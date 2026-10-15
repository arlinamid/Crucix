// Deterministic baseline using the existing cross-domain rules, with optional sources.
import { normalizeIdeas } from './idea-schema.mjs';
import { generateLLMIdeas } from './ideas.mjs';

const list = value => Array.isArray(value) ? value : [];
const isNum = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => isNum(value) ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;

export function generateRuleBasedIdeas(data, language = 'en') {
  if (!data || typeof data !== 'object') return [];
  const hu = language === 'hu';
  const fred = list(data.fred), bls = list(data.bls), thermal = list(data.thermal);
  const urgent = list(data.tg?.urgent), energy = data.energy || {};
  const prices = list(energy.wtiRecent);
  const latest = prices[0], oldest = prices.at(-1);
  const validPrices = prices.length > 1 && isNum(latest) && isNum(oldest) && oldest > 0;
  const vix = fred.find(f => f?.id === 'VIXCLS')?.value;
  const hy = fred.find(f => f?.id === 'BAMLH0A0HYM2')?.value;
  const spread = fred.find(f => f?.id === 'T10Y2Y')?.value;
  const totalThermal = thermal.reduce((sum, t) => sum + (isNum(t?.det) && t.det > 0 ? t.det : 0), 0);
  const ideas = [];
  const add = (title, titleHu, text, textHu, type, confidence, horizon, ticker, signals) => ideas.push({
    title: hu ? titleHu : title, text: hu ? textHu : text, type, confidence, horizon, ticker, signals,
    risk: hu ? 'Jelzésalapú megfigyelés; az adatok lehetnek késleltetettek. Ellenőrizd más forrásokkal.'
      : 'Signal-based observation; data may be delayed. Corroborate with independent sources.',
  });

  if (urgent.length > 3 && isNum(energy.wti) && energy.wti > 68) {
    add('Conflict-Energy Nexus Active', 'Konfliktus és energiaár összefüggése',
      `${urgent.length} urgent OSINT signals with WTI at $${energy.wti}. Watch whether geopolitical risk transmits to energy prices.`,
      `${urgent.length} sürgős OSINT-jelzés, WTI: $${energy.wti}. Figyeld, megjelenik-e a geopolitikai kockázat az energiaárakban.`,
      'LONG', 'MEDIUM', 'Weeks', 'USO', [`urgent_posts=${urgent.length}`, `WTI=${energy.wti}`]);
  }
  if (isNum(vix) && vix > 20) {
    add('Elevated Volatility Regime', 'Megemelkedett piaci volatilitás',
      `VIX at ${vix}. Review short-term portfolio hedges and exposure.`,
      `VIX: ${vix}. Érdemes áttekinteni a rövid távú fedezeteket és a kitettséget.`,
      'HEDGE', vix > 25 ? 'HIGH' : 'MEDIUM', 'Days', 'SPY', [`VIX=${vix}`]);
  }
  if (isNum(vix) && vix > 20 && isNum(hy) && hy > 3) {
    add('Safe Haven Demand Rising', 'Erősödő menedékeszköz-jelzés',
      `VIX ${vix} and high-yield spread ${hy}% indicate risk-off pressure across two market indicators.`,
      `VIX: ${vix}, magas hozamú kötvények felára: ${hy}%. Két piaci mutató jelez kockázatkerülést.`,
      'HEDGE', 'MEDIUM', 'Days', 'GLD', [`VIX=${vix}`, `HY_SPREAD=${hy}`]);
  }
  if (validPrices) {
    const pct = (latest - oldest) / oldest * 100;
    if (Number.isFinite(pct) && Math.abs(pct) > 3) {
      const change = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
      add(pct > 0 ? 'Oil Momentum Building' : 'Oil Under Pressure', pct > 0 ? 'Erősödő olajár-lendület' : 'Nyomás alatt az olajár',
        `WTI moved ${change} recently to $${latest}/bbl. Confirm whether the move reflects supply risk or demand changes.`,
        `A WTI változása ${change}, legutóbbi ára $${latest}/hordó. Ellenőrizd a kínálati és keresleti háttér okait.`,
        pct > 0 ? 'LONG' : 'WATCH', 'MEDIUM', 'Weeks', 'USO', [`WTI_CHANGE=${change}`]);
    }
  }
  if (isNum(spread)) {
    const label = spread > 0 ? 'Yield Curve Normalizing' : spread < 0 ? 'Yield Curve Inverted' : 'Flat Yield Curve';
    const labelHu = spread > 0 ? 'Normalizálódó hozamgörbe' : spread < 0 ? 'Fordított hozamgörbe' : 'Lapos hozamgörbe';
    add(label, labelHu, `10Y–2Y spread is ${spread.toFixed(2)} percentage points. Monitor the curve together with labor and inflation data.`,
      `A 10 és 2 éves hozam különbsége ${spread.toFixed(2)} százalékpont. Figyeld a munkaerőpiaci és inflációs adatokkal együtt.`,
      'WATCH', 'MEDIUM', 'Months', 'TLT', [`T10Y2Y=${spread}`]);
  }
  const debt = amount(data.treasury?.totalDebt);
  if (debt !== null && debt > 35e12) {
    add('Fiscal Trajectory and Hard Assets', 'Államadósság és reáleszközök',
      `US national debt is $${(debt / 1e12).toFixed(1)}T. Track fiscal conditions and real yields; debt alone does not predict asset returns.`,
      `Az USA államadóssága ${(debt / 1e12).toFixed(1)} billió dollár. Figyeld a költségvetést és a reálhozamokat; az adósság önmagában nem jelzi az eszközhozamokat.`,
      'WATCH', 'LOW', 'Months', 'GLD', [`US_DEBT=${debt}`]);
  }
  if (totalThermal > 30000 && urgent.length > 2) {
    add('Thermal Activity and OSINT Elevated', 'Hőészlelés és OSINT-aktivitás emelkedése',
      `${totalThermal.toLocaleString('en-US')} thermal detections and ${urgent.length} urgent OSINT posts. Thermal data also includes civilian fires; corroboration is required.`,
      `${totalThermal.toLocaleString('hu-HU')} hőészlelés és ${urgent.length} sürgős OSINT-bejegyzés. A hőadatok civil tüzeket is tartalmaznak; további megerősítés szükséges.`,
      'WATCH', 'MEDIUM', 'Weeks', 'ITA', [`THERMAL=${totalThermal}`, `URGENT_POSTS=${urgent.length}`]);
  }
  const unemployment = bls.find(b => ['LNS14000000', 'UNRATE'].includes(b?.id))?.value;
  const payrolls = bls.find(b => ['CES0000000001', 'PAYEMS'].includes(b?.id));
  if (isNum(spread) && isNum(unemployment) && payrolls && spread > 0.3 && (unemployment > 4.3 || (isNum(payrolls.momChange) && payrolls.momChange < -50))) {
    add('Steepening Curve Meets Weak Labor', 'Meredekebb hozamgörbe, gyengülő munkaerőpiac',
      `10Y–2Y at ${spread.toFixed(2)} and unemployment ${unemployment}% warrant closer scrutiny of growth risk.`,
      `10Y–2Y: ${spread.toFixed(2)}, munkanélküliség: ${unemployment}%. A növekedési kockázat alaposabb vizsgálatot indokol.`,
      'HEDGE', 'HIGH', 'Days', 'SPY', [`T10Y2Y=${spread}`, `UNEMPLOYMENT=${unemployment}`]);
  }
  if (isNum(data.acled?.totalEvents) && data.acled.totalEvents > 50 && validPrices && latest - oldest > 2) {
    add('Conflict Fueling Energy Momentum', 'Konfliktusjelzés és emelkedő olajár',
      `${data.acled.totalEvents} ACLED events and WTI up $${(latest - oldest).toFixed(1)}. Check regional transmission to energy supply.`,
      `${data.acled.totalEvents} ACLED-esemény és $${(latest - oldest).toFixed(1)} WTI-emelkedés. Ellenőrizd az energiakínálatra gyakorolt regionális hatást.`,
      'LONG', 'MEDIUM', 'Weeks', 'USO', [`ACLED_EVENTS=${data.acled.totalEvents}`, `WTI_MOVE=${(latest - oldest).toFixed(1)}`]);
  }
  if (isNum(data.acled?.totalFatalities) && data.acled.totalFatalities > 500 && totalThermal > 20000) {
    add('Defense Procurement Watch', 'Védelmi beszerzések figyelése',
      `${data.acled.totalFatalities} conflict fatalities and elevated thermal activity. Watch confirmed procurement announcements rather than inferring orders from activity alone.`,
      `${data.acled.totalFatalities} konfliktushoz köthető haláleset és magas hőaktivitás. Figyeld a tényleges beszerzési bejelentéseket; az aktivitás önmagában nem bizonyít megrendelést.`,
      'WATCH', 'MEDIUM', 'Weeks', 'ITA', [`ACLED_FATALITIES=${data.acled.totalFatalities}`, `THERMAL=${totalThermal}`]);
  }
  if (isNum(hy) && isNum(vix) && ((hy > 3.5 && vix < 18) || (hy < 2.5 && vix > 25))) {
    const creditStress = hy > 3.5;
    add(creditStress ? 'Credit Stress and Calm Equity Volatility' : 'Equity Fear Exceeds Credit Stress',
      creditStress ? 'Hitelpiaci stressz, nyugodt részvénypiac' : 'Részvénypiaci félelem, mérsékelt hitelfelár',
      `High-yield spread ${hy.toFixed(1)}% and VIX ${vix.toFixed(0)} diverge. Monitor whether both markets confirm the same risk regime.`,
      `A ${hy.toFixed(1)}%-os hitelfelár és a ${vix.toFixed(0)} VIX eltérő képet mutat. Figyeld a két piac megerősítő vagy ellentétes jelzéseit.`,
      'WATCH', 'MEDIUM', 'Days', 'HYG', [`HY_SPREAD=${hy}`, `VIX=${vix}`]);
  }
  const ppi = bls.find(b => ['WPUFD49104', 'PCU--PCU--'].includes(b?.id));
  const cpi = bls.find(b => ['CUUR0000SA0', 'CPIAUCSL'].includes(b?.id));
  if (cpi && isNum(ppi?.momChangePct) && ppi.momChangePct > 0.3 && isNum(data.gscpi?.value) && data.gscpi.value > 0.5) {
    add('Inflation Pipeline Pressure', 'Erősödő inflációs költségnyomás',
      `GSCPI ${data.gscpi.value.toFixed(2)} and PPI momentum +${ppi.momChangePct.toFixed(1)}%. Watch whether input costs pass through to consumer inflation.`,
      `GSCPI: ${data.gscpi.value.toFixed(2)}, PPI-változás: +${ppi.momChangePct.toFixed(1)}%. Figyeld a költségek fogyasztói árakba történő átgyűrűzését.`,
      'WATCH', 'MEDIUM', 'Months', 'TIP', [`GSCPI=${data.gscpi.value}`, `PPI_CHANGE=${ppi.momChangePct}`]);
  }
  return normalizeIdeas(ideas, { source: 'rules' });
}

export async function resolveIdeas(provider, data, delta = null, previousIdeas = [], language = 'en', stats = null) {
  try {
    const ideas = await generateLLMIdeas(provider, data, delta, previousIdeas, language, stats);
    if (ideas?.length) return { ideas, ideasSource: 'llm' };
  } catch (err) {
    console.warn('[Ideas] Provider unavailable, using rules:', err.message);
  }
  return { ideas: generateRuleBasedIdeas(data, language), ideasSource: 'rules' };
}
