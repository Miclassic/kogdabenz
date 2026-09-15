// ===== Сборщик Новороссийска (v3: РАБОЧАЯ ОСНОВА + очереди и комментарии) =====
// Основа — проверенный код с "паспортом браузера" и повторами. НЕ ЛОМАТЬ.
// Нового только: queue_level в шаге 3, события очередей в шаге 5, шаг 6 (комментарии).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Широкая рамка: Новороссийск + Геленджик + Анапа + Крымск (≈200 км)
// Сбор идёт широко, а на сайте показываем только новороссийские карточки.
const GDEBENZ_URL = 'https://gdebenz.ru/api/stations?lat1=44.40&lon1=37.20&lat2=45.20&lon2=38.60';

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

function fuelNameRu(f) {
  return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : '';
}

async function tg(text) {
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
      body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true })
    });
  } catch (e) { console.log('   ! Телеграм: ' + e.message); }
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
  const nameById = {};
  const wideById = {};
  for (const s of saved) {
    nameById[s.id] = (s.name || 'АЗС') + (s.address ? ' · ' + s.address : '');
    wideById[s.id] = !(s.lat >= 44.60 && s.lat <= 44.85 && s.lon >= 37.55 && s.lon <= 38.05);
  }
  const tgLines = [];

  console.log('3) Достаю последние наблюдения для сравнения...');
  const ids = saved.map(s => s.id);
  const lastByStation = {};
  const recentByStation = {};
  if (ids.length) {
    const last = await sbGet(
      '/rest/v1/observations?station_id=in.(' + ids.map(i => '"' + i + '"').join(',') +
      ')&order=timestamp.desc&limit=2000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level'
    );
    for (const o of last) {
      (recentByStation[o.station_id] = recentByStation[o.station_id] || []).push(o);
      if (!lastByStation[o.station_id]) lastByStation[o.station_id] = o;
    }
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
    // === NEW === очередь появилась / исчезла
    const prevQueue = prev.queue_level === 'high';
    const nowQueue = row.queue_level === 'high';
    if (!prevQueue && nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_appeared', fuel_type: null, confidence: 0.7, source: 'observation' });
    if (prevQueue && !nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_gone', fuel_type: null, confidence: 0.7, source: 'observation' });
  }
  if (events.length) await sbPost('events', events);
  console.log('   Событий обнаружено: ' + events.length);
  for (const e of events) tgLines.push(
    eventNameRu(e.event_type) +
    (e.fuel_type ? ' (' + fuelNameRu(e.fuel_type) + ')' : '') +
    ' — ' + (nameById[e.station_id] || 'АЗС') + (wideById[e.station_id] ? ' (регион)' : '')
  );

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
    for (const e of commentEvents) tgLines.push(eventNameRu(e.event_type) + ' — ' + (nameById[e.station_id] || 'АЗС') + ' (из комментария)');
  }
  // === ШАГ 7: превращаем народные отметки user_feedback в события ===
  console.log('7) Обрабатываю народные отметки...');
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
          ? (f.queue_size === 'large' ? 0.9 : f.queue_size === 'medium' ? 0.75 : f.queue_size === 'small' ? 0.6 : 0.7)
          : 0.85,
      source: 'user_feedback'
    }));
    await sbPost('events', fbEvents);
    for (const e of fbEvents) tgLines.push(eventNameRu(e.event_type) + (e.fuel_type ? ' (' + fuelNameRu(e.fuel_type) + ')' : '') + ' — ' + (nameById[e.station_id] || 'АЗС') + ' (народная отметка)');
    const ids = unprocessed.map(f => f.id).join(',');
    await sbPatch('user_feedback?id=in.(' + ids + ')', { processed_at: new Date().toISOString() });
    console.log('   Народных отметок превращено в события: ' + fbEvents.length);
  } else {
    console.log('   Новых народных отметок нет');
  }
  
  // === ШАГ УБОРКИ: удаляем наблюдения старше 30 дней, чтобы база не раздувалась ===
  console.log('8) Убираю старые наблюдения (старше 30 дней)...');
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  try {
    const delRes = await fetch(
      SUPABASE_URL + '/rest/v1/observations?timestamp=lt.' + cutoff,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
          Prefer: 'return=minimal'
        }
      }
    );
    console.log('   Уборка: HTTP ' + delRes.status);
  } catch (e) {
    console.log('   ! Уборка не прошла: ' + e.message);
  }
  
  if (tgLines.length) {
    await tg('⚡ КогдаБенз, события (' + tgLines.length + '):\n' + tgLines.slice(0, 10).join('\n'));
  }
  console.log('✅ Цикл завершён');
}

main().catch(e => { console.error('❌ Ошибка: ' + e.message); process.exit(1); });