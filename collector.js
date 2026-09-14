// ===== Сборщик Новороссийска (v2: с паспортом браузера и повторами) =====

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
      ')&order=timestamp.desc&limit=2000&select=station_id,fuel_92_status,fuel_95_status,diesel_status'
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
  }
  if (events.length) await sbPost('events', events);
  console.log('   Событий обнаружено: ' + events.length);
  console.log('✅ Цикл завершён');
}

main().catch(e => { console.error('❌ Ошибка: ' + e.message); process.exit(1); });
