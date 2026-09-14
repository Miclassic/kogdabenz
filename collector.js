// ===== Сборщик Новороссийска v2.1 =====
// Запускается сам на GitHub каждые 10 минут. Без внешних библиотек.
// v2.1: если GdeBenz "чихнул" (502) — пробуем ещё несколько раз
// и переключаемся на запасной адрес gdebenz.org.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOX = '?lat1=44.62&lon1=37.62&lat2=44.82&lon2=38.00';
const HOSTS = ['https://gdebenz.ru', 'https://gdebenz.org'];

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  let list = null;
  let host = HOSTS[0];
  for (let attempt = 1; attempt <= 4 && !list; attempt++) {
    host = HOSTS[(attempt - 1) % HOSTS.length];
    try {
      const g = await fetch(host + '/api/stations' + BOX);
      if (g.ok) {
        list = await g.json();
        console.log('   Ответил: ' + host);
      } else {
        console.log('   Попытка ' + attempt + ' (' + host + '): статус ' + g.status);
      }
    } catch (e) {
      console.log('   Попытка ' + attempt + ' (' + host + '): недоступен');
    }
    if (!list && attempt < 4) await sleep(15000);
  }
  if (!list) throw new Error('GdeBenz не ответил после 4 попыток');
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

  console.log('5) Ищу изменения топлива и очередей (события)...');
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
    const prevQueue = prev.queue_level === 'high';
    const nowQueue = row.queue_level === 'high';
    if (!prevQueue && nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_appeared', fuel_type: null, confidence: 0.7, source: 'observation' });
    if (prevQueue && !nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_gone', fuel_type: null, confidence: 0.7, source: 'observation' });
  }
  if (events.length) await sbPost('events', events);
  console.log('   Событий топлива/очередей: ' + events.length);

  console.log('6) Качаю комментарии со станций...');
  const commentsByStation = {};
  let commentsTotal = 0;
  for (const station of list) {
    try {
      const cr = await fetch(host + '/api/stations/' + station.osm_id + '/comments');
      if (cr.ok) {
        const cdata = await cr.json();
        const cList = Array.isArray(cdata) ? cdata : (cdata.comments || cdata.data || []);
        if (cList.length) {
          commentsByStation[station.osm_id] = cList;
          commentsTotal += cList.length;
        }
      }
      await sleep(150);
    } catch (e) {
      console.log('   ! Комменты станции ' + station.osm_id + ' не загрузились: ' + e.message);
    }
  }
  console.log('   Всего комментариев получено: ' + commentsTotal);

  const existingExtIds = new Set();
  if (commentsTotal > 0) {
    try {
      const existing = await sbGet('/rest/v1/comments?select=external_id&limit=5000');
      for (const c of existing) existingExtIds.add(String(c.external_id));
    } catch (e) {
      console.log('   ! Не смог прочитать старые комментарии: ' + e.message);
    }
  }

  const newComments = [];
  const commentEvents = [];
  const KEYWORDS_DELIVERY = ['привезли', 'бензовоз', 'завезли', 'поставка', 'привез', 'только что'];
  const KEYWORDS_NOFUEL = ['закончился', 'отсутствует', 'нет бензина', 'нет 95', 'нет 92', 'нет дизеля', 'пусто'];
  const KEYWORDS_QUEUE = ['очередь', 'много машин', 'большая очередь', 'долго'];

  for (const [osmId, cList] of Object.entries(commentsByStation)) {
    const stationId = idByExt[String(osmId)];
    if (!stationId) continue;
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
  }

  if (newComments.length) await sbPost('comments', newComments);
  console.log('   Новых комментариев сохранено: ' + newComments.length);
  if (commentEvents.length) {
    await sbPost('events', commentEvents);
    console.log('   Событий из комментариев: ' + commentEvents.length);
  }

  console.log('✅ Цикл завершён');
}

main().catch(e => { console.error('❌ Ошибка: ' + e.message); process.exit(1); });
