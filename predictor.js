// ===== Предиктор Новороссийска v1 =====
// Запускается сразу после коллектора в том же workflow.
// Строит прогноз окна пополнения по истории событий fuel_restored.
// Время считаем строго по Москве (UTC+3): GitHub Actions живёт в UTC.
// Честность (ТЗ §16): меньше 3 событий — прогноза нет.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MIN_EVENTS_PRELIM = 3;   // 3-4 события → предварительный прогноз
const MIN_EVENTS_FULL = 5;     // 5+ → полный прогноз
const HISTORY_DAYS = 30;
const MIN_WINDOW_MIN = 15;     // минимальная полуширина окна, минут

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status + ' ' + await r.text());
  return r.json();
}

async function sbPost(path, rows) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error('POST ' + path + ' → ' + r.status + ' ' + await r.text());
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

// Минуты суток по Москве из ISO-строки (MSK = UTC+3 без летнего времени)
function moscowMinutes(iso) {
  const d = new Date(iso);
  return ((d.getUTCHours() + 3) % 24) * 60 + d.getUTCMinutes();
}

function minutesToTime(m) {
  m = Math.max(0, Math.min(1439, Math.round(m)));
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00';
}

function medianOf(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

async function main() {
  console.log('=== ПРЕДИКТОР v1 (время московское) ===');
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000).toISOString();

  console.log('1) Достаю события fuel_restored за ' + HISTORY_DAYS + ' дней...');
  const events = await sbGet(
    '/rest/v1/events?event_type=eq.fuel_restored&detected_at=gte.' + since +
    '&select=station_id,fuel_type,detected_at&limit=10000'
  );
  console.log('   Событий: ' + events.length);

  const groups = {};
  for (const e of events) {
    const key = e.station_id + '|' + e.fuel_type;
    (groups[key] = groups[key] || []).push(e.detected_at);
  }

  const stations = await sbGet('/rest/v1/stations?select=id,name,address&limit=200');
  const nameById = {};
  for (const s of stations) nameById[s.id] = s.name + ' · ' + s.address;

  // Уже существующий сегодняшний прогноз пары (чтобы обновлять, а не спамить)
  const mskNow = new Date(Date.now() + 3 * 3600 * 1000);
  const dayStartIso = new Date(
    Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate()) - 3 * 3600 * 1000
  ).toISOString();
  const existing = await sbGet(
    '/rest/v1/predictions?result=eq.PENDING&created_at=gte.' + dayStartIso +
    '&select=id,station_id,fuel_type&limit=1000'
  );
  const existingByKey = {};
  for (const p of existing) existingByKey[p.station_id + '|' + p.fuel_type] = p.id;

  console.log('2) Строю прогнозы...');
  let created = 0, updated = 0, skipped = 0;
  for (const [key, list] of Object.entries(groups)) {
    const [stationId, fuel] = key.split('|');
    const label = (nameById[stationId] || stationId) + ' / ' + fuel;

    if (list.length < MIN_EVENTS_PRELIM) {
      console.log('   ' + label + ': событий ' + list.length + ' — мало данных (нужно ' + MIN_EVENTS_PRELIM + ')');
      skipped++;
      continue;
    }

    const times = list.map(moscowMinutes).sort((a, b) => a - b);
    const med = medianOf(times);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const variance = times.reduce((s, t) => s + (t - mean) * (t - mean), 0) / times.length;
    let sd = Math.sqrt(variance);
    if (sd < MIN_WINDOW_MIN) sd = MIN_WINDOW_MIN;

    const from = minutesToTime(med - sd);
    const to = minutesToTime(med + sd);

    const tightness = 1 / (1 + sd / 60);
    let confidence = 0.45 + 0.35 * tightness + Math.min(0.15, list.length * 0.01);
    if (list.length < MIN_EVENTS_FULL) confidence = Math.min(confidence, 0.6);
    confidence = Math.min(0.95, confidence);

    const row = {
      station_id: stationId,
      fuel_type: fuel,
      from_time: from,
      to_time: to,
      confidence: confidence.toFixed(2),
      based_on_observations: list.length,
      algorithm_version: 'v1.0-msk',
      result: 'PENDING'
    };

    const existId = existingByKey[key];
    if (existId) {
      await sbPatch('predictions?id=eq.' + existId, row);
      updated++;
    } else {
      await sbPost('predictions', [row]);
      created++;
    }
    console.log('   ' + label + ': окно ' + from.slice(0, 5) + '–' + to.slice(0, 5) +
      ', уверенность ' + row.confidence + ' (событий: ' + list.length + ')' +
      (list.length < MIN_EVENTS_FULL ? ' [предварительный]' : ''));
  }

  console.log('   Создано: ' + created + ', обновлено: ' + updated + ', мало данных: ' + skipped);
  console.log('✅ Предиктор завершил работу');
}

main().catch(e => { console.error('❌ Ошибка предиктора: ' + e.message); process.exit(1); });
