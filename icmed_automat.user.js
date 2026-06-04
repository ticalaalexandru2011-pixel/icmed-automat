// ==UserScript==
// @name         iCmed Automat - Alimentare Stoc
// @namespace    icmed-automat
// @version      1.19
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
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      api.anthropic.com
// @connect      webhook.site
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
        folderQueue:    'icmed-automat-folder-queue',   // coada de facturi din folder (supravietuieste reload-ului)
        folderSel:      'icmed-automat-folder-sel',      // indexul facturii selectate
        antetDone:      'icmed-automat-antet-done',       // marcaj: antet (Factura+Nota) introdus per factura+pagina
    };

    // Timpi (ms). T_POPUP e o LIMITA pentru `asteapta()` (revine mai devreme cand apare elementul);
    // restul sunt asteptari fixe acolo unde nu exista un semnal clar de "gata".
    const T_POPUP  = 4000;  // limita pentru deschiderea popup-ului de cautare
    const T_TYPE   = 500;   // dupa scrierea codului, inainte de Enter
    const T_FILTER = 1500;  // dupa Enter, cat asteptam filtrarea rezultatelor (fara semnal clar)
    const T_RECALC = 700;   // recalculul paginii dupa setarea pretului
    const T_SAVE   = 1200;  // dupa click pe Salveaza
    const T_CLICK  = 600;   // dupa click pe un rand din rezultate

    // ── AI (rezerva pentru buc/cutie nedetectat) ──────────────────────────────
    // Modelul Claude folosit la cautarea pe net. Sonnet 4.6 = echilibru pret/acuratete
    // (cativa centi/cautare, doar cand apesi butonul). Pune 'claude-haiku-4-5' pentru mai ieftin.
    // Cand e false, completarea antetului NU apasa Salveaza (doar umple campurile, ca sa verifici).
    // Pune true cand totul merge, ca sa salveze automat.
    const ANTET_SALVEAZA = false;

    const AI_MODEL   = 'claude-sonnet-4-6';
    const AI_KEY_GM  = 'icmed-anthropic-key'; // cheia API, stocata prin GM_setValue (nu in cod)
    const DBG_URL_GM = 'icmed-debug-url';     // URL webhook.site pt. trimitere debug (stocat local, nu in cod)

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
        let m = textSupl.match(/LOT:\s*([^,\s]+)/i);
        if (m) return m[1];
        // Format alt furnizor: "10=Serie:20250815 Exp:..."
        m = textSupl.match(/Serie:\s*([^,\s]+)/i);
        return m ? m[1] : '';
    }

    function bbd(textSupl) {
        if (!textSupl) return '';
        // Format DD.MM.YYYY (ex: BBD: 30.04.2027 sau Exp:15.08.2030)
        let m = textSupl.match(/(?:BBD|Exp):\s*(\d{2})\.(\d{2})\.(\d{4})/i);
        if (m) return `${m[1]}/${m[2]}/${m[3]}`;
        // Format YYYY-MM-DD (ex: BBD:2026-04-30 sau Exp:2026-04-30)
        m = textSupl.match(/(?:BBD|Exp):\s*(\d{4})-(\d{2})-(\d{2})/i);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
        // Fallback: Data Expirare YYYY-MM-DD
        m = textSupl.match(/Data\s+Expirare\s+(\d{4})-(\d{2})-(\d{2})/i);
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
        return '';
    }

    function bucatiPerCutie(denumire) {
        if (!denumire) return 1;
        // "(BUC)" => cantitatea din XML e deja in bucati individuale (1 buc/cutie)
        if (/\(\s*BUC\s*\)/i.test(denumire)) return 1;
        const U = '(FI(?:OLE)?|FL(?:ACOANE)?|CPR|CP(?:S|SULE|\\.[\\w.]*)?|CPS|CAPS(?:ULE)?|TB|DR(?:AJEURI)?|COMP(?:R(?:IMATE)?)?|PLIC|SUPOZ(?:ITOARE)?|AMP)';
        // Format CRISFARM/UNICAFARM: "CT*20FI", "CTX56 CPR" (cutie x N) => N buc/cutie
        let m = denumire.match(/CT\s*[\*xX]\s*(\d+)/i);
        if (m) return parseInt(m[1], 10);
        m = denumire.match(new RegExp('X\\s*(\\d+)\\s*' + U, 'i'));
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

    // ── Parsare antet factura (al 2-lea XML de la SAGA) ────────────────────────

    // Antetul are un singur <c_xml> cu <cod_fiscal>/<nr_doc> si fara <cantitate>.
    function esteAntet(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        const items = doc.querySelectorAll('c_xml');
        if (items.length !== 1) return false;
        const it = items[0];
        return !!(it.querySelector('cod_fiscal') || it.querySelector('nr_doc')) && !it.querySelector('cantitate');
    }

    // Prima zi a lunii din data facturii (YYYY-MM-DD) -> "01/MM/YYYY" (DD/MM/YYYY)
    function primaZiLuna(dataIso) {
        const m = (dataIso || '').match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return '';
        return `01/${m[2]}/${m[1]}`;
    }

    function parseazaAntet(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        const it = doc.querySelector('c_xml');
        const g = tag => (it?.querySelector(tag)?.textContent || '').trim();
        const nrDoc = g('nr_doc');
        // "MED2 85291" -> serie "MED2", numar "85291"; fallback litere+cifre
        let serie = '', numar = '';
        const sp = nrDoc.match(/^(.*\S)\s+(\d+)$/);
        if (sp) { serie = sp[1].trim(); numar = sp[2]; }
        else {
            const lr = nrDoc.match(/^([A-Za-z]+)\s*(\d+)$/);
            if (lr) { serie = lr[1]; numar = lr[2]; } else { numar = nrDoc; }
        }
        const dataFactura = g('data');
        return {
            tip:        /proces/i.test(g('tip')) ? 'proces' : 'factura',
            furnizor:   g('denumire'),
            cui:        g('cod_fiscal').replace(/^RO/i, '').trim(),
            nrDoc, serie, numar,
            dataFactura,
            dataICmed:  primaZiLuna(dataFactura),
            bazaTva:    g('baza_tva'),
            tva:        g('tva'),
            total:      parseFloat(g('total')) || 0,
        };
    }

    // Suma liniilor de produse dintr-un XML (pentru imperecherea cu antetul, dupa total)
    function sumaLinii(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        let s = 0;
        doc.querySelectorAll('c_xml').forEach(it => {
            s += parseFloat((it.querySelector('total') || it.querySelector('valoare'))?.textContent || '0') || 0;
        });
        return s;
    }

    // Ultimul grup de cifre din numele fisierului (ex. XML-206-133822 -> 133822) — pentru tiebreak la imperechere
    function timpFisier(nume) {
        const m = (nume || '').match(/(\d+)(?=\D*$)/);
        return m ? parseInt(m[1], 10) : 0;
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

    // ── AI: cauta buc/cutie pe net cand nu se detecteaza din denumire ─────────

    function aiGetKey()  { return (typeof GM_getValue === 'function' ? GM_getValue(AI_KEY_GM, '') : '') || ''; }
    function aiSetKey(k) { if (typeof GM_setValue === 'function') GM_setValue(AI_KEY_GM, k || ''); }

    function aiCereCheie() {
        const k = window.prompt('Lipeste cheia API Anthropic (incepe cu sk-ant-...):', aiGetKey());
        if (k && k.trim()) { aiSetKey(k.trim()); return k.trim(); }
        return aiGetKey();
    }

    // Apeleaza Claude cu web search; intoarce {buc, incredere, sursa, explicatie} sau arunca eroare.
    function intreabaAI(prod) {
        return new Promise((resolve, reject) => {
            const key = aiGetKey();
            if (!key) { reject(new Error('Lipseste cheia API')); return; }
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest indisponibil (verifica @grant)')); return;
            }

            const prompt = `Esti asistent pentru o farmacie din Romania. Pentru produsul de mai jos, afla cate bucati individuale (fiole, comprimate, capsule, plicuri, flacoane etc.) sunt intr-o cutie / ambalaj comercial. Cauta pe net (nomenclatorul ANMM, prospect, farmacii online).

Denumire: "${prod.denumire}"${prod.w ? `\nCod CIM: ${prod.w}` : ''}

Raspunde DOAR cu un obiect JSON pe ultima linie, fara text dupa el:
{"buc_per_cutie": <numar intreg sau null>, "incredere": "mare|medie|mica", "sursa": "<de unde>", "explicatie": "<o propozitie scurta in romana>"}`;

            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                data: JSON.stringify({
                    model: AI_MODEL,
                    max_tokens: 1024,
                    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
                    messages: [{ role: 'user', content: prompt }]
                }),
                timeout: 60000,
                onload: (resp) => {
                    try {
                        if (resp.status === 401) { aiSetKey(''); reject(new Error('Cheie API invalida (401) — reintrod-o')); return; }
                        if (resp.status < 200 || resp.status >= 300) {
                            reject(new Error('Eroare API ' + resp.status)); return;
                        }
                        const data = JSON.parse(resp.responseText);
                        const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
                        const mj = text.match(/\{[\s\S]*\}/);
                        if (!mj) { reject(new Error('Raspuns AI neasteptat')); return; }
                        const obj = JSON.parse(mj[0]);
                        const n = parseInt(obj.buc_per_cutie, 10);
                        resolve({
                            buc: Number.isFinite(n) && n > 0 ? n : null,
                            incredere: obj.incredere || '',
                            sursa: obj.sursa || '',
                            explicatie: obj.explicatie || ''
                        });
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('Eroare de retea catre api.anthropic.com')),
                ontimeout: () => reject(new Error('Timeout la apelul AI'))
            });
        });
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

    // ── Completare antet: Factura + Nota receptie ─────────────────────────────

    // Buton imagine ASP.NET dupa fragment de name/id (id-urile au prefix variabil ctl11_ctl02_)
    function gasesteImgDupaNume(frag) {
        return document.querySelector(`input[type="image"][name*="${frag}"], input[type="image"][id*="${frag}"]`);
    }

    // Butonul "➕" (adauga) din randul unei etichete (ex. "Factura/Proces", "Nota receptie")
    function gasesteButonAdauga(labelText) {
        let lab = null;
        for (const el of document.querySelectorAll('td, th, label')) {
            if (el.textContent.trim().replace(':', '').trim().startsWith(labelText)) { lab = el; break; }
        }
        if (!lab) return null;
        const scope = lab.closest('tr') || lab.parentElement;
        if (!scope) return null;
        const cand = [...scope.querySelectorAll('img, input[type="image"], button, a')].filter(el => el.offsetParent);
        if (!cand.length) return null;
        const add = cand.find(el => {
            const s = (el.src || el.href || el.title || el.alt || el.className || '').toLowerCase();
            return /add|plus|nou|new|adaug|insert|append/.test(s);
        });
        return add || cand[cand.length - 1]; // altfel ultimul buton (➕ e in dreapta)
    }

    // Butonul de cautare (fereastra) dintr-un rand — primul care nu pare delete/clear
    function gasesteButonCautareIn(row) {
        if (!row) return null;
        const cand = [...row.querySelectorAll('img, input[type="image"], button, a')].filter(el => {
            if (!el.offsetParent) return false;
            const s = (el.src || el.href || el.title || el.alt || el.className || '').toLowerCase();
            return !/delete|clear|remove|cancel|sterge/.test(s);
        });
        return cand[0] || null;
    }

    // Inputul de langa o eticheta, in interiorul unui popup/document (ex. iframe-ul modalului)
    function campInPopup(popup, text) {
        if (!popup) return null;
        const norm = s => (s || '').trim().replace(/:\s*$/, '').trim();
        const tl = text.toLowerCase();
        const lab = [...popup.querySelectorAll('td, th, label, span, div')].find(el => {
            const t = norm(el.textContent);
            return t.toLowerCase().startsWith(tl) && t.length <= text.length + 14 && !el.querySelector('input, select, textarea');
        });
        if (!lab) return null;
        const okInput = i => i.offsetParent && !['hidden', 'image', 'checkbox', 'radio', 'button', 'submit'].includes(i.type);
        // 1. acelasi rand (tr): inputul de dupa eticheta
        const tr = lab.closest('tr');
        if (tr) {
            const ins = [...tr.querySelectorAll('input')].filter(okInput);
            for (const inp of ins) if (lab.compareDocumentPosition(inp) & Node.DOCUMENT_POSITION_FOLLOWING) return inp;
            if (ins[0]) return ins[0];
        }
        // 2. primul input vizibil de dupa eticheta, oriunde in popup
        const all = [...popup.querySelectorAll('input')].filter(okInput);
        for (const inp of all) if (lab.compareDocumentPosition(inp) & Node.DOCUMENT_POSITION_FOLLOWING) return inp;
        return null;
    }

    // Modalul de creare Factura/Nota e intr-un IFRAME (ModalDialogBoxImpl_iframe). Intoarce documentul lui.
    // Detectie robusta: iframe vizibil, same-origin, cu cel putin 2 inputuri text vizibile.
    function gasesteModalDoc() {
        const ifr = [...document.querySelectorAll('iframe')].find(f => {
            if (!f.offsetParent && !/ModalDialog/i.test(f.id || '')) return false;
            let d; try { d = f.contentDocument; } catch (e) { return false; }
            if (!d || !d.body) return false;
            const inp = [...d.body.querySelectorAll('input[type="text"], input:not([type])')].filter(i => i.offsetParent);
            return inp.length >= 2;
        });
        if (!ifr) return null;
        try { return ifr.contentDocument; } catch (e) { return null; }
    }

    // Butonul de cautare/drop din randul unei etichete, INTR-UN document dat (iframe)
    function gasesteButonCautareInDoc(doc, label) {
        let lab = null;
        for (const el of doc.querySelectorAll('td, th, label')) {
            if (el.textContent.trim().replace(':', '').trim().startsWith(label)) { lab = el; break; }
        }
        const row = lab && (lab.closest('tr') || lab.parentElement);
        if (!row) return null;
        return [...row.querySelectorAll('input[type="image"], img, button, a')]
            .filter(e => e.offsetParent && !/del|clear|erase|cancel|sterge/i.test((e.src || e.name || e.id || '')))[0] || null;
    }

    // Selecteaza furnizorul dupa CUI in combobox-ul din modal (iframe doc)
    async function selecteazaFurnizor(doc, cui) {
        if (!cui) return;
        const drop = doc.querySelector('input[type="image"][id*="Furnizor"][id*="Drop"], input[type="image"][name*="Furnizor"][name*="Drop"]')
            || gasesteButonCautareInDoc(doc, 'Furnizor');
        if (!drop) return;
        drop.click();
        const sInput = await asteapta(() => {
            const all = [...doc.querySelectorAll('input[id*="Furnizor"][id*="Search"], input[name*="Furnizor"][name*="Search"], input[name*="$Search"]')].filter(i => i.offsetParent);
            return all[0] || null;
        }, T_POPUP);
        if (!sInput) return;
        sInput.focus();
        sInput.value = cui;
        sInput.dispatchEvent(new Event('input', { bubbles: true }));
        sInput.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(T_TYPE);
        // declanseaza cautarea: butonul de search (cu typo "Serach" in iCmed) sau Enter
        const searchBtn = doc.querySelector('input[type="image"][id*="Furnizor"][id*="erac"], input[type="image"][name*="Furnizor"][name*="erac"]');
        if (searchBtn) searchBtn.click(); else trimiteEnter(sInput);
        await sleep(T_FILTER);
        // alege randul care contine CUI-ul
        const rand = [...doc.querySelectorAll('tr.pop_row, tr')].find(r => r.offsetParent && (r.textContent || '').includes(cui));
        if (rand) {
            const cell = rand.querySelector('td[onclick]') || rand.querySelector('td') || rand;
            cell.click();
            await sleep(T_CLICK);
        }
    }

    // Salveaza modalul (iframe doc)
    async function salveazaModal(doc) {
        const esteSalv = b => /salv/i.test((b.value || b.textContent || b.alt || b.title || b.name || b.id || ''));
        let btn = [...doc.querySelectorAll('input[type="image"], input[type="button"], input[type="submit"], button, a')]
            .find(b => b.offsetParent && esteSalv(b));
        if (!btn) {
            const txt = [...doc.querySelectorAll('span, div, td')]
                .filter(b => b.offsetParent && /salv/i.test(b.textContent || '') && (b.textContent || '').trim().length < 20)
                .sort((a, b) => a.textContent.length - b.textContent.length)[0];
            if (txt) { const sib = txt.previousElementSibling || txt.nextElementSibling; btn = (sib && /IMG|A|INPUT/.test(sib.tagName)) ? sib : txt; }
        }
        if (btn) { btn.click(); await sleep(T_SAVE); await inchideDialogAvertisment(); return true; }
        return false;
    }

    async function completeazaFactura(antet) {
        const btn = gasesteImgDupaNume('btnAddFactura') || gasesteButonAdauga('Factura/Proces');
        if (!btn) throw new Error('nu gasesc butonul + de la Factura');
        btn.click();
        const doc = await asteapta(() => gasesteModalDoc(), T_POPUP);
        if (!doc) throw new Error('modalul Factura (iframe) nu s-a deschis');
        await sleep(500);

        // Furnizor dupa CUI
        await selecteazaFurnizor(doc, antet.cui);

        // Tip: implicit Factura; daca e proces verbal, bifeaza al 2-lea radio
        if (antet.tip === 'proces') {
            const radios = [...doc.querySelectorAll('input[type="radio"]')].filter(r => r.offsetParent);
            if (radios[1]) radios[1].click();
        }
        const set = (label, val) => { const inp = campInPopup(doc, label); if (inp && val !== '' && val != null) seteazaValoare(inp, String(val)); };
        set('Valoare fara', antet.bazaTva);
        set('Valoare tva',  antet.tva);
        set('Valoare totala', antet.total);
        set('Serie', antet.serie);
        set('Numar', antet.numar);
        set('Data',  antet.dataICmed); // "Data scadenta" ramane goala

        if (ANTET_SALVEAZA) await salveazaModal(doc);
    }

    async function completeazaNota(antet) {
        const btn = gasesteImgDupaNume('btnNotaRec') || gasesteButonAdauga('Nota receptie');
        if (!btn) throw new Error('nu gasesc butonul + de la Nota receptie');
        btn.click();
        const doc = await asteapta(() => gasesteModalDoc(), T_POPUP);
        if (!doc) throw new Error('modalul Nota (iframe) nu s-a deschis');
        await sleep(500);

        const numarInp = campInPopup(doc, 'Numar');
        if (numarInp) {
            const afisat = parseInt((numarInp.value || '').replace(/\D/g, ''), 10) || 0;
            const nrNou = Math.max(afisat + 1, ultimNotaNr + 1);
            ultimNotaNr = nrNou;
            seteazaValoare(numarInp, String(nrNou));
        }
        const dataInp = campInPopup(doc, 'Data');
        if (dataInp && antet.dataICmed) seteazaValoare(dataInp, antet.dataICmed);

        if (ANTET_SALVEAZA) await salveazaModal(doc);
    }

    // ── Stare antet: stim daca factura+nota au fost deja introduse ─────────────

    function cheieAntet(antet) {
        if (!antet) return '';
        return (antet.serie + antet.numar) || antet.nrDoc || '';
    }
    function getAntetDone() {
        try { return JSON.parse(localStorage.getItem(KEYS.antetDone) || '{}'); } catch (e) { return {}; }
    }
    function marcheazaAntetDone(antet) {
        const d = getAntetDone();
        d[cheieAntet(antet) + '_' + PAGINA] = true;
        localStorage.setItem(KEYS.antetDone, JSON.stringify(d));
    }
    function antetEsteDone(antet) {
        return !!getAntetDone()[cheieAntet(antet) + '_' + PAGINA];
    }
    // Detectie reala: combobox-ul "Factura" din pagina (cmbFactura_Display) e completat?
    function facturaPrezentaInPagina() {
        const disp = document.querySelector('input[id*="cmbFactura_Display"], input[name*="cmbFactura$Display"]');
        if (disp) return !!disp.value.trim();
        const inp = inputLangaLabel('Factura/Proces');
        return !!(inp && inp.value.trim());
    }

    // Actualizeaza textul/culoarea butonului de antet in functie de starea (introdus sau nu)
    function actualizeazaButonAntet() {
        const btn = document.getElementById('ia-btn-antet');
        if (!btn) return;
        if (!antetCurent) { btn.style.display = 'none'; return; }
        btn.style.display = 'block';
        btn.disabled = false;
        if (antetEsteDone(antetCurent) || facturaPrezentaInPagina()) {
            btn.style.background = '#2e7d32';
            btn.textContent = '✅ Antet introdus (click = reintroduce)';
        } else {
            btn.style.background = '#8e24aa';
            btn.textContent = '📋 Completeaza Factura + Nota';
        }
    }

    // Persistenta coada de facturi din folder (ca sa supravietuiasca schimbarii de pagina)
    function salveazaCoada() {
        try { localStorage.setItem(KEYS.folderQueue, JSON.stringify(facturiIncarcate)); }
        catch (e) { try { localStorage.removeItem(KEYS.folderQueue); } catch (e2) {} }
    }
    function rebuildDropdownFacturi(selIdx) {
        const sel = document.getElementById('ia-factura-select');
        if (!sel) return;
        if (!facturiIncarcate.length) { sel.style.display = 'none'; return; }
        sel.innerHTML = '<option value="">— alege factura —</option>' + facturiIncarcate.map((f, i) => {
            const et = f.antet ? `${f.antet.furnizor} ${f.antet.nrDoc}` : (f.numeProduse || `factura ${i + 1}`);
            const warn = f.antet && !f.produseText ? ' ⚠ fara produse' : '';
            return `<option value="${i}">${esc(et)}${warn}</option>`;
        }).join('');
        sel.style.display = 'block';
        if (selIdx != null && facturiIncarcate[selIdx]) sel.value = String(selIdx);
    }

    // ── Debug: auto-test selectori + HTML, copiat in clipboard ────────────────

    function elInfo(el) {
        if (!el) return 'NEGASIT';
        const a = [];
        if (el.id) a.push('id="' + el.id + '"');
        if (el.name) a.push('name="' + el.name + '"');
        if (el.type) a.push('type="' + el.type + '"');
        if (el.src) a.push('src="' + el.src.split('/').pop() + '"');
        if (el.title) a.push('title="' + el.title + '"');
        return `GASIT <${el.tagName.toLowerCase()} ${a.join(' ')}>`;
    }

    // URL webhook unde trimitem debug-ul (ca sa-l citeasca Claude cu WebFetch)
    function dbgGetUrl()  { return (typeof GM_getValue === 'function' ? GM_getValue(DBG_URL_GM, '') : '') || ''; }
    function dbgSetUrl(u) { if (typeof GM_setValue === 'function') GM_setValue(DBG_URL_GM, (u || '').trim()); }
    function dbgCereUrl() {
        const u = window.prompt('Lipeste URL-ul de pe webhook.site (ex: https://webhook.site/xxxxxxxx-xxxx-...):', dbgGetUrl());
        if (u && u.trim()) { dbgSetUrl(u.trim()); return u.trim(); }
        return dbgGetUrl();
    }
    function dbgTrimiteWebhook(text) {
        return new Promise((resolve, reject) => {
            const url = dbgGetUrl();
            if (!url) { reject(new Error('fara URL webhook')); return; }
            if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest indisponibil')); return; }
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: { 'content-type': 'text/plain;charset=utf-8' },
                data: text,
                timeout: 15000,
                onload: r => (r.status >= 200 && r.status < 300) ? resolve() : reject(new Error('status ' + r.status)),
                onerror: () => reject(new Error('eroare retea')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }

    function debugRaport() {
        const L = [];
        let ver = '?'; try { ver = GM_info.script.version; } catch (e) {}
        L.push(`=== iCmed Automat DEBUG (pagina: ${PAGINA}, v${ver}) ===`);
        L.push('Buton + Factura: ' + elInfo(gasesteButonAdauga('Factura/Proces')));
        L.push('Buton + Nota:    ' + elInfo(gasesteButonAdauga('Nota receptie')));

        const popup = gasestePopup();
        if (popup) {
            L.push('Popup deschis: DA');
            ['Furnizor', 'Valoare fara', 'Valoare tva', 'Valoare totala', 'Serie', 'Numar', 'Data', 'Data scadenta'].forEach(lab => {
                L.push(`  camp "${lab}": ` + elInfo(campInPopup(popup, lab)));
            });
            L.push('  buton cautare Furnizor: ' + elInfo(gasesteButonCautareIn(gasesteRandDupaLabel('Furnizor'))));
            const salv = [...popup.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="image"], a, span, div')]
                .find(b => b.offsetParent && /salv/i.test((b.value || b.textContent || b.alt || b.title || '')));
            L.push('  buton Salveaza: ' + elInfo(salv));
            L.push('--- HTML POPUP (max 9000) ---');
            L.push((popup.outerHTML || '').slice(0, 9000));
        } else {
            L.push('Popup deschis: NU (gasestePopup nu prinde modalul — scanez mai jos)');
        }

        // Recon: iframe-uri (modalul icMED poate fi iframe) — ruleaza mereu
        L.push('--- IFRAME-uri ---');
        const iframes = [...document.querySelectorAll('iframe')];
        if (!iframes.length) L.push('  (niciun iframe)');
        iframes.forEach((f, i) => {
            let info = `  iframe[${i}] vis=${!!f.offsetParent} id="${f.id || ''}" name="${f.name || ''}" src="${(f.src || '').slice(0, 90)}"`;
            try {
                const d = f.contentDocument;
                if (d) {
                    const inp = d.querySelectorAll('input[type="text"], input:not([type])').length;
                    const hasF = /Furnizor/i.test(d.body ? d.body.textContent : '');
                    info += ` | accesibil: ${inp} inputuri, areFurnizor=${hasF}`;
                }
            } catch (e) { info += ' | INACCESIBIL'; }
            L.push(info);
        });

        // Recon: containere vizibile care contin "Furnizor" SI "Serie" (cele mai mici = modalul)
        L.push('--- Containere candidate (Furnizor+Serie, cele mai mici) ---');
        const cand = [...document.querySelectorAll('div, table, fieldset')]
            .filter(el => el.offsetParent && !el.closest('#icmed-panel') &&
                /Furnizor/i.test(el.textContent || '') && /Serie/i.test(el.textContent || ''))
            .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)
            .slice(0, 4);
        if (!cand.length) L.push('  (niciun container in document principal — probabil e in iframe)');
        cand.forEach((el, i) => {
            const s = window.getComputedStyle(el);
            L.push(`  cand[${i}] <${el.tagName.toLowerCase()} id="${el.id || ''}" class="${el.className || ''}"> pos=${s.position} z=${s.zIndex} display=${s.display} inputuri=${el.querySelectorAll('input').length}`);
        });
        if (cand[0]) { L.push('--- HTML container minim (max 4000) ---'); L.push((cand[0].outerHTML || '').slice(0, 4000)); }

        // Modalul real (iframe): campuri detectate + HTML interior
        const mdoc = gasesteModalDoc();
        if (mdoc) {
            L.push('--- MODAL (iframe) — campuri detectate ---');
            ['Furnizor', 'Valoare fara', 'Valoare tva', 'Valoare totala', 'Serie', 'Numar', 'Data', 'Data scadenta'].forEach(lab => {
                L.push(`  camp "${lab}": ` + elInfo(campInPopup(mdoc, lab)));
            });
            const fdrop = mdoc.querySelector('input[type="image"][id*="Furnizor"][id*="Drop"], input[type="image"][name*="Furnizor"][name*="Drop"]');
            L.push('  drop Furnizor: ' + elInfo(fdrop));
            L.push('--- HTML MODAL (iframe body, max 9000) ---');
            L.push(((mdoc.body && mdoc.body.innerHTML) || '').slice(0, 9000));
        } else {
            L.push('--- MODAL (iframe): NEDETECTAT (deschide popup-ul Factura/Nota inainte de Debug) ---');
        }

        ['Factura/Proces', 'Nota receptie'].forEach(lab => {
            let el = null;
            for (const e of document.querySelectorAll('td, th, label')) {
                if (e.textContent.trim().replace(':', '').trim().startsWith(lab)) { el = e; break; }
            }
            const row = el && (el.closest('tr') || el.parentElement);
            if (row) { L.push(`--- HTML rand "${lab}" (max 3000) ---`); L.push((row.outerHTML || '').slice(0, 3000)); }
        });

        const text = L.join('\n');
        let copiat = false;
        try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' }); copiat = true; } } catch (e) {}
        return { text, copiat };
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
                <div style="display:flex;gap:4px;">
                    <button id="ia-btn-debug" title="Copiaza un raport (selectori + HTML) pentru depanare" style="padding:3px 8px;background:#37474f;border:1px solid #607d8b;border-radius:4px;color:#cfd8dc;font-size:11px;cursor:pointer;">🐞 Debug</button>
                    <button id="ia-btn-istoric" style="padding:3px 8px;background:#2d4a1a;border:1px solid #6a8a4a;border-radius:4px;color:#c8e6c9;font-size:11px;cursor:pointer;">📋 Istoric</button>
                </div>
            </div>
            <div id="ia-factura-info" style="display:none;font-size:11px;color:#80cbc4;margin-bottom:8px;padding:4px 6px;background:#2d4a1a;border-radius:4px;"></div>
            <label style="display:block;margin-bottom:6px;font-size:12px;color:#c8e6c9;">
                Selecteaza fisierul XML din SAGA:
            </label>
            <input id="ia-file" type="file" accept=".xml" style="width:100%;font-size:12px;margin-bottom:8px;"/>
            <label style="display:block;margin-bottom:4px;font-size:12px;color:#c8e6c9;">…sau incarca un folder intreg de XML-uri:</label>
            <input id="ia-folder" type="file" webkitdirectory directory multiple style="width:100%;font-size:11px;margin-bottom:6px;"/>
            <select id="ia-factura-select" style="display:none;width:100%;font-size:12px;padding:4px;margin-bottom:6px;border-radius:4px;border:none;"></select>
            <button id="ia-btn-antet" style="display:none;width:100%;padding:8px;background:#8e24aa;border:none;border-radius:5px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;margin-bottom:8px;">📋 Completeaza Factura + Nota</button>
            <div id="ia-status" style="color:#c8e6c9;font-size:12px;margin-bottom:8px;"></div>
            <div id="ia-jump" style="display:none;align-items:center;gap:6px;margin-bottom:8px;">
                <span style="font-size:12px;color:#c8e6c9;white-space:nowrap;">Mergi la nr:</span>
                <input id="ia-jump-nr" type="number" min="1" value="1" style="width:55px;font-size:12px;padding:3px 5px;border-radius:4px;border:none;"/>
                <button id="ia-btn-jump" style="flex:1;padding:4px 8px;background:#ff8f00;border:none;border-radius:4px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;">
                    Sari la
                </button>
            </div>
            <div id="ia-card" style="display:none;background:#2d4a1a;border-radius:6px;padding:10px;margin-bottom:10px;font-size:12px;line-height:1.6;"></div>
            <div id="ia-buc-row" style="display:none;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;padding:6px 8px;background:#7f1010;border-radius:4px;">
                <span style="font-size:11px;color:#ffcdd2;white-space:nowrap;">Buc/cutie:</span>
                <input id="ia-buc-nr" type="number" min="1" value="1" style="width:60px;font-size:13px;padding:3px 5px;border-radius:4px;border:none;font-weight:bold;"/>
                <button id="ia-btn-buc" style="flex:1;padding:5px 8px;background:#ef5350;border:none;border-radius:4px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;">Aplica</button>
                <button id="ia-btn-ai" title="Cauta pe net cate buc/cutie (sugestie de verificat)" style="padding:5px 8px;background:#5e35b1;border:none;border-radius:4px;color:#fff;font-weight:bold;cursor:pointer;font-size:12px;white-space:nowrap;">🔎 AI</button>
                <div id="ia-ai-result" style="display:none;width:100%;font-size:11px;color:#fff;background:#4527a0;border-radius:4px;padding:5px 7px;line-height:1.4;"></div>
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
    let facturiIncarcate = [], antetCurent = null, ultimNotaNr = 0;

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
        const aiRes = document.getElementById('ia-ai-result');
        if (aiRes) aiRes.style.display = 'none';
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
        actualizeazaButonAntet();
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

        // Fortam selectia de folder din JS (atributul din HTML nu se aplica mereu in Chrome)
        const folderInp = document.getElementById('ia-folder');
        if (folderInp) {
            try {
                folderInp.webkitdirectory = true;
                folderInp.setAttribute('webkitdirectory', '');
                folderInp.setAttribute('directory', '');
            } catch (e) { /* ignoram */ }
        }

        // Comenzi in meniul Tampermonkey pentru cheia API (nu se stocheaza in cod)
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('🔑 Seteaza cheia API Anthropic', aiCereCheie);
            GM_registerMenuCommand('🗑 Sterge cheia API Anthropic', () => {
                aiSetKey('');
                window.alert('Cheia API a fost stearsa.');
            });
            GM_registerMenuCommand('🌐 Seteaza URL debug (webhook.site)', dbgCereUrl);
        }

        const xmlSalvat = localStorage.getItem(KEYS.xml);
        if (xmlSalvat) {
            const filenameSalvat = localStorage.getItem(KEYS.xmlFilename);
            const infoAuto = filenameSalvat ? parseazaNumeFisier(filenameSalvat) : null;
            proceseazaXML(xmlSalvat, true, infoAuto);
        }

        // Restaureaza coada de facturi + selectia (supravietuieste schimbarii de pagina)
        try {
            const q = JSON.parse(localStorage.getItem(KEYS.folderQueue) || 'null');
            if (Array.isArray(q) && q.length) {
                facturiIncarcate = q;
                const selStr = localStorage.getItem(KEYS.folderSel);
                const selIdx = selStr !== null ? parseInt(selStr, 10) : null;
                rebuildDropdownFacturi(selIdx);
                if (selIdx != null && facturiIncarcate[selIdx]) antetCurent = facturiIncarcate[selIdx].antet;
            }
        } catch (e) { /* ignoram */ }
        actualizeazaButonAntet();

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

        document.getElementById('ia-btn-debug').addEventListener('click', async () => {
            const r = debugRaport();
            const status = document.getElementById('ia-status');
            // 1. clipboard (backup)
            if (!r.copiat) {
                let ta = document.getElementById('ia-debug-ta');
                if (!ta) {
                    ta = document.createElement('textarea');
                    ta.id = 'ia-debug-ta';
                    ta.style.cssText = 'width:100%;height:120px;margin-top:6px;font-size:10px;';
                    document.getElementById('ia-status').after(ta);
                }
                ta.value = r.text;
                ta.style.display = 'block';
                ta.focus(); ta.select();
            }
            // 2. trimite la webhook DOAR daca e setat un URL (din meniu) — fara prompt enervant
            if (dbgGetUrl()) {
                status.textContent = '🐞 Trimit debug la webhook…';
                try {
                    await dbgTrimiteWebhook(r.text);
                    status.textContent = '🐞 Trimis la webhook ✓ — spune-i lui Claude „gata".';
                } catch (e) {
                    status.textContent = '🐞 Webhook esuat (' + (e.message || '') + '). ' + (r.copiat ? 'E in clipboard — da Ctrl+V.' : 'Copiaza din casuta de mai jos.');
                }
            } else if (r.copiat) {
                status.textContent = '🐞 Debug copiat in clipboard — lipeste-l la Claude (Ctrl+V).';
            } else {
                status.textContent = '🐞 Copiaza tot din casuta de mai jos (Ctrl+A, Ctrl+C) si lipeste la Claude.';
            }
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

        // ── Incarcare folder intreg + imperechere antet/produse ───────────────
        const citesteFisier = f => new Promise(res => {
            const r = new FileReader();
            r.onload = ev => res(ev.target.result);
            r.readAsText(f);
        });

        document.getElementById('ia-folder').addEventListener('change', async function (e) {
            const files = [...e.target.files].filter(f => /\.xml$/i.test(f.name));
            if (!files.length) return;
            const status = document.getElementById('ia-status');
            status.textContent = `Citesc ${files.length} fisiere…`;

            const parsed = [];
            for (const f of files) parsed.push({ name: f.name, text: await citesteFisier(f) });

            const anteturi = [], produseF = [];
            for (const p of parsed) {
                if (esteAntet(p.text)) anteturi.push(p);
                else produseF.push({ ...p, suma: sumaLinii(p.text), folosit: false });
            }

            facturiIncarcate = [];
            for (const a of anteturi) {
                const antet = parseazaAntet(a.text);
                const tA = timpFisier(a.name);
                const cand = produseF.filter(pf => !pf.folosit && Math.abs(pf.suma - antet.total) < 0.02);
                let ales = cand.length === 1 ? cand[0]
                    : cand.length > 1
                        ? cand.slice().sort((x, y) => Math.abs(timpFisier(x.name) - tA) - Math.abs(timpFisier(y.name) - tA))[0]
                        : null;
                if (ales) ales.folosit = true;
                facturiIncarcate.push({ antet, produseText: ales ? ales.text : null, numeProduse: ales ? ales.name : null });
            }
            // fisiere de produse fara antet (format vechi) — le pastram si pe ele
            for (const pf of produseF) {
                if (!pf.folosit) facturiIncarcate.push({ antet: null, produseText: pf.text, numeProduse: pf.name });
            }

            localStorage.removeItem(KEYS.folderSel); // resetam selectia la incarcare noua
            salveazaCoada();
            rebuildDropdownFacturi(null);
            status.textContent = `${facturiIncarcate.length} facturi gasite. Alege una din lista.`;
        });

        function selecteazaFacturaDinCoada(i, proceseaza) {
            const f = facturiIncarcate[i];
            if (!f) { antetCurent = null; actualizeazaButonAntet(); return; }
            antetCurent = f.antet;
            localStorage.setItem(KEYS.folderSel, String(i));
            if (proceseaza && f.produseText) {
                const info = f.antet
                    ? { firma: f.antet.furnizor, serie: f.antet.serie, nr: f.antet.numar, cheie: (f.antet.serie + f.antet.numar) || f.antet.nrDoc, filename: f.antet.nrDoc }
                    : (f.numeProduse ? parseazaNumeFisier(f.numeProduse) : null);
                localStorage.setItem(KEYS.xml, f.produseText);
                if (f.numeProduse) localStorage.setItem(KEYS.xmlFilename, f.numeProduse);
                localStorage.removeItem(KEYS.extraMateriale);
                localStorage.removeItem(KEYS.idxMed);
                localStorage.removeItem(KEYS.idxMat);
                autoCompletat = false;
                proceseazaXML(f.produseText, false, info);
            }
            actualizeazaButonAntet();
        }

        document.getElementById('ia-factura-select').addEventListener('change', function (e) {
            const i = parseInt(e.target.value, 10);
            if (!Number.isInteger(i)) { antetCurent = null; actualizeazaButonAntet(); return; }
            selecteazaFacturaDinCoada(i, true);
        });

        document.getElementById('ia-btn-antet').addEventListener('click', async function () {
            if (!antetCurent) return;
            const btn = this;
            // daca pare deja introdus, cerem confirmare inainte de a reintroduce
            if ((antetEsteDone(antetCurent) || facturaPrezentaInPagina()) &&
                !window.confirm('Antetul (Factura + Nota) pare deja introdus pentru aceasta factura. Il reintroduci?')) {
                return;
            }
            btn.disabled = true;
            btn.textContent = 'Se completeaza Factura…';
            try {
                await completeazaFactura(antetCurent);
                if (ANTET_SALVEAZA) {
                    btn.textContent = 'Se completeaza Nota…';
                    await sleep(500);
                    await completeazaNota(antetCurent);
                    marcheazaAntetDone(antetCurent);
                    btn.style.background = '#2e7d32';
                    btn.textContent = '✅ Antet introdus — verifica, apoi treci la produse';
                } else {
                    btn.style.background = '#ef6c00';
                    btn.textContent = '🔎 Campuri completate (FARA save) — verifica modalul';
                }
                btn.disabled = false;
            } catch (err) {
                btn.textContent = '⚠ ' + (err.message || 'eroare') + ' — incearca manual';
                btn.disabled = false;
            }
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

        document.getElementById('ia-btn-ai').addEventListener('click', async () => {
            const btn = document.getElementById('ia-btn-ai');
            const res = document.getElementById('ia-ai-result');
            const prod = lista[idx];
            if (!prod) return;
            if (!aiGetKey()) { aiCereCheie(); if (!aiGetKey()) return; }

            btn.disabled = true;
            const txtVechi = btn.textContent;
            btn.textContent = '⏳';
            res.style.display = 'block';
            res.innerHTML = 'AI cauta pe net…';
            try {
                const r = await intreabaAI(prod);
                if (r.buc) {
                    document.getElementById('ia-buc-nr').value = r.buc; // doar pre-completare, NU aplica
                    res.innerHTML = `<b style="color:#b39ddb;">Sugestie: ${r.buc} buc/cutie</b> (incredere: ${esc(r.incredere)})<br/>`
                        + `${esc(r.explicatie)}<br/><span style="color:#b39ddb;">Sursa: ${esc(r.sursa)}</span><br/>`
                        + `<span style="color:#ffcc02;">⚠ Verifica si apasa „Aplica".</span>`;
                } else {
                    res.innerHTML = `AI n-a putut stabili sigur numarul.<br/>${esc(r.explicatie)}`;
                }
            } catch (e) {
                res.innerHTML = `<span style="color:#ff8a65;">Eroare AI: ${esc(e.message || String(e))}</span>`;
            } finally {
                btn.disabled = false;
                btn.textContent = txtVechi;
            }
        });

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
