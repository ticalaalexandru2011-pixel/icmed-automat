// ==UserScript==
// @name         iCmed Automat - Alimentare Stoc
// @namespace    icmed-automat
// @version      1.7
// @description  Completeaza automat formularul din XML exportat din SAGA
// @author       Alex Ticala
// @match        https://staging.icmed.ro/Main/Configurare/Intrari/AlimentareStocMedicamente.module.aspx
// @match        https://staging.icmed.ro/Main/Configurare/Intrari/AlimentareStocMateriale.module.aspx
// @match        https://*.icmed.ro/Main/Configurare/Intrari/AlimentareStocMedicamente.module.aspx
// @match        https://*.icmed.ro/Main/Configurare/Intrari/AlimentareStocMateriale.module.aspx
// @homepageURL  https://github.com/ticalaalexandru2011-pixel/icmed-automat
// @supportURL   https://github.com/ticalaalexandru2011-pixel/icmed-automat/issues
// @updateURL    https://raw.githubusercontent.com/ticalaalexandru2011-pixel/icmed-automat/main/icmed_automat.user.js
// @downloadURL  https://raw.githubusercontent.com/ticalaalexandru2011-pixel/icmed-automat/main/icmed_automat.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const PAGINA = window.location.href.includes('AlimentareStocMedicamente') ? 'med'
                 : window.location.href.includes('AlimentareStocMateriale')   ? 'materiale'
                 : null;
    if (!PAGINA) return;

    const LS_KEY = `icmed-automat-${PAGINA}-idx`;

    // ── Constante ─────────────────────────────────────────────────────────────

    // Chei localStorage (centralizate ca sa nu apara string-uri magice prin cod)
    const KEYS = {
        xml:            'icmed-automat-xml',
        xmlFilename:    'icmed-automat-xml-filename',
        facturaCurenta: 'icmed-automat-factura-curenta',
        istoric:        'icmed-automat-istoric',
        extraMateriale: 'icmed-automat-extra-materiale',
        foldere:        'icmed-automat-folders',
        idxMed:         'icmed-automat-med-idx',
        idxMat:         'icmed-automat-mat-idx',
    };

    // Timpi (ms). T_POPUP e o LIMITA pentru `asteapta()` (revine mai devreme cand apare elementul);
    // restul sunt asteptari fixe acolo unde nu exista un semnal clar de "gata".
    const T_POPUP  = 4000;  // limita pentru deschiderea popup-ului de cautare
    const T_TYPE   = 500;   // dupa scrierea codului, inainte de Enter
    const T_FILTER = 1500;  // dupa Enter, cat asteptam filtrarea rezultatelor (fara semnal clar)
    const T_RECALC = 700;   // recalculul paginii dupa setarea pretului
    const T_SAVE   = 1200;  // dupa click pe Salveaza
    const T_CLICK  = 600;   // dupa click pe un rand din rezultate

    // ── Parsare XML ───────────────────────────────────────────────────────────

    function codW(cod, denumire, textSupl) {
        if (textSupl) {
            const m = textSupl.match(/CIM\s*:\s*(W\d+)/i);
            if (m) return m[1];
        }
        for (const s of [cod, denumire]) {
            if (s) {
                const m = s.match(/\b(W\d+)\b/);
                if (m) return m[1];
            }
        }
        return null;
    }

    function lot(textSupl) {
        if (!textSupl) return '';
        const m = textSupl.match(/LOT:\s*([^,\s]+)/i);
        return m ? m[1] : '';
    }

    function bbd(textSupl) {
        if (!textSupl) return '';
        // Format DD.MM.YYYY (ex: BBD: 30.04.2027)
        let m = textSupl.match(/BBD:\s*(\d{2})\.(\d{2})\.(\d{4})/);
        if (m) return `${m[1]}/${m[2]}/${m[3]}`;
        // Format YYYY-MM-DD (ex: BBD:2026-04-30)
        m = textSupl.match(/BBD:\s*(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
        // Fallback: Data Expirare YYYY-MM-DD
        m = textSupl.match(/Data\s+Expirare\s+(\d{4})-(\d{2})-(\d{2})/i);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
        return '';
    }

    function bucatiPerCutie(denumire) {
        if (!denumire) return 1;
        const U = '(FI(?:OLE)?|FL(?:ACOANE)?|CP(?:S|SULE|\\.[\\w.]*)?|CPS|CAPS(?:ULE)?|TB|DR(?:AJEURI)?|COMP(?:RIMATE)?|PLIC|SUPOZ|AMP)';
        let m = denumire.match(new RegExp('X\\s*(\\d+)\\s*' + U, 'i'));
        if (m) return parseInt(m[1], 10);
        m = denumire.match(new RegExp('\\b(\\d+)\\s*' + U, 'i'));
        if (m) return parseInt(m[1], 10);
        return null;
    }

    function parseazaXML(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        const produse = [], sarite = [];

        doc.querySelectorAll('c_xml').forEach(item => {
            const g = tag => (item.querySelector(tag)?.textContent || '').trim();
            const denumire  = g('denumire');
            const cod       = g('cod');
            const w         = codW(cod, denumire, g('text_supl'));
            const lotNr     = lot(g('text_supl'));
            const bbdData   = bbd(g('text_supl'));
            const cantitate = parseFloat(g('cantitate')) || 0;
            const valoare   = parseFloat(g('valoare'))   || 0;
            const totalXml  = parseFloat(g('total'))     || 0;
            const tvaArt    = parseInt(g('tva_art'), 10) || 0;
            // Daca TVA > 0 si exista <total>, bagam TVA in pret si punem 0 in formular
            const pretBaza  = tvaArt > 0 && totalXml > 0 ? totalXml : valoare;
            const tva       = '0';
            const bucCutieRaw     = bucatiPerCutie(denumire);
            const bucCutie        = bucCutieRaw ?? 1;
            const bucCutieDetectat = bucCutieRaw !== null;
            const totalBuc  = Math.max(1, Math.round(bucCutie * cantitate));
            const pretBuc   = totalBuc > 0
                ? (pretBaza / totalBuc).toFixed(4).replace('.', ',')
                : '0';

            const obj = { denumire, cod, lotNr, bbdData, totalBuc, pretBuc, tva, bucCutie, cantitate, valoare, pretBaza, bucCutieDetectat };
            if (!w) { sarite.push(obj); return; }
            produse.push({ ...obj, w });
        });

        return { produse, sarite };
    }

    // ── DOM helpers ───────────────────────────────────────────────────────────

    function inputLangaLabel(text) {
        for (const el of document.querySelectorAll('td, th, label')) {
            if (el.textContent.trim().replace(':', '').trim().startsWith(text)) {
                const nextTd = el.nextElementSibling;
                if (nextTd) {
                    const inp = nextTd.querySelector('input[type="text"], input:not([type])');
                    if (inp && inp.offsetParent !== null && inp.type !== 'hidden') return inp;
                }
                const row = el.closest('tr');
                if (row) {
                    let found = false;
                    for (const td of row.querySelectorAll('td, th')) {
                        if (found) {
                            const inp = td.querySelector('input[type="text"], input:not([type])');
                            if (inp && inp.offsetParent !== null && inp.type !== 'hidden') return inp;
                        }
                        if (td === el) found = true;
                    }
                }
            }
        }
        return null;
    }

    function selectLangaLabel(text) {
        for (const el of document.querySelectorAll('td, th, label')) {
            if (el.textContent.trim().replace(':', '').trim().startsWith(text)) {
                const row = el.closest('tr');
                if (row) {
                    const s = row.querySelector('select');
                    if (s) return s;
                }
            }
        }
        return null;
    }

    function seteazaValoare(input, value) {
        if (!input) return;
        input.focus();
        input.value = value;
        ['input', 'change', 'keyup'].forEach(e =>
            input.dispatchEvent(new Event(e, { bubbles: true }))
        );
    }

    // Trimite Enter (keydown + keyup) catre un element — folosit pentru a declansa
    // recalculul/validarea campurilor din formularul iCmed.
    function trimiteEnter(el) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
    }

    // Escapeaza text pentru inserare in innerHTML (denumiri/firme din XML pot contine & < > ")
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Asteapta pana cand `fn()` intoarce o valoare truthy (max `timeout` ms), verificand din `pas` in `pas`.
    // Inlocuieste sleep-urile fixe: revine imediat ce elementul apare, deci e si rapid si robust.
    async function asteapta(fn, timeout = 4000, pas = 100) {
        const limita = Date.now() + timeout;
        while (Date.now() < limita) {
            const rez = fn();
            if (rez) return rez;
            await sleep(pas);
        }
        return null;
    }

    // Gaseste primul <tr> al carui td/th/label incepe cu `text` (folosit la multe campuri din formular)
    function gasesteRandDupaLabel(text) {
        for (const el of document.querySelectorAll('td, th, label')) {
            if (el.textContent.trim().replace(':', '').trim().startsWith(text)) {
                return el.closest('tr');
            }
        }
        return null;
    }

    // Inputurile vizibile (non-hidden) dintr-un rand
    function inputuriVizibile(row) {
        return [...row.querySelectorAll('input[type="text"], input:not([type])')]
            .filter(e => e.offsetParent !== null && e.type !== 'hidden');
    }

    // Seteaza Pret unitar + Cota TVA (sunt in acelasi <tr>). Cu `doarDacaGol` recompleteaza
    // doar campurile goale/gresite (folosit la verificare). Intoarce lista campurilor setate.
    async function setarePretTva(row, prod, doarDacaGol) {
        const setate = [];
        if (!row) return setate;

        let inputs = inputuriVizibile(row);
        if (inputs[0] && (!doarDacaGol || !inputs[0].value.trim())) {
            seteazaValoare(inputs[0], prod.pretBuc);
            trimiteEnter(inputs[0]);
            await sleep(T_RECALC); // pagina recalculeaza dupa Enter
            setate.push('pret');
        }

        // Re-citim inputurile: pagina poate adauga/sterge campuri dupa recalcul
        const inputsNoi = inputuriVizibile(row);
        if (inputsNoi.length > 1) {
            const tvaInp = inputsNoi[inputsNoi.length - 1];
            const tinta = String(parseInt(prod.tva, 10));
            if (!doarDacaGol || tvaInp.value.trim() !== tinta) {
                tvaInp.focus();
                tvaInp.select();
                tvaInp.value = tinta;
                ['input', 'change'].forEach(e => tvaInp.dispatchEvent(new Event(e, { bubbles: true })));
                trimiteEnter(tvaInp);
                setate.push('TVA');
            }
        }
        return setate;
    }

    async function inchideDialogAvertisment() {
        const panel = document.getElementById('icmed-panel');
        const btn = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="image"], a')]
            .find(b => {
                if (!b.offsetParent) return false;
                if (panel && panel.contains(b)) return false; // excludem panoul nostru
                const t = (b.value || b.textContent || b.alt || b.title || '').trim().toLowerCase();
                // potriveste "ok", "Ok", "OK", " ok ", "✓ ok", etc.
                return /^[^a-z]*ok[^a-z]*$/i.test(t);
            });
        if (btn) { btn.click(); await sleep(400); return true; }
        return false;
    }

    async function verificaSiRecompletat(prod) {
        const recompletate = [];

        if (prod.lotNr) {
            const inp = inputLangaLabel('Numar lot');
            if (inp && !inp.value.trim()) { seteazaValoare(inp, prod.lotNr); recompletate.push('lot'); }
        }

        if (prod.bbdData) {
            const inp = inputLangaLabel('Data expir');
            if (inp && !inp.value.trim()) { seteazaValoare(inp, prod.bbdData); recompletate.push('data exp.'); }
        }

        const umSel = selectLangaLabel('Unitate');
        if (umSel && umSel.options.length > 1 && umSel.selectedIndex !== 1) {
            umSel.selectedIndex = 1;
            umSel.dispatchEvent(new Event('change', { bubbles: true }));
            recompletate.push('unitate');
        }

        const cantInp = inputLangaLabel('Cantitate');
        if (cantInp && !cantInp.value.trim()) {
            seteazaValoare(cantInp, String(prod.totalBuc));
            recompletate.push('cantitate');
        }

        const setate = await setarePretTva(gasesteRandDupaLabel('Pret unitar'), prod, true);
        recompletate.push(...setate);

        return recompletate;
    }

    function gasestePopup() {
        const candidati = [...document.querySelectorAll('div, table')].filter(el => {
            if (!el.offsetParent) return false;
            if (el.closest('#icmed-panel')) return false; // ignoram propriul panou
            const s = window.getComputedStyle(el);
            const z = parseInt(s.zIndex, 10) || 0;
            return (z > 100 || s.position === 'fixed') && el.querySelector('input[type="text"], input:not([type])');
        });
        return candidati.sort((a, b) => b.contains(a) ? 1 : -1)[0] || null;
    }

    // ── Istoric facturi ───────────────────────────────────────────────────────

    function parseazaNumeFisier(filename) {
        const base = filename.replace(/\.xml$/i, '').trim();
        // Format asteptat: "FIRMA SERIE+NR" ex: "SARALEX SRX20146"
        const m = base.match(/^(.+?)\s+([A-Z]+)(\d+)$/);
        if (m) return { firma: m[1].trim(), serie: m[2], nr: m[3], cheie: `${m[2]}${m[3]}`, filename: base };
        return { firma: base, serie: '', nr: '', cheie: base, filename: base };
    }

    function getIstoric() {
        return JSON.parse(localStorage.getItem(KEYS.istoric) || '[]');
    }

    function saveIstoric(list) {
        localStorage.setItem(KEYS.istoric, JSON.stringify(list));
    }

    function getFoldere() {
        const saved = JSON.parse(localStorage.getItem(KEYS.foldere) || '[]');
        if (!saved.find(f => f.id === 'general')) saved.unshift({ id: 'general', nume: 'General' });
        return saved;
    }
    function saveFoldere(list) {
        localStorage.setItem(KEYS.foldere, JSON.stringify(list));
    }

    function getFacturaCurenta() {
        return JSON.parse(localStorage.getItem(KEYS.facturaCurenta) || 'null');
    }

    function gasesteSauCreazaFactura(info, totalMed, totalMat) {
        const istoric = getIstoric();
        let factura = istoric.find(f => f.cheie === info.cheie);
        if (!factura) {
            const azi = new Date();
            const data = `${String(azi.getDate()).padStart(2,'0')}/${String(azi.getMonth()+1).padStart(2,'0')}/${azi.getFullYear()}`;
            factura = {
                firma: info.firma, serie: info.serie, nr: info.nr,
                cheie: info.cheie, filename: info.filename, data,
                totalMed, totalMat,
                procesatMed: 0, procesatMat: 0,
                completataMed: false, completataMat: false,
                completata: false, completataLa: null
            };
            istoric.unshift(factura);
        } else {
            factura.totalMed = totalMed;
            factura.totalMat = totalMat;
        }
        saveIstoric(istoric);
        return factura;
    }

    function marcheazaAvans() {
        const fc = getFacturaCurenta();
        if (!fc) return;
        const istoric = getIstoric();
        const factura = istoric.find(f => f.cheie === fc.cheie);
        if (!factura) return;
        if (PAGINA === 'med') factura.procesatMed = Math.min((factura.procesatMed || 0) + 1, factura.totalMed);
        else                  factura.procesatMat = Math.min((factura.procesatMat || 0) + 1, factura.totalMat);
        saveIstoric(istoric);
        afiseazaIstoric();
    }

    function marcheazaPaginaCompleta() {
        const fc = getFacturaCurenta();
        if (!fc) return;
        const istoric = getIstoric();
        const factura = istoric.find(f => f.cheie === fc.cheie);
        if (!factura) return;
        if (PAGINA === 'med') { factura.completataMed = true; factura.procesatMed = factura.totalMed; }
        else                  { factura.completataMat = true; factura.procesatMat = factura.totalMat; }
        const medDone = factura.completataMed || factura.totalMed === 0;
        const matDone = factura.completataMat || factura.totalMat === 0;
        if (medDone && matDone) {
            factura.completata = true;
            factura.completataLa = new Date().toISOString();
        }
        saveIstoric(istoric);
        afiseazaIstoric();
    }

    function afiseazaIstoric() {
        const el = document.getElementById('ia-istoric-lista');
        if (!el) return;
        const istoric = getIstoric();
        const foldere = getFoldere();

        let html = foldere.map((folder, fi) => {
            const facturiFoldera = istoric
            .filter(f => (f.folderId || 'general') === folder.id)
            .sort((a, b) => {
                const fa = (a.firma || a.cheie || '').toUpperCase();
                const fb = (b.firma || b.cheie || '').toUpperCase();
                return fa < fb ? -1 : fa > fb ? 1 : (a.cheie || '').localeCompare(b.cheie || '');
            });
            const nrComplete = facturiFoldera.filter(f => f.completata).length;

            const actiuniHtml = `<div style="display:flex;gap:4px;margin-bottom:6px;">
                <button data-rename-folder="${folder.id}" style="padding:2px 8px;background:#2d6a4f;border:none;border-radius:3px;color:#a5d6a7;font-size:10px;cursor:pointer;">✏ Redenumeste</button>
                ${folder.id !== 'general' ? `<button data-delete-folder="${folder.id}" style="padding:2px 8px;background:#7f1010;border:none;border-radius:3px;color:#ffcdd2;font-size:10px;cursor:pointer;">🗑 Sterge folder</button>` : ''}
            </div>`;

            const facturiHtml = facturiFoldera.map(f => {
                const icon = f.completata ? '✅' : '⏳';
                const progMed = `${f.procesatMed}/${f.totalMed} med`;
                const progMat = f.totalMat > 0 ? ` · ${f.procesatMat}/${f.totalMat} mat` : '';
                const btnGata = !f.completata
                    ? `<button data-gata="${esc(f.cheie)}" style="margin-top:4px;width:calc(100% - 32px);padding:4px;background:#388e3c;border:none;border-radius:4px;color:#fff;font-size:11px;font-weight:bold;cursor:pointer;">✅ Marcheaza gata</button>`
                    : '';
                const selectMuta = `<select data-muta="${esc(f.cheie)}" style="font-size:10px;background:#2d4a1a;color:#c8e6c9;border:1px solid #4a6a3a;border-radius:3px;padding:1px 3px;margin-top:3px;width:100%;cursor:pointer;">
                    ${foldere.map(fo => `<option value="${esc(fo.id)}"${(f.folderId||'general')===fo.id?' selected':''}>${esc(fo.nume)}</option>`).join('')}
                </select>`;
                return `<div style="padding:5px 0;border-bottom:1px solid #3a5a2a;font-size:11px;line-height:1.5;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                        <div style="flex:1;min-width:0;">
                            <span style="font-size:13px;">${icon}</span>
                            <b style="color:#fff;"> ${esc(f.cheie)}</b>
                            <span style="color:#c8e6c9;"> ${esc(f.firma)}</span><br/>
                            <span style="color:#9e9e9e;">${esc(f.data)} · ${progMed}${progMat}</span>
                        </div>
                        <button data-sterge="${esc(f.cheie)}" style="padding:2px 6px;background:#b71c1c;border:none;border-radius:3px;color:#fff;font-size:11px;cursor:pointer;flex-shrink:0;margin-left:6px;">🗑</button>
                    </div>
                    ${selectMuta}
                    ${btnGata}
                </div>`;
            }).join('');

            const emptyMsg = facturiFoldera.length === 0
                ? '<div style="color:#6a8a4a;font-size:10px;padding:4px 0;font-style:italic;">Folder gol</div>'
                : '';

            return `<details ${fi === 0 ? 'open' : ''} style="margin-bottom:5px;">
                <summary style="cursor:pointer;padding:5px 8px;background:#2d4a1a;border-radius:5px;
                               font-size:11px;font-weight:bold;color:#c8e6c9;outline:none;
                               display:flex;justify-content:space-between;align-items:center;
                               list-style:none;-webkit-appearance:none;">
                    <span>📁 ${esc(folder.nume)}</span>
                    <span style="color:#9e9e9e;font-weight:normal;font-size:10px;">${nrComplete}/${facturiFoldera.length} ✅</span>
                </summary>
                <div style="padding:4px 0 0 6px;">${actiuniHtml}${facturiHtml}${emptyMsg}</div>
            </details>`;
        }).join('');

        html += `<button data-folder-nou style="margin-top:6px;width:100%;padding:5px;background:#2d4a1a;border:1px dashed #6a8a4a;border-radius:4px;color:#a5d6a7;font-size:11px;cursor:pointer;">+ Folder nou</button>`;
        el.innerHTML = html;
    }

    function afiseazaInfoFactura() {
        const fc = getFacturaCurenta();
        const el = document.getElementById('ia-factura-info');
        if (!el) return;
        if (!fc) { el.style.display = 'none'; return; }
        const label = fc.serie ? `${fc.firma} ${fc.cheie}` : fc.firma;
        el.style.display = 'block';
        el.innerHTML = `
            <span style="color:#9e9e9e;font-size:10px;">Factura:</span>
            <input id="ia-factura-edit" type="text" value="${esc(label)}"
                style="background:transparent;border:none;border-bottom:1px dashed #6a8a4a;
                       color:#80cbc4;font-size:11px;width:calc(100% - 68px);outline:none;
                       margin-left:4px;padding:1px 2px;"/>
            <button id="ia-factura-save"
                style="padding:2px 7px;background:#2d6a4f;border:none;border-radius:3px;
                       color:#a5d6a7;font-size:11px;cursor:pointer;margin-left:4px;font-weight:bold;">✓</button>
        `;
        document.getElementById('ia-factura-save').addEventListener('click', redenumesteFact);
        document.getElementById('ia-factura-edit').addEventListener('keydown', e => {
            if (e.key === 'Enter') redenumesteFact();
        });
    }

    function redenumesteFact() {
        const input = document.getElementById('ia-factura-edit');
        if (!input) return;
        const numeNou = input.value.trim();
        if (!numeNou) return;
        const fc = getFacturaCurenta();
        if (!fc) return;
        const cheieVeche = fc.cheie;

        const info = parseazaNumeFisier(numeNou + '.xml');
        fc.firma = info.firma;
        fc.serie = info.serie;
        fc.nr    = info.nr;
        fc.cheie = info.cheie;

        localStorage.setItem(KEYS.facturaCurenta, JSON.stringify(fc));
        localStorage.setItem(KEYS.xmlFilename, numeNou + '.xml');

        const istoric = getIstoric();
        const f = istoric.find(x => x.cheie === cheieVeche);
        if (f) {
            f.cheie = fc.cheie;
            f.firma = fc.firma;
            saveIstoric(istoric);
        }

        afiseazaInfoFactura();
        afiseazaIstoric();
    }

    // ── Panel UI ──────────────────────────────────────────────────────────────

    function creeazaPanel() {
        const titlu = PAGINA === 'med' ? 'iCmed Automat — Medicamente' : 'iCmed Automat — Materiale';
        const div = document.createElement('div');
        div.id = 'icmed-panel';
        div.style.cssText = `
            position:fixed; top:10px; right:10px; width:300px;
            background:#3d5a2a; color:#fff; border-radius:8px;
            padding:14px; z-index:999999; font-family:Arial,sans-serif;
            font-size:13px; box-shadow:0 4px 16px rgba(0,0,0,.5);
            user-select:none;
        `;
        div.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;border-bottom:1px solid #6a8a4a;padding-bottom:6px;">
                <span style="font-weight:bold;font-size:14px;">${titlu}</span>
                <button id="ia-btn-istoric" style="padding:3px 8px;background:#2d4a1a;border:1px solid #6a8a4a;border-radius:4px;color:#c8e6c9;font-size:11px;cursor:pointer;">📋 Istoric</button>
            </div>
            <div id="ia-factura-info" style="display:none;font-size:11px;color:#80cbc4;margin-bottom:8px;padding:4px 6px;background:#2d4a1a;border-radius:4px;"></div>
            <label style="display:block;margin-bottom:6px;font-size:12px;color:#c8e6c9;">
                Selecteaza fisierul XML din SAGA:
            </label>
            <input id="ia-file" type="file" accept=".xml" style="width:100%;font-size:12px;margin-bottom:10px;"/>
            <div id="ia-status" style="color:#c8e6c9;font-size:12px;margin-bottom:8px;"></div>
            <div id="ia-jump" style="display:none;align-items:center;gap:6px;margin-bottom:8px;">
                <span style="font-size:12px;color:#c8e6c9;white-space:nowrap;">Mergi la nr:</span>
                <input id="ia-jump-nr" type="number" min="1" value="1" style="width:55px;font-size:12px;padding:3px 5px;border-radius:4px;border:none;"/>
                <button id="ia-btn-jump" style="flex:1;padding:4px 8px;background:#ff8f00;border:none;border-radius:4px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;">
                    Sari la
                </button>
            </div>
            <div id="ia-card" style="display:none;background:#2d4a1a;border-radius:6px;padding:10px;margin-bottom:10px;font-size:12px;line-height:1.6;"></div>
            <div id="ia-buc-row" style="display:none;align-items:center;gap:6px;margin-bottom:8px;padding:6px 8px;background:#7f1010;border-radius:4px;">
                <span style="font-size:11px;color:#ffcdd2;white-space:nowrap;">Buc/cutie:</span>
                <input id="ia-buc-nr" type="number" min="1" value="1" style="width:60px;font-size:13px;padding:3px 5px;border-radius:4px;border:none;font-weight:bold;"/>
                <button id="ia-btn-buc" style="flex:1;padding:5px 8px;background:#ef5350;border:none;border-radius:4px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;">Aplica</button>
            </div>
            <button id="ia-btn-fill" style="display:none;width:100%;padding:9px;background:#66bb6a;border:none;border-radius:5px;color:#fff;font-weight:bold;cursor:pointer;font-size:13px;margin-bottom:6px;">
                Completeaza campurile
            </button>
            <div id="ia-fill-msg" style="display:none;color:#fff176;font-size:12px;text-align:center;margin-bottom:6px;padding:6px;background:#5d4037;border-radius:4px;">
                Verifica datele completate,<br/>apoi apasa "Urmatorul produs" (salveaza automat).
            </div>
            <button id="ia-btn-next" style="display:none;width:100%;padding:9px;background:#42a5f5;border:none;border-radius:5px;color:#fff;font-weight:bold;cursor:pointer;font-size:13px;">
                Urmatorul produs
            </button>
            <div id="ia-sarite" style="display:none;margin-top:10px;background:#7f0000;border-radius:5px;padding:8px;font-size:11px;"></div>
            <div id="ia-istoric" style="display:none;margin-top:10px;border-top:1px solid #4a6a3a;padding-top:8px;">
                <div style="font-size:12px;font-weight:bold;color:#c8e6c9;margin-bottom:6px;">Facturi procesate:</div>
                <div id="ia-istoric-lista" style="max-height:380px;overflow-y:auto;padding-right:4px;scrollbar-width:thin;scrollbar-color:#4a6a3a #2d4a1a;"></div>
            </div>
            <div style="margin-top:12px;padding-top:8px;border-top:1px solid #4a6a3a;text-align:center;">
                <span style="font-family:'Georgia',serif;font-size:13px;font-weight:bold;font-style:italic;
                             color:#fff;letter-spacing:1.5px;text-shadow:0 1px 4px rgba(0,0,0,0.5);">
                    ✦ Alex Script ✦
                </span>
            </div>
        `;
        document.body.appendChild(div);
        return div;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    let lista = [], idx = 0, autoCompletat = false;

    // ── Display produs ────────────────────────────────────────────────────────

    function afiseaza(i) {
        const p = lista[i];
        document.getElementById('ia-status').textContent = `Produs ${i + 1} din ${lista.length}`;
        document.getElementById('ia-card').style.display = 'block';
        const codLinie = PAGINA === 'med'
            ? `<span style="color:#80cbc4;">W:</span> ${esc(p.w)}<br/>`
            : `<span style="color:#80cbc4;">Cod:</span> ${esc(p.cod) || '—'}<br/>`;
        const avertBuc = !p.bucCutieDetectat
            ? `<div style="margin-top:6px;padding:5px 7px;background:#b71c1c;border-radius:4px;color:#fff;font-size:11px;font-weight:bold;">⚠ Buc/cutie nedetectate — verifica cantitatea!</div>`
            : '';
        document.getElementById('ia-card').innerHTML = `
            <b>${esc(p.denumire)}</b><br/>
            ${codLinie}
            <span style="color:#80cbc4;">Lot:</span> ${esc(p.lotNr) || '—'}<br/>
            <span style="color:#80cbc4;">Exp:</span> ${esc(p.bbdData) || '—'}<br/>
            <span style="color:#80cbc4;">Cant:</span> ${p.totalBuc} buc (${p.bucCutie} buc/cutie x ${p.cantitate} cutii)<br/>
            <span style="color:#80cbc4;">Pret/buc:</span> ${p.pretBuc} lei<br/>
            <span style="color:#80cbc4;">TVA:</span> ${p.tva}%
            ${avertBuc}
        `;
        const bucRow = document.getElementById('ia-buc-row');
        if (!p.bucCutieDetectat) {
            bucRow.style.display = 'flex';
            document.getElementById('ia-buc-nr').value = p.bucCutie;
        } else {
            bucRow.style.display = 'none';
        }
        document.getElementById('ia-btn-fill').style.display = 'block';
        document.getElementById('ia-btn-fill').disabled = false;
        document.getElementById('ia-btn-fill').textContent = 'Completeaza campurile';
        document.getElementById('ia-btn-next').style.display = 'none';
        document.getElementById('ia-fill-msg').style.display = 'none';
    }

    // Apelata cand s-a terminat lista: marcheaza pagina completa si ascunde controalele de produs.
    function finalizeazaLista() {
        marcheazaPaginaCompleta();
        localStorage.removeItem(LS_KEY);
        document.getElementById('ia-status').textContent = 'Toate produsele procesate! ✅';
        document.getElementById('ia-card').style.display = 'none';
        document.getElementById('ia-btn-fill').style.display = 'none';
        document.getElementById('ia-btn-next').style.display = 'none';
        document.getElementById('ia-fill-msg').style.display = 'none';
    }

    // ── Avertisment produs negasit ────────────────────────────────────────────

    async function aratareAvertisment(prod) {
        return new Promise(resolve => {
            const fillMsg = document.getElementById('ia-fill-msg');
            fillMsg.style.display = 'block';
            fillMsg.innerHTML = `
                <div style="color:#ff8a65;font-weight:bold;margin-bottom:6px;">Produsul nu a fost gasit in iCmed!</div>
                <div style="color:#fff;font-size:11px;margin-bottom:8px;">${esc(prod.denumire)}<br/>W: ${esc(prod.w)}</div>
                <button id="ia-warn-mat" style="width:100%;padding:6px;background:#ff8f00;border:none;border-radius:4px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;margin-bottom:4px;">Trimite la Materiale</button>
                <button id="ia-warn-man" style="width:100%;padding:6px;background:#546e7a;border:none;border-radius:4px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;">Continua manual</button>
            `;
            document.getElementById('ia-warn-mat').onclick = () => { fillMsg.style.display = 'none'; resolve('materiale'); };
            document.getElementById('ia-warn-man').onclick = () => { fillMsg.style.display = 'none'; resolve('manual'); };
        });
    }

    // ── completeaza ───────────────────────────────────────────────────────────

    async function completeaza(prod) {
        const btnFill = document.getElementById('ia-btn-fill');
        const btnNext = document.getElementById('ia-btn-next');
        const fillMsg = document.getElementById('ia-fill-msg');

        btnFill.disabled = true;
        btnFill.textContent = 'Se completeaza...';

        const labelCamp   = PAGINA === 'med' ? 'Medicamente' : 'Materiale';
        const codCautare  = PAGINA === 'med' ? prod.w
            : (prod.denumire.split(' ').find(w => /[a-zA-Z]/.test(w)) || prod.denumire.split(' ')[0]);

        const campRow = gasesteRandDupaLabel(labelCamp);

        if (campRow) {
            const butoane = [...campRow.querySelectorAll('img, input[type="image"], button, a')].filter(el => {
                if (!el.offsetParent) return false;
                const src = (el.src || el.href || el.title || el.alt || '').toLowerCase();
                return !src.includes('delete') && !src.includes('clear') && !src.includes('remove') && !src.includes('cancel');
            });
            const openBtn = butoane[0];
            if (openBtn) {
                openBtn.click();

                // Asteptam pana popup-ul are un input de cautare (in loc de delay fix)
                const searchInput = await asteapta(() => {
                    const p = gasestePopup();
                    return p ? p.querySelector('input[type="text"], input:not([type])') : null;
                }, T_POPUP);

                if (searchInput) {
                    searchInput.focus();
                    searchInput.value = codCautare;
                    searchInput.dispatchEvent(new Event('input',  { bubbles: true }));
                    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
                    await sleep(T_TYPE);
                    trimiteEnter(searchInput);
                    await sleep(T_FILTER); // lasam pagina sa filtreze (nu exista semnal clar de "gata")

                    const popup2 = gasestePopup();
                    if (popup2) {
                        const rows = [...popup2.querySelectorAll('tr')].filter(r => r.cells.length > 1 && r.offsetParent);
                        const primaLinie = rows.find(r => r.closest('tbody')) || rows[0];
                        if (primaLinie) { primaLinie.click(); await sleep(T_CLICK); }
                    }
                }
            }
        }

        // Verifica daca produsul a fost gasit (doar pe pagina med)
        if (PAGINA === 'med') {
            const medInput = inputLangaLabel('Medicamente');
            if (medInput && !medInput.value.trim()) {
                const choice = await aratareAvertisment(prod);
                btnFill.textContent = 'Completeaza campurile';
                btnFill.disabled = false;
                if (choice === 'materiale') {
                    const extras = JSON.parse(localStorage.getItem(KEYS.extraMateriale) || '[]');
                    extras.push(prod);
                    localStorage.setItem(KEYS.extraMateriale, JSON.stringify(extras));
                    idx++;
                    localStorage.setItem(LS_KEY, idx);
                    if (idx < lista.length) {
                        document.getElementById('ia-jump-nr').value = idx + 1;
                        afiseaza(idx);
                    } else {
                        finalizeazaLista();
                    }
                }
                return;
            }
        }

        // Numar lot
        const lotInput = inputLangaLabel('Numar lot');
        if (lotInput) seteazaValoare(lotInput, prod.lotNr);
        await sleep(150);

        // Data expirarii
        const bbdInput = inputLangaLabel('Data expir');
        if (bbdInput) seteazaValoare(bbdInput, prod.bbdData);
        await sleep(150);

        // Unitate comanda - a 2-a optiune
        const umSel = selectLangaLabel('Unitate');
        if (umSel && umSel.options.length > 1) {
            umSel.selectedIndex = 1;
            umSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await sleep(150);

        // Cantitate
        const cantInput = inputLangaLabel('Cantitate');
        if (cantInput) seteazaValoare(cantInput, String(prod.totalBuc));
        await sleep(150);

        // Pret unitar + Cota TVA - ambele in acelasi rand
        await setarePretTva(gasesteRandDupaLabel('Pret unitar'), prod, false);
        await sleep(150);

        const recompletate = await verificaSiRecompletat(prod);

        btnFill.textContent = 'Campuri completate';
        fillMsg.style.display = 'block';
        const msgRecompletat = recompletate.length > 0
            ? `<span style="color:#ffcc02;">⚠ Recompletat: ${recompletate.join(', ')}</span><br/>`
            : '';
        const msgBuc = !prod.bucCutieDetectat
            ? `<span style="color:#ff8a65;font-weight:bold;">⚠ Verifica cantitatea — buc/cutie nedetectate!</span><br/>`
            : '';
        fillMsg.innerHTML = msgRecompletat + msgBuc + 'Verifica datele completate,<br/>apoi apasa "Urmatorul produs" (salveaza automat).';
        btnNext.style.display = 'block';
    }

    // ── proceseazaXML ─────────────────────────────────────────────────────────

    function proceseazaXML(xmlText, autoIncarcat, infoFactura) {
        const result  = parseazaXML(xmlText);
        const extras  = JSON.parse(localStorage.getItem(KEYS.extraMateriale) || '[]')
            .map(p => ({
                bucCutieDetectat: false,
                ...p,
                pretBaza: p.pretBaza || p.valoare || (parseFloat((p.pretBuc || '0').replace(',', '.')) * (p.totalBuc || 1))
            }));
        lista = PAGINA === 'materiale' ? [...result.sarite, ...extras] : result.produse;

        // Creeaza / actualizeaza factura in istoric
        const fc = infoFactura || getFacturaCurenta();
        if (fc) {
            gasesteSauCreazaFactura(fc, result.produse.length, result.sarite.length + extras.length);
            localStorage.setItem(KEYS.facturaCurenta, JSON.stringify(fc));
        }

        afiseazaInfoFactura();
        afiseazaIstoric();

        if (PAGINA === 'med' && result.sarite.length) {
            const el = document.getElementById('ia-sarite');
            el.style.display = 'block';
            el.innerHTML = '<b>Fara cod W (pe Alim. stoc materiale):</b><br/>' + result.sarite.map(d => `• ${esc(d.denumire)}`).join('<br/>');
        }

        if (lista.length > 0) {
            const jumpDiv = document.getElementById('ia-jump');
            jumpDiv.style.display = 'flex';
            document.getElementById('ia-jump-nr').max = lista.length;

            const salvat    = localStorage.getItem(LS_KEY);
            const idxSalvat = salvat !== null ? parseInt(salvat, 10) : 0;
            idx = Math.max(0, Math.min(idxSalvat, lista.length - 1));
            document.getElementById('ia-jump-nr').value = idx + 1;
            afiseaza(idx);

            const prefix = autoIncarcat ? 'XML auto-incarcat — ' : '';
            document.getElementById('ia-status').textContent = idx > 0
                ? `${prefix}${lista.length} produse — continui de la produsul ${idx + 1}`
                : `${prefix}${lista.length} produse gasite in XML`;
        } else {
            document.getElementById('ia-status').textContent = 'Niciun produs gasit in XML pentru aceasta pagina.';
        }
    }

    // ── init ──────────────────────────────────────────────────────────────────

    function init() {
        creeazaPanel();
        afiseazaIstoric();

        const xmlSalvat = localStorage.getItem(KEYS.xml);
        if (xmlSalvat) {
            const filenameSalvat = localStorage.getItem(KEYS.xmlFilename);
            const infoAuto = filenameSalvat ? parseazaNumeFisier(filenameSalvat) : null;
            proceseazaXML(xmlSalvat, true, infoAuto);
        }

        document.getElementById('ia-istoric-lista').addEventListener('click', e => {
            const btnGata = e.target.closest('[data-gata]');
            if (btnGata) {
                const cheie = btnGata.dataset.gata;
                const istoric = getIstoric();
                const factura = istoric.find(f => f.cheie === cheie);
                if (!factura) return;
                factura.completata = true;
                factura.completataMed = true;
                factura.completataMat = true;
                factura.completataLa = new Date().toISOString();
                saveIstoric(istoric);
                afiseazaIstoric();
                return;
            }
            const btnSterge = e.target.closest('[data-sterge]');
            if (btnSterge) {
                const cheie = btnSterge.dataset.sterge;
                const istoric = getIstoric();
                saveIstoric(istoric.filter(f => f.cheie !== cheie));
                afiseazaIstoric();
                return;
            }
            const btnRename = e.target.closest('[data-rename-folder]');
            if (btnRename) {
                const id = btnRename.dataset.renameFolder;
                const foldere = getFoldere();
                const folder = foldere.find(f => f.id === id);
                if (!folder) return;
                const numeNou = window.prompt('Nume nou pentru folder:', folder.nume);
                if (numeNou && numeNou.trim()) {
                    folder.nume = numeNou.trim();
                    saveFoldere(foldere);
                    afiseazaIstoric();
                }
                return;
            }
            const btnDelFolder = e.target.closest('[data-delete-folder]');
            if (btnDelFolder) {
                const id = btnDelFolder.dataset.deleteFolder;
                if (id === 'general') return;
                if (!window.confirm('Stergi folderul? Facturile din el vor fi mutate in General.')) return;
                const foldere = getFoldere();
                saveFoldere(foldere.filter(f => f.id !== id));
                const istoric = getIstoric();
                istoric.forEach(f => { if ((f.folderId || 'general') === id) f.folderId = 'general'; });
                saveIstoric(istoric);
                afiseazaIstoric();
                return;
            }
            const btnFolderNou = e.target.closest('[data-folder-nou]');
            if (btnFolderNou) {
                const nume = window.prompt('Nume folder nou:');
                if (!nume || !nume.trim()) return;
                const foldere = getFoldere();
                foldere.push({ id: 'folder_' + Date.now(), nume: nume.trim() });
                saveFoldere(foldere);
                afiseazaIstoric();
                return;
            }
        });

        document.getElementById('ia-istoric-lista').addEventListener('change', e => {
            const sel = e.target.closest('[data-muta]');
            if (!sel) return;
            const cheie = sel.dataset.muta;
            const folderId = sel.value;
            const istoric = getIstoric();
            const factura = istoric.find(f => f.cheie === cheie);
            if (factura) {
                factura.folderId = folderId;
                saveIstoric(istoric);
                afiseazaIstoric();
            }
        });

        document.getElementById('ia-btn-istoric').addEventListener('click', () => {
            const el = document.getElementById('ia-istoric');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        });

        document.getElementById('ia-file').addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                const infoFactura = parseazaNumeFisier(file.name);
                localStorage.setItem(KEYS.xml, ev.target.result);
                localStorage.setItem(KEYS.xmlFilename, file.name);
                localStorage.removeItem(KEYS.extraMateriale);
                localStorage.removeItem(KEYS.idxMed);
                localStorage.removeItem(KEYS.idxMat);
                autoCompletat = false;
                proceseazaXML(ev.target.result, false, infoFactura);
            };
            reader.readAsText(file);
        });

        document.getElementById('ia-btn-jump').addEventListener('click', () => {
            const nr = parseInt(document.getElementById('ia-jump-nr').value, 10) || 1;
            idx = Math.max(0, Math.min(nr - 1, lista.length - 1));
            localStorage.setItem(LS_KEY, idx);
            autoCompletat = false;
            afiseaza(idx);
        });

        function aplicaBucCutie() {
            const nr = Math.max(1, parseInt(document.getElementById('ia-buc-nr').value, 10) || 1);
            const prod = lista[idx];
            if (!prod.pretBaza && prod.pretBuc && prod.totalBuc) {
                prod.pretBaza = parseFloat(prod.pretBuc.replace(',', '.')) * prod.totalBuc;
            }
            prod.bucCutie = nr;
            prod.bucCutieDetectat = true;
            prod.totalBuc = Math.max(1, Math.round(nr * prod.cantitate));
            prod.pretBuc = prod.pretBaza > 0
                ? (prod.pretBaza / prod.totalBuc).toFixed(4).replace('.', ',')
                : '0';
            afiseaza(idx);
        }
        document.getElementById('ia-btn-buc').addEventListener('click', aplicaBucCutie);
        document.getElementById('ia-buc-nr').addEventListener('keydown', e => { if (e.key === 'Enter') aplicaBucCutie(); });

        document.getElementById('ia-btn-fill').addEventListener('click', () => {
            autoCompletat = true;
            completeaza(lista[idx]);
        });

        document.getElementById('ia-btn-next').addEventListener('click', async () => {
            const btnSalveaza = [...document.querySelectorAll('input[type="button"], input[type="submit"], input[type="image"], button, a')]
                .find(b => {
                    if (!b.offsetParent) return false;
                    const t = (b.value || b.textContent || b.alt || b.title || b.name || '').trim().toLowerCase();
                    return t.includes('salv');
                });
            if (btnSalveaza) {
                btnSalveaza.click();
                await sleep(T_SAVE);
                await inchideDialogAvertisment();
            }
            marcheazaAvans();
            idx++;
            localStorage.setItem(LS_KEY, idx);
            if (idx < lista.length) {
                document.getElementById('ia-jump-nr').value = idx + 1;
                afiseaza(idx);
                if (autoCompletat) {
                    if (lista[idx].bucCutieDetectat) {
                        completeaza(lista[idx]);
                    } else {
                        autoCompletat = false;
                    }
                }
            } else {
                finalizeazaLista();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
