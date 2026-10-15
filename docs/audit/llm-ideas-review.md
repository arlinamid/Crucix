# LLM-ötletek: hogyan dolgoznak, és mi változott a 2.48-ban

**Dátum:** 2026-10-15 · **Alap:** az élő 2.46–2.47-es szerver naplója (2026-10-14 21:25 – 2026-10-15 03:56), `lib/llm/{ideas,cadence,rule-ideas,cursor}.mjs`

## Hogyan dolgoztak a 2.48 előtt

- **Mit csinálnak.** Minden sweep végén egy „kvantitatív elemző” szerepű prompt (`locales/*.json` → `llm.systemPrompt`) 5–8 kereskedési ötletet kért JSON-ban. Egy ötlet mezői: LONG, SHORT, HEDGE, WATCH vagy AVOID; ticker; magabiztosság; indoklás; kockázat; időtáv.
- **Mit látott a modell** (`compactSweepForLLM`, legfeljebb 12 000 karakter):
  - a delta (változások az előző sweep óta);
  - FRED-mutatók (VIX, kamatok, hozamgörbe, HY-felár, dollárindex, jelzálog);
  - energia (WTI, Brent, földgáz, készletek);
  - fémek (arany, ezüst);
  - BLS munkaerőpiac, államadósság, GSCPI ellátási lánc;
  - legfeljebb 5 sürgős OSINT-poszt;
  - hőanomália-régiók;
  - a régi, 10 dobozos légi számok;
  - nukleáris anomáliák, WHO, védelmi szerződések;
  - az előző ötletek, hogy ne ismételje őket.
- **Mit nem látott:**
  - a történetszálakat;
  - az országkockázat mozgásait;
  - a fegyveres konfliktus eszkalációját;
  - a témák megoszlását;
  - a légi riasztásokat (squawk, katonai mintázatú hívójel).

  Pedig ezek a 2.41–2.47 legerősebb, több forrással alátámasztott jelei.
- **Ütem:** az éles `.env`-ben `LLM_IDEAS_EVERY_N_SWEEPS=1`, vagyis minden sweepben, 15 percenként.
- **Szolgáltató:** a Cursor Agent CLI (`agent -p --mode ask`). A 2.39.3-as mérés szerint kb. 50 s telik el az első bájtig.
- **Mért idők az éles naplóban** (a `delta+ideas` lépés, 23 sweep): 45–180 s, a medián kb. 65 s. Egyszer időtúllépés volt (180 s); ekkor a szabályalapú ötletek mentek ki.
- **A fő gond:** a szerver *megvárta* az ötleteket, és csak utána írta a historyt, számolta a kockázatot és a szálakat, és küldte ki a frissítést. Minden sweep friss adata így 1–3 percet késett a dashboardon, és a sweep a kb. 30 s helyett kb. 2,5 percig tartott.

## Mi változott a 2.48-ban

1. **A sweep nem vár.**
   - A pillanatkép az utolsó modellötletekkel (vagy szabályalapú ötletekkel) azonnal kimegy.
   - A modell a kiküldés után fut (`startIdeas`), egyszerre legfeljebb egy.
   - Amikor kész, a dashboard egy kis `ideas` SSE-üzenetben megkapja az új ötleteket, és bekerülnek a memória utolsó futásába is (a következő prompt „ne ismételd” listájához).
   - Ha a modell hibázik vagy időtúllépésbe fut, a publikált ötletek maradnak.
2. **Új alapértelmezett ütem: óránként** (`LLM_IDEAS_EVERY_N_SWEEPS=4`).
   - Ez csak a kódbeli alapértelmezés; az éles `.env` 1-es értéke felülírja.
   - **Javaslat:** írd át 4-re. A kereskedési ötletek nem változnak 15 percenként, a Cursor CLI viszont minden hívásnál ~1 percig dolgozik.
3. **Gazdagabb kontextus**, közvetlenül a delta után:
   - `STORY_THREADS`: legfeljebb 8 szál, az eszkalálódók elöl; témával, rekord- és forrásszámmal, országokkal;
   - `THREAD_TOPICS`;
   - `COUNTRY_RISK_MOVERS_24H`: az 5 legnagyobb 24 órás változás;
   - `ARMED_CONFLICT_REPORTS`: mai beszámolók a szokásoshoz képest, az eszkaláció mértéke;
   - `AIR_ALERTS`: squawkok, katonai mintázatú hívójelek.

   A 12 000 karakteres korlát marad.
4. **Mérés.** Minden futás rögzíti a prompt méretét, a modell idejét, a válasz méretét, a feldolgozott ötletek számát vagy a hiba okát. Ez kiíródik a naplóba (`[LLM Ideas] … in … ms (prompt … chars)`), és az `/api/health` válaszban (`ideas.last`) is látszik.

## Mit érdemes még megnézni

- **A Cursor CLI lassú** (~50 s az első bájtig). Egy közvetlen API-s szolgáltató (pl. Anthropic, OpenAI) jellemzően 5–15 s alatt válaszolna. Ez a felhasználó döntése: költség és kulcs kell hozzá.
- **A prompt kereskedési fókuszú.** Ha az ötletek célja a helyzetértékelés is, érdemes egy második, rövid „mi változott és miért fontos” kimenetet kérni a szálakból. Ez külön döntés.
- **A minőség mérése.** A `lastRun` adatai (hányszor esik vissza szabályalapúra, mekkora a prompt) a napló alapján egy hét után értékelhetők.
