// MAKESHIFT BROTHERS MOTORSPORT - BEOSZTÁS KÖVETŐ LOGIKA

// ============================================================================
//  TERVEZŐ — szerkeszthető, menthető beosztás és esemény-időpontok
// ----------------------------------------------------------------------------
//  A beosztás (SCHEDULE) és az esemény-időpontok (időmérő, verseny kezdete/vége)
//  a "plan" objektumból származnak, amit a Tervező fülön lehet szerkeszteni és
//  a böngészőbe menteni. A levezetett értékeket a rebuildPlanDerived() számolja.
// ============================================================================

const DRIVERS = ['Lackó', 'Zsemle', 'Boldi', 'Beni'];

// Alapértelmezett terv (a korábbi, kódba írt beosztás)
const DEFAULT_PLAN = {
    date: { year: 2026, month: 7, day: 15 }, // hónap 0-indexelt (7 = Augusztus)
    endDate: { year: 2026, month: 7, day: 15 }, // a verseny VÉGÉNEK napja (24h esetén a következő nap)
    qualyStart: '12:00',
    raceStart: '15:00',
    raceEnd: '23:00',
    eveningStart: '20:00', // esti/éjszakai szakasz kezdete
    eveningEnd: '06:00',   // esti/éjszakai szakasz vége (átnyúlik éjfélen)
    stints: [
        { driver: 'Lackó',  start: '15:00', end: '15:40' },
        { driver: 'Boldi',   start: '15:40', end: '16:30' },
        { driver: 'Zsemle', start: '16:30', end: '17:30' },
        { driver: 'Beni',   start: '17:30', end: '18:30' },
        { driver: 'Lackó',  start: '18:30', end: '19:50' },
        { driver: 'Zsemle', start: '19:50', end: '20:50' },
        { driver: 'Boldi',   start: '20:50', end: '22:00' },
        { driver: 'Lackó',  start: '22:00', end: '23:00' }
    ]
};
const PLAN_STORAGE_KEY = 'race_plan_v1';

function loadPlan() {
    try {
        const raw = localStorage.getItem(PLAN_STORAGE_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            if (p && p.date && Array.isArray(p.stints) && p.stints.length) return p;
        }
    } catch (e) { console.error('Terv betöltési hiba:', e); }
    return JSON.parse(JSON.stringify(DEFAULT_PLAN));
}
function savePlan() {
    try { localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plan)); }
    catch (e) { console.error('Terv mentési hiba:', e); }
    if (typeof syncPushPlan === 'function') syncPushPlan(); // felhő-szinkron
}

let plan = loadPlan();

// --- Terv-alapú levezetett értékek (rebuildPlanDerived() tölti fel) ---
let SCHEDULE = [];
let TARGET_YEAR, TARGET_MONTH, TARGET_DAY;
let QUALY_TIME, RACE_TIME, RACE_END_TIME, RACE_ACTUAL_START_TIME;
let RACE_START_MIN, RACE_END_MIN, STAGE2_START_MIN;
let EVENING_START_MIN, EVENING_END_MIN; // az esti/éjszakai szakasz abszolút határai
let DRIVER_PLANNED_TOTAL = {};

// Etap hossza percben; éjfél átlépésekor (vége < kezdés) +1 nap
function stintDurationMin(s) {
    let d = timeStringToMinutes(s.end) - timeStringToMinutes(s.start);
    if (d < 0) d += 1440;
    return d;
}

function rebuildPlanDerived() {
    TARGET_YEAR = plan.date.year;
    TARGET_MONTH = plan.date.month;
    TARGET_DAY = plan.date.day;

    RACE_START_MIN = timeStringToMinutes(plan.raceStart); // a verseny napján

    // A verseny VÉGE — a vég-dátum alapján (24h esetén a következő nap)
    const startMid = raceDayMidnight();
    let endDayOffset;
    if (plan.endDate) {
        const endMid = new Date(plan.endDate.year, plan.endDate.month, plan.endDate.day, 0, 0, 0);
        endDayOffset = Math.round((endMid.getTime() - startMid.getTime()) / 86400000);
    } else {
        // Visszafelé kompatibilitás: ha nincs vég-dátum, éjfél-átlépésből következtetünk
        endDayOffset = timeStringToMinutes(plan.raceEnd) <= RACE_START_MIN ? 1 : 0;
    }
    RACE_END_MIN = endDayOffset * 1440 + timeStringToMinutes(plan.raceEnd);
    if (RACE_END_MIN <= RACE_START_MIN) RACE_END_MIN = RACE_START_MIN + 1; // védőkorlát

    STAGE2_START_MIN = RACE_START_MIN + Math.round((RACE_END_MIN - RACE_START_MIN) / 2);

    // Esti/éjszakai szakasz abszolút határai (valós órákból, éjfélen átnyúlva).
    // Az első olyan előfordulást vesszük, ami a rajt után esik; a vége az esti kezdet után.
    const firstAtOrAfter = (timeInDay, floor) => {
        let t = ((timeInDay % 1440) + 1440) % 1440;
        while (t < floor) t += 1440;
        return t;
    };
    // Alapértelmezés a régi (esti mezők nélkül mentett) tervekhez is
    const evStart = plan.eveningStart || '20:00';
    const evEnd = plan.eveningEnd || '06:00';
    EVENING_START_MIN = firstAtOrAfter(timeStringToMinutes(evStart), RACE_START_MIN);
    EVENING_END_MIN = firstAtOrAfter(timeStringToMinutes(evEnd), EVENING_START_MIN + 1);

    // SCHEDULE a terv etapjaiból; az abszolút kezdet a hosszakból, a rajtidőtől sorban
    let acc = RACE_START_MIN;
    SCHEDULE = plan.stints.map((s, i) => {
        const dur = stintDurationMin(s);
        const absStart = acc;
        acc += dur;
        return {
            id: i + 1, start: s.start, end: s.end, driver: s.driver,
            absStart, stage: absStart < STAGE2_START_MIN ? 1 : 2
        };
    });

    // Pilótánkénti tervezett összidő
    DRIVER_PLANNED_TOTAL = {};
    DRIVERS.forEach(d => { DRIVER_PLANNED_TOTAL[d] = 0; });
    SCHEDULE.forEach(s => {
        if (!(s.driver in DRIVER_PLANNED_TOTAL)) DRIVER_PLANNED_TOTAL[s.driver] = 0;
        DRIVER_PLANNED_TOTAL[s.driver] += stintDurationMin(s);
    });

    // Esemény-időpontok (Date objektumok a visszaszámláláshoz)
    const mkDate = (hhmm) => {
        const [h, m] = hhmm.split(':').map(Number);
        return new Date(TARGET_YEAR, TARGET_MONTH, TARGET_DAY, h || 0, m || 0, 0);
    };
    QUALY_TIME = mkDate(plan.qualyStart);
    RACE_TIME = mkDate(plan.raceStart);
    RACE_END_TIME = absMinToDate(RACE_END_MIN); // a vég-dátumot is figyelembe véve
    RACE_ACTUAL_START_TIME = mkDate(plan.raceStart);

    invalidateTimeline();
    if (typeof configureSimSlider === 'function') configureSimSlider();
}

// Magyar hónapnevek a dátum kijelzéséhez
const MONTH_NAMES = [
    "JANUÁR", "FEBRUÁR", "MÁRCIUS", "ÁPRILIS", "MÁJUS", "JÚNIUS",
    "JÚLIUS", "AUGUSZTUS", "SZEPTEMBER", "OKTÓBER", "NOVEMBER", "DECEMBER"
];

// Állapotváltozók
let isSimulating = false;
let lastSimTelemetryMin = null; // az utoljára kirajzolt szimulált telemetria ideje (a felesleges újrarajzolás ellen)
let simTimeMinutes = 900; // Alapértelmezett: 15:00 (15 * 60)
let currentFilter = 'all';
let dismissedStageId = null; // Ideiglenesen elnémított riasztási ablak etap ID-ja
let dismissedBannerStageId = null; // Ideiglenesen bezárt figyelmeztető sáv etap ID-ja
let trackedTeamQuery = localStorage.getItem('tracked_team_query') || "25"; // Követési keresés (név vagy rajtszám) — frissítés után is megjegyezve
let trackedTeamNo = parseInt(localStorage.getItem('tracked_team_no'), 10) || 25; // Adatbázis azonosító (Chronomoto 'no' paraméter)
let activeRunId = null; // Chronomoto futam ID (aktív jelző)
let activeRunNo = null; // Chronomoto 'run' paraméter — a köridő-lekérdezéshez kell
let activeTab = 'schedule'; // schedule vagy team
let activeStatsSubTab = 'race'; // race (Versenyfutam) vagy qualy (Időmérő)
let teamMap = { "25": "MakeShiftBrothers" }; // Rajtszám <-> Csapatnév összekapcsolás adatbázis
let expandedDrivers = new Set(); // Lenyitott állapotú pilóták neveinek tárolása (frissítésbiztosíték)
let lastTelemetryError = null; // Legutóbbi lekérdezési hiba leírása

// DOM elemek
const clockTimeEl = document.getElementById('clockTime');
const clockDateEl = document.getElementById('clockDate');
const statusDotEl = document.getElementById('statusDot');
const liveIndicatorTextEl = document.getElementById('liveIndicatorText');

// Figyelmeztető banner és ablak elemei
const warningBannerEl = document.getElementById('warningBanner');
const warningMessageBannerEl = document.getElementById('warningMessageBanner');
const warningCloseBtnEl = document.getElementById('warningCloseBtn');
const warningModalEl = document.getElementById('warningModal');
const warningMessageModalEl = document.getElementById('warningMessageModal');
const warningOkBtnEl = document.getElementById('warningOkBtn');

// Tankolás figyelmeztető elemei
const refuelBannerEl = document.getElementById('refuelBanner');
const refuelMessageBannerEl = document.getElementById('refuelMessageBanner');
const refuelCloseBtnEl = document.getElementById('refuelCloseBtn');
const refuelModalEl = document.getElementById('refuelModal');
const refuelMessageModalEl = document.getElementById('refuelMessageModal');
const refuelOkBtnEl = document.getElementById('refuelOkBtn');
let dismissedRefuelStageId = null;
let dismissedRefuelBannerStageId = null;

const activeDriverNameEl = document.getElementById('activeDriverName');
const activeDriverStageEl = document.getElementById('activeDriverStage');
const timeRemainingEl = document.getElementById('timeRemaining');
const totalRaceRemainingEl = document.getElementById('totalRaceRemaining');
const progressBarFillEl = document.getElementById('progressBarFill');
const activeStageStartEl = document.getElementById('activeStageStart');
const activeStageEndEl = document.getElementById('activeStageEnd');

const currentSectionValueEl = document.getElementById('currentSectionValue');
const conditionDescTextEl = document.getElementById('conditionDescText');

const scheduleTableBodyEl = document.getElementById('scheduleTableBody');
const scheduleCountEl = document.getElementById('scheduleCount');

// Visszaszámláló elemei
const countdownHeroEl = document.getElementById('countdownHero');
const heroGridEl = document.getElementById('heroGrid');
const countdownEventTagEl = document.getElementById('countdownEventTag');
const countdownEventTitleEl = document.getElementById('countdownEventTitle');
const countDaysEl = document.getElementById('countDays');
const countHoursEl = document.getElementById('countHours');
const countMinutesEl = document.getElementById('countMinutes');
const countSecondsEl = document.getElementById('countSeconds');
const countdownTargetDescEl = document.getElementById('countdownTargetDesc');

// Chronomoto beágyazás és telemetria elemei
const toggleIframeBtnEl = document.getElementById('toggleIframeBtn');
const iframeWrapperEl = document.getElementById('iframeWrapper');
const telemetryPulseDotEl = document.getElementById('telemetryPulseDot');
const telemetryTableWrapperEl = document.getElementById('telemetryTableWrapper');

const driverFilterEl = document.getElementById('driverFilter');
const simToggleEl = document.getElementById('simToggle');
const sliderGroupEl = document.getElementById('sliderGroup');
const timeSimSliderEl = document.getElementById('timeSimSlider');
const simTimeDisplayEl = document.getElementById('simTimeDisplay');

const statsContainerEl = document.getElementById('statsContainer');

// Tabok elemei
const tabScheduleBtnEl = document.getElementById('tabScheduleBtn');
const tabLapRankBtnEl = document.getElementById('tabLapRankBtn');
const tabTeamBtnEl = document.getElementById('tabTeamBtn');
const tabChartsBtnEl = document.getElementById('tabChartsBtn');
const tabPlannerBtnEl = document.getElementById('tabPlannerBtn');
const tabScheduleContentEl = document.getElementById('tabScheduleContent');
const tabLapRankContentEl = document.getElementById('tabLapRankContent');
const tabTeamContentEl = document.getElementById('tabTeamContent');
const tabChartsContentEl = document.getElementById('tabChartsContent');
const tabPlannerContentEl = document.getElementById('tabPlannerContent');
const lapRankTableBodyEl = document.getElementById('lapRankTableBody');
const currentLapRankValueEl = document.getElementById('currentLapRankValue');

// Telemetria követési beállítások
const teamNumberInputEl = document.getElementById('teamNumberInput');
const teamNameInputEl = document.getElementById('teamNameInput');
const updateTeamQueryBtnEl = document.getElementById('updateTeamQueryBtn');
const telemetryTeamBadgeEl = document.getElementById('telemetryTeamBadge');
const driverTelemetryGridEl = document.getElementById('driverTelemetryGrid');
const downloadDbBtnEl = document.getElementById('downloadDbBtn');
const subTabQualyEl = document.getElementById('subTabQualy');
const subTabRaceEl = document.getElementById('subTabRace');

// Csere elemek
const swapNextBtn = document.getElementById('swapNextBtn');
const earlySwapBtn = document.getElementById('earlySwapBtn');
const cancelSwapBtn = document.getElementById('cancelSwapBtn');
const swapModal = document.getElementById('swapModal');
const earlySwapSelect = document.getElementById('earlySwapSelect');
const swapYesBtn = document.getElementById('swapYesBtn');
const swapNoBtn = document.getElementById('swapNoBtn');

// ============================================================================
//  CSERE (SWAP) MOTOR — tényleges cseréidők + dinamikus újratervezés
// ----------------------------------------------------------------------------
//  A verseny fix 15:00–23:00. Minden pilótának van egy tervezett összideje
//  (a SCHEDULE-ból). A "Csere most" gomb a VALÓS pillanatban rögzíti a cserét
//  (akár korábban, akár később a tervnél), és onnantól minden a tényleges
//  cseréidőkből számol. A kijövő pilóta hiánya/többlete egyenletesen szétoszlik
//  az ő hátralévő etapjai között, hogy 23:00-ra mindenki a tervezett idejét
//  vezesse le, a verseny pedig továbbra is 23:00-kor érjen véget.
// ============================================================================

const MIN_STINT_MIN = 3; // legrövidebb tervezhető etap (perc)
// A RACE_START_MIN / RACE_END_MIN / DRIVER_PLANNED_TOTAL / SCHEDULE értékeket a
// terv-szekció rebuildPlanDerived() függvénye tölti fel (a Tervező fül alapján).

// Cserék naplója: [{ time(perc), driver? }] — sorrendben a lezárt etap-határok.
// A k-adik bejegyzés a k. etap végét jelöli; a driver (ha van) a SORON KÍVÜLI
// cseréből származó felülírás a beugró (k+1.) etapra. Sima cserénél nincs driver.
const SWAP_STORAGE_KEY = 'swapLog_v3';
let swapLog = loadSwapLog();

function loadSwapLog() {
    try {
        const raw = localStorage.getItem(SWAP_STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                return arr
                    .filter(x => x && typeof x.time === 'number')
                    .sort((a, b) => a.time - b.time);
            }
        }
    } catch (e) {
        console.error('Csere-napló betöltési hiba:', e);
    }
    return [];
}

function saveSwapLog() {
    try {
        localStorage.setItem(SWAP_STORAGE_KEY, JSON.stringify(swapLog));
    } catch (e) {
        console.error('Csere-napló mentési hiba:', e);
    }
    if (typeof syncPushSwaps === 'function') syncPushSwaps(); // felhő-szinkron
}

// Idővonal gyorsítótár (a swapLog változásakor érvénytelenítjük)
let cachedTimeline = null;
function invalidateTimeline() { cachedTimeline = null; }
function getTimeline() {
    if (!cachedTimeline) cachedTimeline = buildTimeline();
    return cachedTimeline;
}

// A terv-alapú levezetett értékek első feltöltése (SCHEDULE, RACE_*_MIN, időpontok)
rebuildPlanDerived();

// A beugró pilóta + a maradék tervezett etapok hosszainak újraszámolása úgy,
// hogy [fromMin, 23:00] pontosan kitöltődjön, és minden érintett pilótánál a
// hiány/többlet egyenletesen szétoszoljon a hátralévő etapjai között.
function replanRemaining(incoming, incomingPlannedDur, futureQueue, driven, fromMin) {
    const slots = [{ driver: incoming, plannedDur: incomingPlannedDur }];
    futureQueue.forEach(q => slots.push({ driver: q.driver, plannedDur: q.plannedDur }));

    // slot-darabszám és tervezett maradék pilótánként
    const slotCount = {};
    const plannedRemaining = {};
    slots.forEach(s => {
        slotCount[s.driver] = (slotCount[s.driver] || 0) + 1;
        plannedRemaining[s.driver] = (plannedRemaining[s.driver] || 0) + s.plannedDur;
    });

    // owed = tervezett összidő - eddig levezetett; deficit = owed - tervezett maradék.
    // A deficitet szétosztjuk a pilóta hátralévő etapjai között (fejenként egyenlő plusz).
    const deficitPer = {};
    Object.keys(slotCount).forEach(d => {
        const owed = (DRIVER_PLANNED_TOTAL[d] || 0) - (driven[d] || 0);
        const deficit = owed - (plannedRemaining[d] || 0);
        deficitPer[d] = deficit / slotCount[d];
    });

    let durs = slots.map(s => Math.max(MIN_STINT_MIN, s.plannedDur + (deficitPer[s.driver] || 0)));

    // Normalizálás: a maradék etapok pontosan töltsék ki a [fromMin, 23:00] ablakot
    const targetTotal = RACE_END_MIN - fromMin;
    const sum = durs.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - targetTotal) > 0.0001) {
        const scale = targetTotal / sum;
        durs = durs.map(d => d * scale);
    }
    // Egész percre kerekítés, a maradékot az utolsó etapra tesszük
    durs = durs.map(d => Math.round(d));
    const roundedSum = durs.reduce((a, b) => a + b, 0);
    durs[durs.length - 1] += (targetTotal - roundedSum);

    const newQueue = futureQueue.map((q, i) => ({ driver: q.driver, plannedDur: durs[i + 1] }));
    return { curDur: durs[0], queue: newQueue };
}

// Teljes idővonal felépítése — KÉZI NAPLÓ modell:
//  - a múlt/jelen a TÉNYLEGES cserékből (a pilóta NEM lép magától tovább a
//    tervezett időpontban; a csere csak a "Csere most" gombbal rögzül);
//  - a jövő a hátralévő tervezett rotáció, újraszámolt hosszakkal, hogy 23:00-ra
//    mindenki a tervezett idejét vezesse le.
// Visszatér: [{ id, driver, startMin, endMin, projectedEndMin?, manualStart, current? }]
function buildTimeline() {
    const N = SCHEDULE.length;
    const rotation = SCHEDULE.map(s => s.driver);           // FIX sorrend a tervből
    const plannedDur = SCHEDULE.map(s => stintDurationMin(s));
    const swaps = swapLog.slice();                           // [{time, driver?}] — lezárt határok
    const ci = Math.min(swaps.length, N);                   // jelenlegi (held) etap-index

    const nowMin = Math.min(RACE_END_MIN, Math.max(RACE_START_MIN, getCurrentTimeMinutes()));
    const driven = {};
    DRIVERS.forEach(d => { driven[d] = 0; });

    // Egy etap vezetője: alapból a rotációból. Ha az előző (k-1.) csere SORON KÍVÜLI
    // volt (van driver), az felülírja a beugró (k.) etap vezetőjét. A sorrend így
    // sima cserénél SOSEM változik — csak az idők tolódnak.
    const overrideAt = (k) => (k >= 1 && swaps[k - 1] && swaps[k - 1].driver) ? swaps[k - 1].driver : null;
    const driverAt = (k) => overrideAt(k) || rotation[k] || rotation[k % N];
    const isManualStart = (k) => !!overrideAt(k);           // "kézi" jelölés csak a soron kívüli cseréknél

    const segments = [];

    // 1. Lezárt (múltbeli) etapok 0..ci-1 — a TÉNYLEGES határidőkkel
    let prevEnd = RACE_START_MIN;
    for (let k = 0; k < ci; k++) {
        const start = prevEnd;
        const end = swaps[k].time;
        if (end > start) {
            segments.push({ stintIndex: k, driver: driverAt(k), startMin: start, endMin: end, manualStart: isManualStart(k) });
            driven[driverAt(k)] += end - start;
        }
        prevEnd = Math.max(prevEnd, end);
    }

    // Ha minden etap lezárult → vége
    if (ci >= N) {
        if (segments.length) segments[segments.length - 1].endMin = RACE_END_MIN;
        const ec = {};
        segments.forEach((s, i) => { s.id = i; ec[s.driver] = (ec[s.driver] || 0) + 1; s.etap = ec[s.driver]; });
        return segments;
    }

    // 2. Jelenlegi etap (ci) + jövő projekció — a sorrend fix, csak az idők változnak
    const curDriver = driverAt(ci);
    const curStart = prevEnd;
    const futureQueue = [];
    for (let k = ci + 1; k < N; k++) futureQueue.push({ driver: driverAt(k), plannedDur: plannedDur[k] });

    const replan = replanRemaining(curDriver, plannedDur[ci], futureQueue, driven, curStart);

    const projectedEndMin = Math.min(RACE_END_MIN, curStart + replan.curDur);
    // ÉLESBEN a jelenlegi etap a mostani időpontig nyúlik, ha túlfutott (nem vált magától).
    // SZIMULÁCIÓBAN a terv szerint (idő alapján) lépked.
    const curEndMin = isSimulating ? projectedEndMin : Math.max(projectedEndMin, nowMin);
    segments.push({ stintIndex: ci, driver: curDriver, startMin: curStart, endMin: curEndMin, projectedEndMin, manualStart: isManualStart(ci), current: true });

    let cursor = projectedEndMin;
    replan.queue.forEach((q, idx) => {
        const k = ci + 1 + idx;
        const segStart = cursor;
        const segEnd = Math.min(RACE_END_MIN, cursor + q.plannedDur);
        if (segEnd > segStart) {
            segments.push({ stintIndex: k, driver: q.driver, startMin: segStart, endMin: segEnd, manualStart: isManualStart(k) });
        }
        cursor = segEnd;
    });
    if (segments.length) segments[segments.length - 1].endMin = RACE_END_MIN;

    // Etap = a pilóta hányadik köre: minden pilóta N-edik előfordulása → Etap N
    // (Lackó/Boldi/Zsemle/Beni 1. köre = Etap 1, a következő körük = Etap 2, stb.)
    const etapCount = {};
    segments.forEach((s, i) => {
        s.id = i;
        etapCount[s.driver] = (etapCount[s.driver] || 0) + 1;
        s.etap = etapCount[s.driver];
    });
    return segments;
}

// Az aktív szakasz (aki most a pályán van).
//  - ÉLESBEN: a jelenlegi etap a rajtjától aktív (nem lép magától tovább — a cserét
//    a gomb rögzíti). SZIMULÁCIÓBAN: idő szerint, a terv szerint lépkedve.
function getActiveSegment(nowMin) {
    if (nowMin >= RACE_END_MIN) return null;
    const tl = getTimeline();
    if (isSimulating) {
        return tl.find(seg => nowMin >= seg.startMin && nowMin < seg.endMin) || null;
    }
    const cur = tl.find(seg => seg.current);
    if (cur && nowMin >= cur.startMin) return cur;
    return tl.find(seg => nowMin >= seg.startMin && nowMin < seg.endMin) || null;
}

// A következő etap (a rotációban a jelenlegi UTÁN következő) — a soron következő pilóta
function getNextSegment(nowMin) {
    const tl = getTimeline();
    const active = getActiveSegment(nowMin);
    if (active) return tl.find(seg => seg.stintIndex === active.stintIndex + 1) || null;
    return tl.find(seg => seg.startMin > nowMin) || null;
}

// Csere végrehajtása: a jelenleg (kijelzett) aktív etap MOST lezárul, és a következő
// etap veszi át. overrideDriver=null → sima csere (a rotáció következő pilótája, a
// sorrend változatlan). overrideDriver megadva → soron kívüli csere (az a pilóta jön).
// Szimulációban az addig automatikusan lezárult etapok határait is rögzíti (utolérés).
function performSwap(overrideDriver) {
    const now = Math.round(getCurrentTimeMinutes());
    if (now <= RACE_START_MIN || now >= RACE_END_MIN) {
        showCustomAlert('CSERE', `Cserét csak a verseny ideje alatt (${plan.raceStart}–${fmtClock(RACE_END_MIN, true)}) lehet rögzíteni.`, '--color-gold', 'fa-solid fa-triangle-exclamation');
        return false;
    }
    const tl = getTimeline();
    const active = getActiveSegment(now);
    if (!active) {
        showCustomAlert('CSERE', 'Nincs aktív etap a cseréhez.', '--color-gold', 'fa-solid fa-circle-info');
        return false;
    }
    const d = active.stintIndex;            // a kijelzett aktív etap indexe
    const ci = swapLog.length;              // eddig lezárt határok száma
    if (d >= SCHEDULE.length - 1) {
        showCustomAlert('CSERE', 'Ez az utolsó etap — nincs következő pilóta.', '--color-gold', 'fa-solid fa-circle-info');
        return false;
    }

    // Az addig (idő szerint) automatikusan lezárult etapok (ci..d-1) határainak rögzítése,
    // majd a jelenlegi (d.) etap lezárása MOST. Így a sorrend megmarad, csak az idők tolódnak.
    const newSwaps = swapLog.slice(0, ci);
    let prevT = ci > 0 ? swapLog[ci - 1].time : RACE_START_MIN;
    for (let k = ci; k < d; k++) {
        const seg = tl.find(s => s.stintIndex === k);
        let t = seg ? Math.round(seg.projectedEndMin != null ? seg.projectedEndMin : seg.endMin) : now;
        t = Math.max(prevT + 1, Math.min(t, now - 1));
        newSwaps.push({ time: t });
        prevT = t;
    }
    const ev = { time: Math.max(prevT + 1, now) };
    if (overrideDriver) ev.driver = overrideDriver;
    newSwaps.push(ev);

    swapLog = newSwaps;
    saveSwapLog();
    invalidateTimeline();
    return true;
}

// A legutóbbi csere visszavonása
function undoLastSwap() {
    if (!swapLog.length) return;
    swapLog.pop();
    saveSwapLog();
    invalidateTimeline();
}

// A csere-gombok állapotának frissítése (a visszavonás csak akkor látszik, ha van mit)
function refreshSwapButtons() {
    if (earlySwapBtn) earlySwapBtn.classList.remove('hidden');
    if (cancelSwapBtn) {
        if (swapLog.length > 0) cancelSwapBtn.classList.remove('hidden');
        else cancelSwapBtn.classList.add('hidden');
    }
}

window.addEventListener('DOMContentLoaded', refreshSwapButtons);

// --- SEGÉDFUNKCIÓK ---

// Idő string (HH:MM) átalakítása percekre éjféltől számítva
function timeStringToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

// Percek átalakítása HH:MM formátumra (napon belüli érték)
function minutesToTimeString(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// --- ABSZOLÚT IDŐ (24 ÓRÁS VERSENY TÁMOGATÁS) ---
// Minden belső idő "abszolút perc" a verseny napjának (plan.date) éjfelétől számítva,
// így éjfél után is folytonos (pl. 02:00 másnap = 1440 + 120 = 1560).

function raceDayMidnight() {
    return new Date(TARGET_YEAR, TARGET_MONTH, TARGET_DAY, 0, 0, 0);
}
function dateToAbsMin(dateObj) {
    return Math.round((dateObj.getTime() - raceDayMidnight().getTime()) / 60000);
}
function absMinToDate(absMin) {
    return new Date(raceDayMidnight().getTime() + absMin * 60000);
}

// Abszolút perc -> "HH:MM" (napon belüli idő). A "+n" nap-jelzőt már nem használjuk
// (a sorrend a táblázatban úgyis egyértelmű), a második paraméter figyelmen kívül marad.
function fmtClock(absMin, withDayTag) {
    const norm = ((Math.round(absMin) % 1440) + 1440) % 1440;
    return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
}

// Aktuális dátum objektum lekérése (valós vagy szimulált)
function getCurrentDate() {
    if (isSimulating) return absMinToDate(simTimeMinutes);
    return new Date();
}

// Aktuális idő abszolút percben (valós vagy szimulált)
function getCurrentTimeMinutes() {
    if (isSimulating) return simTimeMinutes;
    return dateToAbsMin(new Date());
}

// --- LEKÉRDEZÉS HATÁRIDŐVEL (TIMEOUT) ---
async function fetchWithTimeout(url, options = {}, timeout = 6000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// --- ADATLEKÉRDEZÉS A SAJÁT CLOUDFLARE WORKER PROXYN KERESZTÜL ---
// A Chronomoto nem küld CORS-fejlécet, ezért böngészőből csak proxyn át érhető el.
// KIZÁRÓLAG a saját Cloudflare Workert használjuk (nincs nyilvános proxy): nincs
// rate-limit, gyors és megbízható. A localStorage 'telemetry_proxy' egy egyedi
// címet tehet a lista ELEJÉRE (pl. ha új Workert hozol létre).
const TELEMETRY_WORKERS = [
    'https://msb-proxy.szaszegri.workers.dev/?url=',    // elsődleges (és egyetlen)
];

function telemetryProxyList() {
    const override = (typeof localStorage !== 'undefined' && localStorage.getItem('telemetry_proxy')) || '';
    return override ? [override, ...TELEMETRY_WORKERS] : TELEMETRY_WORKERS.slice();
}

async function fetchWithProxy(targetUrl) {
    let lastErr = null;
    for (const base of telemetryProxyList()) {
        try {
            const response = await fetchWithTimeout(base + encodeURIComponent(targetUrl), {}, 9000);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const t = await response.text();
            if (!t || t.length <= 30) throw new Error('üres/rövid válasz');
            return t;
        } catch (e) {
            lastErr = e;
            console.warn('Worker sikertelen (' + base + '):', e.message);
        }
    }
    throw new Error('Minden Worker sikertelen. Utolsó hiba: ' + (lastErr ? lastErr.message : 'ismeretlen'));
}

// --- CHRONOMOTO LIVE TELEMETRIA LEKÉRDEZÉS ÉS MEGJELENÍTÉS ---

async function fetchLiveTimingData() {
    try {
        const targetUrl = 'https://live.chronomoto.com/bssw/livedata.php?t=' + Date.now();
        telemetryPulseDotEl.classList.add('fetching');
        
        const htmlText = await fetchWithProxy(targetUrl);
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        
        const rows = doc.querySelectorAll('table tr');
        const standings = [];
        const newTeamMap = {};
        
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            // Ellenőrizzük, hogy ez egy valós csapat adatsor-e
            if (cells.length >= 5) {
                const rawNum = cells[1].textContent.trim();
                // Ha a rajtszám oszlop nem szám, akkor ez nem adatsor (pl. fejléc)
                if (rawNum && !isNaN(parseInt(rawNum))) {
                    const pos = cells[0].textContent.trim().replace('.', '');
                    const num = rawNum;
                    const name = cells[2].textContent.trim().replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
                    const laps = cells[3] ? cells[3].textContent.trim() : '';
                    const bestLap = cells[4] ? cells[4].textContent.trim() : '';
                    const lastLap = cells[8] ? cells[8].textContent.trim() : '';
                    const diffPrev = cells[7] ? cells[7].textContent.trim().replace(/\u00a0/g, ' ').trim() : '';
                    
                    standings.push({ pos, num, name, laps, bestLap, lastLap, diffPrev });
                    newTeamMap[num] = name;

                    // A futam 'run' azonosítója a sor onclick-jéből (a köridőkhöz kell)
                    const rowOnclickRun = (row.getAttribute('onclick') || '').match(/run=(\d+)/);
                    if (rowOnclickRun) activeRunNo = rowOnclickRun[1];

                    // Ellenőrizzük az egyezést név (részleges) VAGY rajtszám (pontos) alapján
                    const queryStr = trackedTeamQuery.trim().toLowerCase();
                    const isNumMatch = num.toLowerCase() === queryStr;
                    const isNameMatch = queryStr.length > 0 && name.toLowerCase().includes(queryStr);

                    if (isNumMatch || isNameMatch) {
                        // A Chronomoto 'no' azonosító a SOR onclick attribútumában van
                        // (pl. onClick=window.location.href='laps.php?run=...&no=8')
                        const onclickAttr = row.getAttribute('onclick') || '';
                        const noMatch = onclickAttr.match(/no=(\d+)/);
                        trackedTeamNo = noMatch ? parseInt(noMatch[1]) : parseInt(num);
                        activeRunId = "active";
                    }
                }
            }
        });
        
        if (Object.keys(newTeamMap).length > 0) {
            teamMap = newTeamMap;
        }
        
        // Kinyerjük a "Time to go" értéket a HTML-ből, hogy szinkronizáljuk az órát a szervezőkkel
        const timeToGoMatch = htmlText.match(/Time to go:<\/b>(?:&nbsp;|\s)*([0-9:]+)/i);
        if (timeToGoMatch && timeToGoMatch[1]) {
            const timeParts = timeToGoMatch[1].split(':');
            let hrs = 0, mins = 0, secs = 0;
            if (timeParts.length === 3) {
                hrs = parseInt(timeParts[0]) || 0;
                mins = parseInt(timeParts[1]) || 0;
                secs = parseInt(timeParts[2]) || 0;
            } else if (timeParts.length === 2) {
                mins = parseInt(timeParts[0]) || 0;
                secs = parseInt(timeParts[1]) || 0;
            }
            const remainingMs = (hrs * 3600 + mins * 60 + secs) * 1000;
            
            // Ha van hátralévő idő, frissítjük a RACE_END_TIME-ot
            if (remainingMs > 0) {
                RACE_END_TIME = new Date(Date.now() + remainingMs);
            }
        }
        
        // Szinkronizáljuk a verseny valódi kezdetét is a "Time elapsed" alapján!
        const timeElapsedMatch = htmlText.match(/Time elapsed:<\/b>(?:&nbsp;|\s)*([0-9:]+)/i);
        if (timeElapsedMatch && timeElapsedMatch[1]) {
            const timeParts = timeElapsedMatch[1].split(':');
            let hrs = 0, mins = 0, secs = 0;
            if (timeParts.length === 3) {
                hrs = parseInt(timeParts[0]) || 0;
                mins = parseInt(timeParts[1]) || 0;
                secs = parseInt(timeParts[2]) || 0;
            } else if (timeParts.length === 2) {
                mins = parseInt(timeParts[0]) || 0;
                secs = parseInt(timeParts[1]) || 0;
            }
            const elapsedMs = (hrs * 3600 + mins * 60 + secs) * 1000;
            
            if (elapsedMs > 0) {
                RACE_ACTUAL_START_TIME = new Date(Date.now() - elapsedMs);
            }
        }
        
        lastTelemetryError = null;
        return standings;
    } catch (error) {
        console.error('Sikertelen Chronomoto telemetria adatlekérés:', error);
        lastTelemetryError = error.message || error;
        return null;
    } finally {
        // Leállítjuk a frissítés animációt kis késleltetés után
        setTimeout(() => {
            telemetryPulseDotEl.classList.remove('fetching');
        }, 800);
    }
}

async function updateTelemetryUI() {
    invalidateTimeline(); // friss idővonal a köridő→pilóta hozzárendeléshez
    try {
        let standings = null;
        if (isSimulating) {
            // Szimulációs módban generálunk teszt állást a felső kártyához és a mini táblázathoz
            const mockLaps = generateMockTelemetryLaps(simTimeMinutes);
            const bestTime = mockLaps.length > 0 ? mockLaps.reduce((best, l) => lapTimeToSeconds(l.lapTime) < lapTimeToSeconds(best.lapTime) ? l : best).lapTime : '1:02.843';
            const lastMock = mockLaps.length > 0 ? mockLaps[mockLaps.length - 1].lapTime : bestTime;
            standings = [
                { pos: '8', num: String(trackedTeamNo), name: teamMap[trackedTeamNo] || 'MakeShiftBrothers', laps: String(mockLaps.length), bestLap: bestTime, lastLap: lastMock, diffPrev: '' }
            ];
        } else {
            standings = await fetchLiveTimingData();
        }
        
        let displayTeamName = trackedTeamQuery;
        let teamFound = false;

        if (standings && standings.length > 0) {
            // Frissítjük a felső csapat állás kártyát
            const queryStr = trackedTeamQuery.trim().toLowerCase();
            const teamItem = standings.find(item => item.num.toLowerCase() === queryStr || item.name.toLowerCase().includes(queryStr));
            
            if (teamItem) {
                teamFound = true;
                
                let cardBestLap = teamItem.bestLap || '';
                if (cardBestLap.toLowerCase().includes('pit')) {
                    cardBestLap = `<span style="color: #ff4757; font-weight: 700; text-transform: uppercase;">in pit</span>`;
                } else {
                    cardBestLap = `<span style="color: var(--color-cyan); font-weight: 700;">${cardBestLap}</span>`;
                }

                currentSectionValueEl.innerHTML = `<i class="fa-solid fa-trophy" style="color: var(--color-gold); margin-right: 8px;"></i><span>${teamItem.pos}. Hely</span>`;
                conditionDescTextEl.innerHTML = `Kör: <strong style="color:var(--text-primary); font-family:var(--font-sans);">${teamItem.laps}</strong> | Legjobb: ${cardBestLap}`;
                
                // Zöld szegély ha megvan a csapatunk helyezése
                currentSectionValueEl.parentElement.style.borderColor = '#2ecc71';
                
                // Pozíció mentése a grafikonhoz
                savePositionHistory(teamItem.pos);
            }
            
            let tableHTML = `
                <table class="telemetry-mini-table">
                    <thead>
                        <tr>
                            <th class="telemetry-pos-col">#</th>
                            <th class="telemetry-num-col">Rsz</th>
                            <th style="min-width: 120px;">Csapat</th>
                            <th class="telemetry-laps-col">Kör</th>
                            <th style="text-align: right;">Előző</th>
                            <th style="text-align: right;">Diff</th>
                            <th style="text-align: right;">Legjobb</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            standings.forEach(item => {
                const queryStr = trackedTeamQuery.trim().toLowerCase();
                const isTracked = item.num.toLowerCase() === queryStr || item.name.toLowerCase().includes(queryStr);
                const rowClass = isTracked ? 'class="tracked-team-row"' : '';
                
                if (isTracked) {
                    displayTeamName = `${item.name} (#${item.num})`;
                    if (document.activeElement !== teamNumberInputEl) {
                        teamNumberInputEl.value = item.num;
                    }
                    if (document.activeElement !== teamNameInputEl) {
                        teamNameInputEl.value = item.name;
                    }
                    trackedTeamNo = parseInt(item.num);
                }

                let displayBestLap = item.bestLap || '--:--.---';
                if (displayBestLap.toLowerCase().includes('pit')) {
                    displayBestLap = `<span style="color: #ff4757; font-weight: 700; text-transform: uppercase;"><i class="fa-solid fa-square-p" style="margin-right: 4px;"></i>in pit</span>`;
                }

                let displayLastLap = item.lastLap || '--:--.---';
                if (displayLastLap.toLowerCase().includes('pit')) {
                    displayLastLap = `<span style="color: #ff4757; font-weight: 700; text-transform: uppercase;">in pit</span>`;
                }

                const diffPrev = item.diffPrev || '';

                tableHTML += `
                    <tr ${rowClass}>
                        <td class="telemetry-pos-col">${item.pos}</td>
                        <td class="telemetry-num-col">${item.num}</td>
                        <td class="telemetry-name-col" title="${item.name}" style="min-width: 120px;">${item.name}</td>
                        <td class="telemetry-laps-col">${item.laps}</td>
                        <td style="text-align: right; font-size: 0.75rem;">${displayLastLap}</td>
                        <td style="text-align: right; font-size: 0.75rem; color: var(--text-muted);">${diffPrev}</td>
                        <td class="telemetry-best-col">${displayBestLap}</td>
                    </tr>
                `;
            });
            
            tableHTML += `
                    </tbody>
                </table>
            `;
            
            telemetryTableWrapperEl.innerHTML = tableHTML;
            
            // --- KÖRHELYEZÉS (PACE) SZÁMÍTÁSA ---
            let lapRankings = [];
            standings.forEach(item => {
                const ll = (item.lastLap || '').toLowerCase();
                if (ll && !ll.includes('pit') && ll !== '--:--.---') {
                    const sec = lapTimeToSeconds(item.lastLap);
                    if (sec && !isNaN(sec)) {
                        lapRankings.push({ ...item, sec });
                    }
                }
            });
            
            // Sorbarendezés a legjobb utolsó kör szerint
            lapRankings.sort((a, b) => a.sec - b.sec);
            
            let rankTableHTML = '';
            let teamLapRankFound = false;
            
            if (lapRankings.length > 0) {
                const fastestSec = lapRankings[0].sec;
                lapRankings.forEach((item, index) => {
                    const rank = index + 1;
                    const diffSec = item.sec - fastestSec;
                    const diffStr = diffSec === 0 ? '' : `+${diffSec.toFixed(3)}`;
                    
                    const isTracked = parseInt(item.num) === trackedTeamNo;
                    if (isTracked) {
                        teamLapRankFound = true;
                        if (currentLapRankValueEl) {
                            currentLapRankValueEl.textContent = `${rank}.`;
                        }
                    }
                    
                    const rowClass = isTracked ? 'class="tracked-team-row"' : '';
                    
                    rankTableHTML += `
                        <tr ${rowClass}>
                            <td class="telemetry-pos-col">${rank}.</td>
                            <td class="telemetry-num-col">${item.num}</td>
                            <td class="telemetry-name-col" title="${item.name}" style="min-width: 120px;">${item.name}</td>
                            <td style="text-align: right; font-family: var(--font-mono); font-size: 0.85rem; color: var(--color-cyan);">${item.lastLap}</td>
                            <td style="text-align: right; font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted);">${diffStr}</td>
                        </tr>
                    `;
                });
            } else {
                rankTableHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">Nincs elérhető köridő.</td></tr>`;
            }
            
            if (lapRankTableBodyEl) {
                lapRankTableBodyEl.innerHTML = rankTableHTML;
            }
            
            if (!teamLapRankFound && currentLapRankValueEl) {
                currentLapRankValueEl.innerHTML = `<i class="fa-solid fa-square-p" style="font-size: 1rem;"></i>`;
            }

        } else {
            // Ha nincs adat (például zárva van a pálya, nincs futam, vagy hiba történt)
            let errorDetails = "";
            if (lastTelemetryError) {
                errorDetails = `<br><span style="font-size: 0.72rem; color: var(--color-gold); font-family: var(--font-mono); display: block; margin-top: 6px;">Kapcsolódási hiba: ${lastTelemetryError}</span>`;
            }
            telemetryTableWrapperEl.innerHTML = `
                <div class="telemetry-no-run">
                    <i class="fa-solid fa-triangle-exclamation" style="color: var(--color-gold); margin-bottom: 6px; font-size: 1.1rem;"></i><br>
                    Jelenleg nincs aktív futam a Visonta pályán, vagy az élő telemetria átmenetileg szünetel.
                    ${errorDetails}
                </div>
            `;
            if (lapRankTableBodyEl) {
                lapRankTableBodyEl.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">Nincs élő adat.</td></tr>`;
            }
            if (currentLapRankValueEl) {
                currentLapRankValueEl.textContent = '--.';
            }
        }

        // Ha a keresett csapatunk nem található az állásban vagy hálózati hiba van
        if (!teamFound) {
            currentSectionValueEl.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" style="color: var(--color-cyan); margin-right: 8px;"></i><span>Keresés...</span>`;
            conditionDescTextEl.textContent = `Várakozás a #${trackedTeamNo} csapat adataira...`;
            currentSectionValueEl.parentElement.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            if (currentLapRankValueEl) {
                currentLapRankValueEl.textContent = '--.';
            }
        }

        const teamStandingTagEl = document.getElementById('teamStandingTag');
        if (teamStandingTagEl) {
            teamStandingTagEl.textContent = isSimulating ? "SZIMULÁLT ÁLLÁS" : "CSAPATUNK ÁLLÁSA";
        }

        // Csapat jelvény frissítése a pilóta statisztikáknál
        telemetryTeamBadgeEl.textContent = `Csapat: ${displayTeamName}`;

        // Egyéni pilóta telemetria frissítése (szimulált vagy valós adatok)
        if (isSimulating) {
            const mockLaps = generateMockTelemetryLaps(simTimeMinutes);
            renderDriverTelemetryCards(mockLaps);
        } else {
            if (trackedTeamNo) {
                await fetchAndRenderRealTelemetry(activeRunNo, trackedTeamNo);
            } else {
                showTelemetryError("Kérjük, add meg a követni kívánt csapat rajtszámát vagy nevét.");
            }
        }
    } catch (err) {
        console.error("Hiba történt az updateTelemetryUI futtatásakor:", err);
    }
}

// --- HELPER FUNKCIÓK A PILÓTA STATISZTIKÁKHOZ ---

function lapTimeToSeconds(lapTimeStr) {
    if (!lapTimeStr || lapTimeStr === '&nbsp;' || lapTimeStr === '-') return Infinity;
    const cleanStr = lapTimeStr.trim();
    if (cleanStr.includes(':')) {
        const [minutes, rest] = cleanStr.split(':');
        const seconds = parseFloat(rest);
        return parseInt(minutes) * 60 + seconds;
    } else {
        return parseFloat(cleanStr);
    }
}

function secondsToLapTime(totalSeconds) {
    if (totalSeconds === Infinity || isNaN(totalSeconds)) return '-';
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60).toFixed(3);
    if (minutes > 0) {
        return `${minutes}:${String(seconds).padStart(6, '0')}`;
    } else {
        return seconds;
    }
}

// Egy kör abszolút perce (a verseny napjának éjfelétől). Ha van rögzített absMin,
// azt használjuk (pontos, 24h-nál is); egyébként a HH:MM:SS stringből becsüljük.
function lapAbsMin(lap) {
    if (lap && typeof lap.absMin === 'number' && !isNaN(lap.absMin)) return lap.absMin;
    return timeOfDayStrToAbs(lap && lap.timeOfDay);
}

// HH:MM(:SS) string -> abszolút perc, a "most"-hoz legközelebbi napi ismétlést választva
// (ez teszi lehetővé a 24h-t: pl. "02:00" a másnapi 1560-ra képződik, nem a 120-ra).
function timeOfDayStrToAbs(timeOfDayStr) {
    if (!timeOfDayStr) return null;
    const m = timeOfDayStr.match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const t = parseInt(m[1]) * 60 + parseInt(m[2]); // 0..1439 (napon belüli)
    const nowAbs = getCurrentTimeMinutes();
    const maxDay = Math.ceil((RACE_END_MIN + 1440) / 1440);
    let best = t, bestDiff = Infinity;
    for (let day = 0; day <= maxDay; day++) {
        const cand = t + day * 1440;
        const diff = Math.abs(cand - nowAbs);
        if (diff < bestDiff) { bestDiff = diff; best = cand; }
    }
    return best;
}

// Melyik pilóta futott adott abszolút percben (a TÉNYLEGES cseréidőket tükröző idővonalból)
function getDriverForAbsMin(absMin) {
    if (absMin == null || isNaN(absMin)) return null;
    if (absMin < RACE_START_MIN) return 'Lackó'; // verseny előtt: időmérő/teszt (csak Lackó)

    const timeline = getTimeline();
    const seg = timeline.find(s => absMin >= s.startMin && absMin < s.endMin);
    if (seg) return seg.driver;
    if (timeline.length && absMin >= timeline[timeline.length - 1].endMin) {
        return timeline[timeline.length - 1].driver;
    }
    return null;
}

// Visszafelé kompatibilis: string alapú lekérdezés
function getDriverForTime(timeOfDayStr) {
    return getDriverForAbsMin(timeOfDayStrToAbs(timeOfDayStr));
}

// Egyéni pilóta kártyák kirajzolása
function renderDriverTelemetryCards(laps) {
    const drivers = ['Lackó', 'Zsemle', 'Boldi', 'Beni'];
    
    // Kiszűrjük a köröket az aktuálisan kiválasztott fül szerint
    // (Időmérő = verseny kezdete előtt, Versenyfutam = verseny kezdete után — abszolút idő alapján)
    const filteredLaps = [];
    laps.forEach(lap => {
        const abs = lapAbsMin(lap);
        if (abs == null) return;
        const isQualy = abs < RACE_START_MIN;
        if (activeStatsSubTab === 'qualy' && isQualy) filteredLaps.push(lap);
        else if (activeStatsSubTab === 'race' && !isQualy) filteredLaps.push(lap);
    });

    // 1. --- IDŐMÉRŐ / TESZT SPECIÁLIS NÉZET (Nincsenek külön pilóták, egyetlen egyszerű körlista) ---
    if (activeStatsSubTab === 'qualy') {
        // Mentjük a görgetési pozíciót a DOM újragenerálása előtt
        let qualyScrollPos = 0;
        const listEl = driverTelemetryGridEl.querySelector('.driver-telemetry-laps-list');
        if (listEl) {
            qualyScrollPos = listEl.scrollTop;
        }

        const stats = { best: Infinity, totalSec: 0, laps: [] };
        filteredLaps.forEach(lap => {
            const sec = lapTimeToSeconds(lap.lapTime);
            stats.laps.push({ ...lap, sec });
            if (!isNaN(sec) && sec !== Infinity) {
                if (sec < stats.best) {
                    stats.best = sec;
                }
                stats.totalSec += sec;
            }
        });

        const lapCount = stats.laps.length;
        const bestTimeStr = stats.best !== Infinity ? secondsToLapTime(stats.best) : '--:--.---';
        const validLapsCount = stats.laps.filter(l => l.sec !== undefined && l.sec !== null && !isNaN(l.sec) && l.sec !== Infinity).length;
        const avgTimeStr = validLapsCount > 0 ? secondsToLapTime(stats.totalSec / validLapsCount) : '--:--.---';

        let lapsListHTML = '';
        if (lapCount === 0) {
            lapsListHTML = '<div style="font-size:0.8rem; color:var(--text-muted); text-align:center; padding:30px;">Nincs még rögzített kör az időmérőn.</div>';
        } else {
            const bestSec = stats.best;
            const sortedLaps = [...stats.laps].reverse(); // legújabb legfelül

            sortedLaps.forEach(lap => {
                const isBest = lap.sec === bestSec;
                const bestClass = isBest ? 'best' : '';
                const trophyIcon = isBest ? '<i class="fa-solid fa-trophy" style="color: var(--color-gold); font-size: 0.65rem; margin-right: 4px;"></i>' : '';

                // Kiszámítjuk, hogy volt-e kiállás (normál kör ~62s, így 80s felett már időveszteség volt)
                let statusIndicator = '';
                let displayTime = lap.lapTime;
                
                if (lap.sec === Infinity || isNaN(lap.sec) || displayTime.toLowerCase().includes('pit')) {
                    statusIndicator = `<span class="lap-status-badge szereles"><i class="fa-solid fa-stopwatch"></i> KIÁLLÁS</span>`;
                    displayTime = '--:--.---';
                } else if (lap.sec > 80) {
                    statusIndicator = `<span class="lap-status-badge szereles"><i class="fa-solid fa-stopwatch"></i> KIÁLLÁS (${lap.lapTime})</span>`;
                    displayTime = '--:--.---';
                }

                lapsListHTML += `
                    <div class="driver-telemetry-lap-row">
                        <span class="driver-telemetry-lap-num">${lap.lapNum}. kör</span>
                        <span class="driver-telemetry-lap-time ${bestClass}">${trophyIcon}${displayTime}${statusIndicator}</span>
                        <span class="driver-telemetry-lap-tod">${lap.timeOfDay.split('.')[0]}</span>
                    </div>
                `;
            });
        }

        driverTelemetryGridEl.innerHTML = `
            <div class="driver-telemetry-card" style="border-left: 4px solid var(--color-cyan); padding: 16px; position: relative;">
                <div class="driver-telemetry-header" style="border-bottom: 1px solid var(--border-color); padding-bottom: 10px; margin-bottom: 12px;">
                    <div class="driver-telemetry-name">
                        <i class="fa-solid fa-gauge-high" style="color: var(--color-cyan);"></i>
                        <span>Időmérő / Teszt köridők</span>
                    </div>
                    <span class="driver-telemetry-sessions" style="font-family: var(--font-sans); font-weight: 700; color: var(--color-cyan);">${lapCount} kör</span>
                </div>
                
                <div class="driver-telemetry-content" style="max-height: none; opacity: 1; pointer-events: auto;">
                    <div class="driver-telemetry-stats-row">
                        <div class="driver-telemetry-stat-box">
                            <span class="driver-telemetry-stat-label">Összes kör</span>
                            <span class="driver-telemetry-stat-value">${lapCount}</span>
                        </div>
                        <div class="driver-telemetry-stat-box">
                            <span class="driver-telemetry-stat-label">Átlag köridő</span>
                            <span class="driver-telemetry-stat-value avg">${avgTimeStr}</span>
                        </div>
                    </div>
                    
                    <div class="driver-telemetry-stat-box" style="width: 100%; margin-top: 10px;">
                        <span class="driver-telemetry-stat-label"><i class="fa-solid fa-trophy" style="color: var(--color-gold);"></i> Legjobb kör</span>
                        <span class="driver-telemetry-stat-value best">${bestTimeStr}</span>
                    </div>
                    
                    <div class="driver-telemetry-laps-section" style="margin-top: 10px;">
                        <span class="driver-telemetry-laps-header">Köridők listája (legújabb legfelül)</span>
                        <div class="driver-telemetry-laps-list" style="max-height: 420px;">
                            ${lapsListHTML}
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Visszaállítjuk a görgetési pozíciót az újragenerált listára
        const newListEl = driverTelemetryGridEl.querySelector('.driver-telemetry-laps-list');
        if (newListEl) {
            newListEl.scrollTop = qualyScrollPos;
        }
        return;
    }

    // 2. --- VERSENYFUTAM SZOKÁSOS NÉZET (4 külön pilóta lenyitható harmonika kártyával) ---
    const driverStats = {
        'Lackó': { laps: [], best: Infinity, totalSec: 0 },
        'Zsemle': { laps: [], best: Infinity, totalSec: 0 },
        'Boldi': { laps: [], best: Infinity, totalSec: 0 },
        'Beni': { laps: [], best: Infinity, totalSec: 0 }
    };
    
    filteredLaps.forEach(lap => {
        const driver = lap.driver || getDriverForAbsMin(lapAbsMin(lap));
        if (driver && driverStats[driver]) {
            const sec = lapTimeToSeconds(lap.lapTime);
            driverStats[driver].laps.push({ ...lap, sec });
            if (!isNaN(sec) && sec !== Infinity) {
                if (sec < driverStats[driver].best) {
                    driverStats[driver].best = sec;
                }
                driverStats[driver].totalSec += sec;
            }
        }
    });
    
    // Mentjük a jelenlegi görgetési pozíciókat a kártyák újragenerálása előtt
    const scrollPositions = {};
    drivers.forEach(d => {
        const listEl = document.querySelector(`.driver-telemetry-card.color-${d} .driver-telemetry-laps-list`);
        if (listEl) {
            scrollPositions[d] = listEl.scrollTop;
        }
    });
    
    driverTelemetryGridEl.innerHTML = '';
    
    drivers.forEach(driver => {
        const stats = driverStats[driver];
        const lapCount = stats.laps.length;
        const bestTimeStr = stats.best !== Infinity ? secondsToLapTime(stats.best) : '--:--.---';
        const validLapsCount = stats.laps.filter(l => l.sec !== undefined && l.sec !== null && !isNaN(l.sec) && l.sec !== Infinity).length;
        const avgTimeStr = validLapsCount > 0 ? secondsToLapTime(stats.totalSec / validLapsCount) : '--:--.---';
        
        let lapsListHTML = '';
        if (lapCount === 0) {
            lapsListHTML = '<div style="font-size:0.7rem; color:var(--text-muted); text-align:center; padding:15px; grid-column:1/-1;">Nincs még rögzített kör ebben a szakaszban.</div>';
        } else {
            const bestSec = stats.best;
            // Összes rögzített kör fordított időrendben (legújabb legfelül)
            const recentLaps = [...stats.laps].reverse();
            
            recentLaps.forEach(lap => {
                const isBest = lap.sec === bestSec;
                const bestClass = isBest ? 'best' : '';
                const trophyIcon = isBest ? '<i class="fa-solid fa-trophy" style="color: var(--color-gold); font-size: 0.65rem; margin-right: 4px;"></i>' : '';
                
                // Kiszámítjuk, hogy volt-e kiállás (normál kör ~62s, így 80s felett már időveszteség volt)
                let statusIndicator = '';
                let displayTime = lap.lapTime;
                
                if (lap.sec === Infinity || isNaN(lap.sec) || displayTime.toLowerCase().includes('pit')) {
                    statusIndicator = `<span class="lap-status-badge szereles"><i class="fa-solid fa-stopwatch"></i> KIÁLLÁS</span>`;
                    displayTime = '--:--.---';
                } else if (lap.sec > 80) {
                    statusIndicator = `<span class="lap-status-badge szereles"><i class="fa-solid fa-stopwatch"></i> KIÁLLÁS (${lap.lapTime})</span>`;
                    displayTime = '--:--.---';
                }

                lapsListHTML += `
                    <div class="driver-telemetry-lap-row">
                        <span class="driver-telemetry-lap-num">${lap.lapNum}. kör</span>
                        <span class="driver-telemetry-lap-time ${bestClass}">${trophyIcon}${displayTime}${statusIndicator}</span>
                        <span class="driver-telemetry-lap-tod">${lap.timeOfDay.split('.')[0]}</span>
                    </div>
                `;
            });
        }
        
        const isCollapsed = !expandedDrivers.has(driver);
        const card = document.createElement('div');
        card.className = `driver-telemetry-card color-${driver} ${isCollapsed ? 'collapsed' : ''}`;
        
        card.innerHTML = `
            <div class="driver-telemetry-header clickable">
                <div class="driver-telemetry-name">
                    <i class="fa-solid fa-helmet-safety driver-telemetry-icon"></i>
                    <span>${driver}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span class="driver-telemetry-sessions" style="font-family: var(--font-sans); font-weight: 700;">${lapCount} kör</span>
                    <i class="fa-solid fa-chevron-down accordion-arrow"></i>
                </div>
            </div>
            
            <div class="driver-telemetry-content">
                <div class="driver-telemetry-stats-row">
                    <div class="driver-telemetry-stat-box">
                        <span class="driver-telemetry-stat-label">Megtett körök</span>
                        <span class="driver-telemetry-stat-value">${lapCount}</span>
                    </div>
                    <div class="driver-telemetry-stat-box">
                        <span class="driver-telemetry-stat-label">Átlag köridő</span>
                        <span class="driver-telemetry-stat-value avg">${avgTimeStr}</span>
                    </div>
                </div>
                
                <div class="driver-telemetry-stat-box" style="width: 100%; margin-top: 10px;">
                    <span class="driver-telemetry-stat-label"><i class="fa-solid fa-trophy" style="color: var(--color-gold);"></i> Legjobb kör</span>
                    <span class="driver-telemetry-stat-value best">${bestTimeStr}</span>
                </div>
                
                <div class="driver-telemetry-laps-section" style="margin-top: 10px;">
                    <span class="driver-telemetry-laps-header">Összes megtett kör (legújabb legfelül)</span>
                    <div class="driver-telemetry-laps-list">
                        ${lapsListHTML}
                    </div>
                </div>
            </div>
        `;
        
        // Klikk esemény a kártya lenyitásához/becsukásához
        const header = card.querySelector('.driver-telemetry-header');
        header.addEventListener('click', () => {
            const nowCollapsed = card.classList.toggle('collapsed');
            if (nowCollapsed) {
                expandedDrivers.delete(driver);
            } else {
                expandedDrivers.add(driver);
            }
        });
        
        driverTelemetryGridEl.appendChild(card);
    });

    // Visszaállítjuk a görgetési pozíciókat a frissített DOM elemekre
    drivers.forEach(d => {
        if (scrollPositions[d] !== undefined) {
            const listEl = document.querySelector(`.driver-telemetry-card.color-${d} .driver-telemetry-laps-list`);
            if (listEl) {
                listEl.scrollTop = scrollPositions[d];
            }
        }
    });
}

// Szimulált köridők generálása teszteléshez
function generateMockTelemetryLaps(currentSimMinutes) {
    const mockLaps = [];
    const raceStartMinutes = RACE_START_MIN; // verseny kezdete (perc)

    if (currentSimMinutes <= raceStartMinutes) {
        return [];
    }
    
    const minutesElapsed = currentSimMinutes - raceStartMinutes;
    const totalMockLaps = Math.floor(minutesElapsed / 1.15); // Köridő átlagosan 1.15 perc
    
    let lapTimeAccumulator = raceStartMinutes * 60; 
    
    for (let i = 1; i <= totalMockLaps; i++) {
        const currentLapTimeSec = lapTimeAccumulator;
        const absMin = Math.floor(currentLapTimeSec / 60);      // abszolút perc a rajt napjának éjfelétől
        const lapSecs = Math.floor(currentLapTimeSec % 60);
        const timeOfDayStr = `${fmtClock(absMin)}:${String(lapSecs).padStart(2, '0')}`; // HH:MM:SS (napon belül)

        const driverName = getDriverForAbsMin(absMin) || 'Lackó';

        // Determinisztikus ál-véletlen a kör sorszámából (0..1), hogy a mock köridők
        // ne változzanak minden újrarajzoláskor (különben magától villogna/ugrálna).
        const rnd = (Math.sin(i * 12.9898) * 43758.5453) % 1;
        const jitter = rnd < 0 ? rnd + 1 : rnd; // 0..1

        let lapDuration = 70.0;
        if (driverName === 'Lackó') {
            lapDuration = 64.2 + (Math.sin(i * 0.5) * 1.5) + (jitter * 2.0);
        } else if (driverName === 'Zsemle') {
            lapDuration = 66.8 + (Math.cos(i * 0.3) * 1.2) + (jitter * 2.5);
        } else if (driverName === 'Boldi') {
            lapDuration = 65.5 + (Math.sin(i * 0.7) * 1.0) + (jitter * 2.0);
        } else { // Beni
            lapDuration = 68.0 + (Math.cos(i * 0.4) * 2.0) + (jitter * 3.5);
        }

        mockLaps.push({
            lapNum: i,
            lapTime: secondsToLapTime(lapDuration),
            timeOfDay: timeOfDayStr,
            absMin: absMin
        });

        lapTimeAccumulator += lapDuration;
    }
    
    return mockLaps;
}

function reconstructLapsTimeline(rawLaps) {
    if (!rawLaps || rawLaps.length === 0) return [];
    
    // Az utolsó kör végét a jelenlegi időhöz (vagy a verseny végéhez) rögzítjük
    const nowMs = Date.now();
    const endMs = RACE_END_TIME.getTime();
    let currentTimelineMs = Math.min(nowMs, endMs);
    
    // Visszafelé haladunk, így garantált, hogy a legutóbbi körök pontosan a jelenlegi
    // valós időponthoz lesznek igazítva, kiküszöbölve minden kumulatív csúszást!
    for (let i = rawLaps.length - 1; i >= 0; i--) {
        const lap = rawLaps[i];
        const lapSec = lapTimeToSeconds(lap.lapTime);
        const durationSec = (isNaN(lapSec) || lapSec <= 0) ? 69 : lapSec;
        
        // A kör végének időpontja
        const lapDate = new Date(currentTimelineMs);
        const hours = String(lapDate.getHours()).padStart(2, '0');
        const minutes = String(lapDate.getMinutes()).padStart(2, '0');
        const seconds = String(lapDate.getSeconds()).padStart(2, '0');

        lap.timeOfDay = `${hours}:${minutes}:${seconds}`;
        lap.absMin = dateToAbsMin(lapDate); // abszolút perc (24h-nál is pontos pilóta-hozzárendelés)

        // Visszalépünk a kör kezdetére (ami az előző kör vége)
        currentTimelineMs -= (durationSec * 1000);
    }
    
    return rawLaps;
}

// Köridők lekérdezése lapdata.php-ről proxy segítségével
async function fetchAndRenderRealTelemetry(runId, teamNumber) {
    try {
        const runPart = runId ? `run=${runId}&` : '';
        const targetUrl = `https://live.chronomoto.com/bssw/lapdata.php?${runPart}no=${teamNumber}&o=&t=${Date.now()}`;
        const htmlText = await fetchWithProxy(targetUrl);
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        
        const rows = doc.querySelectorAll('table tr');
        const laps = [];
        
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
                const lapNumStr = cells[0].textContent.trim();
                const lapNum = parseInt(lapNumStr);
                
                if (!isNaN(lapNum) && lapNum > 0) {
                    const lapTime = cells[1].textContent.trim();
                    laps.push({ lapNum, lapTime });
                }
            }
        });
        
        if (laps.length > 0) {
            const teamName = teamMap[teamNumber] || 'Csapat ' + teamNumber;
            const reconstructedLaps = reconstructLapsTimeline(laps);
            const mergedLaps = saveLapsToDatabase(reconstructedLaps, teamNumber, teamName);
            renderDriverTelemetryCards(mergedLaps);
        } else {
            showTelemetryError("Nincsenek elérhető köridők ehhez a rajtszámhoz ezen a futamon.");
        }
    } catch (error) {
        console.error('Hiba a valós telemetria lekérdezése közben:', error);
        showTelemetryError("Hiba történt a részletes köridők letöltésekor.");
    }
}

function showTelemetryError(message) {
    driverTelemetryGridEl.innerHTML = `
        <div class="telemetry-no-run" style="grid-column: 1 / -1; margin: 40px auto; text-align: center;">
            <i class="fa-solid fa-circle-info" style="color: var(--color-gold); margin-bottom: 8px; font-size: 1.3rem;"></i><br>
            ${message}
        </div>
    `;
}

function showTelemetryLoadingState() {
    driverTelemetryGridEl.innerHTML = `
        <div class="telemetry-loading" style="grid-column: 1 / -1; margin: 40px auto; text-align: center; color: var(--text-secondary);">
            <i class="fa-solid fa-spinner fa-spin" style="color: var(--color-cyan); margin-bottom: 8px; font-size: 1.3rem;"></i><br>
            Kapcsolódás a Chronomoto-hoz és adatok elemzése...
        </div>
    `;
    
    if (typeof telemetryTableWrapperEl !== 'undefined' && telemetryTableWrapperEl) {
        telemetryTableWrapperEl.innerHTML = `
            <div class="telemetry-loading" style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.8rem;">
                <i class="fa-solid fa-circle-notch fa-spin" style="margin-bottom: 6px; color: var(--color-cyan);"></i><br>
                Állás betöltése...
            </div>
        `;
    }
}

// --- ADATBÁZIS PERSZISZTENCIA LOGIKA (LOCALSTORAGE + EXPORT) ---

function saveLapsToDatabase(newLaps, teamNo, teamName) {
    if (!newLaps || newLaps.length === 0) return [];
    
    // Tisztítjuk a csapatnevet a fájl és kulcsnévhez
    const cleanTeamName = teamName.trim().replace(/[^a-zA-Z0-9]/g, '_');
    const storageKey = `laps_db_${teamNo}_${cleanTeamName}`;
    
    // Betöltjük a meglévő mentést
    let savedDb = [];
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
            savedDb = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Hiba a localStorage betöltése közben:', e);
    }
    
    // Összefésüljük a köröket a kör száma (lapNum) alapján
    const lapMap = {};
    savedDb.forEach(lap => {
        lapMap[lap.lapNum] = lap;
    });
    
    newLaps.forEach(lap => {
        if (!lap.driver) {
            lap.driver = getDriverForAbsMin(lapAbsMin(lap)) || 'Egyéb';
        }
        lapMap[lap.lapNum] = lap;
    });
    
    const mergedLaps = Object.values(lapMap).sort((a, b) => a.lapNum - b.lapNum);
    
    // Mentjük a localStorage-be
    try {
        localStorage.setItem(storageKey, JSON.stringify(mergedLaps));
    } catch (e) {
        console.error('Hiba a localStorage mentése közben:', e);
    }
    
    return mergedLaps;
}

function downloadDatabaseFile() {
    const teamName = teamMap[trackedTeamNo] || 'Csapat_' + trackedTeamNo;
    const cleanTeamName = teamName.trim().replace(/[^a-zA-Z0-9]/g, '_');
    const storageKey = `laps_db_${trackedTeamNo}_${cleanTeamName}`;
    
    const stored = localStorage.getItem(storageKey);
    
    if (!stored || JSON.parse(stored).length === 0) {
        alert("Nincsenek még mentett adatok ebben az adatbázisban a letöltéshez!");
        return;
    }
    
    const allLaps = JSON.parse(stored);
    // Kiszűrjük az exportálandó köröket a fül szerint (Időmérő = rajt előtt, Versenyfutam = rajt után)
    const filteredLaps = allLaps.filter(lap => {
        const abs = lapAbsMin(lap);
        if (abs == null) return activeStatsSubTab === 'qualy';
        const isQualy = abs < RACE_START_MIN;
        return activeStatsSubTab === 'qualy' ? isQualy : !isQualy;
    });
    
    if (filteredLaps.length === 0) {
        alert(`Nincs mentett kör ebben a szakaszban (${activeStatsSubTab === 'qualy' ? 'Időmérő' : 'Versenyfutam'}) a letöltéshez!`);
        return;
    }
    
    // Létrehozzuk a letölthető JSON fájlt formázottan
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(filteredLaps, null, 2));
    const downloadAnchor = document.createElement('a');
    
    // Fájlnév formátuma: rajtszam_csapatnev_szakasz.json (pl. 25_Makeshift_Brothers_idomero.json)
    const suffix = activeStatsSubTab === 'qualy' ? 'idomero' : 'verseny';
    const fileName = `${trackedTeamNo}_${cleanTeamName}_${suffix}.json`;
    
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", fileName);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

// Pontos dátum string formázása
function updateClockDisplay() {
    const now = getCurrentDate();
    
    // Óra megjelenítése (a napon belüli idő; szimulációban a másnapot "+1" jelzi)
    if (isSimulating) {
        clockTimeEl.textContent = `${fmtClock(simTimeMinutes)}:00`;
    } else {
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        clockTimeEl.textContent = `${hours}:${minutes}:${seconds}`;
    }

    // Dátum megjelenítése (mindig a valós dátum alapján)
    const year = now.getFullYear();
    const month = MONTH_NAMES[now.getMonth()];
    const day = now.getDate();
    clockDateEl.textContent = `${year}. ${month} ${day}.`;
}

// --- DÖNTÉSI LOGIKA (SZAKASZOK, AKTÍV VERSENYZŐ) ---

// Az aktív / következő szakaszt a getActiveSegment() és getNextSegment()
// függvények adják (a CSERE MOTOR szekcióban, az idővonalból számolva).

// --- UI FRISSÍTÉS ---

function updateUI() {
    invalidateTimeline(); // az idővonal függ a pontos időtől (jelenlegi etap, túlfutás)
    const now = getCurrentDate();
    const isBeforeRace = now < RACE_TIME;
    const currentTimeMinutes = getCurrentTimeMinutes();

    const isAfterRace = now >= RACE_END_TIME;

    // --- 1. VISSZASZÁMLÁLÁS MÓD (Verseny előtt és alatt is aktív) ---
    countdownHeroEl.classList.remove('hidden');

    // Ellenőrizzük, hogy az időmérőre, a verseny kezdetére vagy a végére számolunk-e vissza
    let targetEventTime = RACE_TIME;
    let eventTag = 'KÖVETKEZŐ ESEMÉNY: VERSENYFUTAM';
    let eventTitle = 'VERSENYFUTAM START';
    
    const isToday = now.getDate() === TARGET_DAY;
    const whenQualyStr = isToday ? "ma déli" : "holnap déli";
    const whenRaceStr = isToday ? "ma délutáni" : "holnap délutáni";
    let targetDesc = `A visszaszámlálás a ${whenRaceStr} futam kezdetét mutatja (${plan.raceStart}).`;

    if (now < QUALY_TIME) {
        targetEventTime = QUALY_TIME;
        eventTag = 'KÖVETKEZŐ ESEMÉNY: IDŐMÉRŐ EDZÉS';
        eventTitle = 'IDŐMÉRŐ EDZÉS KEZDETE';
        targetDesc = `A visszaszámlálás a ${whenQualyStr} időmérő kezdetét mutatja (${plan.qualyStart}).`;
    } else if (now < RACE_TIME) {
        // Ha már elmúlt az időmérő kezdetének időpontja, de még nincs versenyfutam
        const qualyEnd = new Date(TARGET_YEAR, TARGET_MONTH, TARGET_DAY, 13, 30, 0); // 13:30-ig tart
        if (now < qualyEnd) {
            eventTag = 'ESEMÉNY FOLYAMATBAN: IDŐMÉRŐ EDZÉS';
            eventTitle = 'IDŐMÉRŐ EDZÉS FOLYIK';
        }
    } else if (!isAfterRace) {
        targetEventTime = RACE_END_TIME;
        eventTag = 'ESEMÉNY FOLYAMATBAN: VERSENYFUTAM';
        eventTitle = 'HÁTRALÉVŐ IDŐ A VERSENYBŐL';
        targetDesc = `A visszaszámlálás a ${fmtClock(RACE_END_MIN, true)}-ás leintésig hátralévő időt mutatja.`;
    } else {
        targetEventTime = now; // to show 00:00:00:00
        eventTag = 'ESEMÉNY VÉGET ÉRT';
        eventTitle = 'VERSENYFUTAM LEINTVE';
        const raceHours = Math.round((RACE_END_MIN - RACE_START_MIN) / 60);
        targetDesc = `A ${raceHours} órás verseny sikeresen véget ért.`;
        
        if (!window.endRaceStatsShown) {
            window.endRaceStatsShown = true;
            if (typeof showEndRaceStats === 'function') {
                showEndRaceStats();
            }
        }
    }

    // Különbség számítása a célidőpontig
    const diffMs = targetEventTime - now;
    
    if (diffMs > 0) {
        const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

        countDaysEl.textContent = String(days).padStart(2, '0');
        countHoursEl.textContent = String(hours).padStart(2, '0');
        countMinutesEl.textContent = String(minutes).padStart(2, '0');
        countSecondsEl.textContent = String(seconds).padStart(2, '0');
    } else {
        countDaysEl.textContent = '00';
        countHoursEl.textContent = '00';
        countMinutesEl.textContent = '00';
        countSecondsEl.textContent = '00';
    }

    countdownEventTagEl.textContent = eventTag;
    countdownEventTitleEl.textContent = eventTitle;
    countdownTargetDescEl.textContent = targetDesc;

    if (isBeforeRace) {
        heroGridEl.classList.add('hidden');
        // Figyelmeztetések elrejtése a verseny előtt
        warningBannerEl.classList.add('hidden');
        warningModalEl.classList.add('hidden');
        dismissedStageId = null;
        dismissedBannerStageId = null;
    } else {
        // --- 2. ÉLŐ VERSENY KÖVETÉS MÓD ---
        heroGridEl.classList.remove('hidden');

        // currentTimeMinutes már be van állítva a függvény elején
        const activeSeg = getActiveSegment(currentTimeMinutes);
        const nextSeg = getNextSegment(currentTimeMinutes);

        // Figyelmeztetés a következő csere előtt 15 perccel.
        // A SÁV (banner) szimulációban is látszik — előnézet. A teljes képernyős
        // MODAL viszont csak ÉLESBEN ugrik fel (csúszkázás közben zavaró lenne).
        if (nextSeg) {
            const nextStartMin = nextSeg.startMin;
            const diffMinutes = nextStartMin - currentTimeMinutes;
            const nextId = nextStartMin;                       // stabil azonosító (cseréidőpont)
            const nextDriver = nextSeg.driver;
            const nextStartStr = fmtClock(nextStartMin, true);

            const needsRefuel = true; // minden cserénél tankolás van

            if (diffMinutes > 0 && diffMinutes <= 15) {
                // A banner frissítése és megjelenítése (ha nincs külön bezárva)
                if (dismissedBannerStageId !== nextId) {
                    warningMessageBannerEl.textContent = `${nextDriver} következik ${diffMinutes} percen belül (${nextStartStr})! Kezdjen el készülni!`;
                    warningBannerEl.classList.remove('hidden');
                } else {
                    warningBannerEl.classList.add('hidden');
                }

                // Tankolás banner megjelenítése (külön, piros)
                if (needsRefuel && dismissedRefuelBannerStageId !== nextId) {
                    refuelMessageBannerEl.textContent = `A következő csere (${nextDriver}, ${nextStartStr}) tankolással jár!`;
                    refuelBannerEl.classList.remove('hidden');
                } else {
                    refuelBannerEl.classList.add('hidden');
                }

                // A központi riasztás modal élesben ÉS szimulációban is felugrik
                // (a teszteléshez, hogy lásd, hogyan viselkedik éles versenyen)
                if (dismissedStageId !== nextId) {
                    warningMessageModalEl.textContent = `${nextDriver} következik ${diffMinutes} percen belül (${nextStartStr})! Kezdjen el készülni!`;
                    warningModalEl.classList.remove('hidden');
                } else {
                    warningModalEl.classList.add('hidden');
                }
            } else {
                // Ha már elhagytuk a 15 perces zónát, töröljük a némításokat
                if (dismissedStageId === nextId) dismissedStageId = null;
                if (dismissedBannerStageId === nextId) dismissedBannerStageId = null;
                if (dismissedRefuelStageId === nextId) dismissedRefuelStageId = null;
                if (dismissedRefuelBannerStageId === nextId) dismissedRefuelBannerStageId = null;
                warningBannerEl.classList.add('hidden');
                warningModalEl.classList.add('hidden');
                refuelBannerEl.classList.add('hidden');
                refuelModalEl.classList.add('hidden');
            }
        } else {
            warningBannerEl.classList.add('hidden');
            warningModalEl.classList.add('hidden');
            refuelBannerEl.classList.add('hidden');
            refuelModalEl.classList.add('hidden');
            dismissedStageId = null;
            dismissedBannerStageId = null;
            dismissedRefuelStageId = null;
            dismissedRefuelBannerStageId = null;
        }

        // Aktív versenyző (a TÉNYLEGES cseréidőket tükröző idővonalból)
        const activeDriverName = activeSeg ? activeSeg.driver : null;
        const isManual = activeSeg ? !!activeSeg.manualStart : false;

        // Teljes versenyből hátralévő idő (23:00-ig)
        if (totalRaceRemainingEl) {
            const totalLeft = Math.max(0, RACE_END_MIN - currentTimeMinutes);
            totalRaceRemainingEl.textContent = `Versenyből hátra: ${Math.floor(totalLeft / 60)} ó ${totalLeft % 60} p`;
        }

        if (activeDriverName) {
            activeDriverNameEl.textContent = activeDriverName;

            const startMin = activeSeg.startMin;
            const targetEndMin = activeSeg.projectedEndMin != null ? activeSeg.projectedEndMin : activeSeg.endMin;
            const totalDuration = Math.max(1, targetEndMin - startMin);
            const elapsed = currentTimeMinutes - startMin;
            const remaining = targetEndMin - currentTimeMinutes; // <0, ha késésben (túlfutott)
            const percent = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));

            // A tervező sorfolytonos számozását követi: hányadik etap az EGÉSZ terven
            // belül (minden cserénél nő), nem a pilóta hányadik köre.
            const etapNum = activeSeg.stintIndex != null ? activeSeg.stintIndex + 1 : (activeSeg.etap || 1);
            const etapTotal = SCHEDULE.length; // a terv összes etapja
            activeDriverStageEl.textContent = isManual
                ? `Kézi csere • Etap ${etapNum} / ${etapTotal}`
                : `Etap ${etapNum} / ${etapTotal}`;

            progressBarFillEl.style.width = `${percent}%`;
            if (remaining >= 0) {
                timeRemainingEl.textContent = `${remaining} perc van hátra`;
                timeRemainingEl.style.color = 'var(--color-cyan)';
            } else {
                // Túlfutott a tervezett cserén — a csere esedékes
                timeRemainingEl.textContent = `Csere esedékes! (+${-remaining} p késés)`;
                timeRemainingEl.style.color = 'var(--color-danger)';
            }
            activeStageStartEl.textContent = fmtClock(startMin, true);
            activeStageEndEl.textContent = fmtClock(targetEndMin, true);

            // Pulzáló keret: kézi cserénél arany, egyébként lila
            document.querySelector('.active-driver-card').style.boxShadow = isManual
                ? '0 0 20px rgba(255, 215, 0, 0.4)'
                : '0 0 20px var(--color-purple-glow)';
        } else {
            // Nincs aktív szakasz => a verseny lezárult (23:00 után)
            document.querySelector('.active-driver-card').style.boxShadow = 'none';
            activeDriverNameEl.textContent = "Program vége";
            activeDriverStageEl.textContent = "Minden etap lefutott";
            timeRemainingEl.textContent = "Befejezve";
            timeRemainingEl.style.color = 'var(--color-green)';
            progressBarFillEl.style.width = "100%";
            activeStageStartEl.textContent = fmtClock(RACE_END_MIN, true);
            activeStageEndEl.textContent = "--:--";
        }

        // Csere-gombok állapotának szinkronizálása
        refreshSwapButtons();
    }

    // 1. Fejléc szimulációs státusza
    if (isSimulating) {
        statusDotEl.className = 'status-dot simulating pulsing';
        liveIndicatorTextEl.textContent = 'SZIMULÁCIÓ AKTÍV';
        liveIndicatorTextEl.style.color = 'var(--color-purple)';
    } else {
        statusDotEl.className = 'status-dot pulsing';
        liveIndicatorTextEl.textContent = 'ÉLŐ KÖVETÉS';
        liveIndicatorTextEl.style.color = 'var(--text-secondary)';
    }




    // 4. Beosztás táblázat kirajzolása és frissítése
    renderTable(currentTimeMinutes);

    // 5. Statisztikák frissítése
    renderStats(currentTimeMinutes);

    // A telemetria (mock körök, állás-kártya) frissítését NEM itt végezzük —
    // szimulációs csúszkázáskor minden mozdulatnál újraépülne, ami rángatná az
    // oldalt. Helyette a 2 mp-es időzítő frissíti (csak ha változott a sim-idő),
    // illetve a csúszka elengedésekor (change esemény).
}

// Táblázat renderelése — a TÉNYLEGES idővonalból (tényleges múlt + újratervezett jövő)
function renderTable(currentTimeMinutes) {
    scheduleTableBodyEl.innerHTML = '';

    const timeline = getTimeline();
    const filtered = currentFilter === 'all'
        ? timeline
        : timeline.filter(seg => seg.driver === currentFilter);

    scheduleCountEl.textContent = `${filtered.length} Etap`;

    const now = getCurrentDate();
    const isBeforeRace = now < RACE_TIME;

    // Elválasztó sor létrehozása
    const makeDivider = (iconClass, text) => {
        const dividerRow = document.createElement('tr');
        dividerRow.className = 'divider-row';
        dividerRow.innerHTML = `
            <td colspan="3">
                <div class="divider-content">
                    <i class="${iconClass}"></i> ${text}
                </div>
            </td>
        `;
        return dividerRow;
    };

    let eveningStartInserted = false;
    let eveningEndInserted = false;

    filtered.forEach(seg => {
        const startMin = seg.startMin;
        const endMin = seg.endMin;

        // Esti/éjszakai szakasz KEZDETE (pl. 20:00) — dinamikusan a tervből
        if (EVENING_START_MIN != null && startMin >= EVENING_START_MIN && !eveningStartInserted) {
            scheduleTableBodyEl.appendChild(makeDivider('fa-solid fa-moon', `ESTI SZAKASZ KEZDETE — ${fmtClock(EVENING_START_MIN, true)}`));
            eveningStartInserted = true;
        }
        // Esti/éjszakai szakasz VÉGE (pl. 06:00 +1) — dinamikusan a tervből
        if (EVENING_END_MIN != null && startMin >= EVENING_END_MIN && !eveningEndInserted) {
            scheduleTableBodyEl.appendChild(makeDivider('fa-solid fa-sun', `ESTI SZAKASZ VÉGE — ${fmtClock(EVENING_END_MIN, true)}`));
            eveningEndInserted = true;
        }

        // Státusz meghatározása
        let rowClass = 'upcoming-row';
        let statusBadge = `<span class="status-badge upcoming"><i class="fa-regular fa-clock"></i> Következik</span>`;

        if (!isBeforeRace) {
            if (currentTimeMinutes >= endMin) {
                rowClass = 'completed-row';
                statusBadge = `<span class="status-badge completed"><i class="fa-solid fa-check"></i> Befejezve</span>`;
            } else if (currentTimeMinutes >= startMin && currentTimeMinutes < endMin) {
                rowClass = 'active-row';
                statusBadge = `<span class="status-badge palyan"><i class="fa-solid fa-motorcycle"></i> Pályán</span>`;
            }
        }

        const etapNum = seg.stintIndex != null ? seg.stintIndex + 1 : (seg.etap || 1); // a tervező sorfolytonos etap-száma
        const manualTag = seg.manualStart
            ? ` <span class="driver-etap" style="color: var(--color-gold);" title="Kézi csere ezen a ponton">• kézi</span>`
            : '';

        const row = document.createElement('tr');
        row.className = rowClass;
        row.dataset.id = seg.id;

        row.innerHTML = `
            <td class="schedule-time-display">${fmtClock(startMin)} - ${fmtClock(endMin)}</td>
            <td>
                <span class="driver-name-cell">${seg.driver}</span>
                <span class="driver-etap">(Etap ${etapNum})</span>${manualTag}
            </td>
            <td>${statusBadge}</td>
        `;

        scheduleTableBodyEl.appendChild(row);
    });
}

// Összesített statisztikák renderelése
function renderStats(currentTimeMinutes) {
    statsContainerEl.innerHTML = '';
    
    // Versenyzők egyedi listája
    const drivers = ['Lackó', 'Zsemle', 'Boldi', 'Beni'];
    
    const timeline = getTimeline();

    drivers.forEach(driver => {
        const segs = timeline.filter(seg => seg.driver === driver);
        const plannedTotal = DRIVER_PLANNED_TOTAL[driver] || 0; // tervezett összidő (perc)

        // Eddig ténylegesen levezetett idő (perc) az idővonalból
        const drivenMin = segs.reduce((acc, seg) => {
            const upto = Math.min(currentTimeMinutes, seg.endMin);
            return acc + Math.max(0, upto - seg.startMin);
        }, 0);

        // Befejezett etapok száma
        const completedCount = segs.filter(seg => currentTimeMinutes >= seg.endMin).length;

        const statRow = document.createElement('div');
        statRow.className = 'driver-stat-row';

        statRow.innerHTML = `
            <div class="driver-stat-info">
                <div class="driver-stat-color-bar color-${driver}"></div>
                <span class="driver-stat-name">${driver}</span>
            </div>
            <div class="driver-stat-values">
                <div class="driver-stat-duration">${Math.round(drivenMin)} / ${plannedTotal} perc</div>
                <div class="driver-stat-etaps">${segs.length} etap (${completedCount} kész)</div>
            </div>
        `;

        statsContainerEl.appendChild(statRow);
    });
}

// --- ESEMÉNYKEZELŐK ---

// Versenyző szűrő változása
driverFilterEl.addEventListener('change', (e) => {
    currentFilter = e.target.value;
    updateUI();
});

// A szimulációs csúszka tartományának és skálájának beállítása a tervhez
// (a teljes versenyt lefedi, akár 24 óra / éjfél átlépése esetén is)
function configureSimSlider() {
    if (!timeSimSliderEl) return;
    const lo = Math.max(0, RACE_START_MIN - 30);
    const hi = RACE_END_MIN + 30;
    timeSimSliderEl.min = lo;
    timeSimSliderEl.max = hi;
    if (simTimeMinutes < lo || simTimeMinutes > hi) {
        simTimeMinutes = RACE_START_MIN;
        timeSimSliderEl.value = RACE_START_MIN;
    }
    const ticks = document.querySelector('.slider-ticks');
    if (ticks) {
        const mid = Math.round((lo + hi) / 2);
        ticks.innerHTML = `<span>${fmtClock(lo, true)}</span><span>${fmtClock(mid, true)}</span><span>${fmtClock(hi, true)}</span>`;
    }
}

// Szimulációs kapcsoló
simToggleEl.addEventListener('change', (e) => {
    isSimulating = e.target.checked;

    if (isSimulating) {
        sliderGroupEl.classList.remove('disabled');
        timeSimSliderEl.disabled = false;
        configureSimSlider();
        // A csúszkát a valós időhöz állítjuk, a verseny ablakán belülre szorítva
        const realAbs = dateToAbsMin(new Date());
        const clampedMinutes = Math.min(RACE_END_MIN, Math.max(RACE_START_MIN, realAbs));
        timeSimSliderEl.value = clampedMinutes;
        simTimeMinutes = clampedMinutes;
        simTimeDisplayEl.textContent = fmtClock(clampedMinutes, true);
    } else {
        sliderGroupEl.classList.add('disabled');
        timeSimSliderEl.disabled = true;
    }

    updateUI();
    updateClockDisplay();
    lastSimTelemetryMin = simTimeMinutes;
    updateTelemetryUI();
});

// Szimulációs csúszka változása (húzás közben: csak a könnyű UI — nincs telemetria-újraépítés)
timeSimSliderEl.addEventListener('input', (e) => {
    simTimeMinutes = parseInt(e.target.value);
    simTimeDisplayEl.textContent = fmtClock(simTimeMinutes, true);

    updateUI();
    updateClockDisplay();
});

// A csúszka elengedésekor frissítjük a telemetriát is (mock körök, állás-kártya)
timeSimSliderEl.addEventListener('change', () => {
    lastSimTelemetryMin = simTimeMinutes;
    updateTelemetryUI();
});

// SIMA CSERE — egy kattintással a rotáció következő pilótájára vált (a sorrend marad)
if (swapNextBtn) {
    swapNextBtn.addEventListener('click', () => {
        if (performSwap(null)) {
            refreshSwapButtons();
            updateUI();
            updateClockDisplay();
            lastSimTelemetryMin = simTimeMinutes;
            updateTelemetryUI();
        }
    });
}

// SORON KÍVÜLI CSERE — legördülőből választható, kire cserélünk
if (earlySwapBtn) {
    earlySwapBtn.addEventListener('click', () => {
        const t = getCurrentTimeMinutes();
        // Alapból a soron következő pilótát ajánljuk fel
        const nextSeg = getNextSegment(t);
        if (nextSeg && earlySwapSelect) {
            earlySwapSelect.value = nextSeg.driver;
        }
        swapModal.classList.remove('hidden');
    });
}

if (cancelSwapBtn) {
    cancelSwapBtn.addEventListener('click', () => {
        undoLastSwap();
        refreshSwapButtons();
        updateUI();
        updateClockDisplay();
        updateTelemetryUI();
    });
}

if (swapYesBtn) {
    swapYesBtn.addEventListener('click', () => {
        const ok = performSwap(earlySwapSelect.value); // soron kívüli: a választott pilóta jön
        swapModal.classList.add('hidden');
        if (ok) {
            refreshSwapButtons();
            updateUI();
            updateClockDisplay();
            lastSimTelemetryMin = simTimeMinutes;
            updateTelemetryUI();
        }
    });
}

if (swapNoBtn) {
    swapNoBtn.addEventListener('click', () => {
        swapModal.classList.add('hidden');
    });
}

// Figyelmeztető ablak elnémítása (leokézása)
warningOkBtnEl.addEventListener('click', () => {
    const currentTimeMinutes = getCurrentTimeMinutes();
    const nextSeg = getNextSegment(currentTimeMinutes);
    if (nextSeg) {
        dismissedStageId = nextSeg.startMin;
        // Ha tankolás is kell ehhez a cseréhez, feldobjuk a tankolás modalt
        const needsRefuel = true; // minden cserénél tankolás van
        if (needsRefuel && dismissedRefuelStageId !== nextSeg.startMin) {
            refuelMessageModalEl.textContent = `A következő csere (${nextSeg.driver}, ${fmtClock(nextSeg.startMin, true)}) tankolással jár! Készítsétek elő az üzemanyagot!`;
            refuelModalEl.classList.remove('hidden');
        }
    }
    warningModalEl.classList.add('hidden');
});

// Tankolás modal elnémítása
refuelOkBtnEl.addEventListener('click', () => {
    const currentTimeMinutes = getCurrentTimeMinutes();
    const nextSeg = getNextSegment(currentTimeMinutes);
    if (nextSeg) {
        dismissedRefuelStageId = nextSeg.startMin;
    }
    refuelModalEl.classList.add('hidden');
});

// Tankolás banner bezárása
refuelCloseBtnEl.addEventListener('click', () => {
    const currentTimeMinutes = getCurrentTimeMinutes();
    const nextSeg = getNextSegment(currentTimeMinutes);
    if (nextSeg) {
        dismissedRefuelBannerStageId = nextSeg.startMin;
    }
    refuelBannerEl.classList.add('hidden');
});

// Figyelmeztető sáv elrejtése (bezárása)
warningCloseBtnEl.addEventListener('click', () => {
    const currentTimeMinutes = getCurrentTimeMinutes();
    const nextSeg = getNextSegment(currentTimeMinutes);
    if (nextSeg) {
        dismissedBannerStageId = nextSeg.startMin;
    }
    warningBannerEl.classList.add('hidden');
});

// Chronomoto beágyazás be- és kikapcsolása
toggleIframeBtnEl.addEventListener('click', () => {
    const isActive = iframeWrapperEl.classList.toggle('active');
    if (isActive) {
        toggleIframeBtnEl.innerHTML = `<i class="fa-solid fa-window-minimize"></i> Bezárás`;
    } else {
        toggleIframeBtnEl.innerHTML = `<i class="fa-solid fa-window-restore"></i> Beágyazás`;
    }
});

// Tabok váltása
function switchTab(tabId) {
    activeTab = tabId;
    
    tabScheduleBtnEl.classList.remove('active');
    if (tabLapRankBtnEl) tabLapRankBtnEl.classList.remove('active');
    tabTeamBtnEl.classList.remove('active');
    if (tabChartsBtnEl) tabChartsBtnEl.classList.remove('active');
    if (tabPlannerBtnEl) tabPlannerBtnEl.classList.remove('active');

    tabScheduleContentEl.classList.add('hidden');
    if (tabLapRankContentEl) tabLapRankContentEl.classList.add('hidden');
    tabTeamContentEl.classList.add('hidden');
    if (tabChartsContentEl) tabChartsContentEl.classList.add('hidden');
    if (tabPlannerContentEl) tabPlannerContentEl.classList.add('hidden');

    if (tabId === 'schedule') {
        tabScheduleBtnEl.classList.add('active');
        tabScheduleContentEl.classList.remove('hidden');
    } else if (tabId === 'laprank') {
        if (tabLapRankBtnEl) tabLapRankBtnEl.classList.add('active');
        if (tabLapRankContentEl) tabLapRankContentEl.classList.remove('hidden');
    } else if (tabId === 'team') {
        tabTeamBtnEl.classList.add('active');
        tabTeamContentEl.classList.remove('hidden');
        updateTelemetryUI();
    } else if (tabId === 'charts') {
        if (tabChartsBtnEl) tabChartsBtnEl.classList.add('active');
        if (tabChartsContentEl) tabChartsContentEl.classList.remove('hidden');
        drawCharts();
    } else if (tabId === 'planner') {
        if (tabPlannerBtnEl) tabPlannerBtnEl.classList.add('active');
        if (tabPlannerContentEl) tabPlannerContentEl.classList.remove('hidden');
        openPlanner();
    }
}

tabScheduleBtnEl.addEventListener('click', () => switchTab('schedule'));
if (tabLapRankBtnEl) {
    tabLapRankBtnEl.addEventListener('click', () => switchTab('laprank'));
}
tabTeamBtnEl.addEventListener('click', () => switchTab('team'));
if (tabChartsBtnEl) {
    tabChartsBtnEl.addEventListener('click', () => switchTab('charts'));
}
if (tabPlannerBtnEl) {
    tabPlannerBtnEl.addEventListener('click', () => switchTab('planner'));
}

// Pilóta statisztika al-tabok váltása (Időmérő / Versenyfutam)
subTabQualyEl.addEventListener('click', () => {
    activeStatsSubTab = 'qualy';
    subTabQualyEl.classList.add('active');
    subTabRaceEl.classList.remove('active');
    updateTelemetryUI();
});

subTabRaceEl.addEventListener('click', () => {
    activeStatsSubTab = 'race';
    subTabRaceEl.classList.add('active');
    subTabQualyEl.classList.remove('active');
    updateTelemetryUI();
});

// Adatbázis mentése fájlba gomb
downloadDbBtnEl.addEventListener('click', downloadDatabaseFile);

// Adatbázis törlése gomb
const clearDbBtnEl = document.getElementById('clearDbBtn');
if (clearDbBtnEl) {
    clearDbBtnEl.addEventListener('click', () => {
        if (confirm("Biztosan törölni szeretnéd a követett csapat teljes eddigi kör adatbázisát? (A korábbi szimulációs tesztadatok törléséhez hasznos)")) {
            const teamName = teamMap[trackedTeamNo] || 'Csapat_' + trackedTeamNo;
            const cleanTeamName = teamName.trim().replace(/[^a-zA-Z0-9]/g, '_');
            const storageKey = `laps_db_${trackedTeamNo}_${cleanTeamName}`;
            localStorage.removeItem(storageKey);
            alert("Adatbázis sikeresen törölve! Az oldal most újraindul a tiszta kezdéshez.");
            location.reload();
        }
    });
}

// A követett csapat megjegyzése — frissítés után is ugyanazt kövesse
function saveTrackedTeam() {
    try {
        localStorage.setItem('tracked_team_query', trackedTeamQuery || '');
        if (trackedTeamNo) localStorage.setItem('tracked_team_no', String(trackedTeamNo));
    } catch (e) {}
}

// Kétoldali automatikus kitöltés (Rajtszám <-> Csapatnév)
teamNumberInputEl.addEventListener('input', () => {
    const rsz = teamNumberInputEl.value.trim();
    if (rsz && teamMap[rsz]) {
        teamNameInputEl.value = teamMap[rsz];
        trackedTeamQuery = rsz;
        updateTelemetryUI();
    }
});

teamNameInputEl.addEventListener('input', () => {
    const nev = teamNameInputEl.value.trim().toLowerCase();
    if (nev) {
        const matchedRsz = Object.keys(teamMap).find(rsz => 
            teamMap[rsz].toLowerCase().includes(nev)
        );
        if (matchedRsz) {
            teamNumberInputEl.value = matchedRsz;
            trackedTeamQuery = teamMap[matchedRsz];
            updateTelemetryUI();
        }
    }
});

// Követés indítása gomb
updateTeamQueryBtnEl.addEventListener('click', (e) => {
    e.preventDefault();
    const rsz = teamNumberInputEl.value.trim();
    const nev = teamNameInputEl.value.trim();
    
    console.log("Követési gomb megnyomva. Bevitel - Rajtszám:", rsz, "| Név:", nev);
    
    if (rsz) {
        trackedTeamQuery = rsz;
        if (!isNaN(parseInt(rsz))) {
            trackedTeamNo = parseInt(rsz);
        }
    } else if (nev) {
        trackedTeamQuery = nev;
        const matchedRsz = Object.keys(teamMap).find(key => 
            teamMap[key].toLowerCase().includes(nev.toLowerCase())
        );
        if (matchedRsz) {
            trackedTeamNo = parseInt(matchedRsz);
        }
    }
    
    console.log("Beállított követett rajtszám (trackedTeamNo):", trackedTeamNo, "| Lekérdezési szöveg (trackedTeamQuery):", trackedTeamQuery);

    saveTrackedTeam();
    showTelemetryLoadingState();
    updateTelemetryUI();
});

// Enter gomb kezelése az inputoknál
teamNumberInputEl.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') {
        const val = teamNumberInputEl.value.trim();
        if (val) {
            trackedTeamQuery = val;
            if (!isNaN(parseInt(val))) {
                trackedTeamNo = parseInt(val);
            }
            saveTrackedTeam();
            showTelemetryLoadingState();
            updateTelemetryUI();
        }
    }
});

teamNameInputEl.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') {
        const val = teamNameInputEl.value.trim();
        if (val) {
            trackedTeamQuery = val;
            const matchedRsz = Object.keys(teamMap).find(key =>
                teamMap[key].toLowerCase().includes(val.toLowerCase())
            );
            if (matchedRsz) {
                trackedTeamNo = parseInt(matchedRsz);
            }
            saveTrackedTeam();
            showTelemetryLoadingState();
            updateTelemetryUI();
        }
    }
});

// --- SAJÁT TELEMETRIA-PROXY MEZŐ (opcionális, pl. Cloudflare Worker) ---
// A mezőt és a státuszt frissíti a localStorage alapján (a szinkron is ezt hívja).
function refreshProxyUI() {
    const inp = document.getElementById('proxyUrlInput');
    const statusEl = document.getElementById('proxyStatus');
    const v = localStorage.getItem('telemetry_proxy') || '';
    if (inp && document.activeElement !== inp) inp.value = v;
    if (statusEl) {
        statusEl.textContent = v ? '✓ Egyedi proxy aktív' : '✓ Beépített Worker aktív (msb-proxy)';
        statusEl.style.color = 'var(--color-green)';
    }
}
(function initProxyField() {
    const inp = document.getElementById('proxyUrlInput');
    const btn = document.getElementById('saveProxyBtn');
    if (!inp || !btn) return;
    refreshProxyUI();
    btn.addEventListener('click', () => {
        const v = inp.value.trim();
        if (v) localStorage.setItem('telemetry_proxy', v);
        else localStorage.removeItem('telemetry_proxy');
        refreshProxyUI();
        if (typeof syncPushProxy === 'function') syncPushProxy(); // megosztás minden eszközzel
        if (typeof showTelemetryLoadingState === 'function') showTelemetryLoadingState();
        if (typeof updateTelemetryUI === 'function') updateTelemetryUI();
    });
})();

// --- VILÁGOS / SÖTÉT MÓD KEZELÉSE ---
const themeToggleBtnEl = document.getElementById('themeToggleBtn');

// Betöltéskor beállítjuk a mentett témát
const savedTheme = localStorage.getItem('app-theme') || 'dark';
if (savedTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    themeToggleBtnEl.innerHTML = '<i class="fa-solid fa-moon" style="font-size: 1.1rem; color: var(--color-purple);"></i>';
} else {
    document.documentElement.removeAttribute('data-theme');
    themeToggleBtnEl.innerHTML = '<i class="fa-solid fa-sun" style="font-size: 1.1rem; color: var(--color-gold);"></i>';
}

themeToggleBtnEl.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    if (currentTheme === 'light') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('app-theme', 'dark');
        themeToggleBtnEl.innerHTML = '<i class="fa-solid fa-sun" style="font-size: 1.1rem; color: var(--color-gold);"></i>';
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('app-theme', 'light');
        themeToggleBtnEl.innerHTML = '<i class="fa-solid fa-moon" style="font-size: 1.1rem; color: var(--color-purple);"></i>';
    }
    // Grafikonok újrarajzolása az új téma színeivel, ha épp látszanak
    if (activeTab === 'charts' && typeof drawCharts === 'function') drawCharts();
});

// --- GRAFIKONOK (CHART.JS) LOGIKA ---

let posChartInstance = null;
let lapChartInstances = []; // pilótánkénti mini-diagramok Chart példányai

function savePositionHistory(posString) {
    if (!posString) return;
    const pos = parseInt(posString);
    if (isNaN(pos)) return;

    const cleanTeamName = teamNameInputEl.value.trim().replace(/[^a-zA-Z0-9]/g, '_');
    const storageKey = `pos_history_${trackedTeamNo}_${cleanTeamName}`;
    let history = [];
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) history = JSON.parse(stored);
    } catch (e) {}

    const now = new Date();
    // Csak akkor mentsük, ha eltelt 1 perc, vagy változott a pozíció
    if (history.length > 0) {
        const lastEntry = history[history.length - 1];
        const lastTime = new Date(lastEntry.time);
        const diffMs = now - lastTime;
        if (diffMs < 60000 && lastEntry.pos === pos) {
            return;
        }
    }

    history.push({ time: now.toISOString(), pos: pos });
    try {
        localStorage.setItem(storageKey, JSON.stringify(history));
    } catch (e) {}
    
    if (activeTab === 'charts') {
        drawCharts();
    }
}

// A grafikonok téma-tudatos színpalettája (light/dark)
function chartTheme() {
    const cs = getComputedStyle(document.documentElement);
    const val = (n, fb) => { const v = cs.getPropertyValue(n).trim(); return v || fb; };
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    return {
        isLight,
        text: val('--text-primary', isLight ? '#1e272e' : '#f5f5f5'),
        muted: val('--text-secondary', isLight ? '#4b6584' : '#b3b3b3'),
        grid: isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)',
        border: isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)',
        tooltipBg: isLight ? 'rgba(255,255,255,0.96)' : 'rgba(20,22,34,0.95)',
        driver: {
            'Lackó': val('--color-purple', '#7c4dff'),
            'Zsemle': val('--color-blue', '#0984e3'),
            'Boldi': val('--color-green', '#00c853'),
            'Beni': val('--color-gold', '#ffab00')
        },
        fallback: ['#e84393', '#00b894', '#0984e3', '#fdcb6e', '#6c5ce7']
    };
}

function hexToRgba(hex, a) {
    const m = hex.replace('#', '');
    const s = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
    const n = parseInt(s, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function drawCharts() {
    if (!document.getElementById('positionChart')) return;
    if (typeof Chart === 'undefined') return;

    const T = chartTheme();
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = T.muted;

    const commonTooltip = {
        backgroundColor: T.tooltipBg,
        titleColor: T.text,
        bodyColor: T.text,
        borderColor: T.border,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxPadding: 4
    };

    const cleanTeamName = teamNameInputEl.value.trim().replace(/[^a-zA-Z0-9]/g, '_');

    // ===================== 1. CSAPAT HELYEZÉS (IDŐVONAL) =====================
    const posKey = `pos_history_${trackedTeamNo}_${cleanTeamName}`;
    let posHistory = [];
    try {
        const stored = localStorage.getItem(posKey);
        if (stored) posHistory = JSON.parse(stored);
    } catch (e) {}

    const posCanvas = document.getElementById('positionChart');
    const posCtx = posCanvas.getContext('2d');
    if (posChartInstance) posChartInstance.destroy();

    const posLabels = posHistory.map(h => {
        const d = new Date(h.time);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    });
    const posDataPoints = posHistory.map(h => parseInt(h.pos));

    // Színátmenetes terület a lila vonal alá
    const posGrad = posCtx.createLinearGradient(0, 0, 0, posCanvas.height || 300);
    posGrad.addColorStop(0, hexToRgba(T.driver['Lackó'], 0.35));
    posGrad.addColorStop(1, hexToRgba(T.driver['Lackó'], 0.02));

    const maxPos = posDataPoints.length ? Math.max(...posDataPoints) : 12;

    posChartInstance = new Chart(posCtx, {
        type: 'line',
        data: {
            labels: posLabels,
            datasets: [{
                label: 'Helyezés',
                data: posDataPoints,
                borderColor: T.driver['Lackó'],
                backgroundColor: posGrad,
                borderWidth: 2.5,
                stepped: 'before',        // a helyezés diszkrét — lépcsős vonal
                fill: true,
                pointBackgroundColor: T.driver['Zsemle'],
                pointBorderColor: T.isLight ? '#fff' : '#0d0f18',
                pointBorderWidth: 1.5,
                pointRadius: posDataPoints.length <= 40 ? 3 : 0,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            animation: { duration: 500 },
            layout: { padding: { top: 6, right: 6 } },
            scales: {
                y: {
                    reverse: true, min: 1,
                    suggestedMax: maxPos + 1,
                    ticks: { color: T.muted, stepSize: 1, precision: 0, padding: 6 },
                    grid: { color: T.grid, drawTicks: false },
                    border: { display: false },
                    title: { display: true, text: 'Helyezés', color: T.muted, font: { weight: '600' } }
                },
                x: {
                    ticks: { color: T.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
                    grid: { display: false },
                    border: { color: T.border }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...commonTooltip,
                    callbacks: {
                        title: (items) => items.length ? `Idő: ${items[0].label}` : '',
                        label: (ctx) => `  ${ctx.raw}. hely`
                    }
                }
            }
        }
    });

    // ===================== 2. PILÓTÁK KÖRIDEJE =====================
    const lapsKey = `laps_db_${trackedTeamNo}_${cleanTeamName}`;
    let allLaps = [];
    try {
        const stored = localStorage.getItem(lapsKey);
        if (stored) allLaps = JSON.parse(stored);
    } catch (e) {}

    // Pilótánként összegyűjtjük a valós köröket (a saját sorszámukkal)
    const perDriver = {}; // driver -> [{seq, sec, lapNum}]
    const allSecs = [];
    allLaps.forEach((lap, idx) => {
        const driver = lap.driver || getDriverForAbsMin(lapAbsMin(lap)) || 'Ismeretlen';
        const sec = lapTimeToSeconds(lap.lapTime);
        if (!sec || isNaN(sec) || sec === Infinity || sec < 50 || sec > 180) return;
        if (!perDriver[driver]) perDriver[driver] = [];
        const lapNum = parseInt(lap.lapNum) || (idx + 1);
        perDriver[driver].push({ seq: perDriver[driver].length + 1, sec, lapNum });
        allSecs.push(sec);
    });

    // Közös, szoros y-skála: a lassú kiállások (boksz) ne nyomják össze a skálát.
    // A felső ~8%-ot (kiugró körök) levágjuk a tengelyről.
    let yMin = 60, yMax = 80;
    if (allSecs.length) {
        const sorted = allSecs.slice().sort((a, b) => a - b);
        const pct = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
        yMin = Math.floor(pct(0) - 0.5);
        yMax = Math.ceil(pct(0.92) + 0.5);
        if (yMax - yMin < 4) yMax = yMin + 4;
    }

    const grid = document.getElementById('lapChartsGrid');
    if (grid) {
        lapChartInstances.forEach(c => { try { c.destroy(); } catch (e) {} });
        lapChartInstances = [];
        grid.innerHTML = '';

        // A DRIVERS sorrendjében, majd az esetleges egyéb (pl. „Ismeretlen") nevek
        const orderedDrivers = DRIVERS.filter(d => perDriver[d] && perDriver[d].length);
        Object.keys(perDriver).forEach(d => { if (!orderedDrivers.includes(d)) orderedDrivers.push(d); });

        if (!orderedDrivers.length) {
            grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:30px 0;">Még nincs köridő-adat — indítsd el a követést egy aktív futam alatt.</div>`;
            return;
        }

        const movAvg = (arr, w) => arr.map((p, i) => {
            const sl = arr.slice(Math.max(0, i - w), i + 1);
            return { x: p.seq, y: sl.reduce((a, b) => a + b.sec, 0) / sl.length };
        });

        orderedDrivers.forEach((driver, idx) => {
            const laps = perDriver[driver];
            const color = T.driver[driver] || T.fallback[idx % T.fallback.length];
            const clean = laps.filter(p => p.sec <= yMax + 0.001);
            const best = laps.reduce((m, p) => p.sec < m.sec ? p : m, laps[0]);
            const avgArr = clean.length ? clean : laps;
            const avg = avgArr.reduce((s, p) => s + p.sec, 0) / avgArr.length;

            const card = document.createElement('div');
            card.className = 'lap-mini-card';
            card.innerHTML =
                `<div class="lap-mini-head">
                    <div class="lap-mini-name"><span class="lap-mini-dot" style="background:${color};"></span>${driver}</div>
                    <span class="lap-mini-count">${laps.length} kör</span>
                </div>
                <div class="lap-mini-stats">
                    <div><div class="lap-mini-lbl">Leggyorsabb</div><div class="lap-mini-val" style="color:${color};">${secondsToLapTime(best.sec)}</div></div>
                    <div><div class="lap-mini-lbl">Átlag</div><div class="lap-mini-val">${secondsToLapTime(avg)}</div></div>
                </div>
                <div class="lap-mini-canvas"><canvas></canvas></div>`;
            grid.appendChild(card);

            const ctx = card.querySelector('canvas').getContext('2d');
            const inst = new Chart(ctx, {
                data: { datasets: [
                    { type: 'line', data: movAvg(laps, 5), borderColor: color, borderWidth: 2.5, pointRadius: 0, tension: 0.4, fill: 'start', backgroundColor: hexToRgba(color, 0.08) },
                    { type: 'scatter', data: clean.map(p => ({ x: p.seq, y: p.sec, lapNum: p.lapNum })), backgroundColor: hexToRgba(color, 0.45), pointRadius: 2.4, pointHoverRadius: 5 },
                    { type: 'scatter', data: [{ x: best.seq, y: best.sec, lapNum: best.lapNum }], backgroundColor: '#f0a52a', pointStyle: 'rectRot', pointRadius: 7, pointHoverRadius: 9, borderColor: T.isLight ? '#fff' : '#0d0f18', borderWidth: 1.5 }
                ]},
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'nearest', intersect: false },
                    animation: { duration: 400 },
                    layout: { padding: { top: 6, right: 4 } },
                    scales: {
                        y: { min: yMin, max: yMax, ticks: { color: T.muted, callback: v => secondsToLapTime(v), maxTicksLimit: 4, font: { size: 10 }, padding: 4 }, grid: { color: T.grid, drawTicks: false }, border: { display: false } },
                        x: { type: 'linear', min: 0, ticks: { display: false }, grid: { display: false }, border: { display: false } }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            ...commonTooltip,
                            callbacks: {
                                title: (items) => items.length ? `${items[0].raw.lapNum}. kör` : '',
                                label: (ctx2) => `  ${secondsToLapTime(ctx2.raw.y)}`
                            }
                        }
                    }
                }
            });
            lapChartInstances.push(inst);
        });
    }
}

// --- RENDSZER INDÍTÁSA ---

// Kezdeti beállítások
// ============================================================================
//  FELHŐ SZINKRON (Firebase Realtime Database) — a beosztás és a cserék valós
//  idejű megosztása több eszköz közt (pl. box-laptop ↔ tablet).
// ----------------------------------------------------------------------------
//  1) Hozz létre egy INGYENES Firebase projektet (console.firebase.google.com),
//     kapcsold be a Realtime Database-t, és másold ide a projekt configját.
//  2) Töltsd fel az oldalt (Netlify/Cloudflare Pages/GitHub Pages).
//  3) Nyisd meg ugyanazt a webcímet a laptopon és a tableten — automatikusan
//     ugyanabba a "szobába" csatlakoznak, és élőben szinkronizálnak.
//  Ha a config üres, az oldal HELYI módban működik (semmi nem törik el).
// ============================================================================

const SYNC_CONFIG = {
    apiKey: "AIzaSyDLCpnsgiidY1NLpTssPKH7pHg1QHp34QA",
    authDomain: "makeshift-race.firebaseapp.com",
    databaseURL: "https://makeshift-race-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "makeshift-race",
    storageBucket: "makeshift-race.firebasestorage.app",
    messagingSenderId: "564954782755",
    appId: "1:564954782755:web:ab0be3a2aba9ee77686596"
};
let SYNC_ROOM = localStorage.getItem('sync_room') || 'makeshift'; // közös szoba-azonosító
let syncRef = null;
let syncApplying = false; // igaz, amikor épp távoli adatot alkalmazunk (ne írjuk vissza)

function syncEnabled() {
    return !!(SYNC_CONFIG.apiKey && SYNC_CONFIG.databaseURL && typeof firebase !== 'undefined');
}

function updateSyncStatus(text, color) {
    const el = document.getElementById('syncStatus');
    if (el) { el.textContent = text; el.style.color = color || 'var(--text-muted)'; }
}

function syncPushPlan() {
    if (syncRef && !syncApplying) syncRef.child('planJson').set(JSON.stringify(plan)).catch(() => {});
}
function syncPushSwaps() {
    if (syncRef && !syncApplying) syncRef.child('swapJson').set(JSON.stringify(swapLog)).catch(() => {});
}
function syncPushProxy() {
    // A saját telemetria-proxy címét is megosztjuk minden eszközzel
    if (syncRef && !syncApplying) syncRef.child('proxyUrl').set(localStorage.getItem('telemetry_proxy') || '').catch(() => {});
}
function syncPushAll() {
    if (!syncRef) return;
    syncRef.child('planJson').set(JSON.stringify(plan)).catch(() => {});
    syncRef.child('swapJson').set(JSON.stringify(swapLog)).catch(() => {});
    const proxy = localStorage.getItem('telemetry_proxy');
    if (proxy) syncRef.child('proxyUrl').set(proxy).catch(() => {});
}

function syncInit() {
    if (!syncEnabled()) {
        updateSyncStatus('Szinkron: nincs beállítva (helyi mód)', 'var(--text-muted)');
        return;
    }
    try {
        if (!firebase.apps.length) firebase.initializeApp(SYNC_CONFIG);
        const db = firebase.database();
        syncRef = db.ref('rooms/' + SYNC_ROOM);
        alertListenerInit = false; // az első alert-pillanatkép csak alapérték, nem mutatjuk
        voiceListenerInit = false; // a betöltéskori (régi) hangüzenetet ne játsszuk le
        updateSyncStatus('Szinkron: kapcsolódás…', 'var(--color-gold)');

        // Kapcsolat-állapot kijelzése
        db.ref('.info/connected').on('value', s => {
            if (s.val() === true) updateSyncStatus(`Szinkron: kapcsolódva ✓  (szoba: ${SYNC_ROOM})`, 'var(--color-green)');
            else updateSyncStatus('Szinkron: offline — újrakapcsolódás…', 'var(--color-gold)');
        });

        // Távoli változások figyelése és alkalmazása
        syncRef.on('value', snap => {
            const data = snap.val();
            if (!data || (data.planJson == null && data.swapJson == null)) {
                syncPushAll(); // üres szoba → feltöltjük a helyi állapotot
                return;
            }
            syncApplying = true;
            let changed = false;
            let proxyChanged = false;
            try {
                if (data.planJson) {
                    const p = JSON.parse(data.planJson);
                    if (JSON.stringify(p) !== JSON.stringify(plan)) {
                        plan = p; savePlan(); rebuildPlanDerived(); invalidateTimeline(); changed = true;
                    }
                }
                if (data.swapJson != null) {
                    const sw = JSON.parse(data.swapJson);
                    if (JSON.stringify(sw) !== JSON.stringify(swapLog)) {
                        swapLog = Array.isArray(sw) ? sw : []; saveSwapLog(); invalidateTimeline(); changed = true;
                    }
                }
                // Saját telemetria-proxy szinkronizálása az eszközök között
                if (typeof data.proxyUrl === 'string') {
                    const curProxy = localStorage.getItem('telemetry_proxy') || '';
                    if (data.proxyUrl !== curProxy) {
                        if (data.proxyUrl) localStorage.setItem('telemetry_proxy', data.proxyUrl);
                        else localStorage.removeItem('telemetry_proxy');
                        if (typeof refreshProxyUI === 'function') refreshProxyUI();
                        proxyChanged = true;
                    }
                }
            } catch (e) { console.error('Szinkron feldolgozási hiba:', e); }
            syncApplying = false;

            if (changed) {
                refreshSwapButtons();
                updateUI();
                updateClockDisplay();
                updateTelemetryUI();
                if (activeTab === 'planner' && typeof openPlanner === 'function') openPlanner();
            } else if (proxyChanged) {
                updateTelemetryUI();
            }
        });

        // Riasztások (gyorsgombok popupjai) figyelése — MINDEN eszközön megjelennek.
        // Betöltéskor a legutóbbi (régi) riasztást nem mutatjuk, csak az újakat.
        syncRef.child('alert').on('value', snap => {
            const a = snap.val();
            if (!alertListenerInit) {
                alertListenerInit = true;
                if (a && a.ts) lastAlertTsSeen = a.ts;
                return;
            }
            if (!a || !a.ts || a.ts <= lastAlertTsSeen) return;
            lastAlertTsSeen = a.ts;
            showCustomAlert(a.title, a.msg, a.colorVar, a.iconClass);
        });

        // Hangüzenetek (walkie-talkie) figyelése — MINDEN eszközön lejátszódnak.
        // Betöltéskor a szobában lévő (régi) hangot nem játsszuk le, csak az újakat.
        syncRef.child('voice').on('value', snap => {
            const v = snap.val();
            if (!voiceListenerInit) {
                voiceListenerInit = true;
                if (v && v.ts) lastVoiceTsSeen = v.ts;
                return;
            }
            if (!v || !v.ts || v.ts <= lastVoiceTsSeen || !v.audio) return;
            lastVoiceTsSeen = v.ts;
            playIncomingVoice(v.audio);
        });
    } catch (e) {
        console.error('Szinkron inicializálási hiba:', e);
        updateSyncStatus('Szinkron: hiba (helyi mód)', 'var(--color-danger)');
    }
}

// Szoba váltása (mindkét eszközön ugyanaz legyen)
function setSyncRoom(room) {
    room = (room || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'makeshift';
    SYNC_ROOM = room;
    localStorage.setItem('sync_room', room);
    if (syncRef) { try { syncRef.off(); } catch (e) {} syncRef = null; }
    syncInit();
}

function init() {
    updateClockDisplay();
    updateUI();

    syncInit(); // felhő-szinkron indítása (ha be van állítva)

    // Szoba-kód mező bekötése
    const syncRoomInput = document.getElementById('syncRoomInput');
    const syncRoomBtn = document.getElementById('syncRoomBtn');
    if (syncRoomInput) syncRoomInput.value = SYNC_ROOM;
    if (syncRoomBtn && syncRoomInput) {
        syncRoomBtn.addEventListener('click', () => setSyncRoom(syncRoomInput.value));
    }

    // A megjegyzett követett csapat visszatöltése az input mezőkbe (frissítés után is látszódjon)
    if (teamNumberInputEl && /^\d+$/.test(trackedTeamQuery)) {
        teamNumberInputEl.value = trackedTeamQuery;
    } else if (teamNameInputEl && trackedTeamQuery) {
        teamNameInputEl.value = trackedTeamQuery;
    }
    if (teamNameInputEl && !teamNameInputEl.value && teamMap[trackedTeamNo]) {
        teamNameInputEl.value = teamMap[trackedTeamNo];
    }

    // Telemetria frissítése 1,75 mp-enként (saját Cloudflare Worker — nincs rate-limit,
    // de a Cloudflare napi 100 000 kérés keret miatt ez a biztonságos ütem több eszközzel
    // is). A telemetryBusy őr megakadályozza, hogy a lekérdezések torlódjanak.
    // SZIMULÁCIÓBAN csak akkor rajzol újra, ha változott a szimulált idő.
    let telemetryBusy = false;
    updateTelemetryUI();
    setInterval(async () => {
        if (isSimulating) {
            if (simTimeMinutes !== lastSimTelemetryMin) {
                lastSimTelemetryMin = simTimeMinutes;
                updateTelemetryUI();
            }
            return;
        }
        if (telemetryBusy) return; // előző lekérdezés még fut → kihagyjuk
        telemetryBusy = true;
        try { await updateTelemetryUI(); } finally { telemetryBusy = false; }
    }, 1750);

    // Óra frissítése másodpercenként
    setInterval(() => {
        updateClockDisplay();
        // Ha nem szimulálunk, akkor az UI-t is frissítjük az idő múlásával
        if (!isSimulating) {
            updateUI();
        }
    }, 1000);
}

// Futtatás betöltéskor
window.addEventListener('DOMContentLoaded', init);

// --- GYORSGOMBOK LOGIKÁJA ---
const customAlertModal = document.getElementById('customAlertModal');
const customAlertBox = document.getElementById('customAlertBox');
const customAlertIconBox = document.getElementById('customAlertIconBox');
const customAlertIcon = document.getElementById('customAlertIcon');
const customAlertTitle = document.getElementById('customAlertTitle');
const customAlertMessage = document.getElementById('customAlertMessage');
const customAlertOkBtn = document.getElementById('customAlertOkBtn');

function showCustomAlert(title, msg, colorVar, iconClass) {
    if (!customAlertModal) return;
    customAlertTitle.textContent = title;
    customAlertTitle.style.color = `var(${colorVar})`;
    customAlertBox.style.borderTopColor = `var(${colorVar})`;
    
    let bgCol = '';
    if (colorVar === '--color-cyan') bgCol = 'rgba(0, 229, 255, 0.15)';
    else if (colorVar === '--color-green') bgCol = 'rgba(0, 230, 118, 0.15)';
    else if (colorVar === '--color-red') bgCol = 'rgba(255, 23, 68, 0.15)';
    else if (colorVar === '--color-orange') bgCol = 'rgba(255, 152, 0, 0.15)';
    
    customAlertIconBox.style.background = bgCol;
    customAlertIconBox.style.color = `var(${colorVar})`;
    customAlertIcon.className = iconClass;
    customAlertMessage.textContent = msg;
    customAlertOkBtn.style.background = `var(${colorVar})`;
    
    customAlertModal.classList.remove('hidden');
}

if (customAlertOkBtn) {
    customAlertOkBtn.addEventListener('click', () => {
        customAlertModal.classList.add('hidden');
    });
}

// Riasztás megjelenítése MINDEN csatlakozott eszközön (a szinkronon keresztül).
// Ha nincs beállítva a szinkron, csak helyben jelenik meg.
let lastAlertTsSeen = 0;
let alertListenerInit = false;
function broadcastAlert(title, msg, colorVar, iconClass) {
    showCustomAlert(title, msg, colorVar, iconClass); // azonnal helyben
    if (typeof syncRef !== 'undefined' && syncRef) {
        const ts = Date.now();
        lastAlertTsSeen = ts; // a saját figyelőnk ne mutassa újra
        syncRef.child('alert').set({ title, msg, colorVar, iconClass, ts }).catch(() => {});
    }
}

const btnQuickSwap = document.getElementById('btnQuickSwap');
if (btnQuickSwap) {
    btnQuickSwap.addEventListener('click', () => {
        broadcastAlert('KORAI CSERE', 'Soron kívüli pilótacsere szükséges! Valami történt a pályán.', '--color-cyan', 'fa-solid fa-rotate');
    });
}

const btnQuickRefuel = document.getElementById('btnQuickRefuel');
if (btnQuickRefuel) {
    btnQuickRefuel.addEventListener('click', () => {
        broadcastAlert('TANKOLÁS', 'Azonnali tankolás szükséges!', '--color-green', 'fa-solid fa-gas-pump');
    });
}

const btnQuickEngine = document.getElementById('btnQuickEngine');
if (btnQuickEngine) {
    btnQuickEngine.addEventListener('click', () => {
        broadcastAlert('MOTORHIBA', 'Műszaki hiba történt! Azonnal a bokszba kell jönni!', '--color-red', 'fa-solid fa-car-burst');
    });
}

const btnQuickHuman = document.getElementById('btnQuickHuman');
if (btnQuickHuman) {
    btnQuickHuman.addEventListener('click', () => {
        broadcastAlert('EMBER HIBA', 'Vezetéstechnikai hiba vagy büntetés!', '--color-orange', 'fa-solid fa-person-falling');
    });
}

// --- WALKIE-TALKIE (HANGÜZENET) ---
// Nyomva tartod a mikrofon gombot → felvesz; elengeded → elküldi a szobának,
// és minden csatlakozott eszközön automatikusan lejátszódik (~1-2 mp késés).
let lastVoiceTsSeen = 0;
let voiceListenerInit = false;
let micStream = null;
let voiceRecorder = null;
let voiceChunks = [];
let voiceRecording = false;
let voicePttHeld = false;
let voiceSendOnStop = false;
let voiceRecStart = 0;
let voiceMaxTimer = null;
let voiceAudioEl = null;
let voiceAudioUnlocked = false;
const VOICE_MAX_MS = 30000;   // max. felvételi hossz (biztonsági önleállás)
const VOICE_MIN_MS = 350;     // ennél rövidebb koppintást eldobunk (véletlen)

// A böngészők blokkolják a hang automatikus lejátszását, amíg nincs
// felhasználói interakció. Az első kattintáskor/érintéskor "feloldjuk".
function unlockVoiceAudio() {
    if (voiceAudioUnlocked) return;
    voiceAudioUnlocked = true;
    try {
        const a = new Audio();
        a.muted = true;
        const p = a.play();
        if (p && p.then) p.then(() => a.pause()).catch(() => {});
    } catch (e) {}
}
window.addEventListener('pointerdown', unlockVoiceAudio, { once: true });
window.addEventListener('touchstart', unlockVoiceAudio, { once: true });
window.addEventListener('keydown', unlockVoiceAudio, { once: true });

function pickVoiceMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const m of cands) { if (MediaRecorder.isTypeSupported(m)) return m; }
    return '';
}

async function ensureMicStream() {
    if (micStream) return micStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('A böngésző nem támogatja a mikrofont.');
    }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return micStream;
}

function setMicButtonRecording(on) {
    const btn = document.getElementById('btnVoicePTT');
    if (btn) btn.classList.toggle('recording', !!on);
}

async function voiceStartRecording() {
    if (voiceRecording) return;
    if (typeof MediaRecorder === 'undefined') {
        showCustomAlert('MIKROFON', 'A böngésző nem támogatja a hangfelvételt (MediaRecorder).', '--color-red', 'fa-solid fa-microphone-slash');
        voicePttHeld = false;
        return;
    }
    let stream;
    try {
        stream = await ensureMicStream();
    } catch (e) {
        console.error('Mikrofon hiba:', e);
        showCustomAlert('MIKROFON', 'Nem sikerült elérni a mikrofont. Engedélyezd a böngészőben a mikrofon-hozzáférést.', '--color-red', 'fa-solid fa-microphone-slash');
        voicePttHeld = false;
        return;
    }
    // Ha közben elengedték a gombot (pl. az engedélykérés alatt), ne indítsunk.
    if (!voicePttHeld) return;

    const mime = pickVoiceMime();
    try {
        voiceRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
        voiceRecorder = new MediaRecorder(stream);
    }
    voiceChunks = [];
    voiceSendOnStop = false;
    voiceRecorder.ondataavailable = ev => { if (ev.data && ev.data.size > 0) voiceChunks.push(ev.data); };
    voiceRecorder.onstop = () => {
        setMicButtonRecording(false);
        const elapsed = Date.now() - voiceRecStart;
        if (!voiceSendOnStop || elapsed < VOICE_MIN_MS || voiceChunks.length === 0) return;
        const blob = new Blob(voiceChunks, { type: (voiceRecorder && voiceRecorder.mimeType) || 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => { voiceBroadcast(reader.result); };
        reader.readAsDataURL(blob);
    };
    voiceRecording = true;
    voiceRecStart = Date.now();
    setMicButtonRecording(true);
    try { voiceRecorder.start(); } catch (e) { voiceRecording = false; setMicButtonRecording(false); return; }
    // Biztonsági önleállás max. hossznál
    if (voiceMaxTimer) clearTimeout(voiceMaxTimer);
    voiceMaxTimer = setTimeout(() => { voiceStopRecording(true); }, VOICE_MAX_MS);
}

function voiceStopRecording(send) {
    if (voiceMaxTimer) { clearTimeout(voiceMaxTimer); voiceMaxTimer = null; }
    if (!voiceRecording) return;
    voiceRecording = false;
    voiceSendOnStop = !!send;
    try { voiceRecorder.stop(); } catch (e) { setMicButtonRecording(false); }
}

function voiceBroadcast(dataUrl) {
    if (!dataUrl) return;
    // RTDB-barát méretkorlát (kb. 30 mp opus bőven belefér ebbe)
    if (dataUrl.length > 900000) {
        showCustomAlert('HANGÜZENET', 'A felvétel túl hosszú lett a küldéshez. Próbáld rövidebben.', '--color-orange', 'fa-solid fa-triangle-exclamation');
        return;
    }
    if (typeof syncRef !== 'undefined' && syncRef) {
        const ts = Date.now();
        lastVoiceTsSeen = ts; // a saját hangunkat ne játsszuk vissza
        syncRef.child('voice').set({ audio: dataUrl, ts }).catch(() => {});
    } else {
        showCustomAlert('HANGÜZENET', 'A szinkron nincs beállítva — a hang nem küldhető el a többi eszközre.', '--color-orange', 'fa-solid fa-triangle-exclamation');
    }
}

let voiceIndicatorTimer = null;
function showVoiceIndicator() {
    const el = document.getElementById('voiceIndicator');
    if (!el) return;
    el.classList.remove('hidden');
    if (voiceIndicatorTimer) clearTimeout(voiceIndicatorTimer);
    voiceIndicatorTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function playIncomingVoice(dataUrl) {
    showVoiceIndicator();
    try {
        if (!voiceAudioEl) voiceAudioEl = new Audio();
        voiceAudioEl.src = dataUrl;
        const p = voiceAudioEl.play();
        if (p && p.catch) p.catch(err => {
            console.warn('Hang lejátszás blokkolva (érintsd meg egyszer az oldalt):', err);
        });
    } catch (e) { console.error('Hang lejátszási hiba:', e); }
}

// Gomb bekötése — NYOMVA TARTÁS (pointer események: egér + érintés egyben)
const btnVoicePTT = document.getElementById('btnVoicePTT');
if (btnVoicePTT) {
    const beginPTT = (e) => {
        e.preventDefault();
        if (voicePttHeld) return;
        try { btnVoicePTT.setPointerCapture(e.pointerId); } catch (_) {}
        voicePttHeld = true;
        voiceStartRecording();
    };
    const endPTT = (e) => {
        if (e) e.preventDefault();
        if (!voicePttHeld) return;
        voicePttHeld = false;
        voiceStopRecording(true);
    };
    btnVoicePTT.addEventListener('pointerdown', beginPTT);
    btnVoicePTT.addEventListener('pointerup', endPTT);
    btnVoicePTT.addEventListener('pointercancel', endPTT);
    btnVoicePTT.addEventListener('contextmenu', e => e.preventDefault());
}

// --- VERSENY VÉGI STATISZTIKA ---
function showEndRaceStats() {
    let allLaps = [];
    const lapsPrefix = `laps_db_${trackedTeamNo}_`;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(lapsPrefix)) {
            try {
                const stored = localStorage.getItem(key);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (parsed.length > allLaps.length) {
                        allLaps = parsed;
                    }
                }
            } catch (e) {}
        }
    }

    let posHistory = [];
    const posPrefix = `pos_history_${trackedTeamNo}_`;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(posPrefix)) {
            try {
                const stored = localStorage.getItem(key);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (parsed.length > posHistory.length) {
                        posHistory = parsed;
                    }
                }
            } catch (e) {}
        }
    }

    const driverStatsMap = {
        'Lackó': { laps: 0, bestSec: Infinity, totalSec: 0, validLaps: 0, posGained: 0 },
        'Zsemle': { laps: 0, bestSec: Infinity, totalSec: 0, validLaps: 0, posGained: 0 },
        'Boldi': { laps: 0, bestSec: Infinity, totalSec: 0, validLaps: 0, posGained: 0 },
        'Beni': { laps: 0, bestSec: Infinity, totalSec: 0, validLaps: 0, posGained: 0 },
        'Egyéb': { laps: 0, bestSec: Infinity, totalSec: 0, validLaps: 0, posGained: 0 }
    };

    allLaps.forEach(lap => {
        const driver = lap.driver || getDriverForAbsMin(lapAbsMin(lap)) || 'Egyéb';
        if (driverStatsMap[driver]) {
            driverStatsMap[driver].laps++;
            const sec = lapTimeToSeconds(lap.lapTime);
            if (sec && !isNaN(sec) && sec !== Infinity) {
                if (sec < driverStatsMap[driver].bestSec) {
                    driverStatsMap[driver].bestSec = sec;
                }
                if (sec >= 50 && sec <= 180) {
                    driverStatsMap[driver].totalSec += sec;
                    driverStatsMap[driver].validLaps++;
                }
            }
        }
    });

    for (let i = 1; i < posHistory.length; i++) {
        const prevPos = parseInt(posHistory[i-1].pos);
        const currPos = parseInt(posHistory[i].pos);
        if (!isNaN(prevPos) && !isNaN(currPos)) {
            const posChange = prevPos - currPos;
            const d = new Date(posHistory[i].time);
            const driver = getDriverForAbsMin(dateToAbsMin(d)) || 'Egyéb';
            if (driverStatsMap[driver] && posChange > 0) {
                driverStatsMap[driver].posGained += posChange;
            }
        }
    }

    let bestLapDriver = '-';
    let bestLapTime = Infinity;
    let mostLapsDriver = '-';
    let mostLaps = 0;
    let bestAvgDriver = '-';
    let bestAvgTime = Infinity;
    let mostPosDriver = '-';
    let mostPosGained = 0;

    for (const [driver, stats] of Object.entries(driverStatsMap)) {
        if (driver === 'Egyéb') continue;
        if (stats.bestSec < bestLapTime) {
            bestLapTime = stats.bestSec;
            bestLapDriver = driver;
        }
        if (stats.laps > mostLaps) {
            mostLaps = stats.laps;
            mostLapsDriver = driver;
        }
        const avg = stats.validLaps > 0 ? stats.totalSec / stats.validLaps : Infinity;
        if (avg < bestAvgTime && stats.validLaps >= 3) {
            bestAvgTime = avg;
            bestAvgDriver = driver;
        }
        if (stats.posGained > mostPosGained) {
            mostPosGained = stats.posGained;
            mostPosDriver = driver;
        }
    }

    const formatTime = (sec) => sec === Infinity ? '--:--.---' : secondsToLapTime(sec);

    // Végső helyezés kiszámítása
    let finalPos = '-';
    if (posHistory.length > 0) {
        finalPos = posHistory[posHistory.length - 1].pos;
    }

    // MVP kiszámítása kategóriagyőzelmek alapján
    let mvpScores = {};
    if (bestLapDriver !== '-') mvpScores[bestLapDriver] = (mvpScores[bestLapDriver] || 0) + 1;
    if (mostLapsDriver !== '-') mvpScores[mostLapsDriver] = (mvpScores[mostLapsDriver] || 0) + 1;
    if (bestAvgDriver !== '-') mvpScores[bestAvgDriver] = (mvpScores[bestAvgDriver] || 0) + 1;
    if (mostPosDriver !== '-') mvpScores[mostPosDriver] = (mvpScores[mostPosDriver] || 0) + 1;
    
    // Extra súlyozás a pozíciószerzésnek és a jó átlagnak döntetlen esetére
    if (mostPosDriver !== '-') mvpScores[mostPosDriver] += 0.5;
    if (bestAvgDriver !== '-') mvpScores[bestAvgDriver] += 0.5;

    let mvpDriver = '-';
    let maxMvpScore = -1;
    for (const [driver, score] of Object.entries(mvpScores)) {
        if (score > maxMvpScore) {
            maxMvpScore = score;
            mvpDriver = driver;
        }
    }

    const contentEl = document.getElementById('endRaceStatsContent');
    if (contentEl) {
        contentEl.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 20px; background: rgba(255, 215, 0, 0.1); padding: 15px; border-radius: 8px; border: 1px solid var(--color-gold);">
                <div style="text-align: center; flex: 1; border-right: 1px solid rgba(255,255,255,0.1);">
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Végső Helyezés</div>
                    <div style="font-size: 2.2rem; font-weight: bold; color: var(--color-gold); margin-top: 5px;">${finalPos}.</div>
                </div>
                <div style="text-align: center; flex: 1;">
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">A Futam MVP-je 👑</div>
                    <div style="font-size: 2.2rem; font-weight: bold; color: #fff; margin-top: 5px;">${mvpDriver}</div>
                </div>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; border-left: 4px solid var(--color-purple);">
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Legjobb köridő</div>
                    <div style="font-size: 1.4rem; font-weight: bold; margin: 5px 0;">${bestLapDriver}</div>
                    <div style="color: var(--color-cyan); font-family: monospace; font-size: 1.1rem;">${formatTime(bestLapTime)}</div>
                </div>
                
                <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; border-left: 4px solid var(--color-gold);">
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Legtöbb kör</div>
                    <div style="font-size: 1.4rem; font-weight: bold; margin: 5px 0;">${mostLapsDriver}</div>
                    <div style="color: var(--color-gold); font-size: 1.1rem;">${mostLaps} kör</div>
                </div>
                
                <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; border-left: 4px solid var(--color-green);">
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Legtöbb pozíciószerzés</div>
                    <div style="font-size: 1.4rem; font-weight: bold; margin: 5px 0;">${mostPosDriver}</div>
                    <div style="color: var(--color-green); font-size: 1.1rem;">+${mostPosGained} hely</div>
                </div>
                
                <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; border-left: 4px solid var(--color-pink);">
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">Legjobb átlag (50s-3m)</div>
                    <div style="font-size: 1.4rem; font-weight: bold; margin: 5px 0;">${bestAvgDriver}</div>
                    <div style="color: var(--color-pink); font-family: monospace; font-size: 1.1rem;">${formatTime(bestAvgTime)}</div>
                </div>
            </div>
        `;
    }

    const endRaceModal = document.getElementById('endRaceModal');
    if (endRaceModal) endRaceModal.classList.remove('hidden');
}

const closeEndRaceBtn = document.getElementById('closeEndRaceBtn');
if (closeEndRaceBtn) {
    closeEndRaceBtn.addEventListener('click', () => {
        document.getElementById('endRaceModal').classList.add('hidden');
    });
}

// ============================================================================
//  TERVEZŐ FÜL — beosztás és esemény-időpontok szerkesztése
// ============================================================================

const plannerTableBodyEl = document.getElementById('plannerTableBody');
const planDateEl = document.getElementById('planDate');
const planQualyStartEl = document.getElementById('planQualyStart');
const planRaceStartEl = document.getElementById('planRaceStart');
const planRaceEndEl = document.getElementById('planRaceEnd');
const planRaceEndDateEl = document.getElementById('planRaceEndDate');
const planEveningStartEl = document.getElementById('planEveningStart');
const planEveningEndEl = document.getElementById('planEveningEnd');
const plannerAddBtnEl = document.getElementById('plannerAddBtn');
const plannerSaveBtnEl = document.getElementById('plannerSaveBtn');
const plannerResetBtnEl = document.getElementById('plannerResetBtn');
const plannerSummaryEl = document.getElementById('plannerSummary');
const plannerWarningEl = document.getElementById('plannerWarning');
const plannerDurationNoteEl = document.getElementById('plannerDurationNote');

let plannerDraft = null; // munkapéldány (mentésig nem él élesben)

function clonePlan(p) { return JSON.parse(JSON.stringify(p)); }
function dateFieldToInput(dObj) {
    if (!dObj) return '';
    return `${dObj.year}-${String(dObj.month + 1).padStart(2, '0')}-${String(dObj.day).padStart(2, '0')}`;
}
function inputToDateField(val) {
    if (!val) return null;
    const [y, m, d] = val.split('-').map(Number);
    return { year: y, month: m - 1, day: d };
}

// Az esemény-időpont mezők feltöltése a munkapéldányból
function fillPlannerForm() {
    if (!plannerDraft) return;
    if (planDateEl) planDateEl.value = dateFieldToInput(plannerDraft.date);
    if (planRaceEndDateEl) planRaceEndDateEl.value = dateFieldToInput(plannerDraft.endDate || plannerDraft.date);
    if (planQualyStartEl) planQualyStartEl.value = plannerDraft.qualyStart;
    if (planRaceStartEl) planRaceStartEl.value = plannerDraft.raceStart;
    if (planRaceEndEl) planRaceEndEl.value = plannerDraft.raceEnd;
    if (planEveningStartEl) planEveningStartEl.value = plannerDraft.eveningStart || '20:00';
    if (planEveningEndEl) planEveningEndEl.value = plannerDraft.eveningEnd || '06:00';
}

// A Tervező fül megnyitása: friss munkapéldány + űrlap feltöltése
function openPlanner() {
    plannerDraft = clonePlan(plan);
    fillPlannerForm();
    renderPlannerRows();
}

function renderPlannerRows() {
    if (!plannerTableBodyEl || !plannerDraft) return;
    plannerTableBodyEl.innerHTML = '';

    plannerDraft.stints.forEach((stint, idx) => {
        const tr = document.createElement('tr');

        const options = DRIVERS.map(dr => `<option value="${dr}" ${dr === stint.driver ? 'selected' : ''}>${dr}</option>`).join('');
        const lenMin = stintDurationMin(stint); // éjfél-átlépésnél is helyes
        const lenStr = (isNaN(lenMin) || lenMin <= 0) ? '--' : `${lenMin} p`;

        tr.innerHTML = `
            <td style="color: var(--text-muted); font-weight: 700;">${idx + 1}</td>
            <td><select class="pl-driver" data-idx="${idx}">${options}</select></td>
            <td><input type="time" class="pl-start" data-idx="${idx}" value="${stint.start}"></td>
            <td><input type="time" class="pl-end" data-idx="${idx}" value="${stint.end}"></td>
            <td style="text-align: right;"><span class="planner-len">${lenStr}</span></td>
            <td style="text-align: right; white-space: nowrap;">
                <button class="planner-row-btn pl-up" data-idx="${idx}" title="Feljebb" ${idx === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                <button class="planner-row-btn pl-down" data-idx="${idx}" title="Lejjebb" ${idx === plannerDraft.stints.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                <button class="planner-row-btn danger pl-del" data-idx="${idx}" title="Törlés"><i class="fa-solid fa-trash"></i></button>
            </td>
        `;
        plannerTableBodyEl.appendChild(tr);
    });

    // Sor-események
    plannerTableBodyEl.querySelectorAll('.pl-driver').forEach(el => {
        el.addEventListener('change', e => { plannerDraft.stints[+e.target.dataset.idx].driver = e.target.value; updatePlannerSummary(); });
    });
    plannerTableBodyEl.querySelectorAll('.pl-start').forEach(el => {
        el.addEventListener('change', e => { plannerDraft.stints[+e.target.dataset.idx].start = e.target.value; renderPlannerRows(); });
    });
    plannerTableBodyEl.querySelectorAll('.pl-end').forEach(el => {
        el.addEventListener('change', e => { plannerDraft.stints[+e.target.dataset.idx].end = e.target.value; renderPlannerRows(); });
    });
    plannerTableBodyEl.querySelectorAll('.pl-up').forEach(el => {
        el.addEventListener('click', e => { const i = +e.currentTarget.dataset.idx; if (i > 0) { [plannerDraft.stints[i - 1], plannerDraft.stints[i]] = [plannerDraft.stints[i], plannerDraft.stints[i - 1]]; renderPlannerRows(); } });
    });
    plannerTableBodyEl.querySelectorAll('.pl-down').forEach(el => {
        el.addEventListener('click', e => { const i = +e.currentTarget.dataset.idx; if (i < plannerDraft.stints.length - 1) { [plannerDraft.stints[i + 1], plannerDraft.stints[i]] = [plannerDraft.stints[i], plannerDraft.stints[i + 1]]; renderPlannerRows(); } });
    });
    plannerTableBodyEl.querySelectorAll('.pl-del').forEach(el => {
        el.addEventListener('click', e => { const i = +e.currentTarget.dataset.idx; plannerDraft.stints.splice(i, 1); renderPlannerRows(); });
    });

    updatePlannerSummary();
}

// Összegzés: pilótánkénti tervezett összidő + a beosztás lefedettsége
function updatePlannerSummary() {
    if (!plannerSummaryEl || !plannerDraft) return;

    const totals = {};
    DRIVERS.forEach(d => { totals[d] = 0; });
    let sum = 0;
    plannerDraft.stints.forEach(s => {
        const len = stintDurationMin(s);
        if (!isNaN(len) && len > 0) {
            totals[s.driver] = (totals[s.driver] || 0) + len;
            sum += len;
        }
    });
    plannerSummaryEl.innerHTML = DRIVERS.map(d => `${d}: <strong style="color:var(--text-primary);">${totals[d]} p</strong>`).join(' &nbsp;•&nbsp; ') + ` &nbsp;|&nbsp; Összesen: <strong style="color:var(--color-cyan);">${sum} p</strong>`;

    // Verseny ablak a vég-dátummal (24h esetén a következő napig)
    let windowMin = null;
    const rs = planRaceStartEl && planRaceStartEl.value;
    const re = planRaceEndEl && planRaceEndEl.value;
    if (rs && re) {
        const startD = inputToDateField(planDateEl && planDateEl.value) || plannerDraft.date;
        const endD = inputToDateField(planRaceEndDateEl && planRaceEndDateEl.value) || startD;
        const offset = Math.round((new Date(endD.year, endD.month, endD.day) - new Date(startD.year, startD.month, startD.day)) / 86400000);
        windowMin = offset * 1440 + timeStringToMinutes(re) - timeStringToMinutes(rs);
    }
    if (plannerDurationNoteEl) {
        plannerDurationNoteEl.textContent = (windowMin != null && windowMin > 0)
            ? `Verseny hossza: ${Math.floor(windowMin / 60)} ó ${windowMin % 60} p`
            : '';
    }

    // Figyelmeztetések (nem blokkolók)
    const warnings = [];
    if (windowMin != null && windowMin > 0 && sum !== windowMin) {
        warnings.push(`A beosztás összhossza (${sum} p) eltér a verseny ablakától (${windowMin} p). A rendszer arányosan igazít.`);
    }
    for (let i = 1; i < plannerDraft.stints.length; i++) {
        if (plannerDraft.stints[i].start !== plannerDraft.stints[i - 1].end) {
            warnings.push('Az etapok nem folytonosak (egyik vége ≠ következő kezdete).');
            break;
        }
    }
    if (plannerWarningEl) {
        if (warnings.length) {
            plannerWarningEl.style.display = 'block';
            plannerWarningEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ' + warnings.join('<br><i class="fa-solid fa-triangle-exclamation"></i> ');
        } else {
            plannerWarningEl.style.display = 'none';
        }
    }
}

// Új etap hozzáadása (az előző végéhez igazítva)
if (plannerAddBtnEl) {
    plannerAddBtnEl.addEventListener('click', () => {
        if (!plannerDraft) openPlanner();
        const last = plannerDraft.stints[plannerDraft.stints.length - 1];
        const start = last ? last.end : (planRaceStartEl.value || plannerDraft.raceStart);
        const end = fmtClock(timeStringToMinutes(start) + 40); // +40 perc, éjfél átfordulással
        plannerDraft.stints.push({ driver: DRIVERS[0], start, end });
        renderPlannerRows();
    });
}

// --- AUTOMATIKUS BEOSZTÁS-GENERÁTOR ---
const genStintLenEl = document.getElementById('genStintLen');
const genOrderEl = document.getElementById('genOrder');
const genApplyBtnEl = document.getElementById('genApplyBtn');
const genNoteEl = document.getElementById('genNote');

// A versenyablak hossza percben a jelenlegi mezőkből (vég-dátummal, 24h-ra is)
function plannerWindowMin() {
    const rs = (planRaceStartEl && planRaceStartEl.value) || plannerDraft.raceStart;
    const re = (planRaceEndEl && planRaceEndEl.value) || plannerDraft.raceEnd;
    const startD = inputToDateField(planDateEl && planDateEl.value) || plannerDraft.date;
    const endD = inputToDateField(planRaceEndDateEl && planRaceEndDateEl.value) || startD;
    const offset = Math.round((new Date(endD.year, endD.month, endD.day) - new Date(startD.year, startD.month, startD.day)) / 86400000);
    return offset * 1440 + timeStringToMinutes(re) - timeStringToMinutes(rs);
}

// Beosztás automatikus kiosztása: az etap-hosszból + versenyablakból számolt
// számú etap, a megadott pilóta-sorrendet körbejárva, a rajtidőtől kezdve.
function generatePlan() {
    if (!plannerDraft) openPlanner();

    const len = parseInt(genStintLenEl && genStintLenEl.value);
    if (!len || len <= 0) {
        showCustomAlert('TERVEZŐ', 'Adj meg érvényes etap-hosszt (perc).', '--color-gold', 'fa-solid fa-triangle-exclamation');
        return;
    }

    // Sorrend feldolgozása + validálás (kis-nagybetű független)
    const order = (genOrderEl.value || '')
        .split(',').map(s => s.trim()).filter(Boolean)
        .map(s => DRIVERS.find(d => d.toLowerCase() === s.toLowerCase()) || s)
        .filter(d => DRIVERS.includes(d));
    if (!order.length) {
        showCustomAlert('TERVEZŐ', `A sorrendben nincs érvényes pilóta. Használható nevek: ${DRIVERS.join(', ')}.`, '--color-gold', 'fa-solid fa-triangle-exclamation');
        return;
    }

    const rsStr = (planRaceStartEl && planRaceStartEl.value) || plannerDraft.raceStart;
    const startAbs = timeStringToMinutes(rsStr);
    const windowMin = plannerWindowMin();
    if (!windowMin || windowMin <= 0) {
        showCustomAlert('TERVEZŐ', 'Előbb állítsd be a verseny kezdetét és végét (a vég lehet a következő nap is).', '--color-gold', 'fa-solid fa-triangle-exclamation');
        return;
    }

    const endAbs = startAbs + windowMin;
    const stints = [];
    let curAbs = startAbs, i = 0, guard = 0;
    while (curAbs < endAbs && guard++ < 500) {
        const segLen = Math.min(len, endAbs - curAbs);
        stints.push({ driver: order[i % order.length], start: fmtClock(curAbs), end: fmtClock(curAbs + segLen) });
        curAbs += segLen;
        i++;
    }
    plannerDraft.stints = stints;
    renderPlannerRows();

    if (genNoteEl) {
        const full = Math.floor(windowMin / len);
        const rem = windowMin - full * len;
        genNoteEl.textContent = `${stints.length} etap generálva (${full}×${len} p${rem > 0 ? ` + 1×${rem} p` : ''}).`;
    }
}
if (genApplyBtnEl) genApplyBtnEl.addEventListener('click', generatePlan);

// Terv mentése (validálás + élesítés)
if (plannerSaveBtnEl) {
    plannerSaveBtnEl.addEventListener('click', () => {
        if (!plannerDraft) return;

        // Esemény-időpontok beolvasása
        if (planDateEl && planDateEl.value) plannerDraft.date = inputToDateField(planDateEl.value);
        if (planRaceEndDateEl && planRaceEndDateEl.value) plannerDraft.endDate = inputToDateField(planRaceEndDateEl.value);
        else plannerDraft.endDate = plannerDraft.date; // ha nincs vég-dátum, ugyanaz a nap
        if (planQualyStartEl) plannerDraft.qualyStart = planQualyStartEl.value || plannerDraft.qualyStart;
        if (planRaceStartEl) plannerDraft.raceStart = planRaceStartEl.value || plannerDraft.raceStart;
        if (planRaceEndEl) plannerDraft.raceEnd = planRaceEndEl.value || plannerDraft.raceEnd;
        if (planEveningStartEl) plannerDraft.eveningStart = planEveningStartEl.value || plannerDraft.eveningStart;
        if (planEveningEndEl) plannerDraft.eveningEnd = planEveningEndEl.value || plannerDraft.eveningEnd;

        // Kemény validálás
        if (!plannerDraft.stints.length) {
            showCustomAlert('TERVEZŐ', 'Legalább egy etapot meg kell adni.', '--color-gold', 'fa-solid fa-triangle-exclamation');
            return;
        }
        // Verseny vége abszolút perc a vég-dátummal
        const sd = plannerDraft.date, ed = plannerDraft.endDate;
        const dayOffset = Math.round((new Date(ed.year, ed.month, ed.day) - new Date(sd.year, sd.month, sd.day)) / 86400000);
        const endAbs = dayOffset * 1440 + timeStringToMinutes(plannerDraft.raceEnd);
        if (endAbs <= timeStringToMinutes(plannerDraft.raceStart)) {
            showCustomAlert('TERVEZŐ', 'A verseny vége (a nappal együtt) nem lehet korábbi a kezdeténél. 24h esetén add meg a következő napot!', '--color-gold', 'fa-solid fa-triangle-exclamation');
            return;
        }
        for (const s of plannerDraft.stints) {
            if (!s.driver || stintDurationMin(s) <= 0) {
                showCustomAlert('TERVEZŐ', 'Minden etapnál a vége térjen el a kezdéstől, és legyen kiválasztva versenyző.', '--color-gold', 'fa-solid fa-triangle-exclamation');
                return;
            }
        }

        // Élesítés
        plan = clonePlan(plannerDraft);
        savePlan();
        rebuildPlanDerived();
        invalidateTimeline();
        updateUI();
        updateClockDisplay();
        updateTelemetryUI();

        showCustomAlert('TERVEZŐ', 'A terv elmentve és aktiválva! A beosztás és a "Csere most" rendszer mostantól ezt használja.', '--color-green', 'fa-solid fa-circle-check');
    });
}

// Alaphelyzet (az alapértelmezett tervre — mentésig nem él)
if (plannerResetBtnEl) {
    plannerResetBtnEl.addEventListener('click', () => {
        plannerDraft = clonePlan(DEFAULT_PLAN);
        openPlannerFromDraft();
    });
}

// A munkapéldányból tölti fel az űrlapot (Alaphelyzet után)
function openPlannerFromDraft() {
    fillPlannerForm();
    renderPlannerRows();
}

// Az esemény-időpont mezők élő összegzés-frissítése
[planRaceStartEl, planRaceEndEl, planRaceEndDateEl, planDateEl].forEach(el => {
    if (el) el.addEventListener('change', updatePlannerSummary);
});
