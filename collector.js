// ===== Сборщик Новороссийска v2 =====
// Запускается сам на GitHub каждые 10 минут. Без внешних библиотек.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GDEBENZ_URL = 'https://gdebenz.ru/api/stations?lat1=44.62&lon1=37.62&lat2=44.82&lon2=38.00';

// ===== Вспомогательные функции =====

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

// Задержка (чтобы не долбить API)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== Обработка топлива =====

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

// ===== Главная функция =====

async function main() {
  console.log('1) Качаю GdeBenz (Новороссийск)...');
  const g = await fetch(GDEBENZ_URL);
  if (!g.ok) throw new Error('GdeBenz ответил ' + g.status);
  const list = await g.json();
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

  console.log('5) Ищу изменения топлива (события)...');
  const events = [];
  for (const row of obsRows) {
    const prev = lastByStation[row.station_id];
    if (!prev) continue;
    // Топливо
    for (const [fuel, col] of [['92','fuel_92_status'], ['95','fuel_95_status'], ['diesel','diesel_status']]) {
      const a = prev[col], b = row[col];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      if (a === false && b === true) events.push({ station_id: row.station_id, event_type: 'fuel_restored', fuel_type: fuel, confidence: 0.8, source: 'observation' });
      if (a === true && b === false) events.push({ station_id: row.station_id, event_type: 'fuel_disappeared', fuel_type: fuel, confidence: 0.8, source: 'observation' });
    }
    // Очередь (новое в v2!)
    const prevQueue = prev.queue_level === 'high';
    const nowQueue = row.queue_level === 'high';
    if (!prevQueue && nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_appeared', fuel_type: null, confidence: 0.7, source: 'observation' });
    if (prevQueue && !nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_gone', fuel_type: null, confidence: 0.7, source: 'observation' });
  }
  if (events.length) await sbPost('events', events);
  console.log('   Событий топлива/очередей: ' + events.length);

  // ===== НОВОЕ В v2: Сбор и анализ комментариев =====
  console.log('6) Качаю комментарии со станций...');
  const commentsByStation = {};
  let commentsTotal = 0;
  let commentsNew = 0;
  const commentEvents = [];
  
  for (const station of list) {
    try {
      const url = 'https://gdebenz.ru/api/stations/' + station.osm_id + '/comments';
      const cr = await fetch(url);
      if (cr.ok) {
        const cdata = await cr.json();
        const cList = Array.isArray(cdata) ? cdata : (cdata.comments || cdata.data || []);
        if (cList.length) {
          commentsByStation[station.osm_id] = cList;
          commentsTotal += cList.length;
        }
      }
      await sleep(150); // не долбить API
    } catch (e) {
      console.log('   ! Комменты станции ' + station.osm_id + ' не загрузились: ' + e.message);
    }
  }
  console.log('   Всего комментариев получено: ' + commentsTotal);

  // Достаём уже сохранённые external_id, чтобы не писать дубли
  const existingExtIds = new Set();
  if (commentsTotal > 0) {
    try {
      const existing = await sbGet('/rest/v1/comments?select=external_id&limit=5000');
      for (const c of existing) existingExtIds.add(String(c.external_id));
    } catch (e) {
      console.log('   ! Не смог прочитать старые комментарии: ' + e.message);
    }
  }

  // Собираем только новые комментарии
  const newComments = [];
  const KEYWORDS_DELIVERY = ['привезли', 'бензовоз', 'завезли', 'поставка', 'привез', 'приехал бензовоз', 'привезут'];
  const KEYWORDS_NOFUEL   = ['нет ', 'закончился', 'отсутствует', 'нет бензина', 'нет 95', 'нет 92', 'нет дизеля', 'пусто'];
  const KEYWORDS_QUEUE    = ['очередь', 'много машин', 'долго', 'большая очередь', 'очереди'];

  for (const [osmId, cList] of Object.entries(commentsByStation)) {
    const stationId = idByExt[String(osmId)];
    if (!stationId) continue;
    for (const c of cList) {
      const extId = String(c.id || c.comment_id || '');
      if (!extId || existingExtIds.has(extId)) continue;
      const text = String(c.text || c.comment || c.body || '');
      const ts = c.timestamp || c.created_at || c.date || new Date().toISOString();
      newComments.push({
        station_id: stationId,
        external_id: extId,
        comment_text: text,
        timestamp: ts,
        source: 'gdebenz'
      });
      // Анализ ключевыми словами
      const low = text.toLowerCase();
      if (KEYWORDS_DELIVERY.some(k => low.includes(k))) {
        commentEvents.push({ station_id: stationId, event_type: 'possible_delivery', fuel_type: null, confidence: 0.7, source: 'comment', detected_at: ts, metadata: { text: text, keyword: 'delivery' } });
      }
      if (KEYWORDS_NOFUEL.some(k => low.includes(k))) {
        commentEvents.push({ station_id: stationId, event_type: 'fuel_unavailable', fuel_type: null, confidence: 0.6, source: 'comment', detected_at: ts, metadata: { text: text, keyword: 'nofuel' } });
      }
      if (KEYWORDS_QUEUE.some(k => low.includes(k))) {
        commentEvents.push({ station_id: stationId, event_type: 'queue_high', fuel_type: null, confidence: 0.65, source: 'comment', detected_at: ts, metadata: { text: text, keyword: 'queue' } });
      }
    }
  }

  if (newComments.length) {
    await sbPost('comments', newComments);
    commentsNew = newComments.length;
  }
  console.log('   Новых комментариев сохранено: ' + commentsNew);

  if (commentEvents.length) {
    // metadata может не сохраниться, если колонки нет — но само событие запишется
    try {
      await sbPost('events', commentEvents);
    } catch (e) {
      // Если падает из-за metadata — пробуем без него
      const stripped = commentEvents.map(ev => ({ station_id: ev.station_id, event_type: ev.event_type, fuel_type: ev.fuel_type, confidence: ev.confidence, source: ev.source, detected_at: ev.detected_at }));
      await sbPost('events', stripped);
    }
    console.log('   Событий из комментариев: ' + commentEvents.length);
  }

  console.log('✅ Цикл завершён');
}

main().catch(e => { console.error('❌ Ошибка: ' + e.message); process.exit(1); });
