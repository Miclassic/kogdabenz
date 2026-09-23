// ===== Сборщик Новороссийска (v5: РАБОЧАЯ ОСНОВА + очереди + донор волна 1) =====
// Основа — проверенный код с "паспортом браузера" и повторами. НЕ ЛОМАТЬ.
// Комментарии не парсим: у GdeBenz нет открытого API комментариев (Этап 1).
// Волна 1: донор Кубань+Адыгея — наблюдения хранятся экономно (смена статуса
// или heartbeat раз в 1 час); события доноров питают бренд-пулы и эпизоды
// k-NN; сайт и дайджест видят только город (вьюха city_events).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Широкая рамка: Новороссийск + Геленджик + Анапа + Крымск (≈200 км)
// Сбор идёт широко, а на сайте показываем только новороссийские карточки.
const GDEBENZ_URL = 'https://gdebenz.ru/api/stations?lat1=44.40&lon1=37.20&lat2=45.20&lon2=38.60';
// Донорские рамки волны 1 (метка региона пишется в stations.region)
const DONOR_FRAMES = [
  { region: 'kuban', url: 'https://gdebenz.ru/api/stations?lat1=43.30&lon1=38.60&lat2=46.00&lon2=41.00' }
];

// "Паспорт браузера", чтобы сайт принимал нас за обычного посетителя
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  'Referer': 'https://gdebenz.ru/'
};

async function fetchFrame(url, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      r = await fetch(url, { headers: BROWSER_HEADERS });
    } catch (netErr) {
      // сетевая ошибка (таймаут/DNS/сброс): источник не досягаем — не мучаем ретраями
      const e = new Error(label + ': сеть не пустила (' + netErr.message + ')');
      e.upstream = true;
      throw e;
    }
    if (r.ok) return r.json();
    // 429/503 — источник throttling'ует или под атакой: выходим сразу, без ретраев
    if (r.status === 429 || r.status === 503) {
      const e = new Error(label + ': статус ' + r.status + ' (похоже на DDoS или защиту)');
      e.upstream = true;
      throw e;
    }
    console.log('   ' + label + ': попытка ' + attempt + ': статус ' + r.status + ', жду 10 сек и повторю...');
    await new Promise(res => setTimeout(res, 10000));
  }
  const e = new Error(label + ': не ответил после 3 попыток');
  e.upstream = true;
  throw e;
}
async function fetchGdebenz() { return fetchFrame(GDEBENZ_URL, 'GdeBenz (Новороссийск)'); }

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status + ' ' + await r.text());
  return r.json();
}

async function sbPost(path, rows, prefer) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error('POST ' + path + ' → ' + r.status + ' ' + await r.text());
  return (prefer || '').includes('representation') ? r.json() : null;
}

async function sbPatch(path, row) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('PATCH ' + path + ' → ' + r.status + ' ' + await r.text());
}

function eventNameRu(t) {
  return {
    fuel_restored: '🟢 бензин вернулся',
    fuel_disappeared: '🔴 бензин закончился',
    queue_appeared: '🚗 появилась очередь',
    queue_gone: '🚗 очередь рассосалась',
    possible_delivery: '🚛 похоже, привезли',
    fuel_unavailable: '🔴 сообщают: топлива нет',
    fuel_available: '⛽ сообщают: топливо было',
    queue_high: '🚗 сообщают: большая очередь',
    queue_low: '🟢 сообщают: свободно'
  }[t] || ('❓ ' + t);
}
// Живая лента: у каждого события — смысл для водителя, а не голая констатация.
// Варианты чередуются, чтобы лента не выглядела штампом.
const STORY_VARIANTS = {
  fuel_restored: ['🟢 {n}: {f} вернулся'],
  fuel_disappeared: ['🔴 {n}: {f} кончился'],
  queue_appeared: ['🚗 {n}: очередь'],
  queue_gone: ['🚗 {n}: очередь рассосалась'],
  possible_delivery: ['🚛 {n}: привезли'],
  fuel_unavailable: ['🔴 {n}: нет {f} (народ)'],
  fuel_available: ['⛽ {n}: есть {f} (народ)'],
  queue_high: ['🚗 {n}: большая очередь (народ)'],
  queue_low: ['🟢 {n}: свободно (народ)']
};
function eventStoryRu(e, name) {
  const vars = STORY_VARIANTS[e.event_type];
  if (!vars) return eventNameRu(e.event_type) + ' — ' + name;
  const f = e.fuel_type ? fuelNameRu(e.fuel_type) : 'топливо';
  const t = vars[Math.floor(Math.random() * vars.length)];
  return t.split('{n}').join(name).split('{f}').join(f);
}

function fuelNameRu(f) {
  return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : '';
}
// Города юга боксами (те же, что CITY_BOXES сайта): в живой ленте строки
// региона получают конкретный город вместо безликого «(регион)»,
// а строки Новороссийска идут жирным — город владельца виден сразу.
const CITY_BOXES = [
  { name: 'Новороссийск', lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.00 },
  { name: 'Геленджик', lat1: 44.45, lat2: 44.68, lon1: 37.95, lon2: 38.25 },
  { name: 'Анапа', lat1: 44.80, lat2: 45.10, lon1: 37.20, lon2: 37.60 },
  { name: 'Крымск', lat1: 44.85, lat2: 45.05, lon1: 37.85, lon2: 38.15 },
  { name: 'Краснодар', lat1: 44.90, lat2: 45.15, lon1: 38.80, lon2: 39.15 },
  { name: 'Сочи', lat1: 43.35, lat2: 43.75, lon1: 39.60, lon2: 40.10 },
  { name: 'Туапсе', lat1: 44.00, lat2: 44.20, lon1: 39.00, lon2: 39.25 },
  { name: 'Армавир', lat1: 44.90, lat2: 45.10, lon1: 40.90, lon2: 41.20 },
  { name: 'Майкоп', lat1: 44.55, lat2: 44.75, lon1: 40.00, lon2: 40.30 }
];
function cityOfStation(s) {
  if (!s) return null;
  for (const c of CITY_BOXES) if (s.lat >= c.lat1 && s.lat <= c.lat2 && s.lon >= c.lon1 && s.lon <= c.lon2) return c.name;
  return null;
}
// экранирование под HTML-режим Телеграма: имена и адреса приходят с источника как есть
function escTg(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function tg(text, html) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    const st = await sbGet('/rest/v1/bot_meta?key=eq.notify&select=value');
    if (st.length && st[0].value === '0') { console.log('   Тихий режим: событийное уведомление пропущено'); return; }
  } catch (e) {}
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(html ? { chat_id: chat, text: text, disable_web_page_preview: true, parse_mode: 'HTML' } : { chat_id: chat, text: text, disable_web_page_preview: true })
    });
  } catch (e) { console.log('   ! Телеграм: ' + e.message); }
}
// Уведомление «источник недоступен» — не чаще раза в час: чужой DDoS
// не повод будить владельца каждые 10 минут. Тихий режим bot_meta учитывается внутри tg().
async function tgUpstreamThrottled(text) {
  try {
    const now = Date.now();
    const cur = await sbGet('/rest/v1/bot_meta?key=eq.upstream_alert&select=value');
    const last = cur.length ? Date.parse(cur[0].value) : 0;
    if (now - last < 60 * 60 * 1000) { console.log('   Троттлинг: о недоступности уже сообщали меньше часа назад'); return; }
    await sbPost('bot_meta?on_conflict=key', [{ key: 'upstream_alert', value: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }], 'return=minimal,resolution=merge-duplicates');
    await tg(text);
  } catch (e) { console.log('   ! Троттлинг: ' + e.message); }
}

function fuelSet(fuelsNow) {
  const empty = !fuelsNow;
  const list = (fuelsNow || '').split(',');
  return {
    f92: empty ? null : list.includes('92'),
    f95: empty ? null : list.includes('95'),
    fdt: empty ? null : list.includes('ДТ')
  };
}

function freshnessMinutes(pricesNow) {
  let latest = null;
  for (const k of Object.keys(pricesNow || {})) {
    const t = (pricesNow[k] || {}).t;
    if (t && (!latest || t > latest)) latest = t;
  }
  if (!latest) return null;
  const d = new Date(latest.replace(' ', 'T') + '+03:00');
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
}

// === Машина состояний v1 (тень): состояние станции по серии статусов АИ-95 ===
// AVAILABLE / SUSPECTED_LOSS / CONFIRMED_LOSS / DEPLETION /
// RECOVERY_STARTED / RECOVERY_CONFIRMED / UNKNOWN (молчание).
// Гистерезис: одно «нет» ещё не дефицит; >=2 подряд — подтверждённая потеря;
// молчание >=1 ч поверх потери — DEPLETION; одно «есть» после потери — только
// начало восстановления, >=3 подряд — снова AVAILABLE.
// Нулевые промежутки короче 6 наблюдений (~1 ч) видим сквозь (дух gap-детектора).
function computeFuelState(hist) {
  const SILENCE = 6;
  let i = 0, gapHead = 0;
  while (i < hist.length && (hist[i] === null || hist[i] === undefined)) { gapHead++; i++; }
  if (i >= hist.length) return 'UNKNOWN'; // за сутки не было ни одной отметки
  const runs = [];
  while (i < hist.length) {
    const v = hist[i];
    let len = 0;
    while (i < hist.length) {
      if (hist[i] === v) { len++; i++; continue; }
      if (hist[i] === null || hist[i] === undefined) {
        let j = i, gap = 0;
        while (j < hist.length && (hist[j] === null || hist[j] === undefined)) { gap++; j++; }
        if (gap < SILENCE && j < hist.length && hist[j] === v) { i = j; continue; }
        break;
      }
      break;
    }
    runs.push({ v: v, len: len });
  }
  const head = runs[0];
  if (gapHead >= SILENCE) return head.v === false ? 'DEPLETION' : 'UNKNOWN';
  if (head.v === false) return head.len >= 2 ? 'CONFIRMED_LOSS' : 'SUSPECTED_LOSS';
  const prev = runs[1];
  if (prev && prev.v === false && prev.len >= 2) {
    if (head.len === 1) return 'RECOVERY_STARTED';
    if (head.len === 2) return 'RECOVERY_CONFIRMED';
  }
  return 'AVAILABLE';
}
// Надёжность v1: доля наблюдений лукбэка, где источник дал хоть одно топливо
function reliabilityOf(histAny) {
  if (!histAny.length) return null;
  let n = 0;
  for (const o of histAny) {
    if (o.fuel_92_status !== null && o.fuel_92_status !== undefined) { n++; continue; }
    if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) { n++; continue; }
    if (o.diesel_status !== null && o.diesel_status !== undefined) n++;
  }
  return Math.round(100 * n / histAny.length) / 100;
}
async function main() {
  // джиттер до 45 сек: не стучим синхронно с волнами атаки и другими клиентами
  await new Promise(res => setTimeout(res, Math.floor(Math.random() * 45000)));
  console.log('1) Качаю GdeBenz (Новороссийск)...');
  const list = await fetchGdebenz();
  console.log('   Станций в ответе: ' + list.length);
  const donorLists = [];
  for (const f of DONOR_FRAMES) {
    const dl = await fetchFrame(f.url, 'GdeBenz (' + f.region + ')');
    console.log('   Донор ' + f.region + ': станций ' + dl.length);
    donorLists.push({ region: f.region, list: dl });
    await new Promise(res => setTimeout(res, 1500)); // вежливая пауза между рамками
  }

  console.log('2) Сохраняю станции...');
  const homeExt = new Set(list.map(s => String(s.osm_id)));
  // паспорт топлив станции из meta.f (через запятую); null, если источник молчит
  const fuelsMetaOf = s => (s.meta && Array.isArray(s.meta.f) && s.meta.f.length) ? s.meta.f.join(',') : null;
  const stationPayload = list.map(s => ({
    external_id: String(s.osm_id),
    name: s.name || 'АЗС',
    brand: s.brand || '',
    address: s.addr || '',
    lat: s.lat,
    lon: s.lon,
    source: 'gdebenz',
    region: null,
    fuels_meta: fuelsMetaOf(s)
  })).concat(donorLists.flatMap(d => d.list
    .filter(s => !homeExt.has(String(s.osm_id)))
    .map(s => ({
      external_id: String(s.osm_id),
      name: s.name || 'АЗС',
      brand: s.brand || '',
      address: s.addr || '',
      lat: s.lat,
      lon: s.lon,
      source: 'gdebenz',
      region: d.region,
      fuels_meta: fuelsMetaOf(s)
    }))));
  const saved = await sbPost(
    'stations?on_conflict=external_id,source',
    stationPayload,
    'return=representation,resolution=merge-duplicates'
  );
  const idByExt = {};
  for (const s of saved) idByExt[s.external_id] = s.id;
  const nameById = {};
const wideById = {};
const cityById = {};
const homeIdSet = new Set();
for (const s of saved) {
  nameById[s.id] = escTg((s.name || 'АЗС') + (s.address ? ' · ' + s.address : ''));
  wideById[s.id] = !(s.lat >= 44.60 && s.lat <= 44.85 && s.lon >= 37.55 && s.lon <= 38.05);
  cityById[s.id] = cityOfStation(s);
  if (!s.region) homeIdSet.add(s.id);
}
// подпись строки ленты: Новороссийск — жирным и без суффикса,
// регион — конкретный город в скобках (или «(регион)», если вне всех боксов)
function stationLabel(id) {
  const base = nameById[id] || 'АЗС';
  if (!wideById[id]) return '<b>' + base + '</b>';
  return base + ' (' + (cityById[id] || 'регион') + ')';
}
  const tgLines = [];

  console.log('3) Достаю последние наблюдения для сравнения...');
  const lastByStation = {};
  const recentByStation = {};
  const pushObs = o => {
    (recentByStation[o.station_id] = recentByStation[o.station_id] || []).push(o);
    if (!lastByStation[o.station_id]) lastByStation[o.station_id] = o;
  };
  const homeIds = [...homeIdSet];
  if (homeIds.length) {
    // домой полный лукбэк (~24ч): gap-детектор видит сквозь ночные null
    const last = await sbGet(
      '/rest/v1/observations?station_id=in.(' + homeIds.map(i => '"' + i + '"').join(',') +
      ')&order=timestamp.desc&limit=20000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level,timestamp'
    );
    for (const o of last) pushObs(o);
  }
  // доноры: история хранится разреженно (смены + heartbeat), берём окно 13ч без списка id
  const sinceDonor = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  const donorLast = await sbGet(
    '/rest/v1/observations?timestamp=gte.' + sinceDonor +
    '&order=timestamp.desc&limit=20000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level,timestamp'
  );
  for (const o of donorLast) if (!homeIdSet.has(o.station_id)) pushObs(o);

  console.log('4) Записываю новые наблюдения...');
  const mkRow = (s, id) => {
    const f = fuelSet(s.fuels_now);
    const p = s.prices_now || {};
    return {
      station_id: id,
      fuel_92_status: f.f92,
      fuel_95_status: f.f95,
      diesel_status: f.fdt,
      price_92: p['92'] ? p['92'].p : null,
      price_95: p['95'] ? p['95'].p : null,
      price_diesel: p['ДТ'] ? p['ДТ'].p : null,
      queue_level: s.conflict === 'queue' ? 'high' : null,
      source_status: s.status === undefined ? null : s.status,
      fuel_state: null,
      reliability_score: null,
      data_freshness_minutes: freshnessMinutes(p)
    };
  };
  const obsRows = list.map(s => mkRow(s, idByExt[String(s.osm_id)])).filter(r => r.station_id);
// Машина состояний v1 (тень): состояния и надёжность считаем только дому —
// у доноров запись разреженная (heartbeat 1ч), серии нерепрезентативны.
// События на состояния ещё не смотрят: сначала неделя замера распределения.
const stateCounts = {};
for (const row of obsRows) {
  if (!homeIdSet.has(row.station_id)) continue;
  const hist = recentByStation[row.station_id] || [];
  row.fuel_state = computeFuelState([row.fuel_95_status].concat(hist.map(o => o.fuel_95_status)));
  row.reliability_score = reliabilityOf(hist);
  stateCounts[row.fuel_state] = (stateCounts[row.fuel_state] || 0) + 1;
}
console.log('   Состояния дома: ' + JSON.stringify(stateCounts));
  // доноры: строка при смене статуса/очереди, heartbeat раз в 1ч или при первой встрече
// (часовой heartbeat нужен, чтобы почасовые сводки региона были живыми)
  const HEARTBEAT_MS = 1 * 3600 * 1000;
  let donorWritten = 0;
  for (const d of donorLists) {
    for (const s of d.list) {
      const id = idByExt[String(s.osm_id)];
      if (!id || homeIdSet.has(id)) continue;
      const row = mkRow(s, id);
      const prev = lastByStation[id];
      const prevMs = prev && prev.timestamp ? new Date(prev.timestamp).getTime() : 0;
      const changed = !prev ||
        prev.fuel_92_status !== row.fuel_92_status ||
        prev.fuel_95_status !== row.fuel_95_status ||
        prev.diesel_status !== row.diesel_status ||
        (prev.queue_level || null) !== (row.queue_level || null);
      const heartbeat = !prev || (Date.now() - prevMs) >= HEARTBEAT_MS;
      if (changed || heartbeat) { obsRows.push(row); donorWritten++; }
    }
  }
  await sbPost('observations', obsRows);
  console.log('   Наблюдений записано: ' + obsRows.length + ' (дом ' + (obsRows.length - donorWritten) + ' + доноры ' + donorWritten + ')');

  console.log('5) Ищу изменения (события)...');
  const events = [];
  for (const row of obsRows) {
    const prev = lastByStation[row.station_id];
    if (!prev) continue;
    const beforeIdx = events.length;
    for (const [fuel, col] of [['92','fuel_92_status'], ['95','fuel_95_status'], ['diesel','diesel_status']]) {
      const b = row[col];
      if (b === null || b === undefined) continue;
      // Ищем последнюю НЕ пустую отметку этого топлива (до 36 часов назад):
      // так не теряем пополнения, случившиеся сквозь ночное "молчание"
      const hist = recentByStation[row.station_id] || [];
      let a = null, aAgeH = Infinity;
      for (const o of hist) {
        if (o[col] !== null && o[col] !== undefined) {
          a = o[col];
          aAgeH = (Date.now() - new Date(o.timestamp).getTime()) / 3600000;
          break;
        }
      }
      if (a === null || aAgeH > 36) continue;
      if (a === false && b === true) events.push({ station_id: row.station_id, event_type: 'fuel_restored', fuel_type: fuel, confidence: aAgeH > 6 ? 0.7 : 0.8, source: 'observation' });
      if (a === true && b === false) events.push({ station_id: row.station_id, event_type: 'fuel_disappeared', fuel_type: fuel, confidence: aAgeH > 6 ? 0.7 : 0.8, source: 'observation' });
    }
    // Фильтр артефакта состава отметок: если дизель и бензин flipped
    // в противофазе за один снимок — это люди отметили "осталось только ДТ"
    // или "бензин вернулся", а не движение цистерны. Дизельный флаг убираем.
    const addedEv = events.slice(beforeIdx);
    const dieselEv = addedEv.find(e => e.fuel_type === 'diesel');
    const gasEv = addedEv.find(e => e.fuel_type === '92' || e.fuel_type === '95');
    if (dieselEv && gasEv && dieselEv.event_type !== gasEv.event_type) {
      events.splice(events.indexOf(dieselEv), 1);
    }
    // очередь появилась / исчезла
    const prevQueue = prev.queue_level === 'high';
    const nowQueue = row.queue_level === 'high';
    if (!prevQueue && nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_appeared', fuel_type: null, confidence: 0.7, source: 'observation' });
    if (prevQueue && !nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_gone', fuel_type: null, confidence: 0.7, source: 'observation' });
  }
  if (events.length) await sbPost('events', events);
  console.log('   Событий обнаружено: ' + events.length);
  for (const e of events) tgLines.push(eventStoryRu(e, stationLabel(e.station_id)));
  // === ШАГ 6: превращаем народные отметки user_feedback в события ===
  console.log('6) Обрабатываю народные отметки...');
  const unprocessed = await sbGet(
    '/rest/v1/user_feedback?processed_at=is.null&select=id,station_id,feedback_type,fuel_type,queue_size,created_at&limit=500'
  );
  if (unprocessed.length) {
    const fbEvents = unprocessed.map(f => ({
      station_id: f.station_id,
      event_type:
        f.feedback_type === 'delivery' ? 'possible_delivery' :
        f.feedback_type === 'available' ? 'fuel_available' :
        f.feedback_type === 'unavailable' ? 'fuel_unavailable' :
        f.feedback_type === 'queue' ? 'queue_high' :
        'queue_low',
      fuel_type: f.fuel_type === 'all' ? null : (f.fuel_type || null),
      detected_at: f.created_at,
      confidence:
        f.feedback_type === 'queue'
          ? (f.queue_size === 'huge' ? 0.95 : f.queue_size === 'large' ? 0.9 : f.queue_size === 'medium' ? 0.75 : f.queue_size === 'small' ? 0.6 : 0.7)
          : 0.85,
      source: 'user_feedback'
    }));
    await sbPost('events', fbEvents);
    for (const e of fbEvents) tgLines.push(eventStoryRu(e, stationLabel(e.station_id)));
    const ids = unprocessed.map(f => f.id).join(',');
    await sbPatch('user_feedback?id=in.(' + ids + ')', { processed_at: new Date().toISOString() });
    console.log('   Народных отметок превращено в события: ' + fbEvents.length);
  } else {
    console.log('   Новых народных отметок нет');
  }

  // === ШАГ УБОРКИ: удаляем наблюдения старше 30 дней, чтобы база не раздувалась ===
  console.log('7) Убираю старые наблюдения (старше 30 дней)...');
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  try {
    const delRes = await fetch(
      SUPABASE_URL + '/rest/v1/observations?timestamp=lt.' + cutoff,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          Prefer: 'return=minimal'
        }
      }
    );
    console.log('   Уборка: HTTP ' + delRes.status);
  } catch (e) {
    console.log('   ! Уборка не прошла: ' + e.message);
  }

  if (tgLines.length) {
    // Контекст города из свежих домашних отметок (факт, не прогноз)
    let known = 0, avail = 0;
    for (const row of obsRows) {
      if (!homeIdSet.has(row.station_id)) continue;
      if (row.fuel_95_status !== null && row.fuel_95_status !== undefined) { known++; if (row.fuel_95_status) avail++; }
    }
    const msk = new Date(Date.now() + 3 * 3600 * 1000);
    const hh = String(msk.getUTCHours()).padStart(2, '0') + ':' + String(msk.getUTCMinutes()).padStart(2, '0');
    await tg('⚡ ' + hh + ' · ' + tgLines.length +
      (known ? '\n🏙 АИ-95: ' + avail + '/' + known : '') +
'\n' + tgLines.slice(0, 8).join('\n'), true);
  }
  console.log('✅ Цикл завершён');
}

main().catch(async e => {
  // Источник недоступен/под атакой — это НЕ баг коллектора: выходим тихо
  // (workflow зелёный), владельца тревожим не чаще раза в час.
  if (e && e.upstream) {
    console.error('⚠️ Источник недоступен: ' + e.message);
    await tgUpstreamThrottled('⚠️ GdeBenz недоступен (похоже на DDoS или защиту). Цикл пропущен, сайт показывает последние данные; вернусь через 10 минут.');
    process.exit(0);
  }
  console.error('❌ Ошибка: ' + e.message);
  process.exit(1);
});