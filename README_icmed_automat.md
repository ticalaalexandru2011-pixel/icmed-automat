# iCmed Automat - Alimentare Stoc (v1.6)

Script Tampermonkey care completeaza automat formularul "Alimentare stoc medicamente" / "Alimentare stoc materiale"
din iCmed, pe baza unui fisier XML exportat din SAGA.

---

## Instalare

### 1. Instaleaza Tampermonkey
- Chrome: https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo
- Edge: https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd

### 2. Adauga scriptul (recomandat: instalare cu auto-update)

Deschide acest link in browser-ul cu Tampermonkey instalat — se va deschide direct fereastra de instalare:

https://raw.githubusercontent.com/ticalaalexandru2011-pixel/icmed-automat/main/icmed_automat.user.js

Click **Install**. Gata.

**Auto-update:** scriptul are `@updateURL`/`@downloadURL` setate, deci Tampermonkey verifica singur versiunea si se actualizeaza automat de pe GitHub cand creste `@version`. Nu mai trebuie sa copiezi nimic manual.

### Instalare manuala (alternativa)
1. Click iconita Tampermonkey din bara browser-ului -> Dashboard
2. Click + (New script)
3. Sterge tot ce e acolo
4. Copiaza continutul fisierului `icmed_automat.user.js`
5. Lipeste -> Ctrl+S

---

## Pagini suportate

Scriptul apare **doar** pe paginile relevante:

| Pagina iCmed              | Ce arata panoul            | Ce produse proceseaza       |
|---------------------------|----------------------------|-----------------------------|
| Alim. stoc medicamente    | "iCmed Automat — Medicamente" (verde) | Produse cu cod W din XML |
| Alim. stoc materiale      | "iCmed Automat — Materiale" (verde)   | Produse fara cod W + extras rutate manual |

---

## Utilizare

1. Mergi pe iCmed -> Alim. stoc medicamente sau Alim. stoc materiale
2. Apare panoul verde in dreapta sus
3. Selectezi fisierul XML exportat din SAGA (denumit `FIRMA SERIENR.xml`, ex: `SARALEX SRX20146.xml`)
4. Scriptul iti arata primul produs
5. **Optioal:** modifica numele facturii in campul editabil "Factura:" din panou (dai Enter sau ✓)
6. Dai **"Completeaza campurile"** o singura data (prima data, manual)
7. Verifici datele completate
8. Dai **"Urmatorul produs"** -> salveaza automat, trece la urmatorul produs si **completeaza automat campurile**
9. De acum inainte: doar verifici si dai "Urmatorul produs" — nu mai trebuie sa atingi "Completeaza campurile"

### Redenumire factura din panou

Dupa ce incarci XML-ul, linia "Factura:" devine editabila:

```
Factura: [SARALEX SRX20146    ] [✓]
```

- Scrii orice text (ex: `FAC 1234 MAI 2026`, `ALFABETA AB567`)
- Dai **✓** sau **Enter**
- Istoricul se actualizeaza imediat cu noul nume
- Formatul `FIRMA SERIENR` e recunoscut special (firma si numar separate); orice alt text e salvat ca atare

### Reset auto-completare

Auto-completarea se reseteaza (revii la modul manual pentru primul produs) cand:
- Incarci un XML nou
- Folosesti "Sari la" pentru a sari la un alt produs

### Fluxul complet pentru o factura

1. **Pagina Medicamente** — incarci XML -> (optional: redenumesti factura) -> completezi primul produs manual -> "Urmatorul produs" merge automat
2. **Pagina Materiale** — incarci acelasi XML -> la fel, primul manual apoi automat

---

## Resume dupa curent / reload / schimbare pagina

Scriptul salveaza automat in `localStorage`:
- Fisierul XML (nu trebuie reincarcat la schimbarea paginii)
- Pozitia curenta separata per pagina (med si materiale)
- Numele fisierului XML (pentru a reconecta factura la istoric la auto-load)

La urmatoarea sesiune sau dupa schimbarea paginii:
- XML-ul e incarcat automat
- Casuta "Mergi la nr." e pre-completata cu produsul unde ai ramas
- Statusul arata: "XML auto-incarcat — 37 produse — continui de la produsul 5"
- Dai "Sari la" (sau continui direct)

Daca vrei sa incepi de la 0, scrie `1` in casuta si dai "Sari la".

---

## Verificare si recompletare automata

Dupa fiecare completare, scriptul verifica daca toate campurile au fost umplute corect. Daca gaseste ceva gol sau TVA gresit, recompleata automat si afiseaza un mesaj galben:

> ⚠ Recompletat: lot, pret

Campuri verificate: numar lot, data expirarii, unitate comanda (intotdeauna a 2-a optiune), cantitate, pret unitar, cota TVA.

---

## Campuri completate automat

| Camp iCmed             | De unde vine                                                      |
|------------------------|-------------------------------------------------------------------|
| Medicamente / Materiale | Cod W (med) sau primul cuvant din denumire (materiale)          |
| Numar lot              | LOT: din XML                                                      |
| Data expirarii         | BBD: din XML (convertit la DD/MM/YYYY)                            |
| Unitate comanda        | Intotdeauna a 2-a optiune din lista                               |
| Cantitate              | bucati/cutie x nr cutii (rotunjit)                                |
| Pret unitar (fara TVA) | valoare totala / total bucati (4 zecimale, separator virgula)     |
| Cota TVA               | tva_art din XML (0, 9 sau 19) - ultimul input din randul Pret     |

---

## Buc/cutie nedetectate

Cand scriptul nu poate detecta numarul de bucati per cutie din denumire (ex: produs fara "X 30CP" sau similar),
afiseaza un avertisment rosu si o casuta "Buc/cutie:" in panou:

1. Introduci manual nr. de bucati/cutie
2. Dai **"Aplica"** sau **Enter**
3. Scriptul recalculeaza cantitatea si pretul
4. Continui normal cu "Completeaza campurile"

---

## Fluxul Medicamente (detaliat)

Langa campul Medicamente sunt doua iconite: **[fereastra] [X]**.

Scriptul:
1. Filtreaza butoanele din randul Medicamente, exclude orice buton cu src/title/alt ce contine "delete/clear/remove/cancel"
2. Apasa **primul** buton ramas = iconita fereastra (deschide popup cautare)
3. Asteapta 1.2s, cauta inputul din popup (element cu z-index > 100 sau position:fixed)
4. Scrie codul W, dispatchEvent input+change, asteapta 0.5s, da Enter
5. Asteapta 1.5s - daca popup-ul e inca deschis, da click pe primul rand din rezultate

### Produs negasit in iCmed

Daca dupa cautare campul Medicamente ramane gol, scriptul arata un avertisment:
- **"Trimite la Materiale"** — salveaza produsul in `localStorage` (extra-materiale), trece la urmatorul
- **"Continua manual"** — lasa campul gol, tu completezi manual, apoi "Urmatorul produs"

Produsele trimise la materiale apar automat pe pagina Alim. stoc materiale la urmatoarea incarcare XML.

---

## Fluxul Materiale (cautare)

Pe pagina Materiale, scriptul cauta dupa **primul cuvant din denumire** (nu dupa cod W).
Produsele cu W rutate de la Medicamente catre Materiale sunt cautate la fel.

---

## Fluxul Pret + TVA (detaliat)

Pret unitar si Cota TVA sunt in **acelasi `<tr>`** din formular.

Scriptul:
1. Gaseste `<tr>`-ul care contine label-ul "Pret unitar"
2. Colecteaza toate inputurile vizibile din acel `<tr>`
3. `inputs[0]` = Pret unitar -> seteaza valoarea si da Enter (declanseaza recalculul paginii)
4. Asteapta 700ms pentru recalcul
5. Re-gaseste inputurile (pagina poate fi actualizata)
6. `inputs[inputs.length - 1]` = Cota TVA -> focus, select, seteaza valoarea, da Enter

**De ce nu se foloseste Tab:** `KeyboardEvent` pentru Tab este ignorat de Chromium pentru navigarea focusului. Se foloseste direct `.focus()` pe indexul corect al inputului.

---

## Salveaza automat + inchide dialog

Butonul "Urmatorul produs" din panou:
1. Cauta in pagina orice element vizibil cu text/value/alt/title/name ce contine "salv"
   - Cauta in: `input[type="button"]`, `input[type="submit"]`, `input[type="image"]`, `button`, `a`
2. Da click pe butonul Salveaza
3. Asteapta 1.2s
4. Daca apare un dialog de avertisment iCmed cu buton "Ok", da click automat pe el
5. Trece la urmatorul produs

`input[type="image"]` este inclus deoarece ASP.NET WebForms foloseste frecvent butoane imagine.

---

## Istoric facturi cu foldere

Panoul are un buton **"Istoric"** care arata facturile grupate pe foldere personalizate:
- ✅ = complet procesata (med + materiale)
- ⏳ = in curs

Scriptul detecteaza factura din **numele fisierului XML**: `FIRMA SERIENR.xml`

Exemple:
- `SARALEX SRX20146.xml` → firma: SARALEX, serie: SRX, nr: 20146
- `ALFA PHARMA AF12345.xml` → firma: ALFA PHARMA, serie: AF, nr: 12345

Poti redenumi oricand factura direct din panou (campul editabil "Factura:").

Informatii salvate per factura: data incarcare, total produse med/mat, produse procesate, status completare.

Daca o factura a ramas marcata ca "in curs" (⏳) si vrei s-o inchei manual, dai click pe butonul
**"✅ Marcheaza gata"** din lista de istoric.

### Organizare pe foldere

Facturile pot fi organizate in foldere personalizate:

- **Folder implicit:** `General` — nu poate fi sters
- **+ Folder nou** — buton la baza listei, dai click si scrii un nume
- **✏ Redenumeste** — in interiorul fiecarui folder, schimba numele
- **🗑 Sterge folder** — disponibil pe foldere non-General; facturile din el se muta in General
- **Muta factura** — fiecare factura are un dropdown cu toate folderele; selectezi destinatia si se muta imediat

---

## Formate XML suportate

Scriptul detecteaza automat formatul `text_supl` din XML:

| Format           | LOT                    | BBD                    | Cod W               |
|------------------|------------------------|------------------------|---------------------|
| SAGA standard    | `LOT:5R01586A`         | `BBD:2026-04-30`       | `CIM:W43285003`     |
| UNICAFARM        | `LOT: 250787`          | `BBD: 30.04.2027`      | `CodCIM: W01704002` |
| PHYTALFARMACIE   | `Lot: TRG1306,`        | `BBD: 2027-08-31,`     | `CodCIM: W08199003` |
| CRISFARM         | *(absent)*             | *(absent)*             | *(absent)*          |

Regex-urile sunt case-insensitive (`/i`) si accepta spatiu optional dupa `:`.

### CRISFARM — format special

La CRISFARM, `<text_supl />`, `<cod />` si `<LOT />` sunt **goale** — scriptul nu poate extrage niciun cod W, LOT sau BBD.

Consecinte:
- Toate produsele merg automat pe pagina **Materiale** (niciun cod W)
- Campurile Numar lot si Data expirarii raman goale — le completezi manual daca e nevoie
- Cantitate si Pret sunt calculate din `<cantitate>` si `<valoare>` din XML

Formate de denumire intalnite la CRISFARM:
- `EUROMED PERFUZOR CU AC METALIC (BUC)` — cantitate deja in BUC (50 BUC = 50 bucati individuale)
- `GLUCONAT CALCIU 10% CT*20FIOLE_10ML BRAUN (CT*20FI)` — 1 cutie x 20 fiole
- `ZDROVIT CALCIDIN CTX56 CPR (CT*56CPR)` — 1 cutie x 56 comprimate
- `ZENTINOR CTX20 FI (CT*20FI)` — 1 cutie x 20 fiole

**Atentie:** `(BUC)` in denumire inseamna ca `<cantitate>` e deja in bucati individuale (buc/cutie = 1). Scriptul nu detecteaza automat asta — va afisa avertismentul rosu "Buc/cutie nedetectate". Introdu manual **1** in casuta si apasa Aplica.

---

## Structura XML SAGA

```xml
<c_xml>
  <denumire>ALGIFEN SOLUTIE INJ 5ML X 5FI W43285003</denumire>
  <cod>W43285003</cod>
  <cantitate>3</cantitate>        <!-- cutii, poate fi zecimal: 2.33 -->
  <valoare>124.44</valoare>       <!-- total fara TVA -->
  <tva_art>0</tva_art>            <!-- cota TVA: 0, 9 sau 19 -->
  <text_supl>LOT:5R01586A,CIM:W43285003,BBD:2026-04-30 ...</text_supl>
</c_xml>
```

Codul W se extrage din (in ordine de prioritate):
1. `CIM:WXXXXXX` din text_supl
2. Tag-ul `<cod>`
3. Pattern `W\d+` din denumire

---

## Logica calcul bucati per cutie

Din denumire se extrage numarul de bucati:
- "X 30CP.FILM"  -> 30 bucati/cutie
- "X 5FI"        -> 5 fiole/cutie
- "20FI BRAUN"   -> 20 fiole/cutie (fara X)
- "X 1000ML"     -> 1 (volum, nu bucati - ML nu e in lista de unitati)

Unitati recunoscute: FI, FIOLE, FL, FLACOANE, CP, CPS, CAPS, CAPSULE, TB, DR, DRAJEURI, COMP, COMPRIMATE, PLIC, SUPOZ, AMP

**Nerecunoscute (afiseaza avertisment rosu):** BUC, CPR, ML, G, MG — pentru acestea introduci manual buc/cutie in casuta rosie.

Total bucati = round(bucati_cutie x cantitate_din_xml)
Pret/bucata  = valoare / total_bucati (4 zecimale, separator virgula)

---

## localStorage — chei folosite

| Cheie                          | Ce stocheaza                                      |
|--------------------------------|---------------------------------------------------|
| `icmed-automat-xml`            | Continutul XML al ultimei facturi incarcate       |
| `icmed-automat-xml-filename`   | Numele fisierului XML (pentru reconstituire info) |
| `icmed-automat-med-idx`        | Pozitia curenta pe pagina medicamente             |
| `icmed-automat-mat-idx`        | Pozitia curenta pe pagina materiale               |
| `icmed-automat-factura-curenta`| Obiectul info al facturii curente (firma/serie/nr)|
| `icmed-automat-istoric`        | Array cu toate facturile procesate (max afisat 15)|
| `icmed-automat-extra-materiale`| Produse cu W rutate manual catre materiale        |
| `icmed-automat-folders`        | Array foldere personalizate din istoric           |

---

## Probleme cunoscute / de testat

1. **Popup Medicamente** - daca nu se deschide sau nu selecteaza corect,
   trimite screenshot si ajustam selectorul (`gasestePopup` cauta z-index > 100 sau position:fixed)

2. **Butonul Salveaza** - daca nu il gaseste, da F12 -> click pe butonul Salveaza -> Elements
   si verifica exact tagul, tipul si atributele (value/alt/title/name trebuie sa contina "salv")

3. **Butonul Ok (dialog avertisment)** - daca nu apasa automat, da F12 -> click pe Ok -> Elements
   si verifica tagul si textul exact (scriptul cauta text care potriveste `/^[^a-z]*ok[^a-z]*$/i`)

4. **Campurile lot / data expirare** - daca nu se completeaza, probabil
   labelurile din HTML difera (ex: "Nr. lot" vs "Numar lot" vs "Data expirarii" vs "Data expirar")
   Ajusteaza parametrul din `inputLangaLabel('Numar lot')` si `inputLangaLabel('Data expir')`

5. **Separatorul zecimal la pret** - scriptul foloseste virgula (ex: 3,6485)
   Daca iCmed vrea punct, schimba `.replace('.', ',')` in `.replace(',', '.')`
   in functia `parseazaXML`

6. **Cota TVA ramane la default** - daca pagina recalculeaza si adauga/sterge inputuri
   dupa Enter la pret, re-gasirea cu `inputsNoi` ar trebui sa rezolve; daca nu,
   mareste `await sleep(700)` la mai mult (ex: 1200)

7. **Materiale consumabile** - de configurat separat (nu au cod W, sunt in lista rosie)

---

## Fisiere

- `icmed_automat.user.js` - scriptul principal v1.5 (se instaleaza in Tampermonkey)
- `README_icmed_automat.md` - acest fisier
