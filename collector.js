// ===== Сборщик Новороссийска (v3: РАБОЧАЯ ОСНОВА + очереди и комментарии) =====
// Основа — проверенный код с "паспортом браузера" и повторами. НЕ ЛОМАТЬ.
// Нового только: queue_level в шаге 3, события очередей в шаге 5, шаг 6 (комментарии).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GDEBENZ_URL = 'https://gdebenz.ru/api/stations?lat1=44.62&lon1=37.62&lat2=44.82&lon2=38.00';

// "Паспорт браузера", чтобы сайт принимал нас за обычного посетителя
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  'Referer': 'https://gdebenz.ru/'
};

async function fetchGdebenz() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(GDEBENZ_URL, { headers: BROWSER_HEADERS });
    if (r.ok) return r.json();
    console.log('   Попытка ' + attempt + ': статус ' + r.status + ', жду 10 сек и повторю...');
    await new Promise(res => setTimeout(res, 10000));
  }
  throw new Error('GdeBenz не ответил после 3 попыток');
}

// === NEW === комментарии: тот же паспорт, но без повторов, чтобы цикл не тормозил
async function fetchCommentsSafe(url) {
  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : (data.comments || data.data || []);
  } catch (e) {
    return [];
  }
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

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

async function main() {
  console.log('1) Качаю GdeBenz (Новороссийск)...');
  const list = await fetchGdebenz();
  console.log('   Станций в ответе: ' + list.length);

  console.log('2) Сохраняю станции...');
  const saved = await sbPost(
    'stations?on_conflict=external_id,source',
    list.map(s => ({
      external_id: String(s.osm_id),
      name: s.name || 'АЗС',
      brand: s.brand || '',
      address: s.addr || '',
      lat: s.lat,
      lon: s.lon,
      source: 'gdebenz'
    })),
    'return=representation,resolution=merge-duplicates'
  );
  const idByExt = {};
  for (const s of saved) idByExt[s.external_id] = s.id;

  console.log('3) Достаю последние наблюдения для сравнения...');
  const ids = saved.map(s => s.id);
  const lastByStation = {};
  if (ids.length) {
    const last = await sbGet(
      '/rest/v1/observations?station_id=in.(' + ids.map(i => '"' + i + '"').join(',') +
      ')&order=timestamp.desc&limit=2000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level'
    );
    for (const o of last) if (!lastByStation[o.station_id]) lastByStation[o.station_id] = o;
  }

  console.log('4) Записываю новые наблюдения...');
  const obsRows = list.map(s => {
    const f = fuelSet(s.fuels_now);
    const p = s.prices_now || {};
    return {
      station_id: idByExt[String(s.osm_id)],
      fuel_92_status: f.f92,
      fuel_95_status: f.f95,
      diesel_status: f.fdt,
      price_92: p['92'] ? p['92'].p : null,
      price_95: p['95'] ? p['95'].p : null,
      price_diesel: p['ДТ'] ? p['ДТ'].p : null,
      queue_level: s.conflict === 'queue' ? 'high' : null,
      data_freshness_minutes: freshnessMinutes(p)
    };
  }).filter(r => r.station_id);
  await sbPost('observations', obsRows);
  console.log('   Наблюдений записано: ' + obsRows.length);

  console.log('5) Ищу изменения (события)...');
  const events = [];
  for (const row of obsRows) {
    const prev = lastByStation[row.station_id];
    if (!prev) continue;
    for (const [fuel, col] of [['92','fuel_92_status'], ['95','fuel_95_status'], ['diesel','diesel_status']]) {
      const a = prev[col], b = row[col];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      if (a === false && b === true) events.push({ station_id: row.station_id, event_type: 'fuel_restored', fuel_type: fuel, confidence: 0.8, source: 'observation' });
      if (a === true && b === false) events.push({ station_id: row.station_id, event_type: 'fuel_disappeared', fuel_type: fuel, confidence: 0.8, source: 'observation' });
    }
    // === NEW === очередь появилась / исчезла
    const prevQueue = prev.queue_level === 'high';
    const nowQueue = row.queue_level === 'high';
    if (!prevQueue && nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_appeared', fuel_type: null, confidence: 0.7, source: 'observation' });
    if (prevQueue && !nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_gone', fuel_type: null, confidence: 0.7, source: 'observation' });
  }
  if (events.length) await sbPost('events', events);
  console.log('   Событий обнаружено: ' + events.length);

  // === NEW === ШАГ 6: комментарии водителей
  console.log('6) Качаю комментарии...');
  const existingExtIds = new Set();
  try {
    const existing = await sbGet('/rest/v1/comments?select=external_id&limit=5000');
    for (const c of existing) existingExtIds.add(String(c.external_id));
  } catch (e) {
    console.log('   ! Не смог прочитать старые комментарии: ' + e.message);
  }

  const KEYWORDS_DELIVERY = ['привезли', 'бензовоз', 'завезли', 'поставка', 'привез', 'только что'];
  const KEYWORDS_NOFUEL = ['закончился', 'отсутствует', 'нет бензина', 'нет 95', 'нет 92', 'нет дизеля', 'пусто'];
  const KEYWORDS_QUEUE = ['очередь', 'много машин', 'большая очередь', 'долго'];

  const newComments = [];
  const commentEvents = [];
  for (const station of list) {
    const stationId = idByExt[String(station.osm_id)];
    const cList = stationId ? await fetchCommentsSafe('https://gdebenz.ru/api/stations/' + station.osm_id + '/comments') : [];
    for (const c of cList) {
      const extId = String(c.id || c.comment_id || '');
      if (!extId || existingExtIds.has(extId)) continue;
      const text = String(c.text || c.comment || c.body || '');
      const ts = c.timestamp || c.created_at || c.date || new Date().toISOString();
      newComments.push({ station_id: stationId, external_id: extId, comment_text: text, timestamp: ts, source: 'gdebenz' });
      const low = text.toLowerCase();
      if (KEYWORDS_DELIVERY.some(k => low.includes(k))) commentEvents.push({ station_id: stationId, event_type: 'possible_delivery', fuel_type: null, confidence: 0.7, source: 'comment', detected_at: ts });
      if (KEYWORDS_NOFUEL.some(k => low.includes(k))) commentEvents.push({ station_id: stationId, event_type: 'fuel_unavailable', fuel_type: null, confidence: 0.6, source: 'comment', detected_at: ts });
      if (KEYWORDS_QUEUE.some(k => low.includes(k))) commentEvents.push({ station_id: stationId, event_type: 'queue_high', fuel_type: null, confidence: 0.65, source: 'comment', detected_at: ts });
    }
    await sleep(120);
  }

  if (newComments.length) await sbPost('comments', newComments);
  console.log('   Новых комментариев сохранено: ' + newComments.length);
  if (commentEvents.length) {
    await sbPost('events', commentEvents);
    console.log('   Событий из комментариев: ' + commentEvents.length);
  }
  // === ШАГ 7: превращаем народные отметки user_feedback в события ===
  console.log('7) Обрабатываю народные отметки...');
  const unprocessed = await sbGet(
    '/rest/v1/user_feedback?processed_at=is.null&select=id,station_id,feedback_type,created_at&limit=500'
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
      fuel_type: null,
      detected_at: f.created_at,
      confidence: 0.85,
      source: 'user_feedback'
    }));
    await sbPost('events', fbEvents);
    const ids = unprocessed.map(f => f.id).join(',');
    await sbPatch('user_feedback?id=in.(' + ids + ')', { processed_at: new Date().toISOString() });
    console.log('   Народных отметок превращено в события: ' + fbEvents.length);
  } else {
    console.log('   Новых народных отметок нет');
  }
  
  console.log('✅ Цикл завершён');
}

main().catch(e => { console.error('❌ Ошибка: ' + e.message); process.exit(1); });
