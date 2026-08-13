# MakeShiftBrothers Motorsport — Projekt átadó / állapot

> Ez a dokumentum összefoglalja a projekt teljes állapotát, hogy **bármelyik gépen,
> bármelyik új Claude Code beszélgetésben** azonnal folytatható legyen a munka.
> Ha új chatben vagy: olvasd el ezt, és a kódot — ebből képben vagy.

## Mi ez?
Egy **állóképességi (endurance) verseny dashboard** a MakeShiftBrothers csapatnak.
Tiszta statikus weboldal (nincs saját backend), 3 fájl:
- `index.html` — szerkezet
- `style.css` — kinézet (sötét/világos téma)
- `script.js` — az összes logika

Adattárolás: `localStorage` + opcionális **Firebase Realtime Database** (eszközök közti szinkron).
Élő köridők: a `live.chronomoto.com`-ról, CORS-proxykon keresztül.

## Élesítés / hosting
- **GitHub repo:** `https://github.com/SzuperSzergely/makeshift-motorsport` (public)
- **Élő cím (GitHub Pages):** `https://szuperszergely.github.io/makeshift-motorsport/`
- **Deploy:** `git commit` + `git push origin main` → a Pages ~1-2 perc alatt magától frissül.
- **Cache-busting:** az `index.html` a `style.css`/`script.js`-t `?v=ÉÉÉÉHHNN` verzióval linkeli —
  **minden érdemi módosításnál növeld a verziószámot** (`sed` a build-ben), különben a böngésző a régit cache-eli.
- `.gitignore` kizárja: `temp.html`, `temp_lap.html` (régi teszt-fájlok), `.claude/`.
- Git identitás lokálisan beállítva (email: `szaszegri@gmail.com`); a push a Git Credential Managerrel hitelesít.
- Helyi teszt: `python -m http.server` (a `file://` nem futtatja jól a JS-t — kell szerver).

## Pilóták
`DRIVERS = ['Lackó', 'Zsemle', 'Boldi', 'Beni']`
(Korábban „Tóth" volt Boldi helyén — mindenhol átnevezve: JS tömbök/mapek, HTML legördülők, **és a CSS `.color-Boldi` osztályok** is.) Átnevezés → színek/statisztika/CSS mind érintett.

## Idő-modell (24 órás verseny támogatás)
Minden belső idő **„abszolút perc a verseny napjának (plan.date) éjfelétől"** → éjfél után is folytonos
(pl. 02:00 másnap = 1560). `fmtClock(absMin)` → `HH:MM` (a régi „+1" nap-jelzőt kivettük).
Éjfél-átlépő etap: `stintDurationMin` +1440-et ad, ha a vége < a kezdés.
`getCurrentTimeMinutes()`: szimulációban `simTimeMinutes`, élesben `dateToAbsMin(new Date())`.

## Terv (Tervező fül)
`plan` objektum (localStorage `race_plan_v1`, alapértelmezés: `DEFAULT_PLAN`). Mezők:
`date`, `endDate` (24h esetén a következő nap), `qualyStart`, `raceStart`, `raceEnd`,
`eveningStart` (20:00), `eveningEnd` (06:00), `stints: [{driver, start, end}]`.
`rebuildPlanDerived()` ebből számol: `SCHEDULE`, `RACE_START_MIN`, `RACE_END_MIN`, `STAGE2_START_MIN`,
`EVENING_START_MIN`, `EVENING_END_MIN`, `DRIVER_PLANNED_TOTAL`, és a `QUALY_TIME`/`RACE_TIME`/`RACE_END_TIME` dátumok.
A Tervező fül: esemény-időpontok + szerkeszthető etap-táblázat + **auto-generátor**
(egy etap hossza + pilóta-sorrend → az etapok számát a versenyablakból számolja, a sorrendet körbejárva).

## Csere-motor (a rotáció sorrendje FIX, csak az idők változnak)
- `swapLog` (localStorage `swapLog_v3`) = rendezett határ-események `[{time, driver?}]`.
  A k. elem a k. etap végét jelöli; a `driver` (ha van) a SORON KÍVÜLI csere felülírása a beugró (k+1.) etapra.
- `buildTimeline()` a vezetőket a **rotációból** (`SCHEDULE` sorrend) veszi (felülírásokkal) → sima cserénél
  a sorrend SOSEM keveredik; csak az idők tolódnak (`replanRemaining` a tervezett összidőkre osztja el, 23:00-ra záruljon).
- `performSwap(overrideDriver)`: sima csere = `performSwap(null)` (rotáció következő pilótája);
  soron kívüli = `performSwap(X)`. SZIMULÁCIÓBAN „utolérés": rögzíti az addig automatikusan lezárult
  határokat, majd a kijelzett aktív etapot most zárja.
- ÉLESBEN a jelenlegi etap „tartott" (nem lép magától tovább a tervezett cserénél — a gomb rögzíti);
  SZIMULÁCIÓBAN idő szerint automatikusan lépked.
- `getActiveSegment` / `getNextSegment`. Visszavonás = az utolsó határ törlése.
- `seg.etap` = a pilóta hányadik köre (mindenki N-edik előfordulása = Etap N — pl. Lackó/Boldi/Zsemle/Beni
  első köre = Etap 1, a következő körük = Etap 2).

## Esti/éjszakai szakasz
A beosztás-táblában két elválasztó, dinamikusan a tervből: 🌙 „ESTI SZAKASZ KEZDETE — HH:MM"
(az első, esti kezdet utáni etap előtt) és ☀ „ESTI SZAKASZ VÉGE — HH:MM". Éjfélen átnyúlik.

## Figyelmeztetések / szimulátor
- 15 perccel a csere előtti **sáv** `.warning-stack` (position: fixed lebegő réteg → NEM tolja a tartalmat);
  szimulációban is látszik. A **teljes képernyős modal** csak ÉLESBEN.
- A szimulátor nem „ugrál": a mock köridők **determinisztikusak** (seed, nem `Math.random`);
  a telemetria csak a csúszka elengedésekor (`change`) + a 2 mp-es időzítővel frissül
  (a felesleges újrarajzolást a `lastSimTelemetryMin` szűri).

## Telemetria
Chronomoto proxykon át (`allorigins`/`codetabs`/`thingproxy`). Szimulációban `generateMockTelemetryLaps`
(determinisztikus). A körök `absMin`-t hordoznak; `getDriverForAbsMin` / `lapAbsMin` a pilóta-hozzárendeléshez
(24h-nál is pontos). Ismert: proxy-adatfüggő hibák a konzolban normálisak, ha nincs élő futam.

## Grafikonok
Téma-tudatosak (`chartTheme()` a CSS-változókból; témaváltáskor újrarajzol). Pozíció = lépcsős vonal +
színátmenet; köridők = pilótánkénti scatter+vonal az app palettájával, adaptív y-tengely. Chart.js CDN-ről.

## Felhő-szinkron (Firebase Realtime Database)
- Firebase projekt: `makeshift-race`, RTDB régió `europe-west1`. A config a `SYNC_CONFIG`-ban van (`script.js`).
  A web `apiKey` publikus — nyugodtan lehet a repóban.
- `SYNC_ROOM` (localStorage `sync_room`, alap: `makeshift`). Szinkronizált: `planJson` + `swapJson`
  (JSON stringként, hogy ne legyen Firebase tömb/üres kvirk) a `rooms/<room>` alatt.
- `syncApplying` őr + JSON-egyenlőség-vizsgálat → nincs visszhang-hurok.
- `savePlan`/`saveSwapLog` hívja a `syncPushPlan`/`syncPushSwaps`-ot.
- **Riasztás-broadcast:** `broadcastAlert(...)` a gyorsgombok (Korai csere/Tankolás/Motorhiba/Ember hiba)
  popupjait a `rooms/<room>/alert`-be írja → minden eszközön felugrik. `alertListenerInit` megakadályozza,
  hogy betöltéskor a régi riasztást újra feldobja.
- Firebase compat SDK CDN-ről az `index.html`-ben. UI: „Eszközök közti szinkron" a Vezérlőpultban
  (`#syncStatus` státusz + `#syncRoomInput`/`#syncRoomBtn`).
- Ha a `SYNC_CONFIG` üres → HELYI mód (semmi nem törik).
- RTDB szabályok: a `rooms` útvonalon nyitott (test) — privát verseny-eszközhöz elfogadható;
  később szigorítható (titkos szoba-kód / auth).

## Fontos működési részletek a versenyre
- A közös **beosztást a laptopon** állítsd be (Tervező → *Terv mentése*) — az lesz a szinkron alap.
- Az „első csatlakozó" tölti fel az üres szobát; de a *Terv mentése* mindig felülírja a szoba tervét.
- A live cím és a szinkron **internetet igényel**; offline megnyitva csak a beosztás/cserék mennének.

## Lehetséges következő lépések / ötletek
- A köradatbázis (`laps_db_*`) és a pozíció-előzmény szinkronizálása is (most eszközönként külön gyűlik).
- RTDB szabályok szigorítása a verseny után.
- „Utolsó csere" több lépéses visszavonása / cserenapló nézet.

---
*Utolsó frissítés: a csere-motor, tervező, 24h, esti szakasz, grafikonok, szimulátor-simítás, GitHub Pages
deploy és a Firebase valós idejű szinkron (beosztás + cserék + riasztások) mind kész és tesztelve.*
