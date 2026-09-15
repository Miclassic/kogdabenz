// ===== Предиктор Новороссийска v1.1 =====
// Умное объединение: свои события → по бренду → по городу.
// Модель длительности дефицита: если топливо сейчас исчезло,
// считаем, когда его обычно возвращают.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MIN_EVENTS_PRELIM = 3;
const MIN_EVENTS_FULL = 5;
const HISTORY_DAYS = 30;
const MIN_WINDOW_MIN = 15;

// Новороссийская рамка — на сайте показываем только эти станции
const OWN_BOX = { lat1: 44.62, lat2: 44.82, lon1: 37.62, lon2: 38.00 };

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

function isOwn(s) {
  return s.lat >= OWN_BOX.lat1 && s.lat <= OWN_BOX.lat2 &&
         s.lon >= OWN_BOX.lon1 && s.lon <= OWN_BOX.lon2;
}

async function main() {
  console.log('=== ПРЕДИКТОР v1.1 (умное объединение + дефицит) ===');
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000).toISOString();

  console.log('1) Достаю станции...');
  const stations = await sbGet('/rest/v1/stations?select=id,name,brand,address,lat,lon&limit=2000');
  console.log('   Всего: ' + stations.length + ' (в Новороссийске: ' + stations.filter(isOwn).length + ')');

  console.log('2) Достаю события fuel_restored за ' + HISTORY_DAYS + ' дней...');
  const restoredEvents = await sbGet(
    '/rest/v1/events?event_type=eq.fuel_restored&detected_at=gte.' + since +
    '&select=station_id,fuel_type,detected_at&limit=50000'
  );
  console.log('   Событий: ' + restoredEvents.length);

  console.log('3) Достаю события fuel_disappeared...');
  const disappearedEvents = await sbGet(
    '/rest/v1/events?event_type=eq.fuel_disappeared&detected_at=gte.' + since +
    '&select=station_id,fuel_type,detected_at&limit=50000'
  );
  console.log('   Событий: ' + disappearedEvents.length);

  console.log('4) Достаю последние наблюдения...');
  const lastObs = {};
  const obs = await sbGet('/rest/v1/observations?order=timestamp.desc&limit=20000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,timestamp');
  for (const o of obs) if (!lastObs[o.station_id]) lastObs[o.station_id] = o;

  // Группируем события по (station_id, fuel)
  const restoredByPair = {};
  for (const e of restoredEvents) {
    const key = e.station_id + '|' + e.fuel_type;
    (restoredByPair[key] = restoredByPair[key] || []).push(e.detected_at);
  }

  // Пары "исчезло → вернулось" для модели длительности дефицита
  const disByPair = {};
  for (const e of disappearedEvents) {
    const key = e.station_id + '|' + e.fuel_type;
    (disByPair[key] = disByPair[key] || []).push(e.detected_at);
  }
  const pairsByPair = {}; // pair_key -> длительности дефицита в минутах
  for (const [key, disList] of Object.entries(disByPair)) {
    const resList = (restoredByPair[key] || []).slice().sort();
    const disSorted = disList.slice().sort();
    const durations = [];
    for (const dis of disSorted) {
      const res = resList.find(r => r > dis);
      if (res) {
        const durMin = (new Date(res).getTime() - new Date(dis).getTime()) / 60000;
        if (durMin > 10 && durMin < 7 * 24 * 60) durations.push(durMin);
      }
    }
    if (durations.length >= MIN_EVENTS_PRELIM) pairsByPair[key] = durations.sort((a, b) => a - b);
  }

  // Существующие прогнозы на сегодня
  const mskNow = new Date(Date.now() + 3 * 3600 * 1000);
  const mskMinutesNow = mskNow.getUTCHours() * 60 + mskNow.getUTCMinutes();
  const todayStr = mskNow.toISOString().slice(0, 10);
  const tomorrowStr = new Date(mskNow.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dayStartIso = new Date(
    Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate()) - 3 * 3600 * 1000
  ).toISOString();
  const existing = await sbGet(
    '/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&target_date=gte.' + todayStr +
    '&select=id,station_id,fuel_type&limit=1000'
  );
  const existingByKey = {};
  for (const p of existing) existingByKey[p.station_id + '|' + p.fuel_type] = p.id;

  console.log('5) Строю прогнозы для новороссийских станций...');
  let created = 0, updated = 0, skipped = 0;
  const fuels = ['92', '95', 'diesel'];
  const fuelCol = { '92': 'fuel_92_status', '95': 'fuel_95_status', 'diesel': 'diesel_status' };

  for (const st of stations) {
    if (!isOwn(st)) continue;

    for (const fuel of fuels) {
      const pairKey = st.id + '|' + fuel;
      const label = (st.name || '?') + ' / ' + fuel;
      const ownTimes = (restoredByPair[pairKey] || []).map(moscowMinutes).sort((a, b) => a - b);
      const ownCount = ownTimes.length;

      let useTimes = null, source = null, basedOnStations = 1, usedCount = 0;

      // Попытка 1: свои события
      if (ownCount >= MIN_EVENTS_PRELIM) {
        useTimes = ownTimes;
        source = 'own';
        usedCount = ownCount;
      }

      // Попытка 2: по бренду
      if (!useTimes && st.brand) {
        const brandTimes = [];
        const brandStations = new Set();
        for (const s of stations) {
          if (s.brand === st.brand) {
            const ts = (restoredByPair[s.id + '|' + fuel] || []).map(moscowMinutes);
            if (ts.length) { brandTimes.push(...ts); brandStations.add(s.id); }
          }
        }
        if (brandTimes.length >= MIN_EVENTS_FULL) {
          useTimes = brandTimes.sort((a, b) => a - b);
          source = 'brand';
          basedOnStations = brandStations.size;
          usedCount = brandTimes.length;
        }
      }

      // Попытка 3: по городу
      if (!useTimes) {
        const cityTimes = [];
        const cityStations = new Set();
        for (const s of stations) {
          if (isOwn(s)) {
            const ts = (restoredByPair[s.id + '|' + fuel] || []).map(moscowMinutes);
            if (ts.length) { cityTimes.push(...ts); cityStations.add(s.id); }
          }
        }
        if (cityTimes.length >= MIN_EVENTS_FULL) {
          useTimes = cityTimes.sort((a, b) => a - b);
          source = 'city';
          basedOnStations = cityStations.size;
          usedCount = cityTimes.length;
        }
      }

      if (!useTimes) { skipped++; continue; }

      // Окно времени
      const med = medianOf(useTimes);
      const mean = useTimes.reduce((a, b) => a + b, 0) / useTimes.length;
      const variance = useTimes.reduce((s, t) => s + (t - mean) * (t - mean), 0) / useTimes.length;
      let sd = Math.sqrt(variance);
      if (sd < MIN_WINDOW_MIN) sd = MIN_WINDOW_MIN;

      const from = minutesToTime(med - sd);
      const to = minutesToTime(med + sd);

      const tightness = 1 / (1 + sd / 60);
      let confidence = 0.35 + 0.30 * tightness + Math.min(0.15, usedCount * 0.01);
      if (source === 'brand') confidence *= 0.85;
      if (source === 'city') confidence *= 0.70;
      if (usedCount >= MIN_EVENTS_FULL && source === 'own') confidence += 0.10;
      confidence = Math.min(0.95, Math.max(0.05, confidence));

      // Модель длительности дефицита: если топливо СЕЙЧАС исчезло
      let expectedRestoreAt = null;
      const cur = lastObs[st.id];
      const currentStatus = cur ? cur[fuelCol[fuel]] : null;
      if (currentStatus === false) {
        const pairDurations = pairsByPair[pairKey] ||
          (source === 'brand' && st.brand
            ? [].concat(...stations.filter(s => s.brand === st.brand)
                .map(s => pairsByPair[s.id + '|' + fuel] || []))
            : []) ||
          (source === 'city'
            ? [].concat(...stations.filter(s => isOwn(s))
                .map(s => pairsByPair[s.id + '|' + fuel] || []))
            : []);

        if (pairDurations.length >= MIN_EVENTS_PRELIM) {
          // Когда именно исчезло сейчас?
          let disappearedAt = null;
          const recent = await sbGet(
            '/rest/v1/events?station_id=eq.' + st.id +
            '&fuel_type=eq.' + fuel +
            '&event_type=eq.fuel_disappeared&order=detected_at.desc&limit=1'
          );
          if (recent.length) disappearedAt = new Date(recent[0].detected_at).getTime();
          if (disappearedAt) {
            const medianDur = medianOf(pairDurations);
            const elapsed = (Date.now() - disappearedAt) / 60000;
            const remaining = Math.max(5, medianDur - elapsed);
            expectedRestoreAt = new Date(Date.now() + remaining * 60000).toISOString();
          }
        }
      }

      const toMin = Number(to.slice(0, 2)) * 60 + Number(to.slice(3, 5));
      const row = {
        station_id: st.id,
        fuel_type: fuel,
        from_time: from,
        to_time: to,
        confidence: confidence.toFixed(2),
        based_on_observations: usedCount,
        based_on_stations: basedOnStations,
        prediction_source: source,
        algorithm_version: 'v1.1|' + source,
        target_date: mskMinutesNow <= toMin ? todayStr : tomorrowStr,
        result: 'PENDING'
      };
      if (expectedRestoreAt) row.expected_restore_at = expectedRestoreAt;

      const existId = existingByKey[pairKey];
      if (existId) {
        await sbPatch('predictions?id=eq.' + existId, row);
        updated++;
      } else {
        await sbPost('predictions', [row]);
        created++;
      }

      const prelim = source === 'own' && usedCount < MIN_EVENTS_FULL ? ' [предв.]' : '';
      const eta = expectedRestoreAt ? ', ждём ~' + new Date(expectedRestoreAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) : '';
      console.log('   ' + label + ' (' + source + ', станций ' + basedOnStations + '): ' +
        from.slice(0, 5) + '–' + to.slice(0, 5) + ', ' + row.confidence +
        ' (' + usedCount + ' соб.)' + prelim + eta);
    }
  }

  console.log('   Создано: ' + created + ', обновлено: ' + updated + ', пропущено: ' + skipped);
  if (created > 0 && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: '🔮 КогдаБенз: появились первые прогнозы (' + created + ' шт)! Открой сайт.' })
      });
    } catch (e) {}
  }
  console.log('✅ Предиктор v1.1 завершил работу');
}

main().catch(e => { console.error('❌ Ошибка предиктора: ' + e.message); process.exit(1); });