const SUPABASE_URL = 'https://api.kogdabenz.ru';
const SUPABASE_KEY = 'eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJyb2xlIjogImFub24iLCAiaXNzIjogImtvZ2RhYmVueiIsICJpYXQiOiAxNzkzMTgwMDg2LCAiZXhwIjogMjEwODU0MDA4Nn0.XgC7MHgl-gwkbPeOUP8rtCR4wt5Ddcw4TDfy5elrzTQ';
const TG_BOT_USERNAME = 'kogdabenz_alert_bot'; // без @, например KogdaBenzAlertBot
const LOGO_FALLBACK = "<svg class='ic ic-l'><use href='#i-pump'/></svg>";
// === лайт-режим для слабого соединения: флаг читаем до первой отрисовки ===
let liteMode = false;
let liteMapOk = false;
let liteAsked = false;
try { liteMode = localStorage.getItem('kbLiteMode') === '1'; } catch (e) {}
if (liteMode) document.body.classList.add('kb-lite');
let deviceId = localStorage.getItem('deviceId');
if (!deviceId) { deviceId = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('deviceId', deviceId); }
// === Минимальная аналитика: анонимные хиты, без персональных данных ===
// session — случайный id в localStorage; события: pageview, panel_view,
// open_station_card, click_where_to_go, feedback_submit, top3_loaded,
// advisor_open, visibility_hidden/visible, heartbeat, session_end.
// Отправка пачками по 5 или раз в 4 сек; при скрытии вкладки — fetch keepalive.
// Важно: быстрый уход после показа топ-3 — часто УСПЕХ, а не отказ.
// Поэтому отдельно копим: общее время сеанса, видимое время, последнее действие.
let sessionId = localStorage.getItem('kbSession');
if (!sessionId) { sessionId = 'ses_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('kbSession', sessionId); }
const utmParams = (() => {
  const q = new URLSearchParams(location.search);
  return { s: q.get('utm_source'), m: q.get('utm_medium'), c: q.get('utm_campaign') };
})();
let hitQueue = [];
let hitTimer = null;
let sessionStartMs = Date.now();
let visibleSinceMs = document.hidden ? null : Date.now();
let visibleMs = 0;
let lastActivityAt = Date.now();
let sessionEndSent = false;
let top3LoadedSent = false;

function track(event, panel, stationId, durationSec, extra) {
  // extra — только для внутренней логики. В site_hits пишем ТОЛЬКО известные колонки,
  // иначе PostgREST отвергнет всю пачку (нет visible_sec/note в таблице).
  const now = Date.now();
  let dur = durationSec;
  if (dur == null) dur = Math.round((now - sessionStartMs) / 1000);
  // для visibility/session_end в duration_sec кладём видимое время, если передали
  if (extra && extra.visible_sec != null &&
      (event === 'session_end' || event === 'visibility_hidden' || event === 'visibility_visible' || event === 'heartbeat')) {
    // формат: общее_сек * 10000 + видимые_сек  (до ~2.7 ч укладывается в int)
    const vis = Math.max(0, Math.min(9999, Math.round(extra.visible_sec)));
    const tot = Math.max(0, Math.min(9999, Math.round(dur)));
    dur = tot * 10000 + vis;
  }
  const row = {
    session_id: sessionId,
    event: event,
    referrer: document.referrer || null,
    utm_source: utmParams.s, utm_medium: utmParams.m, utm_campaign: utmParams.c,
    city_key: (typeof userCityKey !== 'undefined' ? userCityKey : null),
    offline: (typeof offlineMode !== 'undefined' && offlineMode === true),
    panel: panel === undefined ? null : panel,
    station_id: stationId || null,
    duration_sec: dur
  };
  hitQueue.push(row);
  if (hitQueue.length >= 5) { flushHits(false); return; }
  if (!hitTimer) hitTimer = setTimeout(() => flushHits(false), 4000);
}

function flushHits(keepalive) {
  if (hitTimer) { clearTimeout(hitTimer); hitTimer = null; }
  if (!hitQueue.length) return;
  const rows = hitQueue; hitQueue = [];
  fetch(SUPABASE_URL + '/rest/v1/site_hits', {
    method: 'POST',
    keepalive: !!keepalive,
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows)
  }).catch(() => {});
}

// активность пользователя (не скролл-спам: только фиксируем время последнего действия)
['pointerdown', 'touchstart', 'keydown'].forEach(function (evName) {
  window.addEventListener(evName, function () { lastActivityAt = Date.now(); }, { passive: true });
});

// heartbeat раз в 45 сек, только пока вкладка видима и была активность за 2 мин
setInterval(function () {
  if (document.hidden) return;
  const idleMs = Date.now() - lastActivityAt;
  if (idleMs > 120000) return;
  const visSec = Math.round((visibleMs + (visibleSinceMs ? Date.now() - visibleSinceMs : 0)) / 1000);
  track('heartbeat', null, null, null, { visible_sec: visSec });
}, 45000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (visibleSinceMs != null) {
      visibleMs += Date.now() - visibleSinceMs;
      visibleSinceMs = null;
    }
    const durationSec = Math.round((Date.now() - sessionStartMs) / 1000);
    const visSec = Math.round(visibleMs / 1000);
    track('visibility_hidden', null, null, durationSec, { visible_sec: visSec });
    if (!sessionEndSent && durationSec > 3 && durationSec < 7200) {
      sessionEndSent = true;
      track('session_end', null, null, durationSec, { visible_sec: visSec });
    }
    flushHits(true);
    return;
  }
  // вернулись во вкладку
  visibleSinceMs = Date.now();
  lastActivityAt = Date.now();
  sessionEndSent = false;
  track('visibility_visible', null, null, null, {
    visible_sec: Math.round(visibleMs / 1000)
  });
  checkAdvicePoll();
  if (offlineMode && !refreshing) manualRefresh(true);
  refreshTgLink();
});
let allStations = [], allObservations = [], allPredictions = [], allFeedback = [], allEvents = [], allCounts = [], allHourly = [], localIdsGlobal = [], fuelHourly = [];
let geoRequested = false; // флаг: запрос к GPS уже отправлен
let geoFailed = false; // GPS не ответил за таймаут: не крутим спиннер вечно
let allQueueEvents = [];
let allScores = [], scoreMap = {};
let allEvents7 = [];
let allWaveEvents = [];
let lastWaveStats = null;
let allLastPrice = {}, priceHourly = [];
let queueEpisodes = [];
async function dbQueryOnce(path) {
  // таймаут 30 сек: на слабом LTE мегабайтная страница прогнозов не успевала
  // за 20 сек и роняла всю загрузку; зависание всё равно = ошибка со снимком.
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(SUPABASE_URL + path, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, signal: ctrl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.overload = (r.status === 429 || r.status >= 500); throw e; }
    return r.json();
  } finally { clearTimeout(tm); }
}
// мобильная сеть допускает единичные обрывы пакетов: раньше ЛЮБОЙ из 13
// параллельных запросов ронял всю загрузку в «Нет связи» при живом интернете.
// Теперь у каждого запроса есть вторая попытка после паузы 1.5 сек.
async function dbQuery(path) {
  try {
    return await dbQueryOnce(path);
  } catch (e) {
    // база перегружена (5xx/429): мгновенный повтор только усилит лавину —
    // отступаем дольше и с разбросом, чтобы толпа не била синхронно
    if (e && e.overload) {
      await new Promise(res => setTimeout(res, 2500 + Math.random() * 3000));
      return await dbQueryOnce(path);
    }
    await new Promise(res => setTimeout(res, 1500));
    return await dbQueryOnce(path);
  }
}
// постраничное чтение таблиц, переросших лимит Supabase в 1000 строк:
// страницы по 1000 со стабильным порядком, пока страница не придёт неполной
async function dbQueryAll(path, orderCol) {
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await dbQuery(path + sep + 'order=' + (orderCol || 'id') + '.asc&limit=1000&offset=' + offset);
    for (const r of page) out.push(r);
    if (page.length < 1000) break;
  }
  return out;
}
async function dbInsert(table, rows, stId) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 20000);
  try {
    // Если передан один объект, оборачиваем его в массив (PostgREST требует массив)
    const payload = Array.isArray(rows) ? rows : [rows];
    
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
    return true;
  } finally {
    clearTimeout(tm);
  }
}
async function dbInsertReturning(table, row) {
const ctrl = new AbortController();
const tm = setTimeout(() => ctrl.abort(), 20000);
try {
const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
method: 'POST',
headers: {
apikey: SUPABASE_KEY,
Authorization: 'Bearer ' + SUPABASE_KEY,
'Content-Type': 'application/json',
Prefer: 'return=representation'
},
body: JSON.stringify([row])
});
if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
return await r.json();
} finally {
clearTimeout(tm);
}
}
async function dbDelete(table, filter) {
const ctrl = new AbortController();
const tm = setTimeout(() => ctrl.abort(), 20000);
try {
const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + filter, {
method: 'DELETE',
headers: {
apikey: SUPABASE_KEY,
Authorization: 'Bearer ' + SUPABASE_KEY,
Prefer: 'return=minimal'
}
});
if (!r.ok) throw new Error('HTTP ' + r.status);
return true;
} catch (e) { return false; } finally { clearTimeout(tm); }
}
function escapeHtml(v) { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function time5(v) { if (!v) return '—'; const s = String(v); return s.length >= 5 ? s.substring(0,5) : s; }
function fuelLabel(f) { return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : 'топливо'; }
function icon(n, cls) { return '<svg class="ic ' + (cls || '') + '"><use href="#' + n + '"/></svg>'; }
function fuelHtml(ok, trust) {
  if (ok === null || ok === undefined) return '<span class="unknown"><span class="dot gray"></span>нет данных</span>';
  if (ok) {
    // наличие утверждаем только свежим И достоверным снимком источника
    // (свежесть ≤6 ч + машина состояний против блефа чужих отметок)
    if (trust === false) return '<span class="unknown"><span class="dot gray"></span>не подтверждён</span>';
    return '<span class="yes"><span class="dot green"></span>есть</span>';
  }
  return '<span class="no"><span class="dot red"></span>нет</span>';
}
function getPrediction(pred) {
  if (!pred) return { time: 'Пока нет прогноза', confidence: 0, note: 'Нужно больше наблюдений, чтобы понять ритм этой АЗС.', eta: null };
  const confidence = Math.max(0, Math.min(100, Math.round((pred.confidence || 0) * 100)));
  const src = pred.prediction_source || (pred.algorithm_version || '').split('|')[1] || 'own';
  const stationsN = pred.based_on_stations || 1;
  const obsN = pred.based_on_observations || 0;
  let note = 'На основе ';
  if (src === 'own') note += obsN + ' наблюдений этой АЗС.';
  else if (src === 'brand') note += obsN + ' наблюдений ' + stationsN + ' похожих АЗС того же бренда.';
  else if (src === 'city') note += obsN + ' наблюдений ' + stationsN + ' АЗС Новороссийска.';
  else note += obsN + ' наблюдений.';
  let eta = null;
  if (pred.expected_restore_at) {
    const diffMin = Math.round((new Date(pred.expected_restore_at).getTime() - Date.now()) / 60000);
    // окно ещё в будущем (цель завтра или начало окна сегодня ещё не настало) —
    // ETA «только что» ему противоречит: честно показываем само окно
    // (кейс 04.10: окно 09:00, а карточка писала «ожидалось только что»)
    const nowMsk = new Date(Date.now() + 3 * 3600 * 1000);
    const todayStr = nowMsk.toISOString().slice(0, 10);
    const nowMin = nowMsk.getUTCHours() * 60 + nowMsk.getUTCMinutes();
    const winMin = Number(String(pred.from_time).slice(0, 2)) * 60 + Number(String(pred.from_time).slice(3, 5));
    const windowFuture = (pred.target_date && pred.target_date > todayStr) || (pred.target_date === todayStr && nowMin < winMin);
    if (windowFuture) eta = null;
    else if (diffMin > 0) eta = diffMin < 60 ? 'через ' + diffMin + ' мин' : diffMin < 1440 ? 'через ~' + Math.round(diffMin / 60) + ' ч' : 'через ~' + Math.round(diffMin / 1440) + ' дн';
    else if (diffMin >= -90) eta = 'ожидалось только что';
    // ETA, просроченное больше чем на 1.5 ч, — несвежее (источник замолчал
    // или строку давно не обновляли): «только что» не показываем,
    // карточка честно падает на текст окна прогноза
  }
  return { time: time5(pred.from_time) + ' — ' + time5(pred.to_time), confidence, note, eta };
}
const BRAND_LOGOS = { lukoil:'lukoil.png', rosneft:'rosneft.png', ufimneft:'ufimneft.png', gazpromneft:'gazpromneft.png', rusoil:'rusoil.png', pnb:'pnb.png', tnk:'tnk.png', export:'export.png', petrol:'petrol.png' };
function brandKey(st) {
  const t = String(st.brand || st.name || '').toLowerCase();
  if (t.includes('лукойл') || t.includes('lukoil')) return 'lukoil';
  if (t.includes('газпром') || t.includes('gazprom')) return 'gazpromneft';
  if (t.includes('роснефть') || t.includes('rosneft')) return 'rosneft';
  if (t.includes('русойл') || t.includes('rusoil')) return 'rusoil';
  if (t.includes('пнб') || t.includes('pnb')) return 'pnb';
  if (t.includes('уфимнефть') || t.includes('ufimneft')) return 'ufimneft';
  if (t.includes('тнк') || t.includes('татнефть') || t.includes('tnk') || t.includes('tatneft')) return 'tnk';
  if (t.includes('экспорт') || t.includes('export')) return 'export';
  if (t.includes('петрол') || t.includes('petrol')) return 'petrol';
  return null;
}
function stationLogo(st) {
  const k = brandKey(st);
  if (!k || !BRAND_LOGOS[k]) return LOGO_FALLBACK;
  // Добавляем строгие width и height, чтобы браузер заранее знал размер места под логотип
  return '<img src="' + BRAND_LOGOS[k] + '" alt="" width="36" height="36" style="width:100%;height:100%;object-fit:contain;" onerror="this.outerHTML=LOGO_FALLBACK">';
}
const BRAND_COLORS = { lukoil:'#d7263d', rosneft:'#0b62b8', ufimneft:'#009a4e', gazpromneft:'#0079c2', rusoil:'#e05a2b', pnb:'#7b5cd6', tnk:'#f08c00', export:'#c2405a', petrol:'#2f9e44' };
let allLastObs = {};
function getLastObservations() {
  if (Object.keys(allLastObs).length) return allLastObs;
  const r = {}; for (const o of allObservations) if (!r[o.station_id]) r[o.station_id] = o; return r;
}
function getFreshnessMin(o) {
  if (!o) return null;
  // Если есть готовое поле, используем его
  if (o.data_freshness_minutes !== null && o.data_freshness_minutes !== undefined) {
    return Number(o.data_freshness_minutes);
  }
  // Если его нет, но есть timestamp — считаем разницу в минутах прямо в JS
  if (o.timestamp) {
    return Math.max(0, Math.round((Date.now() - new Date(o.timestamp).getTime()) / 60000));
  }
  return null;
}
function pickPrediction(stationId, obs) {
  const preds = allPredictions.filter(p => p.station_id === stationId && p.result === 'PENDING');
  if (!preds.length) return null;
  const missing = [];
  if (obs && obs.fuel_92_status === false) missing.push('92');
  if (obs && obs.fuel_95_status === false) missing.push('95');
  if (obs && obs.diesel_status === false) missing.push('diesel');
  for (const f of missing) { const p = preds.find(x => x.fuel_type === f); if (p) return p; }
  return preds.find(x => x.fuel_type === '95') || preds[0];
}
function confPercent(obs) {
  const m = getFreshnessMin(obs);
  if (m === null) return null;
  return Math.max(8, Math.round(95 * Math.exp(-m / 720)));
}
function fuelConfLine(obs, status) {
  const c = confPercent(obs);
  if (status === null || status === undefined) {
    const m = getFreshnessMin(obs);
    if (m === null) return '—';
    const t = m < 60 ? m + ' мин' : m < 1440 ? Math.round(m / 60) + ' ч' : Math.round(m / 1440) + ' дн';
    return 'данные источника: ' + t + ' назад';
  }
  return '≈ ' + (status ? c : Math.max(3, 100 - c)) + '%';
}
// === вердикт-плашка карточки АЗС: мгновенный ответ водителю ===
function agoRu(min) {
  if (min === null || min === undefined) return 'времени нет';
  if (min < 60) return min + ' мин назад';
  if (min < 1440) return Math.round(min / 60) + ' ч назад';
  return Math.round(min / 1440) + ' дн назад';
}
function priceShort(id, col) {
  const p = allLastPrice[id];
  return p && p[col] !== null && p[col] !== undefined ? Number(p[col]).toFixed(1) + ' ₽' : 'цена —';
}
// === мини-инфографика колонок фактов: полоски за 24 часа ===
// Очередь: часы, когда на станции был активен её собственный эпизод очереди.
// Нет эпизодов за сутки вовсе — полоска светлая: сутки спокойные.
function queueStripHtml(stationId) {
  if (!queueEpisodes.length) return '';
  const nowMs = Date.now();
  let cells = '';
  for (let i = 23; i >= 0; i--) {
    const hEnd = nowMs - i * 3600000;
    const hStart = hEnd - 3600000;
    let on = false;
    for (const e of queueEpisodes) {
      if (e.station_id !== stationId) continue;
      const s = new Date(e.started_at).getTime();
      const en = e.ended_at ? new Date(e.ended_at).getTime() : nowMs;
      if (s < hEnd && en > hStart) { on = true; break; }
    }
    cells += '<i class="' + (on ? 'on' : '') + (i === 0 ? ' now' : '') + '"></i>';
  }
  return '<span class="cf-strip">' + cells + '</span>';
}
// Источник: часы, когда источник видел станцию (снимки station_hourly за сутки).
// Зелёная ячейка = снимок был, светлая = источник молчал: видно, почему строка
// «Обновлено» именно такая и можно ли ей верить.
function seenStripHtml(stationId) {
  const seen = {};
  let any = false;
  for (const r of allHourly) {
    if (r.station_id !== stationId) continue;
    any = true;
    const h = new Date(r.hour).getHours();
    seen[h] = (seen[h] || 0) + (Number(r.total) || 0);
  }
  if (!any) return '';
  const nowH = new Date().getHours();
  let cells = '';
  for (let i = 23; i >= 0; i--) {
    const h = (nowH - i + 24) % 24;
    cells += '<i class="' + (seen[h] ? 'seen' : '') + (i === 0 ? ' now' : '') + '"></i>';
  }
  return '<span class="cf-strip">' + cells + '</span>';
}
function createGraph(stationId) {
  const rows = allHourly.filter(h => h.station_id === stationId).sort((a, b) => new Date(a.hour) - new Date(b.hour)).slice(-14);
  const points = rows.length ? rows : Array.from({ length: 14 }, (_, i) => ({ hour: new Date(Date.now() - (13 - i) * 3600000).toISOString(), total: 0, available_95: 0 }));
  const ratios = points.map(p => p.total ? p.available_95 / p.total : 0);
  const max = Math.max(1, ...ratios);
  return points.map((p, index) => {
    const ratio = p.total ? p.available_95 / p.total : 0;
    const height = p.total ? Math.max(6, Math.round(ratio / max * 46)) : 5;
    let cls = 'bar';
    if (p.total && ratio >= .7) cls += ' good';
    if (p.total && ratio <= .3) cls += ' bad';
    if (index === points.length - 1 && p.total) cls += ' current';
    return '<div class="bar-wrap"><div class="' + cls + '" style="height:' + height + 'px"></div></div>';
  }).join('');
}
function lastRestoration(id) {
  const ev = (allEvents || []).filter(e => e.station_id === id).sort((a,b) => new Date(b.detected_at) - new Date(a.detected_at))[0];
  if (!ev || !ev.detected_at) return 'ещё не было';
  const d = new Date(ev.detected_at);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const hh = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  if (days <= 0) return 'сегодня, ' + hh;
  if (days === 1) return 'вчера, ' + hh;
  return days + ' дн назад, ' + hh;
}
// короткая версия для плитки карточки: день без времени (время уйдёт в факт подсказки)
function lastRestorationShort(id) { return lastRestoration(id).replace(/, \d{2}:\d{2}$/, ''); }
function accuracyLabel(id) {
  const v = allPredictions.filter(p => p.station_id === id && p.is_verified);
  if (v.length < 10) return 'мало данных';
  return Math.round(v.filter(p => p.result === 'SUCCESS').length / v.length * 100) + '%';
}
function accuracyShort(id) { return accuracyLabel(id); }
function isSoon(pred) {
  if (!pred || !pred.from_time) return false;
  const [h, m] = pred.from_time.split(':').map(Number);
  const diff = (h * 60 + m) - (new Date().getHours() * 60 + new Date().getMinutes());
  return diff <= 120 && diff >= -60;
}
function recentFeedback(stationId) {
  const all = allFeedback.filter(f => f.station_id === stationId);
  if (!all.length) return 'Пока отметок нет.';
  // старше 24 часов не показываем: вчерашние пакеты уходят из карточки
  const since = Date.now() - 24 * 3600 * 1000;
  const items = all.filter(f => new Date(f.created_at).getTime() >= since);
  if (!items.length) return 'Отметок за последние 24 часа нет.';
  // группируем отметки по пакетам отправки (ключ — минута created_at),
  // показываем все факты пакета, а не первые три строки
  const batches = {};
  for (const f of items) {
    const key = String(f.created_at).slice(0, 16);
    (batches[key] = batches[key] || []).push(f);
  }
  const fuelShort = t => t === '92' ? 'АИ-92' : t === '95' ? 'АИ-95' : 'дизель';
  const queueShort = { small: '2–3', medium: '4–6', large: '7+', huge: '100+' };
  // те же плашки, что на панели точности: иконка слева, время и факты в центре,
  // очередь или привоз — цветным бейджем справа
  return Object.keys(batches).sort().reverse().slice(0, 2).map(k => {
    const g = batches[k];
    const minutes = Math.max(0, Math.round((Date.now() - new Date(g[0].created_at).getTime()) / 60000));
    const ago = minutes < 60 ? minutes + ' мин' : Math.round(minutes / 60) + ' ч';
    const onSite = g.filter(f => f.verified_on_site).length;
    // факты — цветные плитки с иконкой: число/пометка в своём квадратике,
    // смысл читается по цвету и знаку, а не по голому зелёному/красному тексту
    const tiles = [];
    for (const f of g) if (f.feedback_type === 'available') tiles.push('<span class="fb-fact yes">' + icon('i-check', 'ic-s') + fuelShort(f.fuel_type) + '</span>');
    for (const f of g) if (f.feedback_type === 'unavailable') tiles.push('<span class="fb-fact no">' + icon('i-cross', 'ic-s') + fuelShort(f.fuel_type) + '</span>');
    for (const f of g) if (f.feedback_type === 'queue') tiles.push('<span class="fb-fact queue">' + icon('i-queue', 'ic-s') + 'очередь ' + (queueShort[f.queue_size] || '') + '</span>');
    for (const f of g) if (f.feedback_type === 'delivery') tiles.push('<span class="fb-fact inf">' + icon('i-truck', 'ic-s') + 'привезли</span>');
    for (const f of g) if (f.feedback_type === 'free') tiles.push('<span class="fb-fact yes">' + icon('i-check', 'ic-s') + 'свободно</span>');
    for (const f of g) if (f.feedback_type === 'in_queue') tiles.push('<span class="fb-fact queue">' + icon('i-queue', 'ic-s') + 'в очереди сейчас</span>');
    const comment = (g.find(f => f.comment_text) || {}).comment_text || '';
    const hasFuel = g.some(f => f.feedback_type === 'available' || f.feedback_type === 'unavailable');
    const ids = g.map(f => f.id).join(',');
    const mine = g.some(f => f.device_id === deviceId);
    const repBtn = (!mine && !isReported(ids)) ? '<button class="acc-rep" data-ids="' + ids + '" onclick="repTap(this)" aria-label="Пожаловаться на отметку">' + icon('i-flag', 'ic-s') + '</button>' : '';
    return '<div class="acc-last folk">' +
      '<span class="folk-head">' + icon(hasFuel ? 'i-pump' : 'i-queue') +
      '<span class="acc-last-txt"><b>' + ago + ' назад' + (onSite ? '   с места: ' + onSite : '') + '</b></span>' + repBtn + '</span>' +
      '<span class="fb-facts">' + tiles.join('') + '</span>' +
      (comment ? '<span class="fb-comment">«' + escapeHtml(comment) + '»</span>' : '') + '</div>';
  }).join('');
}
// === Жалоба на отметку: двухтаповая кнопка на народной плашке ===
// 1-й тап — взвод (краснеет), 2-й — отправка жалобы в feedback_reports.
// Коллектор в следующем цикле увидит 2 жалобы от разных device_id —
// удалит отметку и её события. Свои отметки не жалуются (кнопки нет).
function reportedIds() {
  try { return JSON.parse(localStorage.getItem('kbReported') || '[]'); } catch (e) { return []; }
}
function isReported(idsStr) {
  const done = reportedIds();
  return idsStr.split(',').some(id => done.includes(id));
}
function repTap(btn) {
  if (btn.disabled) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    setTimeout(() => {
      if (btn.dataset.armed && !btn.disabled) {
        delete btn.dataset.armed;
        btn.classList.remove('armed');
      }
    }, 4000);
    return;
  }
  delete btn.dataset.armed;
  btn.classList.remove('armed');
  btn.disabled = true;
  btn.classList.add('done');
  btn.innerHTML = icon('i-check', 'ic-s');
  const ids = (btn.dataset.ids || '').split(',').filter(Boolean);
  const rows = ids.map(id => ({ feedback_id: String(id), device_id: deviceId }));
  if (!rows.length) return;
  dbInsert('feedback_reports', rows).catch(() => {
    try {
      const q = JSON.parse(localStorage.getItem('kbRepQueue') || '[]');
      for (const r of rows) q.push(r);
      localStorage.setItem('kbRepQueue', JSON.stringify(q));
    } catch (e) {}
  });
  try {
    const done = reportedIds();
    for (const id of ids) if (!done.includes(id)) done.push(id);
    localStorage.setItem('kbReported', JSON.stringify(done));
  } catch (e) {}
}
async function flushReportQueue() {
  try {
    const q = JSON.parse(localStorage.getItem('kbRepQueue') || '[]');
    if (!q.length) return;
    await dbInsert('feedback_reports', q);
    localStorage.setItem('kbRepQueue', '[]');
  } catch (e) {}
}
// === Карточка «город живёт» при входе: что делали другие и чем помогли твои отметки ===
// «Подтвердили N водителей»: чужие device_id с тем же вердиктом по тому же
// топливу той же АЗС в пределах ±60 мин от вашей отметки. «Источник подтвердил»:
// в течение 2 ч после вашей отметки источник показал тот же статус в наблюдении.
function myImpact() {
  const mine = allFeedback.filter(f => f.device_id === deviceId);
  let coVotes = 0, srcMatch = 0;
  for (const m of mine) {
    if (m.feedback_type !== 'available' && m.feedback_type !== 'unavailable') continue;
    const mt = new Date(m.created_at).getTime();
    const devs = new Set();
    for (const f of allFeedback) {
      if (f.id === m.id || f.device_id === deviceId) continue;
      if (f.station_id !== m.station_id || f.fuel_type !== m.fuel_type || f.feedback_type !== m.feedback_type) continue;
      if (Math.abs(new Date(f.created_at).getTime() - mt) <= 60 * 60000) devs.add(f.device_id);
    }
    coVotes += devs.size;
    const col = m.fuel_type === '92' ? 'fuel_92_status' : m.fuel_type === '95' ? 'fuel_95_status' : 'diesel_status';
    const want = m.feedback_type === 'available';
    for (const o of allObservations) {
      if (o.station_id !== m.station_id) continue;
      const ot = new Date(o.timestamp).getTime();
      if (ot < mt || ot - mt > 2 * 3600 * 1000) continue;
      if (o[col] === want) { srcMatch++; break; }
    }
  }
  return { mine: mine, coVotes: coVotes, srcMatch: srcMatch, onSite: mine.filter(f => f.verified_on_site).length };
}
// === Этап 5 концепции: личная надёжность водителя из журнала свидетеля ===
// Сравниваем отметки человека с независимыми свидетелями: народные голоса
// других устройств в пределах часа и снимки источника в течение 2 часов
// (строки confirm/refute в witness_journal со ссылкой на его заявление).
let myRel = null;
async function loadMyReliability() {
  try {
    const mine = await dbQuery('/rest/v1/witness_journal?source_kind=eq.folk&device_id=eq.' + encodeURIComponent(deviceId) + '&select=id,role,created_at&order=created_at.desc&limit=500');
    const myClaims = mine.filter(r => r.role === 'claim');
    const myWitness = mine.filter(r => r.role !== 'claim');
    let conf = 0, ref = 0, srcConf = 0, folkConf = 0;
    if (myClaims.length) {
      const wit = await dbQuery('/rest/v1/witness_journal?linked_claim_id=in.(' + myClaims.map(c => c.id).join(',') + ')&select=role,weight,source_kind&limit=1000');
      for (const w of wit) {
        if (w.role === 'confirm') { conf += Number(w.weight) || 1; if (w.source_kind === 'source') srcConf++; else folkConf++; }
        else if (w.role === 'refute') { ref += Number(w.weight) || 1; }
      }
    }
    const judged = conf + ref;
    myRel = {
      claims: myClaims.length,
      witnessed: myWitness.length,
      confW: Math.round(conf * 10) / 10,
      refW: Math.round(ref * 10) / 10,
      srcConf: srcConf,
      folkConf: folkConf,
      pct: judged > 0 ? Math.round(100 * conf / judged) : null
    };
  } catch (e) { myRel = null; }
}
function myRelHtml() {
  const r = myRel;
  if (!r || !r.claims) return '<div class="life-rel"><b>—</b><span>ваша надёжность как источника<br>пока формируется — отметок ещё нет</span></div>';
  const pct = r.pct !== null ? r.pct + '%' : '—';
  const sub = r.pct !== null
    ? 'отметок ' + r.claims + '   подтверждено ' + r.confW + '   опровергнуто ' + r.refW
    : 'отметок ' + r.claims + '   свидетелей пока нет — цифра формируется';
  return '<div class="life-rel why-tap" onclick="openWhyChip(this,\'reliability\')"><b>' + pct + '</b><span>ваша надёжность как источника<br>' + sub + (r.witnessed ? '<br>сами подтвердили чужих отметок: ' + r.witnessed : '') + '</span></div>';
}
function lifeBars(days, series, colors) {
  const W = 300, H = 46, bw = 26, gap = (W - 7 * bw) / 8;
  const max = Math.max(1, ...series.flat());
  let out = '';
  days.forEach((lbl, i) => {
    const x = gap + i * (bw + gap);
    const w = bw / series.length;
    series.forEach((s, k) => {
      const v = s[i] || 0;
      const h = v ? Math.max(3, Math.round(v / max * 30)) : 2;
      out += '<rect x="' + (x + k * w).toFixed(1) + '" y="' + (H - 12 - h) + '" width="' + (w - 1).toFixed(1) + '" height="' + h + '" rx="2" fill="' + colors[k] + '" opacity=".85"/>';
    });
    out += '<text x="' + (x + bw / 2) + '" y="' + (H - 2) + '" font-size="7.5" fill="rgba(235,243,255,.65)" text-anchor="middle">' + lbl + '</text>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:' + H + 'px;display:block">' + out + '</svg>';
}
function renderLifePop() {
  const pop = document.getElementById('lifePop');
  if (!pop) return;
  const since24 = Date.now() - 24 * 3600 * 1000;
  const ev7 = (typeof allEvents7 !== 'undefined' && allEvents7) ? allEvents7 : [];
  const ev24 = ev7.filter(e => new Date(e.detected_at).getTime() >= since24);
  const src24 = ev24.filter(e => e.source !== 'user_feedback');
  const folk24 = ev24.filter(e => e.source === 'user_feedback').length;
  const rest = src24.filter(e => e.event_type === 'fuel_restored').length;
  const dis = src24.filter(e => e.event_type === 'fuel_disappeared').length;
  const qev = src24.filter(e => e.event_type === 'queue_appeared' || e.event_type === 'queue_high').length;
  const fb24 = allFeedback.filter(f => new Date(f.created_at).getTime() >= since24);
  const onSite24 = fb24.filter(f => f.verified_on_site).length;
  const days = [], srcS = [], folkS = [], myS = [];
  for (let i = 6; i >= 0; i--) {
    const d0 = new Date(Date.now() - i * 86400000);
    const same = t => new Date(t).toDateString() === d0.toDateString();
    days.push(String(d0.getDate()).padStart(2, '0'));
    srcS.push(ev7.filter(e => e.source !== 'user_feedback' && same(e.detected_at)).length);
    folkS.push(ev7.filter(e => e.source === 'user_feedback' && same(e.detected_at)).length);
    myS.push(allFeedback.filter(f => f.device_id === deviceId && same(f.created_at)).length);
  }
  const imp = myImpact();
  const mine24 = imp.mine.filter(f => new Date(f.created_at).getTime() >= since24).length;
  pop.innerHTML = '<div class="hello-title">Город живёт   ваша польза</div>' +
    '<div class="life-card"><div class="life-card-head"><span class="life-card-ico city">' + icon('i-pump') + '</span>' +
    '<span class="life-card-t"><b>Обстановка в городе   24 часа</b><span>что видели источник и водители за сутки</span></span></div>' +
    '<div class="rc-chips">' +
    '<span class="rc-chip yes">' + icon('i-check', 'ic-s') + 'топливо вернулось ' + rest + '</span>' +
    '<span class="rc-chip no">' + icon('i-cross', 'ic-s') + 'кончилось ' + dis + '</span>' +
    '<span class="rc-chip queue">' + icon('i-queue', 'ic-s') + 'очереди ' + qev + '</span>' +
    '<span class="rc-chip info">' + icon('i-heart', 'ic-s') + 'отметок водителей ' + folk24 + '</span>' +
    '<span class="rc-chip info">' + icon('i-pin', 'ic-s') + 'с места ' + onSite24 + '</span>' +
    '</div>' +
    '<div class="hm-wrap" style="margin-top:8px"><div class="mini-cap" style="margin-bottom:4px">7 дней   источник и водители</div>' +
    lifeBars(days, [srcS, folkS], ['#397cff', '#19b77a']) +
    '<div class="hm-legend" style="margin-top:4px"><span><i style="background:#397cff"></i>источник</span><span><i style="background:#19b77a"></i>водители</span></div></div></div>' +
    '<div class="life-card"><div class="life-card-head"><span class="life-card-ico you">' + icon('i-heart') + '</span>' +
    '<span class="life-card-t"><b>Ваш вклад</b><span>чем ваши отметки помогли городу</span></span></div>' +
    '<div class="life-big why-tap" onclick="openWhyChip(this,\'impact\')">' + imp.coVotes + ' <small>водителей подтвердили ваши отметки</small></div>' +
    '<div class="rc-chips" style="margin-top:6px">' +
    '<span class="rc-chip info">' + icon('i-heart', 'ic-s') + 'ваших отметок ' + imp.mine.length + ' (за 24ч: ' + mine24 + ')</span>' +
    '<span class="rc-chip yes">' + icon('i-check', 'ic-s') + 'источник подтвердил ' + imp.srcMatch + '</span>' +
    '<span class="rc-chip info">' + icon('i-pin', 'ic-s') + 'с места ' + imp.onSite + '</span>' +
    '</div>' +
    myRelHtml() +
    (imp.mine.length ? '<div class="hm-wrap" style="margin-top:8px"><div class="mini-cap" style="margin-bottom:4px">ваши отметки   7 дней</div>' + lifeBars(days, [myS], ['#7c6dff']) + '</div>' : '') + '</div>' +
    '<div class="recent">Подтверждение водителями — когда кто-то ещё отметил то же топливо с тем же вердиктом на той же АЗС в пределах часа от вашей отметки. Подтверждение источником — когда в течение 2 часов после вашей отметки источник показал тот же статус. Это честные измеримые числа, без придуманных «просмотров».</div>' +
    '<button class="cta-btn" style="width:100%;margin-top:10px" onclick="closeLife()">Отлично</button>';
  }
let lifeTries = 0;
function maybeLifePop() {
  const pop = document.getElementById('lifePop');
  const back = document.getElementById('lifeBack');
  if (!pop || !back || pop.classList.contains('open')) return;
  if (offlineMode) return;
  if (adviceShownThisSession) return; // один полезный попап в день
  // ждём загруженные данные, иначе карточка была бы вся из нулей
  if (!allStations.length) { if (lifeTries++ < 10) setTimeout(maybeLifePop, 3000); return; }
  // не лезем поверх приветствия, установки, опроса и карточки АЗС
  const openNow = ['helloBack', 'installBack', 'pollBack', 'sheetBack', 'wnBack', 'mailBack', 'adviceBack', 'lifeBack'].some(id => {
    const el = document.getElementById(id);
    return el && el.classList.contains('open');
  });
  if (openNow) { if (lifeTries++ < 10) setTimeout(maybeLifePop, 4000); return; }
  try {
    renderLifePop();
  } catch (e) {
    console.log('Карточка «город живёт» не собралась: ' + e.message);
    return;
  }
  pop.classList.add('open');
  back.classList.add('open');
}
function closeLife() {
  const pop = document.getElementById('lifePop');
  const back = document.getElementById('lifeBack');
  if (pop) pop.classList.remove('open');
  if (back) back.classList.remove('open');
}
// === Окно «куда ехать»: 3 лучших варианта при входе, раз в сутки ===
// Продуктивнее всего — сразу дать водителю «едь вот сюда». Малозаметнее всего —
// не плодить попапы: если окно показали, «город живёт» и «что нового» в этот
// заход не лезут (adviceShownThisSession). Факт и прогноз разведены цветом.
// Очереди не приукрашиваем: только реальные сигналы, иначе — «не видно».
// Обучение переиспользует готовый контур: клик = learnFromAction('advice_click'),
// исход поездки доучивает personalScore через «тень заправки» и опрос.
let adviceShownThisSession = false, adviceList = [], adviceTries = 0;
let adviceReactions = {}, adviceReactionMine = {}; // кэш счётчиков реакций и моего голоса
let adviceReactionIds = {}; // id записей реакций и народных отметок для возможности отмены
function adviceNowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function adviceWinState(pred) {
  if (!pred || !pred.from_time) return 'none';
  const f = Number(String(pred.from_time).slice(0, 2)) * 60 + Number(String(pred.from_time).slice(3, 5));
  const t = Number(String(pred.to_time).slice(0, 2)) * 60 + Number(String(pred.to_time).slice(3, 5));
  const m = adviceNowMin();
  if (m >= f && m <= t) return 'open';
  if (f - m > 0 && f - m <= 180) return 'soon';
  return 'later';
}
function adviceQueueText(id, o) {
  const lq = liveQueueCount(id);
  if (lq) return lq + ' вод. стоят в очереди сейчас';
  const high = o && o.queue_level === 'high';
  const age = queueAgeMin(id);
  if (high && age != null) return 'очередь стоит ' + ageRu(age);
  if (high) return 'очередь сейчас';
  if (demandOf(id) >= 12) return 'очередь была недавно';
  return 'очередей не видно';
}
// цена focus-топлива + дельта к городу (метрика объективности выбора)
function adviceFocusFuel(it) {
  if (it.kind === 'forecast') return it.pred ? it.pred.fuel_type : '95';
  return it.f === 'yes' ? '95' : it.f === 'part' ? '92' : 'diesel';
}
function advicePriceMeta(st, it) {
  const fl = adviceFocusFuel(it);
  const col = fl === '92' ? 'price_92' : fl === '95' ? 'price_95' : 'price_diesel';
  const cityKey = fl === '92' ? 'p92' : fl === '95' ? 'p95' : 'pdt';
  const p = allLastPrice[st.id];
  const v = p ? p[col] : null;
  if (v === null || v === undefined) return '<span class="adv-meta">' + icon('i-chart', 'ic-s') + 'цена: нет данных</span>';
  const cur = priceHourly.find(r => r[cityKey] !== null && r[cityKey] !== undefined);
  let dTxt = '', cls = '';
  if (cur) {
    const dv = Number(v) - Number(cur[cityKey]);
    if (dv < -0.049) { dTxt = ' −' + Math.abs(dv).toFixed(1) + '₽ к городу'; cls = ' cheap'; }
    else if (dv > 0.049) { dTxt = ' +' + dv.toFixed(1) + '₽ к городу'; cls = ' dear'; }
    else dTxt = ' ±0₽ к городу';
  }
  return '<span class="adv-meta' + cls + '">' + icon('i-chart', 'ic-s') + '<b class="adv-price-v">' + fuelLabel(fl) + ' ' + Number(v).toFixed(1) + '₽</b>' + (dTxt ? '<i class="adv-price-d">' + dTxt.trim() + '</i>' : '') + '</span>';
}
// когда источник последний раз видел станцию (10-мин цикл коллектора)
function adviceFreshMeta(o) {
  const m = getFreshnessMin(o); // <-- ИЗМЕНЕНО ТУТ
  if (m === null) return '<span class="adv-meta">' + icon('i-clock', 'ic-s') + 'отметка: нет времени</span>';
  const t = m < 60 ? m + ' мин' : m < 1440 ? Math.round(m / 60) + ' ч' : Math.round(m / 1440) + ' дн';
  const cls = m <= 30 ? ' fresh-ok' : '';
  return '<span class="adv-meta' + cls + '">' + icon('i-clock', 'ic-s') + 'отметка ' + t + ' назад</span>';
}
// вторая, «тщательная» сверка по всем метрикам среди показанных трёх:
// наличие топлива, уверенность прогноза, свежесть, цена к городу, расстояние, очередь.
// Победитель = «наш выбор» (золотая плашка), ставится первым.
function fullChoiceScore(it) {
  const cl = (x, a, b) => Math.max(a, Math.min(b, x));
  const fuel = it.kind === 'forecast' ? 0 : it.f === 'yes' ? 1 : it.f === 'part' ? 0.6 : 0.3;
  const conf = it.pred ? cl(getPrediction(it.pred).confidence / 100, 0, 1) : 0;
  const m = getFreshnessMin(it.o);
  const fresh = m === null ? 0.5 : cl(1 - m / 360, 0, 1);
  const fl = adviceFocusFuel(it);
  const col = fl === '92' ? 'price_92' : fl === '95' ? 'price_95' : 'price_diesel';
  const cityKey = fl === '92' ? 'p92' : fl === '95' ? 'p95' : 'pdt';
  const p = allLastPrice[it.st.id]; const pv = p ? p[col] : null;
  const cur = priceHourly.find(r => r[cityKey] !== null && r[cityKey] !== undefined);
  const price = (pv == null || !cur) ? 0 : cl(-(Number(pv) - Number(cur[cityKey])) / 3, -1, 1);
  const dist = it.km != null ? cl(1 - it.km / 15, 0, 1) : 0.5;
  const qn = demandOf(it.st.id) + liveQueueCount(it.st.id) * 6;
  const queue = cl(1 - qn / 60, 0, 1);
  let s = 30 * fuel + 22 * conf + 16 * fresh + 14 * price + 12 * dist + 6 * queue;
if (it.unverified) s -= 50; // «не точно» не отбирает «наш выбор» у проверенных
return s;
}
function rankByFinalMetrics(list) {
  for (const it of list) it._fs = fullChoiceScore(it);
  list.sort((a, b) => b._fs - a._fs);
const our = list.find(x => !x.unverified);
if (our) our.ourChoice = true;
  return list;
}
function adviceCoreScore(st, o, km, pred) {
  let s = 0;
  const f = pinKey(o) !== 'unknown' ? pinKey(o) : (folkPinState(st.id, o) || 'unknown');
  if (f === 'yes') s += 300; else if (f === 'part') s += 200; else if (f === 'diesel') s += 80;
  if (km != null) s -= Math.min(25, km * 1.5);
  const sc = demandOf(st.id);
  s -= sc >= 50 ? 40 : sc >= 30 ? 20 : sc >= 12 ? 8 : 0;
  s -= liveQueueCount(st.id) * 3;
  const fmCore = getFreshnessMin(o); 
  if (fmCore !== null) s += Math.max(0, 30 - Math.round(fmCore / 12));
  if (pred) { const ws = adviceWinState(pred); if (ws === 'open') s += 15; else if (ws === 'soon') s += 8; }
  if (getDriverTrips().length >= MIN_TRIPS_FOR_ADVICE) {
    const brand = brandKey(st); const pr = getDriverPrefs();
    if (brand && pr.brandCounts && pr.brandCounts[brand]) s += 10;
    const h = new Date().getHours(); if (pr.hourCounts && pr.hourCounts[h]) s += 4;
  }
  return s;
}
// Окно актуальности голосов в советнике: после смены статуса пары И не старше 24 ч.
// Раньше счётчики жили, пока не придёт fuel_restored/disappeared — на «зависших»
// станциях (данные 2–4 дня) цифры 6/4 и 11/1 висели вечно и держали карточку в топе.
const ADVICE_VOTE_TTL_MS = 24 * 3600 * 1000;
function adviceVoteSince(stationId, fuel) {
  const ch = pairLastChange(stationId, fuel || '95');
  return Math.max(Date.now() - ADVICE_VOTE_TTL_MS, ch || 0);
}

// сырая загрузка реакций для всех станций города (нужна до buildAdviceList)
async function loadAdviceReactionsForListRaw() {
	const cityIds = cityStationList().map(s => s.id);
	if (!cityIds.length) return;
	const now = Date.now();
	const ttlFloor = now - ADVICE_VOTE_TTL_MS;
	// подтянем народные голоса из allFeedback (быстро, без запроса)
	const chMap = pairChangeMap();
for (const stId of cityIds) {
if (!adviceReactions[stId]) adviceReactions[stId] = { like_count:0, dislike_count:0, doubt_count:0, folk_yes:0, folk_no:0, folk_fuel: {} };
// сбрасываем счётчики — иначе при повторной загрузке они накапливаются
adviceReactions[stId].like_count = 0;
adviceReactions[stId].dislike_count = 0;
adviceReactions[stId].doubt_count = 0;
// голоса считаем ПО ТОПЛИВУ: после смены статуса пары И не старше 24 ч
const ff = {};
for (const f of allFeedback) {
if (f.station_id !== stId) continue;
if (f.feedback_type !== 'available' && f.feedback_type !== 'unavailable') continue;
const fuel = f.fuel_type || '95';
const ch = chMap[stId + '|' + fuel] || 0;
const t = new Date(f.created_at).getTime();
if (ch && t <= ch) continue; // голос до «вернулось/пропало» — сгорел
if (t < ttlFloor) continue; // старше суток — тоже сгорел
const g = ff[fuel] = ff[fuel] || { yes: 0, no: 0 };
if (f.feedback_type === 'available') g.yes++; else g.no++;
}
adviceReactions[stId].folk_fuel = ff;
let fy = 0, fn = 0;
for (const k of Object.keys(ff)) { fy += ff[k].yes; fn += ff[k].no; }
adviceReactions[stId].folk_yes = fy;
adviceReactions[stId].folk_no = fn;
		// мой голос — только актуальный (в окне TTL)
		const mine = {};
		for (const f of allFeedback) {
			if (f.station_id !== stId || f.device_id !== deviceId) continue;
			const t = new Date(f.created_at).getTime();
			if (t < ttlFloor) continue;
			const fuel = f.fuel_type || '95';
			const ch = chMap[stId + '|' + fuel] || 0;
			if (ch && t <= ch) continue;
			if (f.feedback_type === 'available') mine.folk_yes = true;
			else if (f.feedback_type === 'unavailable') mine.folk_no = true;
		}
		adviceReactionMine[stId] = mine;
	}
	try { const mm = JSON.parse(localStorage.getItem('kbAdvMine') || '{}'); for (const k of Object.keys(mm)) adviceReactionMine[k] = Object.assign({}, mm[k], adviceReactionMine[k] || {}); } catch (e) {}
	// реакции с сервера — тоже только за 24 ч
	try {
		const sinceIso = new Date(ttlFloor).toISOString();
		const rows = await dbQuery('/rest/v1/advice_reactions?station_id=in.(' + cityIds.join(',') + ')&created_at=gte.' + sinceIso + '&select=station_id,reaction_type,device_id,created_at&order=created_at.desc&limit=2000');
		for (const r of (rows || [])) {
			const s = adviceReactions[r.station_id];
			if (!s) continue;
			s[r.reaction_type + '_count'] = (s[r.reaction_type + '_count'] || 0) + 1;
			if (r.device_id === deviceId) {
				const m = adviceReactionMine[r.station_id] = adviceReactionMine[r.station_id] || {};
				m[r.reaction_type] = true;
			}
		}
	} catch (e) { console.log('advice_reactions: ' + e.message); }
}
const ap = document.getElementById('advicePop');
if (ap && ap.classList.contains('open')) renderAdvicePop();
// Источник утверждает топливо, но снимок несвежий/недостоверный: запасной ключ
// для советника. Null — если топлива по источнику нет вовсе, станция скрыта как раньше.
function stalePinKey(o) {
  if (!o) return null;
  if (o.fuel_95_status === true) return 'yes';
  if (o.diesel_status === true && o.fuel_92_status !== true) return 'diesel';
  if (o.fuel_92_status === true) return 'part';
  return null;
}
function staleWarnText(o) {
  const m = getFreshnessMin(o);
  return m === null
    ? 'Источник давно не присылал новых данных по этой станции. Метки водителей помогут проверить обстановку.'
    : 'Данные по этой станции пришли ' + agoRu(m) + '. С тех пор обстановка могла измениться — метки водителей помогут проверить.';
}
function buildAdviceList(){
	const e = getLastObservations(),
        uLoc = loadUserLocation(),
        t = cityStationList(),
        n = [],
        s = [];
  const nows = [], fcs = [], stales = [];
  for (const st of t) {                          // было city
    if (!Number.isFinite(Number(st.lat)) || !Number.isFinite(Number(st.lon))) continue;
    const o = e[st.id];                          // было last[st.id]

    const trust = o ? availTrustworthy(o) : false;
    let fpk = o && pinKey(o) !== 'unknown' ? pinKey(o) : 'unknown';

    // ЕСЛИ ИСТОЧНИК МОЛЧИТ/ВРЕТ, СМОТРИМ НАРОД ЗА 24 ЧАСА
    if (!trust) {
      const fc95 = folkConsensus24(st.id, '95');
      const fc92 = folkConsensus24(st.id, '92');
      const fcdt = folkConsensus24(st.id, 'diesel');
      if (fc95?.verdict === 'yes') fpk = 'yes';
else if (fc92?.verdict === 'yes') fpk = 'part';
else if (fcdt?.verdict === 'yes') fpk = 'diesel';
    }

    if (fpk === 'unknown' || fpk === 'no') {
  // Третья ступень: источник говорит «есть», но снимок несвежий или
  // подозрительный — станцию не скрываем совсем, а кладём в запасной список
  // с пометкой «не точно». Народный консенсус и проверенные факты важнее.
  const spk = stalePinKey(o);
  if (!spk) {
    console.log('advice skip fpk:', st.name, 'fpk=' + fpk, 'trust=' + trust, 'o=', o);
    continue;
  }
  let kmS = null;
  if (uLoc) {
    const dLat = 111 * (Number(st.lat) - uLoc.lat);
    const dLon = 111 * (Number(st.lon) - uLoc.lon) * Math.cos(uLoc.lat * Math.PI / 180);
    kmS = Math.sqrt(dLat * dLat + dLon * dLon);
  }
  const predS = pickPrediction(st.id, o);
  stales.push({ kind: 'stale', st, o, pred: predS, km: kmS, f: spk, unverified: true, score: 500 + adviceCoreScore(st, o, kmS, predS) });
  continue;
}

    let km = null;
    if (uLoc) {
      const dLat = 111 * (Number(st.lat) - uLoc.lat);
      const dLon = 111 * (Number(st.lon) - uLoc.lon) * Math.cos(uLoc.lat * Math.PI / 180);
      km = Math.sqrt(dLat * dLat + dLon * dLon);
    }

    const f = fpk;
    const pred = pickPrediction(st.id, o);

    if (f === 'yes' || f === 'part' || f === 'diesel') {
      nows.push({ kind: 'now', st, o, pred, km, f, score: 1000 + adviceCoreScore(st, o, km, pred) });
    } else if (pred) {
      const g = getPrediction(pred);
      if (g.confidence >= 35) {
        let score = g.confidence;
        if (km != null) score -= Math.min(15, km);
        const sc = demandOf(st.id);
        score -= sc >= 50 ? 20 : sc >= 30 ? 10 : 0;
        score -= liveQueueCount(st.id) * 2;
        fcs.push({ kind: 'forecast', st, o, pred, km, f, score });
      }
    }
  }
  nows.sort((a, b) => b.score - a.score);
fcs.sort((a, b) => b.score - a.score);
stales.sort((a, b) => b.score - a.score);
const out = nows.slice(0, 3);
if (out.length < 3) out.push(...fcs.slice(0, 3 - out.length));
// проверенных вариантов не хватило — додаём «не точные», чтобы водитель не остался без зацепки
if (out.length < 3) out.push(...stales.slice(0, 3 - out.length));
  // фильтр: убираем станции с >=5 отрицаниями с последнего fuel_restored
	const filtered = out.filter(it => {
const rej = isRejected(it.st.id, adviceFocusFuel(it));
if (rej) console.log('advice rejected:', it.st.name, 'rejections=' + countRejections(it.st.id, adviceFocusFuel(it)));
return !rej;
});
	if (filtered.length < out.length) {
		console.log('advice: отфильтровано ' + (out.length - filtered.length) + ' станций по порогу отрицаний');
	}
	return rankByFinalMetrics(filtered.slice(0, 3));
	console.log('advice nows scores:', nows.map(x => x.st.name + ':' + x.score));
console.log('advice final:', filtered.slice(0,3).map(x => x.st.name));
}
function adviceReasons(it) {
  const r = []; const o = it.o;
  if (it.kind === 'now') r.push(it.f === 'yes' ? 'АИ-95 есть' : it.f === 'part' ? 'АИ-92 есть' : 'дизель есть');
  if (it.kind === 'stale') r.push('источник утверждает топливо — данные не свежие');
  if (it.km != null) r.push(it.km < 1 ? 'рядом' : '~' + it.km.toFixed(1) + ' км');
  // УБРАНА СТРОКА: if (demandOf(it.st.id) < 12 && !liveQueueCount(it.st.id) && !(o && o.queue_level === 'high')) r.push('очередей не видно');
  if (it.pred) { const ws = adviceWinState(it.pred); if (ws === 'open') r.push('окно сейчас'); else if (ws === 'soon') r.push('окно скоро'); }
  if (getDriverTrips().length >= MIN_TRIPS_FOR_ADVICE) { const brand = brandKey(it.st); const pr = getDriverPrefs(); if (brand && pr.brandCounts && pr.brandCounts[brand] >= 3) r.push('твой бренд'); }
  return r.map(x => '<span class="adv-why-i">' + escapeHtml(x) + '</span>').join('');
}
// === Реакции на карточках "Куда ехать" ===
// Три эмодзи-реакции + народные голоса. Счётчики глобальные по станции,
// но видны только в советнике. Порог 5 отрицаний (dislike + unavailable)
// с последнего fuel_restored — карточка убирается из списка до нового привоза.
const REJECT_THRESHOLD = 5;
const REACTION_ICON = { like:'i-check', dislike:'i-cross', doubt:'i-help' };
const REACTION_LABEL = { like:'Да, топливо есть', dislike:'Не соответствует', doubt:'Нужно уточнить' };
const REACTION_SHORT = { like:'Да, топливо есть', dislike:'Не соответствует', doubt:'уточнить' };
const DISLIKE_REASONS = [
  { key:'no_fuel', text:'Топлива нет' },
  { key:'queue', text:'Очередь' },
  { key:'price', text:'Цена завышена' },
  { key:'other', text:'Другое' }
];
const DOUBT_REASONS = [
  { key:'old_data', text:'Данные старые' },
  { key:'not_true', text:'Не похоже на правду' },
  { key:'other', text:'Другое' }
];

function countRejections(stationId, fuel) {
const s = adviceReactions[stationId];
if (!s) return 0;
const fn = fuel ? (((s.folk_fuel || {})[fuel] || {}).no || 0) : (s.folk_no || 0);
return (s.dislike_count || 0) + fn;
}
function isRejected(stationId, fuel) { return countRejections(stationId, fuel) >= REJECT_THRESHOLD; }

function renderAdviceReactions(it) {
const stId = it.st.id;
const s = adviceReactions[stId] || { like_count:0, dislike_count:0, doubt_count:0, folk_yes:0, folk_no:0 };
const ff = (s.folk_fuel || {})[adviceFocusFuel(it)] || { yes: 0, no: 0 };
const mine = adviceReactionMine[stId] || {};
const rejected = isRejected(stId, adviceFocusFuel(it));
const rejectWarn = countRejections(stId, adviceFocusFuel(it)) >= 3 && !rejected;
const reactionBtn = (type) => {
const mineKey = type === 'like' ? (mine.like || mine.folk_yes) : type === 'dislike' ? (mine.dislike || mine.folk_no) : mine.doubt;
const mineClass = mineKey ? ' mine' : '';
const rejectClass = rejected ? ' reject' : '';
const cnt = type === 'like' ? (ff.yes || 0) : type === 'dislike' ? (ff.no || 0) : (s[type + '_count'] || 0);
return '<button class="adv-reaction ' + type + mineClass + rejectClass + '" data-st="' + stId + '" data-rt="' + type + '" aria-label="' + REACTION_LABEL[type] + '">' +
icon(REACTION_ICON[type], 'ic-s') +
'<span class="adv-reaction-t">' + REACTION_SHORT[type] + '</span>' +
(cnt > 0 ? '<span class="cnt">' + cnt + '</span>' : '') +
'</button>';
};
const fy = ff.yes || 0, fn = ff.no || 0;
const people = (fy >= 3 && fy > fn) ? '<span class="adv-people">' + icon('i-heart', 'ic-s') + 'водители выбирают   ' + fy + ' голосов за топливо</span>' : '';
let html = '<div class="adv-reactions">' + people +
reactionBtn('like') +
reactionBtn('dislike') +
reactionBtn('doubt');
if (rejectWarn) {
html += '<span class="adv-reject-warn">' + icon('i-cross', 'ic-s') + 'Много отрицаний — карточка может исчезнуть</span>';
}
html += '</div>';
return html;
}

async function loadAdviceReactionsForList(list) {
  if (!list.length) return;
  const ids = list.map(it => it.st.id);
  try {
    const r = await dbQuery('/rest/v1/rpc/advice_reaction_stats?station_id=in.(' + ids.join(',') + ')');
    // RPC возвращает одну строку на station_id — но PostgREST через in() может вернуть массив
    // Безопаснее: запрос по каждой станции отдельно, но для 3 станций — ок
    for (const row of (Array.isArray(r) ? r : [r])) {
      if (row && row.station_id) {
        adviceReactions[row.station_id] = row;
      }
    }
  } catch (e) {
    console.log('advice_reactions load: ' + e.message);
    // фолбэк: считаем народные голоса из allFeedback
    for (const it of list) {
      const stId = it.st.id;
      if (!adviceReactions[stId]) adviceReactions[stId] = { like_count:0, dislike_count:0, doubt_count:0, folk_yes:0, folk_no:0 };
    }
  }
  // подгрузим народные голоса из allFeedback (если RPC не сработал или для свежести)
  // окно: после last change пары И не старше 24 ч — иначе на «зависших» АЗС счётчики вечные
  const ttlFloor = Date.now() - ADVICE_VOTE_TTL_MS;
  for (const it of list) {
    const stId = it.st.id;
    const s = adviceReactions[stId] || { like_count:0, dislike_count:0, doubt_count:0, folk_yes:0, folk_no:0, folk_fuel: {} };
    const focus = adviceFocusFuel(it);
    const since = adviceVoteSince(stId, focus);
    const ff = {};
    let fy = 0, fn = 0;
    for (const f of allFeedback) {
      if (f.station_id !== stId) continue;
      if (f.feedback_type !== 'available' && f.feedback_type !== 'unavailable') continue;
      const t = new Date(f.created_at).getTime();
      if (t < since || t < ttlFloor) continue;
      const fuel = f.fuel_type || '95';
      const g = ff[fuel] = ff[fuel] || { yes: 0, no: 0 };
      if (f.feedback_type === 'available') { g.yes++; fy++; }
      else { g.no++; fn++; }
    }
    s.folk_fuel = ff;
    s.folk_yes = fy;
    s.folk_no = fn;
    adviceReactions[stId] = s;
  }
  // мой голос — только в актуальном окне
  for (const it of list) {
    const stId = it.st.id;
    const focus = adviceFocusFuel(it);
    const since = adviceVoteSince(stId, focus);
    const mine = adviceReactionMine[stId] || {};
    // не затираем like/dislike/doubt с сервера, только folk-флаги
    delete mine.folk_yes;
    delete mine.folk_no;
    for (const f of allFeedback) {
      if (f.station_id !== stId || f.device_id !== deviceId) continue;
      const t = new Date(f.created_at).getTime();
      if (t < since || t < ttlFloor) continue;
      if (f.feedback_type === 'available') mine.folk_yes = true;
      else if (f.feedback_type === 'unavailable') mine.folk_no = true;
    }
    adviceReactionMine[stId] = mine;
  }
}

async function handleAdviceReaction(stationId, type, btn) {
const mine = adviceReactionMine[stationId] || {};
// повторный тап по своей реакции = отмена голоса
if (mine[type]) {
await cancelAdviceReaction(stationId, type);
return;
}
// если реакция не ставилась, но есть народный голос (поставленный вручную), не отменяем
const folkKey = type === 'like' ? 'folk_yes' : type === 'dislike' ? 'folk_no' : null;
if (folkKey && mine[folkKey]) { if (btn) openWhyChip(btn, 'advvote'); return; }
if (type === 'doubt' && mine.doubt) { if (btn) openWhyChip(btn, 'advvote'); return; }
const it = adviceList.find(x => x.st.id === stationId);
if (!it) return;
// 👍 "Класс" — если не в избранном, предлагаем добавить
if (type === 'like' && !isFavorite(stationId)) {
showReactionPopup(it, type);
return;
}
// 👎 "Плохо" — спрашиваем причину
if (type === 'dislike') {
showReactionPopup(it, type);
return;
}
// 🤔 "Сомнение" — спрашиваем что смущает
if (type === 'doubt') {
showReactionPopup(it, type);
return;
}
// если уже в избранном и лайк — просто считаем
submitReaction(it, type, null);
}

async function cancelAdviceReaction(stationId, type) {
const mine = adviceReactionMine[stationId];
if (!mine || !mine[type]) return;
const ids = adviceReactionIds[stationId] || {};
const rec = ids[type] || {};
// удаляем реакцию из базы
if (rec.reactionId) {
await dbDelete('advice_reactions', 'id=eq.' + rec.reactionId);
} else {
// фолбэк: удаляем по фильтрам
await dbDelete('advice_reactions', 'station_id=eq.' + stationId + '&device_id=eq.' + deviceId + '&reaction_type=eq.' + type);
}
// удаляем народную отметку, если она была создана этой реакцией
if (rec.fbId) {
await dbDelete('user_feedback', 'id=eq.' + rec.fbId);
// также удалим из локального allFeedback
const idx = allFeedback.findIndex(f => String(f.id) === String(rec.fbId));
if (idx >= 0) allFeedback.splice(idx, 1);
}
// обновляем локальный кэш
delete mine[type];
if (type === 'like') delete mine.folk_yes;
if (type === 'dislike') delete mine.folk_no;
try {
const mm = JSON.parse(localStorage.getItem('kbAdvMine') || '{}');
if (mm[stationId]) { delete mm[stationId][type]; localStorage.setItem('kbAdvMine', JSON.stringify(mm)); }
} catch (e) {}
const s = adviceReactions[stationId];
if (s) {
s[type + '_count'] = Math.max(0, (s[type + '_count'] || 0) - 1);
if (type === 'like') s.folk_yes = Math.max(0, (s.folk_yes || 0) - 1);
if (type === 'dislike') s.folk_no = Math.max(0, (s.folk_no || 0) - 1);
}
renderAdvicePop();
track('advice_reaction_cancel', null, stationId);
}
function showReactionPopup(it, type) {
const pop = document.getElementById('reactPop');
const back = document.getElementById('reactBack');
if (!pop || !back) return;
const st = it.st;
const emojiIcon = icon(REACTION_ICON[type]);
const label = REACTION_LABEL[type];
let body = '';
if (type === 'like') {
// объяснение пользы избранного
body = '<div class="react-sub">Отличный выбор! Чтобы не искать эту АЗС каждый раз и получать уведомления о привозе топлива — добавьте её в избранное.</div>' +
'<div class="react-opts">' +
'<button class="react-opt" data-fav="1">' +
icon('i-heart') + ' Добавить в избранное и получить уведомление</button>' +
'<button class="react-opt" data-fav="0">' +
icon('i-check') + ' Просто отметить «Да, топливо есть»</button>' +
'</div>';
} else if (type === 'dislike') {
body = '<div class="react-sub">Что не так с этой АЗС? Ваш ответ поможет другим водителям.</div>' +
'<div class="react-opts" id="reactOpts">' +
DISLIKE_REASONS.map(r => '<button class="react-opt" data-r="' + r.key + '" onclick="pickReactReason(this)">' + r.text + '</button>').join('') +
'</div>' +
'<textarea class="react-text" id="reactText" placeholder="Подробности (необязательно)"></textarea>';
} else if (type === 'doubt') {
body = '<div class="react-sub">Что смущает? Такие голоса помогают нам калибровать модель.</div>' +
'<div class="react-opts" id="reactOpts">' +
DOUBT_REASONS.map(r => '<button class="react-opt" data-r="' + r.key + '" onclick="pickReactReason(this)">' + r.text + '</button>').join('') +
'</div>' +
'<textarea class="react-text" id="reactText" placeholder="Подробности (необязательно)"></textarea>';
}
pop.innerHTML = '<div class="react-head"><span class="react-ico">' + emojiIcon + '</span>' +
'<div><div class="react-title">' + label + '</div>' +
'<div class="react-sub">' + escapeHtml(st.name || 'АЗС') + '</div></div></div>' +
body +
'<div class="react-actions">' +
(type === 'like' ? '' : '<button class="cta-btn" id="reactSend" data-send="1" disabled>Отправить</button>') +
'<button class="cta-btn ghost" onclick="closeReactPop()">Отмена</button></div>';
pop.dataset.type = type;
pop.dataset.stationId = st.id;
pop.classList.add('open');
back.classList.add('open');
if (type !== 'like') {
const ta = document.getElementById('reactText');
if (ta) ta.addEventListener('input', () => {
const btn = document.getElementById('reactSend');
if (btn) btn.disabled = !ta.value.trim() && !pop.dataset.reason;
});
}
}
// === клики реакций и попапа через делегирование: id живёт в data-атрибуте,
// inline-onclick больше нет — клик не может «умереть» от кавычек ===
document.addEventListener('click', e => {
const t = e.target;
if (!t || !t.closest) return;
const rb = t.closest('.adv-reaction[data-st]');
if (rb) { handleAdviceReaction(rb.getAttribute('data-st'), rb.getAttribute('data-rt'), rb); return; }
const ro = t.closest('.react-opt[data-fav]');
if (ro) {
const pop = document.getElementById('reactPop');
if (pop) submitReactionFromPopup(pop.dataset.stationId, pop.dataset.type, null, ro.getAttribute('data-fav') === '1');
return;
}
const rs = t.closest('#reactSend[data-send]');
if (rs) {
const pop = document.getElementById('reactPop');
if (pop) submitReactionFromPopup(pop.dataset.stationId, pop.dataset.type);
}
}, true);
function pickReactReason(btn) {
  const pop = document.getElementById('reactPop');
  if (!pop) return;
  btn.parentNode.querySelectorAll('.react-opt').forEach(b => b.classList.toggle('selected', b === btn));
  pop.dataset.reason = btn.dataset.r;
  const ta = document.getElementById('reactText');
  const btn2 = document.getElementById('reactSend');
  if (btn2) btn2.disabled = false;
  if (ta) ta.placeholder = 'Подробности о «' + btn.textContent.trim() + '» (необязательно)';
}

function closeReactPop() {
  const pop = document.getElementById('reactPop');
  const back = document.getElementById('reactBack');
  if (pop) { pop.classList.remove('open'); delete pop.dataset.reason; delete pop.dataset.type; delete pop.dataset.stationId; }
  if (back) back.classList.remove('open');
}

async function submitReactionFromPopup(stationId, type, reason, alsoFavorite) {
  const pop = document.getElementById('reactPop');
  const ta = document.getElementById('reactText');
  const text = ta ? ta.value.trim() : '';
  const finalReason = (pop && pop.dataset.reason) ? pop.dataset.reason : (reason || (text ? 'other' : null));
  const fullReason = text ? (finalReason ? finalReason + ': ' + text : text) : finalReason;

  closeReactPop();

  const it = adviceList.find(x => x.st.id === stationId);
  if (!it) return;

  // если выбрали "добавить в избранное"
  if (alsoFavorite && !isFavorite(stationId)) {
    const favs = getFavorites();
    favs.push(stationId);
    localStorage.setItem('favorites', JSON.stringify(favs));
    syncFavorites();
    refreshTgButton(stationId);
    track('fav_add', null, stationId);
  }

  await submitReaction(it, type, fullReason);
}

async function submitReaction(it, type, reason) {
const stId = it.st.id;
const mine = adviceReactionMine[stId] = adviceReactionMine[stId] || {};
if (mine[type]) return; // уже голосовал
const ids = adviceReactionIds[stId] = adviceReactionIds[stId] || {};
// записываем реакцию
try {
const rows = await dbInsertReturning('advice_reactions', {
station_id: stId, device_id: deviceId,
reaction_type: type, reason: reason || null
});
if (rows && rows.length) ids[type] = { reactionId: rows[0].id, fbId: null };
} catch (e) {
console.log('advice_reaction save: ' + e.message);
}
mine[type] = true;
try { const mm = JSON.parse(localStorage.getItem('kbAdvMine') || '{}'); const mrow = mm[stId] = mm[stId] || {}; mrow[type] = true; localStorage.setItem('kbAdvMine', JSON.stringify(mm)); } catch (e) {}
const s = adviceReactions[stId] = adviceReactions[stId] || { like_count:0, dislike_count:0, doubt_count:0, folk_yes:0, folk_no:0 };
s[type + '_count'] = (s[type + '_count'] || 0) + 1;
// если like — записываем как народную отметку available: реакция вливается в народные голоса
if (type === 'like') {
const onSite = await onSiteFields(it.st);
try {
const fbRows = await dbInsertReturning('user_feedback', Object.assign({
station_id: stId, device_id: deviceId,
feedback_type: 'available', fuel_type: it.f || '95',
queue_size: null, comment_text: null
}, onSite));
if (fbRows && fbRows.length && ids[type]) ids[type].fbId = fbRows[0].id;
} catch (e) {}
mine.folk_yes = true;
s.folk_yes = (s.folk_yes || 0) + 1;
}
// если dislike — сразу записываем как народную отметку unavailable (это усиливает порог)
if (type === 'dislike') {
const onSite = await onSiteFields(it.st);
try {
const fbRows = await dbInsertReturning('user_feedback', Object.assign({
station_id: stId, device_id: deviceId,
feedback_type: 'unavailable', fuel_type: it.f || '95',
queue_size: null, comment_text: reason ? ('реакция: ' + reason) : null
}, onSite));
if (fbRows && fbRows.length && ids[type]) ids[type].fbId = fbRows[0].id;
} catch (e) {}
mine.folk_no = true;
s.folk_no = (s.folk_no || 0) + 1;
}
// перерисовываем советник
renderAdvicePop();
track('advice_reaction', null, stId);
}

async function handleFolkVote(stationId, type) {
  const it = adviceList.find(x => x.st.id === stationId);
  if (!it) return;
  const mine = adviceReactionMine[stationId] = adviceReactionMine[stationId] || {};
  const key = 'folk_' + type;
  if (mine[key]) return;

  const onSite = await onSiteFields(it.st);
  try {
    await dbInsert('user_feedback', [Object.assign({
      station_id: stationId, device_id: deviceId,
      feedback_type: type === 'yes' ? 'available' : 'unavailable',
      fuel_type: it.f || '95', queue_size: null, comment_text: 'голос в советнике'
    }, onSite)]);
  } catch (e) {}

  mine[key] = true;
  const s = adviceReactions[stationId] = adviceReactions[stationId] || { like_count:0, dislike_count:0, doubt_count:0, folk_yes:0, folk_no:0 };
  s[key] = (s[key] || 0) + 1;

  renderAdvicePop();
  track('advice_folk_vote', null, stationId);
}
// Получаем последнее событие по станции для карточки "Куда ехать"
function getLatestEventHtml(stId) {
  let events = [];
  
  // События источника
  for (const e of allWaveEvents) {
    if (e.station_id !== stId) continue;
    
    const isDiesel = e.fuel_type === 'diesel';
    const verbRestored = isDiesel ? ' вернулся' : ' вернулось';
    const verbGone = isDiesel ? ' пропал' : ' пропало';
    
    events.push({
      t: new Date(e.detected_at).getTime(),
      text: fuelLabel(e.fuel_type) + (e.event_type === 'fuel_restored' ? verbRestored : verbGone),
      icon: e.event_type === 'fuel_restored' ? 'i-check' : 'i-cross',
      cls: e.event_type === 'fuel_restored' ? 'g' : 'r'
    });
  }
  
  // События от водителей (народ)
  for (const f of allFeedback) {
    if (f.station_id !== stId) continue;
    let text = '', icon = 'i-check', cls = 'g';
    if (f.feedback_type === 'available') { text = 'народ: ' + fuelLabel(f.fuel_type) + ' есть'; }
    else if (f.feedback_type === 'unavailable') { text = 'народ: ' + fuelLabel(f.fuel_type) + ' нет'; icon = 'i-cross'; cls = 'r'; }
    else if (f.feedback_type === 'delivery') { text = 'народ: привезли'; icon = 'i-truck'; cls = 'b'; }
    else if (f.feedback_type === 'queue' || f.feedback_type === 'in_queue') { text = 'народ: очередь'; icon = 'i-queue'; cls = 'o'; }
    else continue;
    events.push({ t: new Date(f.created_at).getTime(), text: text, icon: icon, cls: cls });
  }
  
  if (!events.length) return '';
  events.sort((a, b) => b.t - a.t); // Берем самое свежее
  const last = events[0];
  const d = new Date(last.t);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  
  const color = last.cls === 'g' ? '#12855c' : last.cls === 'r' ? '#c2403f' : last.cls === 'o' ? '#c26a2a' : '#2465ee';
  return `<span class="adv-meta adv-evt">` +
`<svg class="ic ic-s" style="color:${color}"><use href="#${last.icon}"/></svg> ` +
`${escapeHtml(last.text)}<i class="adv-evt-t">${hm}</i></span>`;
}
// точка пришла (GPS или ручная) — обновляем открытое окно «куда ехать» живо:
// расстояния вместо «определяю…» без закрытия и повторного открытия окна
function renderAdviceIfOpen() {
const ap = document.getElementById('advicePop');
if (ap && ap.classList.contains('open')) renderAdvicePop();
}
function renderAdvicePop() {
	const pop = document.getElementById('advicePop'); if (!pop) return false;
	adviceList = buildAdviceList();
	if (!adviceList.length) return false;
	const nAdv = adviceList.length;
	const nWord = nAdv === 1 ? 'Пока один лучший вариант' : nAdv === 2 ? 'Два лучших варианта' : 'Три лучших варианта';
	const cards = adviceList.map((it, i) => {
		const st = it.st, o = it.o;
		const badge = it.kind === 'now'
? '<span class="adv-badge yes">' + icon('i-check', 'ic-s') + 'есть сейчас</span>'
: it.kind === 'stale'
? '<span class="adv-badge stale">' + icon('i-help', 'ic-s') + 'не точно — стоит проверить</span>'
: '<span class="adv-badge fc">' + icon('i-clock', 'ic-s') + 'вернётся по прогнозу</span>';
		const fuels = ['92', '95', 'diesel'].map(fl => {
			const col = fl === '92' ? 'fuel_92_status' : fl === '95' ? 'fuel_95_status' : 'diesel_status';
			let v = o ? o[col] : null;
			if (v === null || v === undefined) {
				const fc = folkConsensus24(st.id, fl);
				if (fc?.verdict === 'yes') v = true;
				else if (fc?.verdict === 'no') v = false;
			}
			const tr = o ? availTrustworthy(o) : true;
if (!tr && v === true && it.kind !== 'stale') v = null;
			if (v === null && it.kind === 'now') {
				if (fl === '92' && it.f === 'part') v = true;
				if (fl === '95' && it.f === 'yes') v = true;
				if (fl === 'diesel' && it.f === 'diesel') v = true;
			}
			const cls = v === true ? 'yes' : v === false ? 'no' : '';
return '<span class="adv-fc ' + cls + '"><b>' + fuelLabel(fl) + '</b><i>' + (v === true ? 'есть' : v === false ? 'нет' : 'нет данных') + '</i></span>';
		}).join('');
		const dist = it.km == null
? (geoFailed ? ' <span class="adv-meta warn">' + icon('i-pin','ic-s') + 'геолокация недоступна — расстояние скрыто</span>'
: geoRequested ? ' <span class="adv-meta warn" style="color:#397cff"><span class="ob-spin" style="width:12px;height:12px;border-width:2px;margin-right:6px;vertical-align:-2px"></span>определяю местоположение…</span>'
: ' <span class="adv-meta warn">' + icon('i-pin','ic-s') + 'включи геолокацию</span>')
: ' <span class="adv-meta">' + icon('i-pin','ic-s') + (it.km < 1 ? Math.round(it.km*1000)+' м' : it.km.toFixed(1)+' км') + '</span>';
		const q = adviceQueueText(st.id, o);
		let win = '';
		if (it.pred) { const g = getPrediction(it.pred); win = '<span class="adv-win">' + icon('i-clock', 'ic-s') + 'окно ' + (g.eta ? ('≈ ' + g.eta) : g.time) + '   ' + g.confidence + '%</span>'; }
		const price = advicePriceMeta(st, it);
		const lastEvt = getLatestEventHtml(st.id);
		const our = it.ourChoice ? '<span class="adv-our">' + icon('i-star', 'ic-s') + 'наш выбор</span>' : '';
		const near = (it.km != null && it.km < 1 && !it.ourChoice)
			? '<span class="adv-our" style="background:#eef4ff !important; color:#2465ee !important; border:1px solid #bcd4ff !important; box-shadow:0 2px 12px rgba(36,101,238,.3) !important; background-image:none !important;">' + icon('i-pin', 'ic-s') + 'рядом с тобой</span>'
			: '';
		const bk = brandKey(st);
		const wm = (bk && BRAND_LOGOS[bk]) ? '<div class="adv-wm" aria-hidden="true"><img src="' + BRAND_LOGOS[bk] + '" alt=""></div>' : '';
		const reactionsHtml = renderAdviceReactions(it);
		return '<div class="adv-card' + (i === 0 ? ' best' : '') + (it.ourChoice ? ' our' : '') + '">' + wm +
'<div class="adv-top"><span class="adv-rank">' + (i + 1) + '</span>' + '<span class="adv-name">' + escapeHtml(st.name || 'АЗС') + '</span>' + our + near + '</div>' +
'<div class="adv-addr">' + badge + '</div>' +
'<div style="display:flex;align-items:center;gap:6px;margin:3px 0 4px">' +
'<span style="flex:1;min-width:0;font-size:11px;color:#71809c;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(st.address || '') + '</span>' +
'<span style="flex:0 0 auto">' + dist + '</span></div>' +
'<div class="adv-fuelgrid">' + fuels + '</div>' +
'<div class="adv-facts">' + price + lastEvt + win + '</div>' +
(it.unverified ? '<div class="adv-stale-warn">' + icon('i-clock', 'ic-s') + '<span>' + staleWarnText(o) + '</span></div>' : '') +
'<div class="adv-actions"><button class="cta-btn" onclick="adviceRoute(' + i + ')">' + icon('i-truck', 'ic-s') + 'На карте + маршрут</button>' +
'<button class="cta-btn ghost" onclick="adviceCard(' + i + ')">' + icon('i-pump', 'ic-s') + 'Карточка</button>' +
'<button class="cta-btn ghost' + (isFavorite(st.id) ? ' on' : '') + '" onclick="adviceWatch(' + i + ')">' +
icon('i-heart', 'ic-s') + (isFavorite(st.id) ? 'Слежу' : 'Следить за топливом') + '</button></div>' +
reactionsHtml +
'</div>';
	}).join('');
	pop.innerHTML = '<div class="hello-title">Куда ехать прямо сейчас   ' + escapeHtml(userCityName()) + '</div>' +
		'<div class="help-lead" style="margin:4px 0 8px">' + nWord + ' по свежим данным: где топливо есть сейчас, а если нет — где обещают привоз. Очереди не приукрашиваем: показываем что реально видим.' + (adviceList.some(x => x.unverified) ? ' Пометка «не точно — стоит проверить» — данные источника не свежие, проверь перед выездом.' : '') + '</div>' +
		'<div class="adv-cards">' + cards + '</div>' +
		'<div class="recent">Клик по варианту учит подборку под тебя: бренд, часы и исходы поездок. Показываем при каждом заходе — данные каждые 10 минут, топ живой.</div>' +
		'<button class="cta-btn ghost" style="width:100%;margin-top:8px" onclick="closeAdvicePop()">Закрыть</button>';
	const ac = pop.querySelector('.adv-cards');
	if (ac) ac.style.gridTemplateColumns = 'repeat(' + adviceList.length + ',1fr)';
	return true;
}
function maybeAdvicePop() {
  if (adviceShownThisSession) return;
  if (offlineMode) return; // в офлайне не советуем по несвежим данным
  if (!allStations.length) { if (adviceTries++ < 12) setTimeout(maybeAdvicePop, 3000); return; }
  // показываем при каждом заходе: топ-3 живой (данные каждые 10 мин).
  // от двойного показа в одной сессии защищает adviceShownThisSession выше.
  const openNow = ['helloBack', 'installBack', 'pollBack', 'sheetBack', 'wnBack', 'mailBack', 'lifeBack'].some(id => {
    const el = document.getElementById(id); return el && el.classList.contains('open');
  });
  if (openNow) { if (adviceTries++ < 20) setTimeout(maybeAdvicePop, 1500); return; }
  let ok = false;
try { ok = renderAdvicePop(); } catch (e) { console.log('Окно «куда ехать» не собралось: ' + e.message); return; }
  if (!ok) return;
  adviceShownThisSession = true;
  document.getElementById('advicePop').classList.add('open');
  document.getElementById('adviceBack').classList.add('open');
  // советник реально показан водителю; panel = число карточек
  track('advisor_open', adviceList ? adviceList.length : 0);
}
function closeAdvicePop() {
  const pop = document.getElementById('advicePop'); const back = document.getElementById('adviceBack');
  if (pop) pop.classList.remove('open'); if (back) back.classList.remove('open');
  // установка и «что нового» важнее «не показывать вовсе»: дождавшись закрытия
  // совета — зовём их по очереди (установка первой, whatsnew дожмётся installBack)
  setTimeout(maybeInstallPop, 300);
  setTimeout(maybeWhatsNew, 700);
}
function adviceRoute(i) {
  const it = adviceList[i]; if (!it) return; const st = it.st;
  track('click_where_to_go', null, st.id); learnFromAction(st.id, 'advice_click'); rememberAdvice();
  closeAdvicePop(); pagerGo(2); ensureMap();
  const go = () => { if (!mapObj) { setTimeout(go, 150); return; } drawRouteTo(st); maybeFavFollowOffer(st.id); };
  go();
}
function adviceCard(i) {
  const it = adviceList[i]; if (!it) return; const st = it.st;
  track('click_where_to_go', null, st.id); learnFromAction(st.id, 'advice_click'); rememberAdvice();
  // окно НЕ закрываем (просьба): держим до крестика/фона или «на карте + маршрут».
  // Шторку карточки поднимаем поверх окна — детали видны, окно живёт под ними.
  openSheetAboveAdvice(st.id);
}
// «Следить за топливом» прямо из топ-3 — без захода в карточку за сердечком
function adviceWatch(i) {
  const it = adviceList[i]; if (!it) return;
  const id = it.st.id;
  if (isFavorite(id)) {
    toggleFavoriteById(id);
  } else {
    toggleFavoriteById(id);
    track('fav_add_advice', null, id);
  }
  try { renderAdvicePop(); } catch (e) {}
}
// Тихий оффер после маршрута: один раз за сессию на АЗС, не если уже в избранном
function maybeFavFollowOffer(stId) {
  if (!stId || isFavorite(stId)) return;
  try {
    if (sessionStorage.getItem('kbFavOffer_' + stId)) return;
    if (sessionStorage.getItem('kbFavOfferSession') === '1') return;
  } catch (e) {}
  const st = allStations.find(s => s.id === stId);
  const name = st ? (st.name || 'этой АЗС') : 'этой АЗС';
  let bar = document.getElementById('favFollowBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'favFollowBar';
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:88px;z-index:96;background:#fff;border-radius:16px;padding:12px 14px;box-shadow:0 8px 28px rgba(20,40,80,.18);border:1px solid #e4ebf5;display:none;font-family:inherit';
    document.body.appendChild(bar);
  }
  bar.innerHTML =
    '<div style="font-size:13px;font-weight:650;color:#1a2b45;margin-bottom:4px">Сообщить про топливо здесь?</div>' +
    '<div style="font-size:12px;color:#5b6b86;line-height:1.35;margin-bottom:10px">Добавьте «' + escapeHtml(name) + '» в избранное — будет проще следить, когда бензин появится или закончится. Уведомления можно включить отдельно.</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" id="favFollowYes" style="flex:1;min-width:120px;border:0;border-radius:12px;padding:10px 12px;background:#2465ee;color:#fff;font-weight:650;font-size:13px;cursor:pointer">Следить за топливом</button>' +
    '<button type="button" id="favFollowNo" style="border:0;border-radius:12px;padding:10px 12px;background:#eef2f8;color:#5b6b86;font-weight:600;font-size:13px;cursor:pointer">Не сейчас</button>' +
    '</div>';
  bar.style.display = '';
  const close = () => { bar.style.display = 'none'; };
  const yes = document.getElementById('favFollowYes');
  const no = document.getElementById('favFollowNo');
  if (yes) yes.onclick = () => {
    try { sessionStorage.setItem('kbFavOffer_' + stId, '1'); sessionStorage.setItem('kbFavOfferSession', '1'); } catch (e) {}
    if (!isFavorite(stId)) { toggleFavoriteById(stId); track('fav_add_route_offer', null, stId); }
    close();
  };
  if (no) no.onclick = () => {
    try { sessionStorage.setItem('kbFavOffer_' + stId, '1'); sessionStorage.setItem('kbFavOfferSession', '1'); } catch (e) {}
    close();
  };
  setTimeout(() => { if (bar.style.display !== 'none') close(); }, 12000);
}
function openSheetAboveAdvice(id) {
  const st = allStations.find(s => s.id === id); if (!st) return;
  track('open_station_card', null, id); learnFromAction(id, 'card_open');
  const obs = getLastObservations()[id];
  disposeCardMap(); // см. openSheet: глушим карту до перезаписи sheetBody
  document.getElementById('sheetBody').innerHTML = stationCard(st, obs, pickPrediction(id, obs));
  const sheet = document.getElementById('sheet'); const back = document.getElementById('sheetBack');
  if (sheet) { sheet.style.zIndex = '92'; sheet.classList.add('open'); }
  if (back) { back.style.zIndex = '91'; back.classList.add('open'); }
  requestAnimationFrame(() => mountCardMap(st));
}
// === Избранное на сервере + подписка на Телеграм ===
// Сердечко раньше жило только в localStorage — бот о нём не знал. Теперь
// каждый чих избранного синхронизируется rpc fav_sync (debounce 0.8 сек).
let tgLinked = false;
let tgLinkSeen = null; // null = статус ещё не узнавали; переворот false	true трекаем один раз
let favSyncTimer = null;
function syncFavorites() {
  if (favSyncTimer) clearTimeout(favSyncTimer);
  favSyncTimer = setTimeout(() => {
    fetch(SUPABASE_URL + '/rest/v1/rpc/fav_sync', {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_device: deviceId, p_ids: getFavorites() })
    }).catch(() => {});
  }, 800);
}
async function refreshTgLink() {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/tg_link_status', {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_device: deviceId })
    });
    if (r.ok) tgLinked = !!(await r.json());
  } catch (e) {}
  // крючок: связка с Телеграмом подтвердилась, пока сайт открыт (переворот false	true)
  if (tgLinkSeen === false && tgLinked) track('tg_linked');
  tgLinkSeen = tgLinked;
  // перекрашиваем открытую карточку сразу: подключено 	 зелёная плашка без перезагрузки
  document.querySelectorAll('[data-tgstrip]').forEach(el => {
    const st = allStations.find(s => s.id === el.getAttribute('data-tgstrip'));
    if (st) el.outerHTML = tgStrip(st);
  });
  document.querySelectorAll('[data-tgbtn]').forEach(el => {
    const st = allStations.find(s => s.id === el.getAttribute('data-tgbtn'));
    if (st) el.outerHTML = tgButtonHtml(st);
  });
  // открытое окно «Написать нам» сразу узнаёт новый статус связки
  const mailBackEl = document.getElementById('mailBack');
  const mailPopEl = document.getElementById('mailPop');
  if (mailBackEl && mailPopEl && mailBackEl.classList.contains('open') && !mailPopEl.querySelector('.poll-thanks')) renderMailPop();
}
async function tgConnect(fromStationId) {
  track('tg_connect');
  const code = 'kb' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  let ok = true;
  try { await dbInsert('tg_link_codes', [{ code: code, device_id: deviceId }]); } catch (e) { ok = false; }
  if (!ok) { alert('Не удалось создать код связки, попробуйте ещё раз.'); return; }
  window.open('https://t.me/' + TG_BOT_USERNAME + '?start=' + code, '_blank');
  // вернётся из телеграма — обновим статус и плашка станет «уведомления включены»
  setTimeout(refreshTgLink, 5000);
  setTimeout(refreshTgLink, 20000);
}
function tgOpen() { window.open('https://t.me/' + TG_BOT_USERNAME, '_blank'); }
// полоска в карточке: подключиться / уже включено (только для избранных АЗС)
function tgStrip(station) {
  if (!isFavorite(station.id)) return '';
  // бот подключён — зелёное автоподтверждение с галочкой сразу
  if (tgLinked) return '<div class="dg-strip tap tg-on" data-tgstrip="' + station.id + '" style="margin:0 0 8px" onclick="tgOpen()">' + icon('i-check', 'ic-s') + '<span>Уведомления по этой АЗС включены в Телеграме</span></div>';
  return '<div class="dg-strip tap why-tap tg-ask" data-tgstrip="' + station.id + '" style="margin:0 0 8px" onclick="tgConnect()">' + icon('i-spark', 'ic-s') + '<span>Хотите мгновенные уведомления в Телеграм по этой АЗС? Подключить</span></div>';
}
function feedbackPanel(stationId) {
  return '<div id="feedback-' + stationId + '" class="feedback-panel">' +
    '<div class="feedback-question">Что заметили? Можно несколько сразу</div>' +
    '<div class="fb-group"><div class="fb-gl">Топливо есть</div><div class="feedback-grid g3">' +
    ['92','95','diesel'].map(f => '<button class="feedback-option" data-fact="yes" data-fuel="' + f + '" onclick="fbToggle(this)">' + fuelLabel(f) + '</button>').join('') + '</div></div>' +
    '<div class="fb-group"><div class="fb-gl">Топлива нет</div><div class="feedback-grid g3">' +
    ['92','95','diesel'].map(f => '<button class="feedback-option" data-fact="no" data-fuel="' + f + '" onclick="fbToggle(this)">' + fuelLabel(f) + '</button>').join('') + '</div></div>' +
    '<div class="fb-group"><div class="fb-gl">Очередь</div><div class="feedback-grid g4">' +
    ['small','medium','large','huge'].map(q => '<button class="feedback-option" data-fact="queue" data-queue="' + q + '" onclick="fbToggle(this)">' + (q === 'small' ? '2–3' : q === 'medium' ? '4–6' : q === 'large' ? '7+' : '100+') + '</button>').join('') + '</div></div>' +
    '<div class="fb-group"><div class="fb-gl">Живая очередь</div><div class="feedback-grid">' +
    '<button class="feedback-option" data-fact="inqueue" onclick="fbToggle(this)">' + icon('i-queue','ic-s') + 'Я стою в очереди сейчас</button></div></div>' +
    '<div class="fb-group"><div class="fb-gl">Ещё</div><div class="feedback-grid g3">' +
    '<button class="feedback-option" data-fact="delivery" onclick="fbToggle(this)">' + icon('i-truck','ic-s') + 'Привезли</button>' +
    '<button class="feedback-option" data-fact="free" onclick="fbToggle(this)">' + icon('i-check','ic-s') + 'Свободно</button></div></div>' +
    '<input id="fb-text-' + stationId + '" class="fb-text" type="text" maxlength="200" placeholder="Пара слов (необязательно)">' +
    '<button id="fb-send-' + stationId + '" class="fb-send" onclick="fbSend(\'' + stationId + '\')">Отправить отметку</button></div>';
}
// === Отметка «с места» (гео-взвешивание народной отметки) ===
// При отправке пробуем свежий GPS (кэш до 2 мин годится); нет — недавняя
// (≤15 мин) сохранённая или ручная точка. Расстояние ≤200 м от АЗС —
// verified_on_site = true. Сырые координаты в базу НЕ шлём: только факт и метры.
const ON_SITE_RADIUS_M = 200;
const ON_SITE_MAX_AGE_MIN = 15;
function distMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111000;
  const dLon = (lon2 - lon1) * 111000 * Math.cos(lat1 * Math.PI / 180);
  return Math.round(Math.sqrt(dLat * dLat + dLon * dLon));
}
function recentLocFallback() {
  try {
    const m = JSON.parse(localStorage.getItem('kbManualLoc') || 'null');
    if (m && Number.isFinite(m.lat) && m.t && Date.now() - m.t <= ON_SITE_MAX_AGE_MIN * 60000) return { lat: m.lat, lon: m.lon };
  } catch (e) {}
  try {
    const s = JSON.parse(localStorage.getItem('userLocation') || 'null');
    if (s && Number.isFinite(s.lat) && s.t && Date.now() - s.t <= ON_SITE_MAX_AGE_MIN * 60000) return { lat: s.lat, lon: s.lon };
  } catch (e) {}
  return null;
}
function currentLocForOnSite() {
  return new Promise(res => {
    if (!navigator.geolocation) { res(recentLocFallback()); return; }
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => res(recentLocFallback()),
      { timeout: 4000, maximumAge: 120000 });
  });
}
async function onSiteFields(station) {
  const base = { verified_on_site: false, distance_to_station_m: null };
  if (!station || !Number.isFinite(Number(station.lat)) || !Number.isFinite(Number(station.lon))) return base;
  const loc = await currentLocForOnSite();
  if (!loc) return base;
  const d = distMeters(loc.lat, loc.lon, Number(station.lat), Number(station.lon));
  return { verified_on_site: d <= ON_SITE_RADIUS_M, distance_to_station_m: d };
}
// сколько отметок с места по этой АЗС за последние 24 ч
function onSiteCount24(stationId) {
  const since = Date.now() - 24 * 3600 * 1000;
  let n = 0;
  for (const f of allFeedback) {
    if (f.station_id !== stationId || !f.verified_on_site) continue;
    if (new Date(f.created_at).getTime() < since) continue;
    n++;
  }
  return n;
}
function onSiteStrip(stationId) {
  const n = onSiteCount24(stationId);
  if (!n) return '';
  return '<div class="dg-strip" style="margin-top:6px">' + icon('i-pin', 'ic-s') + '<span>' + n + ' вод. отметили с места (24 ч)</span></div>';
}
// === Живая очередь: сколько водителей стоят в очереди ПРЯМО СЕЙЧАС ===
// Считаем разные device_id с отметкой in_queue за последние 30 минут.
// Это опережающий сигнал: человек физически в очереди, а не «видел проезжая».
const LIVE_QUEUE_MIN = 30;
function liveQueueCount(stationId) {
  const since = Date.now() - LIVE_QUEUE_MIN * 60 * 1000;
  const devs = new Set();
  for (const f of allFeedback) {
    if (f.station_id !== stationId || f.feedback_type !== 'in_queue') continue;
    if (new Date(f.created_at).getTime() < since) continue;
    devs.add(f.device_id || '?');
  }
  return devs.size;
}
function liveQueueStrip(stationId) {
  const n = liveQueueCount(stationId);
  if (!n) return '';
  return '<div class="dg-strip" style="margin-top:6px">' + icon('i-queue', 'ic-s') + '<span>' + n + ' вод. стоят в очереди прямо сейчас</span></div>';
}
// === Тень заправки: пассивное обнаружение визита ===
// Пока сайт открыт, раз в 60 сек тихо сверяем геолокацию. Водитель в радиусе
// АЗС и НЕ движется 3+ минуты (стоит, а не проезжает) — мягко предлагаем
// отметить топливо: отметка «с места» самый ценный сигнал для города.
// Проезд мимо отсеивается стоянием: мимо АЗС машина проходит за 1 чек,
// нам нужно 3-4 чека подряд в радиусе. Координаты никуда не шлются.
const SHADOW_RADIUS_M = 120;
const SHADOW_DWELL_MIN = 3;
const SHADOW_CHECK_MS = 60000;
const SHADOW_MOVE_M = 40;
let shadowState = null; // { stId, since, lat, lon }
let shadowAskedKey = null;
function shadowAskedToday(stId) {
  try {
    const v = localStorage.getItem('kbShadowAsk_' + stId);
    if (!v) return false;
    return new Date(Number(v)).toDateString() === new Date().toDateString();
  } catch (e) { return false; }
}
function shadowMarkAsked(stId) {
  try { localStorage.setItem('kbShadowAsk_' + stId, String(Date.now())); } catch (e) {}
}
function shadowNearestStation(lat, lon) {
  let best = null, bestD = SHADOW_RADIUS_M;
  for (const s of allStations) {
    if (!Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lon))) continue;
    const d = distMeters(lat, lon, Number(s.lat), Number(s.lon));
    if (d <= bestD) { bestD = d; best = s; }
  }
  return best;
}
function shadowTick() {
  if (document.hidden || offlineMode || !allStations.length) return;
  if (!navigator.geolocation) return;
  if (manualMode || manualLoc()) return; // точка под глушилками ручная — тени не верим
  if (activeQuick || activeRing) return; // человек уже отмечает на карте — не мешаем
  const busy = ['helloBack','installBack','pollBack','sheetBack','wnBack','mailBack','lifeBack'].some(id => {
    const el = document.getElementById(id);
    return el && el.classList.contains('open');
  });
  if (busy) return;
  navigator.geolocation.getCurrentPosition(p => {
    if (!p || !p.coords || p.coords.accuracy > 100) return;
    const lat = p.coords.latitude, lon = p.coords.longitude;
    const st = shadowNearestStation(lat, lon);
    const card = document.getElementById('shadowCard');
    if (!st) { shadowState = null; if (card && card.classList.contains('open')) shadowClose(); return; }
    const now = Date.now();
    if (!shadowState || shadowState.stId !== st.id) { shadowState = { stId: st.id, since: now, lat: lat, lon: lon }; return; }
    if (distMeters(lat, lon, shadowState.lat, shadowState.lon) > SHADOW_MOVE_M) { shadowState.lat = lat; shadowState.lon = lon; return; }
    const dwell = (now - shadowState.since) / 60000;
    if (dwell >= SHADOW_DWELL_MIN && !shadowAskedToday(st.id) && !card.classList.contains('open')) shadowOpen(st);
  }, () => {}, { timeout: 8000, maximumAge: 30000 });
}
function shadowOpen(st) {
  const card = document.getElementById('shadowCard');
  if (!card) return;
  shadowAskedKey = st.id;
  confirmAdviceOutcome(st.id);
  card.innerHTML = '<div class="shadow-head">' + icon('i-pin') + '<b>Вы на АЗС «' + escapeHtml(st.name || 'АЗС') + '»</b>' +
    '<button onclick="shadowDismiss()" aria-label="Не сейчас">' + icon('i-close', 'ic-s') + '</button></div>' +
    '<div class="feedback-panel open" id="quick-' + st.id + '">' + quickChipsHtml() +
    '<button class="fb-send" onclick="shadowSend(\'' + st.id + '\')">Отправить отметку</button></div>';
  card.classList.add('open');
}
function shadowClose() {
  const card = document.getElementById('shadowCard');
  if (card) { card.classList.remove('open'); card.innerHTML = ''; }
}
function shadowDismiss() {
  if (shadowAskedKey) shadowMarkAsked(shadowAskedKey);
  shadowAskedKey = null;
  shadowClose();
}
async function shadowSend(stationId) {
  // отметка идёт тем же путём, что быстрая: проверка «с места» и офлайн-очередь
  await quickSend(stationId);
  shadowMarkAsked(stationId);
  shadowAskedKey = null;
  setTimeout(shadowClose, 1400); // даём «спасибо» мелькнуть внутри карточки
}
setInterval(shadowTick, SHADOW_CHECK_MS);
// === Волна из соседних городов: факт, а не прогноз ===
// По каждому городу: исчезновения и возвраты АИ-95 за 24 ч против обычной
// нормы за сутки (среднее за предыдущие 6 суток) — из журнала events.
// Модели и обещаний нет: показываем факт о соседях; долетают ли волны до
// нас и с каким лагом — измеряем (история событий уже копится в базе).
function cityWaveStats() {
  const now = Date.now();
  const H24 = 24 * 3600 * 1000;
  const stCity = {};
  for (const s of allStations) {
    let k = null;
    for (const c of CITY_BOXES) {
      if (s.lat >= c.lat1 && s.lat <= c.lat2 && s.lon >= c.lon1 && s.lon <= c.lon2) { k = c.key; break; }
    }
    stCity[s.id] = k;
  }
  const acc = {};
  for (const c of CITY_BOXES) acc[c.key] = { key: c.key, name: c.name, d24: 0, r24: 0, dPrev: 0, rPrev: 0 };
  for (const e of allWaveEvents) {
    const k = stCity[e.station_id];
    if (!k) continue;
    const age = now - new Date(e.detected_at).getTime();
    if (age < 0 || age > 7 * H24) continue;
    const dis = e.event_type === 'fuel_disappeared';
    if (!dis && e.event_type !== 'fuel_restored') continue;
    if (age <= H24) { if (dis) acc[k].d24++; else acc[k].r24++; }
    else { if (dis) acc[k].dPrev++; else acc[k].rPrev++; }
  }
  for (const k of Object.keys(acc)) {
    const a = acc[k];
    a.dBase = a.dPrev / 6;
    a.rBase = a.rPrev / 6;
    // Мало истории за 6 суток (dPrev) — норма ненадёжна (часто limit=5000
    // отрезает старые события). Без нормы не ставим «волну».
    const hasBase = a.dPrev >= 12; // ≥ ~2 событий/сут в среднем за 6 дней
    if (!hasBase) {
      a.level = 'calm';
      a.noBase = true;
      continue;
    }
    const base = Math.max(1, a.dBase);
    a.level = (a.d24 >= 4 && a.d24 >= 3 * base) ? 'wave'
      : (a.d24 >= 3 && a.d24 >= 2 * base) ? 'tense' : 'calm';
    if (a.level === 'calm' && a.r24 >= 4 && a.r24 >= 3 * Math.max(1, a.rBase)) a.level = 'returns';
  }
  return acc;
}
function waveSummaryLine(stats) {
  const list = Object.values(stats);
  const wave = list.filter(a => a.level === 'wave');
  if (wave.length) return wave.map(a => a.name + ' — волна').join(', ');
  const tense = list.filter(a => a.level === 'tense');
  if (tense.length) return tense.map(a => a.name + ' — напряжённо').join(', ');
  const ret = list.filter(a => a.level === 'returns');
  if (ret.length) return ret.map(a => a.name + ' — возвращают топливо').join(', ');
  return 'спокойно';
}
function waveFactExtra() {
  if (!lastWaveStats) return 'Данных о волне пока нет.';
  const r1 = v => Math.round(v * 10) / 10;
  const loud = Object.values(lastWaveStats).filter(a => a.level !== 'calm');
  if (!loud.length) return 'Все города спокойные: исчезновения и возвраты в пределах нормы.';
  const all = Object.values(lastWaveStats);
  const loud2 = all.filter(a => a.level !== 'calm');
  const noBase = all.filter(a => a.noBase && a.d24 > 0);
  const parts = [];
  if (loud2.length) {
    parts.push(loud2.map(a =>
      a.name + (a.key === userCityKey ? ' (твой город)' : '') + ': исчезновений ' + a.d24 +
      ' (норма ' + r1(a.dBase) + '/сут) — ' +
      (a.level === 'wave' ? 'волна' : a.level === 'tense' ? 'напряжённо' : 'возвращают топливо')
    ).join('; '));
  }
  if (noBase.length) {
    parts.push('Без нормы (мало истории 2–7 сут): ' + noBase.map(a =>
      a.name + ' ' + a.d24 + ' за 24 ч'
    ).join('; '));
  }
  if (!parts.length) return 'Все города спокойные: исчезновения и возвраты в пределах нормы.';
  return parts.join('. ');
}
function renderWave() {
  const strip = document.getElementById('waveStrip');
  if (!strip) return;
  if (!lastWaveStats) { strip.style.display = 'none'; return; }
  // волна в своём городе и так видна на тепловой матрице — не дублируем её
  // полоской и не перегружаем главную панель. Полоска вспыхивает только
  // когда волна у соседей, а твой город ещё спокоен: вот тогда это сигнал.
  const my = lastWaveStats[userCityKey];
  const others = Object.values(lastWaveStats).filter(a => a.key !== userCityKey && a.level === 'wave');
  const r1 = v => Math.round(v * 10) / 10;
  if (others.length && (!my || my.level !== 'wave')) {
    const a = others[0];
    strip.style.display = '';
    strip.innerHTML = icon('i-spark', 'ic-s') + '<span>Волна рядом: ' + a.name + ' — исчезновений ' + a.d24 + ' за 24 ч (норма ~' + r1(a.dBase) + ')</span>';
  } else strip.style.display = 'none';
}
function fbToggle(btn) {
  const fact = btn.dataset.fact;
  const panel = btn.closest('.feedback-panel');
  // очередь — одиночный выбор
  if (fact === 'queue') panel.querySelectorAll('[data-fact="queue"]').forEach(b => { if (b !== btn) b.classList.remove('selected'); });
  // взаимоисключение: «есть 95» гасит «нет 95» и наоборот
  if (fact === 'yes') panel.querySelectorAll('[data-fact="no"][data-fuel="' + btn.dataset.fuel + '"]').forEach(b => b.classList.remove('selected'));
  if (fact === 'no') panel.querySelectorAll('[data-fact="yes"][data-fuel="' + btn.dataset.fuel + '"]').forEach(b => b.classList.remove('selected'));
  btn.classList.toggle('selected');
}
async function fbSend(stationId) {
  const panel = document.getElementById('feedback-' + stationId);
  if (!panel) return;
  const rows = [];
  panel.querySelectorAll('.feedback-option.selected').forEach(b => {
    const fact = b.dataset.fact;
    // PostgREST требует одинаковый набор ключей у всех строк массива (PGRST102):
    // недостающие поля явно null
    const base = { feedback_type: null, fuel_type: null, queue_size: null, comment_text: null };
    if (fact === 'yes') Object.assign(base, { feedback_type: 'available', fuel_type: b.dataset.fuel });
    else if (fact === 'no') Object.assign(base, { feedback_type: 'unavailable', fuel_type: b.dataset.fuel });
    else if (fact === 'queue') Object.assign(base, { feedback_type: 'queue', queue_size: b.dataset.queue });
    else if (fact === 'delivery') Object.assign(base, { feedback_type: 'delivery' });
    else if (fact === 'free') Object.assign(base, { feedback_type: 'free' });
    else if (fact === 'inqueue') Object.assign(base, { feedback_type: 'in_queue' });
    rows.push(base);
  });
  if (!rows.length) { alert('Выберите хотя бы один факт.'); return; }
  const key = 'fb_' + stationId;
  const history = JSON.parse(localStorage.getItem(key) || '[]');
  const now = Date.now();
  if (history.filter(t => now - t < 30 * 60 * 1000).length >= 3) { alert('Слишком много отметок. Попробуйте через полчаса.'); if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = sendBtnOrigText; } return; }
  const comment = (document.getElementById('fb-text-' + stationId).value || '').trim();
  const onSite = await onSiteFields(allStations.find(s => s.id === stationId));
  rows.forEach((r, i) => { r.station_id = stationId; r.device_id = deviceId; Object.assign(r, onSite); if (i === 0 && comment) r.comment_text = comment; });
  const sendBtn = document.getElementById('fb-send-' + stationId);
  const sendBtnOrigText = sendBtn ? sendBtn.textContent : '';
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Отправляю...'; }
let ok = true;
  try { await dbInsert('user_feedback', rows); } catch (e) { ok = false; }
  if (!ok) {
    // сети нет: отметка копится в локальной очереди и уйдёт сама позже
    queueFeedbackLocally(rows);
    history.push(now);
    localStorage.setItem(key, JSON.stringify(history));
    rows.forEach(r => allFeedback.unshift(Object.assign({ created_at: new Date().toISOString() }, r)));
    bumpContrib();
    const stEl = sendBtn.closest('.station');
    const rcEl = stEl && stEl.querySelector('.recent');
    if (rcEl) rcEl.textContent = 'Нет связи: отметка сохранена, уйдёт автоматически.';
    panel.classList.remove('open');
    sendBtn.disabled = false;
    sendBtn.textContent = sendBtnOrigText;
    panel.querySelectorAll('.feedback-option').forEach(b => b.classList.remove('selected'));
    return;
  }
  history.push(now);
  localStorage.setItem(key, JSON.stringify(history));
  rows.forEach(r => allFeedback.unshift(Object.assign({ created_at: new Date().toISOString() }, r)));
  track('feedback_submit');
  bumpContrib();
  maybePollSoon();
  // народный консенсус мог перекрасить пин — обновляем карту после «спасибо»
  setTimeout(() => { if (mapObj) renderMap(); }, 1400);
  const station = sendBtn.closest('.station');
  const recentElement = station && station.querySelector('.recent');
  if (recentElement) recentElement.textContent = 'Спасибо! Учёт ' + rows.length + ' фактов.';
  panel.classList.remove('open');
  sendBtn.disabled = false;
  sendBtn.textContent = sendBtnOrigText;
  panel.querySelectorAll('.feedback-option').forEach(b => b.classList.remove('selected'));
}
function whyHtml(pred) {
  const f = pred && pred.features ? pred.features : null;
  if (!f) return '';
  const items = [];
  const regimeLbl = { NORMAL: 'в городе спокойно', LOCAL_SHORTAGE: 'в городе локальный дефицит', CITY_SHORTAGE: 'в городе общий дефицит', RECOVERY: 'город восстанавливается' };
  if (f.regime && regimeLbl[f.regime]) items.push(regimeLbl[f.regime] + (f.regime === 'RECOVERY' && f.restores_6h ? ': ' + f.restores_6h + ' возвратов за 6ч' : ''));
  if (f.deficit_age_min !== null && f.deficit_age_min !== undefined) {
    const h = Math.floor(f.deficit_age_min / 60), m = f.deficit_age_min % 60;
    items.push('дефицит длится ' + (h ? h + 'ч ' : '') + m + 'м');
  }
  if (f.queue_trend === 'falling') items.push('очередь на АЗС снижается');
  if (f.queue_trend === 'rising') items.push('очередь на АЗС растёт');
  if (f.knn_support) items.push('в прошлом было ' + f.knn_support + ' похожих случаев' + (f.knn_p_restore_2h !== null && f.knn_p_restore_2h !== undefined ? ': привозили в ближайшие 2 ч в ' + f.knn_p_restore_2h + '%' : ''));
  if (f.nearby_missing95) items.push('рядом без АИ-95: ' + f.nearby_missing95 + ' из ' + f.nearby_total);
  if (!items.length) return '';
  return '<div class="why"><div class="why-t">Почему такой прогноз</div>' + items.map(t => '<span class="why-i">' + escapeHtml(t) + '</span>').join('') + '</div>';
}
/* операционный вердикт источника (поле status): отдельно от топлива —
   «работает» не значит «есть бензин», а «не работает» объясняет «нет данных» */
function workStrip(obs) {
  if (!obs) return '';
  const st = obs.source_status;
  let txt, ico = 'i-minus';
  if (st === 'yes' || st === 'queue' || st === 'low') { txt = 'источник: станция работает'; ico = 'i-check'; }
  else if (st === 'no') { txt = 'источник: станция не работает'; ico = 'i-cross'; }
  else { txt = 'источник молчит о станции'; }
  return '<div class="dg-strip chip3 tap why-tap" style="margin:0 0 10px" onclick="openWhyChip(this,\'work\')">' + icon(ico, 'ic-s') + '<span>' + txt + '</span></div>';
}
// === КогдаБенз Score (этап 4): паспорт на сайте ===
// Теневая таблица score_shadow (ночной скорер): Score по связкам домашнего бокса.
// Уровни доказательности: none — недостаточно данных (цифру НЕ показываем),
// forming/stable/strong — растущая доказательность. Score не оценивает бензин
// или честность владельца — только доверие к сведениям КогдаБенз по топливу.
const SC_EV = { none: ['e0', 'данных ещё мало'], forming: ['e1', 'накапливается'], stable: ['e2', 'данных достаточно'], strong: ['e3', 'данных много'] };
function scoreRow(stationId, fuel) { return scoreMap[stationId + '|' + fuel] || null; }
function scoreTileHtml(stationId, fuel, label) {
  const r = scoreRow(stationId, fuel);
  const ev = r ? (SC_EV[r.evidence] || SC_EV.none) : SC_EV.none;
  const num = (r && r.evidence !== 'none') ? r.score : '—';
  return '<div class="sc-tile ' + ev[0] + '" onclick="openScorePop(\'' + stationId + '\',\'' + fuel + '\')"><small>' + label + '</small><b>' + num + '</b><i>' + ev[1] + '</i></div>';
}
function scorePlateHtml(station) {
  if (!scoreRow(station.id, '95') && !scoreRow(station.id, '92') && !scoreRow(station.id, 'diesel')) return '';
  return '<div class="sc-plate"><div class="sc-head">' + icon('i-spark', 'ic-s') + 'КогдаБенз Score   надёжность данных<small>тап — паспорт</small></div><div class="sc-tiles">' +
    scoreTileHtml(station.id, '95', 'АИ-95') + scoreTileHtml(station.id, '92', 'АИ-92') + scoreTileHtml(station.id, 'diesel', 'дизель') +
    '</div></div>';
}
function scWord(score, ev) {
  if (ev === 'none') return ['Данные ещё накапливаются', 'w0'];
  if (score >= 75) return ['Данным можно доверять', 'w3'];
  if (score >= 50) return ['Данным в основном можно доверять', 'w2'];
  if (score >= 30) return ['Доверяй с осторожностью', 'w1'];
  return ['Надёжных данных пока мало', 'w0'];
}
function openScorePop(stationId, fuel) {
  const pop = document.getElementById('scorePop'); const back = document.getElementById('scoreBack');
  if (!pop || !back) return;
  const st = allStations.find(s => s.id === stationId);
  const line = (cls, txt) => '<div class="sc-line"><i class="dot2 ' + cls + '"></i><span>' + txt + '</span></div>';
  let body = '';
  for (const f of ['95', '92', 'diesel']) {
    const r = scoreRow(stationId, f);
    if (!r) continue;
    const c = r.comp || {};
    const ev = SC_EV[r.evidence] || SC_EV.none;
    const word = scWord(r.score, r.evidence);
    const lines = [];
    lines.push((c.n_confirm || 0) > 0
      ? line('g', 'Водители подтверждали наши отметки: ' + c.n_confirm + ' раз(а)')
      : line('n', 'Водители пока не подтверждали отметки — народных отметок мало'));
    if ((c.n_verified || 0) > 0) {
      const ratio = (c.match || 0) / 30;
      lines.push(ratio >= 0.6 ? line('g', 'Прогноз возврата часто сбывается')
        : ratio >= 0.3 ? line('y', 'Прогноз возврата сбывается примерно через раз')
        : line('r', 'Прогноз возврата пока сбывается редко — модель учится'));
    } else lines.push(line('n', 'Прогнозы возврата по этому топливу ещё не проверены'));
    lines.push((c.fresh || 0) >= 20 ? line('g', 'Данные свежие: источник проверял станцию недавно')
      : (c.fresh || 0) >= 10 ? line('y', 'Данные подсохли: источник давно не заглядывал')
      : line('r', 'Данные несвежие: полностью полагаться нельзя'));
    lines.push((c.stable || 0) >= 15 ? line('g', 'Источник не глючит: статусы не прыгают туда-сюда')
      : (c.stable || 0) >= 10 ? line('y', 'Источник иногда глючит по этой станции')
      : line('r', 'Источник часто глючит: статусы прыгают'));
    lines.push((c.srcq || 0) >= 8 ? line('g', 'Источник обычно видит эту станцию')
      : (c.srcq || 0) >= 5 ? line('y', 'Источник видит станцию примерно через раз')
      : line('r', 'Источник часто теряет эту станцию'));
    body += '<div class="sc-row' + (f === fuel ? ' on' : '') + '"><div class="sc-row-t">' + fuelLabel(f) +
      '<span class="sc-ev ' + ev[0] + '">' + ev[1] + '</span><b class="ml">' + (r.evidence === 'none' ? '—' : r.score) + '</b></div>' +
      '<div class="sc-word ' + word[1] + '">' + word[0] + '</div>' +
      lines.join('') +
      '<div class="sc-meta">За вердиктом: ' + r.events_n + ' событий и ' + (c.n_verified || 0) + ' проверок прогноза</div></div>';
  }
  pop.innerHTML = '<div class="hello-title">Насколько можно доверять данным   ' + escapeHtml(st ? st.name || 'АЗС' : 'АЗС') + '</div>' +
    '<div class="help-lead" style="margin:4px 0 8px">Мы проверяем сведения о станции пятью способами: подтверждают ли водители наши отметки, сбывается ли прогноз возврата, свежие ли данные, не глючит ли источник и как часто он вообще видит станцию. Каждая проверка добавляет баллы — вместе это доверие от 0 до 100.</div>' +
    body +
    '<div class="recent">Вердикт пересчитывается каждую ночь. Пока данных мало — говорим об этом прямо и не показываем красивую цифру. Оценка не про бензин и не про владельца: только про надёжность наших сведений.</div>' +
    '<button class="cta-btn" style="width:100%;margin-top:8px" onclick="closeScorePop()">Понятно</button>';
  pop.classList.add('open'); back.classList.add('open');
}
function closeScorePop() {
  const pop = document.getElementById('scorePop'); const back = document.getElementById('scoreBack');
  if (pop) pop.classList.remove('open'); if (back) back.classList.remove('open');
}
// === Правда с места: GPS-отметка водителя «с места» сильнее устаревшего источника ===
// На 2 часа такая отметка перекрывает источнику «нет» и гистерезис машины
// состояний («не подтверждён»): человек физически стоял у колонки, это факт.
// Модель и прогнозы правило не трогает — меняется только витрина карточки.
function sceneMark(stationId, fuel) {
  const since = Date.now() - 2 * 3600 * 1000;
  let best = null;
  for (const f of allFeedback) {
    if (f.station_id !== stationId || f.feedback_type !== 'available') continue;
    if (f.fuel_type !== fuel || !f.verified_on_site) continue;
    const t = new Date(f.created_at).getTime();
    if (t < since) continue;
    if (!best || t > best.t) best = { t: t };
  }
  return best;
}
// === карточка АЗС v2 по макету: вердикт 	 топлива 	 факты 	 кнопки 	
// карта-миниатюра 	 события за сутки 	 Score. Один экран, без скролла. ===
function confPill(obs, stt, trust) {
  const c = confPercent(obs);
  if (c === null) return '<span class="f-pill gray">уверенность —</span>';
  if (stt === true && trust) return '<span class="f-pill yes">уверенность ' + c + '%</span>';
  if (stt === false) return '<span class="f-pill no">уверенность ' + Math.max(3, 100 - c) + '%</span>';
  return '<span class="f-pill ' + (stt === true ? 'warn' : 'gray') + '">уверенность ' + c + '%</span>';
}
function stationTimelineHtml(station, obs) {
  const since = Date.now() - 24 * 3600 * 1000;
  const list = [];
  for (const e of allWaveEvents) {
    if (e.station_id !== station.id) continue;
    const t = new Date(e.detected_at).getTime();
    if (t < since) continue;
    list.push({ t: t, kind: e.event_type === 'fuel_restored' ? 'restored' : 'gone', fuel: e.fuel_type });
  }
  for (const f of allFeedback) {
    if (f.station_id !== station.id) continue;
    const t = new Date(f.created_at).getTime();
    if (t < since) continue;
    if (f.feedback_type === 'available') list.push({ t: t, kind: 'folk_yes', fuel: f.fuel_type });
    else if (f.feedback_type === 'unavailable') list.push({ t: t, kind: 'folk_no', fuel: f.fuel_type });
    else if (f.feedback_type === 'delivery') list.push({ t: t, kind: 'delivery' });
    else if (f.feedback_type === 'queue' || f.feedback_type === 'in_queue') list.push({ t: t, kind: 'queue' });
  }
  if (obs && obs.timestamp) list.push({ t: new Date(obs.timestamp).getTime(), kind: 'update' });
  list.sort((a, b) => a.t - b.t);
  const nodes = list.slice(-3);
  const META = {
    restored: ['i-check', 'g', 'вернулся'],
    gone: ['i-cross', 'r', 'закончился'],
    folk_yes: ['i-check', 'g', 'есть   народ'],
    folk_no: ['i-cross', 'r', 'нет   народ'],
    delivery: ['i-truck', 'b', 'привезли   народ'],
    queue: ['i-queue', 'o', 'очередь   народ'],
    update: ['i-check', 'g', 'Обновление данных']
  };
  const word = nodes.length === 1 ? '1 изменение' : nodes.length < 5 ? nodes.length + ' изменения' : nodes.length + ' изменений';
  const body = nodes.length
    ? nodes.map(n => {
        const m = META[n.kind]; const d = new Date(n.t);
        const cap = n.fuel ? fuelLabel(n.fuel) + ' ' + m[2] : m[2];
        return '<span class="ev-node"><i class="ev-ico ' + m[1] + '"><svg class="ic ic-s"><use href="#' + m[0] + '"/></svg></i><b>' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + '</b><span>' + cap + '</span></span>';
      }).join('')
    : '<span class="ev-quiet">за сутки изменений не было</span>';
  return '<div class="card-ev"><div class="ev-head"><b>События за 24 ч</b><small>' + (nodes.length ? word : 'тихо') + '</small></div><div class="ev-tl">' + body + '</div></div>';
}
function scoreGaugeHtml(station, focusFuel) {
  let r = null, rf = focusFuel;
  for (const f of [focusFuel, '95', '92', 'diesel']) {
    const x = scoreRow(station.id, f);
    if (x) { r = x; rf = f; break; }
  }
  const open = 'openScorePop(\'' + station.id + '\',\'' + rf + '\')';
  if (!r || r.evidence === 'none') {
    return '<span class="sc-gauge" onclick="' + open + '"><svg viewBox="0 0 100 56"><path class="g-track" d="M10 50a40 40 0 0 1 80 0"/></svg><b>—<span>/100</span></b><i style="color:#93a1b8">данных мало<span>&nbsp;</span></i></span>';
  }
  const sc = r.score;
  const col = sc < 35 ? '#ef5350' : sc < 60 ? '#f5a05a' : sc < 80 ? '#397cff' : '#19b77a';
  const lbl = (sc < 35 ? 'низкая' : sc < 60 ? 'средняя' : sc < 80 ? 'хорошая' : 'высокая') + '<span>уверенность</span>';
  const len = Math.round(125.7 * sc / 100 * 10) / 10;
  return '<span class="sc-gauge" onclick="' + open + '"><svg viewBox="0 0 100 56"><path class="g-track" d="M10 50a40 40 0 0 1 80 0"/><path class="g-val" d="M10 50a40 40 0 0 1 80 0" style="stroke:' + col + ';stroke-dasharray:' + len + ' 200"/></svg><b style="color:' + col + '">' + sc + '<span>/100</span></b><i style="color:' + col + '">' + lbl + '</i></span>';
}
// === вторичная кнопка карточки: текст по состоянию «сердечко + бот» ===
// сердечко горит и бот подключён — констатируем: АЗС добавлена, уведомления
// включены (тап открывает чат бота). Сердечко без бота — зовём связаться.
// Без сердечка — прежний зов «Напомнить в Telegram» с подсказкой про сердечко.
function tgButtonHtml(station) {
  const fav = isFavorite(station.id);
  if (fav && tgLinked) return '<button class="cta-btn ghost big tg-onbtn" data-tgbtn="' + station.id + '" onclick="tgOpen()">' + icon('i-check') + 'АЗС в избранном   уведомления включены' + icon('i-arrow') + '</button>';
  if (fav) return '<button class="cta-btn ghost big" data-tgbtn="' + station.id + '" onclick="tgConnectStation(\'' + station.id + '\')">' + icon('i-tg') + 'АЗС в избранном   включите уведомления' + icon('i-arrow') + '</button>';
  return '<button class="cta-btn ghost big" data-tgbtn="' + station.id + '" onclick="tgNotifyTap(this,\'' + station.id + '\')">' + icon('i-tg') + 'Напомнить в Telegram' + icon('i-arrow') + '</button>';
}
function refreshTgButton(stationId) {
  const btn = document.querySelector('[data-tgbtn="' + stationId + '"]');
  if (!btn) return;
  const st = allStations.find(s => s.id === stationId);
  if (st) btn.outerHTML = tgButtonHtml(st);
}
// === Цепочка подписки: польза 	 избранное 	 Телеграм (по стратегии 03.11) ===
// Подключение уведомлений из карточки автоматически добавляет АЗС в избранное:
// персональные уведомления бота живут на избранных связки, поэтому контекст
// станции не теряется даже без изменений бота.
function tgConnectStation(stId) {
  if (stId && !isFavorite(stId)) {
    const f = getFavorites();
    f.push(stId);
    localStorage.setItem('favorites', JSON.stringify(f));
    syncFavorites();
  }
  tgConnect(stId);
}
// Окно-предложение: показываем в момент интереса (добавил в избранное) или на
// повторном заходе с избранным, но без Телеграма. Кулдаун 3 дня, раз за сессию,
// не поверх других окон, никогда в офлайне и никогда при включённой связке.
function tgOfferAllowed() {
  if (tgLinked || offlineMode) return false;
  let last = 0;
  try { last = Number(localStorage.getItem('kbTgOffer') || 0); } catch (e) {}
  if (Date.now() - last < 3 * 86400000) return false;
  try { if (sessionStorage.getItem('kbTgOfferSession')) return false; } catch (e) {}
  return true;
}
function tgOfferShow(stId) {
  const pop = document.getElementById('tgOfferPop'); const back = document.getElementById('tgOfferBack');
  if (!pop || !back) return;
  const st = stId ? allStations.find(s => s.id === stId) : null;
  pop.innerHTML = '<div class="hello-title">⛽ Следи за своей заправкой</div>' +
    '<div class="help-lead" style="margin:4px 0 8px">' + (st
      ? 'По станции «' + escapeHtml(st.name || 'АЗС') + '» уведомления будут приходить прямо в Телеграм — не нужно постоянно проверять сайт.'
      : 'Добавь АЗС в избранное и получай уведомления, когда появляется вероятность возвращения топлива.') + '</div>' +
    '<div class="to-row g">' + icon('i-heart', 'ic-s') + 'Твои любимые АЗС всегда под рукой</div>' +
    '<div class="to-row">' + icon('i-tg', 'ic-s') + 'Уведомления в Телеграм</div>' +
    '<div class="to-row">' + icon('i-clock', 'ic-s') + 'Не нужно постоянно проверять сайт</div>' +
    '<button class="cta-btn" style="width:100%;margin-top:10px" onclick="tgOfferGo(\'' + (stId || '') + '\')">' + icon('i-tg') + 'Получать уведомления в Telegram</button>' +
    '<button class="cta-btn ghost" style="width:100%;margin-top:6px" onclick="closeTgOffer()">Позже</button>' +
    '<div class="recent" style="margin-top:8px">Отключить можно в любой момент. Прогноз — это вероятность, а не гарантия фактического появления топлива.</div>';
  pop.classList.add('open'); back.classList.add('open');
}
function tgOfferGo(stId) {
  closeTgOffer();
  tgConnectStation(stId || undefined);
}
function closeTgOffer() {
  const pop = document.getElementById('tgOfferPop'); const back = document.getElementById('tgOfferBack');
  if (pop) pop.classList.remove('open');
  if (back) back.classList.remove('open');
}
function maybeTgOffer(stId) {
  if (!tgOfferAllowed()) return;
  let tries = 0;
  const attempt = () => {
    if (document.querySelector('.hello-back.open, .sheet.open')) {
      if (++tries < 20) setTimeout(attempt, 1500);
      return;
    }
    try {
      sessionStorage.setItem('kbTgOfferSession', '1');
      localStorage.setItem('kbTgOffer', String(Date.now()));
    } catch (e) {}
    tgOfferShow(stId);
  };
  setTimeout(attempt, 800);
}
function tgNotifyTap(btn, stationId) {
  if (tgLinked) { tgOpen(); return; }
  if (!isFavorite(stationId)) {
    const old = btn.innerHTML;
    btn.innerHTML = icon('i-heart', 'ic-s') + 'Сначала нажмите сердечко';
    setTimeout(() => { btn.innerHTML = old; }, 2500);
    return;
  }
  tgConnectStation(stationId);
}
function cardMapGo(id) {
  const st = allStations.find(s => s.id === id);
  if (!st) return;
  closeSheet();
  pagerGo(2); ensureMap();
  const go = () => {
    if (!mapObj) { setTimeout(go, 150); return; }
    mapObj.stop();
    mapObj.easeTo({ center: [Number(st.lon), Number(st.lat)], zoom: 15, duration: 900 });
  };
  go();
}
// === народные отметки в карточке: чипы фактов за сутки + кнопка отметки ===
function folkCardHtml(stationId) {
  const since = Date.now() - 24 * 3600 * 1000;
  const items = allFeedback.filter(f => f.station_id === stationId && new Date(f.created_at).getTime() >= since);
  const btn = '<button class="folk-add" onclick="toggleFeedback(\'' + stationId + '\')">＋ Отметить</button>';
  if (!items.length) {
    return '<div class="folk-card"><div class="folk-head">' + icon('i-heart', 'ic-s') + '<b>Отметок водителей за 24 ч нет</b>' + btn + '</div>' +
      '<div class="folk-quiet">Сообщите топливо или очередь первыми — город увидит сразу.</div>' +
      feedbackPanel(stationId) + '</div>';
  }
  const batches = {};
  for (const f of items) { const k = String(f.created_at).slice(0, 16); (batches[k] = batches[k] || []).push(f); }
  const fuelShort = t => t === '92' ? 'АИ-92' : t === '95' ? 'АИ-95' : 'дизель';
  const qShort = { small: '2–3', medium: '4–6', large: '7+', huge: '100+' };
  const rowsHtml = Object.keys(batches).sort().reverse().slice(0, 2).map(k => {
    const g = batches[k];
    const min = Math.max(0, Math.round((Date.now() - new Date(g[0].created_at).getTime()) / 60000));
    const ago = min < 60 ? min + ' мин назад' : Math.round(min / 60) + ' ч назад';
    const chips = [];
    for (const f of g) if (f.feedback_type === 'available') chips.push('<i class="fk yes">' + icon('i-check', 'ic-s') + fuelShort(f.fuel_type) + '</i>');
    for (const f of g) if (f.feedback_type === 'unavailable') chips.push('<i class="fk no">' + icon('i-cross', 'ic-s') + fuelShort(f.fuel_type) + '</i>');
    for (const f of g) if (f.feedback_type === 'queue') chips.push('<i class="fk q">' + icon('i-queue', 'ic-s') + (qShort[f.queue_size] || 'очередь') + '</i>');
    for (const f of g) if (f.feedback_type === 'delivery') chips.push('<i class="fk inf">' + icon('i-truck', 'ic-s') + 'привезли</i>');
    for (const f of g) if (f.feedback_type === 'free') chips.push('<i class="fk yes">' + icon('i-check', 'ic-s') + 'свободно</i>');
    for (const f of g) if (f.feedback_type === 'in_queue') chips.push('<i class="fk q">' + icon('i-queue', 'ic-s') + 'в очереди</i>');
    const onSite = g.filter(f => f.verified_on_site).length;
    const comment = (g.find(f => f.comment_text) || {}).comment_text || '';
    return '<div class="folk-row"><span class="folk-ago">' + ago + (onSite ? '   с места' : '') + '</span><span class="folk-chips">' + chips.join('') + '</span>' +
      (comment ? '<span class="folk-comment">«' + escapeHtml(comment) + '»</span>' : '') + '</div>';
  }).join('');
  return '<div class="folk-card"><div class="folk-head">' + icon('i-heart', 'ic-s') + '<b>Отметки водителей</b><small>  24 ч   ' + items.length + '</small>' + btn + '</div>' +
    rowsHtml + feedbackPanel(stationId) + '</div>';
}
// === КАРТОЧКА ОТМЕТОК НАШИХ ВОДИТЕЛЕЙ (агрегация за 24ч) ===
function driverVerdictHtml(stationId) {
  const since = Date.now() - 24 * 3600 * 1000;
  const items = allFeedback.filter(f => f.station_id === stationId && new Date(f.created_at).getTime() >= since);

  if (!items.length) return ''; // Если отметок нет, карточку не показываем

  // Собираем статистику по каждому топливу
  const fuels = { 
    '92': { label: 'АИ-92', yes: 0, no: 0, lastT: 0 }, 
    '95': { label: 'АИ-95', yes: 0, no: 0, lastT: 0 }, 
    'diesel': { label: 'Дизель', yes: 0, no: 0, lastT: 0 } 
  };
  let queueMark = null;

  items.forEach(f => {
    const t = new Date(f.created_at).getTime();
    if (f.feedback_type === 'available' && fuels[f.fuel_type]) {
      fuels[f.fuel_type].yes++;
      fuels[f.fuel_type].lastT = Math.max(fuels[f.fuel_type].lastT, t);
    } else if (f.feedback_type === 'unavailable' && fuels[f.fuel_type]) {
      fuels[f.fuel_type].no++;
      fuels[f.fuel_type].lastT = Math.max(fuels[f.fuel_type].lastT, t);
    } else if (f.feedback_type === 'queue' || f.feedback_type === 'in_queue') {
      if (!queueMark || t > new Date(queueMark.created_at).getTime()) {
        queueMark = f; // Берем самую свежую отметку об очереди
      }
    }
  });

  let rowsHtml = '';
  let hasFuelMarks = false;

  // Генерируем строки для топлива
  for (const fk in fuels) {
    const f = fuels[fk];
    if (f.yes === 0 && f.no === 0) continue;
    hasFuelMarks = true;

    const min = Math.max(0, Math.round((Date.now() - f.lastT) / 60000));
    const ago = min < 60 ? min + ' мин' : Math.round(min / 60) + ' ч';

    let verdict, color, bgColor;
    if (f.yes > f.no) { verdict = 'Есть'; color = '#12855c'; bgColor = '#e5f8ef'; }
    else if (f.no > f.yes) { verdict = 'Нет'; color = '#c2403f'; bgColor = '#fdecec'; }
    else { verdict = 'Разные мнения'; color = '#c26a2a'; bgColor = '#fff2e8'; }

    rowsHtml += `
      <div class="mf-row" style="margin-top:6px; padding:8px 10px;">
        <div class="mf-top" style="margin-bottom:0; align-items:flex-start;">
          <span class="mf-logo" style="color:${color}; background:${bgColor}; border:none;">${icon('i-pump', 'ic-s')}</span>
          <div style="flex:1; min-width:0;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <span class="mf-name" style="font-size:13px;">${f.label}</span>
              <span class="mf-fuel" style="background:${bgColor}; color:${color};">${verdict} (${f.yes} за / ${f.no} пр.)</span>
            </div>
            <div class="mf-addr" style="margin-top:4px; font-size:9.5px; color:#71809c;">Последняя отметка: ${ago} назад</div>
          </div>
        </div>
      </div>`;
  }

  // Добавляем инфу об очереди, если есть
  let queueHtml = '';
  if (queueMark) {
    const minQ = Math.max(0, Math.round((Date.now() - new Date(queueMark.created_at).getTime()) / 60000));
    const agoQ = minQ < 60 ? minQ + ' мин' : Math.round(minQ / 60) + ' ч';
    const qTxt = queueMark.feedback_type === 'in_queue' ? 'Стоят в очереди сейчас' : 'Очередь ' + (QUEUE_SHORT[queueMark.queue_size] || '');
    queueHtml = `
      <div class="mf-row" style="margin-top:6px; padding:8px 10px; background:#fff8f2; border-color:#f5d3b8;">
        <div class="mf-top" style="margin-bottom:0; align-items:center;">
          <span class="mf-logo" style="color:#c26a2a; background:#fff2e8; border:none;">${icon('i-queue', 'ic-s')}</span>
          <div style="flex:1; min-width:0;">
            <span class="mf-name" style="font-size:13px; color:#c26a2a;">${qTxt}</span>
            <div class="mf-addr" style="margin-top:2px; font-size:9.5px;">Отметка: ${agoQ} назад</div>
          </div>
        </div>
      </div>`;
  }

  if (!hasFuelMarks && !queueHtml) return '';

  // Возвращаем готовую плашку в стиле "mf-plate"
  return `
    <div class="mf-plate" style="margin-top:10px; border-color:#dfe8f2; background:linear-gradient(135deg,#f4fbf7,#eef4ff);">
      <div class="mf-head" style="color:#12855c;">${icon('i-heart')} Наши водители сообщают:<small style="color:#7485a0;">за 24 часа</small></div>
      <div class="mf-sub" style="color:#5b6b86;">Свежие данные от таких же водителей, как вы. Ваш голос улучшит прогноз.</div>
      ${rowsHtml}
      ${queueHtml}
      <button class="cta-btn ghost" style="width:100%; margin-top:10px; font-size:11px; padding:10px; background:#fff; border-color:#bcd4ff; color:#2465ee;" onclick="toggleFeedback('${stationId}')">
        ${icon('i-check', 'ic-s')} Поставить свою отметку
      </button>
    </div>
  `;
}
// === народные голоса живут только до следующей смены статуса пары ===
// «топливо вернулось»/«топливо пропало» сжигает голоса, поставленные до него:
// старые отметки не должны утверждать «есть» поверх свежего «нет»
// (кейс 01:40: карточка зеленела голосами до исчезновения, чипы и лента честные).
let pairChangeCache = null, pairChangeKey = '';
function pairChangeMap() {
const key = allWaveEvents.length + ':' + (allWaveEvents.length ? allWaveEvents[allWaveEvents.length - 1].detected_at : '');
if (pairChangeCache && pairChangeKey === key) return pairChangeCache;
const m = {};
for (const e of allWaveEvents) {
if (e.event_type !== 'fuel_restored' && e.event_type !== 'fuel_disappeared') continue;
const t = new Date(e.detected_at).getTime();
const k = e.station_id + '|' + e.fuel_type;
if (!m[k] || t > m[k]) m[k] = t;
}
pairChangeCache = m; pairChangeKey = key;
return m;
}
function pairLastChange(stationId, fuel) { return pairChangeMap()[stationId + '|' + fuel] || 0; }
// окно плашки «возможно есть топливо здесь»: не старше 24 ч и не раньше смены статуса
function maybeSince(stationId, fuel) { return Math.max(Date.now() - 24 * 3600 * 1000, pairLastChange(stationId, fuel)); }
function folkConsensus24(stationId, fuel) {
const since = Math.max(Date.now() - 2 * 60 * 60 * 1000, pairLastChange(stationId, fuel));
  const yes = new Set(), no = new Set();
  for (const f of allFeedback) {
    if (f.station_id !== stationId || f.fuel_type !== fuel) continue;
    if (new Date(f.created_at).getTime() < since) continue;
    if (f.feedback_type === 'available') yes.add(f.device_id || '?');
    else if (f.feedback_type === 'unavailable') no.add(f.device_id || '?');
  }
  const c = { yes: yes.size, no: no.size };
  if (c.yes >= 2 && c.yes > c.no) return { verdict: 'yes', votes: c.yes };
  if (c.no >= 2 && c.no > c.yes) return { verdict: 'no', votes: c.no };
  if (c.yes >= 1 && c.no >= 1) return { verdict: 'conflict', votes: c.yes + c.no };
  return null;
}
// Сигнал народа для плиток/пинов: сначала строгий консенсус (2 device_id / 2 ч),
// иначе — как блок «Наши водители»: перевес отметок за 24 ч (≥2).
function folkFuelSignal(stationId, fuel) {
  const strict = folkConsensus24(stationId, fuel);
  if (strict) return strict;
  const since = Math.max(Date.now() - 24 * 3600 * 1000, pairLastChange(stationId, fuel) || 0);
  let yes = 0, no = 0;
  for (const f of allFeedback) {
    if (f.station_id !== stationId || f.fuel_type !== fuel) continue;
    if (new Date(f.created_at).getTime() < since) continue;
    if (f.feedback_type === 'available') yes++;
    else if (f.feedback_type === 'unavailable') no++;
  }
  if (yes >= 2 && yes > no) return { verdict: 'yes', votes: yes, soft: true };
  if (no >= 2 && no > yes) return { verdict: 'no', votes: no, soft: true };
  if (yes >= 1 && no >= 1) return { verdict: 'conflict', votes: yes + no, soft: true };
  return null;
}
function stationCard(station, obs, pred) {
  const prediction = getPrediction(pred);
  const trust = availTrustworthy(obs);
  const scene = { '92': sceneMark(station.id, '92'), '95': sceneMark(station.id, '95'), 'diesel': sceneMark(station.id, 'diesel') };
  
  // ИСПОЛЬЗУЕМ 24 ЧАСА
  const useFolk = !trust;
  const fc95 = folkFuelSignal(station.id, '95');
  const fc92 = folkFuelSignal(station.id, '92');
  const fcdt = folkFuelSignal(station.id, 'diesel');
  
  const has95 = (trust && obs && obs.fuel_95_status === true) || !!scene['95'] || (useFolk && fc95?.verdict === 'yes');
const has92 = (trust && obs && obs.fuel_92_status === true) || !!scene['92'] || (useFolk && fc92?.verdict === 'yes');
const hasDt = (trust && obs && obs.diesel_status === true) || !!scene['diesel'] || (useFolk && fcdt?.verdict === 'yes');
  
  const availList = [];
  if (has95) availList.push('АИ-95');
  if (has92) availList.push('АИ-92');
  if (hasDt) availList.push('дизель');
  
  const lq = liveQueueCount(station.id);
  const qAge = queueAgeMin(station.id);
  const qHigh = obs && obs.queue_level === 'high';
  let qTxt = 'очередей не видно';
  if (lq) qTxt = lq + ' вод. стоят сейчас';
  else if (qHigh && qAge !== null) qTxt = 'очередь стоит ' + ageRu(qAge);
  else if (qHigh) qTxt = 'на станции очередь';
  let vCls, vIco, vTitle, vSub;
  if (availList.length) {
    const priceCol = has95 ? 'price_95' : has92 ? 'price_92' : 'price_diesel';
    const priceLbl = has95 ? 'АИ-95' : has92 ? 'АИ-92' : 'дизель';
    vCls = 'v-good'; vIco = 'i-pump';
    vTitle = 'Есть сейчас: ' + availList.join(', ');
    vSub = qTxt + '   ' + priceLbl + ' ' + priceShort(station.id, priceCol);
  } else if (obs && (obs.fuel_95_status === false || obs.fuel_92_status === false || obs.diesel_status === false)) {
    vCls = 'v-wait'; vIco = 'i-pump';
    vTitle = 'Топлива нет';
    vSub = pred
      ? 'вернётся ' + time5(pred.from_time) + '—' + time5(pred.to_time) + '   уверенность ' + prediction.confidence + '%'
      : 'прогноз возврата ещё зреет   ' + qTxt;
  } else {
    vCls = 'v-unknown'; vIco = 'i-clock';
    vTitle = 'Данные обновляются';
vSub = (obs && obs.data_freshness_minutes !== null && obs.data_freshness_minutes !== undefined ? 'источник не рассказывал про станцию ' + agoRu(obs.data_freshness_minutes) + ' — подскажут отметки водителей' : 'источник пока молчит — подскажут отметки водителей') + '   ' + qTxt;
  }
    const tile = (label, col, fk) => {
    const sc = scene[fk];
    if (sc) {
      // Отметка с места (GPS) - самый высокий приоритет
      const mins = Math.max(0, Math.round((Date.now() - sc.t) / 60000));
      return '<div class="f-tile"><span class="f-drop">' + icon('i-drop') + '</span><b>' + label + '</b>' +
        '<span class="f-st yes">есть   с места' + icon('i-check', 'ic-s') + '</span>' +
        '<span class="f-pill yes">водитель был там ' + (mins < 60 ? mins + ' мин' : Math.round(mins / 60) + ' ч') + ' назад</span></div>';
    }
    
    // Если источник не подтвердил, но водители собрали консенсус
    const fc = folkFuelSignal(station.id, fk);
    if (!trust && fc) {
      if (fc.verdict === 'yes') {
        return '<div class="f-tile" onclick="openWhyChip(this,\'folk\')">' +
          '<span class="f-drop">' + icon('i-drop') + '</span><b>' + label + '</b>' +
          '<span class="f-st yes">есть   народ' + icon('i-check', 'ic-s') + '</span>' +
          '<span class="f-pill yes">' + fc.votes + ' подтв.</span></div>';
      }
      if (fc.verdict === 'no') {
        return '<div class="f-tile" onclick="openWhyChip(this,\'folk\')">' +
          '<span class="f-drop">' + icon('i-drop') + '</span><b>' + label + '</b>' +
          '<span class="f-st no">нет   народ' + icon('i-cross', 'ic-s') + '</span>' +
          '<span class="f-pill no">' + fc.votes + ' опр.</span></div>';
      }
    }

    // Иначе показываем данные источника
    const stt = obs ? obs[col] : null;
    let stTxt, stIco, stCls;
    if (stt === true && trust) { stTxt = 'есть'; stIco = 'i-check'; stCls = 'yes'; }
    else if (stt === true && fc && fc.verdict === 'yes') {
      stTxt = 'есть   народ'; stIco = 'i-check'; stCls = 'yes';
      return '<div class="f-tile" onclick="openWhyChip(this,\'folk\')">' +
        '<span class="f-drop">' + icon('i-drop') + '</span><b>' + label + '</b>' +
        '<span class="f-st yes">' + stTxt + icon(stIco, 'ic-s') + '</span>' +
        '<span class="f-pill yes">' + fc.votes + ' подтв.</span></div>';
    }
    else if (stt === true) { stTxt = 'не подтверждён'; stIco = 'i-clock'; stCls = 'unknown'; }
    else if (stt === false) { stTxt = 'нет'; stIco = 'i-cross'; stCls = 'no'; }
    else { stTxt = 'нет данных'; stIco = 'i-minus'; stCls = 'none'; }
    return '<div class="f-tile"><span class="f-drop">' + icon('i-drop') + '</span><b>' + label + '</b>' +
      '<span class="f-st ' + stCls + '">' + stTxt + icon(stIco, 'ic-s') + '</span>' +
      confPill(obs, stt, trust) + '</div>';
  };
  const pp = allLastPrice[station.id];
  const pr = c => pp && pp[c] !== null && pp[c] !== undefined ? Number(pp[c]).toFixed(1) + ' ₽' : '—';
  const fw = queueWindowFor(station.id);
  let qVal, qSub, qCls;
  if (lq) { qVal = 'Сейчас стоят'; qSub = lq + ' вод. в очереди'; qCls = 'r'; }
  else if (qHigh) { qVal = 'Высокая'; qSub = qAge !== null ? 'стоит ' + ageRu(qAge) : 'очередь сейчас'; qCls = 'r'; }
  else if (fw) { qCls = fw.confidence < 40 ? 'g' : fw.confidence < 65 ? 'y' : 'r'; qVal = fw.confidence < 40 ? 'Низкая' : fw.confidence < 65 ? 'Средняя' : 'Высокая'; qSub = 'окно ' + fw.window; }
  else { qVal = 'Низкая'; qSub = 'очередей не видно'; qCls = 'g'; }
  let upVal = '—';
  if (obs && obs.timestamp) {
    const d = new Date(obs.timestamp); const now = new Date();
    const day = d.toDateString() === now.toDateString() ? 'Сегодня'
      : d.toDateString() === new Date(now.getTime() - 86400000).toDateString() ? 'Вчера'
      : String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
    upVal = day + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  const focusFuel = pred ? pred.fuel_type : '95';
  return '<article class="station compact">' +
    '<div class="station-header"><div class="station-logo">' + stationLogo(station) + '</div>' +
    '<div class="station-info"><div class="station-name">' + escapeHtml(station.name || 'АЗС') + '</div>' +
    '<div class="station-address">' + escapeHtml(station.brand ? station.brand + '   ' : '') + escapeHtml(station.address || '') + '</div></div>' +
'<button class="favorite ' + (isFavorite(station.id) ? 'on' : '') + '" data-station-id="' + station.id + '" onclick="toggleFavorite(this)" title="' + (isFavorite(station.id) ? 'В избранном — нажмите, чтобы убрать' : 'Следить за топливом') + '" aria-label="' + (isFavorite(station.id) ? 'В избранном' : 'Следить за топливом') + '">' + icon('i-heart') + '</button></div>' +
    '<div class="verdict ' + vCls + '"><span class="v-ico">' + icon(vIco) + '</span><span class="v-txt"><span class="verdict-t">' + escapeHtml(vTitle) + '</span><span class="verdict-s">' + escapeHtml(vSub) + '</span></span></div>' +
    '<div class="f-tiles">' + tile('АИ-92', 'fuel_92_status', '92') + tile('АИ-95', 'fuel_95_status', '95') + tile('Дизель', 'diesel_status', 'diesel') + '</div>' +
    '<div class="card-facts">' +
    '<div class="cf"><div><small>' + icon('i-rub', 'ic-s') + 'Цены</small><span class="cf-prices">' +
    '<span class="pr-row"><i class="pr-ico f92">92</i><b>' + pr('price_92') + '</b></span>' +
    '<span class="pr-row"><i class="pr-ico f95">95</i><b>' + pr('price_95') + '</b></span>' +
    '<span class="pr-row"><i class="pr-ico fdt">ДТ</i><b>' + pr('price_diesel') + '</b></span>' +
    '</span></div></div>' +
    '<div class="cf"><div><small>' + icon('i-queue', 'ic-s') + 'Очередь</small><b class="' + qCls + '">' + qVal + '</b><span class="cf-sub">' + escapeHtml(qSub) + '</span>' + queueStripHtml(station.id) + '</div></div>' +
    '<div class="cf"><div><small>' + icon('i-clock', 'ic-s') + 'Обновлено</small><b>' + upVal + '</b><span class="cf-sub">источник + народ</span>' + seenStripHtml(station.id) + '</div></div>' +
    '</div>' +
    '<div class="card-btns">' +
    '<button class="cta-btn big" onclick="showOnMap(\'' + station.id + '\')">' + icon('i-nav') + 'Построить маршрут' + icon('i-arrow') + '</button>' +
    tgButtonHtml(station) +
    '</div>' +
    '<div class="card-maprow" onclick="cardMapGo(\'' + station.id + '\')"><div class="cmr-txt"><b>На карте</b><small>Смотреть окрестности</small></div><div class="card-map-thumb"><div id="cardMapBox" class="card-map-box"></div></div></div>' +
    stationTimelineHtml(station, obs) +
    driverVerdictHtml(station.id) +
    folkCardHtml(station.id) +
    '<div class="sc-rowline"><div class="sc-rl-txt"><b>КогдаБенз Score<span class="sc-rl-i" onclick="openScorePop(\'' + station.id + '\',\'' + focusFuel + '\')">' + icon('i-help', 'ic-s') + '</span></b><small>Надёжность этой станции</small></div>' +
    scoreGaugeHtml(station, focusFuel) + '</div>' +
    '</article>';
}
function sparkline(stationId) {
  let rows = allHourly.filter(h => h.station_id === stationId).sort((a, b) => new Date(a.hour) - new Date(b.hour)).slice(-24);
  // фолбэк: тяжёлая почасовая вьюха station_hourly иногда отваливается при
  // перегрузе базы (allSettled честно её изолирует) — собираем ту же форму
  // доли АИ-95 по часам из живых наблюдений, чтобы кардиограмма не пропадала.
  // Час берём абсолютный (без поясов): у кардиограммы нет оси часов, важна форма.
  if (rows.length < 2) {
    const buckets = {};
    for (const o of allObservations) {
      if (o.station_id !== stationId) continue;
      const t = o.timestamp ? new Date(o.timestamp).getTime() : NaN;
      if (!isFinite(t)) continue;
      const hk = Math.floor(t / 3600000);
      const b = buckets[hk] = buckets[hk] || { total: 0, available_95: 0 };
      b.total++;
      if (o.fuel_95_status === true) b.available_95++;
    }
    rows = Object.keys(buckets).map(k => ({ hour: Number(k) * 3600000, total: buckets[k].total, available_95: buckets[k].available_95 }))
      .sort((a, b) => a.hour - b.hour).slice(-24);
  }
  if (rows.length < 2) return '';
  const vals = rows.map(r => r.total ? r.available_95 / r.total : 0);
  const W = 64, H = 22;
  const d = vals.map((v, i) => (i ? 'L' : 'M') + (i / (vals.length - 1) * W).toFixed(1) + ',' + (H - 2 - v * (H - 4)).toFixed(1)).join('');
  const last = vals[vals.length - 1];
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '"><path d="' + d + '" fill="none" stroke="' + (last >= .5 ? '#19b77a' : last > 0 ? '#f5b82e' : '#ef5350') + '" stroke-width="1.6" stroke-linecap="round"/></svg>';
}
function srcLabel(pred) {
  const src = pred.prediction_source || 'own';
  return src === 'own' ? 'ритм станции' : src === 'brand' ? 'ритм бренда' : 'ритм города';
}
function rowBadge(pred, obs) {
  if (!pred) return { cls:'none', text:'нет окна', sub:'копим данные' };
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (pred.target_date && pred.target_date > today) return { cls:'soon', text:'окно завтра', sub:time5(pred.from_time) + '–' + time5(pred.to_time) };
  const mins = new Date().getHours() * 60 + new Date().getMinutes();
  const fp = pred.from_time.split(':'), tp = pred.to_time.split(':');
  const f = Number(fp[0]) * 60 + Number(fp[1]), t = Number(tp[0]) * 60 + Number(tp[1]);
  if (mins >= f && mins <= t) return { cls:'open', text:'есть окно', sub:'сейчас выгоднее всего' };
  if (f - mins > 0 && f - mins <= 120) return { cls:'soon', text:'скоро будет', sub:'окно через ~' + (f - mins) + ' мин' };
  if (mins > t) return { cls:'late', text:'окно прошло', sub:'ждём новый прогноз' };
  return { cls:'soon', text:'окно в ' + time5(pred.from_time), sub:'сегодня' };
}
function stationRow(station, obs, pred) {
  const b = rowBadge(pred, obs);
  const color = BRAND_COLORS[brandKey(station)] || '#7c89a0';
  const fuelFocus = pred ? pred.fuel_type : (obs && obs.fuel_95_status === false ? '95' : '95');
  const col = fuelFocus === '92' ? 'fuel_92_status' : fuelFocus === '95' ? 'fuel_95_status' : 'diesel_status';
  const st = obs ? obs[col] : null;
  const stTxt = st === true ? 'есть' : st === false ? 'нет' : 'нет данных';
  const stCls = st === true ? 'yes' : st === false ? 'no' : 'unknown';
  const conf = pred ? Math.round((pred.confidence || 0) * 100) : null;

  return '<div class="srow-wrap" onclick="toggleRow(\'' + station.id + '\', this)" style="cursor:pointer; display:flex; align-items:stretch; background:#fff; border-radius:16px; margin:8px 0; box-shadow:0 2px 8px rgba(20,33,61,.04); overflow:hidden; border:1px solid #eef2f8;">' +
    '<div style="width:6px; background:' + color + '; flex-shrink:0;"></div>' +
    '<div style="flex:1; min-width:0; padding:14px; display:flex; flex-direction:column;">' +
      // Верхняя строка: Название и бейдж
      '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:4px;">' +
        '<div style="font-size:16px; font-weight:800; color:#14213d; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(station.name || 'АЗС') + '</div>' +
        '<div class="sbadge ' + b.cls + '" style="flex-shrink:0; white-space:nowrap;">' + b.text + '</div>' +
      '</div>' +
      // Адрес: жестко изолирован
      '<div style="font-size:12px; color:#71809c; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:12px;">' + escapeHtml(station.address || '') + '</div>' +
      // Нижняя сетка: 3 колонки
      '<div style="display:grid; grid-template-columns: 1fr 1.5fr auto; gap:12px; align-items:end; margin-top:auto;">' +
        '<div style="display:flex; flex-direction:column; min-width:0;">' +
          '<span style="font-size:9px; color:#a7b1c1; text-transform:uppercase; margin-bottom:3px; font-weight:700; line-height:1;">факт</span>' +
          '<span class="scol-v ' + stCls + '" style="font-size:13px; font-weight:800; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + fuelLabel(fuelFocus) + ': ' + stTxt + '</span>' +
        '</div>' +
        '<div style="display:flex; flex-direction:column; min-width:0;">' +
          '<span style="font-size:9px; color:#a7b1c1; text-transform:uppercase; margin-bottom:3px; font-weight:700; line-height:1;">прогноз</span>' +
          '<span style="font-size:13px; font-weight:800; color:#14213d; line-height:1.2; white-space:nowrap;">' + (pred ? time5(pred.from_time) + '–' + time5(pred.to_time) : '—') + '</span>' +
          (conf !== null ? '<span style="font-size:10px; color:#71809c; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1;">' + conf + '%   ' + srcLabel(pred) + '</span>' : '') +
        '</div>' +
        '<div style="display:flex; flex-direction:column; align-items:flex-end; flex-shrink:0;">' +
          sparkline(station.id) +
          '<span style="font-size:10px; color:#71809c; margin-top:2px; line-height:1;">' + accuracyShort(station.id) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}
function toggleRow(id, btn) { openSheet(id); }
function openSheet(id) {
  const st = allStations.find(s => s.id === id);
  if (!st) return;
  track('open_station_card', null, id);
  learnFromAction(id, 'card_open');
  const obs = getLastObservations()[id];
  disposeCardMap(); // старая карточная карта привязана к контейнеру, который сейчас затрётся
  document.getElementById('sheetBody').innerHTML = stationCard(st, obs, pickPrediction(id, obs));
  document.getElementById('sheet').classList.add('open');
  document.getElementById('sheetBack').classList.add('open');
  requestAnimationFrame(() => mountCardMap(st));
}
function closeSheet() {
  disposeCardMap(); // карточка закрывается — карта уходит вместе с ней, без утечки контекста
  const sheet = document.getElementById('sheet'); const back = document.getElementById('sheetBack');
  if (sheet) { sheet.classList.remove('open'); sheet.style.zIndex = ''; }
  if (back) { back.classList.remove('open'); back.style.zIndex = ''; }
  // карточку открыли с карты — возвращаемся на панель карты;
  // центр и зум не тронуты (карта не пересоздавалась), место то же
  if (sheetFromMap) { sheetFromMap = false; pagerGo(2); }
}
/* Линия маршрута на отдельном 2D-канвасе поверх карты: GL-слои на этом
   устройстве линию не отрисовали дважды (отдельный источник, затем источник
   зон), а обычный канвас рисуется гарантированно. Перерисовка на каждом
   движении карты; крестик на плашке очищает канвас. */
function routeCanvasEl() {
  if (!mapObj) return null;
  let cv = document.getElementById('routeCanvas');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'routeCanvas';
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4';
    mapObj.getContainer().appendChild(cv);
    mapObj.on('move', drawRouteCanvas);
    mapObj.on('resize', drawRouteCanvas);
  }
  return cv;
}
function drawRouteCanvas() {
  const cv = document.getElementById('routeCanvas');
  if (!cv || !mapObj) return;
  const box = mapObj.getContainer().getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(box.width * dpr)), H = Math.max(1, Math.round(box.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, box.width, box.height);
  // граница области обслуживания: волнистый живой контур + штриховка
  // «недоступно» снаружи (красно-белая диагональная зебра, как запрещённые
  // зоны в играх). Клип evenodd: прямоугольник экрана минус кольцо —
  // зебра ложится только ВНЕ области обслуживания. Тает к уличному зуму.
  if (serviceRing) {
    const z = mapObj.getZoom();
    const a = z <= 10 ? 0.6 : z >= 12 ? 0 : 0.6 * (12 - z) / 2;
    if (a > 0.02) {
      const pts = [];
      for (let i = 0; i < serviceRing.length; i++) pts.push(mapObj.project(serviceRing[i]));
      // зебра снаружи
      g.save();
      g.beginPath();
      g.rect(0, 0, box.width, box.height);
      for (let i = 0; i < pts.length; i++) { if (i) g.lineTo(pts[i].x, pts[i].y); else g.moveTo(pts[i].x, pts[i].y); }
      g.closePath();
      g.clip('evenodd');
      const step = 14, HH = box.height;
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(255,255,255,' + (a * 0.5).toFixed(3) + ')';
      g.beginPath();
      for (let x = -HH + step / 2; x < box.width + HH; x += step) { g.moveTo(x, 0); g.lineTo(x + HH, HH); }
      g.stroke();
      g.strokeStyle = 'rgba(57,124,255,' + (a * 0.18).toFixed(3) + ')';
      g.beginPath();
      for (let x = -HH; x < box.width + HH; x += step) { g.moveTo(x, 0); g.lineTo(x + HH, HH); }
      g.stroke();
      // вода: собираем экранные полигоны один раз — они нужны и для вырубки
      // зебры, и для клипа пунктирной кромки (граница не должна идти по морю)
      let waterPolys = [];
      try {
        const opts = waterLayerIds.length ? { layers: waterLayerIds } : undefined;
        const wf = mapObj.queryRenderedFeatures([[0, 0], [box.width, box.height]], opts);
        for (const f of wf) {
          if (!f.layer || String(f.layer.id).indexOf('water') < 0) continue;
          const gg = f.geometry;
          if (!gg) continue;
          const polys = gg.type === 'Polygon' ? [gg.coordinates] : gg.type === 'MultiPolygon' ? gg.coordinates : null;
          if (!polys) continue;
          for (const poly of polys) waterPolys.push(poly.map(ring => ring.map(c => mapObj.project(c))));
        }
      } catch (e) {}
      // вырубаем зебру над водой: на море не может быть АЗС.
      // destination-out стирает только пиксели зебры на этом канвасе, море чистое.
      if (waterPolys.length) {
        g.globalCompositeOperation = 'destination-out';
        for (const poly of waterPolys) {
          g.beginPath();
          for (const ring of poly) {
            for (let i = 0; i < ring.length; i++) { if (i) g.lineTo(ring[i].x, ring[i].y); else g.moveTo(ring[i].x, ring[i].y); }
            g.closePath();
          }
          g.fill('evenodd'); // evenodd сохраняет острова внутри воды нетронутыми
        }
        g.globalCompositeOperation = 'source-over';
      }
      g.restore();
      // сама кромка: мягкое свечение + точки поверх зебры.
      // Клип по воде (evenodd: прямоугольник экрана минус полигоны воды) —
      // граница не перечёркивает море: над водой линия просто не рисуется,
      // обрываясь на берегу, а на суше и на островах остаётся.
      g.save();
      if (waterPolys.length) {
        g.beginPath();
        g.rect(0, 0, box.width, box.height);
        for (const poly of waterPolys) {
          for (const ring of poly) {
            for (let i = 0; i < ring.length; i++) { if (i) g.lineTo(ring[i].x, ring[i].y); else g.moveTo(ring[i].x, ring[i].y); }
            g.closePath();
          }
        }
        g.clip('evenodd');
      }
      g.beginPath();
      for (let i = 0; i < pts.length; i++) { if (i) g.lineTo(pts[i].x, pts[i].y); else g.moveTo(pts[i].x, pts[i].y); }
      g.closePath();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.setLineDash([]);
      g.lineWidth = 10;
      g.strokeStyle = 'rgba(57,124,255,' + (a * 0.10).toFixed(3) + ')';
      g.stroke();
      g.setLineDash([0.5, 8.5]);
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(57,124,255,' + (a * 0.7).toFixed(3) + ')';
      g.stroke();
      g.restore();
    }
  }
  if (!routeFeature || !routeFeature.geometry) return;
  const coords = routeFeature.geometry.coordinates;
  const step = Math.max(1, Math.floor(coords.length / 400));
  const pts = [];
  for (let i = 0; i < coords.length; i += step) pts.push(mapObj.project([coords[i][0], coords[i][1]]));
  const lastC = coords[coords.length - 1];
  pts.push(mapObj.project([lastC[0], lastC[1]]));
  // линия как в навигаторе: мягкая синяя тень 	 белая окантовка 	 синий
  // стержень; углы сглажены квадратами через середины отрезков — лаконично
  const trace = () => {
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      g.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const lp = pts[pts.length - 1];
    g.lineTo(lp.x, lp.y);
  };
  g.lineJoin = 'round'; g.lineCap = 'round';
  // фокус на маршруте: лёгкая мягкая вуаль по всей карте, затем вокруг
  // линии вырезается коридор с пером (края затухают ступенями) — внимание
  // остаётся на маршруте, остальное уходит в тень
  // туман только в обзорном виде: на уличном зуме карта чистая и цветная,
  // между z 14 и 15.2 вуаль и коридоры плавно тают — на глубоком зуме серая
  // каша и «прожекторы» не мешают читать улицы
  const veil = Math.max(0, Math.min(1, (15.2 - mapObj.getZoom()) / 1.2));
  if (veil > 0.02) {
    g.fillStyle = 'rgba(20,33,61,' + (0.22 * veil).toFixed(3) + ')';
    g.fillRect(0, 0, box.width, box.height);
    g.globalCompositeOperation = 'destination-out';
    trace(); g.strokeStyle = 'rgba(0,0,0,' + veil.toFixed(3) + ')'; g.lineWidth = 26; g.stroke();
    trace(); g.strokeStyle = 'rgba(0,0,0,' + (0.6 * veil).toFixed(3) + ')'; g.lineWidth = 46; g.stroke();
    trace(); g.strokeStyle = 'rgba(0,0,0,' + (0.3 * veil).toFixed(3) + ')'; g.lineWidth = 68; g.stroke();
    trace(); g.strokeStyle = 'rgba(0,0,0,' + (0.12 * veil).toFixed(3) + ')'; g.lineWidth = 120; g.stroke();
    g.globalCompositeOperation = 'source-over';
  }
  trace(); g.strokeStyle = 'rgba(23,70,200,.16)'; g.lineWidth = 12; g.stroke();
  trace(); g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 8.5; g.stroke();
  trace(); g.strokeStyle = '#2465ee'; g.lineWidth = 5; g.stroke();
}
function showOnMap(id) {
  const st = allStations.find(s => s.id === id);
  if (!st) return;
  closeSheet();
  pagerGo(2);
  ensureMap();
  const go = () => {
    if (!mapObj) { setTimeout(go, 150); return; }
    drawRouteTo(st);
    maybeFavFollowOffer(id);
  };
  go();
}
/* Маршрут по дорогам от точки пользователя до АЗС: публичный OSRM отдаёт
   геометрию маршрута, рисуем её линией с белой подложкой и обзораем кадр
   по границам маршрута. Нет точки или роутер молчит — честный фолбэк:
   просто полёт к АЗС, как раньше. */
function mapReady() { return mapObj.isStyleLoaded() ? Promise.resolve() : new Promise(res => mapObj.once('load', res)); }
function clearRoute() {
  routeFeature = null;
  drawRouteCanvas();
  if (mapObj && zoneReady) renderMap();
  if (window.__routeEndMarker) { window.__routeEndMarker.remove(); window.__routeEndMarker = null; }
  const plate = document.getElementById('routePlate');
  if (plate) plate.classList.remove('open');
}
async function drawRouteTo(st) {
  const stLon = Number(st.lon), stLat = Number(st.lat);
  const fallbackFly = () => { mapObj.stop(); mapObj.easeTo({ center: [stLon, stLat], zoom: 15, duration: 900 }); };
  let loc = loadUserLocation();
  if (!loc && navigator.geolocation) {
    loc = await new Promise(res => navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => res(null), { timeout: 5000, maximumAge: 300000 }));
    if (loc) { saveUserLocation(loc.lat, loc.lon); showUserMarker(loc.lat, loc.lon); detectUserCity(); }
  }
  if (!loc) { fallbackFly(); alert('Разреши определение местоположения — и в следующий раз маршрут от тебя до АЗС построится сразу.'); return; }
  // OSRM из РФ часто блокирует/троттлит — пробуем основной хост, а если
  // не отвечает за 6 сек или отдаёт ошибку, переключаемся на публичное зеркало Fossgis
  const query = loc.lon + ',' + loc.lat + ';' + stLon + ',' + stLat + '?overview=full&geometries=geojson';
  const hosts = [
    'https://router.project-osrm.org/route/v1/driving/',
    'https://osrm.fossgis.de/routing-engine/v1/driving/'
  ];
  let rt = null, lastErr = null;
  for (const host of hosts) {
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(host + query, { signal: ctrl.signal });
      clearTimeout(tm);
      if (!r.ok) { lastErr = new Error(host + ' 	 HTTP ' + r.status); continue; }
      const j = await r.json();
      if (j.code !== 'Ok' || !j.routes || !j.routes.length) { lastErr = new Error(host + ' 	 маршрут не найден'); continue; }
      rt = j.routes[0];
      console.log('route OK от ' + host + ': точек ' + rt.geometry.coordinates.length + ', ' + Math.round(rt.distance) + ' м, ' + Math.round(rt.duration) + ' с');
      break;
    } catch (e) {
      lastErr = e;
      console.log('route fail ' + host + ': ' + e.message);
    }
  }
  if (!rt) { console.log('route: оба хоста молчат (' + (lastErr && lastErr.message) + ') — летим к АЗС без линии'); fallbackFly(); return; }
  await mapReady();await mapReady();
  // линия живёт в источнике зон (kind 'route'): этот конвейер на телефоне
  // доказанно работает (лужи рисуются), в отличие от отдельного geojson-источника
  routeFeature = { type: 'Feature', properties: { color: '#2465ee', kind: 'route' }, geometry: rt.geometry };
track('route_built', null, st.id);
learnFromAction(st.id, 'route_built');
renderMap();
routeCanvasEl();
  drawRouteCanvas();
  // маркер финиша на АЗС — даже если линия не видна (очень редкий случай),
  // цель поездки очевидна: синий флаг на пине АЗС
  if (!window.__routeEndMarker) {
    const el = document.createElement('div');
    el.className = 'route-end-pin';
    el.innerHTML = '<div style="width:22px;height:22px;border-radius:50%;background:#2465ee;border:3px solid #fff;box-shadow:0 4px 12px rgba(36,101,238,.5);display:grid;place-items:center;color:#fff;font-size:13px;font-weight:900">★</div>';
    window.__routeEndMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([stLon, stLat]).addTo(mapObj);
  } else {
    window.__routeEndMarker.setLngLat([stLon, stLat]);
  }
  let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
  for (const c of rt.geometry.coordinates) { if (c[0] < minLon) minLon = c[0]; if (c[0] > maxLon) maxLon = c[0]; if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1]; }
  mapObj.stop();
  mapObj.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 70, maxZoom: 15, duration: 900 });
  const min = Math.max(1, Math.round(rt.duration / 60)), km = rt.distance / 1000;
  const plate = document.getElementById('routePlate');
  if (plate) {
    plate.innerHTML = icon('i-truck', 'ic-s') + '<span>≈ ' + (min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч ' + (min % 60) + ' мин') + '   ' + (km < 1 ? Math.round(km * 1000) + ' м' : km.toFixed(1) + ' км') + ' по дорогам</span><button onclick="clearRoute()" aria-label="Убрать маршрут">' + icon('i-close', 'ic-s') + '</button>';
    plate.classList.add('open');
  }
}
function toggleFeedback(stationId) {
  const panel = document.getElementById('feedback-' + stationId);
  if (panel) panel.classList.toggle('open');
}
function pagerGo(i) { const p = document.getElementById('pager'); if (!p) return; i = Math.max(0, Math.min(4, i)); p.scrollTo({ left: p.clientWidth * i, behavior: 'smooth' }); }
// ПК: переключение панелей стрелками клавиатуры ← 	 (мобильные не задеты:
// проверка ширины + игнор ввода в полях)
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (window.innerWidth < 900) return;
  pagerGo(currentPanel + (e.key === 'ArrowRight' ? 1 : -1));
});
/* тепло */
function badColor(v) {
  const stops = [[47,211,154],[245,213,101],[245,160,90],[239,83,80]];
  const x = Math.max(0, Math.min(1, v)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return 'rgb(' + stops[i].map((s, k) => Math.round(s + (stops[i+1][k] - s) * f)).join(',') + ')';
}
function heatRows() {
  return [
    { label:'АИ-92', icon:'i-pump', bad:r => r.k92 ? 1 - r.a92 / r.k92 : null, stat:r => r.k92 ? r.a92 / r.k92 : null, inv:false },
    { label:'АИ-95', icon:'i-pump', bad:r => r.k95 ? 1 - r.a95 / r.k95 : null, stat:r => r.k95 ? r.a95 / r.k95 : null, inv:false },
    { label:'Дизель', icon:'i-pump', bad:r => r.kdt ? 1 - r.adt / r.kdt : null, stat:r => r.kdt ? r.adt / r.kdt : null, inv:false },
    { label:'Очереди', icon:'i-queue', bad:r => r.selling ? Math.min(1, (r.q / r.selling) / 0.3) : null, stat:r => r.selling ? r.q / r.selling : null, inv:true }
  ];
}
/* Прогноз на тепловой матрице: тусклые пилюли справа от «сейчас» = прогноз по
   ритму за 3 суток; синий контур = окно возврата по PENDING-прогнозам города
   (для очередей — медианное окно городских очередных событий). Факт и прогноз
   разделены визуально, как требует правило продукта. */
function bandOf(cnt) {
  let max = 0, at = -1;
  for (let h = 0; h < 24; h++) if (cnt[h] > max) { max = cnt[h]; at = h; }
  if (at < 0 || max < 1) return null;
  let s = at, e = at;
  while (s > 0 && cnt[s - 1] >= max / 2) s--;
  while (e < 23 && cnt[e + 1] >= max / 2) e++;
  return [s, e];
}
function inBand(h, b) { return b[0] <= b[1] ? (h >= b[0] && h <= b[1]) : (h >= b[0] || h <= b[1]); }
function cityQueueBand() {
  const ids = new Set(scopeIds());
  const mins = [];
  for (const e of allQueueEvents) if (ids.has(e.station_id)) {
    const d = new Date(new Date(e.detected_at).getTime() + 3 * 3600 * 1000);
    mins.push(d.getUTCHours() * 60 + d.getUTCMinutes());
  }
  if (mins.length < 3) return null;
  mins.sort((a, b) => a - b);
  const med = mins.length % 2 ? mins[(mins.length - 1) / 2] : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2;
  const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
  const sd = Math.max(30, Math.sqrt(mins.reduce((s, t) => s + (t - mean) * (t - mean), 0) / mins.length));
  return [Math.floor((((med - sd) / 60) % 24 + 24) % 24), Math.floor((((med + sd) / 60) % 24 + 24) % 24)];
}
function renderHeat() {
  const grid = document.getElementById('heatGrid');
  if (!grid) return;
  const byHour = {};
  for (const r of fuelHourly) byHour[new Date(r.hour).getHours()] = r;
  const last = fuelHourly.length ? fuelHourly[fuelHourly.length - 1] : null;
  // Слова-подписи берём из последних отметок КАЖДОЙ станции (тот же источник,
  // что чипы и шапка), а не из незакрытого текущего часа тепловой истории:
  // в начале часа в бакет успевают попасть не все станции и доля проседает.
  const lastObs = getLastObservations();
  let k92 = 0, a92 = 0, k95 = 0, a95 = 0, kdt = 0, adt = 0, qh = 0, selling = 0;
  for (const id of scopeIds()) {
    const o = lastObs[id];
    if (!o) continue;
    if (o.fuel_92_status !== null && o.fuel_92_status !== undefined) { k92++; if (o.fuel_92_status) a92++; }
    if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) { k95++; if (o.fuel_95_status) a95++; }
    if (o.diesel_status !== null && o.diesel_status !== undefined) { kdt++; if (o.diesel_status) adt++; }
    // selling — станция продаёт прямо сейчас (хоть одно топливо есть):
    // тот же знаменатель, что у клеток тепла (вьюха region_fuel_hourly),
    // чтобы надпись «низкая/средняя/высокая» не спорила с цветом ряда
    if (o.fuel_92_status === true || o.fuel_95_status === true || o.diesel_status === true) selling++;
    if (o.queue_level === 'high') qh++;
  }
  const nowStat = {
    'АИ-92': k92 ? a92 / k92 : null,
    'АИ-95': k95 ? a95 / k95 : null,
    'Дизель': kdt ? adt / kdt : null,
    'Очереди': selling ? qh / selling : null
  };
  // окна прогноза справа от «сейчас»: топлива — по PENDING-прогнозам города
  // за сегодня, очереди — по медианному окну городских очередных событий
  const nowH = new Date().getHours();
  const cityIds = new Set(scopeIds());
  const todayStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const fuelOfRow = { 'АИ-92': '92', 'АИ-95': '95', 'Дизель': 'diesel' };
  const fcBand = { 'АИ-92': null, 'АИ-95': null, 'Дизель': null, 'Очереди': cityQueueBand() };
  for (const lbl of ['АИ-92', 'АИ-95', 'Дизель']) {
    const cnt = new Array(24).fill(0);
    for (const p of allPredictions) {
      if (p.result !== 'PENDING' || p.fuel_type !== fuelOfRow[lbl]) continue;
      if (!cityIds.has(p.station_id) || p.target_date !== todayStr) continue;
      const f = Number(String(p.from_time).slice(0, 2)), t = Number(String(p.to_time).slice(0, 2));
      for (let h = nowH + 1; h < 24; h++) if (h >= f && h <= t) cnt[h]++;
    }
    fcBand[lbl] = bandOf(cnt);
  }
  let html = '';
  for (const row of heatRows()) {
    let cells = '';
    const band = fcBand[row.label];
    for (let h = 0; h < 24; h++) {
      const r = byHour[h];
      const v = r ? row.bad(r) : null;
      const fut = h > nowH;
      cells += '<div class="hm-cell' + (fut ? ' fut' : '') + (fut && band && inBand(h, band) ? ' fc' : '') + '" style="background:' + (v === null ? '#eef2f8' : badColor(v)) + '"></div>';
    }
    const s = nowStat[row.label] !== undefined ? nowStat[row.label] : null;
    let stTxt = '—', stCls = 'n';
    if (s !== null) {
      // очереди — в той же шкале «плохости» 0..1, что и цвет клетки;
      // топливо — честно по смыслу: «нет» только при нуле станций с топливом,
      // иначе даже 4 из 10 — это «мало», а не «нет»
      let good;
      if (row.inv) {
        const v = Math.min(1, s / 0.3);
        good = v < 0.25 ? 2 : v < 0.6 ? 1 : 0;
      } else {
        good = s <= 0 ? 0 : s < 0.6 ? 1 : 2;
      }
      if (good === 2) { stTxt = row.inv ? 'низкая' : 'есть'; stCls = 'g'; }
      else if (good === 1) { stTxt = row.inv ? 'средняя' : 'мало'; stCls = 'y'; }
      else { stTxt = row.inv ? 'высокая' : 'нет'; stCls = 'r'; }
    }
    html += '<div class="hm-row"><div class="hm-label">' + icon(row.icon) + '<span><span class="hm-name">' + row.label + '</span><span class="hm-stat ' + stCls + '">' + stTxt + '</span></span></div><div class="hm-cells">' + cells + '</div></div>';
  }
  html += '<div class="hm-nowline" id="hmNow"><span class="hm-nowtag">сейчас</span><i></i><i></i><i></i><i></i></div>';
  if (fcBand['АИ-95']) {
    const b = fcBand['АИ-95'];
    const mid = (b[0] <= b[1] ? (b[0] + b[1] + 1) / 2 : (b[0] + 12) % 24) / 24;
    html += '<div class="hm-fcline" style="left:calc(86px + (100% - 86px) * ' + mid.toFixed(3) + ')"><span class="hm-fctag">прогноз ' + String(b[0]).padStart(2, '0') + '–' + String((b[1] + 1) % 24).padStart(2, '0') + '</span></div>';
  }
  grid.innerHTML = html;
  const line = document.getElementById('hmNow');
  if (line) { const d = new Date(); line.style.setProperty('--frac', ((d.getHours() + d.getMinutes() / 60) / 24).toFixed(3)); }
}
/* цена станции для карточки: последняя известная цена + дельта к городу */
function priceCell(stationId, col, cityKey) {
  const p = allLastPrice[stationId];
  const v = p ? p[col] : null;
  if (v === null || v === undefined) return '<div class="info-value">нет данных</div>';
  const cur = priceHourly.find(r => r[cityKey] !== null);
  let d = 'город: —';
  if (cur) {
    const dv = v - cur[cityKey];
    d = (dv > 0.049 ? '+' : dv < -0.049 ? '−' : '±') + Math.abs(dv).toFixed(1) + ' ₽ к городу';
  }
  return '<div class="info-value">' + Number(v).toFixed(1) + ' ₽</div><div class="info-delta">' + d + '</div>';
}
function goodRow(r) {
  if (!r) return false;
  const bad = r.k95 ? 1 - r.a95 / r.k95 : 0.5;
  const q = r.selling ? r.q / r.selling : 0;
  return bad < 0.4 && q < 0.1;
}
function peakAndCalm() {
  const byHour = {};
  for (const r of fuelHourly) byHour[new Date(r.hour).getHours()] = r;
  let peakH = null, peakV = -1;
  for (let h = 0; h < 24; h++) {
    const r = byHour[h];
    const v = r && r.selling ? r.q / r.selling : 0;
    if (v > peakV) { peakV = v; peakH = h; }
  }
  let best = null;
  for (let h = 0; h < 24; h++) {
    let len = 0;
    while (len < 8) {
      if (goodRow(byHour[(h + len) % 24])) len++; else break;
    }
    if (len >= 2 && (!best || len > best.len)) best = { h, len };
  }
  // последний завершённый «хороший» отрезок 2+ часа хронологически (за 3 суток)
  let lastCalm = 'за 3 суток не было';
  let runStart = null, runLen = 0, lastRun = null;
  for (const r of fuelHourly) {
    if (goodRow(r)) { if (runStart === null) runStart = r.hour; runLen++; }
    else { if (runLen >= 2) lastRun = { start: runStart, len: runLen }; runStart = null; runLen = 0; }
  }
  if (runLen >= 2) lastRun = { start: runStart, len: runLen };
  if (lastRun) {
    const s = new Date(lastRun.start);
    const e = new Date(s.getTime() + lastRun.len * 3600000);
    const now = new Date();
    const hh = d => String(d.getHours()).padStart(2, '0');
    let day;
    if (s.toDateString() === now.toDateString()) day = 'сегодня';
    else if (s.toDateString() === new Date(now.getTime() - 86400000).toDateString()) day = 'вчера';
    else day = String(s.getDate()).padStart(2, '0') + '.' + String(s.getMonth() + 1).padStart(2, '0');
    lastCalm = day + ' ' + hh(s) + '–' + hh(e);
  }
  // совет: с какого часа лучше вставать в очередь — следующее начало хорошего
  // окна по истории за 3 суток; если вся история «плохая» — час с минимальной очередью
  let advice = null;
  if (fuelHourly.length) {
    const nowH = new Date().getHours();
    const qSum = {}, qN = {}, bSum = {}, bN = {};
    for (const r of fuelHourly) {
      const h = new Date(r.hour).getHours();
      if (r.selling) { qSum[h] = (qSum[h] || 0) + r.q / r.selling; qN[h] = (qN[h] || 0) + 1; }
      if (r.k95) { bSum[h] = (bSum[h] || 0) + (1 - r.a95 / r.k95); bN[h] = (bN[h] || 0) + 1; }
    }
    const goodH = h => (bN[h] ? bSum[h] / bN[h] : 0.5) < 0.4 && (qN[h] ? qSum[h] / qN[h] : 1) < 0.1;
    let advH = null;
    for (let off = 1; off <= 24 && advH === null; off++) {
      const h = (nowH + off) % 24;
      if (goodH(h) && goodH((h + 1) % 24)) advH = h;
    }
    if (advH === null) {
      let bq = Infinity;
      for (let off = 1; off <= 24; off++) {
        const h = (nowH + off) % 24;
        if (!qN[h]) continue;
        const v = qSum[h] / qN[h];
        if (v < bq) { bq = v; advH = h; }
      }
    }
    if (advH !== null) advice = String(advH).padStart(2, '0') + ':00';
  }
  return {
    peak: peakV > 0 ? String(peakH).padStart(2, '0') + ':00–' + String((peakH + 3) % 24).padStart(2, '0') + ':00' : '—',
    calm: best ? String(best.h).padStart(2, '0') + ':00–' + String((best.h + best.len) % 24).padStart(2, '0') + ':00' : '—',
    lastCalm: lastCalm,
    advice: advice
  };
}
/* кардиограмма */
let pulseRaw = [], pulseEv = [];
/* мини-карта на главной панели: живая «Карта спроса» с дальней камеры.
   Тот же MapLibre, тот же стиль и те же слои (поле тепла, лужи очередей,
   стеклянные кластеры, капли-одиночки, подписи городов), но камера вмещает
   весь город пользователя, а карта не реагирует на палец: тап открывает
   полную карту. Радиус тепла умножаем на долю высоты канваса от полной
   карты — картинка та же, просто окно меньше. */
const PIN_COL = { yes: '#1bb978', part: '#f5a05a', diesel: '#6ea8ff', no: '#ef5350', conflict: '#f5a05a', unknown: '#a7b1c1' };
let miniMapObj = null, miniMarkers = [], miniReady = false, miniFittedCity = null, miniUserMarker = null, miniLabelCtrls = [];
// MapLibre приезжает лениво: раньше ~800 КБ стояли в <head> и блокировали
// отрисовку страницы. Теперь библиотека грузится в момент, когда карта
// реально понадобилась, а preconnect в шапке греет соединение заранее.
let maplibrePromise = null;
function ensureMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (maplibrePromise) return maplibrePromise;
  maplibrePromise = new Promise((res, rej) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
    link.onerror = () => { console.error('MapLibre CSS не загрузился'); };
    document.head.appendChild(link);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
    s.onload = () => { console.log('MapLibre загружен'); res(); };
    s.onerror = (e) => { 
      console.error('MapLibre JS не загрузился', e); 
      maplibrePromise = null; 
      rej(new Error('maplibre не загрузился')); 
    };
    document.head.appendChild(s);
  });
  return maplibrePromise;
}
// Мини-карта ниже сгиба экрана: строим её только когда водитель доскроллил.
// Второй WebGL-контекст и тайлы больше не тормозят вход.
let miniMapQueued = false;
function ensureMiniMap() {
const box = document.getElementById('miniMapBox');
if (!box || miniMapObj || miniMapQueued) return;
if (liteMode && !liteMapOk) { litePlaceholder(box); return; }
miniMapQueued = true;
  const run = () => ensureMapLibre().then(buildMiniMap).catch(() => { miniMapQueued = false; });
  if (!('IntersectionObserver' in window)) { run(); return; }
  const io = new IntersectionObserver(es => {
    if (!es[0].isIntersecting) return;
    io.disconnect();
    run();
  }, { rootMargin: '240px' });
  io.observe(box);
}
function buildMiniMap() {
  const box = document.getElementById('miniMapBox');
  if (!box || miniMapObj) return;
  
  box.innerHTML = '<div class="status" style="display:flex;align-items:center;justify-content:center;height:100%;font-size:11px"><span class="ob-spin"></span>Загрузка...</div>';
  
  if (!window.maplibregl) { 
    box.innerHTML = '<div class="status" style="color:#c26a2a;font-size:11px">❌ Карта не загрузилась</div>';
    return; 
  }
  box.innerHTML = '';
  miniMapObj = new maplibregl.Map({
    container: 'miniMapBox',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: [37.77, 44.72],
    zoom: 9,
    attributionControl: false,
    interactive: false
  });
  miniMapObj.on('load', () => {
    for (const layer of miniMapObj.getStyle().layers || []) {
      if (layer.type === 'symbol') miniMapObj.setLayoutProperty(layer.id, 'visibility', 'none');
      else if (layer.id.indexOf('building') >= 0) miniMapObj.setLayoutProperty(layer.id, 'visibility', 'none');
    }
    for (const l of OUR_LABELS) {
      const el = document.createElement('div');
      el.className = 'mlabel' + (l.city ? ' city' : '');
      el.textContent = l.name;
      new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([l.lon, l.lat]).addTo(miniMapObj);
      miniLabelCtrls.push({ el: el, minZoom: l.minZoom || 0 });
    }
    miniMapObj.addSource('fuelheat', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const CARD_FH_DEFS = [
  { id:'fuelheat-calm', cls:'calm', ramp:['rgba(47,211,154,0)','rgba(47,211,154,0.35)','rgba(27,185,120,0.55)','rgba(27,185,120,0.70)','rgba(18,168,106,0.80)'] },
  { id:'fuelheat-partial', cls:'partial', ramp:['rgba(45,212,191,0)','rgba(45,212,191,0.40)','rgba(45,212,191,0.60)','rgba(56,189,248,0.70)','rgba(56,189,248,0.90)'] },
  { id:'fuelheat-calm-old', cls:'calm-old', ramp:['rgba(47,211,154,0)','rgba(47,211,154,0.16)','rgba(27,185,120,0.25)','rgba(27,185,120,0.32)','rgba(18,168,106,0.36)'] },
  { id:'fuelheat-partial-old', cls:'partial-old', ramp:['rgba(45,212,191,0)','rgba(45,212,191,0.20)','rgba(45,212,191,0.30)','rgba(56,189,248,0.35)','rgba(56,189,248,0.40)'] },
  { id:'fuelheat-hot', cls:'hot', ramp:['rgba(239,83,80,0)','rgba(239,83,80,0.40)','rgba(239,83,80,0.65)','rgba(239,83,80,0.85)','rgba(220,38,38,0.95)'] },
  { id:'fuelheat-hot-old', cls:'hot-old', ramp:['rgba(239,83,80,0)','rgba(239,83,80,0.18)','rgba(239,83,80,0.28)','rgba(239,83,80,0.35)','rgba(239,83,80,0.45)'] }
];
    for (const d of FH_DEFS) {
      miniMapObj.addLayer({
        id: d.id, type: 'heatmap', source: 'fuelheat',
        filter: ['==', ['get', 'cls'], d.cls],
        paint: {
          'heatmap-weight': ['get', 'w'],
          'heatmap-intensity': 1.8,
          'heatmap-radius': 60,
          'heatmap-opacity': 0.55,
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, d.ramp[0], 0.25, d.ramp[1], 0.5, d.ramp[2], 0.75, d.ramp[3], 1, d.ramp[4]]
        }
      });
    }
    miniMapObj.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    miniMapObj.addLayer({ id: 'zones-halo', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'halo'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 } });
    miniMapObj.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'main'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 } });
    miniMapObj.addLayer({ id: 'zones-core', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'core'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.24 } });
    miniMapObj.addLayer({ id: 'zones-line', type: 'line', source: 'zones', filter: ['==', ['get', 'kind'], 'main'], paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.24, 'line-width': 1.2, 'line-dasharray': [1, 1.8] } });
    miniReady = true;
    renderMiniMap();
  });
}
function renderMiniMap() {
  if (!miniMapObj || !miniReady) return;
  const city = cityStationList().filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)));
  if (!city.length) return;
  // камера: весь город пользователя с полями, но не ближе z12.4 —
  // это и есть «вид с далека»: кластеры и лужи, а не капли по улицам
  if (miniFittedCity !== userCityKey) {
    let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
    for (const s of city) {
      const lon = Number(s.lon), lat = Number(s.lat);
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    miniMapObj.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 12, maxZoom: 12.4, duration: 0 });
    miniFittedCity = userCityKey;
  }
  // камера по вашей точке: крупный план с фиксированным зумом — улицы и
  // капли вокруг тебя, а не весь город с далёка. MINI_ZOOM: хочешь ближе —
  // подними (14.0–14.5), дальше — опусти (13.0–13.4). Нет точки (GPS не
  // разрешён) — кадр остаётся на городе, как раньше.
  const MINI_ZOOM = 10.0;
  const locCenter = loadUserLocation();
  if (locCenter) {
    miniMapObj.setCenter([locCenter.lon, locCenter.lat]);
    miniMapObj.setZoom(MINI_ZOOM);
  }
  const zoom = miniMapObj.getZoom();
  // поле тепла: рампы те же, радиус масштабируем высотой канваса к полной
  // карте (170px против ~360px) — иначе поле съело бы весь маленький кадр
  const kScale = Math.max(0.35, Math.min(1, (document.getElementById('miniMapBox').clientHeight || 170) / 360));
  const ff = zoneStreetFade(zoom);
  for (const L of FH_LAYERS) {
    miniMapObj.setPaintProperty(L, 'heatmap-radius', zoneRamp(FH_RADIUS, zoom) * kScale);
    miniMapObj.setPaintProperty(L, 'heatmap-opacity', zoneRamp(FH_OPACITY, zoom) * ff * 0.55);
  }
  miniMapObj.setPaintProperty('zones-halo', 'fill-opacity', zoneRamp(ZONE_STOPS.halo, zoom) * 0.93);
  miniMapObj.setPaintProperty('zones-fill', 'fill-opacity', zoneRamp(ZONE_STOPS.fill, zoom) * 0.93);
  miniMapObj.setPaintProperty('zones-core', 'fill-opacity', zoneRamp(ZONE_STOPS.core, zoom) * 0.93);
  miniMapObj.setPaintProperty('zones-line', 'line-opacity', zoneRamp(ZONE_STOPS.line, zoom) * 0.93);
  miniMapObj.setPaintProperty('zones-line', 'line-width', zoneRamp(ZONE_STOPS.width, zoom));
  for (const lc of miniLabelCtrls) lc.el.style.display = zoom >= lc.minZoom ? '' : 'none';
  for (const m of miniMarkers) m.remove();
  miniMarkers = [];
  const last = getLastObservations();
  const feats = [];
  const fuelFeats = [];
  const vb = miniMapObj.getBounds();
  const pad = 0.05;
  const inView = st => Number(st.lat) >= vb.getSouth() - pad && Number(st.lat) <= vb.getNorth() + pad && Number(st.lon) >= vb.getWest() - pad && Number(st.lon) <= vb.getEast() + pad;
      for (const st of allStations) {
    if (!Number.isFinite(Number(st.lat)) || !Number.isFinite(Number(st.lon))) continue;
    const o = last[st.id];
    
    let state = heatKey(o);
    if (state === 'unknown') state = folkPinState(st.id, o) || 'unknown';
    
    if (state !== 'unknown') {
      const stale = !obsFresh(o);
      if (state === 'full') {
        fuelFeats.push({ type: 'Feature', properties: { cls: stale ? 'calm-old' : 'calm', w: 1 }, geometry: { type: 'Point', coordinates: [Number(st.lon), Number(st.lat)] } });
      } else if (state === 'yes' || state === 'partial' || state === 'part' || state === 'diesel') {
        fuelFeats.push({ type: 'Feature', properties: { cls: stale ? 'partial-old' : 'partial', w: 0.8 }, geometry: { type: 'Point', coordinates: [Number(st.lon), Number(st.lat)] } });
      } else {
        let hotW = 0;
        if (state === 'no') hotW = 1.0;
        else if (state === 'conflict') hotW = 0.4;
        if (o && o.queue_level === 'high') hotW += 0.15;
        if (hotW > 0) fuelFeats.push({ type: 'Feature', properties: { cls: stale ? 'hot-old' : 'hot', w: hotW }, geometry: { type: 'Point', coordinates: [Number(st.lon), Number(st.lat)] } });
      }
    }
    // лужи очередей: в мини-карте видны всегда — её зум и есть тот «далёкий»
    // вид, где на полной карте лужи уже показаны
    if (inView(st)) {
      const sc = demandOf(st.id);
      if (sc >= 12) {
        const seed = seedOf(st.id);
        const R = 100 + sc * 6;
        const col = 'rgb(' + demandRgb(sc) + ')';
        feats.push(blobFeature(Number(st.lat), Number(st.lon), R, col, seed, 'halo', 1.25));
        feats.push(blobFeature(Number(st.lat), Number(st.lon), R, col, seed, 'main', 1));
        feats.push(blobFeature(Number(st.lat), Number(st.lon), R, col, seed, 'core', 0.55));
        const elZ = document.createElement('div');
        elZ.className = 'mzone-ico';
        elZ.innerHTML = '<div class="mzone-badge" style="color:rgb(' + demandRgb(sc) + ')"><svg class="ic"><use href="#i-queue"/></svg></div>';
        miniMarkers.push(new maplibregl.Marker({ element: elZ, anchor: 'center' }).setLngLat([Number(st.lon), Number(st.lat)]).addTo(miniMapObj));
      }
    }
  }
  const fhSrc = miniMapObj.getSource('fuelheat');
  if (fhSrc) fhSrc.setData({ type: 'FeatureCollection', features: fuelFeats });
  miniMapObj.getSource('zones').setData({ type: 'FeatureCollection', features: feats });
  // мини-карта без квадратов: всегда капли (как полная карта вблизи),
  // даже на дальнем зуме — кластеры в маленьком окне = каша из цифр.
  // Тепло и лужи очередей — те же слои, что на полной карте.
  for (const st of allStations) {
    if (!Number.isFinite(Number(st.lat)) || !Number.isFinite(Number(st.lon)) || !inView(st)) continue;
    const it = { st: st, o: last[st.id] };
    const kk = effPinKey(it.st, it.o);
    // мини-карта — быстрый ответ «где заправиться»: капли только с топливом
    // (95 / 92 / дизель, включая народный консенсус). Серые «нет данных»,
    // красные «ничего нет» и конфликтные не рисуем; на полной карте они остаются.
    if (kk !== 'yes' && kk !== 'part' && kk !== 'diesel') continue;
    const wrap = document.createElement('div');
    wrap.className = 'mpin-wrap' + (pinKey(it.o) !== 'unknown' && !obsFresh(it.o) ? ' stale' : '');
    const availCols = [];
    if (it.o && (it.o.fuel_92_status != null || it.o.fuel_95_status != null || it.o.diesel_status != null)) {
      if (it.o.diesel_status === true) availCols.push('#6ea8ff');
      if (it.o.fuel_92_status === true) availCols.push('#f5a05a');
      if (it.o.fuel_95_status === true) availCols.push('#1bb978');
    } else {
      const fcons = { '92': folkConsensus(it.st.id, '92'), '95': folkConsensus(it.st.id, '95'), 'diesel': folkConsensus(it.st.id, 'diesel') };
      if (fcons.diesel && fcons.diesel.verdict === 'yes') availCols.push('#6ea8ff');
      if (fcons['92'] && fcons['92'].verdict === 'yes') availCols.push('#f5a05a');
      if (fcons['95'] && fcons['95'].verdict === 'yes') availCols.push('#1bb978');
    }
    let pinStyle = '';
    if (availCols.length >= 2) {
      const stops = availCols.length === 2 ? availCols[0] + ', ' + availCols[1] : availCols[0] + ', ' + availCols[1] + ' 50%, ' + availCols[2];
      pinStyle = 'background:linear-gradient(to top right,' + stops + ');border-color:#fff;color:#fff;';
    }
    wrap.innerHTML = '<div class="mpin ' + kk + '" style="' + pinStyle + '"><svg class="ic"><use href="#i-pump"/></svg></div>';
    miniMarkers.push(new maplibregl.Marker({ element: wrap, anchor: 'bottom' }).setLngLat([Number(st.lon), Number(st.lat)]).addTo(miniMapObj));
  }
  // точка пользователя — как на полной карте, размер уменьшен CSS-ом
  const loc = loadUserLocation();
  if (loc) {
    if (!miniUserMarker) {
      const el = document.createElement('div');
      el.className = 'user-dot';
      miniUserMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([loc.lon, loc.lat]).addTo(miniMapObj);
    } else miniUserMarker.setLngLat([loc.lon, loc.lat]);
  }
}
function miniMapGo() { pagerGo(2); ensureMap(); }
// === Мини-карта места внутри карточки АЗС: лужа очереди + тепло + пин данной АЗС ===
// Один переиспользуемый экземпляр (не плодим WebGL-контексты): создаём лениво при
// первом открытии карточки, дальше только двигаем камеру и перекладываем данные.
// Слои/цвета/зоны — те же глобальные хелперы, что у главной мини-карты и полной
// карты, новой логики нет. Интерактив выключен: палец скроллит шторку, не карту.
let cardMapObj = null, cardReady = false, cardMarkers = [], cardMainPin = null;
const CARD_ZOOM = 15.2;
// мини-3D заправки под пином карточки: здание + 2 колонки.
// Цвет держим в тон пина: каждая грань — свой оттенок базового цвета
// (верх светлее, левая грань = базовый, правая темнее — так читается объём).
const ST3D_PAL = {
  yes:      { top:'#86e6c0', left:'#1bb978', right:'#0f8f5f', ctop:'#b8f0d8', cleft:'#1bb978', cright:'#0c7a50' },
  part:     { top:'#ffc899', left:'#f5a05a', right:'#c26a2a', ctop:'#ffdcc0', cleft:'#f5a05a', cright:'#ad5c22' },
  diesel:   { top:'#aecbff', left:'#6ea8ff', right:'#3d6fd0', ctop:'#cfe0ff', cleft:'#6ea8ff', cright:'#3561b8' },
  no:       { top:'#ff8a80', left:'#ef5350', right:'#c62828', ctop:'#ffcdd2', cleft:'#ef5350', cright:'#b71c1c' },
  conflict: { top:'#ffc899', left:'#f5a05a', right:'#c26a2a', ctop:'#ffdcc0', cleft:'#f5a05a', cright:'#ad5c22' },
  unknown:  { top:'#d6dce6', left:'#a7b1c1', right:'#7d8ba0', ctop:'#e6ebf2', cleft:'#a7b1c1', cright:'#6e7c91' }
};
function cardSt3d(key) {
  const p = ST3D_PAL[key] || ST3D_PAL.unknown;
  return '<svg viewBox="0 0 46 30"><ellipse cx="24" cy="27" rx="20" ry="3.5" fill="rgba(20,33,61,.18)"/>' +
    '<polygon points="8,9 20,3 32,9 20,15" fill="' + p.top + '"/>' +
    '<polygon points="8,9 20,15 20,26 8,20" fill="' + p.left + '"/>' +
    '<polygon points="32,9 20,15 20,26 32,20" fill="' + p.right + '"/>' +
    '<polygon points="10.5,12.5 17.5,16 17.5,19 10.5,15.5" fill="#fff" opacity=".92"/>' +
    '<polygon points="24,17 29,14.5 34,17 29,19.5" fill="' + p.ctop + '"/>' +
    '<polygon points="24,17 29,19.5 29,27 24,24.5" fill="' + p.cleft + '"/>' +
    '<polygon points="34,17 29,19.5 29,27 34,24.5" fill="' + p.cright + '"/>' +
    '<polygon points="25.5,19 28,20.2 28,23 25.5,21.8" fill="#fff" opacity=".9"/>' +
    '<polygon points="33,13 38,10.5 43,13 38,15.5" fill="' + p.ctop + '"/>' +
    '<polygon points="33,13 38,15.5 38,23 33,20.5" fill="' + p.cleft + '"/>' +
    '<polygon points="43,13 38,15.5 38,23 43,20.5" fill="' + p.cright + '"/>' +
    '<polygon points="34.5,15 37,16.2 37,19 34.5,17.8" fill="#fff" opacity=".9"/></svg>';
}
const CARD_FH_DEFS = [
  { id:'fuelheat-calm', cls:'calm', ramp:['rgba(47,211,154,0)','rgba(47,211,154,0.35)','rgba(27,185,120,0.55)','rgba(27,185,120,0.70)','rgba(18,168,106,0.80)'] },
  { id:'fuelheat-hot', cls:'hot', ramp:['rgba(245,213,101,0)','rgba(245,213,101,0.40)','rgba(245,160,90,0.62)','rgba(239,83,80,0.78)','rgba(216,42,38,0.88)'] },
  { id:'fuelheat-partial', cls:'partial', ramp:['rgba(245,213,101,0)','rgba(245,213,101,0.4)','rgba(245,213,101,0.6)','rgba(110,168,255,0.7)','rgba(110,168,255,0.9)'] },
  { id:'fuelheat-calm-old', cls:'calm-old', ramp:['rgba(47,211,154,0)','rgba(47,211,154,0.16)','rgba(27,185,120,0.25)','rgba(27,185,120,0.32)','rgba(18,168,106,0.36)'] },
  { id:'fuelheat-hot-old', cls:'hot-old', ramp:['rgba(245,213,101,0)','rgba(245,213,101,0.18)','rgba(245,160,90,0.28)','rgba(239,83,80,0.35)','rgba(216,42,38,0.40)'] },
  { id:'fuelheat-partial-old', cls:'partial-old', ramp:['rgba(245,213,101,0)','rgba(245,213,101,0.2)','rgba(245,213,101,0.3)','rgba(110,168,255,0.35)','rgba(110,168,255,0.4)'] }
];
// глушим карточную карту: remove() освобождает WebGL-контекст, пока контейнер
// ещё в DOM. Вызываем ДО любой перезаписи sheetBody (openSheet / openSheetAboveAdvice)
// и при closeSheet — иначе старая карта остаётся привязанной к выброшенному узлу
// (баг «второй раз пусто») и контекст утекает.
function disposeCardMap() {
  if (cardMapObj) { try { cardMapObj.remove(); } catch (e) {} cardMapObj = null; }
  cardReady = false;
  for (const m of cardMarkers) { try { m.remove(); } catch (e) {} }
  cardMarkers = [];
  cardMainPin = null;
}
function mountCardMap(st) {
const box = document.getElementById('cardMapBox');
if (!box) return; // контейнер не живой — честная плашка остаётся
if (liteMode && !liteMapOk) { window.__liteCardSt = st; litePlaceholder(box); return; }
ensureMapLibre().then(() => mountCardMapNow(st)).catch(() => {});
}
function mountCardMapNow(st) {
  const box = document.getElementById('cardMapBox');
  if (!box) return;
  
  if (!window.maplibregl) { 
    box.innerHTML = '<div class="status" style="color:#c26a2a;font-size:11px;padding:10px">❌ Карта не загрузилась</div>';
    return; 
  }
  const lon = Number(st.lon), lat = Number(st.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  // шторка пересобирает DOM при каждом открытии, поэтому переиспользовать карту
  // нельзя: строим заново в живой контейнер. disposeCardMap() обычно уже всё
  // выключил до перезаписи sheetBody; guard на всякий случай.
  if (cardMapObj) disposeCardMap();
  box.innerHTML = '';
  cardMapObj = new maplibregl.Map({ container:'cardMapBox', style:'https://tiles.openfreemap.org/styles/positron', center:[lon,lat], zoom:CARD_ZOOM, attributionControl:false, interactive:false });
  cardMapObj.on('load', () => {
    for (const layer of cardMapObj.getStyle().layers || []) {
      if (layer.type === 'symbol') cardMapObj.setLayoutProperty(layer.id,'visibility','none');
      else if (layer.id.indexOf('building') >= 0) cardMapObj.setLayoutProperty(layer.id,'visibility','none');
    }
    cardMapObj.addSource('fuelheat', { type:'geojson', data:{ type:'FeatureCollection', features:[] } });
    for (const d of CARD_FH_DEFS) {
      cardMapObj.addLayer({ id:d.id, type:'heatmap', source:'fuelheat', filter:['==',['get','cls'],d.cls], paint:{ 'heatmap-weight':['get','w'], 'heatmap-intensity':1.8, 'heatmap-radius':50, 'heatmap-opacity':0.5, 'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,d.ramp[0],0.25,d.ramp[1],0.5,d.ramp[2],0.75,d.ramp[3],1,d.ramp[4]] } });
    }
    cardMapObj.addSource('zones', { type:'geojson', data:{ type:'FeatureCollection', features:[] } });
    cardMapObj.addLayer({ id:'zones-halo', type:'fill', source:'zones', filter:['==',['get','kind'],'halo'], paint:{ 'fill-color':['get','color'], 'fill-opacity':0.08 } });
    cardMapObj.addLayer({ id:'zones-fill', type:'fill', source:'zones', filter:['==',['get','kind'],'main'], paint:{ 'fill-color':['get','color'], 'fill-opacity':0.16 } });
    cardMapObj.addLayer({ id:'zones-core', type:'fill', source:'zones', filter:['==',['get','kind'],'core'], paint:{ 'fill-color':['get','color'], 'fill-opacity':0.24 } });
    cardMapObj.addLayer({ id:'zones-line', type:'line', source:'zones', filter:['==',['get','kind'],'main'], paint:{ 'line-color':['get','color'], 'line-opacity':0.24, 'line-width':1.2, 'line-dasharray':[1,1.8] } });
    cardReady = true;
    applyCardMap(st);
  });
}
function applyCardMap(st) {
  if (!cardMapObj || !cardReady) return;
  const lon = Number(st.lon), lat = Number(st.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  cardMapObj.stop();
  cardMapObj.setCenter([lon,lat]);
  cardMapObj.setZoom(CARD_ZOOM);
  const z = CARD_ZOOM, ff = zoneStreetFade(z);
  // радиус тепла под близкий кадр: рампа полной карты, слегка приглушена, чтобы
  // поле читалось вокруг АЗС и не затопило маленький кадр (kScale главной мини-карты
  // здесь не нужен — там вид сдалека, тут улица)
  const hr = zoneRamp(FH_RADIUS, z) * 0.7;
  const ho = zoneRamp(FH_OPACITY, z) * ff * 0.5;
  for (const d of CARD_FH_DEFS) {
    cardMapObj.setPaintProperty(d.id, 'heatmap-radius', hr);
    cardMapObj.setPaintProperty(d.id, 'heatmap-opacity', ho);
  }
  cardMapObj.setPaintProperty('zones-halo','fill-opacity', zoneRamp(ZONE_STOPS.halo,z)*0.93);
  cardMapObj.setPaintProperty('zones-fill','fill-opacity', zoneRamp(ZONE_STOPS.fill,z)*0.93);
  cardMapObj.setPaintProperty('zones-core','fill-opacity', zoneRamp(ZONE_STOPS.core,z)*0.93);
  cardMapObj.setPaintProperty('zones-line','line-opacity', zoneRamp(ZONE_STOPS.line,z)*0.93);
  cardMapObj.setPaintProperty('zones-line','line-width', zoneRamp(ZONE_STOPS.width,z));
  for (const m of cardMarkers) m.remove();
  cardMarkers = [];
  const last = getLastObservations();
  const vb = cardMapObj.getBounds();
  const pad = 0.02;
  const inView = s => Number(s.lat) >= vb.getSouth()-pad && Number(s.lat) <= vb.getNorth()+pad && Number(s.lon) >= vb.getWest()-pad && Number(s.lon) <= vb.getEast()+pad;
  // тепло по всем станциям: KDE-поле формируется соседями, как на полной карте
  const fuelFeats = [];
      for (const s of allStations) {
    if (!Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lon))) continue;
    const o = last[s.id];
    
    let state = heatKey(o);
    if (state === 'unknown') state = folkPinState(s.id, o) || 'unknown';
    if (state === 'unknown') continue;
    
    const stale = !obsFresh(o);
    if (state === 'full') {
      fuelFeats.push({ type:'Feature', properties:{ cls: stale?'calm-old':'calm', w:1 }, geometry:{ type:'Point', coordinates:[Number(s.lon),Number(s.lat)] } });
    } else if (state === 'yes' || state === 'partial' || state === 'part' || state === 'diesel') {
      fuelFeats.push({ type:'Feature', properties:{ cls: stale?'partial-old':'partial', w:0.8 }, geometry:{ type:'Point', coordinates:[Number(s.lon),Number(s.lat)] } });
    } else {
      let hotW = 0;
      if (state === 'no') hotW = 1.0;
      else if (state === 'conflict') hotW = 0.4;
      if (o && o.queue_level === 'high') hotW += 0.15;
      if (hotW > 0) fuelFeats.push({ type:'Feature', properties:{ cls: stale?'hot-old':'hot', w:hotW }, geometry:{ type:'Point', coordinates:[Number(s.lon),Number(s.lat)] } });
    }
  }
  const fhSrc = cardMapObj.getSource('fuelheat');
  if (fhSrc) fhSrc.setData({ type:'FeatureCollection', features:fuelFeats });
  // лужи очередей в кадре + иконка очереди на каждой
  const feats = [];
  for (const s of allStations) {
    if (!Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lon)) || !inView(s)) continue;
    const sc = demandOf(s.id);
    if (sc >= 12) {
      const seed = seedOf(s.id);
      const R = 100 + sc*6;
      const col = 'rgb(' + demandRgb(sc) + ')';
      feats.push(blobFeature(Number(s.lat),Number(s.lon),R,col,seed,'halo',1.25));
      feats.push(blobFeature(Number(s.lat),Number(s.lon),R,col,seed,'main',1));
      feats.push(blobFeature(Number(s.lat),Number(s.lon),R,col,seed,'core',0.55));
      const elZ = document.createElement('div');
      elZ.className = 'mzone-ico';
      elZ.innerHTML = '<div class="mzone-badge" style="color:rgb(' + demandRgb(sc) + ')">' + icon('i-queue') + '</div>';
      cardMarkers.push(new maplibregl.Marker({ element:elZ, anchor:'center' }).setLngLat([Number(s.lon),Number(s.lat)]).addTo(cardMapObj));
    }
  }
  cardMapObj.getSource('zones').setData({ type:'FeatureCollection', features:feats });
  // соседние капли (мельче), кроме данной АЗС; только с топливом — чтобы не шуметь
  for (const s of allStations) {
    if (s.id === st.id) continue;
    if (!Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lon)) || !inView(s)) continue;
    const o = last[s.id];
    const kk = effPinKey(s, o);
    if (kk === 'unknown' || kk === 'no' || kk === 'conflict') continue;
    const wrap = document.createElement('div');
    wrap.className = 'mpin-wrap' + (pinKey(o) !== 'unknown' && !obsFresh(o) ? ' stale' : '');
    wrap.innerHTML = '<div class="mpin ' + kk + '"></div>';
    cardMarkers.push(new maplibregl.Marker({ element:wrap, anchor:'bottom' }).setLngLat([Number(s.lon),Number(s.lat)]).addTo(cardMapObj));
  }
  // пин данной АЗС с кольцом-подсветкой — сразу видно, о какой заправке речь;
  // рисуем всегда (даже серым при отсутствии данных): водитель должен видеть место
  const oMain = last[st.id];
  const kkMain = effPinKey(st, oMain);
  if (!cardMainPin) {
    const el = document.createElement('div');
    el.className = 'card-pin';
    el.innerHTML = '<div class="card-halo"></div><div class="card-st3d">' + cardSt3d(kkMain) + '</div><div class="mpin ' + kkMain + '">' + (kkMain==='conflict' ? '<span class="qmark">?</span>' : icon('i-pump')) + '</div>';
    cardMainPin = new maplibregl.Marker({ element:el, anchor:'bottom' }).setLngLat([lon,lat]).addTo(cardMapObj);
  } else {
    cardMainPin.setLngLat([lon,lat]);
    const mp = cardMainPin.getElement().querySelector('.mpin');
    if (mp) mp.className = 'mpin ' + kkMain;
    const stEl = cardMainPin.getElement().querySelector('.card-st3d');
    if (stEl) stEl.innerHTML = cardSt3d(kkMain);
  }
  cardMapObj.resize();
}
/* герой, чипы, дайджест, шапка */
/* плашка-герой: живая лента отметок за последние 4 часа — источник
   (возврат/пропажа топлива по смене соседних наблюдений) и народ
   (топливо/очередь/привоз). Строка: АЗС • улица • что • время отметки.
   Переключение циклом с «вушем», полоска = прогресс до следующего слайда. */
const FEED_HOURS = 1;
const FEED_MS = 4500;
let feedItems = [], feedIdx = 0, feedTimer = null;
function buildFeed() {
  const since = Date.now() - FEED_HOURS * 3600 * 1000;
  const items = [];
  // лента персональна: только события города пользователя (те же боксы,
  // что у списка и чипов); у водителя в другом городе — его события
  const citySet = new Set(cityStationList().map(s => s.id));
  // источник: из таблицы events — той же, которую читает Телеграм-лента.
  // Раньше пересчитывали смены из последних 5000 наблюдений: с ростом базы
  // это окно сжалось до 2-3 часов, и часть отметок в ленту не доезжала
  // (лента стояла, пока Телеграм гудел).
  for (const e of allWaveEvents) {
    if (!citySet.has(e.station_id)) continue;
    const t = new Date(e.detected_at).getTime();
    if (t < since) continue;
    items.push({ st: e.station_id, fuel: e.fuel_type, kind: e.event_type === 'fuel_restored' ? 'restored' : 'gone', t: t });
  }
  // народ: топливные и очередные отметки за окно (тоже только свой город)
  for (const f of allFeedback) {
    const t = new Date(f.created_at).getTime();
    if (t < since) continue;
    if (!citySet.has(f.station_id)) continue;
    if (f.feedback_type === 'available') items.push({ st: f.station_id, fuel: f.fuel_type, kind: 'folk_yes', t: t });
    else if (f.feedback_type === 'unavailable') items.push({ st: f.station_id, fuel: f.fuel_type, kind: 'folk_no', t: t });
    else if (f.feedback_type === 'delivery') items.push({ st: f.station_id, fuel: null, kind: 'delivery', t: t });
    else if (f.feedback_type === 'queue') items.push({ st: f.station_id, fuel: null, kind: 'queue', q: f.queue_size, t: t });
    else if (f.feedback_type === 'in_queue') items.push({ st: f.station_id, fuel: null, kind: 'queue_live', t: t });
  }
  items.sort((a, b) => b.t - a.t);
  return items.slice(0, 12);
}
function feedCaption(it) {
  if (it.kind === 'restored') return 'Источник: топливо вернулось';
  if (it.kind === 'gone') return 'Источник: топливо пропало';
  if (it.kind === 'folk_yes') return 'Народ: топливо есть';
  if (it.kind === 'folk_no') return 'Народ: топлива нет';
  if (it.kind === 'delivery') return 'Народ: привезли';
  if (it.kind === 'queue_live') return 'Народ: стоит в очереди сейчас';
  return 'Народ: очередь';
}
function feedLine(it) {
  const st = stationById(it.st);
  const name = st ? (st.name || 'АЗС') : 'АЗС';
  const street = st && st.address ? st.address : '—';
  let what;
  if (it.kind === 'queue') what = 'очередь ' + (QUEUE_SHORT[it.q] || '');
  else if (it.kind === 'queue_live') what = 'стоит в очереди сейчас';
  else if (it.kind === 'delivery') what = 'привезли';
  else what = fuelLabel(it.fuel) + (it.kind === 'restored' ? ' вернулось' : it.kind === 'gone' ? ' пропало' : it.kind === 'folk_yes' ? ' есть' : ' нет');
  const d = new Date(it.t);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return name + ' • ' + street + ' • ' + what + ' • ' + hm;
}
function feedIcon(it) {
  if (it.kind === 'restored' || it.kind === 'folk_yes') return ['i-check', '#15976d'];
  if (it.kind === 'gone' || it.kind === 'folk_no') return ['i-cross', '#d64d51'];
  if (it.kind === 'queue' || it.kind === 'queue_live') return ['i-queue', '#c26a2a'];
  return ['i-truck', '#2465ee'];
}
function applyFeedSlide(i, animate) {
  const cap = document.getElementById('hfFuel');
  const line = document.getElementById('hfWindow');
  const bar = document.getElementById('hfBar');
  const ico = document.querySelector('.hero-line > .ic');
  if (!cap || !line) return;
  const it = feedItems[i];
  const paint = () => {
    if (!it) {
      cap.textContent = 'Уведомления   ' + userCityName() + '   ' + FEED_HOURS + (FEED_HOURS === 1 ? ' час' : (FEED_HOURS < 5 ? ' часа' : ' часов'));
      line.textContent = 'Пока тихо: новых отметок за это время нет';
      if (ico) { ico.innerHTML = '<use href="#i-clock"/>'; ico.style.color = '#6a4fd8'; }
      if (bar) { bar.style.transition = 'none'; bar.style.width = '8%'; }
      return;
    }
    const ic = feedIcon(it);
    cap.textContent = feedCaption(it);
    line.textContent = feedLine(it);
    if (ico) { ico.innerHTML = '<use href="#' + ic[0] + '"/>'; ico.style.color = ic[1]; }
    if (bar) {
      if (feedItems.length < 2) { bar.style.transition = 'none'; bar.style.width = '100%'; }
      else {
        bar.style.transition = 'none';
        bar.style.width = '0%';
        void bar.offsetWidth;
        bar.style.transition = 'width ' + FEED_MS + 'ms linear';
        bar.style.width = '100%';
      }
    }
  };
  const hl = document.querySelector('.hero-line .hl-main');
  const animEls = [hl, ico].filter(Boolean);
  if (animate && it) {
    animEls.forEach(el => { el.classList.remove('boot-woosh-in'); el.classList.add('boot-woosh-out'); });
    setTimeout(() => {
      paint();
      animEls.forEach(el => { el.classList.remove('boot-woosh-out'); el.classList.add('boot-woosh-in'); });
      setTimeout(() => animEls.forEach(el => el.classList.remove('boot-woosh-in')), 420);
    }, 200);
  } else paint();
}
function startFeedCycle() {
  if (feedTimer) { clearInterval(feedTimer); feedTimer = null; }
  if (feedItems.length < 2) return;
  feedTimer = setInterval(() => {
    if (document.hidden) return; // вкладка спит — не крутим ленту зря
    feedIdx = (feedIdx + 1) % feedItems.length;
    applyFeedSlide(feedIdx, true);
  }, FEED_MS);
}
function renderHero() {
  feedItems = buildFeed();
  if (feedIdx >= feedItems.length) feedIdx = 0;
  applyFeedSlide(feedIdx, false);
  startFeedCycle();
  // чипы под плашкой — как раньше
  const last = getLastObservations();
  const citySet = new Set(cityStationList().map(s => s.id));
  const tn = document.getElementById('triNow');
  if (tn) {
    let known = 0, avail = 0;
    for (const id of citySet) { const o = last[id]; if (o && o.fuel_95_status !== null && o.fuel_95_status !== undefined) { known++; if (o.fuel_95_status) avail++; } }
    tn.textContent = known ? avail + ' из ' + known + ' АЗС' : 'нет данных';
  }
  const pc = peakAndCalm();
  const tu = document.getElementById('triUsually');
  if (tu) tu.textContent = pc.peak === '—' ? '—' : pc.peak.replace(/:00/g, '');
  const tf = document.getElementById('triFc');
  const tfLbl = document.getElementById('triFcLbl');
  if (tf) {
    tf.textContent = pc.calm !== '—' ? pc.calm : (pc.advice ? 'очередь ' + pc.advice : '—');
    tf.classList.toggle('qadv', pc.calm === '—' && !!pc.advice);
  }
  if (tfLbl) tfLbl.textContent = 'Спокойно';
}
/* панель «Наша точность прогнозов»: честные цифры верификатора */
function fmtErrMin(m) {
  if (m === null || m === undefined || !isFinite(m)) return '—';
  m = Math.round(Math.abs(m));
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60), mm = m % 60;
  return h + ' ч' + (mm ? ' ' + mm + ' мин' : '');
}
function quantileOf(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function renderAccuracy() {
  const body = document.getElementById('accBody');
  if (!body) return;
  const verified = allPredictions.filter(p => p.is_verified);
  const measured = verified.filter(p => p.error_minutes !== null && p.error_minutes !== undefined);
  const cnt = document.getElementById('accCount');
  if (cnt) cnt.textContent = measured.length + '/' + verified.length;
  if (measured.length < 3) {
    body.innerHTML = '<div class="status" style="margin-top:8px">Пока нечего измерять: ' + measured.length + ' из ' + verified.length + ' прогнозов получили факт возврата топлива.<br><small>' +
      verified.length + ' прогнозов уже проверено верификатором. Но дефицит глубокий: по ним ещё не случилось подтверждённого возврата топлива, поэтому честную ошибку посчитать невозможно. Когда возвраты накопятся (минимум 3), здесь появится настоящая аналитика ошибки — а пока эта пустота норма, а не поломка.</small></div>';
    return;
  }
  const errs = measured.map(p => Math.abs(p.error_minutes)).sort((a, b) => a - b);
  const med = Math.round(quantileOf(errs, 0.5));
  const p90 = Math.round(quantileOf(errs, 0.9));
  const baseErrs = measured.filter(p => p.baseline_error_minutes !== null && p.baseline_error_minutes !== undefined)
    .map(p => Math.abs(p.baseline_error_minutes)).sort((a, b) => a - b);
  const baseMed = baseErrs.length ? Math.round(quantileOf(baseErrs, 0.5)) : null;
  const paired = measured.filter(p => p.baseline_error_minutes !== null && p.baseline_error_minutes !== undefined);
  const pairedMed = paired.length ? Math.round(quantileOf(paired.map(p => Math.abs(p.error_minutes)).sort((a, b) => a - b), 0.5)) : null;
  let ratioVal = 'копится', ratioCls = '';
  if (paired.length >= 10 && baseMed && pairedMed !== null) {
    const r = baseMed / Math.max(1, pairedMed);
    if (r > 1) { ratioVal = 'в ' + Math.min(99, r).toFixed(1).replace('.', ',') + ' раза'; ratioCls = ' g'; }
    else ratioVal = 'пока не точнее';
  }
  const succ = verified.filter(p => p.result === 'SUCCESS').length;
  // тренд модели: медианная ошибка первой и последней недели верификации
  const weeks = {};
  for (const p of measured) {
    if (!p.verified_at) continue;
    const d = new Date(p.verified_at);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
    const k = monday.toISOString().slice(0, 10);
    (weeks[k] = weeks[k] || []).push(Math.abs(p.error_minutes));
  }
  const medOf = a => quantileOf(a.slice().sort((x, y) => x - y), 0.5);
  const wKeys = Object.keys(weeks).sort();
  let trendTxt = 'тренд модели: копится (нужно 2+ недели с измерениями)';
  if (wKeys.length >= 2 && weeks[wKeys[0]].length >= 3 && weeks[wKeys[wKeys.length - 1]].length >= 3) {
    const fK = wKeys[0], lK = wKeys[wKeys.length - 1];
    const fE = Math.round(medOf(weeks[fK])), lE = Math.round(medOf(weeks[lK]));
    const lbl = k => { const d0 = new Date(k + 'T00:00:00Z'); return String(d0.getUTCDate()).padStart(2, '0') + '.' + String(d0.getUTCMonth() + 1).padStart(2, '0'); };
    const verdict = lE < fE ? 'модель улучшается' : lE > fE ? 'сейчас хуже, чем было — следим за причиной' : 'уровень тот же';
    trendTxt = 'ошибка по неделям: было ' + fmtErrMin(fE) + ' (' + lbl(fK) + ') 	 стало ' + fmtErrMin(lE) + ' (' + lbl(lK) + ') — ' + verdict;
  } else if (wKeys.length >= 2) {
    trendTxt = 'тренд модели: в крайней неделе мало измерений, пока это шум';
  }
  // последний пример: прогноз и факт одной строкой
  const lastP = measured.slice().sort((a, b) => new Date(b.actual_restore_at || 0) - new Date(a.actual_restore_at || 0))[0];
  let storyHtml = '';
  if (lastP) {
    const st = allStations.find(s => s.id === lastP.station_id);
    const dAt = lastP.actual_restore_at ? new Date(lastP.actual_restore_at) : null;
    const hh = dAt ? String((dAt.getUTCHours() + 3) % 24).padStart(2, '0') + ':' + String(dAt.getUTCMinutes()).padStart(2, '0') : '—';
    const sign = lastP.error_minutes > 0 ? '+' : lastP.error_minutes < 0 ? '−' : '±';
    storyHtml = '<div class="acc-last">' + icon('i-clock') + '<span class="acc-last-txt"><b>' + escapeHtml(st ? st.name || 'АЗС' : 'АЗС') + '   ' + fuelLabel(lastP.fuel_type) + '</b>окно ' + time5(lastP.from_time) + '–' + time5(lastP.to_time) + '   факт ' + hh + '</span>' +
      '<span class="acc-last-err ' + (Math.abs(lastP.error_minutes) <= 60 ? 'ok' : 'mid') + '">' + sign + fmtErrMin(lastP.error_minutes) + '</span></div>';
  }
  // тонкие полосы сравнения: длина пропорциональна ошибке
  const maxV = Math.max(1, med, p90, baseMed || 0);
  const bar = (lbl, v, col) => '<div class="acc-cmp-row"><span>' + lbl + '</span><i style="width:' + (v === null ? 0 : Math.max(4, Math.round(v / maxV * 100))) + '%;background:' + col + '"></i><b>' + (v === null ? '—' : fmtErrMin(v)) + '</b></div>';
  body.innerHTML =
    '<div class="acc-hero">' +
    '<div class="acc-big tap why-tap" onclick="openWhyChip(this,\'accErr\')"><small>ошибка обычно</small><b>' + fmtErrMin(med) + '</b></div>' +
    '<div class="acc-big"><small>против простого</small><b class="' + ratioCls.trim() + '">' + ratioVal + '</b></div>' +
    '<div class="acc-big tap why-tap" onclick="openWhyChip(this,\'accHit\')"><small>попали в окно</small><b>' + succ + '/' + verified.length + '</b></div>' +
    '</div>' +
    '<div class="dg-strip tap why-tap" style="margin-top:6px" onclick="openWhyChip(this,\'accChecked\')">' + icon('i-check', 'ic-s') + '<span>проверено ночами: <b>' + verified.length + '</b> прогнозов, факт случился у <b>' + measured.length + '</b></span></div>' +
    '<div class="acc-cmp">' + bar('мы', med, '#397cff') + bar('простой способ', baseMed, '#a7b1c1') + bar('худшие 10%', p90, '#7c6dff') + '</div>' +
    '<div class="dg-strip" style="margin-top:6px">' + icon('i-chart', 'ic-s') + '<span>' + trendTxt + '</span></div>' +
    storyHtml +
    '<div class="recent">Обычная ошибка — медиана: половина прогнозов точнее неё, половина нет. Худшие 10% — ' + fmtErrMin(p90) + '. «Против простого» считаем только по прогнозам с двумя измеренными числами (сейчас ' + paired.length + ', с 10 покажет кратность). Прогнозы, ждущие факта, в ошибку не входят. Проверяем каждую ночь в 02:10.</div>';
}
/* окошко «что это?» для чипов: простое объяснение + полезная добавка */
function covNowCount() {
  const last = getLastObservations();
  let n = 0;
  for (const s of cityStationList()) {
    const o = last[s.id];
    if (!o) continue;
    if ((o.fuel_92_status !== null && o.fuel_92_status !== undefined) || (o.fuel_95_status !== null && o.fuel_95_status !== undefined) || (o.diesel_status !== null && o.diesel_status !== undefined)) n++;
  }
  return n;
}
function qNowPct() {
  const last = getLastObservations();
  let tot = 0, q = 0;
  for (const s of cityStationList()) {
    const o = last[s.id];
    if (!o) continue;
    tot++;
    if (o.queue_level === 'high') q++;
  }
  return tot ? Math.round(100 * q / tot) : 0;
}
// Свежесть данных: отметка источника не старше 6 часов (порог тот же,
// что у советника «Куда ехать»). Одна функция — одинаковые цифры
// в подзаголовке главной панели и в плашке карты.
function freshStats() {
  const last = getLastObservations();
  let tot = 0, fresh = 0;
  for (const s of cityStationList()) {
    tot++;
    const o = last[s.id];
    const m = getFreshnessMin(o); // <-- ИЗМЕНЕНО ТУТ
    if (m !== null && m <= 360) fresh++;
  }
  return { tot: tot, fresh: fresh };
}
function freshColor(fr) {
  const share = fr.tot ? fr.fresh / fr.tot : 0;
  return share >= 0.8 ? '#2fd39a' : share >= 0.5 ? '#f5d565' : '#ef5350';
}
const WHY_MAP = {
  now95: { t: 'Сейчас   АИ-95 есть', x: 'Сколько станций источник прямо сейчас видит с АИ-95. В знаменателе — станции с данными, а не все АЗС города.', e: () => 'Источник видит любое топливо на ' + covNowCount() + ' из ' + cityStationList().length + ' АЗС: остальные молчат, на карте их пины несут народные отметки.' },
  peak: { t: 'Пик спроса', x: 'Часы, когда очереди на заправках случались чаще всего за последние сутки. Если есть выбор — в это время лучше не заправляться.', e: () => 'Сейчас очередь на ' + qNowPct() + '% станций с данными.' },
  calm: { t: 'Спокойное время', x: 'Когда очередей мало и топливо в наличии — лучшее окно для заправки. Если сейчас такого окна нет, на чипе показываем, с какого часа лучше вставать в очередь.', e: () => { const pc = peakAndCalm(); const m = cityQueueMedian24(); return 'Спокойно было последний раз: ' + pc.lastCalm + '. Медиана завершённой очереди за сутки: ' + (m === null ? '—' : ageRu(m)) + '.'; } },
  plate95: { t: 'АИ-95 в городе', x: 'Сколько станций из видимых источником прямо сейчас с АИ-95. Красная точка — меньше половины, зелёная — больше половины.', e: () => 'Источник видит любое топливо на ' + covNowCount() + ' из ' + cityStationList().length + ' АЗС.' },
  plateQ: { t: 'Очереди сейчас', x: 'Сколько станций источник видит с очередью в этот момент. Это красные зоны спроса и оранжевые точки на пинах карты.', e: () => { const m = cityQueueMedian24(); return 'Медиана завершённой очереди за сутки: ' + (m === null ? '—' : ageRu(m)) + '.'; } },
  platePeak: { t: 'Пик спроса', x: 'Часы, когда очереди случались чаще всего за последние сутки. Зоны на карте — сила очереди сейчас, этот чип — когда она обычно пиковая в течение дня.', e: null },
  fresh: { t: 'Свежесть данных', x: 'Сколько станций твоего города источник видел с отметкой не старше 6 часов — порог тот же, что у советника «Куда ехать». Зелёный — почти все свежие, жёлтый — около половины, красный — источник в основном молчит: тогда пины на карте несут народные отметки.', e: () => { const fr = freshStats(); return 'Сейчас свежие: ' + fr.fresh + ' из ' + fr.tot + ' АЗС города.'; } },
  work: { t: 'Вердикт источника о станции', x: 'Автоматический сигнал по оплатам и отметкам водителей: продаёт ли станция сейчас обычным людям. Это не про топливо: у работающей станции состав может быть неизвестен, а «не работает» или «молчит» объясняет, почему нет данных.', e: null },
  based: { t: 'На основе', x: 'Сколько снимков источника накопилось по этой АЗС за 30 дней. Чем больше наблюдений, тем надёжнее ритм станции и окно прогноза.', e: el => (el && el.dataset.fact) ? el.dataset.fact : null },
  restore: { t: 'Пополнение', x: 'Когда источник последний раз зафиксировал возврат топлива на этой АЗС. Из таких возвратов строится прогноз; если их не было — берём ритм похожих станций бренда или города.', e: el => { if (!el || !el.dataset.fact) return null; const f = el.dataset.fact; return f === 'ещё не было' ? 'Возвратов пока не было.' : 'Последний возврат: ' + f + '.'; } },
  acc: { t: 'Точность', x: 'Доля прогнозов по этой АЗС, попавших в факт вовремя. Показываем при 10 и более проверках, до этого — «мало данных».', e: () => { const v = allPredictions.filter(p => p.is_verified).length; const m = allPredictions.filter(p => p.is_verified && p.error_minutes !== null && p.error_minutes !== undefined).length; return 'По городу: проверено ' + v + ', с измеренной ошибкой ' + m + ' — подробности в панели «Наша точность прогнозов».'; } },
  accChecked: { t: 'Как проверяем прогнозы', x: 'Каждую ночь сервис сравнивает вчерашние прогнозы с тем, что реально случилось на заправках. Прогнозы, по которым факт ещё не случился (топливо пока не вернули), считаем отдельно — они ошибку не портят.', e: () => { const v = allPredictions.filter(p => p.is_verified).length; const m = allPredictions.filter(p => p.is_verified && p.error_minutes !== null && p.error_minutes !== undefined).length; return 'Проверено: ' + v + ', из них ждут факта: ' + (v - m) + '.'; } },
  accErr: { t: 'Что значит «обычно»', x: 'Все ошибки прогнозов выстраиваем от меньшей к большей и берём серединную: половина прогнозов точнее неё, половина — нет. Это честная типичная ошибка по времени.', e: () => { const m = allPredictions.filter(p => p.is_verified && p.error_minutes !== null && p.error_minutes !== undefined).map(p => Math.abs(p.error_minutes)).sort((a, b) => a - b); if (!m.length) return 'Измерений пока нет.'; const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))]; return 'Половина прогнозов ошибается меньше чем на ' + fmtErrMin(q(m, 0.5)) + ', худшие 10% — больше чем на ' + fmtErrMin(q(m, 0.9)) + '.'; } },
  accHit: { t: 'Попадание в окно', x: 'Прогноз указывает окно часов, когда топливо вероятно вернётся. Если возврат случился внутри окна (с допуском: привезли чуть раньше или отметка чуть запоздала) — это попадание.', e: () => { const v = allPredictions.filter(p => p.is_verified); const s = v.filter(p => p.result === 'SUCCESS').length; return 'Попаданий: ' + s + ' из ' + v.length + ' проверенных.'; } },
  qfcst: { t: 'Прогноз очереди', x: 'Смотрим, в какие часы очередь появлялась на этой АЗС (а своих отметок мало — тогда по городу) за последний месяц, и берём срединное время ± разброс. Это оценка по истории, не гарантия.', e: el => (el && el.dataset.qf) ? 'Считано ' + el.dataset.qf + '.' : null },
  impact: { t: 'Как считаем «подтвердили»', x: 'Берём вашу отметку и смотрим: в пределах часа от неё кто-то ещё отметил то же топливо с тем же вердиктом на той же АЗС. Каждый такой водитель — подтверждение, что отметка попала в реальность. Выдуманные «просмотры» не показываем.', e: null },
  pulse: { t: 'Пульс города', x: 'Оценка из 10: наличие АИ-95 (45%), очереди (25%), свежесть данных (20%), баланс возвратов и исчезновений за сутки (10%). «Чем вчера» сравниваем в тот же час по почасовому ритму города.', e: () => { const fr = freshStats(); return 'Свежие данные: ' + fr.fresh + ' из ' + fr.tot + ' АЗС. Оценка считается из отметок источника и водителей, без ручных поправок.'; } },
  momentum: { t: 'Лента: куда движется ситуация', x: 'Сравниваем возвраты и исчезновения топлива в твоём городе за 6 часов — то же окно, что у ленты событий. Возвратов больше — ситуация улучшается, можно выбирать время и цену. Исчезновений больше — топливо уходит с рынка, заправляться лучше сейчас. Очереди никуда не делись: их по-прежнему видно на карте зонами и в карточках АЗС.', e: () => momentumExtra() },
  wavePlate: { t: 'Соседи: обзор юга', x: 'По каждому городу считаем исчезновения и возвраты АИ-95 за 24 ч и сравниваем с обычной нормой за сутки (среднее за предыдущие 6 суток). ≥4 исчезновений и ≥3× нормы — «волна», ≥3 и ≥2× — «напряжённо», ≥4 возвратов и ≥3× нормы возвратов — «возвращают топливо». Это факт за последние сутки, не прогноз.', e: () => waveFactExtra() },
  reliability: { t: 'Ваша надёжность', x: 'Каждую вашу отметку сравниваем с независимыми свидетелями: отметки других водителей в пределах часа от вашей и снимки источника в течение 2 часов после. Подтверждения добавляют надёжность, опровержения вычитают. Пока свидетелей нет — цифра не показывается, надёжность формируется.', e: () => myRel && myRel.pct !== null ? 'Из них источник подтвердил ' + myRel.srcConf + ' раз(а), водители — ' + myRel.folkConf + '.' : null }, 
  advvote: { t: 'Ваш голос уже учтён', x: 'Кольцо вокруг кнопки — это ваш голос по этой АЗС. С одного устройства принимается один голос каждого типа, чтобы накрутки не искажали картину города. Поэтому повторный тап ничего не меняет.', e: null },
  folk: { t: 'Народный консенсус', x: 'Подтверждение от водителей. Если 2 водителя с разных устройств подтвердили наличие топлива (или его отсутствие), мы отдаём этому приоритет, если источник молчит или его данные устарели.', e: null },
ctm: { t: 'Тепловая карта города: как читать', x: 'Каждая плитка — АЗС твоего города. Чем плитка больше и ярче, тем активнее станция с полуночи (события источника и отметки водителей). Цвет — топливо сейчас: зелёный — АИ-95 есть, оранжевый — только 92, голубой — дизель, красный — ничего нет, серый — источник молчит. Процент — доля станции в активности города. Иконки-капли в плитке: со стрелками — окно прогноза привоза, с молнией — событий за сутки, с пином — расстояние до тебя. Станции с долей меньше 5% не рисуем, чтобы не шуметь мелочью.', e: () => 'Тап по плитке открывает полную карточку АЗС.' }
};
let whyOpenKey = null;
function closeWhy() {
  const p = document.getElementById('whyPop');
  if (p) p.classList.remove('open');
  whyOpenKey = null;
}
function openWhyChip(el, key) {
  const p = document.getElementById('whyPop');
  if (!p || !WHY_MAP[key]) return;
  if (whyOpenKey === key && p.classList.contains('open')) { closeWhy(); return; }
  const w = WHY_MAP[key];
  const extra = w.e ? w.e(el) : null;
  p.innerHTML = '<b>' + w.t + '</b><span>' + w.x + '</span>' + (extra ? '<i>' + extra + '</i>' : '');
  p.classList.add('open');
  whyOpenKey = key;
  const r = el.getBoundingClientRect();
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  if (top < 8) top = 8;
  p.style.left = left + 'px';
  p.style.top = top + 'px';
}
let currentPanel = 0;
function setTagline(i) {
  const sl = document.getElementById('tagSlogan');
  const tx = document.getElementById('tagText');
  if (!sl || !tx) return;
  let sHtml, sTxt;
  if (i === 0) {
    sHtml = 'Точность. <span>Честная.</span>';
    sTxt = 'Каждую ночь проверяем вчерашние прогнозы: на сколько минут ошиблись и лучше ли мы простого способа. Прогнозы, по которым факт ещё не случился, показываем отдельно — без округлений в свою пользу.';
  } else if (i === 2) {
    sHtml = 'Карта. <span>Где спрос.</span>';
    sTxt = 'Далеко заправки собраны в квадратики с цифрой — сколько их в этом месте. Приближай карту — квадратики станут каплями-заправками.';
  } else if (i === 3) {
    const last = getLastObservations();
    const city = cityStationList();
    let withFuel = 0, withPred = 0;
    for (const s of city) { const o = last[s.id]; if (o && o.fuel_95_status === true) withFuel++; if (pickPrediction(s.id, o)) withPred++; }
    const c = cityBox();
    sHtml = 'АЗС города. <span>Тап — и всё видно.</span>';
    sTxt = 'В ' + (c.nameIn || c.name) + ' ' + city.length + ' АЗС: АИ-95 есть на ' + withFuel + ', окна у ' + withPred + '. Остальной юг — на карте. Тап по строке — полная карточка.';
  } else if (i === 4) {
    sHtml = 'Обновления. <span>По-человечески.</span>';
    sTxt = 'Что мы добавили и зачем это нужно. Свежее нововведение показываем карточкой с картинкой и инструкцией раз в сутки.';
  } else {
    const marks = pulseRaw.reduce((s, r) => s + r.marks, 0);
    const ev24 = pulseEv.filter(e => Date.now() - e.t.getTime() < 24 * 3600 * 1000).length;
    sHtml = 'Данными. <span>Не догадками.</span>';
    sTxt = 'Каждые 10 минут — отметки АЗС и голоса водителей: ' + marks + ' наблюдений, ' + ev24 + ' событий за сутки. Алгоритм предсказывает окна возврата.';
  }
  sl.innerHTML = sHtml;
  tx.classList.add('swap');
  setTimeout(() => { tx.textContent = sTxt; tx.classList.remove('swap'); }, 130);
}
let lastRendered = [];
// === МОЙ КОГДАБЕНЗ: тихое обучение на поведении водителя ===
// Все данные живут ТОЛЬКО на устройстве (localStorage).
// В базу ничего не отправляем: приватно и законно (152-ФЗ).
const KB_TRIPS_KEY = 'kbDriverTrips';
const KB_PREFS_KEY = 'kbDriverPrefs';
const MIN_TRIPS_FOR_ADVICE = 5; // минимум поездок для персонального совета

function getDriverTrips() {
  try { return JSON.parse(localStorage.getItem(KB_TRIPS_KEY) || '[]'); } catch (e) { return []; }
}
function saveDriverTrip(trip) {
  try {
    const trips = getDriverTrips();
    trips.push(trip);
    if (trips.length > 50) trips.splice(0, trips.length - 50); // максимум 50
    localStorage.setItem(KB_TRIPS_KEY, JSON.stringify(trips));
  } catch (e) {}
}
function getDriverPrefs() {
  try { return JSON.parse(localStorage.getItem(KB_PREFS_KEY) || '{}'); } catch (e) { return {}; }
}
function learnFromAction(stationId, action) {
  // action: 'advice_click' | 'route_built' | 'card_open' | 'visited'
  const st = stationById(stationId);
  if (!st) return;
  const now = new Date();
  const prefs = getDriverPrefs();
  const brand = brandKey(st);
  if (brand) {
    prefs.brandCounts = prefs.brandCounts || {};
    prefs.brandCounts[brand] = (prefs.brandCounts[brand] || 0) + 1;
  }
  const h = now.getHours();
  prefs.hourCounts = prefs.hourCounts || {};
  prefs.hourCounts[h] = (prefs.hourCounts[h] || 0) + 1;
  const d = now.getDay();
  prefs.dowCounts = prefs.dowCounts || {};
  prefs.dowCounts[d] = (prefs.dowCounts[d] || 0) + 1;
  prefs.lastAction = action;
  prefs.lastStationId = stationId;
  try { localStorage.setItem(KB_PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  if (action === 'route_built' || action === 'advice_click') {
    saveDriverTrip({ t: Date.now(), h: h, dow: d, stationId: stationId, brand: brand, action: action });
  }
}
// Замыкание контура: тень заправки подтверждает, доехал ли водитель
function confirmAdviceOutcome(stationId) {
  const trips = getDriverTrips();
  const recent = trips.filter(t => Date.now() - t.t < 3 * 3600 * 1000);
  if (!recent.length) return;
  const lastTrip = recent[recent.length - 1];
  const prefs = getDriverPrefs();
  prefs.outcomes = prefs.outcomes || [];
  prefs.outcomes.push({
    advisedStation: lastTrip.stationId,
    visitedStation: stationId,
    match: lastTrip.stationId === stationId,
    t: Date.now()
  });
  if (prefs.outcomes.length > 30) prefs.outcomes.splice(0, prefs.outcomes.length - 30);
  try { localStorage.setItem(KB_PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
}
// Персональная функция полезности: чем выше — тем лучше для ЭТОГО водителя
function personalScore(station, obs, distKm) {
  const prefs = getDriverPrefs();
  let score = 0;
  if (obs.fuel_95_status === true) score += 90;
  else if (obs.fuel_92_status === true) score += 80;
  else if (obs.diesel_status === true) score += 30;
  if (distKm !== null) score -= Math.min(25, distKm * 1.5);
  const brand = brandKey(station);
  if (brand && prefs.brandCounts && prefs.brandCounts[brand]) {
    const vals = Object.values(prefs.brandCounts);
    const maxBrand = Math.max.apply(null, vals);
    if (prefs.brandCounts[brand] >= maxBrand * 0.5) score += 15; // любимый бренд
  }
  const h = new Date().getHours();
  if (prefs.hourCounts && prefs.hourCounts[h]) score += 5;
  if (obs.queue_level === 'high') score -= 20;
  if (prefs.outcomes) {
    const here = prefs.outcomes.filter(o => o.advisedStation === station.id);
    const ok = here.filter(o => o.match).length;
    if (here.length >= 2) score += ok * 10; // тут раньше сработало
  }
  return score;
}
// Персональный совет: что делать СЕЙЧАС (или молчать)
function getPersonalAdvice() {
  const trips = getDriverTrips();
  if (trips.length < MIN_TRIPS_FOR_ADVICE) return null; // ещё учимся
  const last = getLastObservations();
  const loc = loadUserLocation();
  const citySet = new Set(cityStationList().map(s => s.id));
  let best = null, bestScore = -1, bestReason = '';
  for (const s of allStations) {
    if (!citySet.has(s.id)) continue;
    const o = last[s.id];
    if (!o) continue;
    const fresh = obsFresh(o);
    if (!fresh) continue;
    const hasFuel = o.fuel_95_status === true || o.fuel_92_status === true || o.diesel_status === true;
    if (!hasFuel) continue;
    let distKm = null;
    if (loc && Number.isFinite(Number(s.lat))) {
      const dLat = (Number(s.lat) - loc.lat) * 111;
      const dLon = (Number(s.lon) - loc.lon) * 111 * Math.cos(loc.lat * Math.PI / 180);
      distKm = Math.sqrt(dLat * dLat + dLon * dLon);
    }
    const sc = personalScore(s, o, distKm);
    if (sc > bestScore) { bestScore = sc; best = s; bestReason = o.fuel_95_status === true ? 'fuel95' : o.fuel_92_status === true ? 'fuel92' : 'diesel'; }
  }
  if (!best) return null;
  const prefs = getDriverPrefs();
  const outcomeCount = prefs.outcomes ? prefs.outcomes.length : 0;
  const confidence = Math.min(95, 50 + trips.length * 3 + outcomeCount * 5);
  return { station: best, score: bestScore, reason: bestReason, confidence: confidence, trips: trips.length };
}
// === Пульс города: оценка /10, дельта к вчера, изменения за 24 ч, лента и слово водителей ===
// Считаем ТОЛЬКО из уже загруженных массивов (наблюдения, fuelHourly, события,
// отметки) — новых запросов нет, карточка оживает вместе с данными.
// Оценка честная и объяснимая: АИ-95 45% + очереди 25% + свежесть 20% + баланс
// возвратов/исчезновений за сутки 10% (разбор — в подсказке по тапу на статус).
function pulseRowYesterday() {
  const t = new Date(Date.now() - 24 * 3600 * 1000);
  for (const r of fuelHourly) {
    const d = new Date(r.hour);
    if (d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getHours() === t.getHours()) return r;
  }
  return null;
}
function pulseCore(avail95, qshare) {
  if (avail95 === null || avail95 === undefined || qshare === null || qshare === undefined) return null;
  return 10 * (0.65 * avail95 + 0.35 * (1 - qshare));
}
function activeStationsCount(fromH, toH) {
  const now = Date.now();
  const a = now - toH * 3600 * 1000, b = now - fromH * 3600 * 1000;
  const city = new Set(cityStationList().map(s => s.id));
  const set = new Set();
  for (const o of allObservations) {
    if (!city.has(o.station_id)) continue; // только город пользователя, не весь юг
    const t = new Date(o.timestamp).getTime();
    if (t >= a && t < b) set.add(o.station_id);
  }
  return set.size;
}
function pulseSetDelta(elI, now, prev, upGood) {
  if (!elI) return;
  if (now === null || now === undefined || prev === null || prev === undefined) { elI.textContent = ''; return; }
  const pp = Math.round((now - prev) * 100);
  elI.textContent = pp === 0 ? '±0   сутки' : (pp > 0 ? '+' + pp : '−' + Math.abs(pp)) + ' п.п.   сутки';
  elI.className = pp === 0 ? 'n' : ((pp > 0) === upGood ? 'g' : 'r');
}
function pulseFillD24(b, val, invert) {
  if (!b) return;
  if (val === null || val === undefined) { b.textContent = '—'; b.className = 'n'; return; }
  const good = invert ? -val : val;
  b.textContent = val === 0 ? '±0' : (val > 0 ? '+' + val : '−' + Math.abs(val));
  b.className = val === 0 ? 'n' : (good > 0 ? 'g' : 'r');
}
// Плитки пользы: тап открывает карточку конкретной АЗС (куда ехать / где дёшево)
let pulseGoId = null, pulseCheapId = null;
function pulseGoOpen() { if (pulseGoId) openSheet(pulseGoId); }
function pulseCheapOpen() { if (pulseCheapId) openSheet(pulseCheapId); }
// === Направление ситуации из ленты событий (окно 6 ч, как у ленты) ===
// Возвраты против исчезновений по городу пользователя: «возвращается» /
// «уходит» / «тихо». Плюс медианная «продолжительность жизни» топлива после
// привоза за 7 дней (restored 	 следующее disappeared той же станции и топлива) —
// она отвечает на вопрос «успею ли вечером», показываем её в тап-подсказке.
function pulseMomentum() {
  const now = Date.now();
  const since6 = now - 6 * 3600 * 1000;
  const citySet = new Set(cityStationList().map(s => s.id));
  let rest6 = 0, dis6 = 0, lastT = 0;
  const byPair = {};
  for (const e of allWaveEvents) {
    if (!citySet.has(e.station_id)) continue;
    if (e.event_type !== 'fuel_restored' && e.event_type !== 'fuel_disappeared') continue;
    const t = new Date(e.detected_at).getTime();
    if (t > lastT) lastT = t;
    const k = e.station_id + '|' + e.fuel_type;
    (byPair[k] = byPair[k] || []).push({ t: t, kind: e.event_type });
    if (t < since6) continue;
    if (e.event_type === 'fuel_restored') rest6++;
    else dis6++;
  }
  const durs = [];
  for (const k of Object.keys(byPair)) {
    const list = byPair[k].sort((a, b) => a.t - b.t);
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind !== 'fuel_restored') continue;
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].kind === 'fuel_disappeared') {
          const h = (list[j].t - list[i].t) / 3600000;
          if (h > 0.2 && h < 24 * 7) durs.push(h);
          break;
        }
      }
    }
  }
  let lifeH = null;
  if (durs.length >= 3) {
    durs.sort((a, b) => a - b);
    lifeH = durs.length % 2 ? durs[(durs.length - 1) / 2] : (durs[durs.length / 2 - 1] + durs[durs.length / 2]) / 2;
  }
  let verdict, cls;
  if (rest6 >= 2 && rest6 > dis6) { verdict = 'прибывает'; cls = 'g'; }
  else if (dis6 >= 2 && dis6 > rest6) { verdict = 'уходит'; cls = 'r'; }
  else { verdict = 'тихо'; cls = 'n'; }
  return { rest6: rest6, dis6: dis6, verdict: verdict, cls: cls, sub: '+' + rest6 + ' вернулось   −' + dis6 + ' пропало', lifeH: lifeH, lastT: lastT };
}
function momentumExtra() {
  const m = pulseMomentum();
  const life = m.lifeH === null ? 'пока мало данных' : (m.lifeH >= 24 ? 'больше суток' : '~' + Math.round(m.lifeH) + ' ч');
  const ago = m.lastT ? Math.max(1, Math.round((Date.now() - m.lastT) / 60000)) : null;
  return 'За 6 ч: +' + m.rest6 + ' возвратов, −' + m.dis6 + ' исчезновений. Топливо после привоза держится обычно ' + life +
    (ago ? '. Последнее событие ленты ' + (ago < 60 ? ago + ' мин назад' : '~' + Math.round(ago / 60) + ' ч назад') : '') + '.';
}
// === Лентикулярная карточка: три угла = три слоя данных ===
// Обложки и переходы меняются здесь, одной строкой на сцену.
// go() — куда ведёт тап в текущем угле.
const LENTI_SCENES = [
  { cap: 'что нового?', go: () => openWhatsNewLens() },  // слабый наклон вправо: свежее обновление
  { cap: 'куда ехать', go: () => openAdviceNow() },      // сильный наклон вправо: живой советник с топ-3
  { cap: 'город живёт', go: () => openLifeNow() },       // слабый наклон влево: народная жизнь и твой вклад
  { cap: 'уведомления', go: () => tgSceneGo() }          // сильный наклон влево: Телеграм-бот
];
let lentiAngle = 0, lentiIdle = true, lentiBound = false;
// переходы сцен: каждое окно переиспользуем готовое, ничего нового не плодим
function openWhatsNewLens() {
  if (WHATS_NEW.length) showWhatsNew(WHATS_NEW[0]);
  else pagerGo(4); // обновлений нет — ведём в панель «Обновления сайта»
}
function openAdviceNow() {
  adviceShownThisSession = true; // сам попап в этот заход больше не выскочит
  if (!renderAdvicePop()) { pagerGo(3); return; } // советовать нечего — список АЗС
  document.getElementById('advicePop').classList.add('open');
  document.getElementById('adviceBack').classList.add('open');
}
function openLifeNow() {
  try { renderLifePop(); } catch (e) { return; }
  document.getElementById('lifePop').classList.add('open');
  document.getElementById('lifeBack').classList.add('open');
}
// сцена «Телеграм»: тап — подключить уведомления (или открыть бота, если уже подключён)
function tgSceneGo() { if (tgLinked) tgOpen(); else tgConnect(); }
// 4 сцены на одном наклоне: скорость и размах автовращения не менялись,
// изменились только границы зон (сильный наклон влево теперь тоже занят)
function lentiIdx(a) { return a > 16 ? 1 : a > 0 ? 0 : a > -16 ? 2 : 3; }
let lentiLastAngle = null, lentiLastIdx = -1, lentiScenesCache = null;
function lentiApply() {
  // троттлинг: изменение угла меньше 0.25° не пишем в DOM вовсе —
  // вдвое-втрое меньше перерисовок, соседние карточки не дёргаются
  if (lentiLastAngle !== null && Math.abs(lentiAngle - lentiLastAngle) < 0.25) return;
  lentiLastAngle = lentiAngle;
  const card = document.getElementById('lentiCard');
  if (!card) return;
  card.style.transform = 'rotateY(' + lentiAngle.toFixed(1) + 'deg)';
  card.style.setProperty('--gp', (50 - (lentiAngle / 28) * 50).toFixed(0) + '%');
  // голограмма: линейная рампа с мёртвой зоной до 12% угла — в анфас карточка
  // чистая, при наклоне радуга и глинты разгораются до заметных 0.5
  const mag = Math.min(1, Math.abs(lentiAngle) / 28);
  card.style.setProperty('--foil', (Math.max(0, (mag - 0.12) / 0.88) * 0.5).toFixed(3));
  card.style.setProperty('--fp', (50 - (lentiAngle / 28) * 70).toFixed(0) + '%');
  card.style.setProperty('--sp1', (50 - (lentiAngle / 28) * 110).toFixed(0) + '%');
  card.style.setProperty('--sp2', (50 + (lentiAngle / 28) * 80).toFixed(0) + '%');
  // слаты: узкие быстрее, широкие медленнее — тот же параллакс, что у искр
  card.style.setProperty('--sl1', (50 - (lentiAngle / 28) * 60).toFixed(0) + '%');
  card.style.setProperty('--sl2', (50 + (lentiAngle / 28) * 35).toFixed(0) + '%');
  // переливание мини-панелей отключено совсем: перерисовка градиентов каждый
  // кадр лагала на слабых телефонах. Блестит только линза — она одна и большая
  // сцены и подсказку трогаем ТОЛЬКО при смене угловой зоны, список сцен закэширован
  const idx = lentiIdx(lentiAngle);
  if (idx !== lentiLastIdx) {
    lentiLastIdx = idx;
    if (!lentiScenesCache || !lentiScenesCache.length) lentiScenesCache = document.querySelectorAll('.lenti-scene');
    lentiScenesCache.forEach((s, i) => s.classList.toggle('on', i === idx));
    const hint = document.getElementById('lentiHint');
    if (hint) hint.textContent = LENTI_SCENES[idx].cap;
    // на тёмно-синей сцене блик тоньше: на насыщенном фоне белая полоса
    // читалась как чужая плашка поверх иконки
    card.style.setProperty('--gl', idx === 3 ? '0.45' : '1');
  }
}
// Арт сцены «город живёт»: 7-дневный ритм народных отметок столбиками +
// полупрозрачное сердце. Считаем из уже загруженного allFeedback — без запросов.
// «город живёт»: кардиограмма народной активности за 7 дней (линия читается
// даже когда всё тихо — честная прямая) + сердце-маркер на живом конце
// и мягкое свечение народного фиолетового, как у брендов в «куда ехать».
function lentiLifeBars() {
  const cnt = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    cnt.push(allFeedback.filter(f => new Date(f.created_at).toDateString() === d.toDateString()).length);
  }
  const max = Math.max(1, ...cnt);
  const pts = cnt.map((v, i) => [8 + i * (104 / 6), 50 - (v / max) * 34]);
  let line = '';
  pts.forEach((p, i) => { line += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); });
  const area = line + 'L112 58L8 58Z';
  const lp = pts[pts.length - 1];
  return '<i class="lenti-glow" style="background:radial-gradient(circle at 80% 55%, #7c6dff29, rgba(255,255,255,0) 64%)"></i>' +
    '<svg class="lenti-ecg" viewBox="0 0 120 60" preserveAspectRatio="none" aria-hidden="true">' +
    '<path d="' + area + '" fill="#7c6dff" fill-opacity=".10"/>' +
    '<path d="' + line + '" fill="none" stroke="#7c6dff" stroke-opacity=".55" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path transform="translate(' + (lp[0] - 5).toFixed(1) + ' ' + (lp[1] - 7).toFixed(1) + ') scale(0.42)" d="M12 20s-7-4.5-9-9c-1.2-2.8.6-6 3.8-6 2 0 3.6 1.2 5.2 3.4C13.6 6.2 15.2 5 17.2 5c3.2 0 5 3.2 3.8 6-2 4.5-9 9-9 9z" fill="#7c6dff" fill-opacity=".8"/>' +
    '</svg>';
}
function lentiRender() {
  const el = id => document.getElementById(id);
  if (!el('lentiNewV')) return;
  // сцена 1: свежее обновление сайта — то, до чего не каждый досвайпает
  const wn = WHATS_NEW.length ? WHATS_NEW[0] : null;
  el('lentiNewV').textContent = wn ? wn.title : 'обновления зреют';
  el('lentiNewS').textContent = wn ? wn.date + '   ' + (wn.tag || 'новое') + '   тап — карточка' : 'история — в панели «Обновления сайта»';
  // сцена 2: живой советник — лучшая станция прямо сейчас
  const advList = buildAdviceList();
  const adv = advList[0];
  el('lentiAdvV').textContent = adv ? (adv.st.name || 'АЗС') : 'данные обновляются';
  el('lentiAdvS').textContent = adv
    ? (adv.kind === 'now' ? 'топливо есть сейчас   тап — топ-3' : adv.kind === 'stale' ? 'не точно — стоит проверить   тап — топ-3' : 'окно по прогнозу   тап — топ-3')
    : 'тап — список АЗС города';
  // сцена 3: народная жизнь за сутки + след водителя
  const since24 = Date.now() - 24 * 3600 * 1000;
  let fb = 0, onSite = 0;
  for (const f of allFeedback) {
    const t = new Date(f.created_at).getTime();
    if (t < since24) continue;
    fb++;
    if (f.verified_on_site) onSite++;
  }
  el('lentiLifeV').textContent = fb ? fb + ' отметок за сутки' : 'за сутки тихо';
  el('lentiLifeS').textContent = fb
    ? (onSite ? onSite + ' с места   тап — карточка города' : 'тап — как жил город и твой вклад')
    : 'тап — карточка «город живёт»';
  // арт сцен из готовых ассетов: картинка обновления, штамп+водяной знак бренда,
  // ритм народных отметок. Нет картинки/логотипа — слой просто пустой, текст живёт сам.
  const art0 = el('lentiArt0'), art1 = el('lentiArt1'), art2 = el('lentiArt2');
  // «что нового?»: картинка обновления на всю карточку + вуаль слева под текст
  if (art0) art0.innerHTML = wn && wn.img
    ? '<img class="lenti-bg" src="' + wn.img + '" alt="" onerror="this.style.display=\'none\'"><i class="lenti-scrim"></i>'
    : '';
  // «куда ехать»: на фоне — мягкое свечение фирменного цвета бренда,
  // а логотип — аккуратный штамп справа в потоке (не плавает в углу)
  const bk = adv ? brandKey(adv.st) : null;
  const logo = bk && BRAND_LOGOS[bk] ? BRAND_LOGOS[bk] : null;
  const bc = (bk && BRAND_COLORS[bk]) || '#397cff';
  // фон сцены «куда ехать»: свечение бренда + пунктирный мотив маршрута
  // «точка ты 	 пин АЗС» цветом бренда. Никаких чужих коллажей — только смысл.
  // ч/б призраки брендов из топ-3 (2-е и 3-е места): один меньше, другой ещё
  // меньше, слоты вокруг цветного штампа выбираем случайно при каждой отрисовке
  const ghostSrcs = [];
  for (let gi = 1; gi < advList.length && ghostSrcs.length < 2; gi++) {
    const gk = brandKey(advList[gi].st);
    if (gk && BRAND_LOGOS[gk] && BRAND_LOGOS[gk] !== logo) ghostSrcs.push(BRAND_LOGOS[gk]);
  }
  const GHOST_SLOTS = [[58,6],[70,10],[52,62],[66,68],[78,58],[48,12],[76,26]];
  let ghostHtml = '';
  for (let gk2 = 0; gk2 < ghostSrcs.length; gk2++) {
    const slot = GHOST_SLOTS.splice(Math.floor(Math.random() * GHOST_SLOTS.length), 1)[0];
    ghostHtml += '<span class="lenti-ghost g' + (gk2 + 1) + '" style="left:' + slot[0] + '%;top:' + slot[1] + '%"><img src="' + ghostSrcs[gk2] + '" alt="" onerror="this.parentNode.style.display=\'none\'"></span>';
  }
  if (art1) art1.innerHTML =
    '<i class="lenti-glow" style="background:radial-gradient(circle at 82% 55%, ' + bc + '29, rgba(255,255,255,0) 64%)"></i>' +
    '<svg class="lenti-route" viewBox="0 0 120 60" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
    '<path d="M8 52 C 32 50, 36 26, 60 24 S 94 30, 102 16" fill="none" stroke="' + bc + '" stroke-opacity=".38" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 7"/>' +
    '<circle cx="8" cy="52" r="4" fill="' + bc + '" fill-opacity=".45"/>' +
    '<path d="M102 4 c-6 0-10 4.6-10 10 0 7.4 10 16 10 16 s10-8.6 10-16 c0-5.4-4-10-10-10 z" fill="' + bc + '" fill-opacity=".5"/>' +
    '<circle cx="102" cy="14" r="3.4" fill="#fff" fill-opacity=".9"/>' +
    '</svg>' + ghostHtml;
  const stamp = el('lentiStamp');
  if (stamp) {
    stamp.style.display = logo ? '' : 'none';
    stamp.innerHTML = logo ? '<img src="' + logo + '" alt="" onerror="this.parentNode.style.display=\'none\'">' : '';
  }
  if (art2) art2.innerHTML = lentiLifeBars();
  // сцена 4: Телеграм — синий plane-водяной знак справа, тексты по статусу связки
  const art3 = el('lentiArt3');
  if (art3) art3.innerHTML =
    '<i class="lenti-glow" style="background:radial-gradient(circle at 80% 45%, rgba(255,255,255,.30), rgba(255,255,255,0) 62%)"></i>' +
    '<svg class="lenti-tgart" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-tg"/></svg>';
  const tgV = el('lentiTgV'), tgS = el('lentiTgS');
  if (tgV) tgV.textContent = tgLinked ? 'Уведомления включены' : 'Телеграм подскажет';
  if (tgS) tgS.textContent = tgLinked ? 'бот следит за твоим АЗС' : 'привоз на твоём АЗС — напишет бот';
}
function lentiBind() {
  if (lentiBound) return;
  const box = document.getElementById('lentiBox');
  if (!box) return;
  lentiBound = true;
  let sx = 0, st = 0, moved = 0;
  const setFromX = x => {
    const r = box.getBoundingClientRect();
    lentiAngle = Math.max(-28, Math.min(28, ((x - r.left) / r.width - 0.5) * 70));
    lentiIdle = false;
    lentiApply();
  };
  let sy = 0;
  box.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; st = Date.now(); moved = 0; lentiIdle = false; });
  // страховка поверх touch-action: горизонтальный палец на карточке — наш жест,
  // отменяем браузерную прокрутку, чтобы пейджер не дёргался ни на пиксель
  box.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > Math.abs(t.clientY - sy)) e.preventDefault();
  }, { passive: false });
  box.addEventListener('pointermove', e => {
    // палец на карточке — жест наш: ни пейджер, ни скролл не перехватывают
    if (e.pointerType === 'touch') e.preventDefault();
    if (e.pointerType !== 'mouse' && !(e.buttons & 1)) return;
    moved = Math.max(moved, Math.abs(e.clientX - sx));
    setFromX(e.clientX);
  }, { passive: false });
  box.addEventListener('pointerup', () => {
    if (moved < 10 && Date.now() - st < 600) {
      const idx = lentiIdx(lentiAngle);
      (LENTI_SCENES[idx].go || function () {})();
    }
    setTimeout(() => { lentiIdle = true; }, 6000);
  });
  box.addEventListener('pointercancel', () => { setTimeout(() => { lentiIdle = true; }, 2000); });
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { lentiApply(); return; }
  // автовращение без пальца: полный цикл по всем трём «подвкладкам», чтобы
  // карточка сама показывала, что она линза и что внутри. Скорость — делитель:
  // 650 ≈ круг за 4 сек; быстрее — уменьшай (400–500), медленнее — увеличивай (900+).
  lentiIdle = true;
  // вне экрана автовращение спит: не жжём батарею внизу страницы и не
  // «перелистываем сами» карточку, пока водитель читает ленту событий
  let lentiInView = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(es => { lentiInView = es[0].isIntersecting; }, { threshold: 0.25 }).observe(box);
  }
  const loop = t => {
if (lentiIdle && document.visibilityState === 'visible' && !pagerTouching && !liteMode) {
      lentiAngle = 24 * Math.sin(t / 1900);
      lentiApply();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
function renderPulse() {
  const el = id => document.getElementById(id);
  if (!el('pulseScore')) return;
  const last = getLastObservations();
  let k95 = 0, a95 = 0, kdt = 0, adt = 0, q = 0, selling = 0;
  for (const s of cityStationList()) {
    const o = last[s.id]; if (!o) continue;
    if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) { k95++; if (o.fuel_95_status) a95++; }
    if (o.diesel_status !== null && o.diesel_status !== undefined) { kdt++; if (o.diesel_status) adt++; }
    if (o.fuel_92_status === true || o.fuel_95_status === true || o.diesel_status === true) selling++;
    if (o.queue_level === 'high') q++;
  }
  const avail95 = k95 ? a95 / k95 : null, availDt = kdt ? adt / kdt : null, qshare = selling ? q / selling : null;
  const fr = freshStats();
  const freshShare = fr.tot ? fr.fresh / fr.tot : 0;
  const since24 = Date.now() - 24 * 3600 * 1000;
  let rest24 = 0, dis24 = 0;
  for (const e of allWaveEvents) {
    const t = new Date(e.detected_at).getTime();
    if (t < since24) continue;
    if (e.event_type === 'fuel_restored') rest24++;
    else if (e.event_type === 'fuel_disappeared') dis24++;
  }
  const evbal = (rest24 + dis24) ? rest24 / (rest24 + dis24) : 0.5;
  const score = (avail95 === null || qshare === null) ? null
    : 10 * (0.45 * avail95 + 0.25 * (1 - qshare) + 0.20 * freshShare + 0.10 * evbal);
  el('pulseScore').textContent = score === null ? '—' : score.toFixed(1).replace('.', ',');
  const lvl = score === null ? -1 : score >= 7.5 ? 3 : score >= 5.5 ? 2 : score >= 3.5 ? 1 : 0;
  const LVL = [
    ['Дефицит', 'red', 'Топливо в дефиците: ловите окна возврата в прогнозах.'],
    ['Напряжённо', 'orange', 'Топливо исчезает волнами — проверяйте АЗС перед выездом.'],
    ['Умеренно', 'yellow', 'Есть очереди и провалы, но большинство АЗС продаёт.'],
    ['Спокойно', 'green', 'Город живёт. Заправляться комфортно.']
  ];
  if (lvl >= 0) {
    el('pulseStatus').textContent = LVL[lvl][0];
    el('pulseDot').className = 'dot ' + LVL[lvl][1];
    el('pulseNote').textContent = LVL[lvl][2];
  }
  // кольцо: длина дуги = доля оценки, цвет = уровень города (спокойно/умеренно/напряжённо/дефицит)
  const LVL_RGB = ['239,83,80', '245,160,90', '245,184,46', '25,183,122']; // дефицит 	 спокойно
  const rgb = lvl >= 0 ? LVL_RGB[lvl] : '57,124,255';
  const ring = el('pulseRingFill');
  if (ring) {
    const C = 263.9; // длина окружности при r=42
    const frac = score === null ? 0 : Math.max(0, Math.min(1, score / 10));
    ring.style.strokeDashoffset = String(Math.round(C * (1 - frac) * 10) / 10);
    ring.style.stroke = lvl === 3 ? '#19b77a' : lvl === 2 ? '#f5b82e' : lvl === 1 ? '#f5a05a' : lvl === 0 ? '#ef5350' : '#c9d3e3';
  }
  // карточка в том же тоне: тонкая внутренняя окантовка + подкраска фона по уровню.
  // Прозрачности маленькие (.22 кант, .05	.13 фон) — цвет чувствуется, но не кричит.
  const card = document.querySelector('.pulse-card');
  if (card) {
    card.style.setProperty('--pulse-edge', 'rgba(' + rgb + ',.22)');
    card.style.background = 'linear-gradient(165deg,#fdfeff 0%, rgba(' + rgb + ',.05) 45%, rgba(' + rgb + ',.13) 100%)';
  }
  // дельта к вчера в это же время: ядро «топливо+очереди» по ритму города
  const y = pulseRowYesterday();
  const yAvail = y && y.k95 ? y.a95 / y.k95 : null;
  const yQ = y && y.selling ? y.q / y.selling : null;
  const coreNow = pulseCore(avail95, qshare);
  const coreY = pulseCore(yAvail, yQ);
  const dEl = el('pulseDelta');
  if (coreNow === null || coreY === null) dEl.style.display = 'none';
  else {
    const d = coreNow - coreY;
    dEl.style.display = '';
    dEl.className = 'pulse-delta ' + (d > 0.15 ? 'up' : d < -0.15 ? 'down' : 'flat');
    el('pulseDeltaV').textContent = (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(1).replace('.', ',');
  }
  // === Польза сейчас: куда ехать, где дешевле, есть ли очереди ===
  // Плитка 1: лучший вариант с топливом из того же советника «Куда ехать»
  const go = buildAdviceList()[0];
  if (go) {
    el('pulseGoName').textContent = go.st.name || 'АЗС';
    const fTxt = go.kind === 'now' ? (go.f === 'yes' ? 'АИ-95' : go.f === 'part' ? 'АИ-92' : 'дизель') : go.kind === 'stale' ? 'не точно — проверь' : 'окно по прогнозу';
    const goSub = el('pulseGoSub');
    goSub.textContent = fTxt + (go.km != null ? '   ' + (go.km < 1 ? Math.round(go.km * 1000) + ' м' : go.km.toFixed(1) + ' км') : '');
    goSub.className = go.kind === 'now' ? 'g' : 'n';
    pulseGoId = go.st.id;
  } else {
    el('pulseGoName').textContent = 'пока нет';
    const goSub = el('pulseGoSub');
    goSub.textContent = 'топливо сейчас не подтверждено';
    goSub.className = 'n';
    pulseGoId = null;
  }
  // Плитка 2: минимальная цена АИ-95 по городу + дельта к средней цене города
  let cheap = null;
  const cityP = priceHourly.find(r => r.p95 !== null && r.p95 !== undefined);
  for (const s of cityStationList()) {
    const p = allLastPrice[s.id];
    if (!p || p.price_95 === null || p.price_95 === undefined) continue;
    if (!cheap || Number(p.price_95) < cheap.p) cheap = { id: s.id, name: s.name || 'АЗС', p: Number(p.price_95) };
  }
  if (cheap) {
    el('pulseCheapPrice').textContent = cheap.p.toFixed(1) + ' ₽';
    let dTxt = '';
    if (cityP) {
      const dv = cheap.p - Number(cityP.p95);
      dTxt = '   ' + (dv > 0.049 ? '+' : dv < -0.049 ? '−' : '±') + Math.abs(dv).toFixed(1) + ' ₽ к городу';
    }
    const cnEl = el('pulseCheapName');
    cnEl.textContent = cheap.name + dTxt;
    cnEl.className = cityP && (cheap.p - Number(cityP.p95)) < -0.049 ? 'g' : 'n';
    pulseCheapId = cheap.id;
  } else {
    el('pulseCheapPrice').textContent = '—';
    const cnEl = el('pulseCheapName');
    cnEl.textContent = 'нет свежих цен';
    cnEl.className = 'n';
    pulseCheapId = null;
  }
  // Направление ситуации из ленты: торопиться или можно подождать
  const mom = pulseMomentum();
  const momVal = el('pulseMom');
  momVal.textContent = mom.verdict;
  momVal.className = mom.cls;
  const momSub = el('pulseMomSub');
  momSub.textContent = mom.sub;
  momSub.className = mom.cls;
  // лента событий за 6 часов: источник + народ, список вместо вращающейся строки
  const citySet = new Set(cityStationList().map(s => s.id));
  const since6 = Date.now() - 6 * 3600 * 1000;
  const items = [];
  for (const e of allWaveEvents) {
    if (!citySet.has(e.station_id)) continue;
    const t = new Date(e.detected_at).getTime();
    if (t < since6) continue;
    items.push({ st: e.station_id, fuel: e.fuel_type, kind: e.event_type === 'fuel_restored' ? 'restored' : 'gone', t: t });
  }
  for (const f of allFeedback) {
    const t = new Date(f.created_at).getTime();
    if (t < since6 || !citySet.has(f.station_id)) continue;
    if (f.feedback_type === 'available') items.push({ st: f.station_id, fuel: f.fuel_type, kind: 'folk_yes', t: t });
    else if (f.feedback_type === 'unavailable') items.push({ st: f.station_id, fuel: f.fuel_type, kind: 'folk_no', t: t });
    else if (f.feedback_type === 'delivery') items.push({ st: f.station_id, fuel: null, kind: 'delivery', t: t });
    else if (f.feedback_type === 'queue') items.push({ st: f.station_id, fuel: null, kind: 'queue', t: t });
    else if (f.feedback_type === 'in_queue') items.push({ st: f.station_id, fuel: null, kind: 'queue_live', t: t });
  }
  items.sort((a, b) => b.t - a.t);
  const winEl = el('pulseFeedWin');
  if (winEl) winEl.textContent = items.length ? items.length + ' за последние 6 ч' : 'последние 6 ч';
  const feedBox = el('pulseFeed');
  if (!items.length) feedBox.innerHTML = '<div class="recent">За последние 6 часов событий не было — это тоже новость: город спокоен.</div>';
  else feedBox.innerHTML = items.slice(0, 6).map(it => {
    const s = stationById(it.st);
    const nm = s ? (s.name || 'АЗС') : 'АЗС';
    const adr = s && s.address ? s.address : '';
    const d = new Date(it.t);
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const ic = feedIcon(it);
    const cls = (it.kind === 'restored' || it.kind === 'folk_yes') ? 'g' : (it.kind === 'gone' || it.kind === 'folk_no') ? 'r' : (it.kind === 'delivery') ? 'b' : 'o';
    const folk = it.kind === 'folk_yes' || it.kind === 'folk_no' || it.kind === 'queue' || it.kind === 'queue_live' || it.kind === 'delivery';
    let what;
    if (it.kind === 'queue' || it.kind === 'queue_live') what = 'очередь' + (it.q ? ' ' + (QUEUE_SHORT[it.q] || '') : '');
    else if (it.kind === 'delivery') what = 'привезли';
    else what = fuelLabel(it.fuel) + (it.kind === 'restored' ? ' вернулся' : it.kind === 'gone' ? ' пропал' : it.kind === 'folk_yes' ? ' есть' : ' нет');
    const ghost = it.fuel === '92' ? '92' : it.fuel === '95' ? '95' : it.fuel === 'diesel' ? 'ДТ' : '';
    return '<div class="pf-row"><span class="pf-ico ' + cls + '">' + (ghost ? '<i class="pf-ghost">' + ghost + '</i>' : '') + '<svg class="ic ic-s"><use href="#' + ic[0] + '"/></svg></span>' +
      '<span class="pf-txt"><b>' + escapeHtml(nm) + '</b><span>' + (folk ? 'водители: ' : 'источник: ') + escapeHtml(what) + (adr ? '   ' + escapeHtml(adr) : '') + '</span></span>' +
      '<span class="pf-time">' + hm + '</span></div>';
  }).join('');
  // слово водителям: свежий комментарий из народных отметок
  const qBox = el('pulseQuote');
  const withComment = allFeedback.filter(f => f.comment_text && new Date(f.created_at).getTime() >= since24 && citySet.has(f.station_id));
  if (!withComment.length) qBox.style.display = 'none';
  else {
    const c = withComment[0];
    const d = new Date(c.created_at);
    qBox.style.display = '';
    el('pulseQuoteTxt').textContent = '«' + c.comment_text + '»';
    el('pulseQuoteWho').textContent = 'водитель   ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
}
// === Топ-3 по ближайшему окну: «сейчас» (окно открыто) / «потом» (ближайшие будущие) ===
// Строка: логотип бренда + имя + чипы наличия топлива + бейдж окна с уверенностью.
// Тап — карточка АЗС (тот же контур трекинга, что у списка и карты).
let top3State = 0, top3Bound = false, top3Dragged = false;
function top3Go(i) {
  top3State = i ? 1 : 0;
  const track = document.getElementById('top3Track');
  if (track) { track.classList.remove('drag'); track.style.transform = 'translateX(' + (-top3State * 50) + '%)'; }
  const tn = document.getElementById('top3TabNow'), tl = document.getElementById('top3TabLater');
  if (tn) tn.classList.toggle('active', top3State === 0);
  if (tl) tl.classList.toggle('active', top3State === 1);
}
function top3Open(id) {
  if (top3Dragged) { top3Dragged = false; return; } // свайп не должен открывать карточку
  track('open_station_card', null, id);
  learnFromAction(id, 'card_open');
  openSheet(id);
}
function top3FuelChips(o) {
  const trust = availTrustworthy(o); // фильтр блефа: несвежее/подозрительное «есть» не зеленеет
  const chips = [];
  if (trust && o && o.fuel_95_status === true) chips.push('<i class="tf t95">95</i>');
  if (trust && o && o.fuel_92_status === true) chips.push('<i class="tf t92">92</i>');
  if (trust && o && o.diesel_status === true) chips.push('<i class="tf tdt">ДТ</i>');
  if (chips.length) return chips.join('');
  if (o && o.fuel_95_status === false && o.fuel_92_status === false && o.diesel_status === false) return '<i class="tf tno">нет</i>';
  return '<i class="tf tno">нет данных</i>';
}
// строка ветки: сквиркл-иконка с призрачной меткой топлива (как в ленте событий)
function threadRowHtml(e) {
  const d = new Date(e.t);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  let txt, cls, ico, ghost = '';
  if (e.kind === 'restored') { txt = fuelLabel(e.fuel) + ' вернулся'; cls = 'g'; ico = 'i-check'; ghost = e.fuel === 'diesel' ? 'ДТ' : e.fuel; }
  else if (e.kind === 'gone') { txt = fuelLabel(e.fuel) + ' пропал'; cls = 'r'; ico = 'i-cross'; ghost = e.fuel === 'diesel' ? 'ДТ' : e.fuel; }
  else if (e.kind === 'folk_yes') { txt = 'народ: ' + fuelLabel(e.fuel) + ' есть'; cls = 'g'; ico = 'i-check'; ghost = e.fuel === 'diesel' ? 'ДТ' : e.fuel; }
  else if (e.kind === 'folk_no') { txt = 'народ: ' + fuelLabel(e.fuel) + ' нет'; cls = 'r'; ico = 'i-cross'; ghost = e.fuel === 'diesel' ? 'ДТ' : e.fuel; }
  else if (e.kind === 'delivery') { txt = 'народ: привезли'; cls = 'b'; ico = 'i-truck'; }
  else if (e.kind === 'queue' || e.kind === 'queue_live') { txt = 'народ: очередь' + (e.q ? ' ' + (QUEUE_SHORT[e.q] || '') : ''); cls = 'o'; ico = 'i-queue'; }
  else { txt = String(e.kind); cls = 'o'; ico = 'i-minus'; }
  return '<div class="t3-tw"><span class="pf-ico t3-ico ' + cls + '">' + (ghost ? '<i class="pf-ghost">' + ghost + '</i>' : '') + '<svg class="ic ic-s"><use href="#' + ico + '"/></svg></span><b>' + txt + '</b><span class="tm">' + hm + '</span></div>';
}
// Цвет плашки по ПОСЛЕДНЕМУ событию строки: пополнение/«есть» (народ, привоз) —
// нежная зелёная, пропал/«нет» — нежная красная, очередь — оранжевая.
// Событий нет — пустая строка: карточка остаётся нейтральной,
// красим только там, где что-то произошло, как просил владелец.
function evTintClass(list) {
  if (!list || !list.length) return '';
  const k = list[0].kind;
  if (k === 'restored' || k === 'folk_yes' || k === 'delivery') return ' ev-g';
  if (k === 'gone' || k === 'folk_no') return ' ev-r';
  if (k === 'queue' || k === 'queue_live') return ' ev-o';
  return '';
}
// ветка-«ответ» под строкой топ-3: последние события станции из того же окна, что лента
function top3ThreadHtml(list) {
  if (!list.length) return '<div class="t3-thread"><div class="t3-tw"><span class="pf-ico t3-ico n"><svg class="ic ic-s"><use href="#i-minus"/></svg></span><b>событий за последние 6 ч нет</b></div></div>';
  return '<div class="t3-thread">' + list.map(threadRowHtml).join('') + '</div>';
}
// лента событий одной станции за 24 ч — живёт в карточке АЗС;
// пустая история = блок не рисуется вовсе, карточка не растягивается
function stationEventsHtml(stationId) {
  const since = Date.now() - 24 * 3600 * 1000;
  const list = [];
  for (const e of allWaveEvents) {
    if (e.station_id !== stationId) continue;
    const t = new Date(e.detected_at).getTime();
    if (t < since) continue;
    list.push({ kind: e.event_type === 'fuel_restored' ? 'restored' : 'gone', fuel: e.fuel_type, t: t });
  }
  for (const f of allFeedback) {
    if (f.station_id !== stationId) continue;
    const t = new Date(f.created_at).getTime();
    if (t < since) continue;
    if (f.feedback_type === 'available') list.push({ kind: 'folk_yes', fuel: f.fuel_type, t: t });
    else if (f.feedback_type === 'unavailable') list.push({ kind: 'folk_no', fuel: f.fuel_type, t: t });
    else if (f.feedback_type === 'delivery') list.push({ kind: 'delivery', t: t });
    else if (f.feedback_type === 'queue') list.push({ kind: 'queue', q: f.queue_size, t: t });
    else if (f.feedback_type === 'in_queue') list.push({ kind: 'queue_live', t: t });
  }
  if (!list.length) return '';
  list.sort((a, b) => b.t - a.t);
  return '<div class="st-ev"><div class="st-ev-t">' + icon('i-spark', 'ic-s') + 'События по станции   24 часа</div>' +
    '<div class="t3-thread">' + list.slice(0, 6).map(threadRowHtml).join('') + '</div></div>';
}
function top3RowHtml(st, o, pred, thread) {
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const f = Number(String(pred.from_time).slice(0, 2)) * 60 + Number(String(pred.from_time).slice(3, 5));
  const t = Number(String(pred.to_time).slice(0, 2)) * 60 + Number(String(pred.to_time).slice(3, 5));
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  let badge, time;
  if (pred.target_date > today) { badge = '<span class="t3-badge later">завтра</span>'; time = time5(pred.from_time) + '–' + time5(pred.to_time); }
  else if (nowM >= f && nowM <= t) { badge = '<span class="t3-badge now">сейчас</span>'; time = 'до ' + time5(pred.to_time); }
  else if (f > nowM) { badge = '<span class="t3-badge later">потом</span>'; time = 'через ~' + (f - nowM) + ' мин   ' + time5(pred.from_time) + '–' + time5(pred.to_time); }
  else { badge = '<span class="t3-badge none">окно прошло</span>'; time = 'ждём новый прогноз'; }
  const conf = Math.round((pred.confidence || 0) * 100);
  return '<div class="t3-item">' +
    '<div class="t3-row' + evTintClass(thread) + '" onclick="top3Open(\'' + st.id + '\')">' +
    '<span class="t3-logo">' + stationLogo(st) + '</span>' +
    '<span class="t3-main"><span class="t3-name">' + escapeHtml(st.name || 'АЗС') + '</span>' +
    '<span class="t3-addr">' + escapeHtml(st.address || '') + '</span>' +
    '<span class="t3-fuels">' + top3FuelChips(o) + '</span></span>' +
    '<span class="t3-right">' + badge + '<span class="t3-time">' + time + '   ' + conf + '%</span></span>' +
    '</div>' +
    top3ThreadHtml(thread) +
    '</div>';
}
// Строка страницы «сейчас»: бейдж «есть сейчас», время последней отметки о пополнении.
// Ветка-треда ниже — та же, что у окон: видно, что именно и когда пришло.
function top3NowRowHtml(st, o, rest, thread) {
  let time;
  if (rest && rest.length) {
    const d = new Date(rest[0].t);
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    time = 'пополнение в ' + hm + (rest.length > 1 ? ' и ещё ' + (rest.length - 1) + ' в ленте' : '');
  } else {
    time = 'факт наличия   без свежих привозов';
  }
  return '<div class="t3-item">' +
    '<div class="t3-row' + evTintClass(thread) + '" onclick="top3Open(\'' + st.id + '\')">' +
    '<span class="t3-logo">' + stationLogo(st) + '</span>' +
    '<span class="t3-main"><span class="t3-name">' + escapeHtml(st.name || 'АЗС') + '</span>' +
    '<span class="t3-addr">' + escapeHtml(st.address || '') + '</span>' +
    '<span class="t3-fuels">' + top3FuelChips(o) + '</span></span>' +
    '<span class="t3-right"><span class="t3-badge now">есть сейчас</span><span class="t3-time">' + time + '</span></span>' +
    '</div>' +
    top3ThreadHtml(thread) +
    '</div>';
}
function renderTop3() {
  const pageNow = document.getElementById('top3PageNow');
  const pageLater = document.getElementById('top3PageLater');
  if (!pageNow || !pageLater) return;
  const last = getLastObservations();
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const items = [];
  for (const st of cityStationList()) {
    const o = last[st.id];
    const pred = pickPrediction(st.id, o);
    if (!pred) continue;
    const f = Number(String(pred.from_time).slice(0, 2)) * 60 + Number(String(pred.from_time).slice(3, 5));
    const t = Number(String(pred.to_time).slice(0, 2)) * 60 + Number(String(pred.to_time).slice(3, 5));
    items.push({ st: st, o: o, pred: pred, key: winSortKey(pred), open: pred.target_date === today && nowM >= f && nowM <= t });
  }
  items.sort((a, b) => a.key - b.key);
  // события по станциям за то же 6-часовое окно, что и лента: источник + народ
  const since6 = Date.now() - 6 * 3600 * 1000;
  const evBySt = {};
  for (const e of allWaveEvents) {
    const t = new Date(e.detected_at).getTime();
    if (t < since6) continue;
    const arr = evBySt[e.station_id] = evBySt[e.station_id] || [];
    arr.push({ kind: e.event_type === 'fuel_restored' ? 'restored' : 'gone', fuel: e.fuel_type, t: t });
  }
  for (const f of allFeedback) {
    const t = new Date(f.created_at).getTime();
    if (t < since6) continue;
    const arr = evBySt[f.station_id] = evBySt[f.station_id] || [];
    if (f.feedback_type === 'available') arr.push({ kind: 'folk_yes', fuel: f.fuel_type, t: t });
    else if (f.feedback_type === 'unavailable') arr.push({ kind: 'folk_no', fuel: f.fuel_type, t: t });
    else if (f.feedback_type === 'delivery') arr.push({ kind: 'delivery', t: t });
    else if (f.feedback_type === 'queue') arr.push({ kind: 'queue', q: f.queue_size, t: t });
    else if (f.feedback_type === 'in_queue') arr.push({ kind: 'queue_live', t: t });
  }
  for (const k of Object.keys(evBySt)) evBySt[k].sort((a, b) => b.t - a.t);
  // «Сейчас» — по активности: топливо ЕСТЬ сейчас (достоверное) + отметки о пополнении
  // из ленты за 6 ч (источник: fuel_restored; народ: привезли / топливо есть).
  // Сортировка по свежести последней отметки пополнения. В спокойные недели
  // привозов не бывает вовсе — тогда добираем станциями просто с наличием,
  // но с честной пометкой «без свежих привозов», чтобы страница не пустовала.
  const restBySt = {};
  for (const id of Object.keys(evBySt)) {
    const evs = evBySt[id].filter(e => e.kind === 'restored' || e.kind === 'delivery' || e.kind === 'folk_yes');
    if (evs.length) restBySt[id] = evs; // evBySt уже отсортирован по убыванию времени
  }
  const nowCand = [];
  for (const st of cityStationList()) {
    const o = last[st.id];
    if (!availTrustworthy(o)) continue; // фильтр блефа: несвежее/подозрительное наличие не считаем
    if (o.fuel_95_status !== true && o.fuel_92_status !== true && o.diesel_status !== true) continue;
    const rest = restBySt[st.id] || null;
    nowCand.push({
      st: st, o: o, rest: rest,
      lastT: rest ? rest[0].t : 0,
      n: rest ? rest.length : 0,
      fm: (o.data_freshness_minutes === null || o.data_freshness_minutes === undefined) ? 1e9 : o.data_freshness_minutes
    });
  }
  nowCand.sort((a, b) => ((b.n > 0) - (a.n > 0)) || (b.lastT - a.lastT) || (a.fm - b.fm));
  const nowList = nowCand.slice(0, 3);
  const laterList = items.filter(it => !it.open && it.key < 1e8).slice(0, 3);
  // активных мало — ниже них прозрачное окошко с тем, что было здесь раньше:
  // ближайшие окна возврата по прогнозам (активные станции не дублируем)
  const winList = items.filter(it => it.key < 1e8 && !nowList.some(n => n.st.id === it.st.id)).slice(0, 3);
  const subHtml = winList.length
    ? '<div class="t3-sub"><div class="t3-sub-t">Ближайшие окна возврата   по прогнозу</div>' +
      winList.map(it => top3RowHtml(it.st, it.o, it.pred, (evBySt[it.st.id] || []).slice(0, 2))).join('') + '</div>'
    : '';
  const nowHtml = nowList.map(it => top3NowRowHtml(it.st, it.o, it.rest, (evBySt[it.st.id] || []).slice(0, 3))).join('');
  pageNow.innerHTML = (nowHtml || (subHtml ? '' : '<div class="t3-empty">Сейчас ни у одной АЗС города нет подтверждённого топлива. Свайпни к «потом» — там ближайшие окна возврата.</div>')) + subHtml;
  pageLater.innerHTML = laterList.length
    ? laterList.map(it => top3RowHtml(it.st, it.o, it.pred, (evBySt[it.st.id] || []).slice(0, 3))).join('')
    : '<div class="t3-empty">Ближайших окон пока нет — прогнозы копятся. Загляни позже или открой «куда ехать».</div>';
      // один раз за сессию: топ-3 реально нарисован (успешный сценарий «увидел и уехал»)
  // panel = сколько карточек «сейчас», duration_sec = сколько «потом»
  if (!top3LoadedSent && (nowList.length > 0 || laterList.length > 0)) {
    top3LoadedSent = true;
    track('top3_loaded', nowList.length, null, laterList.length);
  }
  // свайп по блоку: touch-action:pan-y не отдаёт жест горизонтальному пейджеру
  if (!top3Bound) {
    top3Bound = true;
    const vp = document.getElementById('top3View');
    const trackEl = document.getElementById('top3Track');
    let sx = 0, sy = 0, dx = 0, active = false;
    vp.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; dx = 0; active = true; trackEl.classList.add('drag'); });
    vp.addEventListener('pointermove', e => {
      if (!active) return;
      dx = e.clientX - sx;
      if (Math.abs(dx) < Math.abs(e.clientY - sy)) { dx = 0; return; } // вертикаль — это скролл панели
      trackEl.style.transform = 'translateX(' + (-top3State * vp.clientWidth + dx) + 'px)';
    });
    const finish = () => {
      if (!active) return;
      active = false;
      top3Dragged = Math.abs(dx) > 10;
      trackEl.classList.remove('drag');
      if (dx < -50 && top3State === 0) top3Go(1);
      else if (dx > 50 && top3State === 1) top3Go(0);
      else top3Go(top3State);
    };
    vp.addEventListener('pointerup', finish);
    vp.addEventListener('pointercancel', finish);
  }
}
// === «Возможно есть топливо здесь»: народное подтверждение свежих меток источника ===
// Кандидаты — станции, где источник за последние 2 ч отметил возврат топлива
// (событие fuel_restored), но свежим наблюдением «есть» сейчас не подтверждено.
// Голоса пишем обычными народными отметками в user_feedback: коллектор превратит
// их в события, журнал свидетеля — в заявления, консенсус перекрасит пины.
// Консенсус = ≥2 разных device_id за 24 ч: опция зачёркивается (голосование
// закрыто), станция с консенсусом «нет» уезжает в конец сортировки.
function maybeFuelVotes(stationId, fuel, since) {
  const yes = new Set(), no = new Set();
  let mine = null;
  for (const f of allFeedback) {
    if (f.station_id !== stationId || f.fuel_type !== fuel) continue;
    const t = new Date(f.created_at).getTime();
    if (t < since) continue;
    if (f.feedback_type === 'available') { yes.add(f.device_id || '?'); if (f.device_id === deviceId) mine = 'yes'; }
    else if (f.feedback_type === 'unavailable') { no.add(f.device_id || '?'); if (f.device_id === deviceId) mine = 'no'; }
  }
  return { yes: yes.size, no: no.size, mine: mine };
}
function maybeFuelCandidates() {
  const since = Date.now() - 2 * 3600 * 1000;
  const citySet = new Set(cityStationList().map(s => s.id));
  const last = getLastObservations();
  
  const candidates = {};
  
  // 1. Источник отметил возврат топлива
  for (const e of allWaveEvents) {
    if (e.event_type !== 'fuel_restored') continue;
    const t = new Date(e.detected_at).getTime();
    if (t < since || !citySet.has(e.station_id)) continue;
    const k = e.station_id + '|' + e.fuel_type;
    if (!candidates[k] || t > candidates[k].t) {
      candidates[k] = { stId: e.station_id, fuel: e.fuel_type, t: t };
    }
  }
  
  // 2. Водители недавно голосовали
  for (const f of allFeedback) {
    if (f.feedback_type !== 'available' && f.feedback_type !== 'unavailable') continue;
    const t = new Date(f.created_at).getTime();
    if (t < since || !citySet.has(f.station_id)) continue;
    const k = f.station_id + '|' + f.fuel_type;
    if (!candidates[k] || t > candidates[k].t) {
      candidates[k] = { stId: f.station_id, fuel: f.fuel_type, t: t };
    }
  }

  const out = [];
  for (const k of Object.keys(candidates)) {
    const c = candidates[k];
    const o = last[c.stId];
    const col = c.fuel === '92' ? 'fuel_92_status' : c.fuel === '95' ? 'fuel_95_status' : 'diesel_status';
    
    // Если источник свежо подтверждает наличие топлива, голосование не нужно
    if (o && obsFresh(o) && o[col] === true) continue;
    
    const st = allStations.find(s => s.id === c.stId);
    if (!st) continue;
    
    // Если водитель физически на месте уже подтвердил топливо, пропускаем
    if (sceneMark(c.stId, c.fuel)) continue;
    
    const v = maybeFuelVotes(c.stId, c.fuel, Math.max(c.t, maybeSince(c.stId, c.fuel)));
    
    // НОВАЯ ЛОГИКА: Если консенсус 2/2 уже есть, показываем его ещё 2 часа, 
    // чтобы водитель увидел зачёркивание и результат, а потом скрываем.
    if ((v.yes >= 2 || v.no >= 2) && (Date.now() - c.t > 2 * 3600 * 1000)) continue; 
    
    out.push({ st: st, fuel: c.fuel, t: c.t, yes: v.yes, no: v.no, mine: v.mine });
  }
  
  // Сортируем: сначала те, где голосование ещё идёт (меньше 2 голосов), 
  // затем уже завершённые (2/2), по времени.
  out.sort((a, b) => {
    const aDone = (a.yes >= 2 || a.no >= 2) ? 1 : 0;
    const bDone = (b.yes >= 2 || b.no >= 2) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return b.t - a.t;
  });
  
  return out.slice(0, 4);
}
function renderMaybeFuel() {
  const wrap = document.getElementById('maybeFuelPlate');
  if (!wrap) return;
  const list = maybeFuelCandidates();
  if (!list.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = '';
  const rows = list.map(c => {
    const d = new Date(c.t);
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const sunk = c.no >= 2, conf = c.yes >= 2;
    const sr = scoreRow(c.st.id, c.fuel);
    const ev = sr ? (SC_EV[sr.evidence] || SC_EV.none) : null;
    const open = 'openSheet(\'' + c.st.id + '\')';
    return '<div class="mf-row' + (sunk ? ' sunk' : conf ? ' confirmed' : '') + '">' +
      '<div class="mf-score ' + (ev ? ev[0] : 'e0') + '"><img src="icon-192.png" alt="" class="mf-drop">КогдаБенз Score: <b>' + (sr && sr.evidence !== 'none' ? sr.score + '/100' : '—') + '</b>' + (ev ? '   ' + ev[1] : '   ещё не считался') + '</div>' +
      '<div class="mf-top" onclick="' + open + '"><span class="mf-logo">' + stationLogo(c.st) + '</span>' +
      '<span class="mf-name">' + escapeHtml(c.st.name || 'АЗС') + '</span>' +
      '<span class="mf-fuel">' + fuelLabel(c.fuel) + '</span></div>' +
      '<div class="mf-addr" onclick="' + open + '">' + escapeHtml(c.st.address || '') + '   источник: топливо вернулось ' + hm + '</div>' +
      '<div class="mf-votes">' +
      '<button class="mf-btn yes' + (c.yes >= 2 ? ' struck' : '') + (c.mine === 'yes' ? ' mine' : '') + '" onclick="maybeVote(\'' + c.st.id + '\',\'' + c.fuel + '\',true)">' + icon('i-check', 'ic-s') + 'Да, имеется <i>' + c.yes + '/2</i></button>' +
      '<button class="mf-btn no' + (c.no >= 2 ? ' struck' : '') + (c.mine === 'no' ? ' mine' : '') + '" onclick="maybeVote(\'' + c.st.id + '\',\'' + c.fuel + '\',false)">' + icon('i-cross', 'ic-s') + 'Нет, отсутствует <i>' + c.no + '/2</i></button>' +
      '</span></div></div>';
  }).join('');
  wrap.innerHTML = '<div class="mf-head">' + icon('i-pump') + 'Возможно есть топливо здесь:<small>источник отметил за 2 ч</small></div>' +
    '<div class="mf-sub">Подтвердите или опровергните метку источника — голос уходит в ленту города и в цвет пина. Консенсус двух водителей закрывает голосование.</div>' + rows;
}
// === отмена случайного голоса на плашке «возможно есть топливо здесь» ===
// повторный тап по своей кнопке удаляет мою отметку: rpc fb_undo
// (SECURITY DEFINER), фолбэк — прямой DELETE. Офлайн-отметка (id local_*)
// убирается с экрана и из локальной очереди без сервера.
async function maybeUndoVote(stationId, fuel, yes, since) {
let my = null;
for (const f of allFeedback) {
if (f.station_id !== stationId || f.fuel_type !== fuel || f.device_id !== deviceId) continue;
if (f.feedback_type !== (yes ? 'available' : 'unavailable')) continue;
const t = new Date(f.created_at).getTime();
if (t < since) continue;
if (!my || t > my.t) my = { id: f.id, t: t };
}
if (!my) return;
if (String(my.id).indexOf('local_') === 0) {
const idx = allFeedback.findIndex(f => f.id === my.id);
if (idx >= 0) allFeedback.splice(idx, 1);
try {
const q = JSON.parse(localStorage.getItem('fbQueue') || '[]');
const nq = q.filter(r => !(r.station_id === stationId && r.fuel_type === fuel && r.device_id === deviceId && r.feedback_type === (yes ? 'available' : 'unavailable')));
localStorage.setItem('fbQueue', JSON.stringify(nq));
} catch (e) {}
renderMaybeFuel();
return;
}
let ok = false;
try {
const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/fb_undo', {
method: 'POST',
headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
body: JSON.stringify({ p_device: deviceId, p_id: my.id })
});
ok = r.ok && (await r.json()) === true;
} catch (e) {}
if (!ok) { try { ok = await dbDelete('user_feedback', 'id=eq.' + my.id + '&device_id=eq.' + encodeURIComponent(deviceId)); } catch (e) { ok = false; } }
if (!ok) { alert('Не удалось убрать голос: отметку уже видит город. Напишите нам — уберём вручную.'); return; }
const idx = allFeedback.findIndex(f => f.id === my.id);
if (idx >= 0) allFeedback.splice(idx, 1);
renderMaybeFuel();
setTimeout(() => { if (mapObj) renderMap(); renderNow(); }, 600);
track('feedback_undo', null, stationId);
}
async function maybeVote(stationId, fuel, yes) {
// голосование начинается с последней смены статуса пары (вернулось ИЛИ пропало):
// старые голоса до «пропало» не должны держать счётчики плашки
const since = maybeSince(stationId, fuel);
	const v = maybeFuelVotes(stationId, fuel, since);
// повторный тап по своему голосу — отмена (случайное нажатие)
if (v.mine === (yes ? 'yes' : 'no')) { await maybeUndoVote(stationId, fuel, yes, since); return; }
if (v.mine) return; // Один голос на водителя по паре за сутки
  if (yes ? v.yes >= 2 : v.no >= 2) return; // Голосование уже закрыто
  
  const st = allStations.find(s => s.id === stationId);
  const onSite = await onSiteFields(st);
  const row = Object.assign({
    station_id: stationId,
    device_id: deviceId,
    feedback_type: yes ? 'available' : 'unavailable',
    fuel_type: fuel,
    queue_size: null,
    comment_text: null
  }, onSite);
  
  let ok = true;
  try { await dbInsert('user_feedback', [row]); } catch (e) { ok = false; }
  if (!ok) queueFeedbackLocally([row]); // Нет связи - уйдет позже
  
  allFeedback.unshift(Object.assign({ created_at: new Date().toISOString(), id: 'local_' + Date.now() }, row));
  track('feedback_submit');
  bumpContrib();
  
  // Сразу перерисовываем плашку, чтобы счетчик обновился (1/2, 2/2 и т.д.)
  renderMaybeFuel();
  
  // Проверяем, достигнут ли консенсус (2/2)
  const newV = maybeFuelVotes(stationId, fuel, since);
  if (newV.yes >= 2 || newV.no >= 2) {
     // Если собрали 2/2 - обновляем карту (перекрашиваем пин/тепло) и советник
     setTimeout(() => {
       if (mapObj) renderMap();
       renderNow(); // Пересчитает пульс, тепловую карту и "Куда ехать"
     }, 1400);
  }
}
function renderNow() {
  const cta = document.getElementById('ctaBest');
  if (!allStations.length) return;
  const last = getLastObservations();
  let best = null, bestScore = -1, bestReason = '', bestKm = null, q = 0, tot = 0, avail = 0, known = 0;
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const loc = loadUserLocation();
  const distKm = st => {
    if (!loc || !Number.isFinite(Number(st.lat))) return null;
    const dLat = (Number(st.lat) - loc.lat) * 111;
    const dLon = (Number(st.lon) - loc.lon) * 111 * Math.cos(loc.lat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  };
  const citySet = new Set(cityStationList().map(s => s.id));
  for (const s of allStations) {
    if (!citySet.has(s.id)) continue;
    const o = last[s.id];
    if (!o) continue;
    if (!obsFresh(o)) continue;
    tot++;
    if (o.queue_level === 'high') q++;
    if (o.fuel_95_status === true) { avail++; known++; }
    else if (o.fuel_95_status === false) known++;
    
    const fresh = o.data_freshness_minutes !== null && o.data_freshness_minutes !== undefined && o.data_freshness_minutes <= 360;
    const km = distKm(s);
    const distPenalty = km === null ? 0 : Math.min(25, km * 1.5);
    
    if (fresh) {
      let base = 0;
      if (o.fuel_95_status === true) base = 90;
      else if (o.fuel_92_status === true) base = 80;
      else if (o.diesel_status === true) base = 30;
      if (base) {
        const sc = base - distPenalty;
        if (sc > bestScore) { bestScore = sc; best = s; bestKm = km; bestReason = base === 30 ? 'diesel' : 'fuel'; }
      }
    }
    
    const anyFuel = (o.fuel_92_status !== null && o.fuel_92_status !== undefined) ||
                    (o.fuel_95_status !== null && o.fuel_95_status !== undefined) ||
                    (o.diesel_status !== null && o.diesel_status !== undefined);
    const p = pickPrediction(s.id, o);
    if (p && fresh && anyFuel) {
      const fp = p.from_time.split(':'), tp = p.to_time.split(':');
      const f = Number(fp[0]) * 60 + Number(fp[1]), t = Number(tp[0]) * 60 + Number(tp[1]);
      let wv = 0;
      if (nowM >= f && nowM <= t) wv = 70;
      else if (f - nowM > 0 && f - nowM <= 180) wv = 50;
      if (wv) {
        const w = wv + (p.fuel_type === '95' ? 0 : p.fuel_type === '92' ? -10 : -50) - distPenalty;
        if (w > bestScore) { bestScore = w; best = s; bestKm = km; bestReason = 'win'; }
      }
    }
  }
  
  if (cta) {
    const advice = getPersonalAdvice();
    if (advice) {
      const km = loc && Number.isFinite(Number(advice.station.lat)) ?
        Math.sqrt(Math.pow((Number(advice.station.lat) - loc.lat) * 111, 2) +
                  Math.pow((Number(advice.station.lon) - loc.lon) * 111 * Math.cos(loc.lat * Math.PI / 180), 2)) : null;
      
      // === НОВАЯ ЛОГИКА: проверяем geoRequested ===
      const kmLabel = km === null
        ? (geoRequested ? '   определяю…' : '')
        : '   ' + (km < 1 ? Math.round(km * 1000) + ' м' : km.toFixed(1) + ' км');

      cta.innerHTML = icon('i-spark') + 'Куда ехать: ' + escapeHtml(advice.station.name || 'АЗС') +
        kmLabel + '   ' + advice.confidence + '%';
      cta.onclick = () => { track('click_where_to_go', null, advice.station.id); rememberAdvice(); learnFromAction(advice.station.id, 'advice_click'); openSheet(advice.station.id); };
    }
    else if (best) {
      // === НОВАЯ ЛОГИКА: проверяем geoRequested ===
      const kmLabel = bestKm === null
        ? (geoRequested ? '   определяю…' : '')
        : '   ' + (bestKm < 1 ? Math.round(bestKm * 1000) + ' м' : bestKm.toFixed(1) + ' км');

      cta.innerHTML = icon('i-spark') + 'Куда ехать: ' + escapeHtml(best.name || 'АЗС') +
        kmLabel +
        (bestReason === 'fuel' ? '   топливо есть' : bestReason === 'diesel' ? '   дизель есть' : '');
      cta.onclick = () => { track('click_where_to_go', null, best.id); rememberAdvice(); learnFromAction(best.id, 'advice_click'); openSheet(best.id); };
    }
    else { cta.innerHTML = icon('i-spark') + 'Прогнозы созревают'; cta.onclick = () => pagerGo(3); }
  }
  
  const qPct = tot ? Math.round(100 * q / tot) : 0;
  const aPct = known ? Math.round(100 * avail / known) : 0;
  const enough = known >= 5;
  const sub = document.getElementById('nowSub');
  if (sub) {
    const fr = freshStats();
    sub.innerHTML = '<span class="why-span" style="color:' + freshColor(fr) + ';font-weight:800;cursor:pointer" onclick="openWhyChip(this,\'fresh\')">Данные: ' + fr.fresh + ' из ' + fr.tot + ' свежие</span><br>' +
      (enough ? 'очереди на ' + qPct + '% АЗС   АИ-95 есть на ' + aPct + '%' : (known ? 'свежих отметок лишь ' + tot + ' — проценты по городу ещё не считаем' : 'источник ещё не прислал отметки топлива — появятся по мере поступления'));
  }
  const title = document.getElementById('nowTitle');
if (title) title.innerHTML = 'Лента событий <b class="pl-city">' + escapeHtml(cityGenitive()) + '</b>';
  updateMapPlate();
  renderHero();
  renderPulse();
  renderMaybeFuel();
  renderTop3();
  lentiRender();
  lentiBind();
  ensureMiniMap();
  renderMiniMap();
  renderAccuracy();
  renderCityTreemap();
  setTagline(currentPanel);
  updateSlimBar();
  updateSlimGeoStatus();
}
let onlyPred = false, sortWin = false, onlyFav = false, lastKeepOrder = false;
function toggleOnlyPred() {
  onlyPred = !onlyPred;
  const b = document.getElementById('ctlOnlyPred');
  if (b) b.classList.toggle('on', onlyPred);
  renderStations(lastRendered, lastKeepOrder);
}
function toggleSortWin() {
  sortWin = !sortWin;
  const b = document.getElementById('ctlSortWin');
  if (b) b.classList.toggle('on', sortWin);
  renderStations(lastRendered, lastKeepOrder);
}
function toggleOnlyFav() {
  onlyFav = !onlyFav;
  const b = document.getElementById('ctlFav');
  if (b) b.classList.toggle('on', onlyFav);
  renderStations(lastRendered, lastKeepOrder);
}
function winSortKey(p) {
  if (!p) return 1e9;
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const f = Number(p.from_time.slice(0, 2)) * 60 + Number(p.from_time.slice(3, 5));
  const t = Number(p.to_time.slice(0, 2)) * 60 + Number(p.to_time.slice(3, 5));
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (p.target_date > today) return 1440 + f;
  if (nowM >= f && nowM <= t) return 0;
  if (f > nowM) return f - nowM;
  return 1e8;
}
function renderStations(stations, keepOrder) {
  lastRendered = stations;
  lastKeepOrder = !!keepOrder;
  const app = document.getElementById('app');
  const lastObs = getLastObservations();
  if (!stations.length) { app.innerHTML = '<div class="empty-search">' + icon('i-search','ic-l') + '<br><br>Ничего не нашли.<br><small>Попробуйте другое название АЗС или адрес.</small></div>'; return; }
  const scored = stations.map(station => {
    const obs = lastObs[station.id];
    const pred = pickPrediction(station.id, obs);
    const freshMin = getFreshnessMin(obs);
const trusted = freshMin !== null && freshMin <= 360;
    const f95 = trusted ? obs.fuel_95_status : null;
    let score = 1;
    if (pred && f95 === false) score = 4; else if (pred) score = 3; else if (f95 === true) score = 2;
    return { station, obs, pred, score, freshMin };
  }).sort((a,b) => keepOrder ? 0 : (isFavorite(b.station.id) - isFavorite(a.station.id)) || (b.score - a.score) || ((a.freshMin ?? 1e9) - (b.freshMin ?? 1e9)));
  let shown = scored;
  if (onlyPred) shown = shown.filter(it => it.pred);
  if (onlyFav) shown = shown.filter(it => isFavorite(it.station.id));
  if (sortWin) shown = shown.slice().sort((a, b) => (winSortKey(a.pred) - winSortKey(b.pred)) || ((b.pred ? b.pred.confidence : 0) - (a.pred ? a.pred.confidence : 0)));
  app.innerHTML = shown.map(item => stationRow(item.station, item.obs, item.pred)).join('') ||
    '<div class="empty-search">' + icon('i-search','ic-l') + '<br><br>' + (onlyFav ? 'Избранного пока нет.' : 'Сейчас нет станций с прогнозом.') + '<br><small>' + (onlyFav ? 'Открой карточку АЗС и нажми сердечко.' : 'Сними фильтр «Только с прогнозом» или дождись новых данных.') + '</small></div>';
  const lc = document.getElementById('listCount');
  if (lc) lc.textContent = shown.length === stations.length ? stations.length + ' станций' : shown.length + ' из ' + stations.length;
  renderNow();
}
/* карта спроса: MapLibre + OpenFreeMap (вектор), полная перерисовка:
   чужие надписи и здания скрыты рантаймом — чистая бумага;
   надписи и слои спроса — только наши. Станет медленно из РФ — скажи,
   поменяем URL стиля одной строкой. */
let mapObj = null, allQueue = [];
let heatMode = false;
let heatStrength = 0.55; // в обычном режиме карты тепло тише, чтобы не спорить с пинами и кластерами
let routeFeature = null; // линия маршрута как фича рабочего источника zones
let serviceRing = null; // точки кольца границы обслуживания для канваса
let waterLayerIds = []; // id слоёв воды базовой карты: зебра не лежит на море
let zoneReady = false;
let objMarkers = [];
let lastClusterCenterByStation = {};
let lastRenderZoom = null;
let activePopup = null;
let activeRing = null;
let activeQuick = null;
let sheetFromMap = false;
let queueById = {};
let clusterHits = [], pinHits = [];
let userMarker = null;
// === ручная точка под глушилки РЭБ ===
// GPS под глушилками врёт: точность деградирует или точка улетает вне юга.
// Заметили — красная плашка и чип «указать своё местоположение»; в ручном
// режиме пин двигается тапом по карте или перетаскиванием. Ручная точка
// перекрывает GPS (kbManualLoc); кнопка «Рядом» сбрасывает её в авто.
let manualMode = false, geoSuspect = false, locPlateDismissed = false;
function manualLoc() {
  try { const m = JSON.parse(localStorage.getItem('kbManualLoc') || 'null'); return m && Number.isFinite(m.lat) && Number.isFinite(m.lon) ? m : null; } catch (e) { return null; }
}
function geoLooksSuspect(pos) {
  if (!pos || !pos.coords) return true;
  if (pos.coords.accuracy > 300) return true;
  const la = pos.coords.latitude, lo = pos.coords.longitude;
  return !(la >= 42.9 && la <= 48.7 && lo >= 36.9 && lo <= 46.0);
}
// Прыжок: новая точка дальше 5 км от последней принятой — молча верить нельзя:
// это глушилки или реальный переезд. В обоих случаях спрашиваем водителя и
// НЕ переписываем город/точку до подтверждения (кейс Кабардинка/Геленджик
// внутри рабочей рамки: детект молчал, а город молча переключался).
let pendingFix = null;
function savedAutoLoc() {
  try {
    const s = JSON.parse(localStorage.getItem('userLocation') || 'null');
    return s && Number.isFinite(s.lat) && Number.isFinite(s.lon) ? s : null;
  } catch (e) { return null; }
}
function jumpSuspect(lat, lon) {
  const s = savedAutoLoc();
  if (!s || !s.t) return false;
  if (Date.now() - s.t > 24 * 3600 * 1000) return false; // сохранение старше суток — о прыжке не судим
  const dLat = (lat - s.lat) * 111, dLon = (lon - s.lon) * 111 * Math.cos(lat * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon) > 5;
}
function acceptPendingFix() {
if (!pendingFix) return;
saveUserLocation(pendingFix.lat, pendingFix.lon);
showUserMarker(pendingFix.lat, pendingFix.lon);
detectUserCity();
renderStations(cityStationList());
pendingFix = null;
setGeoSuspect(false);
geoFailed = false;
renderAdviceIfOpen();
}
function saveManualLoc(lat, lon) {
try { localStorage.setItem('kbManualLoc', JSON.stringify({ lat: lat, lon: lon, t: Date.now() })); } catch (e) {}
setGeoSuspect(false); // точку поставили/подтвердили вручную — подозрение GPS снято
saveUserLocation(lat, lon);
detectUserCity();
renderStations(cityStationList());
geoFailed = false;
renderAdviceIfOpen();
refreshLocChip();
}
function setGeoSuspect(v) { geoSuspect = v; refreshLocChip(); }
function dismissLocPlate() {
  locPlateDismissed = true;
  try { localStorage.setItem('kbLocPlateDismissed', String(Date.now())); } catch (e) {}
  refreshLocChip();
}
function toggleManualLoc() {
  manualMode = !manualMode;
  if (userMarker && userMarker.setDraggable) userMarker.setDraggable(manualMode);
  refreshLocChip();
}
function refreshLocChip() {
  const chip = document.getElementById('locChip');
  const plate = document.getElementById('locPlate');
  if (chip) {
    chip.style.display = (geoSuspect || manualMode || manualLoc()) ? 'flex' : 'none';
    chip.classList.toggle('on', manualMode);
    chip.innerHTML = manualMode
      ? icon('i-check', 'ic-s') + '<span>точка ставится: тапни по карте или тяни её<br>ещё тап по чипу — готово</span>'
      : icon('i-pin', 'ic-s') + 'указать своё местоположение';
  }
  let cool = false;
  try { cool = Date.now() - Number(localStorage.getItem('kbLocPlateDismissed') || 0) < 6 * 3600 * 1000; } catch (e) {}
  if (plate) plate.classList.toggle('open', geoSuspect && !manualMode && !locPlateDismissed && !cool && !manualLoc());
}
// «Всё верно, оставить обычную точку»: вешаем через делегирование в capture-фазе —
// inline onclick именно этой кнопки на телефоне не срабатывал (кейс 24.09),
// так обработчик не зависит ни от атрибутов, ни от имени функции
document.addEventListener('click', e => {
  const t = e.target;
  if (t && t.closest && t.closest('#locPlateKeep')) {
    locPlateDismissed = true;
    try { localStorage.setItem('kbLocPlateDismissed', String(Date.now())); } catch (e2) {}
    refreshLocChip();
  }
}, true);
let floatChips = [];
function clearFloatChips() {
  for (const el of floatChips) if (el.parentNode) el.parentNode.removeChild(el);
  floatChips = [];
}
// мягкое снятие чипов на старте движения: не мгновенное исчезновение,
// а затухание 0.5с; элементы удаляются из DOM только после затухания
function fadeFloatChips() {
  if (!floatChips.length) return;
  const dying = floatChips.slice();
  floatChips = [];
  for (const box of dying) {
    if (!box.parentNode) continue;
    box.classList.add('out');
    setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 550);
  }
}
// бейджи очереди на зонах: 0 = далеко (центр круга), 1 = близко
// (маленький в левом нижнем углу под пином); переход на зуме 12.8–13.4
let zoneBadges = [];
function zoneBadgeT(z) { return Math.max(0, Math.min(1, (z - 12.8) / 0.6)); }
function applyZoneBadgeZoom(badge) {
  if (!badge || !mapObj) return;
  const t = zoneBadgeT(mapObj.getZoom());
  const s = 1 - 0.30 * t;
  const dx = -14 * t;
  const dy = 4 * t;
  badge.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')';
}
function applyZoneBadgesZoom() {
  for (const b of zoneBadges) applyZoneBadgeZoom(b);
}
const OUR_LABELS = [
  { name: 'Новороссийск', lon: 37.77, lat: 44.72, city: true, minZoom: 0 },
  { name: 'Краснодар', lon: 38.98, lat: 45.03, minZoom: 0 },
  { name: 'Сочи', lon: 39.72, lat: 43.60, minZoom: 0 },
  { name: 'Ростов-на-Дону', lon: 39.70, lat: 47.23, minZoom: 0 },
  { name: 'Ставрополь', lon: 41.97, lat: 45.04, minZoom: 0 },
  { name: 'Майкоп', lon: 40.12, lat: 44.60, minZoom: 9 },
  { name: 'Анапа', lon: 37.32, lat: 44.89, minZoom: 9 },
  { name: 'Геленджик', lon: 38.07, lat: 44.56, minZoom: 9 },
  { name: 'Центральный', lon: 37.77, lat: 44.735, minZoom: 11 },
  { name: 'Южный', lon: 37.79, lat: 44.665, minZoom: 11 },
  { name: 'Восточный', lon: 37.86, lat: 44.745, minZoom: 11 },
  { name: 'Мысхако', lon: 37.72, lat: 44.635, minZoom: 11 }
];
let labelCtrls = [];
// зоны спроса: вдали — лёгкая дымка, с приближением контрастнее и чётче;
// мягкая пульсация заставляет зону «дышать», а не стоять пятном
// зоны спроса: прозрачность и толщина считаются в JS обычными числами
// (MapLibre составные выражения для opacity применяет непредсказуемо):
// вдали — дымка, ближе — ярче и чётче; сверху мягкая пульсация «дыхания»
const ZONE_STOPS = {
  halo: [[12, 0.05], [13, 0.08], [15, 0.12]],
  fill: [[12, 0.10], [13, 0.16], [15, 0.24]],
  core: [[12, 0.16], [13, 0.24], [15, 0.34]],
  line: [[12, 0.16], [13, 0.24], [15, 0.38]],
  width: [[12, 1], [15, 1.6]]
};
function zoneRamp(stops, z) {
  if (z <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (z <= b[0]) return a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0]);
  }
  return stops[stops.length - 1][1];
}
// уличный зум: лужи тают, чтобы не укрывать улицы и дома —
// яркость 1 на z15 и плавно до 0 к z16.5, тот же дух, что вуаль маршрута
function zoneStreetFade(z) { return Math.max(0, Math.min(1, (16.5 - z) / 1.5)); }
// топливное тепло: радиус и прозрачность по зуму — простыми числами из JS
// (правило проекта: никаких составных interpolate(zoom) выражений), той же zoneRamp
const FH_RADIUS = [[9, 42], [11, 90], [13, 115], [15, 75], [16.5, 18]];
const FH_OPACITY = [[9, 1], [12, 1], [15, 1], [16.5, 0]];
const FH_LAYERS = ['fuelheat-calm', 'fuelheat-hot', 'fuelheat-partial', 'fuelheat-calm-old', 'fuelheat-hot-old', 'fuelheat-partial-old'];
let zonePulseTimer = null;
function startZonePulse() {
  if (zonePulseTimer) return;
  const t0 = Date.now();
  zonePulseTimer = setInterval(() => {
    if (!mapObj || !zoneReady) return;
    if (currentPanel !== 2) return;
    if (pagerTouching) return; // свайп: WebGL-перерисовки не отнимают кадры у жеста
    const shEl = document.getElementById('sheet');
    if (shEl && shEl.classList.contains('open')) return;
    const hbEl = document.getElementById('helloBack');
    if (hbEl && hbEl.classList.contains('open')) return;
    const z = mapObj.getZoom();
    // топливное тепло живёт на всех зумах: радиус и прозрачность ставим из JS
    // простыми числами + медленное «дыхание» света (pf) — поле кажется живым
    const pf = 0.92 + 0.08 * Math.sin((Date.now() - t0) / 900);
    const ff = zoneStreetFade(z);
    for (const L of FH_LAYERS) {
      mapObj.setPaintProperty(L, 'heatmap-radius', zoneRamp(FH_RADIUS, z));
      mapObj.setPaintProperty(L, 'heatmap-opacity', zoneRamp(FH_OPACITY, z) * ff * pf * heatStrength);
    }
    if (z < 12) return;
    const p = 0.85 + 0.15 * Math.sin((Date.now() - t0) / 500);
    const f = zoneStreetFade(z);
    mapObj.setPaintProperty('zones-halo', 'fill-opacity', zoneRamp(ZONE_STOPS.halo, z) * p * f);
    mapObj.setPaintProperty('zones-fill', 'fill-opacity', zoneRamp(ZONE_STOPS.fill, z) * p * f);
    mapObj.setPaintProperty('zones-core', 'fill-opacity', zoneRamp(ZONE_STOPS.core, z) * p * f);
    mapObj.setPaintProperty('zones-line', 'line-opacity', zoneRamp(ZONE_STOPS.line, z) * p * f);
    mapObj.setPaintProperty('zones-line', 'line-width', zoneRamp(ZONE_STOPS.width, z));
  }, 130);
}
function applyLabelZoom() {
  if (!mapObj) return;
  const z = mapObj.getZoom();
  for (const lc of labelCtrls) lc.el.style.display = z >= lc.minZoom ? '' : 'none';
}
// === Область обслуживания на карте: туман снаружи, пунктир по кромке ===
// Граница — рамки сбора (дом + донор Кубань/Адыгея): вне их мы не наблюдаем
// станции и не даём прогнозов. Углы скруглены квадратичными кривыми — линия
// читается как мягкая граница, а не как прямоугольник координат.
function roundedRing(pts, r, seg) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const va = [a[0] - p[0], a[1] - p[1]], vb = [b[0] - p[0], b[1] - p[1]];
    const la = Math.hypot(va[0], va[1]), lb = Math.hypot(vb[0], vb[1]);
    const pa = [p[0] + va[0] / la * r, p[1] + va[1] / la * r];
    const pb = [p[0] + vb[0] / lb * r, p[1] + vb[1] / lb * r];
    for (let s = 0; s < seg; s++) {
      const t = s / seg;
      out.push([
        (1 - t) * (1 - t) * pa[0] + 2 * (1 - t) * t * p[0] + t * t * pb[0],
        (1 - t) * (1 - t) * pa[1] + 2 * (1 - t) * t * p[1] + t * t * pb[1]
      ]);
    }
  }
  out.push(out[0].slice());
  return out;
}
function serviceAreaData() {
  // ВАЖНО: пары вида [долгота, широта] (GeoJSON), сначала долгота!
  const pts = [
    [37.20, 43.30], [45.90, 43.30], [45.90, 48.60], [37.20, 48.60]
  ];
  const ring = roundedRing(pts, 0.35, 10);
  const hole = ring.slice().reverse();
  const outer = [[20, 35], [55, 35], [55, 55], [20, 55], [20, 35]];
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { kind: 'dim' }, geometry: { type: 'Polygon', coordinates: [outer, hole] } },
      { type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'Polygon', coordinates: [ring] } }
    ]
  };
}
// Граница — не строгий прямоугольник: сначала уплотняем кольцо точками,
// потом сдвигаем каждую вдоль нормали гармониками 3/5/7 волн по периметру
// (фазы фиксированы — форма не дрожит между перерисовками). Амплитуда ~6 км:
// контур дышит и выглядит живой кромкой, а не рамкой чертежа.
function densifyRing(ring, stepDeg) {
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(d / stepDeg));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  out.push(out[0].slice());
  return out;
}
function organicServiceRing(ring) {
  const dense = densifyRing(ring, 0.05);
  const N = dense.length - 1; // последняя точка равна первой
  const p1 = 1.7, p2 = 4.2, p3 = 0.6;
  const AMP_M = 6000;
  const out = [];
  for (let i = 0; i < N; i++) {
    const prev = dense[(i - 1 + N) % N], cur = dense[i], next = dense[(i + 1) % N];
    let tx = next[0] - prev[0], ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    const t = i / N * 2 * Math.PI;
    const w = 0.55 * Math.sin(3 * t + p1) + 0.3 * Math.sin(5 * t + p2) + 0.18 * Math.sin(7 * t + p3);
    const m = w * AMP_M;
    out.push([cur[0] + nx * (m / (111320 * Math.cos(cur[1] * Math.PI / 180))), cur[1] + ny * (m / 111320)]);
  }
  out.push(out[0].slice());
  return out;
}
function applyServiceZoom() {
  if (!mapObj || !mapObj.getLayer('service-line')) return;
  const z = mapObj.getZoom();
  const line = z <= 10 ? 0.6 : z >= 12 ? 0 : 0.6 * (12 - z) / 2;
  mapObj.setPaintProperty('service-line-casing', 'line-opacity', line * 0.27);
  mapObj.setPaintProperty('service-line', 'line-opacity', line);
}
function ensureMap() {
const box = document.getElementById('mapBox');
if (!box || mapObj) return;
if (liteMode && !liteMapOk) { litePlaceholder(box); return; }
ensureMapLibre().then(buildMap).catch(() => {});
}
function mapLoadFail(e) {
  const box = document.getElementById('mapBox');
  if (box) box.innerHTML = '<div class="status" style="color:#c26a2a">Карта не смогла построиться: ' + (e && e.message ? e.message : 'неизвестная ошибка') + '<br><small style="margin-top:6px;display:block">Обнови страницу; если повторится — пришли фото этой надписи</small></div>';
}
function buildMap() {
  const box = document.getElementById('mapBox');
  if (!box || mapObj) return;
  
  box.innerHTML = '<div class="status" style="display:flex;align-items:center;justify-content:center;height:100%"><span class="ob-spin"></span>Загружаю карту...</div>';
  
  if (!window.maplibregl) { 
    box.innerHTML = '<div class="status" style="color:#c26a2a">❌ Библиотека карты не загрузилась<br><small style="margin-top:8px;display:block">Проверь интернет и обнови страницу</small></div>';
    return; 
  }
const savedLoc = loadUserLocation();
const startCenter = savedLoc ? [savedLoc.lon, savedLoc.lat] : [37.77, 44.72];
const startZoom = savedLoc ? 12 : 10;
mapObj = new maplibregl.Map({
  container: 'mapBox',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: startCenter,
  zoom: startZoom,
  attributionControl: false
});
  mapObj.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  mapObj.on('load', () => { try {
    for (const layer of mapObj.getStyle().layers || []) {
      if (layer.type === 'symbol') mapObj.setLayoutProperty(layer.id, 'visibility', 'none');
      else if (layer.id.indexOf('building') >= 0) mapObj.setLayoutProperty(layer.id, 'visibility', 'none');
      if (layer.type === 'fill' && layer.id.indexOf('water') >= 0) waterLayerIds.push(layer.id);
    }
    for (const l of OUR_LABELS) {
      const el = document.createElement('div');
      el.className = 'mlabel' + (l.city ? ' city' : '');
      el.textContent = l.name;
      new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([l.lon, l.lat]).addTo(mapObj);
      labelCtrls.push({ el: el, minZoom: l.minZoom || 0 });
    }
    applyLabelZoom();
    // Тепловая карта наличия топлива (бензин): сливающиеся мягкие пятна
    // вокруг станций. Зелёный — АИ-95 есть, оранжевый — только АИ-92 или мнения
    // разошлись, красный — бензина нет. Рисуется ПОД зонами спроса и пинами,
    // чтобы очереди и капли оставались читаемыми поверх.
    mapObj.addSource('fuelheat', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // Топливное тепло как непрерывное поле плотности: соседние станции физически
    // сливаются в одно поле (KDE heatmap-слоя). Два слоя: спокойное зелёное поле
    // (топливо есть) и поле дефицита (жёлтый 	 оранжевый 	 красное ядро).
    // Вес точки = сила сигнала дефицита: нет топлива > частичный состав > конфликт,
    // плюс надбавка за очередь сейчас (очередь = спрос здесь и сейчас).
        const FH_DEFS = [
      { id: 'fuelheat-calm', cls: 'calm', ramp: ['rgba(47,211,154,0)', 'rgba(47,211,154,0.35)', 'rgba(27,185,120,0.55)', 'rgba(27,185,120,0.70)', 'rgba(18,168,106,0.80)'] },
      { id: 'fuelheat-partial', cls: 'partial', ramp: ['rgba(45,212,191,0)', 'rgba(45,212,191,0.40)', 'rgba(45,212,191,0.60)', 'rgba(56,189,248,0.70)', 'rgba(56,189,248,0.90)'] },
      { id: 'fuelheat-calm-old', cls: 'calm-old', ramp: ['rgba(47,211,154,0)', 'rgba(47,211,154,0.16)', 'rgba(27,185,120,0.25)', 'rgba(27,185,120,0.32)', 'rgba(18,168,106,0.36)'] },
      { id: 'fuelheat-partial-old', cls: 'partial-old', ramp: ['rgba(45,212,191,0)', 'rgba(45,212,191,0.20)', 'rgba(45,212,191,0.30)', 'rgba(56,189,248,0.35)', 'rgba(56,189,248,0.40)'] },
      // ВНИМАНИЕ: Красный слой теперь в самом конце (рисуется поверх) и без желтого оттенка
      { id: 'fuelheat-hot', cls: 'hot', ramp: ['rgba(239,83,80,0)', 'rgba(239,83,80,0.40)', 'rgba(239,83,80,0.65)', 'rgba(239,83,80,0.85)', 'rgba(220,38,38,0.95)'] },
      { id: 'fuelheat-hot-old', cls: 'hot-old', ramp: ['rgba(239,83,80,0)', 'rgba(239,83,80,0.18)', 'rgba(239,83,80,0.28)', 'rgba(239,83,80,0.35)', 'rgba(239,83,80,0.45)'] }
    ];
    for (const d of FH_DEFS) {
      mapObj.addLayer({
        id: d.id,
        type: 'heatmap',
        source: 'fuelheat',
        filter: ['==', ['get', 'cls'], d.cls],
        paint: {
          'heatmap-weight': ['get', 'w'],
          'heatmap-intensity': 1.8,
          'heatmap-radius': 90,
          'heatmap-opacity': 1,
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
            0, d.ramp[0], 0.25, d.ramp[1], 0.5, d.ramp[2], 0.75, d.ramp[3], 1, d.ramp[4]]
        }
      });
    }
    mapObj.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    mapObj.addLayer({ id: 'zones-halo', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'halo'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 } });
    mapObj.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'main'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.16 } });
    mapObj.addLayer({ id: 'zones-core', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'core'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.24 } });
    mapObj.addLayer({ id: 'zones-line', type: 'line', source: 'zones', filter: ['==', ['get', 'kind'], 'main'], paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.24, 'line-width': 1.2, 'line-dasharray': [1, 1.8] } });
    // линия маршрута: line-cap/line-join в MapLibre живут в layout, не в paint —
    // из-за paint слой не создавался и обрывал всю загрузку карты
    if (!mapObj.getLayer('route-casing')) mapObj.addLayer({ id: 'route-casing', type: 'line', source: 'zones', filter: ['==', ['get', 'kind'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': .8, 'line-blur': 1 } });
    if (!mapObj.getLayer('route-line')) mapObj.addLayer({ id: 'route-line', type: 'line', source: 'zones', filter: ['==', ['get', 'kind'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2465ee', 'line-width': 5, 'line-opacity': .95 } });
    // область обслуживания: границу рисуем на канвасе (drawRouteCanvas) —
    // GL-линия на этом устройстве не отрисовалась, канвас рисуется гарантированно.
    // Запоминаем точки кольца и сразу рисуем границу.
    serviceRing = organicServiceRing(serviceAreaData().features[1].geometry.coordinates[0]);
    routeCanvasEl();
    drawRouteCanvas();
    zoneReady = true;
    startZonePulse();
    renderMap();
    const saved = loadUserLocation();
    if (saved) showUserMarker(saved.lat, saved.lon);
    } catch (e) { mapLoadFail(e); }
  });
  mapObj.on('zoomend', () => applyLabelZoom());
  mapObj.on('zoom', applyZoneBadgesZoom);
  mapObj.on('zoom', applyServiceZoom);
  mapObj.on('movestart', () => { fadeFloatChips(); closeRing(); closeQuick(); closeCovPop(); closeWhy(); });
  // тап мимо пина снимает меню действий и пузырь быстрой отметки
  document.addEventListener('pointerdown', e => {
    const t = e.target;
    const inPin = t.closest && (t.closest('.mring') || t.closest('.mquick') || t.closest('.mpin-wrap'));
    if (activeRing && !inPin) closeRing();
    if (activeQuick && !(t.closest && t.closest('.mquick'))) closeQuick();
  }, { capture: true });
  // Тап по кластеру/пину: гасим совместимые мышиные события маркеров
  // (они сбрасывают полёт камеры) и летаем ПОСЛЕ завершения тача
  const cont = mapObj.getContainer();
  let tX = 0, tY = 0, tT = 0;
  document.addEventListener('pointerdown', e => {
    tX = e.clientX; tY = e.clientY; tT = Date.now();
    const t = e.target;
    if (t && t.closest && (t.closest('.mcluster') || (t.closest('.mpin-wrap') && !t.closest('.mring') && !t.closest('.mquick')))) {
      e.preventDefault();
    }
  }, { capture: true });
  document.addEventListener('pointerup', e => {
    const dx = Math.abs(e.clientX - tX), dy = Math.abs(e.clientY - tY), dt = Date.now() - tT;
    if (dx > 20 || dy > 20 || dt > 800) return;
    const rect = cont.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) return;
    for (const h of pinHits) {
      const p = mapObj.project([h.lon, h.lat]);
      if (Math.hypot(p.x - px, p.y - 20 - py) <= 30) return; // пин откроет карточку сам
    }
    let best = null, bestD = 1e9;
    for (const h of clusterHits) {
      const p = mapObj.project([h.lon, h.lat]);
      const d = Math.max(Math.abs(p.x - px), Math.abs(p.y - py));
      if (d < bestD) { bestD = d; best = h; }
    }
    if (best && bestD <= 26) {
      setTimeout(() => {
        if (!mapObj) return;
        mapObj.stop();
        mapObj.easeTo({ center: [best.lon, best.lat], zoom: Math.min(17, mapObj.getZoom() + 2), duration: 900 });
      }, 120);
    }
  }, { capture: true });
  // ручная точка: тап по карте в ручном режиме передвигает ваш пин
  mapObj.on('click', e => {
    if (!manualMode) return;
    showUserMarker(e.lngLat.lat, e.lngLat.lng);
    saveManualLoc(e.lngLat.lat, e.lngLat.lng);
  });
  let moveTick = false;
  mapObj.on('moveend', () => {
    if (moveTick) return;
    moveTick = true;
    setTimeout(() => { moveTick = false; renderMap(); }, 180);
  });
}
function toggleMapAttrib() {
  const pop = document.getElementById('mapAttribPop');
  if (pop) pop.classList.toggle('open');
}
/* два режима карты: «Карта» (кластеры, пины, лужи очередей) и «Тепло»
   (тепловая карта спроса — главный герой: поле + точки АЗС + минимальная легенда) */
function setHeatMode(on, btn) {
  heatMode = !!on;
  heatStrength = heatMode ? 1 : 0.55;
  const tabs = document.getElementById('heatTabs');
  if (tabs) tabs.querySelectorAll('.mg-tab').forEach(t => t.classList.toggle('active', t === btn));
  const tEl = document.getElementById('mapTitle');
  if (tEl) tEl.textContent = heatMode ? 'Тепловая карта спроса' : 'Карта спроса';
  const sEl = document.getElementById('mapSub');
  if (sEl) sEl.textContent = heatMode
    ? 'Тепловая карта показывает, где сейчас сосредоточен дефицит топлива.'
    : 'Каждая капля — заправка: цвет говорит, какое топливо есть сейчас, а лужа вокруг — где очередь. Цветное поле под ними — где дефицит топлива. Нажми на каплю — появятся кнопки.';
  const plate = document.getElementById('mapPlate');
  if (plate) plate.style.display = heatMode ? 'none' : '';
  const lq = document.getElementById('legQueue'); if (lq) lq.style.display = heatMode ? 'none' : '';
  const lf = document.getElementById('legFuel'); if (lf) lf.style.display = heatMode ? 'none' : '';
  const lh = document.getElementById('legHeat'); if (lh) lh.style.display = '';
  const box = document.getElementById('mapBox');
  if (box) box.classList.toggle('heat', heatMode);
  if (mapObj && zoneReady) {
    for (const L of FH_LAYERS) mapObj.setLayoutProperty(L, 'visibility', 'visible');
    for (const L of ['zones-halo', 'zones-fill', 'zones-core', 'zones-line']) mapObj.setLayoutProperty(L, 'visibility', heatMode ? 'none' : 'visible');
    renderMap();
  }
}
function demandOf(id) {
  const q = queueById[id];
  const last = getLastObservations()[id];
  let sc = 0;
  if (last && last.queue_level === 'high') sc += 50;
  if (q && q.n24) sc += 30 * Math.min(1, (q.q24 || 0) / q.n24);
  if (q && q.n7) sc += 20 * Math.min(1, (q.q7 || 0) / q.n7);
  return Math.round(sc);
}
function demandRgb(sc) { return sc >= 50 ? '239,83,80' : sc >= 30 ? '245,160,90' : sc >= 12 ? '245,213,101' : '47,211,154'; }
const QUEUE_SHORT = { small: '2–3', medium: '4–6', large: '7+', huge: '100+' };
// последняя народная отметка размера очереди за сутки (или null)
function lastQueueMark(stationId) {
  const since = Date.now() - 24 * 3600 * 1000;
  let best = null;
  for (const f of allFeedback) {
    if (f.station_id !== stationId || f.feedback_type !== 'queue') continue;
    const t = new Date(f.created_at).getTime();
    if (t < since) continue;
    if (!best || t > best.t) best = { t: t, size: f.queue_size };
  }
  return best;
}
// сколько минут стоит очередь станции (null, если очереди нет)
function queueAgeMin(stationId) {
  let best = null;
  for (const e of queueEpisodes) {
    if (e.station_id !== stationId || e.ended_at) continue;
    const t = new Date(e.started_at).getTime();
    if (best === null || t > best) best = t;
  }
  return best === null ? null : Math.max(0, Math.round((Date.now() - best) / 60000));
}
function ageRu(min) {
  if (min === null || min === undefined) return null;
  if (min < 60) return min + ' мин';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  return Math.floor(h / 24) + ' дн';
}
// медианная длительность завершённых очередей за сутки по городу
function cityQueueMedian24() {
  const since = Date.now() - 24 * 3600 * 1000;
  const durs = [];
  for (const e of queueEpisodes) {
    if (!e.ended_at) continue;
    const end = new Date(e.ended_at).getTime();
    if (end < since) continue;
    const d = (end - new Date(e.started_at).getTime()) / 60000;
    if (d > 3 && d < 24 * 60) durs.push(d);
  }
  if (!durs.length) return null;
  durs.sort((a, b) => a - b);
  return Math.round(durs.length % 2 ? durs[(durs.length - 1) / 2] : (durs[durs.length / 2 - 1] + durs[durs.length / 2]) / 2);
}
function queueStrip(stationId, obs) {
  const age = queueAgeMin(stationId);
  const high = obs && obs.queue_level === 'high';
  if (age === null && !high) return '';
  // источник больше не подтверждает очередь (статус null или не high):
  // эпизод из вьюхи может висеть «открытым» сутками — честная тусклая строка
  if (!high) {
    return '<div class="dg-strip" style="margin-top:8px;opacity:.75">' + icon('i-queue', 'ic-s') + '<span>очередь сообщали ' + ageRu(age) + ' назад — источник больше не подтверждает</span></div>';
  }
  const txt = age !== null
    ? 'очередь стоит <b>' + ageRu(age) + '</b>'
    : 'очередь сейчас — началась только что';
  return '<div class="dg-strip" style="margin-top:8px">' + icon('i-queue', 'ic-s') + '<span>' + txt + '</span></div>';
}
/* Прогноз очереди (шаг 5): медианное окно появления очереди по истории.
   Берём часы, когда очередь появлялась, строим медиану ± разброс. Своих
   событий станции мало (<3) — берём весь город. Оценка по прошлому, не гарантия. */
function queueWindowFor(stationId) {
  const own = allQueueEvents.filter(e => e.station_id === stationId);
  let use = own, src = 'own';
  if (use.length < 3) { use = allQueueEvents; src = 'city'; }
  if (use.length < 3) return null;
  const mins = use.map(e => {
    const d = new Date(new Date(e.detected_at).getTime() + 3 * 3600 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }).sort((a, b) => a - b);
  const med = mins.length % 2 ? mins[(mins.length - 1) / 2] : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2;
  const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
  const variance = mins.reduce((s, t) => s + (t - mean) * (t - mean), 0) / mins.length;
  let sd = Math.sqrt(variance);
  if (sd < 30) sd = 30;
  const wrap = m => ((m % 1440) + 1440) % 1440;
  const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const tightness = 1 / (1 + sd / 120);
  const conf = Math.min(0.9, Math.max(0.1, 0.3 + 0.3 * tightness + Math.min(0.2, use.length * 0.02)));
  return {
    window: fmt(wrap(Math.round(med - sd))) + '–' + fmt(wrap(Math.round(med + sd))),
    confidence: Math.round(conf * 100),
    basedOn: use.length,
    src: src
  };
}
function queueForecastStrip(stationId) {
  const fw = queueWindowFor(stationId);
  if (!fw) return '';
  const srcTxt = fw.src === 'own' ? 'по истории этой АЗС' : 'по городу (по этой АЗС мало)';
  return '<div class="dg-strip tap why-tap" data-qf="' + srcTxt + '" style="margin-top:6px" onclick="openWhyChip(this,\'qfcst\')">' +
    icon('i-clock', 'ic-s') +
    '<span>Очередь вероятна: <b>' + fw.window + '</b>   ' + fw.confidence + '%</span></div>';
}
// Народный консенсус (защита от фейковых отметок): считаем голоса РАЗНЫХ
// устройств (device_id) за последние 60 минут. Источник всегда в приоритете:
// народ красит пин только когда источник молчит обо всех топливах.
// 2 голоса — ранний сигнал (красим), 3 голоса — подтверждённый консенсус,
// «есть» и «нет» по одному топливу встретились — «разные мнения».
let folkMap = null, folkMapAt = 0, folkMapCount = -1;
function getFolkMap() {
  const now = Date.now();
  if (folkMap && now - folkMapAt < 60000 && folkMapCount === allFeedback.length) return folkMap;
  const since = now - 2 * 60 * 60 * 1000;
  const votes = {};
  for (const f of allFeedback) {
    if (f.feedback_type !== 'available' && f.feedback_type !== 'unavailable') continue;
    if (!f.fuel_type) continue;
    if (new Date(f.created_at).getTime() < since) continue;
    const key = f.station_id + '|' + f.fuel_type + '|' + (f.feedback_type === 'available' ? 'yes' : 'no');
    const v = votes[key] = votes[key] || { devs: new Set(), onSite: new Set() };
    v.devs.add(f.device_id || '?');
    if (f.verified_on_site) v.onSite.add(f.device_id || '?');
  }
  const map = {};
  for (const key of Object.keys(votes)) {
    const parts = key.split('|');
    const st = map[parts[0]] = map[parts[0]] || {};
    st[parts[1]] = st[parts[1]] || { yes: 0, no: 0, yesOnSite: 0, noOnSite: 0 };
    st[parts[1]][parts[2]] = votes[key].devs.size;
    st[parts[1]][parts[2] + 'OnSite'] = votes[key].onSite.size;
  }
  folkMap = map; folkMapAt = now; folkMapCount = allFeedback.length;
  return map;
}
function folkVerdict(c) {
  if (!c) return null;
  if (c.yes >= 2 && c.yes > c.no) return { verdict: 'yes', votes: c.yes, strong: c.yes >= 3, onSite: c.yesOnSite || 0 };
  if (c.no >= 2 && c.no > c.yes) return { verdict: 'no', votes: c.no, strong: c.no >= 3, onSite: c.noOnSite || 0 };
  if (c.yes >= 1 && c.no >= 1) return { verdict: 'conflict', votes: c.yes + c.no, strong: false, onSite: 0 };
  return null;
}
function folkCounts(stationId, fuel) { return (getFolkMap()[stationId] || {})[fuel] || null; }
function folkConsensus(stationId, fuel) { return folkVerdict(folkCounts(stationId, fuel)); }
// Народное состояние пина: только когда источник молчит обо всех топливах
function folkPinState(stationId, o) {
  // Смотрим народ, если источник молчит ИЛИ его данные устарели/не вызывают доверия
  const trust = o && availTrustworthy(o);
  if (trust && (o.fuel_92_status != null || o.fuel_95_status != null || o.diesel_status != null)) return null;
  
  const f95 = folkFuelSignal(stationId, '95'), f92 = folkFuelSignal(stationId, '92'), fdt = folkFuelSignal(stationId, 'diesel');
  if (!f95 && !f92 && !fdt) return null;
  if (f95 && f95.verdict === 'yes') return 'yes';
  if (f92 && f92.verdict === 'yes') return 'part';
  if (fdt && fdt.verdict === 'yes') return 'diesel';
  if ((f95 && f95.verdict === 'conflict') || (f92 && f92.verdict === 'conflict') || (fdt && fdt.verdict === 'conflict')) return 'conflict';
  if ((f95 && f95.verdict === 'no') || (f92 && f92.verdict === 'no') || (fdt && fdt.verdict === 'no')) return 'no';
  return null;
}
function effPinKey(st, o) {
  const k = pinKey(o);
  if (k !== 'unknown') return k;
  return folkPinState(st.id, o) || 'unknown';
}
// доверие к снимку источника: свежий (≤6 ч) И не в «подозрительном» состоянии
// машины состояний коллектора. Подозрительное = источник мигнул «есть» на фоне
// дефицита (SUSPECTED_LOSS / CONFIRMED_LOSS / DEPLETION / RECOVERY_STARTED) —
// ровно профиль блефа чужих отметок на gdebenz. «Нет» (false) не трогаем:
// ложное отсутствие для водителя безопасно.
function stateSuspicious(o) {
  if (!o) return false;
  const s = o.fuel_state;
  return s === 'SUSPECTED_LOSS' || s === 'CONFIRMED_LOSS' || s === 'DEPLETION' || s === 'RECOVERY_STARTED';
}
function availTrustworthy(o) { return obsFresh(o) && !stateSuspicious(o); }
function pinKey(o) {
  if (!o) return 'unknown';
  const trust = availTrustworthy(o);
  const nullish = v => v === null || v === undefined;
  const gate = v => nullish(v) ? null : (trust ? v : (v === false ? false : null));
  const g = gate(o.fuel_95_status), p = gate(o.fuel_92_status), d = gate(o.diesel_status);
  if (g === null) return 'unknown'; // 95 — главный индикатор: не доверяем = серый
  if (g === true) return 'yes';
  if (d === true && p !== true) return 'diesel';
  if (p === true) return 'part';
  return 'no';
}
// порог свежести един по продукту: 6 часов (тот же, что у советника
// «Куда ехать» и индикатора свежести). Отметка старше — рисуется тускло,
// чтобы глаз не принимал вчерашнее топливо за сегодняшнее
function obsFresh(o) {
  const m = getFreshnessMin(o);
  return m !== null && m <= 360;
}
function fuelChip(label, status) {
  if (status === true) return '<span class="rc-chip yes">' + icon('i-pump', 'ic-s') + label + ' есть</span>';
  if (status === false) return '<span class="rc-chip no">' + icon('i-cross', 'ic-s') + label + ' нет</span>';
  return '<span class="rc-chip" style="background:#eef2f8;color:#7487a7">' + icon('i-minus', 'ic-s') + label + ' нет данных</span>';
}
/* зоны спроса — не круги с рамкой, а «лужи»: радиус гуляет по контуру тремя
   плавными гармониками; фазы из хэша id станции — каждая лужа своя, но не
   дрожит и не переползает между перерисовками. Три слоя: ореол, тело, ядро. */
function seedOf(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function blobFeature(lat, lon, rMeters, color, seed, kind, scale) {
  const p1 = (seed % 628) / 100, p2 = ((seed >> 3) % 628) / 100, p3 = ((seed >> 6) % 628) / 100;
  const N = 64;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * 2 * Math.PI;
    const m = 1 + 0.17 * Math.sin(2 * a + p1) + 0.11 * Math.sin(3 * a + p2) + 0.06 * Math.sin(5 * a + p3);
    const r = rMeters * scale * m;
    const dLat = (r * Math.sin(a)) / 111320;
    const dLon = (r * Math.cos(a)) / (111320 * Math.cos(lat * Math.PI / 180));
    pts.push([lon + dLon, lat + dLat]);
  }
  pts.push(pts[0]);
  return { type: 'Feature', properties: { color: color, kind: kind }, geometry: { type: 'Polygon', coordinates: [pts] } };
}
function heatKey(o) {
  if (!o) return 'unknown';
  const nullish = v => v === null || v === undefined;
  const g = nullish(o.fuel_95_status) ? null : o.fuel_95_status;
  const p = nullish(o.fuel_92_status) ? null : o.fuel_92_status;
  const d = nullish(o.diesel_status) ? null : o.diesel_status;

  // Если вообще нет никаких данных по всем трем видам — станцию не рисуем (серая)
  if (g === null && p === null && d === null) return 'unknown';

  // Считаем, сколько видов топлива подтверждено (true)
  let count = 0;
  if (g === true) count++;
  if (p === true) count++;
  if (d === true) count++;

  // Всё топливо есть (3 вида) — зеленый
  if (count === 3) return 'full';     
  
  // Два любых вида есть — бирюзовый
  if (count === 2) return 'partial';  
  
  // Один вид или пусто — красный (дефицит)
  return 'no';                        
}

function renderMap() {
  if (!mapObj || !zoneReady) return;
  for (const m of objMarkers) m.remove();
  objMarkers = [];
  clearFloatChips();
  zoneBadges = [];
  closeRing();
  closeQuick();
  const last = getLastObservations();
  const zoom = mapObj.getZoom();
  const zoomChanged = lastRenderZoom === null || Math.round(zoom) !== Math.round(lastRenderZoom);
  const fromCenters = lastClusterCenterByStation;
  const newCenters = {};
  clusterHits.length = 0;
  pinHits.length = 0;
  const feats = [];
  const items = [];
  const vb = mapObj.getBounds();
  const pad = 0.05;
  const inView = st => Number(st.lat) >= vb.getSouth() - pad && Number(st.lat) <= vb.getNorth() + pad && Number(st.lon) >= vb.getWest() - pad && Number(st.lon) <= vb.getEast() + pad;
  for (const st of allStations) {
    const id = st.id;
    if (!Number.isFinite(Number(st.lat)) || !inView(st)) continue;
    items.push({ st: st, o: last[id] });
    const sc = demandOf(id);
    // зона спроса видна с z >= 12: вдали — мягкое дышащее кольцо-подсказка
    // вокруг кластера, с z >= 13 (пины) — ярче и чётче вокруг каждой капли
    if (!heatMode && sc >= 12 && zoom >= 12) {
      const seed = seedOf(id);
      const R = 100 + sc * 6;
      const col = 'rgb(' + demandRgb(sc) + ')';
      feats.push(blobFeature(Number(st.lat), Number(st.lon), R, col, seed, 'halo', 1.25));
      feats.push(blobFeature(Number(st.lat), Number(st.lon), R, col, seed, 'main', 1));
      feats.push(blobFeature(Number(st.lat), Number(st.lon), R, col, seed, 'core', 0.55));
    }
    // иконка очереди живёт на всех зумах зоны: вдали — в центре круга,
    // с приближением плавно уменьшается и уезжает в левый нижний угол под пин
    if (!heatMode && sc >= 12 && zoom >= 12) {
      const elZ = document.createElement('div');
      elZ.className = 'mzone-ico';
      elZ.style.zIndex = '1';
      elZ.innerHTML = '<div class="mzone-badge" style="color:rgb(' + demandRgb(sc) + ')"><svg class="ic"><use href="#i-queue"/></svg></div>';
      const mkZ = new maplibregl.Marker({ element: elZ, anchor: 'center' }).setLngLat([Number(st.lon), Number(st.lat)]).addTo(mapObj);
      zoneBadges.push(elZ.firstElementChild);
      applyZoneBadgeZoom(elZ.firstElementChild);
      objMarkers.push(mkZ);
    }
  }
  // точки для тепловой карты наличия топлива: берём статус АИ-95 каждой станции
  // (источник приоритетнее, при молчании — народный консенсус) и кладём в отдельный слой
      const fuelFeats = [];
  for (const st of allStations) {
    if (!Number.isFinite(Number(st.lat)) || !Number.isFinite(Number(st.lon))) continue;
    const o = last[st.id];
    
    let state = heatKey(o);
    if (state === 'unknown') {
      const fp = folkPinState(st.id, o);
      if (fp) state = fp;
    }
    if (state === 'unknown') continue;
    
    const stale = !obsFresh(o);
    
    if (state === 'full') {
      fuelFeats.push({ type: 'Feature', properties: { cls: stale ? 'calm-old' : 'calm', w: 1 }, geometry: { type: 'Point', coordinates: [Number(st.lon), Number(st.lat)] } });
    } else if (state === 'yes' || state === 'partial' || state === 'part' || state === 'diesel') {
      fuelFeats.push({ type: 'Feature', properties: { cls: stale ? 'partial-old' : 'partial', w: 0.8 }, geometry: { type: 'Point', coordinates: [Number(st.lon), Number(st.lat)] } });
    } else {
      let hotW = 0;
      if (state === 'no') hotW = 1.0;
      else if (state === 'conflict') hotW = 0.4;
      if (o && o.queue_level === 'high') hotW += 0.15;
      if (hotW > 0) {
        fuelFeats.push({ type: 'Feature', properties: { cls: stale ? 'hot-old' : 'hot', w: hotW }, geometry: { type: 'Point', coordinates: [Number(st.lon), Number(st.lat)] } });
      }
    }
  }
  const fhSrc = mapObj.getSource('fuelheat');
  if (fhSrc) fhSrc.setData({ type: 'FeatureCollection', features: fuelFeats });
  if (routeFeature) feats.push(routeFeature);
  mapObj.getSource('zones').setData({ type: 'FeatureCollection', features: feats });
  if (heatMode) {
    // режим «Тепло»: кластеры и пины не рисуем — тепловой слой главный герой
  } else if (zoom < 13) {
    // свои кластеры: сетка ~70px текущего зума
    // сетка на мировых координатах (не экранных): кластеры не
    // перегруппировываются от панов, только от смены зума
    const zc = Math.round(zoom);
    const size = 256 * Math.pow(2, zc);
    const worldPx = (lon, lat) => {
      const latRad = lat * Math.PI / 180;
      return {
        x: (lon + 180) / 360 * size,
        y: (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * size
      };
    };
    // кластеры считаем по ВСЕМ станциям, а не только по видимым: иначе при
    // панораме станции входят/выходят из кадра и квадраты меняют цифру и центр
    const cells = {};
    for (const st of allStations) {
      if (!Number.isFinite(Number(st.lat))) continue;
      const p = worldPx(Number(st.lon), Number(st.lat));
      const key = Math.floor(p.x / 70) + ':' + Math.floor(p.y / 70);
      (cells[key] = cells[key] || []).push({ st: st, o: last[st.id] });
    }
    for (const key of Object.keys(cells)) {
      const group = cells[key];
      // кластер рисуем, только если его центр в кадре: состав и центр теперь
      // не зависят от панорамы — квадраты не прыгают и цифры не меняются
      const cn = group.length;
      const clon0 = group.reduce((s, it) => s + Number(it.st.lon), 0) / cn;
      const clat0 = group.reduce((s, it) => s + Number(it.st.lat), 0) / cn;
      if (clon0 < vb.getWest() - pad || clon0 > vb.getEast() + pad || clat0 < vb.getSouth() - pad || clat0 > vb.getNorth() + pad) continue;
      if (group.length === 1) { newCenters[group[0].st.id] = [Number(group[0].st.lon), Number(group[0].st.lat)]; addPin(group[0], null, zoomChanged); continue; }
      // полоса кластера — те же цвета, что и пины: зелёный = АИ-95 есть,
      // оранжевый = есть 92, светло-синий = только дизель,
      // красный = ничего, серый = нет данных
      const cnt = { yes: 0, part: 0, diesel: 0, no: 0, conflict: 0, unknown: 0 };
      for (const it of group) cnt[effPinKey(it.st, it.o)]++;
      // кластер тусклый, если половина и больше станций с топливным сигналом
      // держатся на старых отметках источника
      let sig = 0, staleSig = 0;
      for (const it of group) {
        if (effPinKey(it.st, it.o) !== 'unknown') sig++;
        if (pinKey(it.o) !== 'unknown' && !obsFresh(it.o)) staleSig++;
      }
      const clStale = sig > 0 && staleSig * 2 >= sig;
      const n = group.length;
      const CLUSTER_COLS = { yes: '#1bb978', part: '#f5a05a', diesel: '#6ea8ff', no: '#ef5350', conflict: '#f5a05a', unknown: '#a7b1c1' };
      const stops = [];
      let acc = 0;
      for (const k of ['yes', 'part', 'diesel', 'no', 'conflict', 'unknown']) {
        if (!cnt[k]) continue;
        const from = acc;
        acc += 100 * cnt[k] / n;
        stops.push(CLUSTER_COLS[k] + ' ' + from.toFixed(1) + '% ' + acc.toFixed(1) + '%');
      }
      const clon = group.reduce((s, it) => s + Number(it.st.lon), 0) / n;
      const clat = group.reduce((s, it) => s + Number(it.st.lat), 0) / n;
      clusterHits.push({ lon: clon, lat: clat });
      const wrapC = document.createElement('div');
      wrapC.style.zIndex = '2';
      const el = document.createElement('div');
      el.className = 'mcluster' + (clStale ? ' stale' : '');
      el.innerHTML = '<span>' + n + '</span><i style="background:linear-gradient(90deg,' + stops.join(', ') + ')"></i>';
      if (zoomChanged) el.style.animation = 'mPopBox .3s ease';
      wrapC.appendChild(el);
      const mkC = new maplibregl.Marker({ element: wrapC, anchor: 'center' }).setLngLat([clon, clat]).addTo(mapObj);
      objMarkers.push(mkC);
      for (const m of group) newCenters[m.st.id] = [clon, clat];
    }
  } else {
    // чипы вытекают вправо от капли: запрещаем их пину, если справа на той же
    // горизонтальной линии (±34px) есть ещё капля, либо у правого края карты
    // нет 150px места — иначе чипы накроют соседа / обрежутся краем = каша
    const cw = mapObj.getContainer().clientWidth;
    const pts = items.map(it => { const p = mapObj.project([Number(it.st.lon), Number(it.st.lat)]); return { id: it.st.id, x: p.x, y: p.y }; });
    const blocked = new Set();
    for (const a of pts) {
      if (a.x > cw - 150) { blocked.add(a.id); continue; }
      for (const b of pts) {
        if (a.id === b.id) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx > -12 && dx < 190 && Math.abs(dy) <= 34) { blocked.add(a.id); break; }
      }
    }
    for (const it of items) addPin(it, fromCenters[it.st.id] || null, zoomChanged, blocked.has(it.st.id));
  }
  lastClusterCenterByStation = newCenters;
  lastRenderZoom = zoom;
  updateMapPlate();
}
function closeRing() {
  if (activeRing) {
    const wrapEl = activeRing.parentNode;
    if (wrapEl) {
      wrapEl.removeChild(activeRing);
      if (!wrapEl.querySelector('.mquick')) {
        const pn = wrapEl.querySelector('.mpin-name');
        if (pn) { pn.classList.remove('on'); pn.classList.remove('ring'); }
      }
    }
  }
  activeRing = null;
}
function toggleFavoriteById(id) {
  let favs = getFavorites();
  if (favs.includes(id)) favs = favs.filter(x => x !== id);
  else { favs.push(id); track('fav_add', null, id); maybeTgOffer(id); }
  localStorage.setItem('favorites', JSON.stringify(favs));
  syncFavorites();
  refreshTgButton(id);
}
// меню действий вокруг капли (стиль The Sims): три синих чипа
// слева / справа / снизу на равных расстояниях от капли
function openRing(st, wrap) {
  closeRing();
  closeQuick();
  const fc = wrap.querySelector('.fchips');
  if (fc) fc.style.display = 'none';
  const pn = wrap.querySelector('.mpin-name');
  if (pn) { pn.classList.add('on'); pn.classList.add('ring'); }
  const ring = document.createElement('div');
  ring.className = 'mring';
  // кольцо вешаем на каплю сразу: кнопкам нужно быть в DOM,
  // чтобы измерить свою реальную ширину и встать симметрично
  wrap.appendChild(ring);
  const fav = isFavorite(st.id);
  const actions = [
    { icon: 'i-heart', label: fav ? 'Убрать из избранного' : 'В избранное', side: 'left', dy: -2, run: () => { toggleFavoriteById(st.id); closeRing(); } },
    { icon: 'i-truck', label: 'Построить маршрут', side: 'top', dy: -52, cls: 'route', run: () => { closeRing(); drawRouteTo(st); } },
    { icon: 'i-check', label: 'Отметка', side: 'bottom', dy: 52, run: () => { closeRing(); openQuick(st, wrap); } },
    { icon: 'i-pump', label: 'Карточка АЗС', side: 'right', dy: -2, run: () => { closeRing(); sheetFromMap = true; openSheet(st.id); } }
  ];
  for (const a of actions) {
    const b = document.createElement('button');
    if (a.cls) b.classList.add(a.cls);
    b.style.top = a.dy + 'px';
    b.innerHTML = icon(a.icon, 'ic-s') + a.label;
    ring.appendChild(b);
    // боковые чипы отстоят от капли внутренним краем на равные 12px:
    // длина подписи больше не сдвигает композицию вправо/влево
    const w = b.offsetWidth;
    const gap = 28;
    b.style.left = (a.side === 'left' ? -(gap + w / 2) : a.side === 'right' ? (gap + w / 2) : 0) + 'px';
    // жест начинается на чипе: не отдаём его ни карте, ни пину
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('pointerup', e => e.stopPropagation());
    b.addEventListener('click', e => { e.stopPropagation(); a.run(); });
  }
  activeRing = ring;
}
// быстрая отметка: пузырь «перетекает» из капли с чипами из карточки,
// сама карточка АЗС не открывается (для неё есть действие «Карточка АЗС»)
function closeQuick() {
  if (activeQuick) {
    const wrapEl = activeQuick.wrap;
    if (wrapEl && wrapEl.dataset.z !== undefined) wrapEl.style.zIndex = wrapEl.dataset.z;
    if (activeQuick.el && activeQuick.el.parentNode) activeQuick.el.parentNode.removeChild(activeQuick.el);
    if (wrapEl && !wrapEl.querySelector('.mring')) {
      const pn = wrapEl.querySelector('.mpin-name');
      if (pn) { pn.classList.remove('on'); pn.classList.remove('ring'); }
    }
  }
  activeQuick = null;
}
function quickChipsHtml() {
  return '<div class="fb-group"><div class="fb-gl">Топливо есть</div><div class="feedback-grid g3">' +
    ['92','95','diesel'].map(f => '<button class="feedback-option" data-fact="yes" data-fuel="' + f + '" onclick="fbToggle(this)">' + fuelLabel(f) + '</button>').join('') + '</div></div>' +
    '<div class="fb-group"><div class="fb-gl">Топлива нет</div><div class="feedback-grid g3">' +
    ['92','95','diesel'].map(f => '<button class="feedback-option" data-fact="no" data-fuel="' + f + '" onclick="fbToggle(this)">' + fuelLabel(f) + '</button>').join('') + '</div></div>' +
    '<div class="fb-group"><div class="fb-gl">Очередь</div><div class="feedback-grid g4">' +
    ['small','medium','large','huge'].map(q => '<button class="feedback-option" data-fact="queue" data-queue="' + q + '" onclick="fbToggle(this)">' + (q === 'small' ? '2–3' : q === 'medium' ? '4–6' : q === 'large' ? '7+' : '100+') + '</button>').join('') + '</div></div>' +
    '<div class="fb-group"><div class="fb-gl">Живая очередь</div><div class="feedback-grid">' +
    '<button class="feedback-option" data-fact="inqueue" onclick="fbToggle(this)">' + icon('i-queue','ic-s') + 'Я стою в очереди сейчас</button></div></div>' +
    '<div class="fb-group"><div class="fb-gl">Ещё</div><div class="feedback-grid g3">' +
    '<button class="feedback-option" data-fact="delivery" onclick="fbToggle(this)">' + icon('i-truck','ic-s') + 'Привезли</button>' +
    '<button class="feedback-option" data-fact="free" onclick="fbToggle(this)">' + icon('i-check','ic-s') + 'Свободно</button></div></div>';
}
function openQuick(st, wrap) {
  closeQuick();
  closeRing();
  shadowClose();
  const el = document.createElement('div');
  el.className = 'mquick';
  el.innerHTML = '<div class="feedback-panel open" id="quick-' + st.id + '">' + quickChipsHtml() +
    '<button class="fb-send" onclick="quickSend(\'' + st.id + '\')">Отправить отметку</button></div>';
  el.addEventListener('pointerdown', e => e.stopPropagation());
  el.addEventListener('pointerup', e => e.stopPropagation());
  const pn = wrap.querySelector('.mpin-name');
  if (pn) pn.classList.add('on');
  // пузырь открывается центром карты: ширина/высота учтены через
  // max-width/max-height + внутренний скролл — виден целиком при любом пине
  const host = document.getElementById('mapWrap') || document.getElementById('mapBox') || wrap;
  host.appendChild(el);
  activeQuick = { el: el, wrap: wrap };
}
async function quickSend(stationId) {
  const panel = document.getElementById('quick-' + stationId);
  if (!panel) return;
  const sendBtn = panel.querySelector('.fb-send');
  if (sendBtn && sendBtn.disabled) return; // двойной тап не должен слать пакет дважды
  if (sendBtn) sendBtn.disabled = true;
  const rows = [];
  panel.querySelectorAll('.feedback-option.selected').forEach(b => {
    const fact = b.dataset.fact;
    const base = { feedback_type: null, fuel_type: null, queue_size: null, comment_text: null };
    if (fact === 'yes') Object.assign(base, { feedback_type: 'available', fuel_type: b.dataset.fuel });
    else if (fact === 'no') Object.assign(base, { feedback_type: 'unavailable', fuel_type: b.dataset.fuel });
    else if (fact === 'queue') Object.assign(base, { feedback_type: 'queue', queue_size: b.dataset.queue });
    else if (fact === 'delivery') Object.assign(base, { feedback_type: 'delivery' });
    else if (fact === 'free') Object.assign(base, { feedback_type: 'free' });
    else if (fact === 'inqueue') Object.assign(base, { feedback_type: 'in_queue' });
    rows.push(base);
  });
  if (!rows.length) { alert('Выберите хотя бы один факт.'); if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = sendBtnOrigText; } return; }
  const key = 'fb_' + stationId;
  const history = JSON.parse(localStorage.getItem(key) || '[]');
  const now = Date.now();
  if (history.filter(t => now - t < 30 * 60 * 1000).length >= 3) { alert('Слишком много отметок. Попробуйте через полчаса.'); if (sendBtn) sendBtn.disabled = false; return; }
  const onSite = await onSiteFields(allStations.find(s => s.id === stationId));
  rows.forEach(r => { r.station_id = stationId; r.device_id = deviceId; Object.assign(r, onSite); });
let qok = true;
  try { await dbInsert('user_feedback', rows); } catch (e) { qok = false; }
  if (!qok) {
    queueFeedbackLocally(rows);
    history.push(now);
    localStorage.setItem(key, JSON.stringify(history));
    rows.forEach(r => allFeedback.unshift(Object.assign({ created_at: new Date().toISOString() }, r)));
    bumpContrib();
    const saved = document.getElementById('quick-' + stationId);
    if (saved) saved.innerHTML = '<div class="q-thanks">Нет связи — отметка сохранена<small>уйдёт автоматически, когда связь вернётся</small></div>';
    setTimeout(closeQuick, 1600);
    return;
  }
  history.push(now);
  localStorage.setItem(key, JSON.stringify(history));
  rows.forEach(r => allFeedback.unshift(Object.assign({ created_at: new Date().toISOString() }, r)));
  track('feedback_submit');
  bumpContrib();
  maybePollSoon(2000);
  // подтверждение прямо в пузыре: спасибо + счётчик фактов, затем автозакрытие
  const done = document.getElementById('quick-' + stationId);
  if (done) done.innerHTML = '<div class="q-thanks">Спасибо за вашу отметку 🙏<small>' + rows.length + ' факт(ов) учтено</small></div>';
  setTimeout(closeQuick, 1200);
}
function addPin(it, fromCenter, zoomChanged, chipsBlocked) {
  const st = it.st, o = it.o;
  pinHits.push({ lon: Number(st.lon), lat: Number(st.lat) });
  let stKey = pinKey(o);
  // источник молчит обо всех топливах — смотрим народный консенсус
  const srcSilent = !o || (o.fuel_92_status == null && o.fuel_95_status == null && o.diesel_status == null);
  const fcons = srcSilent ? { '92': folkConsensus(st.id, '92'), '95': folkConsensus(st.id, '95'), 'diesel': folkConsensus(st.id, 'diesel') } : null;
  if (stKey === 'unknown' && fcons) {
    const v = f => fcons[f] ? fcons[f].verdict : null;
    if (v('95') === 'yes') stKey = 'yes';
    else if (v('92') === 'yes') stKey = 'part';
    else if (v('diesel') === 'yes') stKey = 'diesel';
    else if (v('95') === 'conflict' || v('92') === 'conflict' || v('diesel') === 'conflict') stKey = 'conflict';
    else if (v('95') === 'no' || v('92') === 'no' || v('diesel') === 'no') stKey = 'no';
  }
  const sc = demandOf(st.id);
  const wrap = document.createElement('div');
  // пин тусклый (вместе с табличкой и чипами), если его цвет — отметка источника старше 6 часов
  wrap.className = 'mpin-wrap' + (!srcSilent && !obsFresh(o) ? ' stale' : '');
  // приоритет наложения: пин с топливом выше пустого, пустой выше серого
  wrap.style.zIndex = String({ unknown: 3, no: 4, conflict: 5, diesel: 5, part: 6, yes: 7 }[stKey] || 3);
  // пин двух/трёх цветов: градиент от кончика капли вверх в порядке
  // дизель (синий) 	 АИ-92 (оранжевый) 	 АИ-95 (зелёный);
  // направление to top right в локальных координатах капли = снизу вверх на экране
  const availCols = [];
  if (srcSilent && fcons) {
    if (fcons.diesel && fcons.diesel.verdict === 'yes') availCols.push('#6ea8ff');
    if (fcons['92'] && fcons['92'].verdict === 'yes') availCols.push('#f5a05a');
    if (fcons['95'] && fcons['95'].verdict === 'yes') availCols.push('#1bb978');
  } else if (o) {
    if (o.diesel_status === true) availCols.push('#6ea8ff');
    if (o.fuel_92_status === true) availCols.push('#f5a05a');
    if (o.fuel_95_status === true) availCols.push('#1bb978');
  }
  let pinStyle = '';
  if (availCols.length >= 2) {
    const stops = availCols.length === 2
      ? availCols[0] + ', ' + availCols[1]
      : availCols[0] + ', ' + availCols[1] + ' 50%, ' + availCols[2];
    pinStyle = 'background:linear-gradient(to top right,' + stops + ');border-color:#fff;color:#fff;';
  }
  const pinIco = stKey === 'conflict' ? '<span class="qmark">?</span>' : '<svg class="ic"><use href="#i-pump"/></svg>';
  const lqBadge = liveQueueCount(st.id);
  wrap.innerHTML = '<div class="mpin ' + stKey + '" style="' + pinStyle + '">' + pinIco + (lqBadge ? '<i class="qdot liveq">' + lqBadge + '</i>' : (o && o.queue_level === 'high' ? '<i class="qdot"></i>' : '')) + '</div>';
  // табличка над пином: название жирным с иконкой бренда слева, улица обычным
  const nameEl = document.createElement('div');
  nameEl.className = 'mpin-name';
  nameEl.innerHTML = '<b><span class="mpin-logo">' + stationLogo(st) + '</span>' + escapeHtml(st.name || 'АЗС') + '</b><span>' + escapeHtml(st.address || '') + '</span>';
  wrap.appendChild(nameEl);
  const mk = new maplibregl.Marker({ element: wrap, anchor: 'bottom' }).setLngLat([Number(st.lon), Number(st.lat)]).addTo(mapObj);
  // тап через pointer-события: мобильная карта съедает синтетический click
  let downX = 0, downY = 0, downT = 0, tapped = false;
  wrap.addEventListener('pointerdown', e => { e.stopPropagation(); downX = e.clientX; downY = e.clientY; downT = Date.now(); tapped = false; }, { passive: true });
  wrap.addEventListener('pointerup', e => {
    if (Math.abs(e.clientX - downX) <= 16 && Math.abs(e.clientY - downY) <= 16 && Date.now() - downT <= 700) {
      tapped = true;
      if (activeRing && activeRing.parentNode === wrap) closeRing();
      else openRing(st, wrap);
    }
  }, { passive: true });
  mk.on('click', e => {
    if (tapped) { tapped = false; return; }
    if (e && e.originalEvent) e.originalEvent.stopPropagation();
    if (activeRing && activeRing.parentNode === wrap) closeRing();
    else openRing(st, wrap);
  });
  objMarkers.push(mk);
  // воздушные чипы топлива справа от капли (zoom >= 13): вытекают вправо по
  // очереди, цикл проходит дважды и затухает; при движении карты убираются сразу
  if (mapObj.getZoom() >= 13 && !chipsBlocked) {
    const avail = [];
    let fuelInfo = 0;
    const srcFuels = [['92', 'АИ-92', o ? o.fuel_92_status : null], ['95', 'АИ-95', o ? o.fuel_95_status : null], ['diesel', 'дизель', o ? o.diesel_status : null]];
    for (const s of srcFuels) if (s[2] === true) { avail.push({ t: s[1], q: 0, k: s[0] }); fuelInfo++; }
    // источник по топливу молчит — показываем народный консенсус (2 голоса — рано, 3 — подтверждён)
    for (const s of srcFuels) if (s[2] === null || s[2] === undefined) {
      const c = folkCounts(st.id, s[0]);
      const v = folkVerdict(c);
      if (v && v.verdict === 'yes') { avail.push({ t: s[1] + (v.strong ? '   народ подтвердил: ' + v.votes : '   народ: ' + v.votes + ' мнения') + (v.onSite ? '   📍' + v.onSite : ''), q: 0, k: s[0] }); fuelInfo++; }
      else if (v && v.verdict === 'no') { avail.push({ t: s[1] + ' нет   народ: ' + v.votes, q: -2, k: s[0] }); fuelInfo++; }
      else if (v && v.verdict === 'conflict') { avail.push({ t: s[1] + '   разные мнения', q: -3, k: s[0] }); fuelInfo++; }
      else if (c && c.yes === 1 && c.no === 0) { avail.push({ t: s[1] + '   народ', q: 0, k: s[0] }); fuelInfo++; }
    }
    // очередь: уровень по силе спроса + сколько стоит + сколько машин народно
    if (sc >= 12) {
      const mark = lastQueueMark(st.id);
      const cars = mark && mark.size ? '   ' + (QUEUE_SHORT[mark.size] || '') + ' машин' : '';
      const ageS = ageRu(queueAgeMin(st.id));
      const lbl = sc >= 50 ? 'очередь огромная' : sc >= 30 ? 'очередь терпимая' : 'очередь малая';
      avail.push({ t: lbl + (ageS ? '   ' + ageS : '') + cars, q: sc >= 50 ? 3 : sc >= 30 ? 2 : 1 });
    }
    // живая очередь: люди стоят ПРЯМО СЕЙЧАС — самый свежий сигнал
    const lq = liveQueueCount(st.id);
    if (lq) avail.push({ t: lq + ' вод. в очереди сейчас', q: 3 });
    // ни источника, ни народа по топливу — честно подписываем молчание
    if (!fuelInfo) avail.push({ t: 'топливо: источник молчит', q: -1 });
    if (avail.length) {
      const box = document.createElement('div');
      box.className = 'fchips';
      avail.forEach((item, i) => {
        const c = document.createElement('div');
        c.className = 'fchip' + (item.q === 3 ? ' fchip-q' : item.q === 2 ? ' fchip-q2' : item.q === 1 ? ' fchip-q1' : item.q === -1 ? ' fchip-x' : item.q === -2 ? ' fchip-no' : item.q === -3 ? ' fchip-conflict' : item.k === 'diesel' ? ' fchip-dt' : item.k === '92' ? ' fchip-92' : '');
        c.style.animationDelay = (0.25 + i * 0.45) + 's';
        c.textContent = item.t;
        box.appendChild(c);
      });
      wrap.appendChild(box);
      floatChips.push(box);
      // на время жизни чипов пин с ними выше соседних пинов (z 8 против 3–7),
      // иначе плашки уходят под чужие капли; через 6.5с возвращаем базовый z
      const baseZ = wrap.style.zIndex;
      wrap.style.zIndex = '8';
      setTimeout(() => {
        if (!wrap.querySelector('.mquick') && !wrap.querySelector('.mring')) wrap.style.zIndex = baseZ;
      }, 6500);
    }
  }
  // плавный «разлёт»: пина стартует из центра своего кластера
  // и за 0.5с доезжает до своей точки; трансформ маркера не трогаем
  const inner = wrap.firstElementChild;
  if (fromCenter) {
    const p1 = mapObj.project(fromCenter);
    const p2 = mapObj.project([Number(st.lon), Number(st.lat)]);
    const dx = p1.x - p2.x, dy = p1.y - p2.y;
    if (Math.hypot(dx, dy) > 6) {
      inner.style.transition = 'none';
      inner.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(-45deg) scale(.55)';
      inner.style.opacity = '.35';
      void inner.offsetWidth;
      inner.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1), opacity .35s ease';
      inner.style.transform = 'translate(0px,0px) rotate(-45deg) scale(1)';
      inner.style.opacity = '1';
      return;
    }
  }
  if (zoomChanged) inner.style.animation = 'mPopPin .3s ease';
}
function updateMapPlate() {
  const el = document.getElementById('mapPlate');
  if (!el) return;
  const last = getLastObservations();
  let known = 0, avail = 0, qn = 0, knownAny = 0;
  const citySet = new Set(cityStationList().map(s => s.id));
  for (const id of citySet) {
    const o = last[id];
    if (!o) continue;
    if (o.fuel_95_status === true) { avail++; known++; }
    else if (o.fuel_95_status === false) known++;
    if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) knownAny++;
    else if (o.fuel_92_status !== null && o.fuel_92_status !== undefined) knownAny++;
    else if (o.diesel_status !== null && o.diesel_status !== undefined) knownAny++;
    if (o.queue_level === 'high') qn++;
  }
  const pc = peakAndCalm();
  el.innerHTML =
    '<span class="gp gp-btn why-tap" onclick="openWhyChip(this,\'plate95\')"><i class="dot ' + (known && avail / known >= 0.5 ? 'green' : 'red') + '"></i>АИ-95: ' + (known ? avail + '/' + known : 'нет данных') + '</span>' +
    '<span class="gp gp-btn why-tap" onclick="openWhyChip(this,\'plateQ\')"><i class="dot ' + (qn ? 'red' : 'green') + '"></i>очереди: ' + qn + '</span>' +
    '<span class="gp gp-btn why-tap" onclick="openWhyChip(this,\'platePeak\')">' + icon('i-chart', 'ic-s') + 'пик ' + pc.peak + '</span>' +
    '<span class="gp gp-btn" id="covChip" onclick="toggleCovPop()">' + icon('i-pump', 'ic-s') + 'топливо видно: ' + knownAny + ' из ' + citySet.size + ' АЗС' + covSpark() + '</span>' +
    '<span class="gp gp-btn why-tap" onclick="openWhyChip(this,\'wavePlate\')">' + icon('i-chart', 'ic-s') + 'соседи: ' + (lastWaveStats ? waveSummaryLine(lastWaveStats) : 'нет данных') + '</span>';
}
// мини-график покрытия за 24 ч: сколько станций источник видел в каждый час
function covSpark() {
  const rows = fuelHourly.slice(-24);
  const vals = rows.map(r => Number(r.knownany || 0));
  if (vals.length < 2) return '';
  const W = 36, H = 12;
  const max = Math.max(1, ...vals);
  const d = vals.map((v, i) => (i ? 'L' : 'M') + (i / (vals.length - 1) * W).toFixed(1) + ',' + (H - 1 - (v / max) * (H - 2)).toFixed(1)).join('');
  return '<svg class="cov-spark" viewBox="0 0 ' + W + ' ' + H + '"><path d="' + d + '" fill="none" stroke="#397cff" stroke-width="1.4" stroke-linecap="round"/></svg>';
}
function closeCovPop() {
  const pop = document.getElementById('covPop');
  if (pop) pop.classList.remove('open');
}
function toggleCovPop() {
  const pop = document.getElementById('covPop');
  if (!pop) return;
  if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
  const last = getLastObservations();
  const rows = [];
  const citySet = new Set(cityStationList().map(s => s.id));
  for (const id of citySet) {
    const o = last[id];
    if (!o) continue;
    const vis = (o.fuel_92_status !== null && o.fuel_92_status !== undefined) ||
                (o.fuel_95_status !== null && o.fuel_95_status !== undefined) ||
                (o.diesel_status !== null && o.diesel_status !== undefined);
    if (!vis) continue;
    const st = allStations.find(s => s.id === id);
    if (st) rows.push({ st: st, o: o });
  }
  const dot = v => '<i class="cov-dot" style="background:' + (v === true ? '#1bb978' : v === false ? '#ef5350' : '#a7b1c1') + '"></i>';
  pop.innerHTML = '<div class="recent" style="margin:2px 6px 4px">Источник видит сейчас эти АЗС   точки: АИ-92   АИ-95   дизель</div>' +
    (rows.length ? rows.map(r =>
      '<button class="cov-row" onclick="flyToStation(\'' + r.st.id + '\')">' +
      '<span style="min-width:0"><b>' + escapeHtml(r.st.name || 'АЗС') + '</b><small>' + escapeHtml(r.st.address || '') + '</small></span>' +
      '<span class="cov-fuels">' + dot(r.o.fuel_92_status) + dot(r.o.fuel_95_status) + dot(r.o.diesel_status) + '</span>' +
      '</button>').join('')
    : '<div class="recent" style="margin:4px 6px">Сейчас источник не видит ни одну АЗС города.</div>');
  const plate = document.getElementById('mapPlate');
  if (plate) pop.style.top = (plate.offsetHeight + 14) + 'px';
  pop.classList.add('open');
}
function flyToStation(id) {
  const st = allStations.find(s => s.id === id);
  if (!st || !mapObj) return;
  closeCovPop();
  mapObj.stop();
  mapObj.easeTo({ center: [Number(st.lon), Number(st.lat)], zoom: 15, duration: 900 });
}
// === Фоновый добор дыр: что не пришло на первой загрузке — добираем по одному,
// без перезагрузки страницы и без повторной качки хороших кусков. Глобал
// перезаписывается ТОЛЬКО когда повтор успешен. Разброс по времени + одно
// соединение за раз = не усиливаем лавину при перегрузе базы. ===
let pendingPreds = [], verifiedPreds = [];
let LOAD_DEFS = [], pendingLoads = [], drainTimer = null, drainBusy = false, softTimer = null;
function softRefresh() {
  // перерисовываем панели, потребляющие добранные данные; дебаунс, чтобы
  // несколько удачных доборов подряд не дёргали тяжёлую карту много раз
  if (softTimer) clearTimeout(softTimer);
  softTimer = setTimeout(() => {
    softTimer = null;
    if (!allStations.length) return; // куски доехали раньше станций — не мигаем пустым списком
    try {
      renderStations(cityStationList()); // тянет renderNow -> hero/чипы/мини-карта/точность/плашка
      renderHeat();
      if (mapObj && zoneReady) renderMap();
      renderAccuracy();
      lastWaveStats = allWaveEvents.length ? cityWaveStats() : null;
      renderWave();
      saveCache();
    } catch (e) { console.log('softRefresh: ' + e.message); }
  }, 600);
}
function scheduleDrainAgain(base) {
  if (drainTimer) return;
  const ms = (base == null) ? (4000 + Math.random() * 5000) : base;
  drainTimer = setTimeout(drainPendingLoads, ms);
}
function drainPendingLoads() {
  drainTimer = null;
  if (drainBusy) { scheduleDrainAgain(); return; }
  // не лезем, пока идёт полная загрузка/офлайн-режим/вкладка спит —
  // там дыры чинит полный путь (manualRefresh / start), а не мелкий добор
  if (offlineMode || refreshing || startRunning || document.visibilityState !== 'visible') { scheduleDrainAgain(); return; }
  if (!pendingLoads.length) return;
  const i = pendingLoads[0];
  const d = LOAD_DEFS[i];
  if (!d) { pendingLoads.shift(); scheduleDrainAgain(); return; }
  drainBusy = true;
  const p = d.all ? dbQueryAll(d.path, d.orderCol) : dbQuery(d.path);
  p.then(rows => {
    drainBusy = false;
    try { d.set(rows); } catch (e) {}
    pendingLoads.shift();
    d._tries = 0;
    softRefresh();
    scheduleDrainAgain(1500 + Math.random() * 2000); // следующий дырявый кусок — с небольшим зазором
  }).catch(err => {
    drainBusy = false;
    const msg = String((err && err.message) || '');
    // преходящее (сеть/обрыв/перегруз 429/5xx) — крутим в хвост и пробуем ещё;
    // постоянное (4xx не-429, битый запрос) — не долбим, убираем из очереди
    const transient = (err && err.overload) || /abort|failed to fetch|network|load failed|http 429|http 5\d\d/i.test(msg);
    d._tries = (d._tries || 0) + 1;
    if (!transient || d._tries >= 8) pendingLoads.shift();
    else pendingLoads.push(pendingLoads.shift()); // в хвост: дать другим кускам шанс
    scheduleDrainAgain(4000 + Math.random() * 5000);
  });
}
// Первый осмысленный экран: приехали станции + последние отметки —
// прячем каплю и показываем список/матрицу; остальное дойдёт фоном.
let firstPaintDone = false;
function firstPaint() {
  if (firstPaintDone || bootOver) return;
  if (!allStations.length || !Object.keys(allLastObs).length) return;
  firstPaintDone = true;
  bootDataOk = true;
  try { renderStations(cityStationList()); renderHeat(); } catch (e) {}
  bootDone();
}
async function start() {
  const app = document.getElementById('app');
  offlineMode = false;
  if (!refreshing) {
    document.body.classList.remove('offline');
    const ob = document.getElementById('offlineBar');
    if (ob) ob.classList.remove('on');
  }
  // цены меняются медленно: прогреваем известное из кэша ДО загрузки, чтобы
  // упавший в этом заходе ценовой запрос не стирал цену в «нет данных» (дрожание)
  if (!refreshing) {
    try { const cc = loadCache(); if (cc) { if (cc.lastPrice) allLastPrice = cc.lastPrice; if (cc.priceHourly) priceHourly = cc.priceHourly; } } catch (e) {}
  }
  // Первый осмысленный экран: станции + последние отметки доехали — прячем
  // каплю и показываем список/матрицу; остальное добирается фоном.
  let firstPaintDone = false;
  const firstPaint = () => {
    if (firstPaintDone || bootOver) return;
    if (!allStations.length || !Object.keys(allLastObs).length) return;
    firstPaintDone = true;
    bootDataOk = true;
    try { renderStations(cityStationList()); renderHeat(); } catch (e) {}
    bootDone();
  };
  try {
    const stations = await dbQueryAll('/rest/v1/stations?select=id,name,brand,address,lat,lon');
    allStations = stations || [];
    bootLoadTotal = 16;
    bootReportLoad('станции');
    const ownBox = { lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.05 };
    const localIds = stations.filter(s => s.lat >= ownBox.lat1 && s.lat <= ownBox.lat2 && s.lon >= ownBox.lon1 && s.lon <= ownBox.lon2).map(s => s.id);
    localIdsGlobal = stations.map(s => s.id);
    const sinceH = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const BOOT_LOAD_LABELS = [
      'наблюдения', 'счётчики', 'прогнозы', 'прогнозы', 'события',
      'отметки', 'по часам', 'очереди', 'снимки АЗС', 'цены',
      'цены города', 'эпизоды', 'очереди 30д', 'лента 7д', 'волны'
    ];
    // описатели 15 кусков: путь + как читать + куда класть. Один источник правды
    // и для первой загрузки, и для фонового добора дыр (drainPendingLoads).
    LOAD_DEFS = [
      { all: false, path: '/rest/v1/observations?order=timestamp.desc&limit=2500&select=station_id,timestamp,fuel_92_status,fuel_95_status,diesel_status,queue_level,data_freshness_minutes,source_status,fuel_state', set: r => { allObservations = r || []; } },
      { all: true, orderCol: 'station_id', path: '/rest/v1/station_counts_snap?select=station_id,total', set: r => { allCounts = r || []; } },
      { all: true, orderCol: 'id', path: '/rest/v1/predictions?select=*&result=eq.PENDING&is_verified=eq.false&model_version=not.like.*%7Cshadow*', set: r => { pendingPreds = r || []; allPredictions = pendingPreds.concat(verifiedPreds); } },
      { all: true, orderCol: 'id', path: '/rest/v1/predictions?select=id,station_id,fuel_type,from_time,to_time,target_date,result,is_verified,error_minutes,baseline_error_minutes,verified_at,actual_restore_at,prediction_source&is_verified=eq.true&model_version=not.like.*%7Cshadow*', set: r => { verifiedPreds = r || []; allPredictions = pendingPreds.concat(verifiedPreds); } },
      { all: false, path: '/rest/v1/events?event_type=eq.fuel_restored&order=detected_at.desc&limit=1000&select=station_id,event_type,detected_at', set: r => { allEvents = r || []; } },
      { all: false, path: '/rest/v1/user_feedback?order=created_at.desc&limit=300', set: r => { allFeedback = r || []; } },
      { all: false, path: '/rest/v1/station_hourly?select=station_id,hour,total,available_95&hour=gte.' + sinceH + '&station_id=in.(' + localIds.map(i => '"' + i + '"').join(',') + ')', set: r => { allHourly = r || []; } },
      { all: true, orderCol: 'station_id', path: '/rest/v1/station_queue?select=station_id,q24,n24,q7,n7', set: r => { allQueue = r || []; queueById = {}; for (const x of allQueue) queueById[x.station_id] = x; } },
      { all: true, orderCol: 'station_id', path: '/rest/v1/station_last_obs?select=station_id,timestamp,fuel_92_status,fuel_95_status,diesel_status,queue_level,data_freshness_minutes,source_status,fuel_state', set: r => { allLastObs = {}; for (const o of (r || [])) allLastObs[o.station_id] = o; firstPaint(); renderBootLiveStations(); } },
      { all: false, path: '/rest/v1/station_last_price?select=station_id,price_92,price_95,price_diesel&station_id=in.(' + localIds.map(i => '"' + i + '"').join(',') + ')', set: r => { allLastPrice = {}; for (const x of (r || [])) allLastPrice[x.station_id] = x; } },
      { all: false, path: '/rest/v1/city_price_hourly?select=hour,p92,p95,pdt,min95,max95,n95&order=hour.desc&limit=168', set: r => { priceHourly = r || []; } },
      { all: false, path: '/rest/v1/city_queue_episodes?select=station_id,started_at,ended_at&started_at=gte.' + new Date(Date.now() - 72 * 3600 * 1000).toISOString() + '&order=started_at.desc&limit=1000', set: r => { queueEpisodes = r || []; } },
      { all: true, orderCol: 'id', path: '/rest/v1/events?event_type=in.(queue_appeared,queue_high)&detected_at=gte.' + since30 + '&select=station_id,event_type,detected_at', set: r => { allQueueEvents = r || []; } },
      { all: false, path: '/rest/v1/events?detected_at=gte.' + new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString() + '&select=station_id,event_type,detected_at,source&order=detected_at.desc&limit=3000', set: r => { allEvents7 = r || []; } },
      { all: false, path: '/rest/v1/events?event_type=in.(fuel_disappeared,fuel_restored)&detected_at=gte.' + new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString() + '&select=station_id,event_type,fuel_type,detected_at&limit=5000', set: r => { allWaveEvents = r || []; } },
      { all: false, path: '/rest/v1/score_shadow?select=station_id,fuel_type,score,evidence,events_n,comp&limit=500', set: r => { allScores = r || []; scoreMap = {}; for (const x of allScores) scoreMap[x.station_id + '|' + x.fuel_type] = x; } }
    ];
    // Все 15 летят одновременно; каждый кусок применяется сразу по приходу —
    // список оживает по мере доезда, а не когда весь конвой дотащится.
    const P = LOAD_DEFS.map((d, idx) => {
      const p = d.all ? dbQueryAll(d.path, d.orderCol) : dbQuery(d.path);
      const done = () => bootReportLoad(BOOT_LOAD_LABELS[idx] || ('запрос ' + (idx + 1)));
      p.then(rows => { try { d.set(rows); } catch (e) {} softRefresh(); done(); }).catch(() => { done(); });
      return p;
    });
    const R = await Promise.allSettled(P);
    allStations = stations || [];
    firstPaint();
    // Всегда закрываем загрузочный экран после пачки запросов
    bootDataOk = true;
    if (!bootOver) bootDone();
    pendingLoads = [];
    for (let i = 0; i < LOAD_DEFS.length; i++) {
      const r = R[i];
      if (r && r.status === 'fulfilled') LOAD_DEFS[i].set(r.value);
      else {
        pendingLoads.push(i); // дыра: доберём фоном, без перезагрузки
        // цены (9,10) при провале НЕ затираем — держим прогретое из кэша;
        // последние отметки (8) при мгновенном входе тоже НЕ затираем —
        // иначе экран обнулится до нулей, которые водитель уже видел.
        if (i !== 9 && i !== 10 && !(i === 8 && window.__cacheRendered)) LOAD_DEFS[i].set([]);
      }
    }
    saveCache(); // ранний снимок: следующий сбой сети покажет данные с плашкой, а не экран ошибки
    window.__netOk = true;
    const obNet = document.getElementById('offlineBar');
    if (obNet) { obNet.classList.remove('on'); obNet.classList.remove('catch'); }
    document.body.classList.remove('offline');
    flushFeedbackQueue();
    flushPollQueue();
    flushReportQueue();
    syncFavorites();   // довезти избранное до сервера (вдруг сердечки ставили до фичи)
    refreshTgLink();   // узнаём, подключён ли телеграм у этого устройства
    loadMyReliability(); // личная надёжность водителя из журнала свидетеля
    // повторный заход с избранным, но без Телеграма — напомнить о уведомлениях
    // (не на первом визите: сначала человек должен понять продукт)
    try {
      const vis = Number(localStorage.getItem('kbVisits') || 0) + 1;
      localStorage.setItem('kbVisits', String(vis));
      if (vis >= 2) setTimeout(() => { if (getFavorites().length) maybeTgOffer(null); }, 4000);
    } catch (e) {}
    if (!stations.length) { window.__startErr = 'Источник вернул пустой список станций'; bootDataOk = false; app.innerHTML = '<div class="status">База подключена, но в ней пока нет АЗС.</div>'; return; }
    // весь юг: список показывает все станции, сортируются позже по геолокации
    renderStations(cityStationList());
    // подписи строк тепла зависят от снимка последних отметок: первая отрисовка
    // из loadPulse может случиться раньше загрузки и нарисовать «—» — перерисовываем
    renderHeat();
    // карта греется вне критического пути: после первого экрана и в простое —
    // свайп на панель остаётся быстрым, но вход не платит за WebGL и тайлы
    setTimeout(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(() => ensureMap(), { timeout: 8000 });
      else ensureMap();
    }, 3500);
    // отложенный опрос про «Куда ехать»: если с совета прошло 45 минут — 3 суток,
    // спрашиваем, чем закончилась поездка (сразу в момент клика человек ещё не доехал)
    checkAdvicePoll();
    setTimeout(maybeAdvicePop, 900);
setTimeout(maybeWhatsNew, 2600);
renderWhatsNewPanel();
    if (pendingLoads.length) scheduleDrainAgain(2500 + Math.random() * 3000); // добрать дыры фоном, без перезагрузки
    loadAdviceReactionsForListRaw().catch(e => console.log('advice reactions: ' + e.message)); // подтянем реакции фоном
  } catch (e) {
    // Связь отвалилась: если в памяти есть снимок — показываем его с честной
    // плашкой; человек видит прежние данные и может ставить отметки.
    const c = loadCache();
    if (c) {
      applyCache(c);
      offlineMode = true;
      showOfflineBar(c.t);
      detectUserCity();
      renderStations(cityStationList());
      renderHeat();
      return;
    }
    window.__startErr = e.message;
    bootDataOk = false;
    app.innerHTML = '<div class="status">Сейчас не получилось загрузить данные.<br><small>Проверьте интернет и попробуйте ещё раз — обычно это на пару минут.</small><br><br><button class="cta-btn" style="width:auto;padding:10px 24px" onclick="retryStart()">Попробовать снова</button></div>';
    const t1 = document.getElementById('nowTitle');
    const s1 = document.getElementById('nowSub');
    if (t1) t1.textContent = 'Данные не загрузились';
    if (s1) s1.textContent = 'База данных не ответила: ' + escapeHtml(e.message);
    const hw = document.getElementById('hfWindow');
    if (hw) hw.textContent = 'Кнопка «Попробовать снова» — в окне загрузки или в списке АЗС';
    const hg = document.getElementById('heatGrid');
    if (hg) hg.innerHTML = '<div class="status" style="margin:4px 0">Тепловая матрица появится, когда данные доедут. Сейчас сеть или база не ответили.</div>';
    const tt = document.getElementById('tagText');
    if (tt) tt.textContent = 'Данные города не доехали — цифры появятся после удачной загрузки.';
  }
  // автоопределение местоположения пользователя
  if (navigator.geolocation) {
    geoRequested = true; navigator.geolocation.getCurrentPosition(position => {
const lat = position.coords.latitude, lon = position.coords.longitude;
const suspect = geoLooksSuspect(position) || jumpSuspect(lat, lon);
setGeoSuspect(suspect);
if (manualLoc()) return; // точка поставлена вручную — GPS под глушилками её не затирает
if (suspect) { pendingFix = { lat: lat, lon: lon }; return; } // город и точку не переписываем до подтверждения
geoFailed = false;
saveUserLocation(lat, lon);
showUserMarker(lat, lon);
detectUserCity();
// пере-считаем список и сводки с учётом города пользователя
renderStations(cityStationList());
renderAdviceIfOpen(); // точка пришла — в открытом окне «определяю…» меняется на километры
loadPulse();
}, () => { geoFailed = true; renderAdviceIfOpen(); }, { timeout: 5000, maximumAge: 300000 });
  }
}
let startRunning = false;
let startGen = 0;
function retryStart() {
  // повторный тап во время идущей попытки не запускает параллельную загрузку:
  // оверлей уже крутится (это и есть реакция на первый тап)
  if (startRunning) return;
  const g = ++startGen;
  startRunning = true;
  bootStart(); // мгновенная реакция: экран ошибки -> «крутится», прогресс заново
  start().then(() => {
    if (g !== startGen) return; // устаревшая попытка — не трогаем загрузочный экран
    if (bootDataOk || offlineMode) bootDone();
    else bootFail(window.__startErr || 'Данные пришли пустыми — источник молчит');
  }).catch(() => {
    if (g !== startGen) return;
    bootFail(window.__startErr || 'Неизвестная ошибка загрузки');
  }).finally(() => {
    if (g === startGen) startRunning = false;
  });
}
// кнопка «Обновить» на плашке «Нет связи»: повторяем загрузку без перезагрузки
// страницы. На время загрузки плашка остаётся с текстом «Обновляю данные…»,
// а по итогу либо прячется (связь вернулась), либо возвращается со свежим временем.
let refreshing = false;
function manualRefresh(silent) {
  if (refreshing) return;
  refreshing = true;
  const ob = document.getElementById('offlineBar');
  if (silent) offlineBarTrying();
  else if (ob) { ob.classList.remove('catch'); ob.innerHTML = '<span class="ob-spin"></span>Обновляю данные…'; ob.classList.add('on'); }
  document.body.classList.add('offline');
  // тихое автообновление не стирает кэшированные данные с экрана
  if (!silent) {
    const app = document.getElementById('app');
    if (app) app.innerHTML = '<div class="status">Подключаюсь к данным...</div>';
  }
  start().finally(() => {
    refreshing = false;
    if (!offlineMode) {
      // сеть поймали: зелёная плашка «Связь восстановлена», потом прячем
      offlineBarCatch();
      setTimeout(() => {
        const el = document.getElementById('offlineBar');
        if (el) { el.classList.remove('on'); el.classList.remove('catch'); }
        document.body.classList.remove('offline');
      }, 1400);
    }
  });
}
// автообновление, пока висит плашка «Нет связи»: каждые 5 секунд сами
// пробуем поймать сеть, пока start() не загрузит данные. Кнопка на плашке
// осталась для мгновенной попытки, если не хочется ждать.
let offlineRetryTimer = null;
function scheduleOfflineRetry() {
  if (offlineRetryTimer) return;
  // разброс по времени: при толпе клиенты не должны долбить базу в одну секунду
  const loop = () => {
    offlineRetryTimer = setTimeout(() => {
      offlineRetryTimer = null;
      if (offlineMode && !refreshing) manualRefresh(true);
      if (offlineMode) loop();
    }, 25000 + Math.random() * 15000);
  };
  loop();
}
// === Спасательный круг: снимок данных в памяти телефона ===
// После каждой удачной загрузки пишем свежий снимок в localStorage.
// Если следующая загрузка упала (сеть/503) — показываем снимок с честной
// плашкой «нет связи, данные на HH:MM», отметки копим в локальной очереди.
let offlineMode = false;
const LS_CACHE = 'kbCache';
function saveCache() {
  if (offlineMode) return; // офлайн-данные не должны затирать хороший снимок
  if (!allStations.length) return; // частичный снимок без станций убил бы мгновенный вход
  try {
    // Слияние: кусок, упавший в ЭТОМ прогоне, не должен вытирать из кэша
    // хорошие данные прошлого снимка (иначе пустые отметки замораживают
    // экран нулями на следующем входе — твой кейс 01:10)
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(LS_CACHE) || 'null'); } catch (e) {}
    const keep = (cur, old) => {
      const n = cur ? (Array.isArray(cur) ? cur.length : Object.keys(cur).length) : 0;
      return n ? cur : (old !== undefined && old !== null ? old : cur);
    };
    localStorage.setItem(LS_CACHE, JSON.stringify({
      t: Date.now(),
      stations: allStations,
      lastObs: keep(Object.values(allLastObs), prev && prev.lastObs),
      preds: keep(allPredictions.filter(p => p.result === 'PENDING' || (p.is_verified && p.error_minutes !== null && p.error_minutes !== undefined)).slice(0, 800), prev && prev.preds),
      feedback: keep(allFeedback.slice(0, 300), prev && prev.feedback),
      counts: keep(allCounts, prev && prev.counts),
      hourly: keep(allHourly, prev && prev.hourly),
      lastPrice: keep(allLastPrice, prev && prev.lastPrice),
      priceHourly: keep(priceHourly, prev && prev.priceHourly),
      queueEpisodes: keep(queueEpisodes, prev && prev.queueEpisodes),
      fuelHourly: keep(fuelHourly, prev && prev.fuelHourly),
      pulseRaw: keep(pulseRaw, prev && prev.pulseRaw),
      pulseEv: keep(pulseEv, prev && prev.pulseEv)
    }));
  } catch (e) { console.log('Кэш не записан: ' + e.message); }
}
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
    return c && c.stations && c.stations.length ? c : null;
  } catch (e) { return null; }
}
function applyCache(c) {
  allStations = c.stations || [];
  localIdsGlobal = allStations.map(s => s.id);
  allLastObs = {};
  for (const o of (c.lastObs || [])) allLastObs[o.station_id] = o;
  allPredictions = c.preds || [];
  allFeedback = c.feedback || [];
  allCounts = c.counts || [];
  allHourly = c.hourly || [];
  allLastPrice = c.lastPrice || {};
  priceHourly = c.priceHourly || [];
  queueEpisodes = c.queueEpisodes || [];
  allQueueEvents = [];
  fuelHourly = c.fuelHourly || [];
  pulseRaw = (c.pulseRaw || []).map(r => Object.assign({}, r, { t: new Date(r.t) }));
  pulseEv = (c.pulseEv || []).map(e => Object.assign({}, e, { t: new Date(e.t) }));
  queueById = {};
}
let offlineCacheT = 0;
function offlineStamp(t) {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + d.getDate() + '.' + String(d.getMonth() + 1).padStart(2, '0');
}
function showOfflineBar(cacheTime) {
  const el = document.getElementById('offlineBar');
  if (!el) return;
  offlineCacheT = cacheTime;
  el.classList.remove('catch');
  el.innerHTML = 'Нет связи — показываем данные на ' + offlineStamp(cacheTime) + '. Пробую каждые ~30 секунд, отметки сохраняются. <button class="ob-btn" onclick="manualRefresh()">Обновить сейчас</button>';
  el.classList.add('on');
  document.body.classList.add('offline');
  scheduleOfflineRetry();
}
/* анимация обновления: пока попытка идёт — плашка крутит спиннер «Ищу сеть…»,
   при успехе на пару секунд зеленеет «Связь восстановлена» — человек видит,
   что связь восстанавливается, а не что сайт молча стоит */
function offlineBarTrying() {
  const el = document.getElementById('offlineBar');
  if (!el) return;
  el.classList.remove('catch');
  el.innerHTML = '<span class="ob-spin"></span>Ищу сеть… данные на ' + offlineStamp(offlineCacheT || Date.now()) + ', пробую обновиться';
  el.classList.add('on');
}
function offlineBarCatch() {
  const el = document.getElementById('offlineBar');
  if (!el) return;
  el.classList.add('catch');
  el.innerHTML = '<span class="ob-spin"></span>Связь восстановлена, обновляю данные';
}
function queueFeedbackLocally(rows) {
  try {
    const q = JSON.parse(localStorage.getItem('fbQueue') || '[]');
    for (const r of rows) q.push(r);
    localStorage.setItem('fbQueue', JSON.stringify(q));
  } catch (e) {}
}
async function flushFeedbackQueue() {
  try {
    const q = JSON.parse(localStorage.getItem('fbQueue') || '[]');
    if (!q.length) return;
    await dbInsert('user_feedback', q);
    localStorage.setItem('fbQueue', '[]');
    for (const r of q) allFeedback.unshift(Object.assign({ created_at: new Date().toISOString() }, r));
    console.log('Отметки из очереди отправлены: ' + q.length);
  } catch (e) { console.log('Очередь отметок не ушла, попробуем в следующий раз'); }
}
function getFavorites() { return JSON.parse(localStorage.getItem('favorites') || '[]'); }
function isFavorite(id) { return getFavorites().includes(id); }
function toggleFavorite(button) {
  const id = button.dataset.stationId;
  let favs = getFavorites();
  if (favs.includes(id)) { favs = favs.filter(x => x !== id); button.classList.remove('on'); }
  else { favs.push(id); button.classList.add('on'); track('fav_add', null, id); maybeTgOffer(id); }
  localStorage.setItem('favorites', JSON.stringify(favs));
  syncFavorites();
}
function searchStations() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const city = cityStationList();
  if (!query) { renderStations(city); return; }
  renderStations(city.filter(st => [st.name || '', st.brand || '', st.address || ''].join(' ').toLowerCase().includes(query)));
}
function saveUserLocation(lat, lon) {
  try {
    localStorage.setItem('userLocation', JSON.stringify({ lat: lat, lon: lon, t: Date.now() }));
  } catch (e) {}
}

/* гео-разрез: города юга боксами; сводки по умолчанию = город пользователя */
const CITY_BOXES = [
  { key: 'novorossiysk', name: 'Новороссийск', nameIn: 'Новороссийске', lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.00 },
  { key: 'gelendzhik', name: 'Геленджик', nameIn: 'Геленджике', lat1: 44.45, lat2: 44.68, lon1: 37.95, lon2: 38.25 },
  { key: 'anapa', name: 'Анапа', nameIn: 'Анапе', lat1: 44.80, lat2: 45.10, lon1: 37.20, lon2: 37.60 },
  { key: 'krymsk', name: 'Крымск', nameIn: 'Крымске', lat1: 44.85, lat2: 45.05, lon1: 37.85, lon2: 38.15 },
  { key: 'krasnodar', name: 'Краснодар', nameIn: 'Краснодаре', lat1: 44.90, lat2: 45.15, lon1: 38.80, lon2: 39.15 },
  { key: 'sochi', name: 'Сочи', nameIn: 'Сочи', lat1: 43.35, lat2: 43.75, lon1: 39.60, lon2: 40.10 },
  { key: 'tuapse', name: 'Туапсе', nameIn: 'Туапсе', lat1: 44.00, lat2: 44.20, lon1: 39.00, lon2: 39.25 },
  { key: 'armavir', name: 'Армавир', nameIn: 'Армавире', lat1: 44.90, lat2: 45.10, lon1: 40.90, lon2: 41.20 },
  { key: 'maykop', name: 'Майкоп', nameIn: 'Майкопе', lat1: 44.55, lat2: 44.75, lon1: 40.00, lon2: 40.30 },
  { key: 'rostov', name: 'Ростов-на-Дону', nameIn: 'Ростове-на-Дону', lat1: 47.15, lat2: 47.35, lon1: 39.55, lon2: 39.85 },
  { key: 'stavropol', name: 'Ставрополь', nameIn: 'Ставрополе', lat1: 44.80, lat2: 45.25, lon1: 41.60, lon2: 42.30 },
];
let userCityKey = 'novorossiysk';
function detectUserCity() {
  const loc = loadUserLocation();
  if (!loc) return;
  for (const c of CITY_BOXES) {
    if (loc.lat >= c.lat1 && loc.lat <= c.lat2 && loc.lon >= c.lon1 && loc.lon <= c.lon2) { userCityKey = c.key; return; }
  }
  let best = null, bestD = 60;
  for (const c of CITY_BOXES) {
    const clat = (c.lat1 + c.lat2) / 2, clon = (c.lon1 + c.lon2) / 2;
    const dLat = (loc.lat - clat) * 111, dLon = (loc.lon - clon) * 111 * Math.cos(loc.lat * Math.PI / 180);
    const d = Math.sqrt(dLat * dLat + dLon * dLon);
    if (d < bestD) { bestD = d; best = c.key; }
  }
  if (best) userCityKey = best;
}
function userCityName() {
  const c = CITY_BOXES.find(x => x.key === userCityKey);
  return c ? c.name : 'регион';
}
function stationById(id) { return allStations.find(s => s.id === id); }
function scopeIds() {
  const c = CITY_BOXES.find(x => x.key === userCityKey);
  if (!c) return localIdsGlobal;
  return localIdsGlobal.filter(id => {
    const s = stationById(id);
    return s && s.lat >= c.lat1 && s.lat <= c.lat2 && s.lon >= c.lon1 && s.lon <= c.lon2;
  });
}
function cityBox() { return CITY_BOXES.find(x => x.key === userCityKey) || CITY_BOXES[0]; }
function cityStationList() {
  const c = cityBox();
  return allStations.filter(s => s.lat >= c.lat1 && s.lat <= c.lat2 && s.lon >= c.lon1 && s.lon <= c.lon2);
}

function loadUserLocation() {
  const m = manualLoc();
  if (m) return { lat: m.lat, lon: m.lon };
  try {
    const saved = localStorage.getItem('userLocation');
    if (!saved) return null;
    const data = JSON.parse(saved);
    if (Date.now() - data.t > 7 * 24 * 3600 * 1000) return null;
    return { lat: data.lat, lon: data.lon };
  } catch (e) { return null; }
}

function showUserMarker(lat, lon) {
  if (!mapObj) return;
  if (!userMarker) {
    const el = document.createElement('div');
    el.className = 'user-dot';
    el.style.zIndex = '10';
    userMarker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: !!manualMode }).setLngLat([lon, lat]).addTo(mapObj);
    // перетащили пин в ручном режиме = то же, что тап по карте: точка ручная
    userMarker.on('dragend', () => { const ll = userMarker.getLngLat(); saveManualLoc(ll.lat, ll.lng); });
  } else {
    userMarker.setLngLat([lon, lat]);
  }
}

function flyToUserLocation(lat, lon, zoom) {
  if (!mapObj) return;
  showUserMarker(lat, lon);
  mapObj.stop();
  mapObj.easeTo({ center: [lon, lat], zoom: zoom || 12, duration: 900 });
}

function findNearby() {
  if (!navigator.geolocation) { alert('Ваш браузер не поддерживает определение местоположения.'); return; }
  navigator.geolocation.getCurrentPosition(position => {
    const lat = position.coords.latitude, lon = position.coords.longitude;
    try { localStorage.removeItem('kbManualLoc'); } catch (e) {}
 pendingFix = null;
    try { localStorage.removeItem('kbLocPlateDismissed'); } catch (e) {}
    setGeoSuspect(false);
    saveUserLocation(lat, lon);
    detectUserCity();
    if (mapObj) {
      flyToUserLocation(lat, lon);
    } else {
      const sorted = allStations.map(station => {
        const sLat = Number(station.lat), sLon = Number(station.lon);
        if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) return { station, distance: Infinity };
        const dLat = (sLat - lat) * 111, dLon = (sLon - lon) * 111 * Math.cos(lat * Math.PI / 180);
        return { station, distance: Math.sqrt(dLat*dLat + dLon*dLon) };
      }).sort((a,b) => a.distance - b.distance).map(x => x.station);
      const cityIds = new Set(cityStationList().map(s => s.id));
      renderStations(sorted.filter(s => cityIds.has(s.id)), true);
    }
  }, () => alert('Не удалось определить местоположение.'));
}
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchStations(); });
document.addEventListener('pointerdown', e => {
  const t = e.target;
  const pop = document.getElementById('covPop');
  if (pop && pop.classList.contains('open') && !(t.closest && (t.closest('#covPop') || t.closest('#covChip')))) pop.classList.remove('open');
  const wp = document.getElementById('whyPop');
  if (wp && wp.classList.contains('open') && !(t.closest && (t.closest('#whyPop') || t.closest('.chip3.tap') || t.closest('.gp-btn') || t.closest('.info.tap') || t.closest('.why-span') || t.closest('.ctm-why')))) closeWhy();
}, { capture: true });
async function loadPulse() {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const since72 = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  const cityFilter = userCityKey;
  try {
    const [hourly, events] = await Promise.all([
      dbQuery('/rest/v1/region_hourly?select=city,hour,marks,queue_marks,avail95,known95,selling&city=eq.' + cityFilter + '&hour=gte.' + since + '&order=hour.asc&limit=1000'),
      dbQuery('/rest/v1/region_events?select=city,event_type,detected_at&city=eq.' + cityFilter + '&detected_at=gte.' + since + '&event_type=in.(fuel_disappeared,fuel_restored)&order=detected_at.desc&limit=1000')
    ]);
    pulseRaw = hourly.map(h => ({ t: new Date(h.hour), marks: h.marks, queuePct: h.selling ? Math.round(100 * h.queue_marks / h.selling) : 0, availPct: h.known95 ? Math.round(100 * h.avail95 / h.known95) : null }));
    pulseEv = events.map(e => ({ t: new Date(e.detected_at), type: e.event_type }));
  } catch (e) { console.log('pulse main: ' + e.message); }
  dbQuery('/rest/v1/region_fuel_hourly?select=city,hour,a92,k92,a95,k95,adt,kdt,q,marks,selling,knownany&city=eq.' + cityFilter + '&hour=gte.' + since72 + '&order=hour.asc&limit=96')
    .then(f => { fuelHourly = f; renderHeat(); lastWaveStats = allWaveEvents.length ? cityWaveStats() : null;
    renderWave();
    updateMapPlate();
    renderHero(); renderPulse(); setTagline(currentPanel); saveCache(); })
    .catch(() => { if (!offlineMode) fuelHourly = []; renderHeat(); renderHero(); });
  // ← ключевая заплатка: после того как pulseEv пришёл, дайджест и шапка узнают правду
  setTimeout(() => { renderNow(); }, 400);
}
/* помощь: карточка вопрос-ответ простым языком + окно при первом заходе */
function helpHtml() {
  return '<div class="help-h">Что такое КогдаБенз и чем он помогает</div>' +
    '<div class="help-lead">КогдаБенз — помощник водителя юга: Краснодарский край и Адыгея. Мы не просто показываем, где бензин: каждые 10 минут собираем отметки заправок и сообщения водителей, а потом подсказываем, когда топливо вернётся на заправку и когда лучше поехать.</div>' +
    '<div class="help-item"><div class="help-q">Зачем создан этот сайт?</div><div class="help-a">В дефицит бензин пропадает с заправок, а очереди появляются внезапно. Чтобы не ездить по городу вслепую, мы собрали все отметки в одном месте и заранее подсказываем, когда и куда лучше заправиться.</div></div>' +
    '<div class="help-item"><div class="help-q">Откуда берутся данные?</div><div class="help-a">Из двух источников: народная карта заправок (обновляется каждые 10 минут) и отметки таких же водителей, как вы: «топливо есть», «очередь», «привезли». Чем больше людей отмечают, тем точнее подсказки.</div></div>' +
    '<div class="help-item"><div class="help-q">Что за плашка вверху главной панели?</div><div class="help-a">Это живая лента отметок за последний час: источник (топливо вернулось или пропало) и водители (топливо есть/нет, очередь, привезли). Строки сменяются циклом: заправка, улица, что случилось и время отметки.</div></div>' +
    '<div class="help-item"><div class="help-q">Что означают цвета капель на карте?</div><div class="help-a">Зелёная — АИ-95 есть. Оранжевая — есть только АИ-92. Голубая — только дизель. Красная — ничего нет. Серая — свежих данных нет. Если топлив несколько сразу, капля окрашена градиентом из их цветов. Когда источник станцию не видит, каплю красят отметки людей: 2 голоса — ранний сигнал, 3 голоса — подтверждено; оранжевая капля со знаком вопроса — мнения людей разошлись.</div></div>' +
    '<div class="help-item"><div class="help-q">Что за лужи вокруг капель?</div><div class="help-a">Это очереди. Чем краснее и заметнее лужа, тем больше людей стоят в очереди прямо сейчас. Значок с человечками внутри зоны — отметка очереди.</div></div>' +
    '<div class="help-item"><div class="help-q">Что за пунктирная граница на карте?</div><div class="help-a">Это край области, которую мы обслуживаем: внутри неё мы наблюдаем все заправки и даём прогнозы, а снаружи данных пока нет. Граница видна только на обзорной карте, при приближении к городу она тает, чтобы не мешать.</div></div>' +
    '<div class="help-item"><div class="help-q">Что за кнопка «Тепло» на карте?</div><div class="help-a">Это тепловая карта спроса: одно сплошное поле показывает, где сейчас сосредоточен дефицит топлива. Зелёный — спокойно, жёлтый — напряжённо, оранжевый — дефицит, красный — ядро дефицита. В этом режиме капли и очереди скрыты, чтобы не мешать читать поле.</div></div>' +
    '<div class="help-item"><div class="help-q">Что такое «окно возврата»?</div><div class="help-a">Часы, когда топливо с большей вероятностью вернётся на заправку. Мы считаем их по истории заправки: когда и как обычно туда привозят бензин. Рядом с окном всегда показана уверенность в процентах.</div></div>' +
    '<div class="help-item"><div class="help-q">Как построить маршрут до заправки?</div><div class="help-a">Нажмите на каплю на карте и выберите «Построить маршрут»: сайт проведёт линию по дорогам от вашей точки, а внизу покажет примерное время в пути и расстояние в километрах. Если маршрут построить не удалось (например, нет связи) — карта просто подлетит к заправке.</div></div>' +
    '<div class="help-item"><div class="help-q">GPS показывает не туда, что делать?</div><div class="help-a">Иногда навигацию глушат, и точка прыгает или улетает далеко. Тогда сайт покажет красную плашку и чип «указать своё местоположение»: тапните по карте или перетащите синюю точку пальцем — и всё будет считаться от неё. Кнопка «Рядом» в шапке возвращает автоопределение.</div></div>' +
    '<div class="help-item"><div class="help-q">Можно ли доверять сайту?</div><div class="help-a">Каждую ночь мы сверяем свои подсказки с тем, что случилось на самом деле, и честно показываем ошибку на панели «Наша точность прогнозов». Если данных мало — говорим об этом прямо и не выдумываем цифры.</div></div>' +
    '<div class="help-item"><div class="help-q">Что делает кнопка «Куда ехать»?</div><div class="help-a">Подбирает ближайшую к вам заправку с топливом по свежим отметкам и показывает расстояние. Если топлива сейчас нигде нет — подскажет ближайшее окно возврата.</div></div>' +
    '<div class="help-item"><div class="help-q">Работает ли без интернета?</div><div class="help-a">Да, частично: если связь пропала, сайт покажет последние загруженные данные с плашкой «Нет связи — показываем данные на ЧЧ:ММ». Ваши отметки в это время не теряются: они уйдут автоматически, когда связь вернётся.</div></div>' +
    '<div class="help-item"><div class="help-q">Как установить на домашний экран?</div><div class="help-a">На Android в Chrome сайт сам предложит «Установить приложение» в отдельном окошке. На iPhone в Safari: кнопка «Поделиться» 	 «На экран “Домой”» 	 «Добавить». Тогда КогдаБенз будет открываться как обычное приложение, без строки браузера.</div></div>' +
    '<div class="help-item"><div class="help-q">Как я могу помочь?</div><div class="help-a">Нажмите на каплю на карте и выберите «Отметка»: пара нажатий — и ваша отметка о топливе или очереди улучшит подсказки для всего города.</div></div>' +
    '<div class="help-item"><div class="help-q">Как получать уведомления по любимым АЗС?</div><div class="help-a">Нажмите сердечко в карточке АЗС — станция попадёт в избранное. Затем нажмите полоску «Подключить Телеграм», откроется бот — нажмите «Старт». После этого бот будет лично вам писать, когда на избранных заправках вернулось или кончилось топливо, либо появилась очередь (в пределах 10 минут от события).</div></div>' +
    '<div class="help-item"><div class="help-q">Как написать разработчику?</div><div class="help-a">Кнопка «Написать нам / сообщить об ошибке» на главной панели: выберите причину (идея, жалоба, ошибка, реклама), напишите до 350 символов и отправьте. Сообщение придёт разработчику анонимно как «Водитель #N», а Ответ вернётся вам в Телеграм через бота — поэтому окно сначала предложит привязаться к боту. Ответить разработчику можно прямо в чате бота: кнопкой «Ответить разработчику» под его сообщением или обычным сообщением — продолжение диалога придёт ему карточкой «Диалог».</div></div>' +
    '<div class="help-item"><div class="help-q">Что такое «волна в соседнем городе»?</div><div class="help-a">Если в соседнем городе топливо стали терять в 3–4 раза чаще обычного, на плашке карты и полоске главной панели мы показываем «волна» с названием города. Это факт за последние 24 часа, а не прогноз: дефицит иногда ходит между городами волнами, и мы пока измеряем, как часто они доходят до нас.</div></div>' +
    (liteMode ? '<button class="cta-btn ghost" style="width:100%;margin-top:6px" onclick="liteSet(false)">Выключить лайт-версию</button>' : '') +
'<button class="cta-btn" style="width:100%;margin-top:10px" onclick="openMailPop()">' + icon('i-mail') + 'Написать нам / сообщить об ошибке</button>';
}
function openHelp() {
  document.getElementById('sheetBody').innerHTML = helpHtml();
  document.getElementById('sheet').classList.add('open');
  document.getElementById('sheetBack').classList.add('open');
}
function closeHello(more) {
  document.getElementById('helloPop').classList.remove('open');
  document.getElementById('helloBack').classList.remove('open');
  try { localStorage.setItem('seenHello', '1'); } catch (e) {}
  if (more) openHelp(); else setTimeout(maybeInstallPop, 500);
  setTimeout(maybeAdvicePop, 400);
}
function maybeHello() {
  let seen = false;
  try { seen = !!localStorage.getItem('seenHello'); } catch (e) { seen = true; }
  if (seen) return;
  setTimeout(() => {
    document.getElementById('helloPop').classList.add('open');
    document.getElementById('helloBack').classList.add('open');
  }, 600);
}
// === Установка на домашний экран (PWA): красивая подсказка водителю ===
// Android Chrome даёт системный диалог (beforeinstallprompt) — кнопка
// «Установить приложение»; iOS и прочие — три коротких шага под платформу.
// Показываем один раз на устройство (localStorage.seenInstall), не раньше
// приветствия и никогда в standalone (уже стоит как приложение).
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('appinstalled', () => { try { localStorage.setItem('seenInstall', '1'); } catch (e) {} track('pwa_install'); closeInstallPop(false); setTimeout(() => maybeTgOffer(null), 1200); });
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}
function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function installStepsHtml() {
  if (isIOSDevice()) return '<div class="install-step"><b>1</b>В Safari нажмите «Поделиться» — квадрат со стрелкой внизу</div>' +
    '<div class="install-step"><b>2</b>Выберите «На экран “Домой”»</div>' +
    '<div class="install-step"><b>3</b>Нажмите «Добавить» — иконка появится на экране</div>';
  return '<div class="install-step"><b>1</b>Откройте меню браузера (⋮ или ≡)</div>' +
    '<div class="install-step"><b>2</b>Выберите «Установить приложение» или «Добавить на главный экран»</div>' +
    '<div class="install-step"><b>3</b>Подтвердите — иконка появится на экране</div>';
}
function maybeInstallPop() {
  if (isStandalone()) return;
  let seen = false;
  try { seen = !!localStorage.getItem('seenInstall'); } catch (e) { seen = true; }
  if (seen) return;
  const hb = document.getElementById('helloBack');
  if (hb && hb.classList.contains('open')) return; // сначала приветствие, установка — следом
  const ab = document.getElementById('adviceBack');
  if (ab && ab.classList.contains('open')) return; // окно «куда ехать» открыто — дозовёт closeAdvicePop
  const pop = document.getElementById('installPop');
  const back = document.getElementById('installBack');
  if (!pop || !back || pop.classList.contains('open')) return;
  const steps = document.getElementById('installSteps');
  const btn = document.getElementById('installBtn');
  if (steps) {
    if (deferredInstall) { steps.style.display = 'none'; steps.innerHTML = ''; }
    else { steps.style.display = ''; steps.innerHTML = installStepsHtml(); }
  }
  if (btn) btn.innerHTML = deferredInstall ? icon('i-spark') + 'Установить приложение' : icon('i-check') + 'Понятно, сделаю';
  pop.classList.add('open');
  back.classList.add('open');
}
function closeInstallPop(markSeen) {
  const pop = document.getElementById('installPop');
  const back = document.getElementById('installBack');
  if (pop) pop.classList.remove('open');
  if (back) back.classList.remove('open');
  if (markSeen) { try { localStorage.setItem('seenInstall', '1'); } catch (e) {} }
  setTimeout(maybeWhatsNew, 900);
}
async function installRun() {
  if (deferredInstall) {
    try {
      await deferredInstall.prompt();
      const choice = await deferredInstall.userChoice;
      if (choice && choice.outcome === 'accepted') { try { localStorage.setItem('seenInstall', '1'); } catch (e) {} }
      deferredInstall = null;
    } catch (e) {}
    closeInstallPop(true);
    return;
  }
  closeInstallPop(true);
}
// === Опрос водителей: один вопрос за появление, мягкий режим ===
// Показываем только в «тёплый момент» (после отправленной отметки или совета
// «Куда ехать»), не чаще раза за открытие сайта; после ответа — тишина 7 дней,
// после «Позже» — 3 дня. Ответ анонимный: device_id + вопрос + ответ.
// После отправки — спасибо с долей таких же ответов («вы не одни») и личным
// счётчиком вклада: уважение к человеку — главный принцип опроса.
const POLL_ITEMS = [
  { key: 'arrive_truth', q: 'Вы подъехали к заправке — наша информация про топливо совпала?', opts: [['match', 'Всё совпало'], ['almost', 'Почти, одно топливо ошиблось'], ['wrong', 'Нет, было по-другому'], ['notyet', 'Ещё не подъезжал']] },
  { key: 'usability', q: 'Сайтом удобно пользоваться?', opts: [['great', 'Да, всё понятно и быстро'], ['ok', 'В целом удобно'], ['confuse', 'Иногда путаюсь'], ['bad', 'Не очень']] },
  { key: 'map_clear', q: 'Карта понятна: капли, круги, цвета?', opts: [['glance', 'Да, читаю с первого взгляда'], ['ok', 'В целом да'], ['legend', 'Подсматриваю в подсказку цветов'], ['no', 'Не понимаю карту']] },
  { key: 'forecast_true', q: 'Мы пишем «топливо вернётся с 14 до 16». По вашему опыту это сбывается?', opts: [['always', 'Да, почти всегда'], ['half', 'Примерно через раз'], ['rare', 'Редко'], ['notyet', 'Ещё не проверял']] },
  { key: 'marks_why', q: 'Вы отмечаете (топливо, очереди)? Почему?', opts: [['help', 'Да, хочу помочь городу'], ['sometimes', 'Иногда'], ['whynot', 'Нет, не понимаю зачем'], ['hard', 'Нет, неудобно или долго']] },
  { key: 'stars', q: 'Оцените сайт в целом.', stars: true, follow: [['acc', 'Точности'], ['speed', 'Скорости'], ['clear', 'Понятности'], ['city', 'Моего города']] }
];
// Отдельный вопрос отложенного триггера «Куда ехать». Сразу в момент клика
// человек ещё не доехал до АЗС — любой вопрос «совпало?» дал бы пустой ответ.
// Поэтому спрашиваем через 45 минут — 3 суток, когда поездка уже состоялась
// (или не состоялась — это тоже честный и полезный для нас ответ).
const POLL_ADVICE = { key: 'advice_outcome', q: 'Недавно вы строили маршрут до заправки через «Куда ехать». Чем закончилось?', opts: [['fuel', 'Доехал и заправился'], ['miss', 'Поехал, но топливо или очередь — не как ожидал'], ['notwent', 'Ещё не доехал'], ['noadv', 'Не воспользовался советом']] };
function rememberAdvice() {
  try { localStorage.setItem('kbAdviceAt', String(Date.now())); } catch (e) {}
}
function checkAdvicePoll() {
  let at = 0;
  try { at = Number(localStorage.getItem('kbAdviceAt') || 0); } catch (e) {}
  if (!at) return;
  const age = Date.now() - at;
  if (age > 72 * 3600000) { try { localStorage.removeItem('kbAdviceAt'); } catch (e) {} return; }
  if (age < 45 * 60000) return;
  try { localStorage.removeItem('kbAdviceAt'); } catch (e) {}
  maybePollSoon(1200, 'advice_outcome');
}
let pollShownThisSession = false, pollTimer = null, pollSel = null, pollStars = 0, pollMiss = null;
function bumpContrib() {
  let n = 0;
  try { n = Number(localStorage.getItem('kbContrib') || 0); } catch (e) {}
  n++;
  try { localStorage.setItem('kbContrib', String(n)); } catch (e) {}
  return n;
}
function maybePollSoon(delay, overrideKey) {
  if (pollTimer) return;
  pollTimer = setTimeout(() => { pollTimer = null; maybePoll(overrideKey); }, delay || 1600);
}
function maybePoll(overrideKey) {
  if (offlineMode || pollShownThisSession) return;
  const now = Date.now();
  let a = 0, l = 0;
  try { a = Number(localStorage.getItem('kbPollAnswerAt') || 0); l = Number(localStorage.getItem('kbPollLaterAt') || 0); } catch (e) {}
  if (now - a < 7 * 86400000 || now - l < 3 * 86400000) return;
  for (const id of ['sheet', 'helloPop', 'installPop', 'pollPop', 'covPop', 'whyPop', 'advicePop']) {
    const el = document.getElementById(id);
    if (el && el.classList.contains('open')) return;
  }
  showPoll(overrideKey);
}
function showPoll(overrideKey) {
  const pop = document.getElementById('pollPop');
  const back = document.getElementById('pollBack');
  if (!pop || !back) return;
  let item = null;
  if (overrideKey && POLL_ADVICE.key === overrideKey) item = POLL_ADVICE;
  if (!item) {
    let idx = 0;
    try { idx = Number(localStorage.getItem('kbPollIdx') || 0); } catch (e) {}
    item = POLL_ITEMS[idx % POLL_ITEMS.length];
    try { localStorage.setItem('kbPollIdx', String(idx + 1)); } catch (e) {}
  }
  pollSel = null; pollStars = 0; pollMiss = null;
  let body = '';
  if (item.stars) {
    body += '<div class="poll-stars" id="pollStars">' + [1, 2, 3, 4, 5].map(n => '<button onclick="pollPickStar(' + n + ')" aria-label="' + n + '">' + icon('i-star') + '</button>').join('') + '</div>' +
      '<div class="poll-follow" id="pollFollow" style="display:none"><div class="fb-gl">Чего не хватает?</div><div class="feedback-grid">' +
      item.follow.map(f => '<button class="feedback-option" data-f="' + f[0] + '" onclick="pollPickFollow(this)">' + f[1] + '</button>').join('') + '</div></div>';
  } else {
    body += '<div class="poll-opts">' + item.opts.map(o => '<button class="poll-opt" data-a="' + o[0] + '" onclick="pollPick(this)">' + o[1] + '</button>').join('') + '</div>';
  }
  pop.innerHTML = '<div class="poll-head"><div class="logo"><svg viewBox="0 0 24 24" class="logo-mark" aria-hidden="true"><path fill="#fff" d="M12 2.6C12 2.6 5 10.6 5 14.6a7 7 0 0 0 14 0C19 10.6 12 2.6 12 2.6Z"/><path fill="none" stroke="#2465ee" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M12 11.2v3.4l2.6 1.6"/></svg></div>' +
    '<div><div class="poll-title">Минута вашего времени — для общей точности</div><div class="poll-sub">Один вопрос. Ответ делает сайт лучше для всего города.</div></div></div>' +
    '<div class="poll-q">' + item.q + '</div>' + body +
    '<div class="poll-actions"><button class="cta-btn" id="pollSend" onclick="sendPoll()" disabled>Отправить</button>' +
    '<button class="cta-btn ghost" onclick="pollLater()">Позже</button></div>';
  pop.dataset.key = item.key;
  pop.classList.add('open');
  back.classList.add('open');
  pollShownThisSession = true;
}
function pollPick(btn) {
  btn.parentNode.querySelectorAll('.poll-opt').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  pollSel = btn.dataset.a;
  const s = document.getElementById('pollSend');
  if (s) s.disabled = false;
}
function pollPickStar(n) {
  pollStars = n;
  const box = document.getElementById('pollStars');
  if (box) box.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i < n));
  const f = document.getElementById('pollFollow');
  if (f) f.style.display = n <= 3 ? '' : 'none';
  const s = document.getElementById('pollSend');
  if (s) s.disabled = false;
}
function pollPickFollow(btn) {
  btn.parentNode.querySelectorAll('.feedback-option').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  pollMiss = btn.dataset.f;
}
function pollLater() {
  const pop = document.getElementById('pollPop');
  const back = document.getElementById('pollBack');
  if (pop) pop.classList.remove('open');
  if (back) back.classList.remove('open');
  try { localStorage.setItem('kbPollLaterAt', String(Date.now())); } catch (e) {}
}
function closePollThanks() {
  const pop = document.getElementById('pollPop');
  const back = document.getElementById('pollBack');
  if (pop) pop.classList.remove('open');
  if (back) back.classList.remove('open');
}
function pollBackClick() {
  const pop = document.getElementById('pollPop');
  if (pop && pop.querySelector('.poll-thanks')) { closePollThanks(); return; }
  pollLater();
}
async function sendPoll() {
  const pop = document.getElementById('pollPop');
  if (!pop || !pop.dataset.key) return;
  const key = pop.dataset.key;
  const item = POLL_ITEMS.find(x => x.key === key) || (POLL_ADVICE.key === key ? POLL_ADVICE : null);
  const sendBtn = document.getElementById('pollSend');
  if (sendBtn && sendBtn.disabled) return;
  const sendBtnOrigText = sendBtn ? sendBtn.textContent : '';
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Отправляю...'; }
  const answerKey = item && item.stars ? 'star' + pollStars + (pollMiss ? '_' + pollMiss : '') : pollSel;
  if (!answerKey) return;
  const row = { device_id: deviceId, question_key: key, answer_key: answerKey, stars: pollStars || null, city_key: userCityKey || null };
  let ok = true;
  try { await dbInsert('poll_answers', [row]); } catch (e) { ok = false; }
  if (!ok) {
    // нет связи: ответ ждёт в локальной очереди и уйдёт автоматически
    try {
      const q = JSON.parse(localStorage.getItem('pollQueue') || '[]');
      q.push(row);
      localStorage.setItem('pollQueue', JSON.stringify(q));
    } catch (e) {}
  }
  const n = bumpContrib();
  try { localStorage.setItem('kbPollAnswerAt', String(Date.now())); } catch (e) {}
  let pctHtml = '';
  try {
    const rows = await dbQuery('/rest/v1/poll_totals?question_key=eq.' + encodeURIComponent(key));
    const total = rows.reduce((s, r) => s + Number(r.cnt), 0);
    if (total >= 5) {
      if (item && item.stars) {
        const same = rows.filter(r => String(r.answer_key).indexOf('star' + pollStars) === 0).reduce((s, r) => s + Number(r.cnt), 0);
        let sum = 0;
        for (const r of rows) { const m = String(r.answer_key).match(/star(\d)/); if (m) sum += Number(m[1]) * Number(r.cnt); }
        pctHtml = 'Вы не одни: такую же оценку поставили ' + Math.round(100 * same / total) + '% водителей, средняя по сайту — ' + (sum / total).toFixed(1).replace('.', ',') + '. Всего оценок: ' + total + '.';
      } else {
        const same = rows.filter(r => r.answer_key === answerKey).reduce((s, r) => s + Number(r.cnt), 0);
        const optTxt = item ? ((item.opts || []).find(o => o[0] === answerKey) || [])[1] || '' : '';
        pctHtml = 'Вы не одни: «' + optTxt.toLowerCase() + '» ответили ' + Math.round(100 * same / total) + '% водителей. Всего ответов на этот вопрос: ' + total + '.';
      }
    } else {
      pctHtml = 'Вы первый, кто отвечает на этот вопрос, — спасибо, что прокладываете дорогу! Как только наберутся ответы, покажем, как совпадают мнения всех водителей.';
    }
  } catch (e) { pctHtml = 'Ответ записан и поможет делать сайт и прогнозы точнее.'; }
  pop.innerHTML = '<div class="poll-thanks"><div class="big">Спасибо! 🙏</div>' +
    '<div class="pct">' + pctHtml + '</div>' +
    '<div class="me">Это ваш ' + n + '-й вклад в общее дело (отметки и ответы). Спасибо, что вы с нами!</div>' +
    '<div class="poll-actions"><button class="cta-btn" onclick="closePollThanks()">Отлично</button></div></div>';
  setTimeout(closePollThanks, 4500);
}
async function flushPollQueue() {
  try {
    const q = JSON.parse(localStorage.getItem('pollQueue') || '[]');
    if (!q.length) return;
    await dbInsert('poll_answers', q);
    localStorage.setItem('pollQueue', '[]');
    console.log('Ответы опроса из очереди отправлены: ' + q.length);
  } catch (e) { console.log('Очередь ответов опроса не ушла, попробуем в следующий раз'); }
}

// === «Что нового»: карточки нововведений ===
// Новое нововведение = добавить объект В НАЧАЛО массива (дата дд.мм.гг, чип).
// Карточка дня всплывает раз в сутки и только 14 дней с даты нововведения;
// полная история всегда живёт на панели «Обновления» (пятая).
const WHATS_NEW = [
    {
id: 'v052-heatmap-fast',
date: '12.11.26',
tag: 'v0.5.2',
title: 'Тепловая карта города + лёгкий редизайн',
img: 'v0.5.2.webp', 
lead: 'Главная панель теперь показывает город как живую мозаику: каждая плитка — АЗС, размер и яркость — сколько событий станция собрала с полуночи, цвет — какое топливо есть сейчас, процент — доля станции в активности города. Вход стал быстрее: последний снимок данных показываем сразу, а сеть обновляет цифры фоном.',
steps: [
['Мозаика города на главной', 'Плитки — заправки твоего города: чем больше и ярче, тем активнее станция с 00:00 (события источника + отметки водителей). Цвет — топливо сейчас: зелёный АИ-95, оранжевый АИ-92, голубой дизель, красный «нет», серый «молчит». Внутри плитки — прозрачный штамп бренда, а в строках — окно прогноза, события и километры до тебя.'],
['Тап по любой плитке открывает полную карточку АЗС с ценами, очередью и прогнозом.', 'Мелкие станции меньше 5% активности не шумят в мозаике.'],
['Быстрый вход и лёгкий редизайн', 'Сайт открывается мгновенно из снимка прошлой загрузки, а свежие данные доезжают фоном без перезагрузки. Карта грузится только когда нужна, шапка стала компактной (версия, связь, гео, уведомления), а при слабом интернете предлагается лайт-режим без карты.']
],
why: 'Зачем: в дефицит важно видеть не список, а картину города целиком — где топливо держится, где вымывается, какие АЗС живут активной жизнью. Мозаика даёт это с одного взгляда, а быстрый вход экономит секунды и трафик именно тогда, когда связь слабая и топливо нужно найти сейчас.'
},
    {
  id: 'advice-now',
  date: '12.10.26',
  tag: 'подбор',
  title: 'Куда ехать прямо сейчас',
  img: 'whatsnew-advice.webp',
  lead: 'При входе сайт сам подбирает, куда ехать заправиться прямо сейчас: показывает лучшие заправки твоего города с топливом, ценой, расстоянием и окном привоза — и отмечает золотом лучший вариант.',
  steps: [
    ['Откроется само при заходе', 'Сайт сам покажет окно при входе: лучшие заправки твоего города по свежим данным. Если достоверных сейчас одна — покажем одну, пустые рисовать не будем.'],
    ['Сравни варианты по делу', 'В каждой карточке: какое топливо есть, как далеко, почём и насколько дешевле города, когда последний раз проверяли, очередь (только если реально видим) и окно привоза с уверенностью. Золотая плашка «наш выбор» — лучший по всем метрикам сразу.'],
    ['Жми и езжай', '«На карте + маршрут» проложит дорогу от тебя и покажет время в пути. «Карточка» откроет подробности, не закрывая подборку — вернёшься одним крестиком. Твой выбор запоминается: в следующий раз подберём ближе к твоим привычкам.']
  ],
  why: 'Зачем: в дефицит главное — не гонять машину вслепую. Мы показываем только то, что реально видим прямо сейчас, отделяем факт от прогноза и не приукрашиваем очередь. А золотой «наш выбор» экономит минуту: не надо самому сводить расстояние, цену и наличие в голове.'
}, 
  {
    id: 'mail-bridge',
    date: '08.10.26',
    tag: 'связь',
    title: 'Прямая линия с разработчиком',
    img: 'whatsnew-mail.webp',
    lead: 'Кнопка «Написать нам / сообщить об ошибке» на главной панели: причина, до 350 символов — и сообщение ушло разработчику как «Водитель #N». Ответ придёт в Телеграм, там же можно продолжить диалог.',
    steps: [
      ['Откройте окно «Написать нам»', 'Полоска на главной панели или кнопка в «Помощи»; окно сразу предложит привязаться к боту — чтобы было куда отвечать.'],
      ['Выберите причину и напишите', 'Идея, жалоба, ошибка или реклама; счётчик покажет, сколько символов осталось.'],
      ['Получите ответ в Телеграме', 'Ответ придёт в чат бота; нажмите «Ответить разработчику» — диалог продолжится без сайта.']
    ],
    why: 'Зачем: сайт живёт, пока с ним говорят. Раньше ошибки и идеи терялись в чатах и отзывах, теперь они приходят одним потоком с анонимным номером водителя, а ответ возвращается туда же — разговор не обрывается.'
  },
  {
    id: 'tg-fav-notify',
    date: '04.10.26',
    tag: 'уведомления',
    title: 'Уведомления в Телеграм по выбранным АЗС',
    img: 'whatsnew-tg.webp',
    lead: 'Добавьте любимые АЗС в избранное — и не пропустите, когда на них появится бензин. Бот следит сам и пишет лично вам.',
    steps: [
      ['Откройте детальную карточку АЗС', 'В списке «АЗС города» или на карте тапните строку или каплю и нажмите сердечко.'],
      ['Подключите Телеграм', 'В карточке нажмите голубую плашку «Подключить»: откроется бот, нажмите «Старт» — готово.'],
      ['Получайте сообщения', 'Топливо вернулось, кончилось или выросла очередь на выбранной АЗС — сообщение придёт в течение нескольких минут после события.']
    ],
    why: 'Зачем: в дефицит топливо появляется на заправках непредсказуемо, а проверять сайт каждый час — утомительно. Теперь уведомление приходит само: только по вашим АЗС и только когда что-то реально случилось. Пауза — команда /quiet в боте, отключить совсем — /stop.'
  }
];
function wnAgeDays(w) {
  const p = w.date.split('.');
  const d = new Date(2000 + Number(p[2]), Number(p[1]) - 1, Number(p[0]));
  return (Date.now() - d.getTime()) / 86400000;
}
function wnCardHtml(w) {
  return '<div class="wn-card">' +
    (w.img ? '<img class="wn-img" src="' + w.img + '" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\'" onclick="openWnZoom(this.src)">' : '') +
    '<div class="rc-chips" style="margin-top:8px"><span class="rc-chip info">' + icon('i-spark', 'ic-s') + w.date + '</span>' +
    (w.tag ? '<span class="rc-chip yes">' + icon('i-check', 'ic-s') + w.tag + '</span>' : '') + '</div>' +
    '<div class="wn-title">' + w.title + '</div>' +
    '<div class="wn-lead">' + w.lead + '</div>' +
    '<div class="install-steps">' + w.steps.map((s, i) =>
      '<div class="install-step"><b>' + (i + 1) + '</b><span style="min-width:0;color:#71809c;font-weight:400;line-height:1.45"><i style="display:block;font-style:italic;font-weight:850;color:#14213d;margin-bottom:3px">' + s[0] + '</i>' + s[1] + '</span></div>').join('') + '</div>' +
    '<div class="wn-why">' + w.why + '</div></div>';
}
function renderWhatsNewPanel() {
  const el = document.getElementById('wnBody');
  if (!el) return;
  el.innerHTML = WHATS_NEW.length ? WHATS_NEW.map(wnCardHtml).join('') : '<div class="status">Обновлений пока нет.</div>';
}
function showWhatsNew(w) {
  const pop = document.getElementById('wnPop');
  if (!pop) return;
  pop.innerHTML = '<div class="hello-title">Что нового на сайте</div>' + wnCardHtml(w) +
    '<div class="nowcard-cta" style="margin-top:10px"><button class="cta-btn" onclick="closeWhatsNew()">Понятно</button>' +
    '<button class="cta-btn ghost" onclick="closeWhatsNew();pagerGo(4)">Все обновления</button></div>';
  pop.classList.add('open');
  const back = document.getElementById('wnBack');
  if (back) back.classList.add('open');
}
function closeWhatsNew() {
  const pop = document.getElementById('wnPop');
  const back = document.getElementById('wnBack');
  if (pop) pop.classList.remove('open');
  if (back) back.classList.remove('open');
}
// плавный зум картинки: открываем оверлей и на следующем кадре добавляем
// .shown — CSS-транзишен сам доводит масштаб и прозрачность
function openWnZoom(src) {
  const z = document.getElementById('wnZoom');
  if (!z) return;
  const img = document.getElementById('wnZoomImg');
  if (img) img.src = src;
  z.classList.add('open');
  requestAnimationFrame(() => requestAnimationFrame(() => z.classList.add('shown')));
}
function closeWnZoom() {
  const z = document.getElementById('wnZoom');
  if (!z || !z.classList.contains('open')) return;
  z.classList.remove('shown');
  setTimeout(() => { z.classList.remove('open'); }, 320);
}
let wnTries = 0;
function maybeWhatsNew() {
  const pop = document.getElementById('wnPop');
  if (!pop || pop.classList.contains('open')) return;
  if (!WHATS_NEW.length || wnAgeDays(WHATS_NEW[0]) > 14) return;
  // не блокируем советом: «что нового» выйдет после закрытия advice
  // (см. closeAdvicePop / closeInstallPop) — раз в сутки по kbWnDay.
  let last = '';
  try { last = localStorage.getItem('kbWnDay') || ''; } catch (e) {}
  const d = new Date();
  const today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  if (last === today) return; // раз в сутки
  const openNow = ['helloBack', 'installBack', 'pollBack', 'sheetBack', 'lifeBack', 'adviceBack'].some(id => {
    const el = document.getElementById(id);
    return el && el.classList.contains('open');
  });
  if (openNow) { if (wnTries++ < 15) setTimeout(maybeWhatsNew, 4000); return; }
  try { localStorage.setItem('kbWnDay', today); } catch (e) {}
  showWhatsNew(WHATS_NEW[0]);
}
// === Лайтбокс картинки нововведений ===
// Тап ловим делегированием по любому img.wn-img — работает, даже если
// onclick-атрибут не встал в разметку карточки. Оверлей создаётся сам.
document.addEventListener('click', function (e) {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.classList.contains('wn-img')) openWnZoom(t.src);
});
function openWnZoom(src) {
  let z = document.getElementById('wnZoom');
  if (!z) {
    z = document.createElement('div');
    z.className = 'wn-zoom';
    z.id = 'wnZoom';
    z.innerHTML = '<img id="wnZoomImg" alt="">';
    z.addEventListener('click', closeWnZoom);
    document.body.appendChild(z);
  }
  const img = document.getElementById('wnZoomImg');
  if (img) img.src = src;
  z.classList.add('open');
  requestAnimationFrame(() => requestAnimationFrame(() => z.classList.add('shown')));
}
function closeWnZoom() {
  const z = document.getElementById('wnZoom');
  if (!z || !z.classList.contains('open')) return;
  z.classList.remove('shown');
  setTimeout(() => { z.classList.remove('open'); }, 320);
}
// === загрузочный оверлей: этапы поверх заблюренной страницы ===
// Показываем только на первой загрузке: как только start() завершился
// (успех, кэш или ошибка) — прогресс доходит до 100% и оверлей тает.
// Этапы листаются таймером, прогресс ползёт к 95% и ждёт реальной
// готовности — честные «100%» при пустых панелях не показываем.
const BOOT_TARGETS = [16, 34, 52, 70, 86, 95];
const BOOT_LINES = [
  'Слушаем, где сейчас топливо течёт, а где высохло…',
  'Считаем очереди, чтобы вам в них не стоять…',
  'Примеряем заправки к вашим маршрутам…',
  'Раскладываем по полочкам — почти готово…'
];

// Полезные факты из раздела «Помощь» для показа во время загрузки
const BOOT_TIPS = [
  '💡 Зелёная капля на карте — есть АИ-95. Оранжевая — только 92-й.',
  '💡 Лужи вокруг заправок — это очереди. Чем краснее, тем дольше ждать.',
  '💡 Добавьте АЗС в избранное, и бот в Телеграме напишет, когда туда привезут бензин.',
  '💡 Нет топлива? Нажмите на «Куда ехать» — покажем ближайшее окно возврата.',
  '💡 GPS глушат? Нажмите чип «Указать своё местоположение» на карте.',
  '💡 Ваши отметки о топливе и очередях делают прогнозы точнее для всего города.',
  '💡 Каждую ночь мы сверяем прогнозы с фактами и показываем честную ошибку.'
];
let bootStage = -1, bootPct = 3, bootTarget = 3, bootTimer = null, bootStageTimer = null, bootOver = false, bootT0 = 0;
// загрузка не должна выглядеть муляжом: оверлей не имеет права показать
// «всё готово», пока start() реально не привёз данные. bootDataOk — флаг
// настоящего успеха, bootFailed — оверлей уже показал честную ошибку
let bootDataOk = true, bootFailed = false;
// метрики под прогресс-баром: скорость, объём, ETA (оценка по probe + % этапов)
// Честный прогресс: полоска = доля завершённых запросов start(), не таймер этапов
let bootNet = { kbps: 0, probeMs: 0 };
let bootLoadDone = 0, bootLoadTotal = 16, bootLoadLabel = '';
function bootFmtSpeed(kbps) {
  if (!kbps || kbps < 1) return '';
  if (kbps >= 1000) return (kbps / 1000).toFixed(1) + ' Мбит/с';
  return Math.round(kbps) + ' Кбит/с';
}
function ensureBootMetaEl() {
  let meta = document.getElementById('bootMeta');
  if (meta) return meta;
  const bar = document.getElementById('bootBarFill');
  const parent = bar && (bar.parentElement || bar.parentNode);
  if (!parent) return null;
  meta = document.createElement('div');
  meta.id = 'bootMeta';
  meta.setAttribute('aria-live', 'polite');
  meta.style.cssText = 'margin-top:8px;font-size:11px;line-height:1.35;color:rgba(255,255,255,.72);text-align:center;font-variant-numeric:tabular-nums;letter-spacing:.01em';
  parent.insertAdjacentElement('afterend', meta);
  return meta;
}
function bootReportLoad(label) {
  if (bootOver) return;
  bootLoadDone = Math.min(bootLoadTotal, bootLoadDone + 1);
  if (label) bootLoadLabel = label;
  const pct = Math.round(4 + (bootLoadDone / Math.max(1, bootLoadTotal)) * 92);
  bootTarget = pct;
  bootPct = Math.max(bootPct, pct);
  bootPaintPct();
  // Все запросы отработали — не ждём firstPaint/start, закрываем оверлей
  if (bootLoadDone >= bootLoadTotal) {
    bootDataOk = true;
    setTimeout(function () { if (!bootOver) bootDone(); }, 50);
  }
}
const BOOT_TIPS_CARDS = [
  { ico: 'i-tg', bg: 'linear-gradient(135deg,#2465ee,#5b8def)', title: 'Уведомления в Телеграме', text: 'Добавь АЗС в избранное — бот напишет, когда туда привезут бензин. Не нужно проверять сайт каждый час.' },
  { ico: 'i-pump', bg: 'linear-gradient(135deg,#19b77a,#5dd9a5)', title: 'Отметка топлива — 2 тапа', text: 'Нажал на каплю → «Отметка». Твой голос делает прогнозы точнее именно для твоего города — без тебя мы гадаем.' },
  { ico: 'i-check', bg: 'linear-gradient(135deg,#f5a05a,#ffd089)', title: 'Честная ошибка прогноза', text: 'Каждую ночь сверяем вчерашние прогнозы с фактом. Медиану ошибки показываем openly — без округлений в свою пользу.' },
  { ico: 'i-truck', bg: 'linear-gradient(135deg,#7c6dff,#a597ff)', title: 'Куда ехать прямо сейчас', text: 'Сайт сам подбирает лучшие заправки города с топливом и ценой. Золотая плашка «наш выбор» экономит твоё время.' },
  { ico: 'i-clock', bg: 'linear-gradient(135deg,#f5b82e,#ffd56b)', title: 'Окна возврата топлива', text: 'Мы прогнозируем, когда топливо вернётся на заправку. Тапни на АЗС, чтобы увидеть вероятное время привоза.' },
  { ico: 'i-pin', bg: 'linear-gradient(135deg,#ef5350,#ff8a80)', title: 'GPS врёт?', text: 'Если навигацию глушат, нажми на карте «Указать своё местоположение» — перетащи точку пальцем, и маршруты построятся верно.' },
  { ico: 'i-heart', bg: 'linear-gradient(135deg,#d7263d,#ff6b81)', title: 'Помоги городу', text: 'Отмечай наличие топлива и очереди. Каждая твоя отметка помогает сотням водителей не тратить время зря.' },
  { ico: 'i-chart', bg: 'linear-gradient(135deg,#397cff,#74a0ff)', title: 'Экономь на заправках', text: 'В карточке АЗС мы показываем цену и насколько она отличается от средней по городу. Выбирай выгодные заправки.' }
];
let currentBootTips = null;
function getBootTips() {
  if (currentBootTips) return currentBootTips;
  // Перемешиваем и берем 3 случайных
  currentBootTips = [...BOOT_TIPS_CARDS].sort(() => 0.5 - Math.random()).slice(0, 3);
  return currentBootTips;
}
function renderBootLiveStations() {
  const listEl = document.getElementById('bootLiveList');
  const titleEl = document.getElementById('bootTitle');
  if (!listEl) return;

  // === НОВЫЙ БЛОК: онбординг вместо скелетонов ===
  if (!allStations.length || !Object.keys(getLastObservations()).length) {
    if (titleEl) titleEl.textContent = 'Подключаемся к базе...';
    
    // Генерируем 3 случайные карточки
    const tips = getBootTips();
    listEl.innerHTML = tips.map((t, i) => `
      <div class="boot-tip-card" style="animation-delay:${i * 0.1}s">
        <div class="boot-tip-ico" style="background:${t.bg}">
          <svg class="ic" style="width:22px;height:22px"><use href="#${t.ico}"/></svg>
        </div>
        <div class="boot-tip-body">
          <b>${t.title}</b>
          <span>${t.text}</span>
        </div>
      </div>
    `).join('');
    
    return;
  }

  const loc = loadUserLocation();
  const lastObs = getLastObservations();
  const localStations = cityStationList();
  
  const withFuel = [];
  const recentlyUpdated = [];
  
  for (const st of localStations) {
    const o = lastObs[st.id];
    if (!o) continue;
    
    if (o.data_freshness_minutes !== null && o.data_freshness_minutes !== undefined) {
      recentlyUpdated.push({ st, o });
    }

    const isFresh = obsFresh(o);
    const hasFuel = o.fuel_95_status === true || o.fuel_92_status === true || o.diesel_status === true;
    
    if (isFresh && hasFuel) {
      let dist = null;
      if (loc && Number.isFinite(Number(st.lat))) {
        const dLat = (Number(st.lat) - loc.lat) * 111;
        const dLon = (Number(st.lon) - loc.lon) * 111 * Math.cos(loc.lat * Math.PI / 180);
        dist = Math.sqrt(dLat * dLat + dLon * dLon);
      }
      withFuel.push({ st, o, dist });
    }
  }

  withFuel.sort((a, b) => {
    if (a.dist !== null && b.dist !== null) return a.dist - b.dist;
    return a.o.data_freshness_minutes - b.o.data_freshness_minutes;
  });

  let top = withFuel.slice(0, 3);
  let isFallback = false;

  if (top.length === 0) {
    isFallback = true;
    recentlyUpdated.sort((a, b) => a.o.data_freshness_minutes - b.o.data_freshness_minutes);
    top = recentlyUpdated.slice(0, 3).map(item => {
      let dist = null;
      if (loc && Number.isFinite(Number(item.st.lat))) {
        const dLat = (Number(item.st.lat) - loc.lat) * 111;
        const dLon = (Number(item.st.lon) - loc.lon) * 111 * Math.cos(loc.lat * Math.PI / 180);
        dist = Math.sqrt(dLat * dLat + dLon * dLon);
      }
      return { ...item, dist };
    });
  }

  if (!top.length) {
    titleEl.textContent = 'Собираем данные...';
    listEl.innerHTML = '<div style="color:rgba(255,255,255,.7);font-size:12px;text-align:center;padding:20px;">Секунду, подключаемся к базе...</div>';
    return;
  }

  titleEl.textContent = isFallback ? 'Недавно обновляли' : ((loc && top[0].dist !== null) ? 'Топливо есть рядом' : 'Топливо есть в городе');

  listEl.innerHTML = top.map((it, i) => {
    const st = it.st;
    const o = it.o;
    const distTxt = it.dist !== null ? (it.dist < 1 ? Math.round(it.dist * 1000) + ' м' : it.dist.toFixed(1) + ' км') : '';
    
    let descHtml = '';
    let fuelsHtml = '';

    if (isFallback) {
      const min = o.data_freshness_minutes;
      const timeTxt = min < 60 ? min + ' мин назад' : Math.round(min / 60) + ' ч назад';
      descHtml = `Обновлено ${timeTxt}`;
      
      const hasFuel = o.fuel_95_status === true || o.fuel_92_status === true || o.diesel_status === true;
      if (!hasFuel) {
        fuelsHtml = `<span class="boot-fuel-chip" style="background:rgba(255,255,255,.1); color:rgba(255,255,255,.6); border-color:transparent">без топлива</span>`;
      }
    } else {
      descHtml = escapeHtml(st.address || '');
      const fuels = [];
      if (o.fuel_95_status === true) fuels.push('95');
      if (o.fuel_92_status === true) fuels.push('92');
      if (o.diesel_status === true) fuels.push('ДТ');
      fuelsHtml = fuels.map(f => `<span class="boot-fuel-chip">${f}</span>`).join('');
    }

    return `
      <div class="boot-st-card" style="animation-delay: ${i * 0.1}s">
        <div class="boot-st-logo">${stationLogo(st)}</div>
        <div class="boot-st-info">
          <div class="boot-st-name">${escapeHtml(st.name || 'АЗС')}</div>
          <div class="boot-st-desc">${descHtml}</div>
        </div>
        <div class="boot-st-fuels">${fuelsHtml}</div>
        ${distTxt ? `<div class="boot-st-dist">${distTxt}</div>` : ''}
      </div>
    `;
  }).join('');
}
function bootStart() {
  const back = document.getElementById('bootBack');
  if (!back) return;
  if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }
  if (bootStageTimer) { clearInterval(bootStageTimer); bootStageTimer = null; }
  bootOver = false; bootFailed = false;
  bootPct = 2; bootTarget = 2; bootStage = -1;
  bootLoadDone = 0; bootLoadTotal = 16; bootLoadLabel = 'подключение';
  bootNet.kbps = 0; bootNet.probeMs = 0;
  back.style.display = ''; back.classList.remove('off');
  const fb = document.getElementById('bootFailBox'); if (fb) fb.style.display = 'none';
  bootT0 = Date.now();
  ensureBootMetaEl();
  bootPaintPct();
  netProbe().then((r) => {
    if (bootOver) return;
    if (r && r.kbps) bootNet.kbps = r.kbps;
    if (r && r.ms) bootNet.probeMs = r.ms;
    bootPaintPct();
  }).catch(() => {});
  bootTimer = setInterval(() => {
    if (bootPct < bootTarget) { bootPct = Math.min(bootTarget, bootPct + 3); bootPaintPct(); }
  }, 40);
  bootStageTimer = setInterval(() => {
    if (bootOver) return;
    if (bootStage < BOOT_TARGETS.length - 1) applyBootStage(bootStage + 1);
  }, 1900);
  setTimeout(() => { if (!bootOver) bootFail('Сеть или база не ответили за 45 секунд'); }, 45000);
}
function applyBootStage(i) {
  bootStage = i;
  // Полоску этапы больше НЕ двигают — только текст
  const el = document.getElementById('bootLine');
  if (!el) return;
  let txt = '';
  if (i % 2 === 0) {
    const lineIdx = Math.floor(i / 2);
    txt = BOOT_LINES[lineIdx] || BOOT_LINES[BOOT_LINES.length - 1];
  } else {
    txt = BOOT_TIPS[Math.floor(Math.random() * BOOT_TIPS.length)];
  }
  if (el.textContent === txt) return;
  el.classList.remove('boot-woosh-in');
  el.classList.add('boot-woosh-out');
  setTimeout(() => {
    el.textContent = txt;
    el.classList.remove('boot-woosh-out');
    el.classList.add('boot-woosh-in');
    setTimeout(() => el.classList.remove('boot-woosh-in'), 400);
  }, 200);
}
function bootPaintPct() {
  const p = Math.max(0, Math.min(100, bootPct));
  const bar = document.getElementById('bootBarFill');
  if (bar) bar.style.width = p + '%';
  const meta = ensureBootMetaEl();
  if (!meta) return;
  if (p >= 100) {
    const sp = bootFmtSpeed(bootNet.kbps);
    meta.textContent = sp ? ('Готово · ' + sp) : 'Готово';
    return;
  }
  const parts = [];
  const sp = bootFmtSpeed(bootNet.kbps);
  if (sp) parts.push(sp);
  parts.push(bootLoadDone + ' из ' + bootLoadTotal + ' запросов');
  parts.push(Math.round(p) + '%');
  if (bootLoadLabel) parts.push(bootLoadLabel);
  meta.textContent = parts.join(' · ');
}
function hideBoot() {
  const back = document.getElementById('bootBack');
  if (!back) return;
  back.classList.add('off');
  back.style.opacity = '0';
  back.style.pointerEvents = 'none';
  back.style.display = 'none';
  try { back.remove(); } catch (e) {}
}
function bootDone() {
  if (bootOver) { hideBoot(); return; }
  bootOver = true;
  bootDataOk = true;
  if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }
  if (bootStageTimer) { clearInterval(bootStageTimer); bootStageTimer = null; }
  bootLoadDone = bootLoadTotal;
  bootPct = 100; bootTarget = 100;
  try { bootPaintPct(); } catch (e) {}
  hideBoot();
}
function bootFail(msg) {
  if (bootOver) return;
  bootOver = true;
  bootFailed = true;
  startRunning = false; // ошибка показана -> кнопка «Попробовать снова» снова кликабельна
  if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }
  if (bootStageTimer) { clearInterval(bootStageTimer); bootStageTimer = null; }
  console.log('Загрузка не удалась: ' + (msg || ''));
  const box = document.getElementById('bootFailBox');
  if (box) box.style.display = '';
}
// === мост «водитель ↔ разработчик»: обращения без регистраций ===
// Окно: связка с ботом (канал ответа), причина, текст до 350 символов
// со счётчиком. Отправка через rpc driver_msg_send — он же выдаёт
// стабильный анонимный номер «Водитель #N». Бот доставляет обращение
// владельцу с кнопкой «Ответить», ответ приходит в личку бота.
const MAIL_REASONS = { idea: 'Идея', complaint: 'Жалоба', error: 'Ошибка', ad: 'Реклама' };
let mailReason = null, mailTextCache = '';
function openMailPop() {
  const pop = document.getElementById('mailPop');
  const back = document.getElementById('mailBack');
  if (!pop || !back) return;
  renderMailPop();
  pop.classList.add('open');
  back.classList.add('open');
}
function closeMailPop() {
  const pop = document.getElementById('mailPop');
  const back = document.getElementById('mailBack');
  if (pop) pop.classList.remove('open');
  if (back) back.classList.remove('open');
}
function renderMailPop() {
  const pop = document.getElementById('mailPop');
  if (!pop) return;
  const linkPlate = tgLinked
    ? '<div class="dg-strip tg-on" style="margin:0">' + icon('i-check', 'ic-s') + '<span>Ответ придёт в ваш Телеграм</span></div>'
    : '<div class="dg-strip tap tg-ask" style="margin:0" onclick="tgConnectMail()">' + icon('i-spark', 'ic-s') + '<span>Чтобы получать ответ — привяжитесь к боту. Подключить</span></div>';
  pop.innerHTML = '<div class="hello-title">Написать нам / сообщить об ошибке</div>' +
    '<div class="help-lead" style="margin:6px 0 8px">Сообщение придёт разработчику анонимно как «Водитель #N». Ответ вернётся вам в Телеграм через бота.</div>' +
    linkPlate +
    '<div class="mail-reasons">' + Object.keys(MAIL_REASONS).map(k => '<button class="mail-reason' + (mailReason === k ? ' selected' : '') + '" data-r="' + k + '" onclick="mailPickReason(this)">' + MAIL_REASONS[k] + '</button>').join('') + '</div>' +
    '<textarea class="mail-text" id="mailText" maxlength="350" placeholder="Опишите подробно: что случилось, где на сайте, что хотелось бы..."></textarea>' +
    '<div class="mail-count" id="mailCount">Осталось: 350</div>' +
    (mailPhotoUrl ? '<div class="mail-photo"><img src="' + mailPhotoUrl + '" alt=""><span>Фото уйдёт вместе с сообщением</span><button onclick="mailPhotoClear()" aria-label="Убрать фото">' + icon('i-close', 'ic-s') + '</button></div>' : '') +
    '<div class="mail-actions"><button class="mail-clip' + (mailPhotoUrl ? ' has' : '') + '" onclick="mailPickPhoto()" aria-label="Прикрепить фото">' + icon('i-clip') + '</button><button class="cta-btn" id="mailSend" onclick="mailSend()">Отправить</button>' +
    '<button class="cta-btn ghost" onclick="closeMailPop()">Закрыть</button></div>' +
    '<div class="recent" id="mailHint"></div>';
  const ta = document.getElementById('mailText');
  if (ta) {
    ta.value = mailTextCache;
    ta.addEventListener('input', () => { mailTextCache = ta.value; mailCount(); mailGate(); });
    mailCount();
  }
  mailGate();
}
function mailCount() {
  const ta = document.getElementById('mailText');
  const c = document.getElementById('mailCount');
  if (!ta || !c) return;
  const left = 350 - ta.value.length;
  c.textContent = ta.value.length ? 'Осталось: ' + left : 'Осталось: 350';
  c.classList.toggle('low', left <= 30);
}
function mailPickReason(btn) {
  mailReason = btn.dataset.r;
  btn.parentNode.querySelectorAll('.mail-reason').forEach(b => b.classList.toggle('selected', b === btn));
  mailGate();
}
function mailGate() {
  const btn = document.getElementById('mailSend');
  const hint = document.getElementById('mailHint');
  if (!btn) return;
  const ta = document.getElementById('mailText');
  const ok = tgLinked && !!mailReason && !!(ta && ta.value.trim());
  btn.disabled = !ok;
  if (hint) hint.textContent = !tgLinked ? 'Отправка откроется после привязки к боту — иначе нам некуда будет ответить.' : (!mailReason ? 'Выберите причину обращения.' : (!(ta && ta.value.trim()) ? 'Пара слов по делу — и можно отправлять.' : ''));
}
function tgConnectMail() {
  tgConnect();
  const refresh = () => {
    const back = document.getElementById('mailBack');
    const pop = document.getElementById('mailPop');
    if (back && pop && back.classList.contains('open') && !pop.querySelector('.poll-thanks')) renderMailPop();
  };
  setTimeout(refresh, 5000);
  setTimeout(refresh, 20000);
}
// === Фото к обращению: скрепка внизу окна ===
// Фото сжимаем на устройстве (до 1280px, JPEG 72%) и кладём в Storage
// (бакет driver-photos, см. SQL). В текст сообщения боту дописываем
// ссылку — новый параметр rpc не нужен. Не залилось — шлём без фото.
let mailPhotoUrl = null;
function mailPickPhoto() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) mailCompress(f); };
  inp.click();
}
function mailCompress(f) {
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      const k = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(b => { if (b) mailUpload(b); }, 'image/jpeg', 0.72);
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(f);
}
async function mailUpload(blob) {
  const name = deviceId + '_' + Date.now() + '.jpg';
  try {
    const r = await fetch(SUPABASE_URL + '/storage/v1/object/driver-photos/' + name, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'image/jpeg' },
      body: blob
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    mailPhotoUrl = SUPABASE_URL + '/storage/v1/object/public/driver-photos/' + name;
    renderMailPop();
  } catch (e) { alert('Фото не прикрепилось (бакет или связь). Сообщение уйдёт без фото.'); }
}
function mailPhotoClear() { mailPhotoUrl = null; renderMailPop(); }
async function mailSend() {
  const ta = document.getElementById('mailText');
  const btn = document.getElementById('mailSend');
  if (!ta || !mailReason || !tgLinked || btn.disabled) return;
  const text = ta.value.trim();
  if (!text) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Отправляю...';
  let alias = null;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/driver_msg_send', {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_device: deviceId, p_reason: mailReason, p_text: text + (mailPhotoUrl ? '\n\n📷 Фото: ' + mailPhotoUrl : '') })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    alias = await r.json();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    alert('Не удалось отправить. Проверьте связь и попробуйте ещё раз.');
    return;
  }
  mailTextCache = '';
  mailReason = null;
  mailPhotoUrl = null;
  const pop = document.getElementById('mailPop');
  if (pop) pop.innerHTML = '<div class="poll-thanks"><div class="big">Отправлено! 🙏</div>' +
    '<div class="pct">Вы — Водитель #' + alias + '. Разработчик увидит обращение в ближайшие минуты, ответ придёт в ваш Телеграм через бота.</div>' +
    '<div class="poll-actions"><button class="cta-btn" onclick="closeMailPop()">Отлично</button></div></div>';
}
function tickClock() {
  const el = document.getElementById('p1Time');
  if (el) { const d = new Date(); el.textContent = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
}
// === Мгновенный вход: последний снимок из телефона показываем СРАЗУ ===
// Есть снимок — данные на экране без капли и без ожидания сети; сеть
// молча обновляет цифры фоном. Нет снимка (первый заход) — капля как раньше.
(function instantCacheRender() {
  const c = loadCache();
  if (!c || !(c.lastObs || []).length) return; // снимок без отметок не помогает: честная загрузка с каплей, а не пустой экран
  applyCache(c);
  window.__cacheRendered = true;
  detectUserCity();
  try {
    renderStations(cityStationList());
    renderHeat();
    lastWaveStats = allWaveEvents.length ? cityWaveStats() : null;
    renderWave();
    updateMapPlate();
    renderHero();
    setTagline(currentPanel);
    renderBootLiveStations();
  } catch (e) { console.log('мгновенный снимок: ' + e.message); }
  // плашку «данные на ЧЧ:ММ» показываем только если сеть не успела за 4 сек
  setTimeout(() => { if (!window.__netOk && !offlineMode) showOfflineBar(c.t); }, 4000);
  // капли не будет вовсе: данные уже на экране
  const bb = document.getElementById('bootBack');
  if (bb) bb.style.display = 'none';
  bootOver = true;
})();
// === Слим-бар: постоянная шапка ===
// Инициализация сразу, без таймера
function initSlimBar() {
  document.body.classList.add('slim-on'); // Добавляем отступ сверху для контента
  updateSlimBar();
  checkServerHealth();
  setInterval(checkServerHealth, 30000); // Пинг сервера каждые 30 сек
}

function updateSlimBar() {
  const vEl = document.getElementById('slimVersion');
if (vEl && typeof KB_VERSION !== 'undefined') {
const m = KB_VERSION.match(/^v\d+\./);
const head = m ? m[0] : KB_VERSION;
const tail = m ? KB_VERSION.slice(head.length) : '';
vEl.innerHTML = '<i class="slim-vh">' + head + '</i><i class="slim-vt">' + tail + '</i>';
}
  updateSlimForecast();
  updateSlimBellBadge();
  updateSlimGeoStatus(); // Обновляем цвет иконки гео
}

// --- Гео: зелёный/красный ---
function updateSlimGeoStatus() {
  const btn = document.getElementById('slimGeo');
  if (!btn) return;
  // geoFailed = true если GPS не ответил. geoSuspect = true если глушилки/прыжок.
  // manualMode = ручная точка (считаем ок, если пользователь сам поставил).
  const isOk = !geoFailed && !geoSuspect; 
  
  if (isOk) {
    btn.classList.remove('geo-err');
    btn.classList.add('geo-ok');
  } else {
    btn.classList.remove('geo-ok');
    btn.classList.add('geo-err');
  }
}

// --- Прогнозы: скролл к Топ-3 ---
function updateSlimForecast() {
  const el = document.getElementById('slimForecast');
  if (!el) return;
  if (!allPredictions.length || !allStations.length) { el.style.display = 'none'; return; }
  
  const cityIds = new Set(cityStationList().map(s => s.id));
  const pending = allPredictions.filter(p => p.result === 'PENDING' && cityIds.has(p.station_id));
  
  if (pending.length) {
    el.style.display = '';
    el.innerHTML = icon('i-clock', 'ic-s') + ' ' + pending.length + ' окон';
  } else {
    el.style.display = 'none';
  }
}

function scrollToTop3() {
  // 1. Переключаемся на главную панель (индекс 1)
  pagerGo(1);
  
  // 2. Ждем немного, пока панель доедет, и скроллим внутри неё к блоку .top3
  setTimeout(() => {
    const panels = document.querySelectorAll('.panel');
    const mainPanel = panels[1]; // Вторая панель (Главная)
    if (!mainPanel) return;
    
    const target = mainPanel.querySelector('.top3');
    if (target) {
      // Скроллим контейнер панели (panel-scroll или сама panel)
      // В текущей верстке скроллится .panel.p1 или .panel-scroll внутри неё
      const scrollContainer = mainPanel.querySelector('.panel-scroll') || mainPanel;
      
      // Вычисляем позицию с учетом отступа сверху
      const topPos = target.offsetTop - 60; 
      scrollContainer.scrollTo({ top: topPos, behavior: 'smooth' });
    }
  }, 400); // 400мс задержка на анимацию свайпа пейджера
}

// --- Уведомления (логика та же) ---
function updateSlimBellBadge() {
  const btn = document.getElementById('slimBell');
  if (!btn) return;
  
  // Узнаем, когда пользователь последний раз открывал уведомления
  let lastView = 0;
  try { lastView = Number(localStorage.getItem('kbLastNotifView') || 0); } catch (e) {}
  
  const events = getFavoriteEvents();
  // Показываем красную точку, только если есть события, которые случились ПОСЛЕ последнего просмотра
  const hasNew = events.length > 0 && new Date(events[0].detected_at).getTime() > lastView;
  
  btn.classList.toggle('has-news', hasNew);
}

function getFavoriteEvents() {
  const favs = getFavorites();
  if (!favs.length) return [];
  const since = Date.now() - 24 * 3600 * 1000;
  const out = [];
  for (const e of allWaveEvents) {
    if (!favs.includes(e.station_id)) continue;
    if (new Date(e.detected_at).getTime() < since) continue;
    out.push(e);
  }
  for (const f of allFeedback) {
    if (!favs.includes(f.station_id)) continue;
    if (new Date(f.created_at).getTime() < since) continue;
    if (f.feedback_type === 'available' || f.feedback_type === 'unavailable') {
      out.push({ station_id: f.station_id, fuel_type: f.fuel_type, detected_at: f.created_at,
                 event_type: f.feedback_type === 'available' ? 'fuel_restored' : 'fuel_disappeared', source: 'folk' });
    }
  }
  out.sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));
  return out.slice(0, 12);
}

function getRecommendedStations() {
  const since = Date.now() - 24 * 3600 * 1000;
  const city = cityStationList();
  const loc = loadUserLocation();
  const active = [];
  for (const st of city) {
    const hasEv = allWaveEvents.some(e => e.station_id === st.id && new Date(e.detected_at).getTime() >= since);
    const hasFb = allFeedback.some(f => f.station_id === st.id && new Date(f.created_at).getTime() >= since);
    if (!hasEv && !hasFb) continue;
    let dist = null;
    if (loc && Number.isFinite(Number(st.lat))) {
      const dLat = (Number(st.lat) - loc.lat) * 111;
      const dLon = (Number(st.lon) - loc.lon) * 111 * Math.cos(loc.lat * Math.PI / 180);
      dist = Math.sqrt(dLat * dLat + dLon * dLon);
    }
    active.push({ st: st, dist: dist });
  }
  active.sort((a, b) => (a.dist === null ? 999 : a.dist) - (b.dist === null ? 999 : b.dist));
  return active.slice(0, 5);
}

function renderSlimNotif() {
  const el = document.getElementById('slimNotif');
  if (!el) return;
  const favs = getFavorites();

    if (favs.length) {
    const events = getFavoriteEvents();
    let html = '<div class="slim-notif-t">' + icon('i-bell') + 'Уведомления по избранным</div>';
    if (!events.length) {
      html += '<div class="slim-notif-empty">За последние 24 часа по вашим АЗС событий не было.<br>Загляните позже — мы следим.</div>';
    } else {
      html += events.map(e => {
        const st = stationById(e.station_id);
        const name = st ? (st.name || 'АЗС') : 'АЗС';
        const address = (st && st.address) ? escapeHtml(st.address) : '';
        const isR = e.event_type === 'fuel_restored';
        const cls = isR ? 'g' : 'r';
        const ico = isR ? 'i-check' : 'i-cross';
        const fuelTxt = e.fuel_type ? fuelLabel(e.fuel_type) : 'Топливо';
        const verb = isR ? 'вернулось' : 'пропало';
        const d = new Date(e.detected_at);
        const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        const src = e.source === 'folk' ? 'водители' : 'источник';
        
        return '<div class="sn-row" onclick="openSheet(\'' + e.station_id + '\');closeSlimNotif()">' +
          '<span class="sn-ico ' + cls + '">' + icon(ico) + '</span>' +
          '<span class="sn-txt"><b>' + escapeHtml(name) + '</b><span>' + (address ? address + ' · ' : '') + fuelTxt + ' ' + verb + ' · ' + src + '</span></span>' +
          '<span class="sn-time">' + hm + '</span></div>';
      }).join('');
    }
    el.innerHTML = html;
  } else {
    const recs = getRecommendedStations();
    let html = '<div class="slim-notif-t">' + icon('i-spark') + 'Рекомендации рядом</div>';
    if (!recs.length) {
      html += '<div class="slim-notif-empty">Нет активных АЗС за 24 ч в вашем городе.<br>Добавьте АЗС в избранное, чтобы получать уведомления.</div>';
    } else {
      html += recs.map(r => {
        const st = r.st;
        const distTxt = r.dist !== null ? (r.dist < 1 ? Math.round(r.dist * 1000) + ' м' : r.dist.toFixed(1) + ' км') : '';
        return '<div class="sn-row" onclick="openSheet(\'' + st.id + '\');closeSlimNotif()">' +
          '<span class="sn-ico b">' + icon('i-pump') + '</span>' +
          '<span class="sn-txt"><b>' + escapeHtml(st.name || 'АЗС') + '</b><span>' + escapeHtml(st.address || '') + (distTxt ? ' · ' + distTxt : '') + '</span></span>' +
          '<span class="sn-time">' + icon('i-heart', 'ic-s') + '</span></div>';
      }).join('');
      html += '<div class="sn-fav-hint">' + icon('i-heart') + 'Нажмите на АЗС и добавьте в избранное (сердечко), чтобы получать уведомления о топливе прямо сюда.</div>';
    }
    el.innerHTML = html;
  }
}

function toggleSlimNotif() {
  if (slimNotifOpen) { closeSlimNotif(); return; }
  
  renderSlimNotif();
  slimNotifOpen = true;
  
  // ЗАПОМИНАЕМ ВРЕМЯ ПРОСМОТРА: сохраняем "сейчас" в память
  try { localStorage.setItem('kbLastNotifView', String(Date.now())); } catch (e) {}
  
  // Сразу же обновляем иконку, чтобы красная точка мгновенно пропала
  updateSlimBellBadge();
  
  const back = document.getElementById('slimNotifBack');
  const panel = document.getElementById('slimNotif');
  if (back) back.classList.add('open');
  if (panel) panel.classList.add('open');
}

function closeSlimNotif() {
  slimNotifOpen = false;
  const back = document.getElementById('slimNotifBack');
  const panel = document.getElementById('slimNotif');
  if (back) back.classList.remove('open');
  if (panel) panel.classList.remove('open');
}
let slimNotifOpen = false;

// --- Статус сервера ---
let slimDropPrev = null; // 'ok' / 'err': попап только при СМЕНЕ состояния
function slimDropToast(kind) {
const bad = kind === 'err';
let t = document.getElementById('slimDropToast');
if (!t) {
t = document.createElement('div');
t.id = 'slimDropToast';
t.style.cssText = 'position:fixed;left:50%;top:calc(60px + env(safe-area-inset-top));transform:translate(-50%,-10px);z-index:93;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:14px;font-size:11px;font-weight:800;box-shadow:0 12px 30px rgba(15,27,51,.25);opacity:0;pointer-events:none;transition:opacity .3s ease, transform .3s cubic-bezier(.2,.8,.2,1);max-width:calc(100vw - 32px);';
document.body.appendChild(t);
}
t.style.background = bad ? '#fdecec' : '#e5f8ef';
t.style.color = bad ? '#c2403f' : '#12855c';
t.style.border = '1px solid ' + (bad ? '#f3b7b3' : '#bfe8d4');
t.innerHTML = icon(bad ? 'i-cross' : 'i-check', 'ic-s') + '<span>' + (bad ? 'Соединение плохое — сервер не отвечает' : 'Соединение восстановлено') + '</span>';
t.style.opacity = '1';
t.style.transform = 'translate(-50%,0)';
clearTimeout(t._hide);
t._hide = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translate(-50%,-10px)'; }, 4000);
}
async function checkServerHealth() {
const drop = document.getElementById('slimDrop');
if (!drop) return;
let okNow = false;
try {
const ctrl = new AbortController();
const tm = setTimeout(() => ctrl.abort(), 6000);
const r = await fetch(SUPABASE_URL + '/rest/v1/stations?select=id&limit=1', {
headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
signal: ctrl.signal
});
clearTimeout(tm);
okNow = r.ok;
} catch (e) { okNow = false; }
drop.classList.toggle('drop-ok', okNow);
drop.classList.toggle('drop-err', !okNow);
// попап только при переходе: покраснела — предупредили, позеленела — успокоили
if (slimDropPrev !== null && (slimDropPrev === 'ok') !== okNow) slimDropToast(okNow ? 'ok' : 'err');
slimDropPrev = okNow ? 'ok' : 'err';
}

async function slimDropTap() {
  const drop = document.getElementById('slimDrop');
  if (!drop) return;
  drop.style.opacity = '.45';
  await checkServerHealth();
  drop.style.opacity = '';
}
initSlimBar(); // Запускаем шапку сразу
// === Связь: замер скорости на загрузке, лайт-версия при слабом интернете ===
// Лайт = без карт (MapLibre + тайлы = самый тяжёлый трафик) и без декоративных
// анимаций. Данные, прогнозы, отметки и теплокарта — полностью на месте.
// Решение помним на устройстве: '1' — лайт, '0' — отказ (7 дней не спрашиваем).
(function liteCss() {
const st = document.createElement('style');
st.id = 'kbLiteCss';
st.textContent =
'body.kb-lite .lenti-holo,body.kb-lite .lenti-glare,body.kb-lite .lenti-foil,body.kb-lite .lenti-spark,body.kb-lite .lenti-slats{display:none;}' +
'body.kb-lite .panel::before{animation:none;opacity:.2;}' +
'body.kb-lite .why-tap::before,body.kb-lite .why-tap::after{animation:none;}' +
'body.kb-lite .kb-glow{animation:none;opacity:.3;}' +
'body.kb-lite .boot-parts{display:none;}' +
'body.kb-lite .boot-drop-wrap,body.kb-lite .boot-drop-orb-wrap::after,body.kb-lite .boot-drop-orb::before,body.kb-lite .boot-drop-orb::after,body.kb-lite .bd-wave{animation:none;}' +
'body.kb-lite .adv-our{animation:none;}' +
'body.kb-lite .card-halo{animation:none;opacity:.5;}' +
'body.kb-lite .ctm-tile{transition:none;}';
document.head.appendChild(st);
})();
function netProbe() {
const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
if (c && c.saveData) return Promise.resolve({ weak: true, why: 'saveData' });
const et = c ? (c.effectiveType || '') : '';
if (et === 'slow-2g' || et === '2g') return Promise.resolve({ weak: true, why: et });
return new Promise(res => {
const t0 = performance.now();
const ctrl = new AbortController();
const tm = setTimeout(() => { ctrl.abort(); res({ weak: true, why: 'timeout' }); }, 9000);
fetch('icon-512.png?kbprobe=' + Date.now(), { cache: 'no-store', signal: ctrl.signal })
.then(r => {
if (!r.ok) throw new Error('http ' + r.status);
return r.arrayBuffer().then(buf => {
clearTimeout(tm);
const ms = performance.now() - t0;
const kbps = (buf.byteLength || 1) / 1024 / (ms / 1000 || 1) * 8;
res({ weak: ms > 3500 || kbps < 250, ms: Math.round(ms), kbps: Math.round(kbps) });
});
})
.catch(() => { clearTimeout(tm); res({ weak: false, why: 'err' }); }); // не смогли замерить — не пристаём с вопросом
});
}
function litePlaceholder(box) {
if (!box || box.dataset.litePh) return;
box.dataset.litePh = '1';
box.innerHTML = '<div class="status" style="margin:10px">Лайт-режим: карта отключена для экономии трафика.<br><button class="cta-btn" style="width:auto;padding:8px 16px;margin-top:10px">Всё равно загрузить карту</button></div>';
const b = box.querySelector('.cta-btn');
if (b) b.onclick = () => { liteMapOk = true; delete box.dataset.litePh; box.innerHTML = ''; if (box.id === 'mapBox') ensureMap(); else if (box.id === 'miniMapBox') ensureMiniMap(); else mountCardMap(window.__liteCardSt || null); };
}
function liteAsk() {
if (liteAsked) return;
const openNow = ['helloBack', 'installBack', 'pollBack', 'sheetBack', 'wnBack', 'mailBack', 'adviceBack', 'lifeBack'].some(id => {
const el = document.getElementById(id); return el && el.classList.contains('open');
});
if (openNow) { setTimeout(liteAsk, 4000); return; } // не лезем поверх других окон
liteAsked = true;
let back = document.getElementById('liteBack');
if (!back) {
back = document.createElement('div');
back.id = 'liteBack'; back.className = 'hello-back'; back.style.zIndex = '88';
back.onclick = () => liteSet(false);
const pop = document.createElement('div');
pop.id = 'litePop'; pop.className = 'hello-pop'; pop.style.zIndex = '89';
document.body.appendChild(back); document.body.appendChild(pop);
}
const pop = document.getElementById('litePop');
pop.innerHTML = '<div class="hello-title">Соединение слабое</div>' +
'<div class="help-lead" style="margin:6px 0 10px">Интернет сейчас медленнее обычного. Есть лайт-версия сайта: без карты и лишних анимаций — грузится быстрее и экономит трафик. Прогнозы, отметки и тепловая карта остаются на месте.</div>' +
'<button class="cta-btn" onclick="liteSet(true)">Включить лайт-версию</button>' +
'<button class="cta-btn ghost" style="margin-top:6px" onclick="liteSet(false)">Остаться на обычной</button>';
pop.classList.add('open');
back.classList.add('open');
}
function liteSet(on) {
const pop = document.getElementById('litePop');
const back = document.getElementById('liteBack');
if (pop) pop.classList.remove('open');
if (back) back.classList.remove('open');
try {
if (on) { localStorage.setItem('kbLiteMode', '1'); }
else { localStorage.setItem('kbLiteMode', '0'); }
} catch (e) {}
liteMode = !!on;
document.body.classList.toggle('kb-lite', liteMode);
}
setTimeout(() => {
if (liteMode) return; // уже в лайте — не спрашиваем
netProbe().then(r => { if (r.weak) liteAsk(); });
}, 1500);
if (!bootOver) bootStart();
renderBootLiveStations();
const g0 = ++startGen;
start().then(() => {
  if (g0 !== startGen) return;
  bootDataOk = true;
  if (!bootOver) bootDone();
}).catch((e) => {
  if (g0 !== startGen) return;
  console.log('start fail', e);
  bootDataOk = true;
  if (!bootOver) bootDone(); // даже при ошибке не оставляем вечный спиннер
});
track('pageview');
loadPulse().catch(e => console.log('pulse: ' + e.message));
currentPanel = 1;
setTagline(1);
requestAnimationFrame(() => { const pg = document.getElementById('pager'); if (pg) pg.scrollLeft = pg.clientWidth; });
maybeHello();
setTimeout(maybeInstallPop, 1400);
detectUserCity();
tickClock();
refreshLocChip();
setInterval(tickClock, 30000);
// Плашка карты: мягкие края карусели — фейд только с той стороны,
// куда есть куда скроллить; в упоре край чистый, ничего не «обрезано»
(function plateScrollFx() {
  const el = document.getElementById('mapPlate');
  if (!el) return;
  const fx = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('start', el.scrollLeft <= 2);
    el.classList.toggle('end', el.scrollLeft >= max - 2);
  };
  el.addEventListener('scroll', fx, { passive: true });
  window.addEventListener('resize', fx);
  new MutationObserver(fx).observe(el, { childList: true, subtree: true, characterData: true });
  fx();
})();
// Чипы плашки: медленная бегущая строка (~20 px/сек), только на панели карты.
// У края — пауза 1.2 сек и мягко в обратную сторону (пинг-понг); касание или
// колесо на плашке ставит автоскролл на паузу 8 сек, чтобы не воевать с пальцем.
(function plateMarquee() {
  const el = document.getElementById('mapPlate');
  if (!el) return;
  let dir = 1, holdUntil = 0, pauseUntil = 0, last = performance.now();
  const SPEED = 0.02; // px за мс ≈ 20 px/сек
  const HOLD = 1200;
  const touch = () => { pauseUntil = performance.now() + 8000; };
  el.addEventListener('pointerdown', touch, { passive: true });
  el.addEventListener('wheel', touch, { passive: true });
  const tick = now => {
    const dt = Math.min(50, now - last); last = now;
    const max = el.scrollWidth - el.clientWidth;
    if (currentPanel === 2 && max > 4 && now > pauseUntil && now >= holdUntil && !pagerTouching) {
      let x = el.scrollLeft + dir * SPEED * dt;
      if (x >= max) { x = max; dir = -1; holdUntil = now + HOLD; }
      else if (x <= 0) { x = 0; dir = 1; holdUntil = now + HOLD; }
      el.scrollLeft = x;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
// народные голоса живут 60 минут: периодически обновляем открытую карту
setInterval(() => { if (mapObj && currentPanel === 2 && !mapObj.isMoving()) renderMap(); }, 5 * 60 * 1000);
const pagerEl = document.getElementById('pager');
if (pagerEl) pagerEl.addEventListener('scroll', () => {
  closeWhy();
  const i = Math.round(pagerEl.scrollLeft / pagerEl.clientWidth);
  if (i !== currentPanel) { currentPanel = i; setTagline(i); if (i === 2) ensureMap(); track('panel_view', i); }
  document.querySelectorAll('#pagerDots i').forEach((d, k) => d.classList.toggle('on', k === i));
});
// лечение «половинчатого» сдвига: скролл остановился между панелями —
// через 140 мс мягко доводим до ближайшей. Снап мог быть снят подсказкой
// пейджера в первые секунды, теперь залипание чинится само навсегда.
let pagerSettleT = null, pagerTouching = false;
if (pagerEl) {
  pagerEl.addEventListener('pointerdown', () => { pagerTouching = true; document.body.classList.add('is-swiping'); }, { passive: true });
  const endSwipe = () => { pagerTouching = false; document.body.classList.remove('is-swiping'); };
  window.addEventListener('pointerup', endSwipe, { passive: true });
  window.addEventListener('pointercancel', endSwipe, { passive: true });
}
if (pagerEl) pagerEl.addEventListener('scroll', () => {
  clearTimeout(pagerSettleT);
  pagerSettleT = setTimeout(() => {
    if (pagerTouching) return; // палец ещё держит экран: доводчик молчит, snap-back исчез
    const w = pagerEl.clientWidth;
    if (!w) return;
    const i = Math.round(pagerEl.scrollLeft / w);
    if (Math.abs(pagerEl.scrollLeft - i * w) > 8) pagerEl.scrollTo({ left: i * w, behavior: 'smooth' });
  }, 140);
}, { passive: true });
let hintCancelled = false;
(function pagerHint() {
  const pager = document.getElementById('pager');
  if (!pager) return;
  pager.addEventListener('pointerdown', () => { hintCancelled = true; pager.style.scrollSnapType = ''; }, { once: true });
  setTimeout(() => {
    if (hintCancelled) return;
    pager.style.scrollSnapType = 'none';
    pager.scrollTo({ left: Math.round(pager.clientWidth * 1.25), behavior: 'smooth' });
    setTimeout(() => {
      if (hintCancelled) return;
      pager.scrollTo({ left: pager.clientWidth, behavior: 'smooth' });
      setTimeout(() => { pager.style.scrollSnapType = ''; }, 700);
    }, 600);
  }, 900);
})();
// // === мини-навигация: плавающий стеклянный док СВЕРХУ, под slim-баром ===
// Активная вкладка — пилюля с подписью, остальные — компактные иконки.
// Док fixed поверх контента, z-index ниже модалок (sheet 91+), но выше карточек.
const MINI_NAV = [
{ icon: 'i-check',  label: 'Точность', s: 's0' },
{ icon: 'i-chart',  label: 'Главная',  s: 's1' },
{ icon: 'i-pin',    label: 'Карта',    s: 's2' },
{ icon: 'i-pump',   label: 'АЗС',      s: 's3' },
{ icon: 'i-spark',  label: 'Новинки',  s: 's4' }
];

function renderMiniNav() {
const wrap = document.getElementById('mnWrap');
if (!wrap || wrap.dataset.built) return;
wrap.dataset.built = '1';
if (!document.getElementById('mnTabsCss')) {
const st = document.createElement('style');
st.id = 'mnTabsCss';
st.textContent =
/* контейнер — та же стеклянная пилюля, что нравится: не трогаем */
'#mnWrap{position:relative !important;display:flex !important;align-items:center !important;justify-content:center !important;gap:4px !important;padding:2px !important;margin:-4px 0 10px !important;background:rgba(255,255,255,.88) !important;backdrop-filter:blur(22px) saturate(1.5) !important;-webkit-backdrop-filter:blur(22px) saturate(1.5) !important;border:1px solid rgba(255,255,255,.8) !important;border-radius:999px !important;box-shadow:0 10px 30px rgba(20,33,61,.14),0 2px 6px rgba(20,33,61,.05) !important;z-index:1 !important;max-width:calc(100vw - 20px) !important;font-family:inherit !important;}' +
/* кнопка: размер по содержимому (ничего не режется), без цветных подложек */
'#mnWrap .mn-item{flex:0 0 auto !important;min-width:0 !important;display:flex !important;flex-direction:row !important;align-items:center !important;justify-content:center !important;height:40px !important;padding:0 10px !important;border:none !important;outline:none !important;background:transparent !important;background-image:none !important;border-radius:999px !important;cursor:pointer !important;color:#7487a7 !important;box-shadow:none !important;transition:color .25s ease,background .3s ease,box-shadow .3s ease,padding .35s cubic-bezier(.34,1.4,.64,1),transform .15s ease !important;position:relative !important;overflow:hidden !important;font-family:inherit !important;}' +
'#mnWrap .mn-item::before{display:none !important;}' +
'#mnWrap .mn-item:active{transform:scale(.9);}' +
/* иконка: чистый глиф без кружка-плашки и без ч/б фильтра */
'#mnWrap .mn-ico{width:21px !important;height:21px !important;flex:none !important;display:inline-flex !important;align-items:center !important;justify-content:center !important;background:transparent !important;background-image:none !important;box-shadow:none !important;border-radius:0 !important;color:inherit !important;filter:none !important;opacity:1 !important;}' +
'#mnWrap .mn-ico::after{display:none !important;}' +
'#mnWrap .mn-ico svg,#mnWrap .mn-ico .ic{width:100% !important;height:100% !important;display:block !important;}' +
/* подпись: по умолчанию скрыта, у активной разворачивается ВСЁ слово */
'#mnWrap .mn-label{display:inline-block !important;font-size:12px !important;font-weight:800 !important;color:inherit !important;white-space:nowrap !important;letter-spacing:.2px !important;max-width:0 !important;opacity:0 !important;overflow:hidden !important;margin-left:0 !important;text-shadow:none !important;transition:max-width .35s cubic-bezier(.34,1.4,.64,1),opacity .25s ease,margin-left .35s ease !important;}' +
/* активная: глубокая синяя пилюля с внутренним светом и мягкой тенью */
'#mnWrap .mn-item.on{background:linear-gradient(140deg,#4b93ff 0%,#2465ee 55%,#1746c8 100%) !important;color:#fff !important;padding:0 14px !important;box-shadow:0 6px 18px rgba(36,101,238,.38),inset 0 1px 0 rgba(255,255,255,.4),inset 0 -2px 6px rgba(10,40,120,.28) !important;}' +
'#mnWrap .mn-item.on .mn-label{max-width:110px !important;opacity:1 !important;margin-left:7px !important;}' +
/* нажатие на неактивную: лёгкое подсвечивание стекла */
'#mnWrap .mn-item:not(.on):active{background:rgba(20,33,61,.06) !important;color:#33445f !important;}';
document.head.appendChild(st);
}
wrap.innerHTML = MINI_NAV.map((m, i) =>
'<button class="mn-item ' + m.s + '" data-mn="' + i + '" onclick="pagerGo(' + i + ')" aria-label="' + m.label + '">' +
'<span class="mn-ico">' + icon(m.icon) + '</span>' +
'<span class="mn-label">' + m.label + '</span>' +
'</button>').join('');
updateMiniNav(currentPanel);
const pg = document.getElementById('pager');
if (pg && !pg.dataset.mnBound) {
pg.dataset.mnBound = '1';
pg.addEventListener('scroll', () => {
updateMiniNav(Math.round(pg.scrollLeft / pg.clientWidth));
}, { passive: true });
}
}
function updateMiniNav(i) {
  document.querySelectorAll('.mn-item').forEach(b => b.classList.toggle('on', Number(b.dataset.mn) === i));
}
renderMiniNav();
// === ТЕПЛОКАРТА ГОРОДА (treemap в стиле Coin360, но в нашей палитре) ===
// Плитка = АЗС города. Размер и яркость = активность с 00:00 МСК
// (источник +2 за событие, народ +3 за отметку, живая очередь и свежий
// снимок — бонусы в живой точке). Цвет = топливо сейчас. Процент = доля
// активности города, сидит в правом нижнем углу плитки.
// Тап по плитке = карточка АЗС. Снизу — плеер суток: ползунок 00:00→сейчас,
// автопроигрывание один раз показывает, как плитки росли в течение дня.
const CTM_CSS =
'.ctm-card{margin:10px 0 12px;background:linear-gradient(165deg,#fdfeff,#eef4ff);border-radius:18px;padding:10px 10px 8px;box-shadow:0 2px 10px rgba(20,33,61,.06);}' +
'.ctm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin:0 2px 8px;}' +
'.ctm-head-t{display:flex;flex-direction:column;gap:2px;align-items:flex-start;min-width:0;}' +
'.ctm-why{flex:0 0 auto;margin-top:2px;display:inline-flex;align-items:center;gap:4px;border:1px solid #e6ebf4;background:rgba(255,255,255,.85);color:#5b6b86;border-radius:99px;padding:5px 10px;font-size:9px;font-weight:800;cursor:pointer;font-family:inherit;}' +
'.ctm-why .ic{width:11px;height:11px;color:#2465ee;}' +
'.ctm-title{font-size:13px;font-weight:800;color:#14213d;white-space:nowrap;}' +
'.ctm-sub{font-size:10px;color:#71809c;font-weight:700;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;}' +
'.ctm-body{position:relative;height:230px;border-radius:14px;overflow:hidden;background:#f4f7fb;}' +
'.ctm-tile{position:absolute;border-radius:12px;overflow:hidden;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.30),inset 0 1px 0 rgba(255,255,255,.22);transition:left .8s cubic-bezier(.2,.8,.2,1),top .8s cubic-bezier(.2,.8,.2,1),width .8s,height .8s,background .8s;}' +
'.ctm-tile::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0) 46%);pointer-events:none;}' +
'.ctm-playing .ctm-tile{transition:left .16s linear,top .16s linear,width .16s linear,height .16s linear,background .16s linear;}' +
'.ctm-in{position:absolute;inset:0;padding:6px 7px;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;gap:3px;min-width:0;}' +
'.ctm-stamp{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}' +
'.ctm-stamp img{width:80%;height:80%;object-fit:contain;opacity:.20;filter:saturate(.85);}' +
'.ctm-a{position:relative;font-size:8.5px;font-weight:800;opacity:.85;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}' +
'.ctm-rows{position:relative;align-self:stretch;display:flex;flex-direction:column;gap:2px;align-items:flex-start;min-width:0;padding-right:34px;overflow:hidden;}' +
'.ctm-tile.ctm-fs .ctm-row{font-size:7.5px;gap:3px;}' +
'.ctm-tile.ctm-fs .ctm-row .ic{width:9px;height:9px;}' +
'.ctm-tile.ctm-fs .ctm-rows{padding-right:26px;gap:1px;}' +
'.ctm-tile.ctm-fs .ctm-a{font-size:7px;}' +
'.ctm-tile.ctm-fs .ctm-p{font-size:11px;right:5px;bottom:4px;}' +
'.ctm-tile.ctm-fs .ctm-p.small{font-size:9px;}' +
'.ctm-tile.ctm-fl .ctm-row{font-size:10px;gap:5px;}' +
'.ctm-tile.ctm-fl .ctm-row .ic{width:13px;height:13px;}' +
'.ctm-tile.ctm-fl .ctm-rows{padding-right:42px;gap:3px;}' +
'.ctm-tile.ctm-fl .ctm-a{font-size:9px;}' +
'.ctm-tile.ctm-fl .ctm-p{font-size:17px;}' +
'.ctm-row{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:900;letter-spacing:-.2px;white-space:nowrap;font-variant-numeric:tabular-nums;}' +
'.ctm-v{font-style:normal;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.ctm-row .ic{width:15px;height:15px;flex:none;opacity:.95;}' +
'.ctm-p{position:absolute;right:6px;bottom:5px;font-size:15px;font-weight:900;line-height:1;letter-spacing:-.5px;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(20,33,61,.15);}' +
'.ctm-p.small{font-size:10px;letter-spacing:-.2px;}' +
'.ctm-player{display:flex;align-items:center;gap:8px;margin:10px 2px 2px;}' +
'.ctm-play{width:30px;height:30px;border-radius:50%;border:0;background:#397cff;color:#fff;font-size:11px;font-weight:800;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(57,124,255,.35);}' +
'.ctm-track{position:relative;flex:1;height:6px;border-radius:99px;background:#dfe6f2;cursor:pointer;touch-action:none;}' +
'.ctm-fill{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:linear-gradient(90deg,#7db4ff,#397cff);}' +
'.ctm-thumb{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid #397cff;transform:translate(-50%,-50%);box-shadow:0 2px 6px rgba(20,33,61,.25);pointer-events:none;}' +
'.ctm-time{font-size:10px;font-weight:800;color:#71809c;min-width:52px;text-align:right;flex:none;}' +
'.ctm-note{margin:6px 2px 0;font-size:9.5px;color:#8aa0b8;font-weight:600;}' +
'.ctm-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:#8aa0b8;font-weight:700;}' +
'.pl-city{color:#2465ee;font-weight:800;}';
let ctmDay = null;            // {since, nowMs, perSt:{id:[{t,w,folk}]}}
let ctmTileEls = {};          // живые DOM-плитки по id станции (для морфинга)
let ctmPlay = { playing: false, t: 0, raf: 0 };
let ctmAutoPlayed = false;
let ctmCurT = null;           // null = живая точка (сейчас)
function ctmSinceMs() {
  const m = new Date(Date.now() + 3 * 3600 * 1000);
  return Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()) - 3 * 3600 * 1000;
}
function ctmMskHM(t) {
  const d = new Date(t + 3 * 3600 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
function ctmEvWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return n + ' событие';
  const d = n % 10, h = n % 100;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return n + ' события';
  return n + ' событий';
}
function ctmRgba(hex, al) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + al.toFixed(3) + ')';
}
// события суток из единой ленты allEvents7 (source говорит, кто отметился)
function ctmBuildDay() {
  const since = ctmSinceMs();
  const nowMs = Date.now();
  const perSt = {};
  for (const e of allEvents7) {
    const t = new Date(e.detected_at).getTime();
    if (t < since || t > nowMs) continue;
    const folk = e.source === 'user_feedback';
    (perSt[e.station_id] = perSt[e.station_id] || []).push({ t: t, w: folk ? 3 : 2, folk: folk });
  }
  ctmDay = { since: since, nowMs: nowMs, perSt: perSt };
}
function ctmWeightAt(id, T) {
  let a = 0.6, ev = 0;
  const list = (ctmDay && ctmDay.perSt[id]) || null;
  if (list) for (const x of list) if (x.t <= T) { a += x.w; ev++; }
  return { a: a, ev: ev };
}
function ctmCityActs(T, live) {
  const city = cityStationList();
  const last = getLastObservations();
  return city.map(st => {
    const w = ctmWeightAt(st.id, T);
    let a = w.a;
    if (live) {
      const lq = liveQueueCount(st.id);
      if (lq) a += 2 + lq;
      const o = last[st.id];
      if (o && obsFresh(o)) a += 1;
    }
    return { st: st, o: last[st.id], a: a, ev: w.ev };
  });
}
// squarified treemap: плитки стремятся к квадратам, крупные — к левому верху
function ctmTreemap(items, W, H) {
  const sorted = items.slice().sort((a, b) => b.w - a.w);
  const total = sorted.reduce((s, i) => s + i.w, 0) || 1;
  const scale = (W * H) / total;
  const out = [];
  let x = 0, y = 0, w = W, h = H, i = 0;
  const worst = (row, sum, side) => {
    const thick = (sum * scale) / side;
    let mx = 0;
    for (const it of row) {
      const len = (it.w * scale) / thick;
      const r = Math.max(thick / len, len / thick);
      if (r > mx) mx = r;
    }
    return mx;
  };
  while (i < sorted.length && w > 0 && h > 0) {
    const side = Math.min(w, h);
    let row = [sorted[i]], sum = sorted[i].w, best = worst(row, sum, side), j = i + 1;
    while (j < sorted.length) {
      const c = worst(row.concat(sorted[j]), sum + sorted[j].w, side);
      if (c <= best) { row.push(sorted[j]); sum += sorted[j].w; best = c; j++; } else break;
    }
    const thick = (sum * scale) / side;
    if (w >= h) {
      let yy = y;
      for (const it of row) { const len = (it.w * scale) / thick; out.push({ x: x, y: yy, w: thick, h: len, ref: it.ref }); yy += len; }
      x += thick; w -= thick;
    } else {
      let xx = x;
      for (const it of row) { const len = (it.w * scale) / thick; out.push({ x: xx, y: y, w: len, h: thick, ref: it.ref }); xx += len; }
      y += thick; h -= thick;
    }
    i = j;
  }
  return out;
}
function ctmOpen(id) {
  track('open_station_card', null, id);
  learnFromAction(id, 'card_open');
  openSheet(id);
}
function ctmGeoKm(st) {
try {
if (!st || st.lat == null || st.lon == null) return null;
const g = loadUserLocation(); // родная точка приложения: GPS или ручная под глушилками
if (!g) return null;
const R = 6371, r = Math.PI / 180;
const dLa = (st.lat - g.lat) * r, dLo = (st.lon - g.lon) * r;
const a = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(g.lat * r) * Math.cos(st.lat * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
} catch (e) { return null; }
}
function ctmTileInner(b, x, pct, word, tier) {
const p = '<span class="ctm-p' + (b === 3 ? '' : ' small') + '">' + pct + '%</span>';
if (b <= 0) return '';
const bk = brandKey(x.st);
const stamp = (bk && BRAND_LOGOS[bk]) ? '<span class="ctm-stamp"><img src="' + BRAND_LOGOS[bk] + '" alt=""></span>' : '';
const addr = '<span class="ctm-a">' + escapeHtml(x.st.address || x.st.name || 'АЗС') + '</span>';
if (b === 1) return '<span class="ctm-in">' + stamp + '</span>' + p;
const pred = pickPrediction(x.st.id, x.o);
const winR = (pred && pred.from_time) ? '<span class="ctm-row">' + icon('kb-win') + '<i class="ctm-v">' + time5(pred.from_time) + '–' + time5(pred.to_time) + '</i></span>' : '';
const evR = x.ev > 0 ? '<span class="ctm-row">' + icon('kb-ev') + '<i class="ctm-v">' + x.ev + '</i></span>' : '';
const km = ctmGeoKm(x.st);
const kmR = km != null ? '<span class="ctm-row">' + icon('kb-km') + '<i class="ctm-v">' + (km < 10 ? km.toFixed(1) : Math.round(km)) + '</i></span>' : '';
const order = tier === 's' ? [evR, kmR, winR] : [winR, evR, kmR];
const rows = b === 3 ? order.filter(Boolean).slice(0, tier === 's' ? 2 : 3) : [evR, kmR, winR].filter(Boolean).slice(0, 1);
return '<span class="ctm-in">' + stamp + addr + (rows.length ? '<span class="ctm-rows">' + rows.join('') + '</span>' : '') + '</span>' + p;
}
function ctmPaintPlayer(T, live, citySet) {
  const span = (ctmDay.nowMs - ctmDay.since) || 1;
  const frac = Math.max(0, Math.min(1, (T - ctmDay.since) / span));
  const fill = document.getElementById('ctmFill');
  const thumb = document.getElementById('ctmThumb');
  const time = document.getElementById('ctmTime');
  const sub = document.getElementById('ctmSub');
  if (fill) fill.style.width = (frac * 100).toFixed(2) + '%';
  if (thumb) thumb.style.left = (frac * 100).toFixed(2) + '%';
  if (time) time.textContent = live ? ctmMskHM(ctmDay.nowMs) : ctmMskHM(T);
  if (sub) {
    let tot = 0, folk = 0, upto = 0;
    for (const id of citySet) {
      const list = ctmDay.perSt[id];
      if (!list) continue;
      for (const x of list) { tot++; if (x.folk) folk++; if (x.t <= T) upto++; }
    }
    sub.textContent = live
      ? 'с 00:00 · всего ' + tot + ' · народ ' + folk + (tot ? ' (' + Math.round(100 * folk / tot) + '%)' : '')
      : 'на ' + ctmMskHM(T) + ' · событий с 00:00: ' + upto;
  }
}
function ctmPaint(T, live) {
  const body = document.getElementById('ctmBody');
  if (!body || !ctmDay) return;
  if (body.querySelector('.ctm-empty')) { body.innerHTML = ''; ctmTileEls = {}; }
  const city = cityStationList();
  const acts = ctmCityActs(T, live);
  if (!acts.length) { body.innerHTML = '<div class="ctm-empty">город ещё не определён</div>'; ctmTileEls = {}; return; }
  const W = body.clientWidth || 340, H = body.clientHeight || 230;
const total = acts.reduce((s, x) => s + x.a, 0) || 1;
// плитки мельче 5% активности города не рисуем вовсе: хвост из
// однопроцентных огрызков превращал мозаику в шум. Проценты честные —
// от всей активности города, поэтому видимые плитки не обязаны давать 100%.
let shown = acts.filter(x => (100 * x.a / total) >= 5);
// вдруг всё мельче 5% (ровный тихий день) — держим топ-4, карта не пустеет
if (shown.length < 4) shown = acts.slice().sort((a, b) => b.a - a.a).slice(0, 4);
const rects = ctmTreemap(shown.map(x => ({ w: Math.max(0.6, x.a), ref: x })), W, H);
const maxA = Math.max(...shown.map(x => x.a)) || 1;
  const WORD = { yes: 'топливо', part: 'АИ-92', diesel: 'дизель', no: 'нет', conflict: 'спорно', unknown: 'молчит' };
  const seen = {};
  for (const r of rects) {
    const x = r.ref, id = x.st.id;
    seen[id] = 1;
    let el = ctmTileEls[id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'ctm-tile';
      el.onclick = (function (sid) { return function () { ctmOpen(sid); }; })(id);
      body.appendChild(el);
      ctmTileEls[id] = el;
    }
    const pct = Math.round(100 * x.a / total);
    const area = r.w * r.h;
    const key = effPinKey(x.st, x.o);
    const col = PIN_COL[key] || PIN_COL.unknown;
    const al = 0.28 + 0.72 * Math.pow(x.a / maxA, 0.7);
    el.style.left = r.x.toFixed(1) + 'px';
    el.style.top = r.y.toFixed(1) + 'px';
    el.style.width = Math.max(0, r.w - 3).toFixed(1) + 'px';
    el.style.height = Math.max(0, r.h - 3).toFixed(1) + 'px';
    el.style.background = ctmRgba(col, al);
    el.style.color = al < 0.5 ? '#14213d' : '#fff';
    const b = area > 5200 ? 3 : area > 2600 ? 2 : area > 1200 ? 1 : area > 420 ? 0 : -1;
const word = WORD[key] || '';
const winP = pickPrediction(x.st.id, x.o);
// калибр по живому размеру плитки: узкая мельче, широкая крупнее
const tier = (r.w < 82 || r.h < 62) ? 's' : (r.w >= 112 && r.h >= 92) ? 'l' : 'm';
el.classList.toggle('ctm-fs', tier === 's');
el.classList.toggle('ctm-fl', tier === 'l');
const sig = b + '|' + tier + '|' + x.ev + '|' + pct + '|' + (winP ? winP.from_time : '-') + '|' + word + '|' + (ctmGeoKm(x.st) || 0).toFixed(1);
if (el.dataset.sig !== sig) {
el.dataset.sig = sig;
el.innerHTML = ctmTileInner(b, x, pct, word, tier);
} else {
const p = el.querySelector('.ctm-p'); if (p) p.textContent = pct + '%';
}
  }
  for (const id of Object.keys(ctmTileEls)) if (!seen[id]) { ctmTileEls[id].remove(); delete ctmTileEls[id]; }
  ctmPaintPlayer(T, live, new Set(city.map(s => s.id)));
}
function ctmStopPlay() {
  ctmPlay.playing = false;
  if (ctmPlay.raf) cancelAnimationFrame(ctmPlay.raf);
  ctmPlay.raf = 0;
  const card = document.getElementById('ctmCard'); if (card) card.classList.remove('ctm-playing');
  const btn = document.getElementById('ctmPlay'); if (btn) btn.textContent = '▶';
}
function ctmStartPlay(fromT) {
  if (!ctmDay) return;
  const card = document.getElementById('ctmCard'); if (card) card.classList.add('ctm-playing');
  const btn = document.getElementById('ctmPlay'); if (btn) btn.textContent = '❚❚';
  ctmPlay.playing = true;
  ctmPlay.t = fromT;
  const span = (ctmDay.nowMs - ctmDay.since) || 1;
  let prevTs = null;
  const step = ts => {
    if (!ctmPlay.playing) return;
    if (prevTs === null) prevTs = ts;
    const dt = Math.min(100, ts - prevTs); prevTs = ts;
    ctmPlay.t += span * (dt / 25000); // сутки проигрываются за 25 секунд — спокойно и читаемо
    if (ctmPlay.t >= ctmDay.nowMs) { ctmStopPlay(); renderCityTreemap(); return; }
    ctmCurT = ctmPlay.t;
    ctmPaint(ctmPlay.t, false);
    ctmPlay.raf = requestAnimationFrame(step);
  };
  ctmPlay.raf = requestAnimationFrame(step);
}
function ctmTogglePlay() {
  if (ctmPlay.playing) { ctmStopPlay(); return; }
  const from = (ctmCurT !== null && ctmCurT < ctmDay.nowMs - 60000) ? ctmCurT : ctmDay.since;
  ctmStartPlay(from);
}
function ctmScrub(clientX) {
  const tr = document.getElementById('ctmTrack');
  if (!tr || !ctmDay) return;
  const r = tr.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const T = ctmDay.since + f * (ctmDay.nowMs - ctmDay.since);
  ctmCurT = T;
  ctmPaint(T, false);
}
function mountCityTreemap() {
  if (document.getElementById('ctmCard')) return;
  const lb = document.getElementById('lentiBox');
  if (!lb || !lb.parentNode) return;
  const card = document.createElement('div');
  card.className = 'ctm-card'; card.id = 'ctmCard';
  card.innerHTML = '<div class="ctm-head"><div class="ctm-head-t"><div class="ctm-title">Тепловая карта города</div><div class="ctm-sub" id="ctmSub">считаем…</div></div>' +
'<button class="ctm-why" onclick="openWhyChip(this,\'ctm\')" aria-label="Что это?">' + icon('i-help', 'ic-s') + 'Что это?</button></div>' +
'<div class="ctm-body" id="ctmBody"></div>';
  lb.parentNode.insertBefore(card, lb.nextSibling);
}
function renderCityTreemap() {
  const body = document.getElementById('ctmBody');
  if (!body) return;
  ctmStopPlay();
  ctmCurT = null;
  ctmBuildDay();
  if (!cityStationList().length) { body.innerHTML = '<div class="ctm-empty">город ещё не определён</div>'; ctmTileEls = {}; return; }
  ctmPaint(ctmDay.nowMs, true);
}
// Род города для заголовка «Лента событий …»: Новороссийск → Новороссийска
function cityGenitive() {
  const G = { novorossiysk: 'Новороссийска', gelendzhik: 'Геленджика', anapa: 'Анапы', krymsk: 'Крымска', krasnodar: 'Краснодара', sochi: 'Сочи', tuapse: 'Туапсе', armavir: 'Армавира', maykop: 'Майкопа', rostov: 'Ростова-на-Дону', stavropol: 'Ставрополя' };
  return G[userCityKey] || userCityName();
}
// Перестановка главной панели: линза встаёт на место слогана
// «Данными. Не догадками.» (слоган скрываем), теплокарта остаётся
// на бывшем месте линзы внутри карточки ленты.
function ctmRelayout() {
  const lb = document.getElementById('lentiBox');
  const ts = document.getElementById('tagSlogan');
  if (!lb || !ts || lb.dataset.moved) return;
  const wrap = ts.parentNode;
  if (!wrap || !wrap.parentNode) return;
  lb.dataset.moved = '1';
  wrap.style.display = 'none';
  wrap.parentNode.insertBefore(lb, wrap);
  
  // Возвращаем как было в оригинале
  lb.style.marginBottom = '0';
  
  const mn = document.getElementById('mnWrap');
  if (mn) { 
    mn.style.marginTop = '-6px'; 
    mn.style.paddingTop = '0'; 
  }
}
// === ЛИНЗА: тоньше + ночной свет билборда (исправлено) ===
// Мои прошлые косяки: 1) класс .lenti-glow уже занят продуктом — это
// световые оверлеи ВНУТРИ сцен (lentiRender/lentiLifeBars), мой CSS ломал
// их геометрию и растягивал карточку; 2) сцену искал среди детей #lentiBox,
// а сцены живут в #lentiCard — свечение не получало цвет; 3) height:100%
// бил по всем детям бокса. Теперь: уникальный класс .kb-glow, сцена берётся
// как #lentiCard .lenti-scene.on, высота только на боксе и карточке.
const LENTI_CSS =
'#lentiBox{height:90px !important;min-height:0 !important;overflow:hidden !important;}' +
'#lentiCard{height:90px !important;min-height:0 !important;}' +
'.kb-glow{position:relative;z-index:3;height:24px;margin:0 10%;filter:blur(12px);pointer-events:none;border-radius:50%;opacity:.5;transition:background 1.1s ease;animation:kbGlow 4.2s ease-in-out infinite;}' +
'.kb-glow.top{margin-bottom:-14px;}' +
'.kb-glow.bottom{margin-top:-14px;}' +
'@keyframes kbGlow{0%,100%{opacity:.38}50%{opacity:.68}}';
function lentiPolish() {
  const s = document.createElement('style');
  s.textContent = LENTI_CSS;
  document.head.appendChild(s);
  const lb = document.getElementById('lentiBox');
  if (!lb || lb.dataset.glow) return;
  lb.dataset.glow = '1';
  const top = document.createElement('div');
  top.className = 'kb-glow top';
  const bot = document.createElement('div');
  bot.className = 'kb-glow bottom';
  lb.parentNode.insertBefore(top, lb);
  lb.parentNode.insertBefore(bot, lb.nextSibling);
  const paint = () => {
    const sc = document.querySelector('#lentiCard .lenti-scene.on') || document.querySelector('#lentiCard .lenti-scene');
    if (!sc) return;
    const cs = getComputedStyle(sc);
    let col = cs.backgroundColor;
    if (!col || col === 'rgba(0, 0, 0, 0)') {
      const m = cs.backgroundImage.match(/rgba?\([^)]+\)/);
      col = m ? m[0] : 'rgba(57,124,255,.8)';
    }
    const g = 'radial-gradient(ellipse at 50% 50%, ' + col + ', rgba(255,255,255,0) 72%)';
    top.style.background = g;
    bot.style.background = g;
  };
  paint();
  new MutationObserver(() => { requestAnimationFrame(paint); }).observe(lb, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style'] });
  setInterval(paint, 1500);
}
(function initCityTreemap() {
  const s = document.createElement('style');
  s.textContent = CTM_CSS;
  document.head.appendChild(s);
  mountCityTreemap();
  ctmRelayout();
  lentiPolish();
  renderCityTreemap();
  setInterval(renderCityTreemap, 10 * 60 * 1000); // каждые 10 минут
  (function schedMidnight() { // сброс-перерисовка в 00:00 МСК
    const now = Date.now();
    const m = new Date(now + 3 * 3600 * 1000);
    const next = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() + 1) - 3 * 3600 * 1000;
    setTimeout(function () { renderCityTreemap(); schedMidnight(); }, next - now + 5000);
  })();
})();
// ============================================================
// KB RETENTION PACK v1
// Telegram без блокировок + крючки возврата.
// Вставить в САМЫЙ КОНЕЦ app.js. index.html не менять.
// Блок перехватывает tgConnect/tgOpen и оборачивает нужные функции.
// ============================================================
(function () {
  'use strict';
  if (window.__kbRetentionPack) return;
  window.__kbRetentionPack = 1;

  var BOT = (typeof TG_BOT_USERNAME === 'string' && TG_BOT_USERNAME) ? TG_BOT_USERNAME : 'kogdabenz_alert_bot';
  var SITE = 'https://kogdabenz.ru';

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- палитра и скроллбары в стиле сайта ----------
  (function css() {
    var s = document.createElement('style');
    s.textContent =
      '.hello-pop::-webkit-scrollbar{width:8px}' +
      '.hello-pop::-webkit-scrollbar-track{background:#eef2f8;border-radius:8px}' +
      '.hello-pop::-webkit-scrollbar-thumb{background:#2465ee;border-radius:8px}' +
      '.hello-pop::-webkit-scrollbar-thumb:hover{background:#1746c8}' +
      '.kb-toast{position:fixed;left:12px;right:12px;bottom:96px;z-index:120;background:#14213d;color:#fff;border-radius:16px;padding:12px 14px;box-shadow:0 12px 34px rgba(20,33,61,.35);display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.4;transform:translateY(20px);opacity:0;transition:.3s cubic-bezier(.2,.8,.2,1);pointer-events:none}' +
      '.kb-toast.on{transform:translateY(0);opacity:1;pointer-events:auto}' +
      '.kb-toast.ok{background:#12855c}.kb-toast.warn{background:#c26a2a}' +
      '.kb-toast button{margin-left:auto;flex:none;border:0;border-radius:10px;background:rgba(255,255,255,.18);color:#fff;font-weight:700;font-size:12px;padding:8px 12px;cursor:pointer}' +
      '.kb-ladder{display:flex;flex-direction:column;gap:8px;margin:10px 0}' +
      '.kb-ladder button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border-radius:14px;padding:12px 14px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid #dfe8f2;background:#fff;color:#14213d;font-family:inherit}' +
      '.kb-ladder button.primary{background:linear-gradient(140deg,#4b93ff,#2465ee 60%,#1746c8);color:#fff;border:0;box-shadow:0 6px 18px rgba(36,101,238,.35)}' +
      '.kb-ladder button small{display:block;font-weight:500;color:inherit;opacity:.75;font-size:11px;margin-top:2px}' +
      '.kb-code{display:flex;align-items:center;gap:8px;background:#eef4ff;border:1px dashed #bcd4ff;border-radius:12px;padding:10px 12px;margin:8px 0;font-family:ui-monospace,monospace;font-size:15px;font-weight:800;color:#1746c8;word-break:break-all}' +
      '.kb-code button{margin-left:auto;flex:none;border:0;border-radius:8px;background:#2465ee;color:#fff;font-size:11px;font-weight:700;padding:6px 10px;cursor:pointer}' +
      '.kb-note{border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.5;margin:8px 0}' +
      '.kb-note.amber{background:#fff6ec;border:1px solid #f5d3b8;color:#8a5a2b}' +
      '.kb-note.blue{background:#eef4ff;border:1px solid #bcd4ff;color:#33507e}' +
      '.kb-probe{font-size:12px;font-weight:700;margin:6px 0;min-height:16px}' +
      '.kb-probe.ok{color:#12855c}.kb-probe.bad{color:#c26a2a}' +
      '.kb-adv-extra,.kb-card-extra{display:flex;gap:8px;margin-top:8px}' +
      '.kb-adv-extra button,.kb-card-extra button{flex:1;border:1px solid #bcd4ff;background:#fff;color:#2465ee;border-radius:12px;padding:9px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}' +
      '.kb-live{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;font-weight:700;color:#5b6b86;background:#eef2f8;border-radius:99px;padding:4px 10px}' +
      '.kb-live i{width:7px;height:7px;border-radius:50%;background:#19b77a;animation:kbPulse 1.6s infinite}' +
      '@keyframes kbPulse{0%,100%{opacity:1}50%{opacity:.3}}' +
      '.kb-prefs .feedback-option.selected{background:#2465ee;color:#fff;border-color:#2465ee}' +
      '.kb-bar{position:fixed;left:12px;right:12px;bottom:88px;z-index:96;background:#fff;border-radius:16px;padding:12px 14px;box-shadow:0 8px 28px rgba(20,40,80,.18);border:1px solid #e4ebf5;font-family:inherit}' +
      '.kb-bar b{display:block;font-size:13px;color:#1a2b45;margin-bottom:4px}' +
      '.kb-bar span{display:block;font-size:12px;color:#5b6b86;line-height:1.35;margin-bottom:10px}' +
      '.kb-bar .row{display:flex;gap:8px}' +
      '.kb-bar .row button{flex:1;border:0;border-radius:12px;padding:10px 12px;font-weight:650;font-size:13px;cursor:pointer}' +
      '.kb-bar .yes{background:#2465ee;color:#fff}.kb-bar .no{background:#eef2f8;color:#5b6b86}';
    document.head.appendChild(s);
  })();

  // ---------- утилиты ----------
  function kbToast(msg, kind, actionLabel, onAction, ms) {
    var t = document.getElementById('kbToast');
    if (!t) { t = document.createElement('div'); t.id = 'kbToast'; t.className = 'kb-toast'; document.body.appendChild(t); }
    t.className = 'kb-toast on' + (kind ? ' ' + kind : '');
    t.innerHTML = '<span>' + msg + '</span>' + (actionLabel ? '<button data-kbtoast-act="1">' + actionLabel + '</button>' : '');
    t._cb = onAction || null;
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('on'); }, ms || 5000);
  }

  function kbCopy(text) {
    function done() { kbToast('Скопировано', 'ok'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  function kbModal(id, z) {
    var back = document.getElementById(id + 'Back'), pop = document.getElementById(id);
    if (!back) { back = document.createElement('div'); back.id = id + 'Back'; back.className = 'hello-back'; back.style.zIndex = z; document.body.appendChild(back); }
    if (!pop) { pop = document.createElement('div'); pop.id = id; pop.className = 'hello-pop'; pop.style.zIndex = z + 1; pop.style.maxHeight = '88vh'; pop.style.overflowY = 'auto'; document.body.appendChild(pop); }
    var api = {
      pop: pop, back: back,
      open: function () { pop.classList.add('open'); back.classList.add('open'); },
      close: function () { pop.classList.remove('open'); back.classList.remove('open'); }
    };
    back.onclick = api.close;
    return api;
  }

  function kbAnyModalOpen() {
    return ['helloBack', 'installBack', 'pollBack', 'sheetBack', 'wnBack', 'mailBack', 'adviceBack', 'lifeBack', 'kbTgWizBack', 'kbPrefsBack'].some(function (id) {
      var el = document.getElementById(id); return el && el.classList.contains('open');
    });
  }

  function kbFuelPref() { return LS.get('kbFuelPref', null); }
  function kbFuelLabel() { var f = kbFuelPref(); return f === '92' ? 'АИ-92' : f === 'diesel' ? 'дизель' : 'АИ-95'; }

  // ============================================================
  // 1) МАСТЕР ПОДКЛЮЧЕНИЯ: iMe — способ №1 сразу, Telegram — запасной
  var wiz = null; // {code, stId, poll, client}
  var KB_IME_PLAY = 'https://play.google.com/store/apps/details?id=com.iMe.android';
  var KB_IME_IOS = 'https://apps.apple.com/us/app/ime-messenger/id1450480822';
  var KB_UA_ANDROID = /android/i.test(navigator.userAgent);
  var KB_UA_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  (function kbClientCss() {
    var s = document.createElement('style');
    s.textContent =
      '.kb-step-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;color:#14213d;margin:12px 0 6px}' +
      '.kb-step-n{width:20px;height:20px;border-radius:50%;background:linear-gradient(140deg,#4b93ff,#2465ee 60%,#1746c8);color:#fff;font-size:11px;font-weight:900;display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 3px 8px rgba(36,101,238,.3)}' +
      '.kb-step-n.gray{background:#8aa0b8;box-shadow:none}' +
      '.kb-install{display:flex;gap:8px;margin:8px 0}' +
      '.kb-install button{flex:1;border:1px solid #bcd4ff;background:#eef4ff;color:#1746c8;border-radius:10px;padding:8px 6px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit}' +
      '.kb-fallback{margin:12px 0 4px;border:1px solid #dfe8f2;border-radius:12px;padding:9px 12px;background:#f7f9fc}' +
      '.kb-fallback summary{cursor:pointer;font-size:12px;font-weight:800;color:#5b6b86;list-style:none;display:flex;align-items:center;gap:8px}' +
      '.kb-fallback summary::-webkit-details-marker{display:none}' +
      '.kb-fallback summary::before{content:"▸";color:#8aa0b8;transition:transform .2s}' +
      '.kb-fallback[open] summary::before{transform:rotate(90deg)}' +
      '.kb-fallback[open] summary{margin-bottom:6px}';
    document.head.appendChild(s);
  })();

  // сохранённый клиент нужен только для повторного открытия чата (tgOpen);
  // мастер ВСЕГДА открывается с iMe как способом №1
  function kbClient() { return LS.get('kbTgClient', 'ime'); }

  function kbOpenClient(client, code) {
    if (client === 'ime') {
      track(code ? 'tg_ime_open' : 'tg_ime_launch');
      if (KB_UA_ANDROID) {
        var u = code
          ? 'intent://resolve?domain=' + BOT + '&start=' + code + '#Intent;scheme=tg;package=com.iMe.android;S.browser_fallback_url=' + encodeURIComponent(KB_IME_PLAY) + ';end'
          : 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.iMe.android;S.browser_fallback_url=' + encodeURIComponent(KB_IME_PLAY) + ';end';
        try { window.location.href = u; } catch (e) {}
      } else {
        try { window.location.href = 'ime://' + (code ? 'resolve?domain=' + BOT + '&start=' + code : ''); } catch (e) {}
      }
    } else {
      track('tg_native_open');
      try { window.location.href = 'tg://resolve?domain=' + BOT + (code ? '&start=' + code : ''); } catch (e) {}
    }
    setTimeout(function () {
      if (!document.hidden && !tgLinked && wiz) {
        var h = document.getElementById('kbNativeHint');
        if (h) h.style.display = '';
      }
    }, 2500);
  }
  function kbOpenNative(code) { kbOpenClient(wiz ? wiz.client : 'ime', code); }
  function kbOpenBotChat() { kbOpenClient(kbClient(), null); }

  function kbProbeTme() {
    var el = document.getElementById('kbProbe');
    if (!el) return;
    el.className = 'kb-probe'; el.textContent = 'Проверяем, открывается ли t.me с вашего интернета…';
    var ctrl = new AbortController();
    var tm = setTimeout(function () { ctrl.abort(); }, 6000);
    fetch('https://t.me/' + BOT, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(function () { clearTimeout(tm); el.className = 'kb-probe ok'; el.textContent = '✓ t.me отвечает — обычная ссылка тоже должна открыться.'; })
      .catch(function () { clearTimeout(tm); el.className = 'kb-probe bad'; el.textContent = '✗ Страница t.me не открывается с вашего интернета — это блокировка страницы, не Telegram. Способ №1 (iMe) работает без неё.'; });
  }

  function kbWizSuccess() {
    if (!wiz) return;
    clearInterval(wiz.poll); wiz.poll = null;
    var m = kbModal('kbTgWiz', 96);
    m.pop.innerHTML =
      '<div class="hello-title">Готово! 🎉</div>' +
      '<div class="help-lead">Уведомления включены. Бот напишет, когда на ваших АЗС появится или закончится топливо.</div>' +
      '<button class="cta-btn" style="width:100%;margin-top:10px" data-kbclose="1">Отлично</button>';
    kbToast('Telegram подключён — уведомления включены', 'ok');
    setTimeout(function () { m.close(); wiz = null; }, 2200);
  }

  function kbWizCheck() {
    refreshTgLink();
    setTimeout(function () { if (tgLinked) kbWizSuccess(); else kbToast('Пока не видим подтверждения. Нажмите «Старт» в боте и попробуйте ещё раз.', 'warn'); }, 1200);
  }

  function kbRenderWizard(m, code, stId) {
    var st = stId ? stationById(stId) : null;
    var tme = 'https://t.me/' + BOT + '?start=' + code;
    var web = 'https://web.telegram.org/k/#?tgaddr=' + encodeURIComponent('tg://resolve?domain=' + BOT + '&start=' + code);
    var startCmd = '/start ' + code;
    m.pop.innerHTML =
      '<div class="hello-title">Подключаем уведомления</div>' +
      '<div class="help-lead" style="margin:4px 0 8px">' +
        (st ? 'По станции «' + escapeHtml(st.name || 'АЗС') + '. ' : '') +
        'Бот напишет, когда появится или закончится ' + kbFuelLabel().toLowerCase() + '.' +
      '</div>' +

      // ===== СПОСОБ №1 — iMe, сразу, без выбора =====
      '<div class="kb-step-h"><span class="kb-step-n">1</span>iMe — работает без VPN</div>' +
      '<div class="kb-note blue" style="margin-top:0"><b>Проверено:</b> iMe — клиент Telegram с теми же чатами и ботами, но со своей сетью прокси («Стабильное соединение»). Соединение держится само, без VPN и ручных настроек.</div>' +
      '<div class="kb-ladder">' +
        '<button class="primary" data-kbtg-native="1">🟢 Открыть бота в iMe<small>Ссылка на бота откроется внутри iMe — без веб-страницы и без VPN</small></button>' +
        '<div id="kbNativeHint" class="kb-note amber" style="display:none">Не открылось? Если открылся магазин — установите iMe и вернитесь сюда. Если iMe уже стоит, но открылся магазин — нажмите «Просто открыть iMe» и отправьте команду способом №2.</div>' +
        '<button data-kbime-open="1">Просто открыть iMe<small>Запустит приложение; команду боту отправите способом №2</small></button>' +
      '</div>' +
      '<div class="kb-install"><button data-kbime-install="android">Установить iMe · Android</button><button data-kbime-install="ios">Установить iMe · iPhone</button></div>' +

      // ===== СПОСОБ №2 — вручную, работает в любом клиенте =====
      '<div class="kb-step-h"><span class="kb-step-n">2</span>Вручную — если ссылка не открылась</div>' +
      '<div class="kb-note blue" style="margin-top:0">1. Откройте iMe (или Telegram) как обычно.<br>2. Найдите бота <b>@' + BOT + '</b> через поиск.<br>3. Отправьте ему команду ниже.</div>' +
      '<div class="kb-code"><span>' + startCmd + '</span><button data-kbcopy="' + startCmd + '">Копировать</button></div>' +
      '<div class="kb-code"><span>@' + BOT + '</span><button data-kbcopy="@' + BOT + '">Копировать</button></div>' +
      '<button class="cta-btn" style="width:100%" data-kbtg-check="1">Я нажал «Старт» — проверить</button>' +

      // ===== СПОСОБ №3 — официальный Telegram, свёрнутый запасной =====
      '<details class="kb-fallback"><summary><span class="kb-step-n gray">3</span>Обычный Telegram — запасной вариант</summary>' +
        '<div class="kb-probe" id="kbProbe"></div>' +
        '<div class="kb-ladder">' +
          '<button data-kbtg-tgopen="1">📲 Открыть в приложении Telegram<small>Если у вас он работает без VPN</small></button>' +
          '<button data-kbtg-web="1">🌐 Веб-версия (web.telegram.org)<small>В браузере, если приложение не установлено</small></button>' +
          '<button data-kbtg-tme="1">🔗 Обычная ссылка t.me<small>Если страница открывается с вашего интернета</small></button>' +
        '</div>' +
      '</details>' +

      '<div class="kb-note amber"><b>Про VPN честно:</b> VPN сейчас тоже активно блокируют, поэтому мы на него не полагаемся — iMe проводит соединение сам. Если совсем глухо, помогает MTProto-прокси внутри клиента: Настройки → Данные и память → Прокси. Сомнительные VPN-приложения ставить не просим.</div>' +
      '<div class="kb-note blue">Не получается с мессенджером? Не страшно: <b>колокольчик на сайте</b> показывает события по вашим избранным АЗС без Telegram и без VPN.</div>' +
      '<button class="cta-btn ghost" style="width:100%;margin-top:6px" data-kbclose="1">Закрыть</button>';
    m.pop._tme = tme; m.pop._web = web;
    kbProbeTme();
  }

  async function kbTgConnectWizard(stId) {
    track('tg_connect');
    var m = kbModal('kbTgWiz', 96);
    m.open();
    m.pop.innerHTML = '<div class="hello-title">Подключаем уведомления</div><div class="help-lead">Готовим код связки…</div>';
    var code = 'kb' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    var ok = true;
    try { await dbInsert('tg_link_codes', [{ code: code, device_id: deviceId }]); } catch (e) { ok = false; }
    if (!ok) {
      m.pop.innerHTML =
        '<div class="hello-title">Не удалось создать код</div>' +
        '<div class="help-lead">Сеть или база не ответили. Попробуйте ещё раз.</div>' +
        '<button class="cta-btn" style="width:100%" data-kbtg-retry="1">Попробовать снова</button>' +
        '<button class="cta-btn ghost" style="width:100%;margin-top:6px" data-kbclose="1">Закрыть</button>';
      m.pop._stId = stId || null;
      return;
    }
    // iMe — всегда способ №1 при открытии мастера, без выбора
    wiz = { code: code, stId: stId || null, poll: null, client: 'ime' };
    kbRenderWizard(m, code, stId);
    if (wiz.poll) clearInterval(wiz.poll);
    wiz.poll = setInterval(function () {
      refreshTgLink();
      if (tgLinked) kbWizSuccess();
    }, 4000);
    setTimeout(function () { if (wiz && wiz.poll) { clearInterval(wiz.poll); wiz.poll = null; } }, 180000);
  }

  // кнопки мастера: запуск iMe, установка iMe, запасной Telegram
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el;
    if ((el = t.closest('[data-kbime-open]'))) { kbOpenClient('ime', null); return; }
    if ((el = t.closest('[data-kbime-install]'))) {
      track('tg_ime_install');
      window.open(el.getAttribute('data-kbime-install') === 'ios' ? KB_IME_IOS : KB_IME_PLAY, '_blank');
      return;
    }
    if ((el = t.closest('[data-kbtg-tgopen]'))) {
      LS.set('kbTgClient', 'tg'); // человек явно выбрал рабочий у себя официальный клиент
      kbOpenClient('tg', wiz ? wiz.code : null);
      return;
    }
    if ((el = t.closest('[data-kbtg-web]')) || (el = t.closest('[data-kbtg-tme]'))) {
      LS.set('kbTgClient', 'tg');
      return; // само открытие делает делегирование пака по pop._web / pop._tme
    }
  }, true);

  // перехват старых функций — все кнопки ТГ теперь ведут в мастер
  tgConnect = function (fromStationId) { kbTgConnectWizard(fromStationId); };
  tgOpen = function () { kbOpenBotChat(); };

  // ============================================================
  // 2) НАСТРОЙКИ: топливо + район. Район = геопозиция пользователя в ЕГО городе
  //    (весь юг). «Свой район» = АЗС в радиусе вокруг точки; GPS молчит — центр города.
  function kbKmBetween(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * 111, dLon = (lon2 - lon1) * 111 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }
  function kbCityCenter() { var c = cityBox(); return { lat: (c.lat1 + c.lat2) / 2, lon: (c.lon1 + c.lon2) / 2 }; }

  // GPS/ручная точка — приоритет; иначе центр города пользователя, чтобы
  // «далеко» значило далеко в ЛЮБОМ городе юга, а не только в Новороссийске.
  var _kbLoadUserLocation = loadUserLocation;
  loadUserLocation = function () {
    var loc = _kbLoadUserLocation();
    if (loc) return loc;
    var cc = kbCityCenter();
    return { lat: cc.lat, lon: cc.lon, t: Date.now(), kbCityAnchor: true };
  };
  function kbAnchor() { return loadUserLocation(); }
  function kbHasRealGeo() { return !!_kbLoadUserLocation(); }
  function kbRadiusKm() { var r = Number(LS.get('kbRadius', 4)); return isFinite(r) ? r : 4; }
  function kbKmFromAnchor(st) {
    var a = kbAnchor();
    if (!a || !st || st.lat == null || st.lon == null) return null;
    return kbKmBetween(a.lat, a.lon, Number(st.lat), Number(st.lon));
  }
  function kbInDistrict(st) {
    var R = kbRadiusKm();
    if (R <= 0) return true; // весь город
    var km = kbKmFromAnchor(st);
    return km != null && km <= R;
  }

  // Приоритет «своего района» на этапе кандидатов: далёкие АЗС не вытесняют твои.
  var _kbAdviceCoreScore = adviceCoreScore;
  adviceCoreScore = function (st, o, km, pred) {
    var s = _kbAdviceCoreScore(st, o, km, pred);
    var R = kbRadiusKm();
    if (R <= 0 || !st) return s;
    var kmA = kbKmFromAnchor(st);
    if (kbInDistrict(st)) s += 120;
    else s -= Math.min(120, 20 + (kmA == null ? 40 : (kmA - R) * 20));
    if (km == null && kmA != null) s -= Math.min(25, kmA * 1.5);
    return s;
  };

  // Финальная сортировка «наш выбор»: топливо + свой район + расстояние.
  var _kbFullChoiceScore = fullChoiceScore;
  fullChoiceScore = function (it) {
    var s = _kbFullChoiceScore(it);
    var p = kbFuelPref();
    if (p && it && it.o) {
      var col = p === '92' ? 'fuel_92_status' : p === '95' ? 'fuel_95_status' : 'diesel_status';
      if (it.o[col] === true) s += 8;
    }
    var R = kbRadiusKm();
    if (R <= 0 || !it || !it.st) return s;
    var kmA = kbKmFromAnchor(it.st);
    if (kbInDistrict(it.st)) s += 30;
    else s -= Math.min(60, kmA == null ? 30 : kmA * 10);
    if (it.km == null && kmA != null) s += 12 * (Math.max(0, Math.min(1, 1 - kmA / 15)) - 0.5);
    return s;
  };

  // «Топ-3»: станции своего района поднимаем наверх обоих списков.
  function kbTop3ItemId(item) {
    var row = item.querySelector('.t3-row');
    var oc = (row && row.getAttribute('onclick')) || '';
    var m = oc.match(/top3Open\('([^']+)'\)/);
    return m ? m[1] : null;
  }
  function kbOrderTop3() {
    if (kbRadiusKm() <= 0) return;
    ['top3PageNow', 'top3PageLater'].forEach(function (pid) {
      var page = document.getElementById(pid);
      if (!page) return;
      var items = [].slice.call(page.children).filter(function (el) { return el.classList && el.classList.contains('t3-item'); });
      if (items.length < 2) return;
      items.sort(function (a, b) {
        var sa = stationById(kbTop3ItemId(a)), sb = stationById(kbTop3ItemId(b));
        var ma = sa && kbInDistrict(sa) ? 0 : 1, mb = sb && kbInDistrict(sb) ? 0 : 1;
        if (ma !== mb) return ma - mb;
        var ka = sa ? kbKmFromAnchor(sa) : null, kb2 = sb ? kbKmFromAnchor(sb) : null;
        return (ka == null ? 99 : ka) - (kb2 == null ? 99 : kb2);
      });
      var sub = page.querySelector('.t3-sub');
      items.forEach(function (el) { page.insertBefore(el, sub || null); });
    });
  }
  var _kbRenderTop3 = renderTop3;
  renderTop3 = function () { var r = _kbRenderTop3(); try { kbOrderTop3(); } catch (e) {} return r; };

  // Честная строка в советнике: город + радиус «своего района».
  var _kbRenderAdvicePop = renderAdvicePop;
  renderAdvicePop = function () {
    var ok = _kbRenderAdvicePop();
    try {
      if (ok) {
        var lead = document.querySelector('#advicePop .help-lead');
        if (lead && lead.innerHTML.indexOf('Район:') < 0) {
          var R = kbRadiusKm();
          var txt = R > 0 ? 'сначала рядом ≤' + R + ' км' : 'весь город';
          lead.innerHTML += ' <b style="color:#2465ee">Район: ' + escapeHtml(userCityName()) + '</b> — ' + txt + (kbHasRealGeo() ? ' (по геопозиции)' : ' (от центра города)') + '.';
        }
      }
    } catch (e) {}
    return ok;
  };

  function kbAskPrefs() {
    if (LS.get('kbPrefsAsked', false)) return;
    var m = kbModal('kbPrefs', 94);
    var selFuel = kbFuelPref() || '95';
    var selRadius = kbRadiusKm();
    function paint() {
      var geoTxt = kbHasRealGeo()
        ? 'Ваш район определён по геопозиции: ' + escapeHtml(userCityName()) + '. Сначала показываем АЗС рядом с вами.'
        : 'GPS пока молчит — район считаем от центра города ' + escapeHtml(userCityName()) + '. Включите гео или поставьте точку на карте для точности.';
      m.pop.innerHTML =
        '<div class="hello-title">Настроим под вас за 2 тапа</div>' +
        '<div class="help-lead" style="margin:4px 0 8px">Чтобы подбор показывал заправки рядом с вами, а не через весь город.</div>' +
        '<div class="fb-gl">Ваше топливо</div>' +
        '<div class="feedback-grid g3 kb-prefs" style="margin:6px 0 12px">' +
        ['92', '95', 'diesel'].map(function (f) {
          return '<button class="feedback-option' + (selFuel === f ? ' selected' : '') + '" data-kbpref-fuel="' + f + '">' + fuelLabel(f) + '</button>';
        }).join('') + '</div>' +
        '<div class="fb-gl">Ваш район — сначала рядом</div>' +
        '<div class="kb-note blue" style="margin:0 0 6px">' + geoTxt + '</div>' +
        '<div class="feedback-grid g4 kb-prefs" style="margin:6px 0 12px">' +
        [2, 4, 8, 0].map(function (r) {
          return '<button class="feedback-option' + (selRadius === r ? ' selected' : '') + '" data-kbpref-dist="' + r + '">' + (r === 0 ? 'весь город' : '≈' + r + ' км') + '</button>';
        }).join('') + '</div>' +
        '<button class="cta-btn" style="width:100%" data-kbpref-save="1">Готово</button>' +
        '<button class="cta-btn ghost" style="width:100%;margin-top:6px" data-kbpref-skip="1">Пропустить</button>';
    }
    m.pop._save = function () {
      LS.set('kbFuelPref', selFuel);
      LS.set('kbRadius', selRadius);
      LS.set('kbDistrict', ''); // старый захардкоженный район больше не используется
      LS.set('kbPrefsAsked', true);
      track('prefs_set');
      m.close();
      kbToast('Готово! Подбор и расстояния теперь от вашего района в ' + userCityName(), 'ok');
      try { renderAdviceIfOpen(); } catch (e) {}
      try { softRefresh(); } catch (e) {}
      setTimeout(kbNotifOffer, 4000);
    };
    m.pop._pickFuel = function (f) { selFuel = f; paint(); };
    m.pop._pickDist = function (d) { selRadius = Number(d); paint(); };
    m.pop._skip = function () { LS.set('kbPrefsAsked', true); m.close(); setTimeout(kbNotifOffer, 4000); };
    paint();
    m.open();
  }

  // ============================================================
  // 3) УВЕДОМЛЕНИЯ ПОСЛЕ ЦЕННОСТИ + живые пуши по избранным
  // ============================================================
  function kbNotifOffer() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    if (LS.get('kbNotifAsked', false) || offlineMode) return;
    if (document.getElementById('kbNotifBar')) return;
    var bar = document.createElement('div');
    bar.id = 'kbNotifBar'; bar.className = 'kb-bar';
    bar.innerHTML =
      '<b>Не хотите ехать вслепую?</b>' +
      '<span>Включите уведомления — напишем, когда ' + kbFuelLabel().toLowerCase() + ' появится рядом с вами.</span>' +
      '<div class="row"><button class="yes" data-kbnotif-yes="1">Включить</button><button class="no" data-kbnotif-no="1">Не сейчас</button></div>';
    document.body.appendChild(bar);
  }

  function kbNotifyFavs(freshEvents) {
    var favs = getFavorites();
    if (!favs.length) return;
    for (var i = 0; i < freshEvents.length; i++) {
      var e = freshEvents[i];
      if (favs.indexOf(e.station_id) < 0) continue;
      if (e.event_type !== 'fuel_restored') continue;
      var st = stationById(e.station_id);
      var name = st ? (st.name || 'АЗС') : 'АЗС';
      var msg = fuelLabel(e.fuel_type) + ' вернулся: ' + name;
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          var n = new Notification('КогдаБенз', { body: msg + ' · отметка свежая', icon: 'icon-192.png', tag: 'kb-' + e.station_id + '-' + e.detected_at });
          n.onclick = function () { window.focus(); openSheet(e.station_id); };
        } catch (err) {}
      }
      kbToast('⛽ ' + msg, 'ok', 'Открыть', (function (id) { return function () { openSheet(id); }; })(e.station_id), 8000);
    }
  }

  // ============================================================
  // 4) ЖИВОЙ ГОРОД: зрители онлайн + утренний дайджест + дежурный
  // ============================================================
  function kbPaintViewers(n) {
    var host = document.getElementById('nowSub');
    if (!host) return;
    var el = document.getElementById('kbLiveChip');
    if (!el) { el = document.createElement('div'); el.id = 'kbLiveChip'; host.parentNode.insertBefore(el, host.nextSibling); }
    if (n >= 2) { el.className = 'kb-live'; el.innerHTML = '<i></i>' + n + ' водителей сейчас на сайте'; el.style.display = ''; }
    else el.style.display = 'none';
  }

  function kbMorningDigest() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var d = new Date();
    if (d.getHours() !== 8 || d.getMinutes() > 20) return;
    var today = d.toDateString();
    if (LS.get('kbDigestDay', '') === today) return;
    LS.set('kbDigestDay', today);
    var fr = freshStats();
    var last = getLastObservations(), avail = 0, tot = 0;
    cityStationList().forEach(function (s) { var o = last[s.id]; if (o && o.fuel_95_status !== null && o.fuel_95_status !== undefined) { tot++; if (o.fuel_95_status) avail++; } });
    try { new Notification('КогдаБенз · утренняя сводка', { body: 'АИ-95 на ' + avail + ' из ' + tot + ' АЗС · свежие данные: ' + fr.fresh + ' из ' + fr.tot, icon: 'icon-192.png', tag: 'kb-digest' }); } catch (e) {}
  }

  function kbDutyNudge() {
    var favs = getFavorites();
    if (!favs.length) return;
    var today = new Date().toDateString();
    if (LS.get('kbDutyDay', '') === today) return;
    var h = new Date().getHours();
    if (h < 8 || h > 21) return;
    var last = getLastObservations();
    for (var i = 0; i < favs.length; i++) {
      var id = favs[i], st = stationById(id);
      if (!st) continue;
      var o = last[id];
      var fm = getFreshnessMin(o);
      var fbAge = null;
      for (var j = 0; j < allFeedback.length; j++) {
        var f = allFeedback[j];
        if (f.station_id !== id) continue;
        var age = Date.now() - new Date(f.created_at).getTime();
        if (fbAge === null || age < fbAge) fbAge = age;
      }
      var staleSrc = fm === null || fm > 180;
      var staleFolk = fbAge === null || fbAge > 3 * 3600000;
      if (staleSrc && staleFolk) {
        LS.set('kbDutyDay', today);
        kbToast('👀 «' + escapeHtml(st.name || 'АЗС') + '» без отметок 3 ч. Проезжаете? Обновите.', 'warn', 'Открыть', (function (sid) { return function () { openSheet(sid); }; })(id), 9000);
        return;
      }
    }
  }

  // ============================================================
  // 5) ОТКРЫТЫЕ ПЕТЛИ: «напомнить про окно»
  // ============================================================
  function kbSetWatch(i) {
    var it = adviceList[i];
    if (!it || !it.pred || !it.pred.from_time) return;
    var p = it.pred.from_time.split(':');
    var at = new Date(); at.setHours(Number(p[0]), Number(p[1]), 0, 0);
    if (at.getTime() < Date.now()) at.setDate(at.getDate() + 1);
    LS.set('kbWatchWin', { id: it.st.id, name: it.st.name || 'АЗС', fuel: it.pred.fuel_type, at: at.getTime() });
    track('watch_window', null, it.st.id);
    kbToast('⏰ Напомним, когда окно откроется — и проверим при следующем заходе.', 'ok');
  }

  function kbCheckWatch() {
    var w = LS.get('kbWatchWin', null);
    if (!w) return;
    if (Date.now() >= w.at) {
      LS.set('kbWatchWin', null);
      kbToast('⏰ Окно на «' + escapeHtml(w.name) + '» открылось — проверьте наличие ' + fuelLabel(w.fuel).toLowerCase() + '.', 'ok', 'Открыть', function () { openSheet(w.id); }, 10000);
    } else if (Date.now() - w.at > 2 * 3600000) {
      LS.set('kbWatchWin', null);
    }
  }

  // ============================================================
  // 6) СТРИК И «ТВОЯ ОТМЕТКА ПОМОГЛА» после каждого вклада
  // ============================================================
  function kbStreakToast() {
    var now = Date.now();
    if (now - LS.get('kbStreakShownAt', 0) < 60000) return;
    LS.set('kbStreakShownAt', now);
    var days = LS.get('kbMarkDays', []);
    var today = new Date().toDateString();
    if (days.indexOf(today) < 0) { days.push(today); if (days.length > 60) days = days.slice(-60); LS.set('kbMarkDays', days); }
    var streak = 0, d = new Date();
    while (days.indexOf(d.toDateString()) >= 0) { streak++; d.setDate(d.getDate() - 1); }
    var imp = null; try { imp = myImpact(); } catch (e) {}
    var msg = streak >= 2 ? '🔥 ' + streak + ' дней подряд на связи!' : 'Спасибо! Отметка учтена.';
    if (imp && imp.coVotes > 0) msg += ' Ваши отметки подтвердили ' + imp.coVotes + ' водителей.';
    kbToast(msg, 'ok');
  }

  var _bumpContrib = bumpContrib;
  bumpContrib = function () { var n = _bumpContrib(); try { kbStreakToast(); } catch (e) {} return n; };

  // ============================================================
  // 7) ШЕРИНГ-КАРТОЧКА: картинка + текст, бесплатный трафик
  // ============================================================
  function kbWrapText(g, text, x, y, maxW, lh) {
    var words = String(text).split(' '), line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y); y += lh; line = words[i]; }
      else line = test;
    }
    if (line) g.fillText(line, x, y);
    return y;
  }

  function kbShareCardBlob(st, lines, brandCol) {
    return new Promise(function (res) {
      var W = 1080, H = 566;
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var g = cv.getContext('2d');
      var grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, brandCol || '#2465ee'); grad.addColorStop(1, '#14213d');
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.beginPath(); g.arc(W - 120, 110, 220, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = '700 40px system-ui,sans-serif';
      g.fillText('КогдаБенз · живая карта топлива', 60, 88);
      g.font = '800 62px system-ui,sans-serif';
      kbWrapText(g, st.name || 'АЗС', 60, 185, W - 120, 68);
      g.font = '600 40px system-ui,sans-serif';
      lines.forEach(function (l, i) { g.fillText(l, 60, 330 + i * 54); });
      g.font = '700 32px system-ui,sans-serif'; g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillText('kogdabenz.ru', 60, H - 52);
      cv.toBlob(function (b) { res(b); }, 'image/png');
    });
  }

  async function kbShare(stId) {
    var st = stationById(stId); if (!st) return;
    var o = getLastObservations()[stId];
    var trust = o ? availTrustworthy(o) : false;
    var fuels = [];
    if (o) {
      if (trust && o.fuel_95_status === true) fuels.push('АИ-95');
      if (trust && o.fuel_92_status === true) fuels.push('АИ-92');
      if (trust && o.diesel_status === true) fuels.push('дизель');
    }
    var fuelTxt = fuels.length ? fuels.join(', ') + ' есть' : 'наличие уточняется';
    var pref = kbFuelPref() || '95';
    var col = pref === '92' ? 'price_92' : pref === 'diesel' ? 'price_diesel' : 'price_95';
    var p = allLastPrice[stId];
    var priceTxt = p && p[col] != null ? Number(p[col]).toFixed(1) + ' ₽' : '';
    var fm = getFreshnessMin(o);
    var freshTxt = fm === null ? '' : 'обновлено ' + (fm < 60 ? fm + ' мин' : Math.round(fm / 60) + ' ч') + ' назад';
    var lq = liveQueueCount(stId);
    var qTxt = lq ? lq + ' вод. в очереди' : (o && o.queue_level === 'high' ? 'очередь' : 'очередей не видно');
    var lines = [fuelTxt + (priceTxt ? ' · ' + priceTxt : ''), qTxt, freshTxt].filter(Boolean);
    var url = SITE + '/?utm_source=share&utm_medium=driver&utm_campaign=station';
    var text = '⛽ ' + (st.name || 'АЗС') + (st.address ? ', ' + st.address : '') + ': ' + lines.join(' · ');
    track('share_tap', null, stId);
    try {
      if (navigator.share) {
        var payload = { title: 'КогдаБенз', text: text, url: url };
        if (navigator.canShare) {
          try {
            var bc = (typeof BRAND_COLORS !== 'undefined' && BRAND_COLORS[brandKey(st)]) || '#2465ee';
            var blob = await kbShareCardBlob(st, lines, bc);
            if (blob) {
              var file = new File([blob], 'kogdabenz.png', { type: 'image/png' });
              if (navigator.canShare({ files: [file] })) payload.files = [file];
            }
          } catch (e) {}
        }
        await navigator.share(payload);
        track('share_done', null, stId);
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    kbCopy(text + '\n' + url);
    kbToast('Текст скопирован — отправьте в чат водителям', 'ok');
  }

  // кнопки «Поделиться»/«Напомнить» в советнике и карточке АЗС
  var _renderAdvicePop = renderAdvicePop;
  renderAdvicePop = function () {
    var ok = _renderAdvicePop();
    try {
      if (ok) {
        var pop = document.getElementById('advicePop');
        if (pop) pop.querySelectorAll('.adv-card').forEach(function (card, i) {
          var it = adviceList[i];
          if (!it || card.querySelector('.kb-adv-extra')) return;
          var ex = document.createElement('div');
          ex.className = 'kb-adv-extra';
          var watch = (it.pred && adviceWinState(it.pred) === 'soon')
            ? '<button data-kbwatch="' + i + '">⏰ Напомнить про окно</button>' : '';
          ex.innerHTML = '<button data-kbshare="' + it.st.id + '">📤 Поделиться</button>' + watch;
          card.appendChild(ex);
        });
      }
    } catch (e) {}
    return ok;
  };

  var _stationCard = stationCard;
  stationCard = function (st, obs, pred) {
    var h = _stationCard(st, obs, pred);
    var extra = '<div class="kb-card-extra" style="padding:0 14px 14px"><button data-kbshare="' + st.id + '">📤 Поделиться заправкой</button></div>';
    return h.replace('</article>', extra + '</article>');
  };

  // ============================================================
  // 8) ХУКИ: после top-3/onboarding, живой цикл, делегирование
  // ============================================================
  var kbValueSeen = false;
  var _track = track;
  track = function (ev, panel, stationId, durationSec, extra) {
    _track(ev, panel, stationId, durationSec, extra);
    if ((ev === 'top3_loaded' || ev === 'advisor_open') && !kbValueSeen) {
      kbValueSeen = true;
      setTimeout(function () {
        if (kbAnyModalOpen()) return;
        if (!LS.get('kbPrefsAsked', false)) kbAskPrefs();
        else kbNotifOffer();
      }, 2500);
    }
  };

  var kbLastLive = Date.now();
  async function kbLiveTick() {
    if (document.hidden || offlineMode || !allStations.length) return;
    try {
      var since = new Date(Date.now() - 40 * 60000).toISOString();
      var ev = await dbQuery('/rest/v1/events?event_type=in.(fuel_restored,fuel_disappeared)&detected_at=gte.' + since + '&select=station_id,event_type,fuel_type,detected_at&order=detected_at.desc&limit=200');
      var known = {};
      allWaveEvents.forEach(function (e) { known[e.station_id + '|' + e.event_type + '|' + e.detected_at] = 1; });
      var fresh = (ev || []).filter(function (e) { return !known[e.station_id + '|' + e.event_type + '|' + e.detected_at]; });
      if (fresh.length) {
        allWaveEvents = fresh.concat(allWaveEvents);
        try { softRefresh(); } catch (e) {}
        kbNotifyFavs(fresh.filter(function (e) { return new Date(e.detected_at).getTime() > kbLastLive; }));
      }
      kbLastLive = Date.now();
    } catch (e) {}
    try {
      var since5 = new Date(Date.now() - 5 * 60000).toISOString();
      var rows = await dbQuery('/rest/v1/site_hits?select=session_id&event=eq.heartbeat&created_at=gte.' + since5 + '&limit=1000');
      var uniq = {};
      (rows || []).forEach(function (r) { uniq[r.session_id] = 1; });
      kbPaintViewers(Object.keys(uniq).length);
    } catch (e) {}
    kbCheckWatch();
    kbDutyNudge();
    kbMorningDigest();
  }

  // единое делегирование всех кнопок пака
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el;
    if ((el = t.closest('[data-kbtoast-act]'))) { var tt = document.getElementById('kbToast'); if (tt && tt._cb) tt._cb(); if (tt) tt.classList.remove('on'); return; }
    if ((el = t.closest('[data-kbcopy]'))) { kbCopy(el.getAttribute('data-kbcopy')); return; }
    if ((el = t.closest('[data-kbtg-native]'))) { if (wiz) kbOpenNative(wiz.code); return; }
    if ((el = t.closest('[data-kbtg-web]'))) { var pw = document.getElementById('kbTgWiz'); if (pw && pw._web) window.open(pw._web, '_blank'); return; }
    if ((el = t.closest('[data-kbtg-tme]'))) { var pt = document.getElementById('kbTgWiz'); if (pt && pt._tme) window.open(pt._tme, '_blank'); return; }
    if ((el = t.closest('[data-kbtg-check]'))) { kbWizCheck(); return; }
    if ((el = t.closest('[data-kbtg-retry]'))) { var pr = document.getElementById('kbTgWiz'); kbTgConnectWizard(pr ? pr._stId : null); return; }
    if ((el = t.closest('[data-kbclose]'))) { var mm = t.closest('.hello-pop'); if (mm) { mm.classList.remove('open'); var b = document.getElementById(mm.id + 'Back'); if (b) b.classList.remove('open'); } if (wiz && wiz.poll) { clearInterval(wiz.poll); wiz.poll = null; } return; }
    if ((el = t.closest('[data-kbshare]'))) { kbShare(el.getAttribute('data-kbshare')); return; }
    if ((el = t.closest('[data-kbwatch]'))) { kbSetWatch(Number(el.getAttribute('data-kbwatch'))); return; }
    if ((el = t.closest('[data-kbpref-fuel]'))) { var pf = document.getElementById('kbPrefs'); if (pf && pf._pickFuel) pf._pickFuel(el.getAttribute('data-kbpref-fuel')); return; }
    if ((el = t.closest('[data-kbpref-dist]'))) { var pd = document.getElementById('kbPrefs'); if (pd && pd._pickDist) pd._pickDist(el.getAttribute('data-kbpref-dist')); return; }
    if ((el = t.closest('[data-kbpref-save]'))) { var ps = document.getElementById('kbPrefs'); if (ps && ps._save) ps._save(); return; }
    if ((el = t.closest('[data-kbpref-skip]'))) { var pk = document.getElementById('kbPrefs'); if (pk && pk._skip) pk._skip(); return; }
    if ((el = t.closest('[data-kbnotif-yes]'))) {
      LS.set('kbNotifAsked', true);
      var bar = document.getElementById('kbNotifBar'); if (bar) bar.remove();
      Notification.requestPermission().then(function (p) {
        track(p === 'granted' ? 'notif_granted' : 'notif_denied');
        if (p === 'granted') kbToast('Уведомления включены. Напишем, когда топливо появится рядом.', 'ok');
      });
      return;
    }
    if ((el = t.closest('[data-kbnotif-no]'))) { LS.set('kbNotifAsked', true); var bn = document.getElementById('kbNotifBar'); if (bn) bn.remove(); return; }
  }, true);

  // возвращаемся из Telegram — сразу проверяем связку
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wiz) { refreshTgLink(); setTimeout(function () { if (tgLinked) kbWizSuccess(); }, 800); }
  });

  // ---------- запуск ----------
  kbCheckWatch();
  setTimeout(kbLiveTick, 12000);
  setInterval(kbLiveTick, 4 * 60000);
})();
// ============================================================
// KB LIVE RESET + NEARBY CARE
// 1) Реакции (3 кнопки) сбрасываются при каждом появлении/пропаже
//    топлива на АЗС: старые голоса и счётчики сгорают, можно голосовать заново.
// 2) Геолокация -> ближайшие АЗС -> мягкая просьба отметить топливо,
//    если станция давно молчит или просто нужен свежий голос для города.
// Вставить в САМЫЙ КОНЕЦ app.js. index.html не менять.
// ============================================================
(function () {
  'use strict';
  if (window.__kbLiveResetCare) return;
  window.__kbLiveResetCare = 1;

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ---------- маленький тост в палитре сайта ----------
  function toast(msg, kind) {
    var t = document.getElementById('kbLrToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'kbLrToast';
      t.style.cssText = 'position:fixed;left:12px;right:12px;bottom:150px;z-index:121;border-radius:14px;padding:10px 14px;font-size:12px;font-weight:700;color:#fff;background:#14213d;box-shadow:0 10px 26px rgba(20,33,61,.3);opacity:0;transform:translateY(12px);transition:.3s;pointer-events:none;font-family:inherit';
      document.body.appendChild(t);
    }
    t.style.background = kind === 'ok' ? '#12855c' : kind === 'warn' ? '#c26a2a' : '#14213d';
    t.textContent = msg;
    t.style.opacity = '1'; t.style.transform = 'translateY(0)';
    clearTimeout(t._tm); t._tm = setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(12px)'; }, 4200);
  }

  // ============================================================
  // 1) ЭПОХА ТОПЛИВА: сжигание реакций при смене статуса
  // ============================================================
  function fuelEpoch(stId) {
    var t = 0;
    for (var i = 0; i < allWaveEvents.length; i++) {
      var e = allWaveEvents[i];
      if (e.station_id !== stId) continue;
      if (e.event_type !== 'fuel_restored' && e.event_type !== 'fuel_disappeared') continue;
      var x = new Date(e.detected_at).getTime();
      if (x > t) t = x;
    }
    return t;
  }
  function readEpochs() { return lsGet('kbAdvEpoch', {}); }
  function writeEpochs(m) { lsSet('kbAdvEpoch', m); }
  function readMine() { return lsGet('kbAdvMine', {}); }
  function writeMine(m) { lsSet('kbAdvMine', m); }

  // синхронное локальное сжигание: вызывается перед каждой отрисовкой советника
  function localBurn() {
    var stored = readEpochs();
    var first = !Object.keys(stored).length;
    var ids = {};
    Object.keys(adviceReactions).forEach(function (id) { ids[id] = 1; });
    (adviceList || []).forEach(function (x) { ids[x.st.id] = 1; });
    var cur = {};
    Object.keys(ids).forEach(function (id) { cur[id] = fuelEpoch(id); });
    if (first) { writeEpochs(cur); return false; }
    var changed = false;
    var mm = readMine();
    Object.keys(ids).forEach(function (id) {
      var ep = cur[id] || 0, old = stored[id] || 0;
      if (ep > old) {
        changed = true;
        adviceReactionMine[id] = {};
        adviceReactionIds[id] = {};
        delete mm[id];
        var s = adviceReactions[id];
        if (s) { s.like_count = 0; s.dislike_count = 0; s.doubt_count = 0; }
      }
    });
    writeEpochs(Object.assign({}, stored, cur));
    if (changed) writeMine(mm);
    return changed;
  }

  // серверная пересборка счётчиков: считаем только голоса НОВЕЕ эпохи топлива
  var sweepTimer = null;
  function scheduleSweep() { if (sweepTimer) return; sweepTimer = setTimeout(function () { sweepTimer = null; serverSweep(); }, 700); }
  async function serverSweep() {
    var ids = Object.keys(adviceReactions);
    if (!ids.length) return;
    var epochs = {}; ids.forEach(function (id) { epochs[id] = fuelEpoch(id); });
    try {
      var sinceIso = new Date(Date.now() - ADVICE_VOTE_TTL_MS).toISOString();
      var rows = await dbQuery('/rest/v1/advice_reactions?station_id=in.(' + ids.join(',') + ')&created_at=gte.' + sinceIso + '&select=station_id,reaction_type,device_id,created_at&order=created_at.desc&limit=2000');
      ids.forEach(function (id) {
        var s = adviceReactions[id] = adviceReactions[id] || { like_count: 0, dislike_count: 0, doubt_count: 0, folk_yes: 0, folk_no: 0, folk_fuel: {} };
        s.like_count = 0; s.dislike_count = 0; s.doubt_count = 0;
        var mine = adviceReactionMine[id] = adviceReactionMine[id] || {};
        delete mine.like; delete mine.dislike; delete mine.doubt;
        (rows || []).forEach(function (r) {
          if (r.station_id !== id) return;
          var t = new Date(r.created_at).getTime();
          if (epochs[id] && t <= epochs[id]) return; // голос до смены топлива — сгорел
          s[r.reaction_type + '_count'] = (s[r.reaction_type + '_count'] || 0) + 1;
          if (r.device_id === deviceId) mine[r.reaction_type] = true;
        });
      });
      var mm = readMine();
      ids.forEach(function (id) {
        var m = adviceReactionMine[id] || {};
        var row = mm[id] || {};
        row.like = !!m.like; row.dislike = !!m.dislike; row.doubt = !!m.doubt;
        mm[id] = row;
      });
      writeMine(mm);
      try { renderAdvicePop(); } catch (e) {}
    } catch (e) {}
  }

  // оборачиваем отрисовку и загрузчики: сжигание до показа + пересборка после
  var _rap = renderAdvicePop;
  renderAdvicePop = function () { var ch = localBurn(); var r = _rap(); if (ch) scheduleSweep(); return r; };
  var _raw = loadAdviceReactionsForListRaw;
  loadAdviceReactionsForListRaw = async function () { await _raw(); localBurn(); await serverSweep(); };
  var _lst = loadAdviceReactionsForList;
  loadAdviceReactionsForList = async function (list) { await _lst(list); localBurn(); await serverSweep(); };
  var _sr = softRefresh;
  softRefresh = function () {
    _sr();
    if (localBurn()) { toast('Топливо обновилось — голоса по этой АЗС сброшены', 'ok'); try { renderAdvicePop(); } catch (e) {} scheduleSweep(); }
  };
  setInterval(function () {
    if (document.hidden) return;
    if (localBurn()) { toast('Топливо обновилось — голоса по этой АЗС сброшены', 'ok'); try { renderAdvicePop(); } catch (e) {} scheduleSweep(); }
  }, 20000);

  // ============================================================
  // ============================================================
  // 2) БЛИЖАЙШИЕ АЗС: мягкая просьба отметить топливо.
  //    Уступает советнику и любым окнам; улица видна сразу.
  // ============================================================
  var nearLoc = null, nearTriedGeo = false;
  var nearState = { list: [], sel: null };

  function realLoc() {
    var l = loadUserLocation();
    if (l && !l.kbCityAnchor) return l;
    return nearLoc;
  }
  function ensureGeo() {
    if (nearTriedGeo || realLoc() || !navigator.geolocation) return;
    nearTriedGeo = true;
    navigator.geolocation.getCurrentPosition(function (p) {
      if (!p || !p.coords || p.coords.accuracy > 300) return;
      nearLoc = { lat: p.coords.latitude, lon: p.coords.longitude };
    }, function () {}, { timeout: 6000, maximumAge: 300000 });
  }
  function folkRecent(stId, ms) {
    var since = Date.now() - ms;
    for (var i = 0; i < allFeedback.length; i++) {
      var f = allFeedback[i];
      if (f.station_id !== stId) continue;
      if (f.feedback_type !== 'available' && f.feedback_type !== 'unavailable') continue;
      if (new Date(f.created_at).getTime() >= since) return true;
    }
    return false;
  }
  function nearCandidates() {
    var loc = realLoc(); if (!loc) return [];
    var last = getLastObservations();
    var arr = [];
    for (var i = 0; i < allStations.length; i++) {
      var st = allStations[i];
      if (!Number.isFinite(Number(st.lat)) || !Number.isFinite(Number(st.lon))) continue;
      var d = distMeters(loc.lat, loc.lon, Number(st.lat), Number(st.lon));
      if (d > 3000) continue;
      var o = last[st.id];
      var fm = getFreshnessMin(o);
      var folk2 = folkRecent(st.id, 2 * 3600000);
      if (!(fm === null || fm > 180 || !folk2)) continue;
      var reason = fm === null ? 'источник ещё не делился данными'
        : fm > 180 ? 'источник молчит ' + agoRu(fm)
        : 'нужен свежий голос для других водителей';
      arr.push({ st: st, d: d, reason: reason });
    }
    arr.sort(function (a, b) { return a.d - b.d; });
    return arr.slice(0, 2);
  }
  function nearCooldown(id) { try { return localStorage.getItem('kbNearAsk_' + id) === new Date().toDateString(); } catch (e) { return false; } }
  function nearMark(id) { try { localStorage.setItem('kbNearAsk_' + id, new Date().toDateString()); } catch (e) {} }

  function anyModal() {
    return ['helloBack', 'installBack', 'pollBack', 'sheetBack', 'wnBack', 'mailBack', 'adviceBack', 'lifeBack', 'reactBack', 'scoreBack', 'tgOfferBack', 'liteBack', 'kbTgWizBack', 'kbPrefsBack', 'slimNotifBack'].some(function (id) {
      var el = document.getElementById(id); return el && el.classList.contains('open');
    });
  }

  function nearCss() {
    if (document.getElementById('kbNearCss')) return;
    var s = document.createElement('style'); s.id = 'kbNearCss';
    s.textContent =
      '#kbNearCard{position:fixed;left:12px;right:12px;bottom:88px;z-index:84;background:#fff;border-radius:18px;border:1px solid #e4ebf5;box-shadow:0 12px 32px rgba(20,40,80,.2);padding:12px 14px;font-family:inherit;max-height:60vh;overflow-y:auto}' +
      '#kbNearCard::-webkit-scrollbar{width:8px}#kbNearCard::-webkit-scrollbar-thumb{background:#2465ee;border-radius:8px}' +
      '.kbn-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800;color:#14213d;margin-bottom:6px}' +
      '.kbn-head .ic{width:16px;height:16px;color:#2465ee}' +
      '.kbn-sub{font-size:11px;color:#5b6b86;line-height:1.4;margin-bottom:8px}' +
      '.kbn-pills{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}' +
      '.kbn-pill{display:flex;flex-direction:column;align-items:flex-start;gap:2px;border:1px solid #dfe8f2;background:#f7f9fc;color:#33445f;border-radius:12px;padding:7px 10px;cursor:pointer;font-family:inherit;max-width:100%}' +
      '.kbn-pill.on{background:#2465ee;color:#fff;border-color:#2465ee}' +
      '.kbn-pill-top{font-size:11px;font-weight:800;white-space:nowrap}' +
      '.kbn-pill-addr{font-size:9px;font-weight:600;opacity:.8;max-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.kbn-addr{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#33445f;margin:2px 0 6px}' +
      '.kbn-addr .ic{width:13px;height:13px;color:#2465ee;flex:none}' +
      '.kbn-reason{font-size:11px;color:#c26a2a;font-weight:700;margin-bottom:6px}' +
      '.kbn-actions{display:flex;gap:8px;margin-top:8px}' +
      '.kbn-actions button{flex:1;border:0;border-radius:12px;padding:10px 12px;font-weight:650;font-size:12px;cursor:pointer;font-family:inherit}' +
      '.kbn-no{background:#eef2f8;color:#5b6b86}' +
      '.kbn-thanks{font-size:12px;color:#12855c;font-weight:800;text-align:center;padding:8px 0}';
    document.head.appendChild(s);
  }

  function nearRender() {
    nearCss();
    var card = document.getElementById('kbNearCard');
    if (!card) { card = document.createElement('div'); card.id = 'kbNearCard'; document.body.appendChild(card); }
    var sel = nearState.sel || (nearState.list[0] && nearState.list[0].st.id);
    nearState.sel = sel;
    var cur = nearState.list.find(function (x) { return x.st.id === sel; }) || nearState.list[0];
    if (!cur) { card.remove(); return; }
    var pills = nearState.list.map(function (x) {
      var dm = x.d < 1000 ? Math.round(x.d) + ' м' : (x.d / 1000).toFixed(1) + ' км';
      return '<button class="kbn-pill' + (x.st.id === sel ? ' on' : '') + '" data-kbnear-sel="' + x.st.id + '">' +
        '<span class="kbn-pill-top">' + escapeHtml(x.st.name || 'АЗС') + ' · ' + dm + '</span>' +
        '<span class="kbn-pill-addr">' + escapeHtml(x.st.address || 'адрес не указан') + '</span>' +
        '</button>';
    }).join('');
    card.innerHTML =
      '<div class="kbn-head">' + icon('i-pin', 'ic-s') + 'Вы рядом с заправками</div>' +
      '<div class="kbn-sub">Пара тапов — и город увидит свежую обстановку. Это помогает другим водителям не ехать вслепую.</div>' +
      '<div class="kbn-pills">' + pills + '</div>' +
      '<div class="kbn-addr">' + icon('i-pin', 'ic-s') + '<span>' + escapeHtml(cur.st.name || 'АЗС') + ' — ' + escapeHtml(cur.st.address || 'адрес не указан') + '</span></div>' +
      '<div class="kbn-reason">' + escapeHtml(cur.reason) + '</div>' +
      '<div class="feedback-panel open" id="quick-' + cur.st.id + '">' + quickChipsHtml() + '</div>' +
      '<div class="kbn-actions"><button class="kbn-no" data-kbnear-no="1">Не сейчас</button><button class="cta-btn" data-kbnear-send="' + cur.st.id + '">Отправить отметку</button></div>';
  }

  function nearHide() { var c = document.getElementById('kbNearCard'); if (c) c.remove(); }

  async function nearSend(id) {
    var panel = document.getElementById('quick-' + id);
    if (!panel) return;
    var rows = [];
    panel.querySelectorAll('.feedback-option.selected').forEach(function (b) {
      var fact = b.dataset.fact;
      var base = { feedback_type: null, fuel_type: null, queue_size: null, comment_text: null };
      if (fact === 'yes') Object.assign(base, { feedback_type: 'available', fuel_type: b.dataset.fuel });
      else if (fact === 'no') Object.assign(base, { feedback_type: 'unavailable', fuel_type: b.dataset.fuel });
      else if (fact === 'queue') Object.assign(base, { feedback_type: 'queue', queue_size: b.dataset.queue });
      else if (fact === 'delivery') Object.assign(base, { feedback_type: 'delivery' });
      else if (fact === 'free') Object.assign(base, { feedback_type: 'free' });
      else if (fact === 'inqueue') Object.assign(base, { feedback_type: 'in_queue' });
      rows.push(base);
    });
    if (!rows.length) { toast('Выберите хотя бы один факт', 'warn'); return; }
    var st = stationById(id);
    var onSite = await onSiteFields(st);
    rows.forEach(function (r) { r.station_id = id; r.device_id = deviceId; Object.assign(r, onSite); });
    var ok = true;
    try { await dbInsert('user_feedback', rows); } catch (e) { ok = false; }
    if (!ok) queueFeedbackLocally(rows);
    rows.forEach(function (r) { allFeedback.unshift(Object.assign({ created_at: new Date().toISOString() }, r)); });
    track('feedback_submit'); bumpContrib(); nearMark(id);
    var card = document.getElementById('kbNearCard');
    if (card) card.innerHTML = '<div class="kbn-thanks">Спасибо! Отметка учтена — город видит свежее топливо 🙏</div>';
    setTimeout(function () { nearHide(); try { softRefresh(); } catch (e) {} }, 1600);
  }

  function nearDismiss() {
    nearState.list.forEach(function (x) { nearMark(x.st.id); });
    nearHide();
  }

  function nearTick() {
    if (document.hidden || offlineMode || !allStations.length) return;
    if (anyModal() || activeQuick || activeRing) return; // советник и любые окна — главнее
    var sh = document.getElementById('shadowCard'); if (sh && sh.classList.contains('open')) return;
    if (document.getElementById('kbNearCard')) return;
    try { if (Number(sessionStorage.getItem('kbNearSession') || 0) >= 2) return; } catch (e) {}
    ensureGeo();
    var list = nearCandidates().filter(function (x) { return !nearCooldown(x.st.id); });
    if (!list.length) return;
    nearState.list = list; nearState.sel = list[0].st.id;
    try { sessionStorage.setItem('kbNearSession', String(Number(sessionStorage.getItem('kbNearSession') || 0) + 1)); } catch (e) {}
    nearRender();
    track('near_nudge_show', null, list[0].st.id);
  }

  // Мгновенно прячем карточку, когда открывается советник/любое окно,
  // и возвращаем её только после закрытия (без наложения слоёв).
  var nearGuardT = null;
  function nearGuard() {
    if (anyModal()) { nearHide(); return; }
    if (nearGuardT) return;
    nearGuardT = setTimeout(function () { nearGuardT = null; if (!anyModal()) nearTick(); }, 700);
  }
  new MutationObserver(nearGuard).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

  document.addEventListener('click', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    var el;
    if ((el = t.closest('[data-kbnear-sel]'))) { nearState.sel = el.getAttribute('data-kbnear-sel'); nearRender(); return; }
    if ((el = t.closest('[data-kbnear-send]'))) { nearSend(el.getAttribute('data-kbnear-send')); return; }
    if ((el = t.closest('[data-kbnear-no]'))) { nearDismiss(); return; }
  }, true);

  setInterval(nearTick, 45000);
  setTimeout(nearTick, 15000);
})();
// ============================================================
// KB MAYBE-FUEL: «отметил — у меня скрылось, у других осталось»
// Голос этого устройства мгновенно убирает строку из его поля зрения.
// Остальные водители видят строку и счётчик, пока сами не отметят.
// Новое событие источника (fuel_restored) по паре снова открывает строку.
// Вставить в САМЫЙ КОНЕЦ app.js. index.html не менять.
// ============================================================
(function () {
  'use strict';
  if (window.__kbMfHide) return;
  window.__kbMfHide = 1;

  var HKEY = 'kbMfHidden';
  function hmap() { try { return JSON.parse(localStorage.getItem(HKEY) || '{}'); } catch (e) { return {}; } }
  function hsave(m) { try { localStorage.setItem(HKEY, JSON.stringify(m)); } catch (e) {} }
  function hidePair(stId, fuel) { var m = hmap(); m[stId + '|' + fuel] = Date.now(); hsave(m); }
  function unhidePair(stId, fuel) { var m = hmap(); delete m[stId + '|' + fuel]; hsave(m); }

  // окно актуальности: с последней смены статуса пары (вернулось/пропало)
  function pairSince(stId, fuel) { return maybeSince(stId, fuel); }

  // строка должна исчезнуть у ЭТОГО устройства?
  function shouldHide(stId, fuel) {
    var s = pairSince(stId, fuel);
    var v = maybeFuelVotes(stId, fuel, s);
    if (v.mine) return true; // мой голос уже в ленте (в т.ч. офлайн-очередь)
    var h = hmap()[stId + '|' + fuel] || 0;
    // скрытие действует, пока не случилось более новое событие по паре
    return h > 0 && h >= s;
  }

  // ---------- снек «голос учтён · отменить» ----------
  (function css() {
    var s = document.createElement('style');
    s.textContent =
      '#mfSnack{position:fixed;left:12px;right:12px;bottom:96px;z-index:121;display:flex;align-items:center;gap:10px;' +
      'background:#14213d;color:#fff;border-radius:16px;padding:12px 14px;font-size:12px;font-weight:700;line-height:1.4;' +
      'box-shadow:0 12px 34px rgba(20,33,61,.35);opacity:0;transform:translateY(16px);transition:.3s cubic-bezier(.2,.8,.2,1);pointer-events:none;font-family:inherit}' +
      '#mfSnack.on{opacity:1;transform:translateY(0);pointer-events:auto}' +
      '#mfSnack button{margin-left:auto;flex:none;border:0;border-radius:10px;background:rgba(255,255,255,.18);color:#fff;font-weight:800;font-size:12px;padding:8px 12px;cursor:pointer;font-family:inherit}' +
      '.mf-row{transition:opacity .22s ease,transform .22s ease}' +
      '.mf-row.mf-out{opacity:0;transform:translateX(14px)}';
    document.head.appendChild(s);
  })();

  function showSnack(stId, fuel, yes) {
    var el = document.getElementById('mfSnack');
    if (!el) { el = document.createElement('div'); el.id = 'mfSnack'; document.body.appendChild(el); }
    el.innerHTML = '<span>Голос учтён — строка скрыта только у вас. Остальные водители её видят.</span><button type="button">Отменить</button>';
    el.classList.add('on');
    el.querySelector('button').onclick = function () {
      el.classList.remove('on');
      maybeUndoVote(stId, fuel, yes, pairSince(stId, fuel));
    };
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('on'); }, 6000);
  }

  // ---------- перерисовка: убираем «мои» строки из моего поля зрения ----------
  var _render = renderMaybeFuel;
  renderMaybeFuel = function () {
    _render();
    var wrap = document.getElementById('maybeFuelPlate');
    if (!wrap || wrap.style.display === 'none') return;
    var rows = [].slice.call(wrap.querySelectorAll('.mf-row'));
    var left = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var m = row.innerHTML.match(/maybeVote\('([^']+)','([^']+)'/);
      if (!m) { left++; continue; }
      var id = m[1], fuel = m[2];
      row.setAttribute('data-st', id);
      row.setAttribute('data-fuel', fuel);
      if (shouldHide(id, fuel)) row.remove();
      else left++;
    }
    if (!left) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
  };

  // ---------- голос: мгновенно скрыть у себя, у других оставить ----------
  var _vote = maybeVote;
  maybeVote = async function (stId, fuel, yes) {
    var s = pairSince(stId, fuel);
    var v = maybeFuelVotes(stId, fuel, s);

    // повторный тап по своему голосу = отмена (строка возвращается)
    if (v.mine) {
      unhidePair(stId, fuel);
      await _vote(stId, fuel, yes);
      renderMaybeFuel();
      return;
    }
    // голосование уже закрыто консенсусом — ничего не скрываем
    if (yes ? v.yes >= 2 : v.no >= 2) { await _vote(stId, fuel, yes); return; }

    // оптимистично: запоминаем скрытие и убираем строку сразу, до ответа сети
    hidePair(stId, fuel);
    var wrap = document.getElementById('maybeFuelPlate');
    if (wrap) {
      var row = wrap.querySelector('.mf-row[data-st="' + stId + '"][data-fuel="' + fuel + '"]');
      if (row) row.classList.add('mf-out');
    }
    await _vote(stId, fuel, yes); // внутри уже перерисовывает (наш врап уберёт строку)
    renderMaybeFuel();
    showSnack(stId, fuel, yes);
  };

  // ---------- отмена голоса: строка возвращается этому водителю ----------
  var _undo = maybeUndoVote;
  maybeUndoVote = async function (stId, fuel, yes, since) {
    unhidePair(stId, fuel);
    await _undo(stId, fuel, yes, since);
    renderMaybeFuel();
  };

  // первый прогон: если водитель уже голосовал раньше — сразу чисто
  setTimeout(function () { try { renderMaybeFuel(); } catch (e) {} }, 1200);
})();
// ============================================================
// KB FUEL MERGE v1 — одна правда о топливе: источник + народ + «с места»
// Советник «Куда ехать» больше не рисует «нет данных» там, где карточка
// АЗС уже видит топливо по народным отметкам. Приоритет (как в stationCard):
//   1) «с места» (GPS ≤200 м, ≤2 ч) — факт у колонки;
//   2) свежий достоверный источник (≤6 ч, не SUSPECTED/CONFIRMED_LOSS…);
//   3) народ: строгий консенсус (2 устройства / 2 ч), иначе перевес за 24 ч
//      (folkFuelSignal — ровно то, что красит плитки карточки);
//   4) несвежее «есть» источника — янтарное «не точно», не зелёное.
// Народное «есть» больше НЕ затирается фильтром доверия источника,
// а народное «есть» перекрывает несвежее «нет» источника — как в карточке.
// Вставить в САМЫЙ КОНЕЦ app.js. index.html не менять.
// ============================================================
(function () {
'use strict';
if (window.__kbFuelMerge) return;
window.__kbFuelMerge = 1;

// ---------- палитра плиток в стиле сайта ----------
(function css() {
var s = document.createElement('style');
s.id = 'kbFuelMergeCss';
s.textContent =
'.adv-fc.kbm{display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 6px 6px;border-radius:12px;min-width:0;}' +
'.adv-fc.kbm b{font-size:10px;font-weight:800;letter-spacing:.2px;opacity:.85;}' +
'.adv-fc.kbm i{font-style:normal;display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:900;line-height:1.2;}' +
'.adv-fc.kbm em{font-style:normal;display:inline-flex;align-items:center;gap:3px;font-size:8px;font-weight:700;opacity:.8;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
'.adv-fc.kbm .ic{width:10px;height:10px;flex:none;}' +
'.adv-fc.kbm.yes{background:#e5f8ef;color:#12855c;}' +
'.adv-fc.kbm.no{background:#fdecec;color:#c2403f;}' +
'.adv-fc.kbm.warn{background:#fff6ec;color:#c26a2a;}' +
'.adv-fc.kbm.none{background:#eef2f8;color:#7487a7;}' +
'.adv-fc.kbm.folk.yes{box-shadow:inset 0 0 0 1px #bfe8d4;}' +
'.adv-fc.kbm.scene.yes{box-shadow:inset 0 0 0 1.5px #12855c;}' +
'.adv-fc.kbm.source.yes{box-shadow:inset 0 0 0 1px #bfe8d4;}' +
'.kbm-bsrc{font-style:normal;font-weight:700;opacity:.85;margin-left:4px;font-size:9px;}' +
'.kbm-lead{color:#12855c;font-weight:700;}';
document.head.appendChild(s);
})();

// ---------- объединённый взгляд на пару АЗС×топливо (с кэшем) ----------
var fvCache = {}, fvAt = 0, fvFb = -1, fvEv = -1;
function fvInvalidate() {
var now = Date.now();
if (now - fvAt > 15000 || fvFb !== allFeedback.length || fvEv !== allWaveEvents.length) {
fvCache = {}; fvAt = now; fvFb = allFeedback.length; fvEv = allWaveEvents.length;
}
}
function minAgo(m) { return m < 60 ? m + ' мин' : m < 1440 ? Math.round(m / 60) + ' ч' : Math.round(m / 1440) + ' дн'; }
function latestFolkAt(stId, fl, yes) {
var t = 0, since = Date.now() - 24 * 3600000;
for (var i = 0; i < allFeedback.length; i++) {
var f = allFeedback[i];
if (f.station_id !== stId || f.fuel_type !== fl) continue;
if (f.feedback_type !== (yes ? 'available' : 'unavailable')) continue;
var x = new Date(f.created_at).getTime();
if (x >= since && x > t) t = x;
}
return t;
}
function computeFuelView(stId, o, fl) {
var col = fl === '92' ? 'fuel_92_status' : fl === '95' ? 'fuel_95_status' : 'diesel_status';
var trust = o ? availTrustworthy(o) : false;
var fm = o ? getFreshnessMin(o) : null;
// 1) «с места» — сильнее всего
var sc = null; try { sc = sceneMark(stId, fl); } catch (e) {}
if (sc) return { v: true, src: 'scene', label: 'есть', ico: 'i-pin', note: 'с места · ' + minAgo(Math.max(0, Math.round((Date.now() - sc.t) / 60000))) + ' назад' };
var stt = o ? o[col] : null;
// 2) свежий достоверный источник
if (trust && stt === true) return { v: true, src: 'source', label: 'есть', ico: 'i-pump', note: 'источник' + (fm !== null ? ' · ' + minAgo(fm) + ' назад' : '') };
if (trust && stt === false) return { v: false, src: 'source', label: 'нет', ico: 'i-pump', note: 'источник' + (fm !== null ? ' · ' + minAgo(fm) + ' назад' : '') };
// 3) народ — дополняет молчание/несвежесть источника (как folkFuelSignal в карточке)
var fc = null; try { fc = folkFuelSignal(stId, fl); } catch (e) {}
if (fc && fc.verdict === 'yes') { var ty = latestFolkAt(stId, fl, true); return { v: true, src: 'folk', label: 'есть', ico: 'i-heart', votes: fc.votes, note: 'народ · ' + fc.votes + ' подтв.' + (ty ? ' · ' + minAgo(Math.max(0, Math.round((Date.now() - ty) / 60000))) + ' назад' : '') }; }
if (fc && fc.verdict === 'no') { var tn = latestFolkAt(stId, fl, false); return { v: false, src: 'folk', label: 'нет', ico: 'i-heart', votes: fc.votes, note: 'народ · ' + fc.votes + ' опр.' + (tn ? ' · ' + minAgo(Math.max(0, Math.round((Date.now() - tn) / 60000))) + ' назад' : '') }; }
if (fc && fc.verdict === 'conflict') return { v: null, src: 'conflict', label: 'спорно', ico: 'i-help', note: 'народ · мнения разошлись' };
// 4) несвежий источник: «есть» — не точно, «нет» — тускло
if (stt === true) return { v: null, src: 'stale', label: 'не точно', ico: 'i-clock', staleYes: true, note: 'источник · ' + (fm !== null ? agoRu(fm) : 'давно') };
if (stt === false) return { v: false, src: 'stale-no', label: 'нет', ico: 'i-clock', dim: true, note: 'источник · ' + (fm !== null ? agoRu(fm) : 'давно') };
return { v: null, src: 'none', label: 'нет данных', ico: 'i-minus', note: 'ждём отметок' };
}
function kbFuelView(stId, o, fl) {
fvInvalidate();
var key = stId + '|' + fl, c = fvCache[key];
if (c && c.o === o) return c.v;
var v = computeFuelView(stId, o, fl);
fvCache[key] = { o: o, v: v };
return v;
}
window.kbFuelView = kbFuelView; // единая точка правды для будущих блоков

// ---------- focus-топливо: то, что реально видно (а не только пин источника) ----------
var _aff = adviceFocusFuel;
adviceFocusFuel = function (it) {
if (!it || it.kind === 'forecast') return _aff(it);
var pref = null; try { pref = JSON.parse(localStorage.getItem('kbFuelPref') || 'null'); } catch (e) {}
var order = ['95', '92', 'diesel'];
if (pref === '92' || pref === 'diesel') order = [pref].concat(order.filter(function (f) { return f !== pref; }));
for (var i = 0; i < order.length; i++) if (kbFuelView(it.st.id, it.o, order[i]).v === true) return order[i];
return _aff(it);
};

// ---------- кандидаты советника: наличие = объединённый взгляд ----------
buildAdviceList = function () {
var uLoc = loadUserLocation(), city = cityStationList(), last = getLastObservations();
var nows = [], fcs = [], stales = [];
function kmOf(st) {
if (!uLoc) return null;
var dLat = 111 * (Number(st.lat) - uLoc.lat);
var dLon = 111 * (Number(st.lon) - uLoc.lon) * Math.cos(uLoc.lat * Math.PI / 180);
return Math.sqrt(dLat * dLat + dLon * dLon);
}
for (var i = 0; i < city.length; i++) {
var st = city[i];
if (!Number.isFinite(Number(st.lat)) || !Number.isFinite(Number(st.lon))) continue;
var o = last[st.id], km = kmOf(st), pred = pickPrediction(st.id, o);
var v95 = kbFuelView(st.id, o, '95'), v92 = kbFuelView(st.id, o, '92'), vdt = kbFuelView(st.id, o, 'diesel');
var f = v95.v === true ? 'yes' : v92.v === true ? 'part' : vdt.v === true ? 'diesel' : null;
if (f) { nows.push({ kind: 'now', st: st, o: o, pred: pred, km: km, f: f, score: 1000 + adviceCoreScore(st, o, km, pred) }); continue; }
var spk = stalePinKey(o);
if (spk) { stales.push({ kind: 'stale', st: st, o: o, pred: pred, km: km, f: spk, unverified: true, score: 500 + adviceCoreScore(st, o, km, pred) }); continue; }
if (pred) {
var g = getPrediction(pred);
if (g.confidence >= 35) {
var sc = g.confidence;
if (km != null) sc -= Math.min(15, km);
var dm = demandOf(st.id);
sc -= dm >= 50 ? 20 : dm >= 30 ? 10 : 0;
sc -= liveQueueCount(st.id) * 2;
fcs.push({ kind: 'forecast', st: st, o: o, pred: pred, km: km, f: null, score: sc });
}
}
}
nows.sort(function (a, b) { return b.score - a.score; });
fcs.sort(function (a, b) { return b.score - a.score; });
stales.sort(function (a, b) { return b.score - a.score; });
var pool = nows.concat(fcs).concat(stales), out = [];
for (var j = 0; j < pool.length && out.length < 3; j++) {
if (!isRejected(pool[j].st.id, adviceFocusFuel(pool[j]))) out.push(pool[j]);
}
return rankByFinalMetrics(out);
};

// ---------- плитки топлива в советнике: статус + происхождение ----------
function tileHtml(fl, vw) {
var cls = vw.v === true ? 'yes' : vw.v === false ? 'no' : (vw.src === 'stale' || vw.src === 'conflict' ? 'warn' : 'none');
var mark = vw.v === true ? ' ' + icon('i-check', 'ic-s') : vw.v === false ? ' ' + icon('i-cross', 'ic-s') : '';
return '<span class="adv-fc kbm ' + cls + ' ' + vw.src + '"' + (vw.dim ? ' style="opacity:.72"' : '') + '>' +
'<b>' + fuelLabel(fl) + '</b>' +
'<i>' + vw.label + mark + '</i>' +
'<em>' + icon(vw.ico, 'ic-s') + '<span>' + escapeHtml(vw.note) + '</span></em>' +
'</span>';
}
function badgeSrc(it) {
if (it.kind !== 'now') return '';
var o = it.o, trust = o ? availTrustworthy(o) : false;
var scene = ['92', '95', 'diesel'].some(function (fl) { try { return !!sceneMark(it.st.id, fl); } catch (e) { return false; } });
if (scene) return 'с места';
if (trust && o && (o.fuel_92_status === true || o.fuel_95_status === true || o.diesel_status === true)) return 'источник';
return 'народ';
}
function mergeAdviceDom() {
var pop = document.getElementById('advicePop');
if (!pop || !pop.classList.contains('open')) return;
var cards = pop.querySelectorAll('.adv-card');
for (var i = 0; i < cards.length; i++) {
var it = adviceList[i];
if (!it) continue;
var grid = cards[i].querySelector('.adv-fuelgrid');
if (grid) {
grid.innerHTML = ['92', '95', 'diesel'].map(function (fl) { return tileHtml(fl, kbFuelView(it.st.id, it.o, fl)); }).join('');
}
var badge = cards[i].querySelector('.adv-badge.yes');
if (badge && !badge.querySelector('.kbm-bsrc')) {
var src = badgeSrc(it);
if (src) badge.insertAdjacentHTML('beforeend', '<i class="kbm-bsrc">· ' + src + '</i>');
}
}
var lead = pop.querySelector('.help-lead');
if (lead && lead.innerHTML.indexOf('kbm-lead') < 0) {
lead.insertAdjacentHTML('beforeend', ' <span class="kbm-lead">Плитки топлива учитывают источник, отметки водителей («народ») и «с места» — как в карточке АЗС.</span>');
}
}
var _rap = renderAdvicePop;
renderAdvicePop = function () {
var ok = _rap();
if (ok) { try { mergeAdviceDom(); } catch (e) { console.log('fuel merge: ' + e.message); } }
return ok;
};

// ---------- живое обновление: новая народная отметка сразу перекрашивает открытый советник ----------
var _bump = bumpContrib;
bumpContrib = function () { var n = _bump(); setTimeout(function () { try { renderAdviceIfOpen(); } catch (e) {} }, 600); return n; };
function sig() {
return (adviceList || []).map(function (it) {
return it.st.id + ':' + ['92', '95', 'diesel'].map(function (fl) { var v = kbFuelView(it.st.id, it.o, fl); return v.label + '/' + v.src; }).join(',');
}).join('|');
}
var lastSig = '';
setInterval(function () {
if (document.hidden || offlineMode) return;
var pop = document.getElementById('advicePop');
if (!pop || !pop.classList.contains('open') || !adviceList.length) return;
var s = sig();
if (lastSig && s !== lastSig) { try { renderAdvicePop(); } catch (e) {} }
lastSig = sig();
}, 20000);
})();
// ============================================================
// KB CHOICE GUARD v1 — «наш выбор» только за подтверждённое топливо
// Порядок советника: сначала станции, где топливо РЕАЛЬНО видно
// (источник / народ / «с места»), затем прогнозы, затем «не точно».
// Баллы цены/расстояния/района сортируют ТОЛЬКО внутри своего класса —
// они больше не могут поднять «нет данных + прогноз» выше подтверждённой АЗС.
// Золотая плашка «наш выбор» выдаётся только классу «есть сейчас»;
// если подтверждённого топлива нет вовсе — плашки нет, без обмана.
// Вставить в САМЫЙ КОНЕЦ app.js. index.html не менять.
// ============================================================
(function () {
'use strict';
if (window.__kbChoiceGuard) return;
window.__kbChoiceGuard = 1;

// класс доказательности: 0 — топливо подтверждено сейчас,
// 1 — только прогноз возврата, 2 — несвежее «есть» источника («не точно»)
function kbTier(it) {
if (!it) return 3;
return it.kind === 'now' ? 0 : it.kind === 'forecast' ? 1 : 2;
}

rankByFinalMetrics = function (list) {
for (var i = 0; i < list.length; i++) list[i]._fs = fullChoiceScore(list[i]);
list.sort(function (a, b) {
var t = kbTier(a) - kbTier(b);
if (t !== 0) return t;               // класс доказательности важнее любых баллов
return (b._fs - a._fs);              // внутри класса — цена/район/очередь/свежесть
});
for (var j = 0; j < list.length; j++) delete list[j].ourChoice;
var our = null;
for (var k = 0; k < list.length; k++) {
if (list[k].kind === 'now') { our = list[k]; break; }
}
if (our) our.ourChoice = true;       // золотом — только подтверждённое наличие
return list;
};
})();
// ============================================================
// KB TILE CLARITY v1 — понятные плитки топлива в советнике
// Было: «народ · 3 подтв. · 25» — хвост «мин назад» обрезался,
// голое число сбивало с толку. Стало: две честные строки —
//   ♥ народ · 3 подтв.
//   🕐 25 мин назад
// Время последней отметки всегда с единицей и словом «назад»,
// перенос разрешён, обрезки нет. Источник / «с места» / «спорно»
// подписаны так же явно. Вставить в САМЫЙ КОНЕЦ app.js.
// ============================================================
(function () {
'use strict';
if (window.__kbTileClarity) return;
window.__kbTileClarity = 1;

(function css() {
if (document.getElementById('kbTileClarityCss')) return;
var s = document.createElement('style');
s.id = 'kbTileClarityCss';
s.textContent =
'.adv-fc.kbm{gap:2px;padding:8px 6px 7px;}' +
'.adv-fc.kbm em{display:flex;align-items:center;justify-content:center;gap:3px;max-width:100%;' +
'white-space:normal;overflow:visible;text-overflow:clip;text-align:center;' +
'font-size:8.5px;line-height:1.25;font-weight:700;opacity:.85;font-style:normal;}' +
'.adv-fc.kbm em span{min-width:0;}' +
'.adv-fc.kbm em .ic{width:9px;height:9px;flex:none;}' +
'.adv-fc.kbm em.kbm2-time{opacity:.62;font-weight:600;}';
document.head.appendChild(s);
})();

function fmtMin(m) {
if (m === null || m === undefined) return '';
if (m < 1) return 'только что';
if (m < 60) return m + ' мин назад';
if (m < 1440) return Math.round(m / 60) + ' ч назад';
return Math.round(m / 1440) + ' дн назад';
}

// минуты последней отметки: народ — свежий голос по этому топливу,
// источник — свежесть снимка, «с места» — время GPS-отметки
function tileMinutes(it, fl, vw) {
var now = Date.now();
if (vw.src === 'folk') {
var want = vw.v === true ? 'available' : 'unavailable';
var t = 0, since = now - 24 * 3600000;
for (var i = 0; i < allFeedback.length; i++) {
var f = allFeedback[i];
if (f.station_id !== it.st.id || f.fuel_type !== fl || f.feedback_type !== want) continue;
var x = new Date(f.created_at).getTime();
if (x >= since && x > t) t = x;
}
return t ? Math.max(0, Math.round((now - t) / 60000)) : null;
}
if (vw.src === 'scene') {
var sc = null; try { sc = sceneMark(it.st.id, fl); } catch (e) {}
return sc ? Math.max(0, Math.round((now - sc.t) / 60000)) : null;
}
if (vw.src === 'source' || vw.src === 'stale' || vw.src === 'stale-no') {
return it.o ? getFreshnessMin(it.o) : null;
}
return null;
}

function provenance(vw) {
if (vw.src === 'folk') return { ico: 'i-heart', txt: 'народ · ' + (vw.votes || 0) + (vw.v === true ? ' подтв.' : ' опр.') };
if (vw.src === 'scene') return { ico: 'i-pin', txt: 'с места' };
if (vw.src === 'source' || vw.src === 'stale' || vw.src === 'stale-no') return { ico: 'i-pump', txt: 'источник' };
if (vw.src === 'conflict') return { ico: 'i-help', txt: 'народ · спорно' };
return { ico: 'i-minus', txt: 'ждём отметок' };
}

function fixTiles() {
if (typeof window.kbFuelView !== 'function') return; // пак объединения не стоит — не трогаем
var pop = document.getElementById('advicePop');
if (!pop || !pop.classList.contains('open')) return;
var cards = pop.querySelectorAll('.adv-card');
for (var i = 0; i < cards.length; i++) {
var it = adviceList[i];
if (!it) continue;
var tiles = cards[i].querySelectorAll('.adv-fc.kbm');
var fuels = ['92', '95', 'diesel'];
for (var k = 0; k < tiles.length && k < 3; k++) {
var fl = fuels[k], vw = window.kbFuelView(it.st.id, it.o, fl);
if (!vw) continue;
var mins = tileMinutes(it, fl, vw);
var pv = provenance(vw);
var mark = vw.v === true ? ' ' + icon('i-check', 'ic-s') : vw.v === false ? ' ' + icon('i-cross', 'ic-s') : '';
var timeLine = mins !== null
? '<em class="kbm2-time">' + icon('i-clock', 'ic-s') + '<span>' + fmtMin(mins) + '</span></em>'
: '';
tiles[k].innerHTML =
'<b>' + fuelLabel(fl) + '</b>' +
'<i>' + vw.label + mark + '</i>' +
'<em class="kbm2-src">' + icon(pv.ico, 'ic-s') + '<span>' + escapeHtml(pv.txt) + '</span></em>' +
timeLine;
tiles[k].setAttribute('title', pv.txt + (mins !== null ? ' · ' + fmtMin(mins) : ''));
}
}
}

var _rap = renderAdvicePop;
renderAdvicePop = function () {
var ok = _rap();
if (ok) { try { fixTiles(); } catch (e) { console.log('tile clarity: ' + e.message); } }
return ok;
};
})();