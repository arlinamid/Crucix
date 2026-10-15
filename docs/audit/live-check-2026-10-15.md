# Crucix élő ellenőrzés: 2026-10-15 13:31 (+02:00)

Automatikus, csak olvasó ellenőrzés a futó 2.47.0-s szerveren (`http://127.0.0.1:3117`). Kódot, konfigurációt és adatot nem módosítottam, a szervert nem indítottam újra.

## Összefoglaló

**Ami működik**
- A szerver fut, újraindítás nélkül: uptime 35 948 s (~10 óra), vagyis a 2.47.0 telepítése (~03:32) óta. `status: ok`, `historyEngine: sqlite`, a history, a risk és az archive állapota is `ok`.
- A sweep-archívum importja egyszer futott le (`history-import`: 01:35:41Z, 117 s, ok), utána nem indult újra. A history 33 555 rekordot tart, 2026-10-12 17:45Z óta.
- A karbantartás hibátlan: 125 futás, `lastError: null`, üres várakozási sor. Job-idők: save 333 ms, history 10 ms, thread-archive 3 ms.
- A szálak száma már nem ragad sapkán: 556 aktuális szál (a sapka 2 000). A Past lista 28 szálat tart, és egyetlen id vagy cím sem szerepel egyszerre az aktuálisak között is.
- A latencia kiváló: median 4,4 ms, p95 9,0 ms, max 30,4 ms (a cél p95 < 50 ms volt).
- Az útvonal-lefedettség tovább nőtt: 4 583 / 6 748 légitársasági járat (68%; 03:00-kor 65,5%, a baseline-kor 22% volt).

**Amit figyelni kell**
1. **Egyetlen mentés sem tartalmazza még az importált rekordokat.** A `history.db.bak` 03:33:29-kor készült, 27 MB-os, és ez kb. 13,5 ezer rekordnak felel meg. Az import 03:35:41-kor ért véget, így a mentés még az import előtti állapotot rögzíti. A `history-import.json` késznek jelöli a fájlokat, ezért ha a db sérülne, az import magától nem futna újra.
2. **A régebbi napok darabszáma kicsit csökkent** a 03:5x-es állapothoz képest: 12-én −6, 13-án −30, 14-én −311. Valószínű ok, hogy az ismétlődő eseményeknél upsert frissíti az időbélyeget, így ezek a mai napra „vándorolnak”. Ezt ellenőrizni kell, mert napi statisztikában félrevezető.
3. **A növekedés és a méret:** a history.db 64,6 MB (~1,93 KB/rekord). Az élő ütem a 2.47 óta ~660 rekord/óra, ~16 000/nap. 30 napra ez ~480 ezer rekord, ~0,9 GB, és a napi `.bak` miatt összesen ~1,85 GB.
4. **A graph.json mérete** 2,1 MB-ról 7,3 MB-ra nőtt, a save job ideje 242 ms-ról 333 ms-ra.
5. **A Past lista lassan nő:** 03:5x óta csak +5 szál (23 → 28). Közben az aktuális szálak 47%-a `fading` (261 / 556).
6. **A szerver naplóját nem tudtam olvasni.** A terminál-eszköz ebben az ütemezett futásban jóváhagyást kért, a primary terminálban pedig nem fut shell. Naplófájl nincs a `~/.crucix` alatt. Emiatt a Post-processing időket és a figyelmeztetéseket ebben a futásban nem tudtam ellenőrizni.

## Összehasonlító táblázat

| Mérőszám | Baseline (10-14 21:42, 2.46) | 03:00 (2.46) | 2.47 után (03:5x) | Most (10-15 13:31, 2.47) |
|---|---|---|---|---|
| History rekord | 10 506 | 13 384 | 27 262 | **33 555** |
| 12 / 13 / 14 / 15 okt. | – / 1 261 / 9 245 / – | – | 3 120 / 11 585 / 9 755 / 2 802 | 3 114 / 11 555 / 9 444 / 9 442 |
| history.db | 20 MB | – | – | 64,6 MB |
| history.db.bak | napi | – | 03:33 | 27,1 MB, 03:33 (~10 órás) |
| Aktuális szálak | 160 | 200 (sapka) | 439 | **556** |
| Past szálak | 0 | – | 23 | 28 (12.: 5, 13.: 19, 14.: 4) |
| Duplikátum current/past | – | – | 0 | 0 (id és cím alapján is) |
| graph.json | 2,1 MB | – | – | 7,3 MB |
| threads.json | – | – | – | 172 KB |
| Légtérben | 11 022 | – | – | 7 901 |
| Útvonal ismert / légitársasági | 1 698 / 7 662 (22%) | 3 843 / 5 865 (65,5%) | – | 4 583 / 6 748 (68%) |
| Notable / flows | 202 / 80 | – | – | 132 / 80 |
| Post-processing events+history | 606 ms (első sweep) | ~450–620 ms | 858 ms (első sweep) | nem mérhető (nincs napló) |
| Post-processing risk+graph+threads | 500 ms | ~290–720 ms | 688 ms | nem mérhető |
| Latencia median / p95 / max | – | 6 / 10 / – ms | 6 / 23 / 106 ms (üresjárat) | **4,4 / 9,0 / 30,4 ms** |
| Karbantartási hiba | nincs | nincs | nincs | nincs (125 futás) |
| Források ok / hibás | – | – | – | 65 / 3 |

## Részletek

**Health.** A legutóbbi sweep 11:17:30Z-kor indult és 11:17:58Z-kor ért véget (~28 s), a következő 11:32:58Z-re van ütemezve, tehát a 15 perces ütem tart. `archivedSweeps: 75`. 3 forrás hibás. A health végpont nem adja vissza a nevüket.

**History.** `retentionDays: 30`, `maxRecords: 1 000 000`, `retainedBytes` 64 622 592. Típus szerint a news dominál (29 321), utána a weather (2 722) és a maritime (533) jön. A 10–11. októberi napok nem szerepelnek, ahogy vártuk: akkor alig futott a Crucix.

**Import.** A `history-import.json` 12,9 KB, 03:35-ös, és a `runs/sweeps/*` fájlokat feldolgozottként tartja számon. A job egyszer futott (117 s). A rekordszámok illeszkednek a másolaton mért értékekhez: az élő import 13 465 új rekordot adott, a másolaton 13 471 volt.

**Szálak.** Összesen 556. Témák: nincs téma 232, politika 120, gazdaság 57, konfliktus 53, katasztrófa 46, technológia 43, egészség 5. Státuszok: fading 261, active 248, emerging 42, escalating 5.

**Archívum.** A `days` mező értéke 10–14. október. A fájlok:

| Fájl | Méret | Írva |
|---|---|---|
| 2026-10-10.json | 85 B (üres) | 10-14 21:27 |
| 2026-10-11.json | 85 B (üres) | 10-15 02:11 |
| 2026-10-12.json | 297 KB | 10-15 03:36 |
| 2026-10-13.json | 1,19 MB | 10-15 03:37 |
| 2026-10-14.json | 1,03 MB | 10-15 03:38 |

Az archív fájlok 2–2,5 MB-os összmérete jóval nagyobb, mint amennyit a 28 megjelenő Past szál indokolna. Ennek oka, hogy a Past lista kihagyja azokat a szálakat, amelyeknek van még aktuális tagja. Néhány példa:

- 12.: „M5.5 TONGA”; „Türkiye strongly condemns Houthi attack on Saudi airport”
- 13.: „Airlines cancel flights to Saudi Arabia after Riyadh airport attacks”; „Zelensky says Western partners didn't warn Ukraine…”
- 14.: „Four Killed, 29 Injured in Russian Attacks on Ukraine”; „Minor earthquake recorded on Kyrgyzstan-Uzbekistan border”

**Légtér.** OpenSky, `fallback: false`. 7 901 gép van a levegőben (napszakfüggő, ezért a baseline 11 022-es értékével nem összevethető). Notable: 21 high, 35 military, 76 nocallsign. A flows száma 80, ugyanannyi, mint a baseline-kor; ez valószínűleg a megjelenítési felső korlát. A legforgalmasabb flow-k: HND→FUK 8, NRT→ICN 8, KIX→ICN 7, BER→AYT 5, BNE→PER 5.

**Latencia.** 30 kérés a `/api/health` végpontra, 300 ms-onként. Min 3,8, median 4,4, p95 9,0, max 30,4 ms.

## Javasolt következő lépések (nem implementáltam)

1. **Azonnali, kézi history-mentés,** vagy annak ellenőrzése, hogy a holnap ~03:33-as napi backup tartalmazza-e a ~33 ezer rekordot. Ha ezt automatizálni kell: egy egyszeri import után a karbantartás készítsen soron kívüli backupot.
2. **A napi darabszám csökkenésének vizsgálata.** Meg kell nézni, hogy a history upsert felülírja-e az esemény `at`/első észlelés idejét. Ha igen, érdemes külön `firstSeen` mezőt tartani, és a napi statisztikát arra számolni.
3. **A méret tervezése.** A ~0,9 GB-os db és ugyanekkora backup ellen segíthet a backup tömörítése, egy `VACUUM INTO` alapú mentés, vagy egy `maxBytes` limit beállítása (most `null`). 1–2 nap múlva érdemes újramérni a napi ütemet, mert a 14-i teljes nap csak ~9,4 ezer rekord volt, a mai ütem viszont ~16 ezer/nap.
4. **A graph.json növekedésének követése.** Ha napi szinten tovább nő, és a save job 500 ms fölé megy, érdemes megfontolni a gráf-csomópontok idő alapú ritkítását vagy a bináris/inkrementális mentést.
5. **A Past/Current átmenet ellenőrzése** egy nappal később. Holnap várható a 15-i archív fájl, és a 12–13-i szálaknak tömegesen át kell kerülniük a Past listába, ahogy kiesnek a 72 órás ablakból. Ha a Past lista 28 körül marad, a „van még aktuális tag” szűrő túl szigorú.
6. **Napló a következő ellenőrzéshez.** A szerver kimenetét érdemes fájlba is írni, például `crucix server *>&1 | Tee-Object runs\server.log`, vagy a következő futás előtt jóváhagyni a terminál-olvasást. Így a Post-processing idők és a figyelmeztetések is ellenőrizhetők lesznek.
7. **A 3 hibás forrás azonosítása,** például a `/api/data` forrásállapotából. Hasznos lenne, ha a health végpont a nevüket is visszaadná.
