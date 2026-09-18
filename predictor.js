// ===== Предиктор Новороссийска v1.6 (+ State Machine Awareness) =====
// Умное объединение: свои события → по бренду → по городу.
// Модель длительности дефицита: если топливо сейчас исчезло,
// считаем, когда его обычно возвращают.
// v1.2: снапшот признаков в момент прогноза + режим города.
// v1.3: k-NN по эпизодам "исчезло → вернулось" для ETA.
// v1.6: учет состояний (State Machine) для фильтрации шума и оценки глубины кризиса.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MIN_EVENTS_PRELIM = 3;
const MIN_EVENTS_FULL = 5;
const HISTORY_DAYS = 30;
const MIN_WINDOW_MIN = 15;
// Рамка всего юга (дом + донор Кубань+Адыгея): прогнозы и очереди по всем станциям
const OWN_BOX = { lat1: 43.20, lat2: 46.10, lon1: 37.20, lon2: 41.60 };

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
  console.log('=== ПРЕДИКТОР v1.6 (State Machine Aware) ===');
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

  console.log('3.5) Достаю очередные события для контекста k-NN...');
  const queueEventsRaw = await sbGet(
    '/rest/v1/events?event_type=in.(queue_high,queue_appeared,queue_gone,queue_low)&detected_at=gte.' + since +
    '&select=station_id,event_type,detected_at&limit=50000'
  );
  const queueEvents = queueEventsRaw.map(e => ({ station_id: e.station_id, type: e.event_type, t: new Date(e.detected_at).getTime() }));
  console.log('   Событий: ' + queueEvents.length);

  console.log('4) Достаю последние наблюдения (с состояниями)...');
  // ВАЖНОЕ ИЗМЕНЕНИЕ v1.6: Выбираем поле fuel_state
  const lastObs = {};
  const obs = await sbGet('/rest/v1/observations?order=timestamp.desc&limit=20000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level,data_freshness_minutes,timestamp,fuel_state,reliability_score');
  for (const o of obs) if (!lastObs[o.station_id]) lastObs[o.station_id] = o;

  // v1.4: станция "жива на источнике" = недавно был ненулевой статус топлива.
  const lastNonNullTs = {};
  for (const o of obs) {
    if (lastNonNullTs[o.station_id]) continue;
    if (o.fuel_92_status !== null && o.fuel_92_status !== undefined) { lastNonNullTs[o.station_id] = new Date(o.timestamp).getTime(); continue; }
    if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) { lastNonNullTs[o.station_id] = new Date(o.timestamp).getTime(); continue; }
    if (o.diesel_status !== null && o.diesel_status !== undefined) lastNonNullTs[o.station_id] = new Date(o.timestamp).getTime();
  }

  // --- v1.2: городской контекст и снапшоты признаков ---
  const QUEUE_RANK = { low: 1, medium: 2, high: 3 };
  const recentByStation = {};
  for (const o of obs) { 
    const arr = recentByStation[o.station_id] || (recentByStation[o.station_id] = []);
    if (arr.length < 4) arr.push(o);
  }
  function queueTrend(stationId) {
    const arr = recentByStation[stationId];
    if (!arr || arr.length < 2) return null;
    const nowRank = QUEUE_RANK[arr[0].queue_level] || 0;
    const oldRank = QUEUE_RANK[arr[arr.length - 1].queue_level] || 0;
    if (nowRank > oldRank) return 'rising';
    if (nowRank < oldRank) return 'falling';
    return 'flat';
  }

  let cityKnown = 0, cityAvail = 0;
  let cityConfirmedLoss = 0; // NEW METRIC
  for (const s of stations) {
    if (!isOwn(s)) continue;
    const o = lastObs[s.id];
    if (o && o.fuel_95_status !== null && o.fuel_95_status !== undefined) { 
      cityKnown++; 
      if (o.fuel_95_status) cityAvail++; 
      else if (o.fuel_state === 'CONFIRMED_LOSS') cityConfirmedLoss++; // Count deep deficits
    }
  }
  const cityAvailShare = cityKnown ? cityAvail / cityKnown : null;
  const sixHoursAgo = Date.now() - 6 * 3600 * 1000;
  const restores6h = restoredEvents.filter(e => new Date(e.detected_at).getTime() >= sixHoursAgo).length;
  const disappears6h = disappearedEvents.filter(e => new Date(e.detected_at).getTime() >= sixHoursAgo).length;
  
  let regime = cityAvailShare === null ? 'UNKNOWN' : 'NORMAL';
  if (cityAvailShare !== null && cityAvailShare < 0.60) {
    regime = cityAvailShare < 0.30 ? 'CITY_SHORTAGE' : 'LOCAL_SHORTAGE';
    if (restores6h >= 2 && restores6h > disappears6h) regime = 'RECOVERY';
  }
  
  // Если много подтвержденных потерь — усиливаем сигнал дефицита
  if (cityConfirmedLoss > cityKnown * 0.4) regime = 'DEEP_SHORTAGE'; 

  const lastDisByPair = {};
  for (const e of disappearedEvents) {
    const key = e.station_id + '|' + e.fuel_type;
    const t = new Date(e.detected_at).getTime();
    if (!lastDisByPair[key] || t > lastDisByPair[key]) lastDisByPair[key] = t;
  }

  function nearbyMissing95(st) {
    let missing = 0, total = 0;
    for (const s of stations) {
      if (!isOwn(s) || s.id === st.id) continue;
      const dLat = (s.lat - st.lat) * 111, dLon = (s.lon - st.lon) * 111 * Math.cos(st.lat * Math.PI / 180);
      if (Math.sqrt(dLat * dLat + dLon * dLon) <= 3) {
        total++;
        const o = lastObs[s.id];
        if (o && o.fuel_95_status === false) missing++;
      }
    }
    return { missing: missing, total: total };
  }

  console.log('   Контекст региона: АИ-95 есть на ' + (cityAvailShare === null ? '—' : Math.round(cityAvailShare * 100) + '%') +
              ', режим ' + regime + ', возвратов/исчезновений за 6ч: ' + restores6h + '/' + disappears6h +
              ', глубоких дефицитов: ' + cityConfirmedLoss);

  // Группируем события по (station_id, fuel)
  const restoredByPair = {};
  for (const e of restoredEvents) {
    const key = e.station_id + '|' + e.fuel_type;
    (restoredByPair[key] = restoredByPair[key] || []).push(e.detected_at);
  }
  const disByPair = {};
  for (const e of disappearedEvents) {
    const key = e.station_id + '|' + e.fuel_type;
    (disByPair[key] = disByPair[key] || []).push(e.detected_at);
  }
  const pairsByPair = {}; 
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

  // --- v1.3: эпизоды "исчезло → вернулось" (база k-NN) ---
  const restoredMsByPair = {};
  for (const e of restoredEvents) {
    const key = e.station_id + '|' + e.fuel_type;
    (restoredMsByPair[key] = restoredMsByPair[key] || []).push(new Date(e.detected_at).getTime());
  }
  for (const k of Object.keys(restoredMsByPair)) restoredMsByPair[k].sort((a, b) => a - b);
  
  const stationById = {};
  for (const s of stations) stationById[s.id] = s;
  const disMsAll = disappearedEvents.map(e => ({ st: e.station_id, fuel: e.fuel_type, t: new Date(e.detected_at).getTime() }));
  
  function waveAt(fuel, t) {
    let w = 0;
    for (const x of disMsAll) if (x.fuel === fuel && Math.abs(x.t - t) <= 2 * 3600 * 1000) w++;
    return w;
  }
  function queueBeforeAt(stationId, t) {
    for (const q of queueEvents) if ((q.type === 'queue_high' || q.type === 'queue_appeared') && q.station_id === stationId && q.t <= t && t - q.t <= 90 * 60000) return true;
    return false;
  }
  function queueAgeMin(stationId, nowMs) {
    let lastPos = null, lastNeg = null;
    for (const q of queueEvents) {
      if (q.station_id !== stationId || q.t > nowMs) continue;
      if (q.type === 'queue_high' || q.type === 'queue_appeared') { if (lastPos === null || q.t > lastPos) lastPos = q.t; }
      else { if (lastNeg === null || q.t > lastNeg) lastNeg = q.t; }
    }
    if (lastPos === null || (lastNeg !== null && lastNeg > lastPos)) return null;
    return Math.round((nowMs - lastPos) / 60000);
  }

  const episodes = [];
  for (const [key, disList] of Object.entries(disByPair)) {
    const parts = key.split('|');
    const stId = parts[0], fuel = parts[1];
    const st = stationById[stId];
    const resList = restoredMsByPair[key] || [];
    for (const dis of disList) {
      const disMs = new Date(dis).getTime();
      const res = resList.find(r => r > disMs);
      if (!res) continue;
      const dur = (res - disMs) / 60000;
      if (dur <= 10 || dur >= 7 * 24 * 60) continue;
      const d = new Date(disMs + 3 * 3600 * 1000);
      episodes.push({
        fuel: fuel,
        brand: st ? st.brand : null,
        hour: d.getUTCHours(),
        dow: d.getUTCDay(),
        wave: waveAt(fuel, disMs),
        queueBefore: queueBeforeAt(stId, disMs),
        dur: dur
      });
    }
  }

  function similarEpisodes(st, fuel, disMs) {
    const d = new Date(disMs + 3 * 3600 * 1000);
    const hour = d.getUTCHours(), dow = d.getUTCDay();
    const wave = waveAt(fuel, disMs);
    const qb = queueBeforeAt(st.id, disMs);
    const scored = [];
    for (const e of episodes) {
      if (e.fuel !== fuel) continue;
      const dh = Math.min(Math.abs(e.hour - hour), 24 - Math.abs(e.hour - hour)) / 12;
      const dist = dh + (e.dow === dow ? 0 : 0.5) + Math.abs(e.wave - wave) / 4 +
                   (e.queueBefore === qb ? 0 : 0.7) + (e.brand && st.brand && e.brand === st.brand ? 0 : 0.3);
      scored.push({ dist: dist, e: e });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, 12);
  }
  console.log('   Эпизодов дефицита для k-NN: ' + episodes.length);

  // Существующие прогнозы на сегодня
  const mskNow = new Date(Date.now() + 3 * 3600 * 1000);
  const mskMinutesNow = mskNow.getUTCHours() * 60 + mskNow.getUTCMinutes();
  const todayStr = mskNow.toISOString().slice(0, 10);
  const tomorrowStr = new Date(mskNow.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
const existing = [];
for (let offset = 0; ; offset += 1000) {
  const page = await sbGet(
    '/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&target_date=gte.' + todayStr +
    '&select=id,station_id,fuel_type&order=id.asc&limit=1000&offset=' + offset
  );
  for (const p of page) existing.push(p);
  if (page.length < 1000) break;
}
const existingByKey = {};
for (const p of existing) existingByKey[p.station_id + '|' + p.fuel_type] = p.id;
console.log('   Существующих PENDING-прогнозов (цель >= сегодня): ' + existing.length);

  console.log('5) Строю прогнозы для всех станций региона...');
  let created = 0, updated = 0, skipped = 0, stale = 0;
  const fuels = ['92', '95', 'diesel'];
  const fuelCol = { '92': 'fuel_92_status', '95': 'fuel_95_status', 'diesel': 'diesel_status' };

  for (const st of stations) {
    if (!isOwn(st)) continue;
    
    const fm = lastObs[st.id] ? lastObs[st.id].data_freshness_minutes : null;
    const fmStale = (fm === null || fm === undefined)
      ? !lastNonNullTs[st.id]
      : fm > 7 * 24 * 60;
    if (fmStale) { stale++; continue; }

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
      
      // v1.6 Adjustment: Penalize confidence slightly if state is unstable or suspect
      const curObs = lastObs[st.id];
      if (curObs && curObs.fuel_state === 'SUSPECTED_LOSS') {
          confidence *= 0.9; // Less sure about recovery timing if loss isn't confirmed yet
      }

      confidence = Math.min(0.95, Math.max(0.05, confidence));

      // Модель длительности дефицита
      let expectedRestoreAt = null;
      let baselineRestoreAt = null;
      let knnInfo = null;
      const currentStatus = curObs ? curObs[fuelCol[fuel]] : null;
      
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
          const disappearedAt = lastDisByPair[pairKey] || null;
          if (disappearedAt) {
            const elapsed = (Date.now() - disappearedAt) / 60000;
            
            const knnScored = similarEpisodes(st, fuel, disappearedAt);
            const knn = knnScored.map(x => x.e);
            let knnMedian = null, knnSupport = 0, p2h = null, knnDist = null;
            
            if (knn.length >= 8) {
              knnSupport = knn.length;
              knnMedian = medianOf(knn.map(e => e.dur).sort((a, b) => a - b));
              p2h = Math.round(100 * knn.filter(e => e.dur <= elapsed + 120).length / knn.length);
              knnDist = Math.round(1000 * knnScored.reduce((s, x) => s + x.dist, 0) / knnScored.length) / 1000;
            }
            
            const useDur = knnMedian !== null ? knnMedian : medianOf(pairDurations);
            const remaining = Math.max(5, useDur - elapsed);
            expectedRestoreAt = new Date(Date.now() + remaining * 60000).toISOString();
            
            const baseDur = medianOf(pairDurations);
            baselineRestoreAt = new Date(Date.now() + Math.max(5, baseDur - elapsed) * 60000).toISOString();
            knnInfo = { support: knnSupport, median_dur_min: knnMedian === null ? null : Math.round(knnMedian), p_restore_2h: p2h, mean_dist: knnDist };
          }
        }
      }

      const toMin = Number(to.slice(0, 2)) * 60 + Number(to.slice(3, 5));
      
      // Features Snapshot v1.6
      const nb = nearbyMissing95(st);
      const features = {
        v: 1,
        hour_msk: mskNow.getUTCHours(),
        dow_msk: mskNow.getUTCDay(),
        deficit_age_min: currentStatus === false && lastDisByPair[pairKey]
          ? Math.round((Date.now() - lastDisByPair[pairKey]) / 60000) : null,
        queue_level: curObs && curObs.queue_level ? curObs.queue_level : null,
        queue_trend: queueTrend(st.id),
        queue_age_min: queueAgeMin(st.id, Date.now()),
        city_avail95_pct: cityAvailShare === null ? null : Math.round(cityAvailShare * 100),
        nearby_missing95: nb.missing,
        nearby_total: nb.total,
        restores_6h: restores6h,
        disappears_6h: disappears6h,
        regime: regime,
        knn_support: knnInfo ? knnInfo.support : 0,
        knn_median_dur_min: knnInfo ? knnInfo.median_dur_min : null,
        knn_p_restore_2h: knnInfo ? knnInfo.p_restore_2h : null,
        knn_mean_dist: knnInfo ? knnInfo.mean_dist : null,
        station_state: curObs ? curObs.fuel_state : 'UNKNOWN' // NEW FEATURE
      };

      const row = {
        station_id: st.id,
        fuel_type: fuel,
        from_time: from,
        to_time: to,
        confidence: confidence.toFixed(2),
        based_on_observations: usedCount,
        based_on_stations: basedOnStations,
        prediction_source: source,
        algorithm_version: 'v1.6|' + source,
        target_date: mskMinutesNow <= toMin ? todayStr : tomorrowStr,
        result: 'PENDING',
        features: features,
        model_version: 'v1.1'
      };
      if (expectedRestoreAt) row.expected_restore_at = expectedRestoreAt;
      if (baselineRestoreAt) row.baseline_restore_at = baselineRestoreAt;

      const existId = existingByKey[pairKey];
      if (existId) {
        await sbPatch('predictions?id=eq.' + existId, row);
        updated++;
      } else {
        await sbPost('predictions', [row]);
        created++;
      }
      
      const prelim = source === 'own' && usedCount < MIN_EVENTS_FULL ? ' [предв.]' : '';
      const eta = expectedRestoreAt ? ', ждём ~' + new Date(expectedRestoreAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) + (knnInfo && knnInfo.support ? ' (k-NN ' + knnInfo.support + ', P<2ч ' + knnInfo.p_restore_2h + '%)' : '') : '';
      console.log('   ' + label + ' (' + source + ', станций ' + basedOnStations + '): ' +
        from.slice(0, 5) + '–' + to.slice(0, 5) + ', ' + row.confidence +
        ' (' + usedCount + ' соб.)' + prelim + eta);
    }
  }
  console.log('   Создано: ' + created + ', обновлено: ' + updated + ', пропущено: ' + skipped + ', молчащих станций (>72ч): ' + stale);
  
  if (created > 0 && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: '🔮 КогдаБенз v1.6: появились новые прогнозы (' + created + ' шт)! Учитываем состояния станций.' })
      });
    } catch (e) {}
  }
  console.log('✅ Предиктор v1.6 завершил работу');
}
main().catch(e => { console.error('❌ Ошибка предиктора: ' + e.message); process.exit(1); });