// ===== Предиктор Новороссийска v1.11 (+ отказ от city-пула) =====
// Умное объединение: свои события → по бренду → по городу.
// Модель длительности дефицита: если топливо сейчас исчезло,
// считаем, когда его обычно возвращают.
// v1.2: снапшот признаков в момент прогноза + режим города.
// v1.3: k-NN по эпизодам "исчезло → вернулось" для ETA.
// v1.6: учет состояний (State Machine) для фильтрации шума и оценки глубины кризиса.
// v1.7: день недели в k-NN — круговое расстояние между днями + класс будни/выходные
//       (суббота ближе к воскресенью, чем к понедельнику; пятница и суббота — разные классы).
// v1.8: калибровка уверенности: ночью калибратор сравнивает сырую уверенность с фактом
//       попаданий и пишет таблицу пересчёта в bot_meta; предиктор применяет её утром.
//       Нет таблицы (мало данных) — работаем по сырой уверенности, как раньше.
// v1.10: окно по квантилям 20–80% (вместо медиана ± σ), фильтр привозов по классу
//        дня (будни/выходные), синхронизация окна с ETA при глубоком дефиците.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MIN_EVENTS_PRELIM = 3;
const MIN_EVENTS_FULL = 8;
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
// v1.10: день недели по Москве из ISO-метки (0/6 — выходные)
function isWeIso(iso) {
  const d = new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
  return d.getUTCDay() === 0 || d.getUTCDay() === 6;
}
function medianOf(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
function isOwn(s) {
  return s.lat >= OWN_BOX.lat1 && s.lat <= OWN_BOX.lat2 &&
         s.lon >= OWN_BOX.lon1 && s.lon <= OWN_BOX.lon2;
}
// --- v1.8: калибровка уверенности по таблице из bot_meta ---
let calibPoints = null;
async function loadCalibration() {
  try {
    const cur = await sbGet('/rest/v1/bot_meta?key=eq.calibration_table&select=value');
    if (!cur.length) { console.log('   Таблицы калибровки ещё нет — сырая уверенность'); return; }
    const t = typeof cur[0].value === 'string' ? JSON.parse(cur[0].value) : cur[0].value;
    if (!t || !Array.isArray(t.points) || t.points.length < 2) { console.log('   Таблица калибровки битая — сырая уверенность'); return; }
    if (Date.now() - Date.parse(t.built_at) > 21 * 24 * 3600 * 1000) { console.log('   Таблица калибровки старше 21 дня — сырая уверенность'); return; }
    calibPoints = t.points;
    console.log('   Калибровка применится: таблица от ' + String(t.built_at).slice(0, 10) + ' по ' + t.n + ' проверенным прогнозам');
  } catch (e) { console.log('   Калибровка: ' + e.message + ' — сырая уверенность'); }
}
function calibrate(c) {
  if (!calibPoints) return c;
  const pts = calibPoints;
  if (c <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (c <= pts[i][0]) {
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
      return x1 === x0 ? y1 : y0 + (y1 - y0) * (c - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

async function main() {
  console.log('=== ПРЕДИКТОР v1.11 (State Machine Aware) ===');
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
    const isWe = x => x === 0 || x === 6;
    const scored = [];
    for (const e of episodes) {
      if (e.fuel !== fuel) continue;
      const dh = Math.min(Math.abs(e.hour - hour), 24 - Math.abs(e.hour - hour)) / 12;
      // v1.7: день недели — круговое расстояние (0..3 дня), приведённое к прежней шкале 0..0.5,
      // плюс штраф за границу классов будни/выходные (пятница→суббота — смена ритма)
      const dd = Math.min(Math.abs(e.dow - dow), 7 - Math.abs(e.dow - dow));
      const dist = dh + 0.5 * (dd / 3) + (isWe(e.dow) === isWe(dow) ? 0 : 0.25) + Math.abs(e.wave - wave) / 4 +
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

  console.log('4.9) Читаю таблицу калибровки уверенности...');
  await loadCalibration();
  console.log('5) Строю прогнозы для всех станций региона...');
  let created = 0, updated = 0, skipped = 0, stale = 0, lost_no_city = 0;
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
      const toItem = iso => ({ min: moscowMinutes(iso), we: isWeIso(iso) });
      const ownItems = (restoredByPair[pairKey] || []).map(toItem).sort((a, b) => a.min - b.min);
      const ownCount = ownItems.length;

      let useItems = null, source = null, basedOnStations = 1, usedCount = 0;

      // Попытка 1: свои события
      if (ownCount >= MIN_EVENTS_PRELIM) {
        useItems = ownItems;
        source = 'own';
        usedCount = ownCount;
      }
      // Попытка 2: по бренду
      if (!useItems && st.brand) {
        const brandItems = [];
        const brandStations = new Set();
        for (const s of stations) {
          if (s.brand === st.brand) {
            const its = (restoredByPair[s.id + '|' + fuel] || []).map(toItem);
            if (its.length) { brandItems.push(...its); brandStations.add(s.id); }
          }
        }
        if (brandItems.length >= MIN_EVENTS_FULL) {
          useItems = brandItems.sort((a, b) => a.min - b.min);
          source = 'brand';
          basedOnStations = brandStations.size;
          usedCount = brandItems.length;
        }
      }
      // Попытка 3: по городу — ОТКЛЮЧЕНА v1.11
      // Городской ритм даёт ошибку 8-20 часов (см. анализ 26.09.2026):
      // у разных АЗС привозы в совершенно разное время, "среднее по городу"
      // не подходит никому. Лучше честно сказать "данных мало", чем гадать.
      // Код сохранён в комментарии для отката при необходимости.
      /*
      if (!useItems) {
        const cityItems = [];
        const cityStations = new Set();
        for (const s of stations) {
          if (isOwn(s)) {
            const its = (restoredByPair[s.id + '|' + fuel] || []).map(toItem);
            if (its.length) { cityItems.push(...its); cityStations.add(s.id); }
          }
        }
        if (cityItems.length >= MIN_EVENTS_FULL) {
          useItems = cityItems.sort((a, b) => a.min - b.min);
          source = 'city';
          basedOnStations = cityStations.size;
          usedCount = cityItems.length;
        }
      }
      */
      if (!useItems) {
        // Считаем отдельно: сколько прогнозов потеряли из-за отключения city
        // (если бы city был включён, прогноз бы создался)
        let wouldHaveCity = false;
        if (st.brand) {
          // brand не сработал — значит brandItems.length < MIN_EVENTS_FULL
          // проверяем, хватило бы city
          let cityCount = 0;
          for (const s of stations) {
            if (isOwn(s) && (restoredByPair[s.id + '|' + fuel] || []).length > 0) cityCount++;
          }
          if (cityCount >= 8) wouldHaveCity = true;
        }
        if (wouldHaveCity) lost_no_city++;
        skipped++;
        continue;
      }

      // v1.10: фильтр по классу дня (будни/выходные): субботний ритм привозов
      // отличается от будничного. Фильтруем только когда событий достаточно,
      // иначе остаёмся на смешанном наборе (как раньше).
      const isNowWe = mskNow.getUTCDay() === 0 || mskNow.getUTCDay() === 6;
      if (useItems.length >= MIN_EVENTS_FULL) {
        const sameClass = useItems.filter(x => x.we === isNowWe);
        if (sameClass.length >= MIN_EVENTS_PRELIM) { useItems = sameClass; usedCount = sameClass.length; }
      }
      const useTimes = useItems.map(x => x.min);

      // Окно времени — v1.10: квантили 20–80% вместо «медиана ± σ».
      // При размазанном распределении привозов σ давала окно 10–11 часов,
      // квантили дают 4–6 часов — такое окно уже полезно водителю.
      const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))];
      const fromMin = q(useTimes, 0.20);
      let toMinWin = q(useTimes, 0.80);
      const minWin = 2 * MIN_WINDOW_MIN; // окно уже 30 минут — не окно
      if (toMinWin < fromMin + minWin) toMinWin = fromMin + minWin;
      const from = minutesToTime(fromMin);
      const to = minutesToTime(toMinWin);
      const tightness = 1 / (1 + (toMinWin - fromMin) / 120);

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
      const rawConfidence = confidence;
      confidence = Math.min(0.95, Math.max(0.05, calibrate(confidence)));

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

      // v1.10: синхронизация окна с ETA. Если дефицит глубокий и ETA далеко
      // (больше 8 часов впереди), окно «сегодня днём» противоречило бы ETA
      // «завтра утром» — переставляем окно вокруг часа ETA (±2 часа,
      // в рамках 06:00–23:00). target_date ниже посчитается от нового окна.
      let winFrom = from, winTo = to;
      if (expectedRestoreAt) {
        const hoursUntilEta = (new Date(expectedRestoreAt).getTime() - Date.now()) / 3600000;
        if (hoursUntilEta > 8) {
          const etaMsk = new Date(new Date(expectedRestoreAt).getTime() + 3 * 3600 * 1000);
          const etaMin = etaMsk.getUTCHours() * 60 + etaMsk.getUTCMinutes();
          let wf = Math.max(6 * 60, etaMin - 120);
          let wt = Math.min(23 * 60, etaMin + 120);
          // хотфикс v1.10.1: ночная ETA (раньше ~08:00) выворачивала окно —
          // конец раньше начала (кейс -55 мин на live-странице).
          // Тогда снимаем нижнюю рамку и строим окно вокруг ETA как обычно.
          if (wt < wf + 2 * MIN_WINDOW_MIN) {
            wf = Math.max(0, etaMin - 120);
            wt = Math.min(1439, etaMin + 120);
            if (wt < wf + 2 * MIN_WINDOW_MIN) wt = Math.min(1439, wf + 2 * MIN_WINDOW_MIN);
          }
          winFrom = minutesToTime(wf);
          winTo = minutesToTime(wt);
        }
      }
      const toMin = Number(winTo.slice(0, 2)) * 60 + Number(winTo.slice(3, 5));

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
        station_state: curObs ? curObs.fuel_state : 'UNKNOWN', // NEW FEATURE
        conf_raw: Math.round(rawConfidence * 1000) / 1000 // v1.8: сырая уверенность до калибровки (метка для калибратора)
      };

      const row = {
        station_id: st.id,
        fuel_type: fuel,
        from_time: winFrom,
        to_time: winTo,
        confidence: confidence.toFixed(2),
        based_on_observations: usedCount,
        based_on_stations: basedOnStations,
        prediction_source: source,
        algorithm_version: 'v1.11|' + source,
        target_date: mskMinutesNow <= toMin ? todayStr : tomorrowStr,
        result: 'PENDING',
        features: features,
        model_version: 'v1.2'
      };
      // v1.9: ETA пишем всегда (включая null): иначе при молчании источника
      // (статус null) или возврате топлива в строке остаётся вчерашний
      // expected_restore_at и карточка часами показывает «ожидалось только что»
      row.expected_restore_at = expectedRestoreAt;
      row.baseline_restore_at = baselineRestoreAt;

      const existId = existingByKey[pairKey];
      if (existId) {
        // v1.9: при обновлении не трогаем target_date — прицел выбирается один раз
        // при создании. Иначе вечерний прогон переставит строку на «завтра», и
        // ночной верификатор никогда не поймает закрывшееся окно (кейс 0/77 23.09).
        const patchRow = Object.assign({}, row);
        delete patchRow.target_date;
        await sbPatch('predictions?id=eq.' + existId, patchRow);
        updated++;
      } else {
        await sbPost('predictions', [row]);
        created++;
      }

      const prelim = source === 'own' && usedCount < MIN_EVENTS_FULL ? ' [предв.]' : '';
      const eta = expectedRestoreAt ? ', ждём ~' + new Date(expectedRestoreAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) + (knnInfo && knnInfo.support ? ' (k-NN ' + knnInfo.support + ', P<2ч ' + knnInfo.p_restore_2h + '%)' : '') : '';
      console.log('   ' + label + ' (' + source + ', станций ' + basedOnStations + '): ' +
        winFrom.slice(0, 5) + '–' + winTo.slice(0, 5) + ', ' + row.confidence +
        ' (' + usedCount + ' соб.)' + prelim + eta);
    }
  }
  console.log('   Создано: ' + created + ', обновлено: ' + updated + ', пропущено: ' + skipped + ' (из них потеряно из-за отключения city: ' + lost_no_city + '), молчащих станций (>72ч): ' + stale);

  if (created > 0 && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, 'text': '🔮 КогдаБенз v1.10: появились новые прогнозы (' + created + ' шт)! Окна компактнее: квантили + фильтр дня + синхронизация с ETA.' })
      });
    } catch (e) {}
  }
  console.log('✅ Предиктор v1.11 завершил работу');
}
main().catch(e => { console.error('❌ Ошибка предиктора: ' + e.message); process.exit(1); });