// ===== Сборщик Новороссийска (v5: РАБОЧАЯ ОСНОВА + очереди + донор волна 1) =====
// Основа — проверенный код с "паспортом браузера" и повторами. НЕ ЛОМАТЬ.
// Комментарии не парсим: у GdeBenz нет открытого API комментариев (Этап 1).
// Волна 1: донор Кубань+Адыгея — наблюдения хранятся экономно (смена статуса
// или heartbeat раз в 1 час); события доноров питают бренд-пулы и эпизоды
// k-NN; сайт и дайджест видят только город (вьюха city_events).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Широкая рамка: Новороссийск + Геленджик + Анапа + Крымск (≈200 км)
// Сбор идёт широко, а на сайте показываем только новороссийские карточки.
const GDEBENZ_URL = 'https://gdebenz.ru/api/stations?lat1=44.40&lon1=37.20&lat2=45.20&lon2=38.60';
// Донорские рамки волны 1 (метка региона пишется в stations.region)
// Рамки НЕ должны пересекаться: одна станция в двух донорах = дубль ключа
// в одном upsert, а Postgres это запрещает («cannot affect row a second time»).
// Стыки границ — только по линиям 46.60 и 41.00, покрытия дыр нет:
// западная колонка до 41.00 — Кубань, восточная до 46.60 — Ставрополье, север — Ростов.
const DONOR_FRAMES = [
  { region: 'kuban', url: 'https://gdebenz.ru/api/stations?lat1=43.30&lon1=38.60&lat2=46.60&lon2=41.00' },
  { region: 'rostov', url: 'https://gdebenz.ru/api/stations?lat1=46.60&lon1=38.80&lat2=48.60&lon2=44.50' },
  { region: 'stavropol', url: 'https://gdebenz.ru/api/stations?lat1=44.20&lon1=41.00&lat2=46.60&lon2=45.90' },
{ region: 'northwest', url: 'https://gdebenz.ru/api/stations?lat1=58.50&lon1=28.00&lat2=62.50&lon2=35.50' }
];

// "Паспорт браузера", чтобы сайт принимал нас за обычного посетителя
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  'Referer': 'https://gdebenz.ru/'
};

async function fetchFrame(url, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      r = await fetch(url, { headers: BROWSER_HEADERS });
    } catch (netErr) {
      // сетевая ошибка (таймаут/DNS/сброс): источник не досягаем — не мучаем ретраями
      const e = new Error(label + ': сеть не пустила (' + netErr.message + ')');
      e.upstream = true;
      throw e;
    }
    if (r.ok) return r.json();
    // 429/503 — источник throttling'ует или под атакой: выходим сразу, без ретраев
    if (r.status === 429 || r.status === 503) {
      const e = new Error(label + ': статус ' + r.status + ' (похоже на DDoS или защиту)');
      e.upstream = true;
      throw e;
    }
    console.log('   ' + label + ': попытка ' + attempt + ': статус ' + r.status + ', жду 10 сек и повторю...');
    await new Promise(res => setTimeout(res, 10000));
  }
  const e = new Error(label + ': не ответил после 3 попыток');
  e.upstream = true;
  throw e;
}
async function fetchGdebenz() { return fetchFrame(GDEBENZ_URL, 'GdeBenz (Новороссийск)'); }

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status + ' ' + await r.text());
  return r.json();
}
// пагинация: циклом по 1000 до конца (таблицы переросли лимит Supabase в 1000 строк)
async function sbGetAll(path) {
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(path + sep + 'limit=1000&offset=' + offset);
    for (const r of page) out.push(r);
    if (page.length < 1000) break;
  }
  return out;
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

// v5.4: вставка наблюдений кусками с повторами: одиночная вставка всех строк
// (дом + доноры, сотни строк) под нагрузкой упиралась в statement timeout
// Supabase (ошибка 57014) и убивала весь цикл, включая толпу и предиктор.
// Кусок 150 строк проходит быстро; случайный сбой базы переживаем до 3 попыток.
async function sbPostChunks(path, rows, chunkSize) {
  const size = chunkSize || 150;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    for (let attempt = 1; ; attempt++) {
      try {
        await sbPost(path, chunk);
        break;
      } catch (e) {
        const msg = String(e.message || '');
        const transient = /500|502|503|504|57014|timeout|failed to fetch|network|load failed/i.test(msg);
        if (!transient || attempt >= 3) throw e;
        console.log('   Кусок ' + (i + 1) + '–' + (i + chunk.length) + ': попытка ' + attempt + ' не удалась (' + msg.slice(0, 120) + '), жду 5 сек...');
        await new Promise(res => setTimeout(res, 5000));
      }
    }
  }
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

async function sbDelete(path) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Prefer: 'return=minimal' }
  });
  if (!r.ok) throw new Error('DELETE ' + path + ' → ' + r.status + ' ' + await r.text());
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
// Живая лента: у каждого события — смысл для водителя, а не голая констатация.
// Варианты чередуются, чтобы лента не выглядела штампом.
const STORY_VARIANTS = {
  fuel_restored: ['🟢 {n}: {f} вернулся'],
  fuel_disappeared: ['🔴 {n}: {f} кончился'],
  queue_appeared: ['🚗 {n}: очередь'],
  queue_gone: ['🚗 {n}: очередь рассосалась'],
  possible_delivery: ['🚛 {n}: привезли'],
  fuel_unavailable: ['🔴 {n}: нет {f} (народ)'],
  fuel_available: ['⛽ {n}: есть {f} (народ)'],
  queue_high: ['🚗 {n}: большая очередь (народ)'],
  queue_low: ['🟢 {n}: свободно (народ)']
};
function eventStoryRu(e, name) {
  const vars = STORY_VARIANTS[e.event_type];
  if (!vars) return eventNameRu(e.event_type) + ' — ' + name;
  const f = e.fuel_type ? fuelNameRu(e.fuel_type) : 'топливо';
  const t = vars[Math.floor(Math.random() * vars.length)];
  return t.split('{n}').join(name).split('{f}').join(f);
}

function fuelNameRu(f) {
  return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : '';
}
// Города юга боксами (те же, что CITY_BOXES сайта): в живой ленте строки
// региона получают конкретный город вместо безликого «(регион)»,
// а строки Новороссийска идут жирным — город владельца виден сразу.
const CITY_BOXES = [
  { name: 'Новороссийск', lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.00 },
  { name: 'Геленджик', lat1: 44.45, lat2: 44.68, lon1: 37.95, lon2: 38.25 },
  { name: 'Анапа', lat1: 44.80, lat2: 45.10, lon1: 37.20, lon2: 37.60 },
  { name: 'Крымск', lat1: 44.85, lat2: 45.05, lon1: 37.85, lon2: 38.15 },
  { name: 'Краснодар', lat1: 44.90, lat2: 45.15, lon1: 38.80, lon2: 39.15 },
  { name: 'Сочи', lat1: 43.35, lat2: 43.75, lon1: 39.60, lon2: 40.10 },
  { name: 'Туапсе', lat1: 44.00, lat2: 44.20, lon1: 39.00, lon2: 39.25 },
  { name: 'Армавир', lat1: 44.90, lat2: 45.10, lon1: 40.90, lon2: 41.20 },
  { name: 'Майкоп', lat1: 44.55, lat2: 44.75, lon1: 40.00, lon2: 40.30 }
];
function cityOfStation(s) {
  if (!s) return null;
  for (const c of CITY_BOXES) if (s.lat >= c.lat1 && s.lat <= c.lat2 && s.lon >= c.lon1 && s.lon <= c.lon2) return c.name;
  return null;
}
// экранирование под HTML-режим Телеграма: имена и адреса приходят с источника как есть
function escTg(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function tg(text, html) {
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
      body: JSON.stringify(html ? { chat_id: chat, text: text, disable_web_page_preview: true, parse_mode: 'HTML' } : { chat_id: chat, text: text, disable_web_page_preview: true })
    });
  } catch (e) { console.log('   ! Телеграм: ' + e.message); }
}
// Уведомление «источник недоступен» — не чаще раза в час: чужой DDoS
// не повод будить владельца каждые 10 минут. Тихий режим bot_meta учитывается внутри tg().
async function tgUpstreamThrottled(text) {
  try {
    const now = Date.now();
    const cur = await sbGet('/rest/v1/bot_meta?key=eq.upstream_alert&select=value');
    const last = cur.length ? Date.parse(cur[0].value) : 0;
    if (now - last < 60 * 60 * 1000) { console.log('   Троттлинг: о недоступности уже сообщали меньше часа назад'); return; }
    await sbPost('bot_meta?on_conflict=key', [{ key: 'upstream_alert', value: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }], 'return=minimal,resolution=merge-duplicates');
    await tg(text);
  } catch (e) { console.log('   ! Троттлинг: ' + e.message); }
}
// Персональное уведомление подписчику (не в чат владельца): HTML-режим,
// чтобы имена АЗС с escTg-экранированием отображались нормально
async function tgTo(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true, parse_mode: 'HTML' })
    });
  } catch (e) { console.log('   ! Персональное уведомление: ' + e.message); }
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

// === Машина состояний v1 (тень): состояние станции по серии статусов АИ-95 ===
// AVAILABLE / SUSPECTED_LOSS / CONFIRMED_LOSS / DEPLETION /
// RECOVERY_STARTED / RECOVERY_CONFIRMED / UNKNOWN (молчание).
// Гистерезис: одно «нет» ещё не дефицит; >=2 подряд — подтверждённая потеря;
// молчание >=1 ч поверх потери — DEPLETION; одно «есть» после потери — только
// начало восстановления, >=3 подряд — снова AVAILABLE.
// Нулевые промежутки короче 6 наблюдений (~1 ч) видим сквозь (дух gap-детектора).
function computeFuelState(hist) {
  const SILENCE = 6;
  let i = 0, gapHead = 0;
  while (i < hist.length && (hist[i] === null || hist[i] === undefined)) { gapHead++; i++; }
  if (i >= hist.length) return 'UNKNOWN'; // за сутки не было ни одной отметки
  const runs = [];
  while (i < hist.length) {
    const v = hist[i];
    let len = 0;
    while (i < hist.length) {
      if (hist[i] === v) { len++; i++; continue; }
      if (hist[i] === null || hist[i] === undefined) {
        let j = i, gap = 0;
        while (j < hist.length && (hist[j] === null || hist[j] === undefined)) { gap++; j++; }
        if (gap < SILENCE && j < hist.length && hist[j] === v) { i = j; continue; }
        break;
      }
      break;
    }
    runs.push({ v: v, len: len });
  }
  const head = runs[0];
  if (gapHead >= SILENCE) return head.v === false ? 'DEPLETION' : 'UNKNOWN';
  if (head.v === false) return head.len >= 2 ? 'CONFIRMED_LOSS' : 'SUSPECTED_LOSS';
  const prev = runs[1];
  if (prev && prev.v === false && prev.len >= 2) {
    if (head.len === 1) return 'RECOVERY_STARTED';
    if (head.len === 2) return 'RECOVERY_CONFIRMED';
  }
  return 'AVAILABLE';
}
// Надёжность v1: доля наблюдений лукбэка, где источник дал хоть одно топливо
function reliabilityOf(histAny) {
  if (!histAny.length) return null;
  let n = 0;
  for (const o of histAny) {
    if (o.fuel_92_status !== null && o.fuel_92_status !== undefined) { n++; continue; }
    if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) { n++; continue; }
    if (o.diesel_status !== null && o.diesel_status !== undefined) n++;
  }
  return Math.round(100 * n / histAny.length) / 100;
}
// === САЙТ: визиты и действия водителей для хозяйского чата ===
// Читаем site_hits с прошлого водяного знака (bot_meta.hits_notify_at) и
// подмешиваем сводку в ТО ЖЕ сообщение, что уходит по событиям топлива.
const HITS_RU = {
  pageview:            ['👀', 'открыли сайт'],
  panel_view:          ['📖', 'листали панели'],
  open_station_card:   ['⛽', 'открывали карточку АЗС'],
  click_where_to_go:   ['🧭', 'жали «Куда ехать»'],
  route_built:         ['🛣️', 'построили маршрут'],
  go_intent:           ['🚗', 'поехали («Поеду сюда»)'],
  price_click:         ['💰', 'смотрели цену'],
  feedback_submit:     ['🙏', 'оставили отметку'],
  advice_reaction:     ['👍', 'реакция на совет'],
  advice_folk_vote:    ['🗳️', 'голос в советнике'],
  fav_add:             ['❤️', 'добавили в избранное'],
  fav_add_advice:      ['❤️', 'избранное из совета'],
  fav_add_route_offer: ['❤️', 'избранное после маршрута'],
  tg_connect:          ['🔗', 'нажали «Телеграм»'],
  tg_linked:           ['✅', 'связка с ботом'],
  pwa_install:         ['📲', 'установили приложение'],
  share_tap:           ['📤', 'нажали «Поделиться»'],
  notif_granted:       ['🔔', 'включили уведомления'],
  prefs_set:           ['⚙️', 'настроили под себя'],
  watch_window:        ['⏰', 'напомнить про окно'],
  near_nudge_show:     ['📍', 'показали «вы рядом»'],
  feedback_undo:       ['↩️', 'отменили отметку'],
  advisor_open:        ['🎯', 'показали советник'],
  top3_loaded:         ['📊', 'показали топ-3']
};
const HITS_ORDER = ['panel_view','open_station_card','click_where_to_go','go_intent',
  'price_click','route_built','feedback_submit','advice_reaction','advice_folk_vote',
  'fav_add','fav_add_advice','fav_add_route_offer','tg_connect','tg_linked','pwa_install',
  'share_tap','notif_granted','prefs_set','watch_window','near_nudge_show','feedback_undo',
  'advisor_open','top3_loaded'];
const HITS_SKIP = ['pageview','heartbeat','session_end','visibility_hidden','visibility_visible'];
const HITS_CITY_RU = {
  novorossiysk:'Новороссийск', gelendzhik:'Геленджик', anapa:'Анапа', krymsk:'Крымск',
  krasnodar:'Краснодар', sochi:'Сочи', tuapse:'Туапсе', armavir:'Армавир',
  maykop:'Майкоп', rostov:'Ростов-на-Дону', stavropol:'Ставрополь'
};
function hitsDur(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return s + ' сек';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' мин';
  return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}
async function siteHitsDigest(nameById) {
  try {
    const now = Date.now();
    const wm = await sbGet('/rest/v1/bot_meta?key=eq.hits_notify_at&select=value');
    const prev = wm.length ? wm[0].value : new Date(now - 15 * 60000).toISOString();
    const rows = await sbGet(
      '/rest/v1/site_hits?created_at=gt.' + encodeURIComponent(prev) +
      '&event=neq.heartbeat&select=session_id,event,station_id,city_key,duration_sec' +
      '&order=created_at.asc&limit=3000'
    );
    await sbPost('bot_meta?on_conflict=key', [{
      key: 'hits_notify_at',
      value: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString()
    }], 'return=minimal,resolution=merge-duplicates');
    if (!rows.length) return '';

    const sessions = new Set(), cnt = {}, stCount = {}, citySess = {}, durs = [];
    let visits = 0;
    for (const r of rows) {
      if (r.session_id) sessions.add(r.session_id);
      cnt[r.event] = (cnt[r.event] || 0) + 1;
      if (r.event === 'pageview') visits++;
      if (r.city_key && r.session_id) {
        (citySess[r.city_key] = citySess[r.city_key] || new Set()).add(r.session_id);
      }
      if ((r.event === 'open_station_card' || r.event === 'click_where_to_go') && r.station_id) {
        stCount[r.station_id] = (stCount[r.station_id] || 0) + 1;
      }
      // duration_sec у session_end упакован: общее*10000 + видимое
      if (r.event === 'session_end' && r.duration_sec !== null && r.duration_sec !== undefined) {
        const d = Number(r.duration_sec);
        const vis = d >= 10000 ? d % 10000 : d;
        if (vis > 0 && vis < 7200) durs.push(vis);
      }
    }

    const lines = [];
    let shown = 0;
    for (const k of HITS_ORDER) {
      if (!cnt[k] || shown >= 8) continue;
      const ru = HITS_RU[k];
      lines.push(ru[0] + ' ' + ru[1] + ': ' + cnt[k]);
      shown++;
    }
    let rest = 0;
    for (const k of Object.keys(cnt)) {
      if (HITS_SKIP.indexOf(k) >= 0) continue;
      if (HITS_ORDER.indexOf(k) < 0 || shown < HITS_ORDER.indexOf(k) + 1) {
        if (HITS_ORDER.indexOf(k) < 0) rest += cnt[k];
      }
    }
    if (rest) lines.push('• прочие действия: ' + rest);

    if (durs.length) {
      durs.sort((a, b) => a - b);
      lines.push('⏱ время на сайте (медиана): ' + hitsDur(durs[Math.floor(durs.length / 2)]));
    }
    // глубина просмотра: карточек АЗС на одного водителя за цикл
    var cardsN = cnt['open_station_card'] || 0;
    if (sessions.size) lines.push('📚 глубина: ' + (Math.round(10 * cardsN / sessions.size) / 10) + ' карточек на водителя');
    const topCity = Object.keys(citySess).sort((a, b) => citySess[b].size - citySess[a].size).slice(0, 3);
    if (topCity.length) {
      lines.push('🏙 ' + topCity.map(k => (HITS_CITY_RU[k] || k) + ' ' + citySess[k].size).join(' · '));
    }
    const topSt = Object.keys(stCount).sort((a, b) => stCount[b] - stCount[a]).slice(0, 2);
    if (topSt.length && nameById) {
      lines.push('⛽ чаще смотрели: ' + topSt.map(id =>
        String(nameById[id] || 'АЗС').split(' · ')[0] + ' — ' + stCount[id]).join(', '));
    }

    return '🌐 <b>САЙТ</b> · водителей: ' + sessions.size + ' · заходов: ' + (visits || sessions.size) +
      (lines.length ? '\n' + lines.join('\n') : '');
  } catch (e) {
    console.log('   ! Сайт-дайджест: ' + e.message);
    return '';
  }
}
// === РЕЙТИНГ СЕРВИСА: блок в хозяйский дайджест (каждые 10 мин) ===
// Агрегат берём готовой SQL-функцией rate_stats (сырые строки не качаем).
// Блок подмешивается в ТО ЖЕ сообщение, что события/сайт. Если с прошлой
// проверки появилась новая оценка — сообщение уходит даже без событий.
function ratingPlural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }
function ratingAgo(iso) {
  if (!iso) return '—';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин назад';
  if (m < 1440) return Math.round(m / 60) + ' ч назад';
  return Math.round(m / 1440) + ' дн назад';
}
async function siteRatingDigest() {
  try {
    const now = Date.now();
    const wm = await sbGet('/rest/v1/bot_meta?key=eq.rating_notify_at&select=value');
    const prev = wm.length ? wm[0].value : new Date(now - 15 * 60000).toISOString();
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/rate_stats', {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_device: null })
    });
    if (!r.ok) throw new Error('rate_stats HTTP ' + r.status);
    const st = await r.json();
    await sbPost('bot_meta?on_conflict=key', [{ key: 'rating_notify_at', value: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }], 'return=minimal,resolution=merge-duplicates');
    const total = Number((st && st.total) || 0);
    const hasNew = !!(st && st.last_at && new Date(st.last_at).getTime() > new Date(prev).getTime());
    if (!total && !hasNew) return { text: '', hasNew: false };
    const f1 = v => v == null ? '—' : Number(v).toFixed(1).replace('.', ',');
    const a = (st && st.avg) || {};
    const dist = (st && st.dist) || [0, 0, 0, 0, 0];
    const lines = [];
    lines.push('⭐ <b>РЕЙТИНГ</b> · ★ ' + f1(a.overall) + '/5 · ' + total + ' ' + ratingPlural(total, ['водитель оценил', 'водителя оценили', 'водителей оценили']) + (st && st.week ? ' · +' + st.week + ' за неделю' : ''));
    lines.push('последняя оценка: ' + ratingAgo(st && st.last_at));
    lines.push('5★ ' + dist[4] + ' · 4★ ' + dist[3] + ' · 3★ ' + dist[2] + ' · 2★ ' + dist[1] + ' · 1★ ' + dist[0]);
    lines.push('удобство ' + f1(a.interface) + ' · точность ' + f1(a.accuracy) + ' · скорость ' + f1(a.speed) + ' · дизайн ' + f1(a.design));
    if (hasNew) lines.push('🆕 с прошлой проверки есть новые оценки');
    return { text: lines.join('\n'), hasNew };
  } catch (e) {
    console.log('   ! Рейтинг-дайджест: ' + e.message);
    return { text: '', hasNew: false };
  }
}
// ============================================================
// KB SOUTH DIGEST (серверная часть) — «Сводка по Югу» каждые 4 часа.
// Выпуски 00/04/08/12/16/20 МСК. Пишет рядом с index.html:
// svodka.html (страница для поиска), sitemap.xml, robots.txt, svodka.json.
// Работает внутри обычного цикла коллектора: отдельный cron не нужен.
// Папку сайта ищет сама (где лежит index.html); если не нашла —
// скажет в логе, тогда задай SVODKA_DIR в cron.
// ============================================================
const SD_FS = require('fs');
const SD_PATH = require('path');
const SD_SITE = 'https://kogdabenz.ru';
const SD_H = 3600000;
const SD_BOXES = [
  { key: 'novorossiysk', name: 'Новороссийск', inn: 'Новороссийске', lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.00 },
  { key: 'gelendzhik', name: 'Геленджик', inn: 'Геленджике', lat1: 44.45, lat2: 44.68, lon1: 37.95, lon2: 38.25 },
  { key: 'anapa', name: 'Анапа', inn: 'Анапе', lat1: 44.80, lat2: 45.10, lon1: 37.20, lon2: 37.60 },
  { key: 'krymsk', name: 'Крымск', inn: 'Крымске', lat1: 44.85, lat2: 45.05, lon1: 37.85, lon2: 38.15 },
  { key: 'krasnodar', name: 'Краснодар', inn: 'Краснодаре', lat1: 44.90, lat2: 45.15, lon1: 38.80, lon2: 39.15 },
  { key: 'sochi', name: 'Сочи', inn: 'Сочи', lat1: 43.35, lat2: 43.75, lon1: 39.60, lon2: 40.10 },
  { key: 'tuapse', name: 'Туапсе', inn: 'Туапсе', lat1: 44.00, lat2: 44.20, lon1: 39.00, lon2: 39.25 },
  { key: 'armavir', name: 'Армавир', inn: 'Армавире', lat1: 44.90, lat2: 45.10, lon1: 40.90, lon2: 41.20 },
  { key: 'maykop', name: 'Майкоп', inn: 'Майкопе', lat1: 44.55, lat2: 44.75, lon1: 40.00, lon2: 40.30 },
  { key: 'rostov', name: 'Ростов-на-Дону', inn: 'Ростове-на-Дону', lat1: 47.15, lat2: 47.35, lon1: 39.55, lon2: 39.85 },
  { key: 'stavropol', name: 'Ставрополь', inn: 'Ставрополе', lat1: 44.80, lat2: 45.25, lon1: 41.60, lon2: 42.30 }
];
const SD_SUSPECT = { SUSPECTED_LOSS: 1, CONFIRMED_LOSS: 1, DEPLETION: 1, RECOVERY_STARTED: 1 };
function sdMsk() { return new Date(Date.now() + 3 * SD_H); }
function sdBucket() {
  const m = sdMsk();
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate(), Math.floor(m.getUTCHours() / 4) * 4) - 3 * SD_H);
}
function sdPad(n) { return String(n).padStart(2, '0'); }
function sdStamp(d) { return sdPad(d.getUTCDate()) + '.' + sdPad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ', ' + sdPad(d.getUTCHours()) + ':' + sdPad(d.getUTCMinutes()); }
function sdMin(v) { const s = String(v || ''); return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)); }
function sdT5(v) { return String(v || '').slice(0, 5); }
function sdFuel(f) { return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : 'топливо'; }
function sdEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function sdCityOf(st) {
  const lat = Number(st.lat), lon = Number(st.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  for (const c of SD_BOXES) if (lat >= c.lat1 && lat <= c.lat2 && lon >= c.lon1 && lon <= c.lon2) return c.key;
  return null;
}
function sdFreshMin(o) {
  if (!o) return null;
  if (o.data_freshness_minutes !== null && o.data_freshness_minutes !== undefined) return Number(o.data_freshness_minutes);
  if (o.timestamp) return Math.max(0, Math.round((Date.now() - new Date(o.timestamp).getTime()) / 60000));
  return null;
}
function sdTrust(o) { const m = sdFreshMin(o); return m !== null && m <= 360 && !SD_SUSPECT[o.fuel_state]; }
function sdWinKey(p, nowM, today) {
  const f = sdMin(p.from_time), t = sdMin(p.to_time);
  if (p.target_date && p.target_date > today) return 1440 + f;
  if (p.target_date && p.target_date < today) return 1e9;
  if (nowM >= f && nowM <= t) return 0;
  if (f > nowM) return f - nowM;
  return 1e8;
}
function sdSiteDir() {
  const cands = [process.env.SVODKA_DIR, process.cwd(), __dirname, '/var/www/kogdabenz', '/var/www/kogdabenz.ru', '/var/www/html', '/var/www'];
  for (const d of cands) {
    if (!d) continue;
    try { if (SD_FS.existsSync(SD_PATH.join(d, 'index.html'))) return d; } catch (e) {}
  }
  return null;
}
function sdWrite(dir, name, text) {
  const p = SD_PATH.join(dir, name), tmp = p + '.tmp';
  SD_FS.writeFileSync(tmp, text, 'utf8');
  SD_FS.renameSync(tmp, p);
}

async function southDigest() {
  try {
    const bucket = sdBucket();
    const bIso = bucket.toISOString();
    const gate = await sbGet('/rest/v1/bot_meta?key=eq.svodka_bucket&select=value');
    if (gate.length && gate[0].value === bIso) return; // выпуск уже собран

    const dir = sdSiteDir();
    if (!dir) {
      console.log('   ! Сводка юга: папка сайта не найдена (нет index.html рядом). Задай в cron SVODKA_DIR=/путь/папки/сайта');
      return;
    }

    const stations = await sbGetAll('/rest/v1/stations?select=id,name,brand,address,lat,lon&order=id.asc');
    const obsRows = await sbGetAll('/rest/v1/observations?timestamp=gte.' + new Date(Date.now() - 6 * SD_H).toISOString() + '&order=timestamp.desc&select=station_id,timestamp,fuel_92_status,fuel_95_status,diesel_status,queue_level,data_freshness_minutes,fuel_state');
    const last = {};
    for (const o of obsRows) if (!last[o.station_id]) last[o.station_id] = o;
    const preds = await sbGetAll('/rest/v1/predictions?result=eq.PENDING&select=station_id,fuel_type,from_time,to_time,target_date,confidence&order=id.asc');
    const evs = await sbGetAll('/rest/v1/events?event_type=in.(fuel_disappeared,fuel_restored)&detected_at=gte.' + new Date(Date.now() - 24 * SD_H).toISOString() + '&order=detected_at.desc&select=station_id,event_type,fuel_type,detected_at');
    const fb = await sbGet('/rest/v1/user_feedback?order=created_at.desc&limit=500&select=station_id,fuel_type,feedback_type,created_at,verified_on_site,device_id');

    const nowM = sdMsk().getUTCHours() * 60 + sdMsk().getUTCMinutes();
    const today = sdMsk().toISOString().slice(0, 10);

    const pairChg = {};
    for (const e of evs) {
      const t = new Date(e.detected_at).getTime();
      const k = e.station_id + '|' + e.fuel_type;
      if (!pairChg[k] || t > pairChg[k]) pairChg[k] = t;
    }
    const folk = {}, onSite = {};
    for (const f of fb) {
      const t = new Date(f.created_at).getTime();
      const k = f.station_id + '|' + f.fuel_type;
      if (f.feedback_type === 'available' && f.verified_on_site && Date.now() - t <= 2 * SD_H) onSite[k] = true;
      if (Date.now() - t > 24 * SD_H) continue;
      if (f.feedback_type !== 'available' && f.feedback_type !== 'unavailable') continue;
      if (pairChg[k] && t <= pairChg[k]) continue;
      const g = folk[k] || (folk[k] = { y: {}, n: {} });
      if (f.feedback_type === 'available') g.y[f.device_id || '?'] = 1; else g.n[f.device_id || '?'] = 1;
    }
    const predBy = {};
    for (const p of preds) (predBy[p.station_id] = predBy[p.station_id] || []).push(p);

    function state(id, o, fl) {
      const col = fl === '92' ? 'fuel_92_status' : fl === '95' ? 'fuel_95_status' : 'diesel_status';
      const k = id + '|' + fl;
      if (onSite[k]) return { v: true, src: 'с места' };
      const raw = o ? o[col] : null;
      if (sdTrust(o)) {
        if (raw === true) return { v: true, src: 'источник' };
        if (raw === false) return { v: false, src: 'источник' };
      }
      const g = folk[k];
      if (g) {
        const ny = Object.keys(g.y).length, nn = Object.keys(g.n).length;
        if (ny >= 2 && ny > nn) return { v: true, src: 'водители (' + ny + ')' };
        if (nn >= 2 && nn > ny) return { v: false, src: 'водители (' + nn + ')' };
      }
      if (raw === true) return { v: null, src: 'не подтверждено' };
      if (raw === false) return { v: false, src: 'источник (давно)' };
      return { v: null, src: 'нет данных' };
    }

    const cities = {};
    for (const c of SD_BOXES) cities[c.key] = { key: c.key, name: c.name, inn: c.inn, total: 0, known: 0, a92: 0, a95: 0, adt: 0, any: 0, q: 0, sts: [], wins: [] };
    for (const st of stations) {
      const ck = sdCityOf(st);
      if (!ck) continue;
      const c = cities[ck], o = last[st.id];
      c.total++;
      const s92 = state(st.id, o, '92'), s95 = state(st.id, o, '95'), sdt = state(st.id, o, 'diesel');
      if (s92.src !== 'нет данных' || s95.src !== 'нет данных' || sdt.src !== 'нет данных') c.known++;
      if (s92.v === true) c.a92++;
      if (s95.v === true) c.a95++;
      if (sdt.v === true) c.adt++;
      const has = s92.v === true || s95.v === true || sdt.v === true;
      if (has) c.any++;
      const q = !!(o && o.queue_level === 'high');
      if (q) c.q++;
      let best = null;
      for (const p of (predBy[st.id] || [])) {
        const conf = Math.round((p.confidence || 0) * 100);
        const k = sdWinKey(p, nowM, today);
        if (conf < 35 || k >= 1e8) continue;
        if (!best || k < sdWinKey(best, nowM, today)) best = p;
      }
      const row = { id: st.id, name: st.name || 'АЗС', address: st.address || '', s92: s92, s95: s95, sdt: sdt, q: q, has: has, pred: best };
      c.sts.push(row);
      if (best) c.wins.push({ st: row, city: c.name, p: best, k: sdWinKey(best, nowM, today), conf: Math.round((best.confidence || 0) * 100) });
    }
    const list = Object.keys(cities).map(k => cities[k]).filter(c => c.total > 0);
    for (const c of list) {
      c.share = c.known ? c.a95 / c.known : null;
      c.level = c.known < 3 ? 'n' : c.share >= 0.6 ? 'g' : c.share >= 0.25 ? 'y' : 'r';
      c.wins.sort((a, b) => a.k - b.k);
      c.sts.sort((a, b) => (b.has - a.has) || ((a.pred ? 0 : 1) - (b.pred ? 0 : 1)));
    }
    list.sort((a, b) => ((a.known >= 3 ? 0 : 1) - (b.known >= 3 ? 0 : 1)) || ((a.share == null ? 9 : a.share) - (b.share == null ? 9 : b.share)) || (b.total - a.total));
    const T = { total: 0, known: 0, a92: 0, a95: 0, adt: 0, any: 0, q: 0, wins: 0, cities: list.length };
    for (const c of list) { T.total += c.total; T.known += c.known; T.a92 += c.a92; T.a95 += c.a95; T.adt += c.adt; T.any += c.any; T.q += c.q; T.wins += c.wins.length; }
    const topWins = list.flatMap(c => c.wins).sort((a, b) => a.k - b.k).slice(0, 10);
    const stById = {};
    for (const st of stations) stById[st.id] = st;
    const changes = [];
    for (const e of evs) {
      const t = new Date(e.detected_at).getTime();
      if (t < bucket.getTime()) continue;
      const st = stById[e.station_id];
      if (!st) continue;
      const ck = sdCityOf(st);
      if (!ck) continue;
      const d = new Date(t + 3 * SD_H);
      changes.push({ t: sdPad(d.getUTCHours()) + ':' + sdPad(d.getUTCMinutes()), city: cities[ck].name, name: st.name || 'АЗС', fuel: sdFuel(e.fuel_type), back: e.event_type === 'fuel_restored' });
    }
    changes.sort((a, b) => b.t.localeCompare(a.t));
    const chList = changes.slice(0, 12);

    const stamp = sdStamp(bucket);
    const nxt = sdStamp(new Date(bucket.getTime() + 4 * SD_H)).slice(-5);
    const title = 'Когда привезут бензин на юге — сводка по АЗС на ' + stamp + ' МСК';
    const desc = 'Сводка по югу России на ' + stamp + ' МСК: АИ-95 есть на ' + T.a95 + ' из ' + T.known + ' АЗС, ' + T.wins + ' прогнозов окон привоза, ' + T.q + ' АЗС с очередью. ' + T.cities + ' городов. Обновляется каждые 4 часа.';
    const pill = s => '<span class="pill ' + (s.v === true ? 'y' : s.v === false ? 'n' : 'u') + '">' + (s.v === true ? 'есть' : s.v === false ? 'нет' : '—') + '</span>';
    const word = { g: 'спокойно', y: 'напряжённо', r: 'дефицит', n: 'мало данных' };

    const winsHtml = topWins.length ? topWins.map(w =>
      '<div class="win"><div class="t"><b>' + sdT5(w.p.from_time) + '–' + sdT5(w.p.to_time) + '</b><span>' + (w.k >= 1440 ? 'завтра' : w.k === 0 ? 'сейчас' : 'сегодня') + '</span></div>' +
      '<div class="m"><b>' + sdEsc(w.st.name) + '</b><span>' + sdEsc(w.city) + ' · ' + sdEsc(w.st.address) + '</span></div>' +
      '<div class="c">' + w.conf + '%</div></div>').join('') : '<div class="cr">Прогнозы окон привоза пока накапливаются.</div>';
    const chHtml = chList.length ? chList.map(c =>
      '<div class="cr"><i class="' + (c.back ? 'g' : 'r') + '"></i><span><b>' + sdEsc(c.city) + '</b> · ' + sdEsc(c.name) + ' — ' + sdEsc(c.fuel) + (c.back ? ' вернулось' : ' пропало') + '</span><em>' + c.t + '</em></div>').join('') : '<div class="cr">За этот выпуск изменений не зафиксировано — на юге спокойно.</div>';
    const navHtml = list.map(c => '<a href="#' + c.key + '">' + sdEsc(c.name) + '</a>').join('');
    const blocksHtml = list.map(c => {
      const rows = c.sts.slice(0, 40).map(r => {
        const p = r.pred;
        const win = p ? '<span class="wt">' + sdT5(p.from_time) + '–' + sdT5(p.to_time) + '</span><br><span class="cf">' + sdEsc(sdFuel(p.fuel_type)) + ' · ' + Math.round((p.confidence || 0) * 100) + '%</span>' : '<span class="cf">окно копится</span>';
        return '<tr><td><b>' + sdEsc(r.name) + '</b><span class="ad">' + sdEsc(r.address) + '</span></td><td>' + pill(r.s92) + '</td><td>' + pill(r.s95) + '</td><td>' + pill(r.sdt) + '</td><td>' + (r.q ? 'очередь' : '—') + '</td><td>' + win + '</td></tr>';
      }).join('');
      return '<section class="card" id="' + c.key + '"><div class="ch"><span class="dot ' + c.level + '"></span><h3>Бензин в ' + sdEsc(c.inn) + '</h3><span class="st">' + word[c.level] + '</span><span class="n">АИ-95: <b>' + c.a95 + '</b> из ' + c.known + ' · окон: <b>' + c.wins.length + '</b></span></div>' +
        '<div class="tw"><table><thead><tr><th>АЗС</th><th>АИ-92</th><th>АИ-95</th><th>Дизель</th><th>Очередь</th><th>Окно привоза</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
    }).join('');
    const faq = [
      ['Где сейчас есть бензин на юге России?', 'На ' + stamp + ' МСК АИ-95 подтверждён на ' + T.a95 + ' из ' + T.known + ' АЗС с данными, АИ-92 — на ' + T.a92 + ', дизель — на ' + T.adt + '. Всего в сводке ' + T.cities + ' городов и ' + T.total + ' заправок юга. Данные обновляются каждые 4 часа.'],
      ['Когда привезут бензин на заправку?', 'Для каждой АЗС считается окно возврата — интервал часов, когда топливо обычно возвращается. Сейчас по югу активно ' + T.wins + ' таких окон. Рядом с окном указана уверенность в процентах: это вероятность, а не гарантия привоза.'],
      ['Как считается сводка?', 'Из двух источников: снимки наличия топлива на АЗС каждые 10 минут и отметки самих водителей «есть / нет / очередь / привезли». Отметка водителя с места по GPS сильнее устаревших данных. Прогнозы окон проверяются каждую ночь по фактическим привозам.'],
      ['Чем это отличается от карты наличия?', 'Карта отвечает на вопрос «где есть сейчас». В дефицит она вся красная. Эта сводка отвечает на вопрос «когда привезут и стоит ли ехать» — по всем городам юга сразу, с окнами возврата и очередями.']
    ];
    const faqHtml = faq.map(q => '<details><summary>' + sdEsc(q[0]) + '</summary><p>' + sdEsc(q[1]) + '</p></details>').join('');
    const ldArticle = { '@context': 'https://schema.org', '@type': 'Article', headline: title, description: desc, datePublished: bIso, dateModified: bIso, inLanguage: 'ru-RU', author: { '@type': 'Organization', name: 'КогдаБенз', url: SD_SITE + '/' }, publisher: { '@type': 'Organization', name: 'КогдаБенз', logo: { '@type': 'ImageObject', url: SD_SITE + '/icon-192.png' } }, image: SD_SITE + '/icon-512.png', mainEntityOfPage: { '@type': 'WebPage', '@id': SD_SITE + '/svodka.html' }, spatialCoverage: list.map(c => c.name) };
    const ldFaq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(q => ({ '@type': 'Question', name: q[0], acceptedAnswer: { '@type': 'Answer', text: q[1] } })) };
    const ldBread = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'КогдаБенз', item: SD_SITE + '/' }, { '@type': 'ListItem', position: 2, name: 'Сводка по Югу', item: SD_SITE + '/svodka.html' }] };

    const css = ':root{--ink:#0a1024;--surf:#121a2e;--surf2:#16203a;--line:rgba(148,180,255,.16);--txt:#ebf3ff;--mut:#93a0b8;--blue:#4b93ff;--blue2:#2465ee;--green:#2fd39a;--amber:#f5a05a;--red:#ff8a80}' +
      '*{box-sizing:border-box}html{scroll-behavior:smooth}' +
      'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;color:var(--txt);background:radial-gradient(900px 520px at 88% -8%,rgba(36,101,238,.30),transparent 62%),radial-gradient(760px 480px at 4% 22%,rgba(25,183,122,.16),transparent 60%),linear-gradient(180deg,#0d1526,#0a1024 60%,#080d1c);background-attachment:fixed;line-height:1.55}' +
      '::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-track{background:#0d1526}::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--blue),var(--blue2));border-radius:9px;border:2px solid #0d1526}' +
      'a{color:var(--blue);text-decoration:none}.wrap{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:0 16px 64px}' +
      'header{position:sticky;top:0;z-index:20;backdrop-filter:blur(18px) saturate(1.4);background:rgba(10,16,36,.82);border-bottom:1px solid var(--line)}' +
      '.hd{max-width:1080px;margin:0 auto;padding:11px 16px;display:flex;align-items:center;gap:12px}.logo{font-weight:900;font-size:17px}.logo span{color:var(--blue)}' +
      '.hd .go{margin-left:auto;display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:99px;font-weight:800;font-size:13px;color:#fff;background:linear-gradient(135deg,#4b93ff,#2465ee 60%,#1746c8);box-shadow:0 6px 20px rgba(36,101,238,.4)}' +
      'nav{display:flex;gap:7px;overflow-x:auto;padding:9px 16px;max-width:1080px;margin:0 auto;scrollbar-width:none}nav::-webkit-scrollbar{height:0}' +
      'nav a{flex:none;font-size:12px;font-weight:700;color:var(--mut);padding:6px 11px;border-radius:99px;border:1px solid var(--line);background:rgba(148,180,255,.05)}' +
      '.hero{padding:34px 0 8px}.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:900;letter-spacing:.9px;text-transform:uppercase;color:var(--green);background:rgba(25,183,122,.12);border:1px solid rgba(25,183,122,.32);padding:6px 13px;border-radius:99px}' +
      '.eyebrow i{width:7px;height:7px;border-radius:50%;background:var(--green);animation:p 1.9s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}' +
      'h1{font-size:clamp(27px,5.4vw,44px);line-height:1.12;margin:16px 0 10px;font-weight:900;letter-spacing:-1px}' +
      'h1 em{font-style:normal;background:linear-gradient(100deg,#4b93ff,#2fd39a 55%,#b7a8ff);-webkit-background-clip:text;background-clip:text;color:transparent}' +
      '.lead{font-size:15px;color:var(--mut);max-width:70ch;font-weight:500}.stamp{margin-top:12px;font-size:13px;font-weight:700;color:var(--mut)}.stamp b{color:var(--txt)}' +
      '.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:11px;margin:24px 0 6px}' +
      '.k{background:linear-gradient(160deg,var(--surf2),var(--surf));border:1px solid var(--line);border-radius:18px;padding:15px 16px;position:relative;overflow:hidden}' +
      '.k small{display:block;font-size:10.5px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--mut)}' +
      '.k b{display:block;font-size:34px;font-weight:900;letter-spacing:-1.4px;margin-top:5px;line-height:1}.k i{display:block;font-style:normal;font-size:11.5px;color:var(--mut);margin-top:5px;font-weight:600}' +
      '.k.g b{color:var(--green)}.k.b b{color:var(--blue)}.k.y b{color:var(--amber)}.k.r b{color:var(--red)}' +
      'h2{font-size:clamp(20px,3.4vw,27px);margin:44px 0 6px;font-weight:900;letter-spacing:-.5px;scroll-margin-top:120px}.sub{color:var(--mut);font-size:13.5px;margin-bottom:16px;font-weight:500}' +
      '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:11px}' +
      '.win{display:flex;gap:12px;align-items:center;background:linear-gradient(160deg,var(--surf2),var(--surf));border:1px solid var(--line);border-radius:16px;padding:13px 15px}' +
      '.win .t{flex:none;text-align:center;border-radius:12px;padding:8px 10px;min-width:88px;background:rgba(75,147,255,.14);border:1px solid rgba(75,147,255,.3)}' +
      '.win .t b{display:block;font-size:15px;font-weight:900;color:var(--blue)}.win .t span{display:block;font-size:9.5px;font-weight:800;color:var(--mut);text-transform:uppercase}' +
      '.win .m{min-width:0}.win .m b{display:block;font-size:14px;font-weight:800}.win .m span{display:block;font-size:12px;color:var(--mut)}.win .c{margin-left:auto;flex:none;font-size:19px;font-weight:900;color:var(--green)}' +
      '.card{background:linear-gradient(165deg,var(--surf2),var(--surf));border:1px solid var(--line);border-radius:20px;padding:16px 16px 8px;margin-bottom:14px}' +
      '.ch{display:flex;align-items:center;gap:11px;flex-wrap:wrap;margin-bottom:10px}.dot{width:11px;height:11px;border-radius:50%;flex:none}' +
      '.dot.g{background:var(--green)}.dot.y{background:var(--amber)}.dot.r{background:var(--red)}.dot.n{background:#7d8ba0}' +
      '.ch h3{margin:0;font-size:19px;font-weight:900}.ch .st{font-size:11px;font-weight:800;padding:4px 10px;border-radius:99px;background:rgba(148,180,255,.1);color:var(--mut)}' +
      '.ch .n{margin-left:auto;font-size:13px;font-weight:800;color:var(--mut)}.ch .n b{color:var(--txt);font-size:16px}' +
      '.tw{overflow-x:auto;border-radius:14px;border:1px solid var(--line)}table{width:100%;border-collapse:collapse;font-size:13px;min-width:600px}' +
      'th{background:rgba(148,180,255,.07);text-align:left;padding:10px 12px;font-size:10.5px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--mut);white-space:nowrap}' +
      'td{padding:10px 12px;border-top:1px solid rgba(148,180,255,.09);vertical-align:middle}tr:hover td{background:rgba(148,180,255,.045)}td b{font-weight:800}td .ad{display:block;font-size:11.5px;color:var(--mut)}' +
      '.pill{display:inline-block;border-radius:7px;padding:3px 8px;font-size:11px;font-weight:900;white-space:nowrap}' +
      '.pill.y{background:rgba(25,183,122,.16);color:var(--green)}.pill.n{background:rgba(239,83,80,.15);color:var(--red)}.pill.u{background:rgba(148,180,255,.09);color:var(--mut)}' +
      '.wt{font-weight:900;color:var(--blue);white-space:nowrap}.cf{color:var(--mut);font-size:11.5px;font-weight:700}' +
      '.chg{display:flex;flex-direction:column;gap:7px}.cr{display:flex;align-items:center;gap:10px;background:rgba(148,180,255,.05);border:1px solid var(--line);border-radius:12px;padding:9px 13px;font-size:13px}' +
      '.cr i{width:8px;height:8px;border-radius:50%;flex:none}.cr i.g{background:var(--green)}.cr i.r{background:var(--red)}.cr em{margin-left:auto;font-style:normal;color:var(--mut);font-weight:800}' +
      '.faq{display:flex;flex-direction:column;gap:9px}details{background:linear-gradient(160deg,var(--surf2),var(--surf));border:1px solid var(--line);border-radius:15px;padding:13px 16px}' +
      'summary{cursor:pointer;font-weight:800;font-size:14.5px;list-style:none;display:flex;gap:10px;align-items:center}summary::-webkit-details-marker{display:none}' +
      'summary::before{content:"+";color:var(--blue);font-weight:900;font-size:19px;line-height:1}details[open] summary::before{content:"–"}details p{margin:10px 0 0;color:var(--mut);font-size:13.5px}' +
      '.cta{margin:36px 0 0;border-radius:22px;padding:24px;text-align:center;background:linear-gradient(135deg,rgba(36,101,238,.24),rgba(25,183,122,.16) 60%,rgba(124,109,255,.2));border:1px solid rgba(148,180,255,.28)}' +
      '.cta h2{margin:0 0 8px}.cta p{color:var(--mut);margin:0 0 16px;font-size:14px}' +
      '.cta a{display:inline-block;padding:13px 26px;border-radius:99px;font-weight:900;font-size:15px;color:#fff;background:linear-gradient(135deg,#4b93ff,#2465ee 60%,#1746c8);box-shadow:0 10px 30px rgba(36,101,238,.45)}' +
      'footer{margin-top:38px;padding-top:18px;border-top:1px solid var(--line);color:var(--mut);font-size:12.5px}footer b{color:var(--txt)}' +
      '@media(max-width:640px){.hd .go{padding:8px 12px;font-size:12px}.k b{font-size:28px}}';

    const html = '<!DOCTYPE html>\n<html lang="ru"><head>\n<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>' + sdEsc(title) + '</title>\n' +
      '<meta name="description" content="' + sdEsc(desc) + '">\n<link rel="canonical" href="' + SD_SITE + '/svodka.html">\n' +
      '<meta property="og:type" content="article"><meta property="og:locale" content="ru_RU"><meta property="og:title" content="' + sdEsc(title) + '"><meta property="og:description" content="' + sdEsc(desc) + '"><meta property="og:url" content="' + SD_SITE + '/svodka.html"><meta property="og:image" content="' + SD_SITE + '/icon-512.png">\n' +
      '<meta name="twitter:card" content="summary_large_image"><link rel="icon" href="' + SD_SITE + '/icon-192.png">\n<style>' + css + '</style>\n' +
      '<script type="application/ld+json">' + JSON.stringify(ldArticle) + '</script>\n<script type="application/ld+json">' + JSON.stringify(ldFaq) + '</script>\n<script type="application/ld+json">' + JSON.stringify(ldBread) + '</script>\n</head><body>\n' +
      '<header><div class="hd"><div class="logo">Когда<span>Бенз</span></div><a class="go" href="' + SD_SITE + '/">Живая карта юга →</a></div><nav>' + navHtml + '</nav></header>\n' +
      '<div class="wrap">\n<div class="hero">\n<span class="eyebrow"><i></i>Автовыпуск каждые 4 часа</span>\n<h1>Когда привезут бензин <em>на юге России</em></h1>\n' +
      '<p class="lead">Общая сводка по всем городам юга: где топливо есть сейчас, на каких АЗС очередь и в какие часы ожидается привоз. Не один город — весь юг сразу: Краснодарский край, Адыгея, Ростовская область и Ставрополье.</p>\n' +
      '<p class="stamp">Выпуск <b>' + stamp + ' МСК</b> · следующий в <b>' + nxt + ' МСК</b> · ' + T.cities + ' городов · ' + T.total + ' АЗС</p>\n</div>\n' +
      '<div class="kpi"><div class="k g"><small>АИ-95 есть</small><b>' + T.a95 + '</b><i>из ' + T.known + ' АЗС с данными</i></div><div class="k b"><small>Окна привоза</small><b>' + T.wins + '</b><i>прогнозов на сегодня и завтра</i></div><div class="k y"><small>Очереди</small><b>' + T.q + '</b><i>АЗС с очередью сейчас</i></div><div class="k r"><small>АИ-92 / дизель</small><b>' + T.a92 + ' / ' + T.adt + '</b><i>АЗС с топливом</i></div></div>\n' +
      '<h2 id="windows">Ближайшие окна привоза по югу</h2>\n<p class="sub">Интервалы, когда топливо обычно возвращается на заправку. Процент — уверенность прогноза, проверяемая по фактическим привозам каждую ночь.</p>\n<div class="grid">' + winsHtml + '</div>\n' +
      '<h2 id="changes">Что изменилось за последние 4 часа</h2>\n<p class="sub">События по всем городам юга с начала выпуска.</p>\n<div class="chg">' + chHtml + '</div>\n' +
      '<h2 id="cities">Наличие топлива по городам</h2>\n<p class="sub">Сначала города, где напряжённее. Таблица по каждой АЗС: марки топлива, очередь и окно возврата.</p>\n' + blocksHtml + '\n' +
      '<h2 id="faq">Частые вопросы</h2>\n<div class="faq">' + faqHtml + '</div>\n' +
      '<div class="cta"><h2>Проверить свою заправку прямо сейчас</h2><p>Живая карта обновляется каждые 10 минут, показывает очереди и отправляет уведомление в Telegram, когда топливо вернулось на избранную АЗС.</p><a href="' + SD_SITE + '/">Открыть КогдаБенз</a></div>\n' +
      '<footer><b>КогдаБенз</b> — карта наличия топлива и прогнозов привоза на юге России. Сводка формируется автоматически каждые 4 часа: 00:00, 04:00, 08:00, 12:00, 16:00 и 20:00 МСК. Прогноз — вероятность, а не гарантия фактического появления топлива. Данные: отметки АЗС и сообщения водителей.<br>Обновлено ' + stamp + ' МСК.</footer>\n</div></body></html>';

    sdWrite(dir, 'svodka.html', html);
    sdWrite(dir, 'sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + SD_SITE + '/</loc><lastmod>' + bIso + '</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>\n  <url><loc>' + SD_SITE + '/svodka.html</loc><lastmod>' + bIso + '</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>\n</urlset>\n');
    const rp = SD_PATH.join(dir, 'robots.txt');
    let body = '';
    try { if (SD_FS.existsSync(rp)) body = SD_FS.readFileSync(rp, 'utf8'); } catch (e) {}
    const line = 'Sitemap: ' + SD_SITE + '/sitemap.xml';
    if (body.indexOf(line) < 0) {
      if (body.indexOf('User-agent') < 0) body = 'User-agent: *\nAllow: /\n';
      sdWrite(dir, 'robots.txt', body.replace(/\s+$/, '') + '\n\n' + line + '\n');
    }
    sdWrite(dir, 'svodka.json', JSON.stringify({ generated: bIso, totals: T, cities: list.map(c => ({ key: c.key, name: c.name, total: c.total, known: c.known, a92: c.a92, a95: c.a95, adt: c.adt, any: c.any, q: c.q, level: c.level })) }, null, 1));
    await sbPost('bot_meta?on_conflict=key', [{ key: 'svodka_bucket', value: bIso, updated_at: new Date().toISOString() }], 'return=minimal,resolution=merge-duplicates');
    console.log('   Сводка юга: городов ' + T.cities + ', АЗС ' + T.total + ', АИ-95 ' + T.a95 + '/' + T.known + ', окон ' + T.wins + ' → ' + dir);
  } catch (e) {
    console.log('   ! Сводка юга: ' + e.message);
  }
}
async function main() {
  // джиттер до 45 сек: не стучим синхронно с волнами атаки и другими клиентами
  await new Promise(res => setTimeout(res, Math.floor(Math.random() * 45000)));
  console.log('1) Качаю GdeBenz (Новороссийск)...');
// v5.3 аварийный режим: недоступность источника (домашняя рамка) — не повод
// пропускать народные отметки. При upstream-ошибке не прерываем цикл, а
// поднимаем флаг и сразу уходим в outageCrowdCycle(): шаги 2–5 (станции,
// наблюдения, события по снимкам) пропускаются, толпа, жалобы и уборка
// выполняются — во время атаки толпа единственный живой источник.
let list = null;
let upstreamDown = false;
try {
list = await fetchGdebenz();
} catch (e) {
if (!e.upstream) throw e;
upstreamDown = true;
console.error('⚠️ Домашняя рамка недоступна: ' + e.message + ' — включаю аварийный режим');
await tgUpstreamThrottled('⚠️ GdeBenz недоступен (похоже на DDoS или защиту). Цикл в аварийном режиме: народные отметки и уборка выполняются, снимки пропускаю; вернусь через 10 минут.');
}
if (upstreamDown) {
await outageCrowdCycle();
await southDigest();
try { await require(require('path').join(__dirname, 'svodka.js')).run(); } catch (e) { console.log('   ! Сводка юга: ' + e.message); }
console.log('✅ Цикл завершён в аварийном режиме: толпа и уборка без источника');
return;
}
console.log('   Станций в ответе: ' + list.length);
// v5.3 sanity-фильтр «200, но мусор»: под атакой CDN может отдать 200 с
// пустым или обрезанным списком. Сравниваем с числом станций последнего
// успешного цикла (bot_meta.upstream_sanity): упало вдвое и больше —
// ничего не пишем, алерт и выход: обрезанный снимок записался бы как свежие данные.
try {
const prevRows = await sbGet('/rest/v1/bot_meta?key=eq.upstream_sanity&select=value');
const prevN = prevRows.length ? Number(prevRows[0].value) : 0;
if (prevN > 0 && list.length < prevN * 0.5) {
console.error('⚠️ Sanity: источник отдал ' + list.length + ' станций против ' + prevN + ' в прошлом успешном цикле — похоже на ошмётки атаки, цикл пропущен');
await tgUpstreamThrottled('⚠️ GdeBenz отдал аномально мало станций: ' + list.length + ' против ' + prevN + ' в прошлом цикле. Похоже на ошмётки атаки. Цикл пропущен, сайт показывает последние данные.');
process.exit(0);
}
await sbPost('bot_meta?on_conflict=key', [{ key: 'upstream_sanity', value: String(list.length), updated_at: new Date().toISOString() }], 'return=minimal,resolution=merge-duplicates');
} catch (e) { console.log('   ! Sanity-фильтр: ' + e.message); }
const donorLists = [];
  // Защита от дублей: рамки доноров могут стыковаться с основной и друг
  // с другом — сначала запоминаем osm_id основной рамки, потом каждый донор
  // оставит только станции, которых ещё не было. Postgres получит уникальные ключи.
  const seenOsm = new Set(list.map(s => String(s.osm_id)));
  for (const f of DONOR_FRAMES) {
// v5.3: мёртвая донор-рамка пропускает только себя, не убивая весь цикл:
// домашние наблюдения и события пишутся как обычно
let dl;
try {
dl = await fetchFrame(f.url, 'GdeBenz (' + f.region + ')');
} catch (e) {
if (!e.upstream) throw e;
console.error('⚠️ Донор ' + f.region + ' недоступен: ' + e.message + ' — пропускаю только его');
await tgUpstreamThrottled('⚠️ Донор ' + f.region + ' недоступен (похоже на DDoS или защиту). Цикл продолжается без него.');
continue;
}
console.log('   Донор ' + f.region + ': станций ' + dl.length);
    const clean = dl.filter(s => {
      const k = String(s.osm_id);
      if (seenOsm.has(k)) return false;
      seenOsm.add(k);
      return true;
    });
    donorLists.push({ region: f.region, list: clean });
    await new Promise(res => setTimeout(res, 1500)); // вежливая пауза между рамками
  }

  console.log('2) Сохраняю станции...');
  const homeExt = new Set(list.map(s => String(s.osm_id)));
  // паспорт топлив станции из meta.f (через запятую); null, если источник молчит
  const fuelsMetaOf = s => (s.meta && Array.isArray(s.meta.f) && s.meta.f.length) ? s.meta.f.join(',') : null;
  const stationPayload = list.map(s => ({
    external_id: String(s.osm_id),
    name: s.name || 'АЗС',
    brand: s.brand || '',
    address: s.addr || '',
    lat: s.lat,
    lon: s.lon,
    source: 'gdebenz',
    region: null,
    fuels_meta: fuelsMetaOf(s)
  })).concat(donorLists.flatMap(d => d.list
    .filter(s => !homeExt.has(String(s.osm_id)))
    .map(s => ({
      external_id: String(s.osm_id),
      name: s.name || 'АЗС',
      brand: s.brand || '',
      address: s.addr || '',
      lat: s.lat,
      lon: s.lon,
      source: 'gdebenz',
      region: d.region,
      fuels_meta: fuelsMetaOf(s)
    }))));
  // v5.7: апсерт кусками по 400 станций — короткие транзакции вместо одной на
  // несколько тысяч строк: меньше пик нагрузки на базу в окно сбора.
  const saved = [];
  for (let i = 0; i < stationPayload.length; i += 400) {
    const part = await sbPost(
      'stations?on_conflict=external_id,source',
      stationPayload.slice(i, i + 400),
      'return=representation,resolution=merge-duplicates'
    );
    for (const s of part) saved.push(s);
  }
  const idByExt = {};
  for (const s of saved) idByExt[s.external_id] = s.id;
  const nameById = {};
const wideById = {};
const cityById = {};
const homeIdSet = new Set();
for (const s of saved) {
  nameById[s.id] = escTg((s.name || 'АЗС') + (s.address ? ' · ' + s.address : ''));
  wideById[s.id] = !(s.lat >= 44.60 && s.lat <= 44.85 && s.lon >= 37.55 && s.lon <= 38.05);
  cityById[s.id] = cityOfStation(s);
  if (!s.region) homeIdSet.add(s.id);
}
// подпись строки ленты: Новороссийск — жирным и без суффикса,
// регион — конкретный город в скобках (или «(регион)», если вне всех боксов)
function stationLabel(id) {
  const base = nameById[id] || 'АЗС';
  if (!wideById[id]) return '<b>' + base + '</b>';
  return base + ' (' + (cityById[id] || 'регион') + ')';
}
  const tgSrcLines = [];
  const tgFolkLines = [];

  console.log('3) Достаю последние наблюдения для сравнения...');
  const lastByStation = {};
  const recentByStation = {};
  const pushObs = o => {
    (recentByStation[o.station_id] = recentByStation[o.station_id] || []).push(o);
    if (!lastByStation[o.station_id]) lastByStation[o.station_id] = o;
  };
  const homeIds = [...homeIdSet];
  if (homeIds.length) {
    // домой лукбэк 6ч (вместо 24ч): gap-детектор и машина состояний работают с меньшим окном,
    // а ночные null уже учтены в функции computeFuelState (SILENCE = 6 наблюдений ~1ч).
    // v5.5: минус ~300 МБ/сутки.
    const last = await sbGetAll(
      '/rest/v1/observations?station_id=in.(' + homeIds.map(i => '"' + i + '"').join(',') +
      ')&timestamp=gte.' + new Date(Date.now() - 6 * 3600 * 1000).toISOString() + '&order=timestamp.desc&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level,timestamp'
    );
    for (const o of last) pushObs(o);
  }
  // доноры: v5.7 — вьюха station_last_obs оказалась самым тяжёлым запросом цикла:
  // её DISTINCT ON сканирует ВСЕ наблюдения за 7 дней (сотни тысяч строк), и в окно
  // сбора сайт не мог дышать. Вместо неё читаем окно 90 минут по индексу timestamp:
  // доноры пишут heartbeat раз в час, поэтому у каждой живой станции свежая строка
  // в окне есть. Если у станции строки в окне нет (сбой записи) — она считается
  // «изменившейся» и пишет heartbeat сама, само-починка. Мост сквозь молчание
  // у доноров смотрит только последнюю строку: если она null — событие
  // донора пропускаем (дом не задет: у дома отдельная история 6ч).
  const donorLast = await sbGetAll(
    '/rest/v1/observations?timestamp=gte.' + new Date(Date.now() - 90 * 60 * 1000).toISOString() +
    '&order=timestamp.desc&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level,timestamp'
  );
  for (const o of donorLast) if (!homeIdSet.has(o.station_id)) pushObs(o);

  console.log('4) Записываю новые наблюдения...');
  const mkRow = (s, id) => {
    const f = fuelSet(s.fuels_now);
    const p = s.prices_now || {};
    return {
      station_id: id,
      fuel_92_status: f.f92,
      fuel_95_status: f.f95,
      diesel_status: f.fdt,
      price_92: p['92'] ? p['92'].p : null,
      price_95: p['95'] ? p['95'].p : null,
      price_diesel: p['ДТ'] ? p['ДТ'].p : null,
      queue_level: s.conflict === 'queue' ? 'high' : null,
      source_status: s.status === undefined ? null : s.status,
      fuel_state: null,
      reliability_score: null,
      data_freshness_minutes: freshnessMinutes(p)
    };
  };
  const obsRows = list.map(s => mkRow(s, idByExt[String(s.osm_id)])).filter(r => r.station_id);
// Машина состояний v1 (тень): состояния и надёжность считаем только дому —
// у доноров запись разреженная (heartbeat 1ч), серии нерепрезентативны.
// События на состояния ещё не смотрят: сначала неделя замера распределения.
const stateCounts = {};
for (const row of obsRows) {
  if (!homeIdSet.has(row.station_id)) continue;
  const hist = recentByStation[row.station_id] || [];
  row.fuel_state = computeFuelState([row.fuel_95_status].concat(hist.map(o => o.fuel_95_status)));
  row.reliability_score = reliabilityOf(hist);
  stateCounts[row.fuel_state] = (stateCounts[row.fuel_state] || 0) + 1;
}
console.log('   Состояния дома: ' + JSON.stringify(stateCounts));
  // доноры: строка при смене статуса/очереди, heartbeat раз в 1ч или при первой встрече
// (часовой heartbeat нужен, чтобы почасовые сводки региона были живыми)
  const HEARTBEAT_MS = 1 * 3600 * 1000;
  let donorWritten = 0;
  for (const d of donorLists) {
    for (const s of d.list) {
      const id = idByExt[String(s.osm_id)];
      if (!id || homeIdSet.has(id)) continue;
      const row = mkRow(s, id);
      const prev = lastByStation[id];
      const prevMs = prev && prev.timestamp ? new Date(prev.timestamp).getTime() : 0;
      const changed = !prev ||
        prev.fuel_92_status !== row.fuel_92_status ||
        prev.fuel_95_status !== row.fuel_95_status ||
        prev.diesel_status !== row.diesel_status ||
        (prev.queue_level || null) !== (row.queue_level || null);
      const heartbeat = !prev || (Date.now() - prevMs) >= HEARTBEAT_MS;
      if (changed || heartbeat) { obsRows.push(row); donorWritten++; }
    }
  }
  await sbPostChunks('observations', obsRows, 150);
  console.log('   Наблюдений записано: ' + obsRows.length + ' (дом ' + (obsRows.length - donorWritten) + ' + доноры ' + donorWritten + ')');

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
    // очередь появилась / исчезла
    const prevQueue = prev.queue_level === 'high';
    const nowQueue = row.queue_level === 'high';
    if (!prevQueue && nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_appeared', fuel_type: null, confidence: 0.7, source: 'observation' });
    if (prevQueue && !nowQueue) events.push({ station_id: row.station_id, event_type: 'queue_gone', fuel_type: null, confidence: 0.7, source: 'observation' });
  }
  if (events.length) await sbPost('events', events);
  console.log('   Событий обнаружено: ' + events.length);
  // === ШАГ 5.6: журнал свидетеля (КогдаБенз Score, этап 1): заявления источника ===
    // Пишем ТОЛЬКО перевороты статуса (те же строки, где рождаются
    // fuel_restored/fuel_disappeared) — журнал не раздувается снимками каждые 10 мин.
    // Ошибка журнала не роняет цикл: этап 1 теневой, оценок пользователю нет.
    try {
      const wRowsS = [];
      for (const e of events) {
        if (e.event_type !== 'fuel_restored' && e.event_type !== 'fuel_disappeared') continue;
        wRowsS.push({
          station_id: e.station_id,
          fuel_type: e.fuel_type,
          role: 'claim',
          claim: e.event_type === 'fuel_restored',
          source_kind: 'source',
          device_id: null,
          on_site: false,
          distance_m: null,
          linked_claim_id: null,
          weight: 1,
          created_at: new Date().toISOString()
        });
      }
      if (wRowsS.length) {
        await sbPost('witness_journal', wRowsS);
        console.log('   Журнал свидетеля (источник): ' + wRowsS.length);
      }
    } catch (e) { console.log('   ! Журнал свидетеля (источник): ' + e.message); }
  for (const e of events) tgSrcLines.push(eventStoryRu(e, stationLabel(e.station_id)));
  console.log('5.5) Обновляю суточную сводку city_daily...');
  await cityDailyRollup();
  // === ШАГ 6: превращаем народные отметки user_feedback в события ===
  console.log('6) Обрабатываю народные отметки...');
let fbEvents = [];
const unprocessed = await sbGetAll(
    '/rest/v1/user_feedback?processed_at=is.null&select=id,station_id,feedback_type,fuel_type,queue_size,created_at'
  );
  if (unprocessed.length) {
    fbEvents = unprocessed.map(f => ({
      station_id: f.station_id,
      event_type:
        f.feedback_type === 'delivery' ? 'possible_delivery' :
        f.feedback_type === 'available' ? 'fuel_available' :
        f.feedback_type === 'unavailable' ? 'fuel_unavailable' :
        f.feedback_type === 'queue' ? 'queue_high' :
        f.feedback_type === 'in_queue' ? 'queue_high' :
        'queue_low',
      fuel_type: f.fuel_type === 'all' ? null : (f.fuel_type || null),
      detected_at: f.created_at,
      confidence:
        f.feedback_type === 'queue'
          ? (f.queue_size === 'huge' ? 0.95 : f.queue_size === 'large' ? 0.9 : f.queue_size === 'medium' ? 0.75 : f.queue_size === 'small' ? 0.6 : 0.7)
          : 0.85,
      source: 'user_feedback'
    }));
    await sbPost('events', fbEvents);
    for (const e of fbEvents) tgFolkLines.push(eventStoryRu(e, stationLabel(e.station_id)));
    const ids = unprocessed.map(f => f.id).join(',');
    await sbPatch('user_feedback?id=in.(' + ids + ')', { processed_at: new Date().toISOString() });
    console.log('   Народных отметок превращено в события: ' + fbEvents.length);
  } else {
    console.log('   Новых народных отметок нет');
  }

// === ШАГ 6.5: жалобы на народные отметки: 2 разных водителя → удаляем отметку ===
console.log('6.5) Проверяю жалобы на отметки...');
try {
  const reports = await sbGetAll('/rest/v1/feedback_reports?select=feedback_id,device_id');
  const byFb = {};
  for (const r of reports) (byFb[r.feedback_id] = byFb[r.feedback_id] || new Set()).add(r.device_id);
  const badIds = Object.keys(byFb).filter(id => byFb[id].size >= 2);
  if (!badIds.length) {
    console.log('   Жалоб нет или недостаточно (нужно 2 разных водителя)');
  } else {
    const fbs = await sbGetAll('/rest/v1/user_feedback?id=in.(' + badIds.join(',') + ')&select=id,station_id,created_at');
    for (const f of fbs) {
      await sbDelete('events?source=eq.user_feedback&station_id=eq.' + f.station_id + '&detected_at=eq.' + encodeURIComponent(f.created_at));
    }
    if (fbs.length) await sbDelete('user_feedback?id=in.(' + fbs.map(f => f.id).join(',') + ')');
    console.log('   Удалено отметок по жалобам: ' + fbs.length);
  }
} catch (e) { console.log('   ! Жалобы: ' + e.message); }

// === ШАГ 6.5: персональные уведомления по избранным АЗС ===
// Сердечко на сайте → user_favorites (rpc fav_sync), бот связал device_id с
// chat_id (tg_subscriptions). Берём события с момента прошлой рассылки
// (bot_meta.personal_notify_at) и шлём лично подписчикам их станций.
// Строка подробная: какое топливо / какого размера очередь, имя и адрес АЗС,
// время события по Москве; народные строки помечены «водители сообщают».
console.log('6.5) Персональные уведомления по избранным...');
try {
  const metaRows = await sbGet('/rest/v1/bot_meta?key=eq.personal_notify_at&select=value');
  const prev = metaRows.length ? metaRows[0].value : new Date(Date.now() - 10 * 60000).toISOString();
  const evs = await sbGetAll('/rest/v1/events?detected_at=gt.' + encodeURIComponent(prev) + '&select=station_id,event_type,fuel_type,detected_at&order=detected_at.asc');
  if (!evs.length) {
    console.log('   Новых событий нет — уведомлять не о чем');
  } else {
    const FUEL_RU = { '92': 'АИ-92', '95': 'АИ-95', 'diesel': 'дизель' };
    const QUEUE_SHORT = { small: '2–3', medium: '4–6', large: '7+', huge: '100+' };
    const stIds = [...new Set(evs.map(e => e.station_id))];
    const favs = await sbGetAll('/rest/v1/user_favorites?station_id=in.(' + stIds.map(i => '"' + i + '"').join(',') + ')&select=device_id,station_id');
    if (!favs.length) {
      console.log('   Избранного по этим станциям нет');
    } else {
      // имя И адрес станции — чтобы водитель понял, о какой заправке речь
      const names = await sbGetAll('/rest/v1/stations?select=id,name,address&id=in.(' + stIds.map(i => '"' + i + '"').join(',') + ')');
      const LABEL = {};
      for (const s of names) LABEL[s.id] = escTg((s.name || 'АЗС') + (s.address ? ' · ' + s.address : ''));
      // размер народной очереди живёт в user_feedback.queue_size, а не в событии:
      // стыкуем отметку и событие по станции и минуте (detected_at = created_at)
      const fbByKey = {};
      if (evs.some(e => e.event_type === 'queue_high')) {
        const qfb = await sbGetAll('/rest/v1/user_feedback?feedback_type=eq.queue&station_id=in.(' + stIds.map(i => '"' + i + '"').join(',') + ')&select=station_id,created_at,queue_size');
        for (const f of qfb) fbByKey[f.station_id + '|' + f.created_at] = f;
      }
      const hhmm = iso => { const d = new Date(new Date(iso).getTime() + 3 * 3600 * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
      const rowOf = e => {
        const f = e.fuel_type ? (FUEL_RU[e.fuel_type] || 'топливо') : null;
        const t = hhmm(e.detected_at);
        if (e.event_type === 'fuel_restored') return '🟢 ' + (f || 'топливо') + ' · вернулся · ' + t;
        if (e.event_type === 'fuel_disappeared') return '🔴 ' + (f || 'топливо') + ' · кончился · ' + t;
        if (e.event_type === 'queue_appeared') return '🚗 очередь · появилась · ' + t;
        if (e.event_type === 'queue_gone') return '✅ очередь · рассосалась · ' + t;
        if (e.event_type === 'fuel_available') return '⛽ водители: ' + (f || 'топливо') + ' есть · ' + t;
        if (e.event_type === 'fuel_unavailable') return '🔴 водители: ' + (f || 'топливо') + ' нет · ' + t;
        if (e.event_type === 'queue_high') {
          const fb = fbByKey[e.station_id + '|' + e.detected_at];
          return '🚗 водители: очередь' + (fb && fb.queue_size ? ' ' + (QUEUE_SHORT[fb.queue_size] || '') + ' машин' : '') + ' · ' + t;
        }
        if (e.event_type === 'queue_low') return '🟢 водители: свободно · ' + t;
        if (e.event_type === 'possible_delivery') return '🚛 водители: привезли · ' + t;
        return null;
      };
      const devIds = [...new Set(favs.map(f => f.device_id))];
      const subs = await sbGetAll('/rest/v1/tg_subscriptions?device_id=in.(' + devIds.map(d => '"' + d + '"').join(',') + ')&enabled=eq.true&select=device_id,chat_id');
      const chatByDev = {};
      for (const s of subs) chatByDev[s.device_id] = s.chat_id;
      // сообщение-таблица: станция — жирный заголовок-«шапка», события —
      // компактные строки под ней; адрес не повторяется в каждой строке,
      // строки короткие и не рвутся на мобильном, блоки разделены пустой строкой
      const groupsByChat = {};
      for (const f of favs) {
        const chat = chatByDev[f.device_id];
        if (!chat) continue;
        for (const e of evs) {
          if (e.station_id !== f.station_id) continue;
          const row = rowOf(e);
          if (!row) continue;
          const arr = groupsByChat[chat] = groupsByChat[chat] || [];
          let grp = arr.find(g => g.st === e.station_id);
          if (!grp) { grp = { st: e.station_id, label: LABEL[e.station_id] || 'АЗС', rows: [] }; arr.push(grp); }
          grp.rows.push(row);
        }
      }
      let sent = 0;
      for (const chat of Object.keys(groupsByChat)) {
        const blocks = groupsByChat[chat].slice(0, 6).map(g =>
          '<b>📍 ' + g.label + '</b>\n' + g.rows.slice(0, 8).join('\n')
        ).join('\n\n');
        await tgTo(Number(chat), '⭐ <b>Ваше избранное</b> · ' + hhmm(evs[evs.length - 1].detected_at) + '\n\n' + blocks);
        sent++;
      }
      console.log('   Персональных уведомлений отправлено: ' + sent);
    }
    await sbPost('bot_meta?on_conflict=key', [{ key: 'personal_notify_at', value: evs[evs.length - 1].detected_at, updated_at: new Date().toISOString() }], 'return=minimal,resolution=merge-duplicates');
  }
} catch (e) { console.log('   ! Персональные уведомления: ' + e.message); }
// === ШАГ 6.7: журнал свидетеля (этап 1): народные заявления ===
    // Свой водяной знак witness_logged_at (не processed_at): время заявления
    // берём из created_at, поэтому отметки периода аварии источника попадут
    // в журнал первым здоровым циклом с правильным временем. Колонка новая и
    // пустая — первые циклы добьют ИСТОРИЮ отметок порциями по 300, это норма.
    console.log('6.7) Пишу народные заявления в журнал свидетеля...');
    try {
      const wUnlogged = await sbGet(
        '/rest/v1/user_feedback?witness_logged_at=is.null&feedback_type=in.(available,unavailable)&fuel_type=in.(92,95,diesel)&select=id,station_id,feedback_type,fuel_type,created_at,device_id,verified_on_site,distance_to_station_m&order=id.asc&limit=300'
      );
      if (wUnlogged.length) {
        const wRowsF = wUnlogged.map(f => ({
          station_id: f.station_id,
          fuel_type: f.fuel_type,
          role: 'claim',
          claim: f.feedback_type === 'available',
          source_kind: 'folk',
          device_id: f.device_id || null,
          on_site: !!f.verified_on_site,
          distance_m: (f.distance_to_station_m === null || f.distance_to_station_m === undefined) ? null : f.distance_to_station_m,
          linked_claim_id: null,
          weight: 1,
          created_at: f.created_at
        }));
        await sbPost('witness_journal', wRowsF);
        await sbPatch('user_feedback?id=in.(' + wUnlogged.map(f => f.id).join(',') + ')', { witness_logged_at: new Date().toISOString() });
        console.log('   Журнал свидетеля (народ): ' + wRowsF.length);
      } else {
        console.log('   Новых народных заявлений нет');
      }
    } catch (e) { console.log('   ! Журнал свидетеля (народ): ' + e.message); }
    // === ШАГ 6.8: журнал свидетеля (Score этап 2): независимость и подтверждения ===
    // Свидетель = другое заявление по той же связке в окне от -5 до +60 минут.
    // народ↔народ только разные device_id; источник↔народ взаимно;
    // источник↔источник нет (один сенсор). Вес народа тает с разрывом (1→0.5),
    // «с места» +0.15, источник эталонный 1.0. Потолок: 3 подтверждения
    // с устройства по станции в сутки. Дубли связок не пишем.
    console.log('6.8) Сопоставляю заявления и свидетелей...');
    try {
      const mskD = new Date(Date.now() + 3 * 3600 * 1000);
      const dayStart = new Date(Date.UTC(mskD.getUTCFullYear(), mskD.getUTCMonth(), mskD.getUTCDate()) - 3 * 3600 * 1000).toISOString();
      const claims = await sbGet(
        '/rest/v1/witness_journal?role=eq.claim&created_at=gte.' + new Date(Date.now() - 130 * 60000).toISOString() +
        '&created_at=lt.' + new Date(Date.now() - 2 * 60000).toISOString() +
        '&select=id,station_id,fuel_type,claim,source_kind,device_id,on_site,created_at&order=id.asc&limit=400'
      );
      if (!claims.length) {
        console.log('   Заявлений для сопоставления нет');
      } else {
        const rows = await sbGet(
          '/rest/v1/witness_journal?created_at=gte.' + dayStart +
          '&select=id,station_id,fuel_type,role,claim,source_kind,device_id,on_site,distance_m,created_at,linked_claim_id&order=id.asc&limit=5000'
        );
        const linksDone = new Set();
        const perDeviceDay = {};
        for (const r of rows) {
          if (r.linked_claim_id !== null && r.linked_claim_id !== undefined) {
            linksDone.add(r.linked_claim_id + '|' + r.source_kind + '|' + (r.device_id || '') + '|' + r.role);
          }
          if (r.role === 'confirm' && r.source_kind === 'folk' && r.device_id) {
            const k = r.device_id + '|' + r.station_id + '|' + String(r.created_at).slice(0, 10);
            perDeviceDay[k] = (perDeviceDay[k] || 0) + 1;
          }
        }
        const out = [];
        for (const c of claims) {
          const cT = new Date(c.created_at).getTime();
          for (const w of rows) {
            if (w.role !== 'claim' || w.id === c.id) continue;
            if (w.station_id !== c.station_id || w.fuel_type !== c.fuel_type) continue;
            const gap = new Date(w.created_at).getTime() - cT;
            if (gap < -5 * 60000 || gap > 60 * 60000) continue;
            const role = (w.claim === c.claim) ? 'confirm' : 'refute';
            let weight;
            if (w.source_kind === 'folk' && c.source_kind === 'folk') {
              if (!w.device_id || !c.device_id || w.device_id === c.device_id) continue;
              weight = Math.max(0.5, 1 - 0.5 * (gap / 3600000));
            } else if (w.source_kind === 'source' && c.source_kind === 'folk') {
              weight = 1;
            } else if (w.source_kind === 'folk' && c.source_kind === 'source') {
              weight = Math.max(0.5, 1 - 0.5 * (gap / 3600000));
            } else continue;
            if (w.source_kind === 'folk') {
              const capK = w.device_id + '|' + c.station_id + '|' + String(w.created_at).slice(0, 10);
              if ((perDeviceDay[capK] || 0) >= 3) continue;
              if (w.on_site) weight = Math.min(1, weight + 0.15);
            }
            const linkK = c.id + '|' + w.source_kind + '|' + (w.device_id || '') + '|' + role;
            if (linksDone.has(linkK)) continue;
            linksDone.add(linkK);
            if (w.source_kind === 'folk') {
              const capK = w.device_id + '|' + c.station_id + '|' + String(w.created_at).slice(0, 10);
              perDeviceDay[capK] = (perDeviceDay[capK] || 0) + 1;
            }
            out.push({
              station_id: c.station_id,
              fuel_type: c.fuel_type,
              role: role,
              claim: w.claim,
              source_kind: w.source_kind,
              device_id: w.device_id || null,
              on_site: !!w.on_site,
              distance_m: (w.distance_m === null || w.distance_m === undefined) ? null : w.distance_m,
              linked_claim_id: c.id,
              weight: Math.round(weight * 1000) / 1000,
              created_at: w.created_at
            });
          }
        }
        if (out.length) {
          await sbPost('witness_journal', out);
          console.log('   Подтверждений/опровержений записано: ' + out.length);
        } else {
          console.log('   Новых подтверждений нет');
        }
      }
    } catch (e) { console.log('   ! Журнал свидетеля (сопоставление): ' + e.message); }
    // === ШАГ 6.9: журнал свидетеля (этап 2): непрерывность источника ===
    // Источник подтверждает народное заявление не только переворотом (6.8),
    // но и «молчаливым согласием»: первый снимок источника в течение 2 часов
    // после отметки показывает тот же статус этого топлива. Это главный
    // поставщик подтверждений: перевороты редки, снимки каждые 10 минут.
    console.log('6.9) Непрерывность источника: сверяю народные заявления со снимками...');
    try {
      const folkClaims = await sbGet(
        '/rest/v1/witness_journal?role=eq.claim&source_kind=eq.folk&created_at=gte.' + new Date(Date.now() - 130 * 60000).toISOString() +
        '&created_at=lt.' + new Date(Date.now() - 2 * 60000).toISOString() +
        '&select=id,station_id,fuel_type,claim,created_at&order=id.asc&limit=200'
      );
      if (!folkClaims.length) {
        console.log('   Свежих народных заявлений нет');
      } else {
        const linked = await sbGet(
          '/rest/v1/witness_journal?linked_claim_id=in.(' + folkClaims.map(c => c.id).join(',') + ')&source_kind=eq.source&select=linked_claim_id,role'
        );
        const done = new Set(linked.map(r => r.linked_claim_id + '|' + r.role));
        const out = [];
        for (const c of folkClaims) {
          const col = c.fuel_type === '92' ? 'fuel_92_status' : c.fuel_type === '95' ? 'fuel_95_status' : 'diesel_status';
          const obs = await sbGet(
            '/rest/v1/observations?station_id=eq.' + c.station_id +
            '&timestamp=gt.' + c.created_at +
            '&timestamp=lte.' + new Date(new Date(c.created_at).getTime() + 2 * 3600 * 1000).toISOString() +
            '&order=timestamp.asc&limit=12&select=timestamp,' + col
          );
          const first = obs.find(o => o[col] !== null && o[col] !== undefined);
          if (!first) continue; // источник молчал 2 часа после отметки — свидетеля нет
          const role = (first[col] === c.claim) ? 'confirm' : 'refute';
          if (done.has(c.id + '|' + role)) continue;
          done.add(c.id + '|' + role);
          out.push({
            station_id: c.station_id,
            fuel_type: c.fuel_type,
            role: role,
            claim: first[col],
            source_kind: 'source',
            device_id: null,
            on_site: false,
            distance_m: null,
            linked_claim_id: c.id,
            weight: 1,
            created_at: first.timestamp
          });
        }
        if (out.length) {
          await sbPost('witness_journal', out);
          console.log('   Непрерывность источника: ' + out.length);
        } else {
          console.log('   Непрерывность источника: новых свидетелей нет');
        }
      }
    } catch (e) { console.log('   ! Журнал свидетеля (непрерывность): ' + e.message); }
  // === ШАГ УБОРКИ: удаляем наблюдения старше 30 дней, чтобы база не раздувалась ===
  console.log('7) Убираю старые наблюдения (старше 7 дней, порциями по суткам)...');
// v5.4: хранение 30 дней съело весь бесплатный лимит базы (observations
// 440 МБ из 500): доноры с часовым heartbeat дают ~53k строк в сутки.
// Суточные порции — чтобы один большой DELETE не отменил statement timeout.
const mskHourClean = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(new Date()));
for (let d = 30; mskHourClean === 3 && d >= 7; d--) {
  const from = new Date(Date.now() - (d + 1) * 24 * 3600 * 1000).toISOString();
  const to = new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  try {
    const delRes = await fetch(
      SUPABASE_URL + '/rest/v1/observations?timestamp=gte.' + from + '&timestamp=lt.' + to,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          Prefer: 'return=minimal'
        }
      }
    );
    if (!delRes.ok) console.log('   ! Уборка суток -' + d + ': HTTP ' + delRes.status);
  } catch (e) {
    console.log('   ! Уборка суток -' + d + ': ' + e.message);
  }
}

    const hitsBlock = await siteHitsDigest(nameById);
const ratingBlock = await siteRatingDigest();
if (tgSrcLines.length || tgFolkLines.length || hitsBlock || ratingBlock.hasNew) {
// Контекст города из свежих домашних отметок (факт, не прогноз)
let known = 0, avail = 0;
for (const row of obsRows) {
  if (!homeIdSet.has(row.station_id)) continue;
  if (row.fuel_95_status !== null && row.fuel_95_status !== undefined) { known++; if (row.fuel_95_status) avail++; }
}
const msk = new Date(Date.now() + 3 * 3600 * 1000);
const hh = String(msk.getUTCHours()).padStart(2, '0') + ':' + String(msk.getUTCMinutes()).padStart(2, '0');
const total = tgSrcLines.length + tgFolkLines.length;
// Народ сверху — его глазами ищешь; источник ниже. Лимит строк общий ~10.
let body = '';
let left = 10;
if (tgFolkLines.length) {
  const take = tgFolkLines.slice(0, Math.min(left, 6));
  left -= take.length;
  body += '\n\n👥 <b>НАРОД</b> · ' + tgFolkLines.length + '\n' + take.join('\n');
  if (tgFolkLines.length > take.length) body += '\n<i>…ещё ' + (tgFolkLines.length - take.length) + '</i>';
}
if (tgSrcLines.length && left > 0) {
  const take = tgSrcLines.slice(0, left);
  body += '\n\n📡 <b>ИСТОЧНИК</b> · ' + tgSrcLines.length + '\n' + take.join('\n');
  if (tgSrcLines.length > take.length) body += '\n<i>…ещё ' + (tgSrcLines.length - take.length) + '</i>';
}
if (hitsBlock) body += '\n\n' + hitsBlock;
if (ratingBlock.text) body += '\n\n' + ratingBlock.text;
await tg('⚡ ' + hh + (total ? ' · ' + total : '') +
  (known ? '\n🏙 АИ-95: ' + avail + '/' + known : '') +
  body, true);
}
await southDigest();
try { await require(require('path').join(__dirname, 'svodka.js')).run(); } catch (e) { console.log('   ! Сводка юга: ' + e.message); }
  console.log('✅ Цикл завершён');
}

// === ШАГ 5.5: суточная сводка city_daily ===
// Норма «среднее исчезновений АИ-95 за предыдущие 6 суток» больше не считается
// из observations (7 дней хранения + разреженные доноры съедают историю).
// Берём её из вечной сводки, которая дописывается из events (events не удаляются).
// Первый прогон делает бэкфилл за 7 суток из накопленных событий.
async function cityDailyRollup() {
  try {
    const st = await sbGetAll('/rest/v1/stations?select=id,lat,lon');
    const cityBySt = {};
    for (const s of st) cityBySt[s.id] = cityOfStation(s);
    const MSK = 3 * 3600 * 1000;
    const nowMsk = new Date(Date.now() + MSK);
    const back = await sbGet('/rest/v1/bot_meta?key=eq.city_daily_backfill&select=value');
    const days = (back.length && back[0].value === '1') ? [1] : [1, 2, 3, 4, 5, 6, 7];
    const acc = {};
    for (const d of days) {
      const dayMsk = new Date(Date.UTC(
        nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate() - d
      ));
      const from = new Date(dayMsk.getTime() - MSK);
      const to   = new Date(from.getTime() + 24 * 3600 * 1000);
      const evs = await sbGetAll(
        '/rest/v1/events?detected_at=gte.' + from.toISOString() +
        '&detected_at=lt.' + to.toISOString() +
        '&event_type=in.(fuel_disappeared,fuel_restored)&fuel_type=eq.95' +
        '&select=station_id,event_type'
      );
      for (const e of evs) {
        const c = cityBySt[e.station_id];
        if (!c) continue;
        const key = c + '|' + dayMsk.toISOString().slice(0, 10);
        if (!acc[key]) acc[key] = {
          city: c, day: dayMsk.toISOString().slice(0, 10),
          disappeared: 0, restored: 0, updated_at: new Date().toISOString()
        };
        if (e.event_type === 'fuel_disappeared') acc[key].disappeared++;
        else acc[key].restored++;
      }
      // нулевые строки для всех городов: «0» = спокойные сутки, а не дыра в истории
      for (const c of CITY_BOXES) {
        const key = c.name + '|' + dayMsk.toISOString().slice(0, 10);
        if (!acc[key]) acc[key] = {
          city: c.name, day: dayMsk.toISOString().slice(0, 10),
          disappeared: 0, restored: 0, updated_at: new Date().toISOString()
        };
      }
    }
    const rows = Object.values(acc);
    if (rows.length) {
      await sbPost('city_daily?on_conflict=city,day', rows, 'return=minimal,resolution=merge-duplicates');
    }
    if (!(back.length && back[0].value === '1')) {
      await sbPost('bot_meta?on_conflict=key', [{
        key: 'city_daily_backfill', value: '1', updated_at: new Date().toISOString()
      }], 'return=minimal,resolution=merge-duplicates');
    }
    console.log('   city_daily: обновлено ' + rows.length + ' строк за ' + days.length + ' сут(ок)');
  } catch (e) {
    console.log('   ! city_daily: ' + e.message);
  }
}
// === v5.3 аварийный режим: толпа и уборка без источника ===
// Когда GdeBenz лежит (DDoS, защита, сеть), раньше цикл пропускал ВСЁ,
// включая народные отметки, — а во время атаки толпа единственный живой
// источник. Функция выполняет только шаги, не зависящие от источника:
// отметки → события, жалобы, уборка старых наблюдений. Персональные
// уведомления в аварийном режиме не шлются, но и не теряются:
// bot_meta.personal_notify_at не продвигается, и первый здоровый цикл
// доставит подписчикам всё, накопленное за аварию.
async function outageCrowdCycle() {
console.log('Аварийный режим: источник лежит, выполняю толпу и уборку без него...');
const dbSt = await sbGetAll('/rest/v1/stations?select=id,name,address,lat,lon,region');
const nameById = {};
const wideById = {};
const cityById = {};
for (const s of dbSt) {
nameById[s.id] = escTg((s.name || 'АЗС') + (s.address ? ' · ' + s.address : ''));
wideById[s.id] = !(s.lat >= 44.60 && s.lat <= 44.85 && s.lon >= 37.55 && s.lon <= 38.05);
cityById[s.id] = cityOfStation(s);
}
function stationLabel(id) {
const base = nameById[id] || 'АЗС';
if (!wideById[id]) return '<b>' + base + '</b>';
return base + ' (' + (cityById[id] || 'регион') + ')';
}
const tgLines = [];
console.log('6) Обрабатываю народные отметки...');
let fbEvents = [];
const unprocessed = await sbGetAll(
'/rest/v1/user_feedback?processed_at=is.null&select=id,station_id,feedback_type,fuel_type,queue_size,created_at'
);
if (unprocessed.length) {
fbEvents = unprocessed.map(f => ({
station_id: f.station_id,
event_type:
f.feedback_type === 'delivery' ? 'possible_delivery' :
f.feedback_type === 'available' ? 'fuel_available' :
f.feedback_type === 'unavailable' ? 'fuel_unavailable' :
f.feedback_type === 'queue' ? 'queue_high' :
f.feedback_type === 'in_queue' ? 'queue_high' :
'queue_low',
fuel_type: f.fuel_type === 'all' ? null : (f.fuel_type || null),
detected_at: f.created_at,
confidence:
f.feedback_type === 'queue'
? (f.queue_size === 'huge' ? 0.95 : f.queue_size === 'large' ? 0.9 : f.queue_size === 'medium' ? 0.75 : f.queue_size === 'small' ? 0.6 : 0.7)
: 0.85,
source: 'user_feedback'
}));
await sbPost('events', fbEvents);
for (const e of fbEvents) tgLines.push(eventStoryRu(e, stationLabel(e.station_id)));
const ids = unprocessed.map(f => f.id).join(',');
await sbPatch('user_feedback?id=in.(' + ids + ')', { processed_at: new Date().toISOString() });
console.log('   Народных отметок превращено в события: ' + fbEvents.length);
} else {
console.log('   Новых народных отметок нет');
}
console.log('6.5) Проверяю жалобы на отметки...');
try {
const reports = await sbGetAll('/rest/v1/feedback_reports?select=feedback_id,device_id');
const byFb = {};
for (const r of reports) (byFb[r.feedback_id] = byFb[r.feedback_id] || new Set()).add(r.device_id);
const badIds = Object.keys(byFb).filter(id => byFb[id].size >= 2);
if (!badIds.length) {
console.log('   Жалоб нет или недостаточно (нужно 2 разных водителя)');
} else {
const fbs = await sbGetAll('/rest/v1/user_feedback?id=in.(' + badIds.join(',') + ')&select=id,station_id,created_at');
for (const f of fbs) {
await sbDelete('events?source=eq.user_feedback&station_id=eq.' + f.station_id + '&detected_at=eq.' + encodeURIComponent(f.created_at));
}
if (fbs.length) await sbDelete('user_feedback?id=in.(' + fbs.map(f => f.id).join(',') + ')');
console.log('   Удалено отметок по жалобам: ' + fbs.length);
}
} catch (e) { console.log('   ! Жалобы: ' + e.message); }
console.log('6.6) Обновляю суточную сводку city_daily (без источника)...');
await cityDailyRollup();
console.log('7) Убираю старые наблюдения (старше 7 дней, порциями по суткам)...');
// v5.4: хранение 30 дней съело весь бесплатный лимит базы (observations
// 440 МБ из 500): доноры с часовым heartbeat дают ~53k строк в сутки.
// Суточные порции — чтобы один большой DELETE не отменил statement timeout.
const mskHourClean = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).format(new Date()));
for (let d = 30; mskHourClean === 3 && d >= 7; d--) {
  const from = new Date(Date.now() - (d + 1) * 24 * 3600 * 1000).toISOString();
  const to = new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  try {
    const delRes = await fetch(
      SUPABASE_URL + '/rest/v1/observations?timestamp=gte.' + from + '&timestamp=lt.' + to,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          Prefer: 'return=minimal'
        }
      }
    );
    if (!delRes.ok) console.log('   ! Уборка суток -' + d + ': HTTP ' + delRes.status);
  } catch (e) {
    console.log('   ! Уборка суток -' + d + ': ' + e.message);
  }
}
const hitsBlock = await siteHitsDigest(nameById);
const ratingBlock = await siteRatingDigest();
if (tgLines.length || hitsBlock || ratingBlock.hasNew) {
const msk = new Date(Date.now() + 3 * 3600 * 1000);
const hh = String(msk.getUTCHours()).padStart(2, '0') + ':' + String(msk.getUTCMinutes()).padStart(2, '0');
let body = '';
  if (tgLines.length) body += '\n\n👥 <b>НАРОД</b> · ' + tgLines.length + '\n' + tgLines.slice(0, 8).join('\n');
  if (hitsBlock) body += '\n\n' + hitsBlock;
  if (ratingBlock.text) body += '\n\n' + ratingBlock.text;
  await tg('⚡ ' + hh + ' · аварийный режим (источник лежит)' + body, true);
  } // <-- закрывает if
} // <-- ДОБАВЬТЕ ВОТ ЭТУ СКОБКУ, чтобы закрыть функцию outageCrowdCycle

main().catch(async e => {
  // Источник недоступен/под атакой — это НЕ баг коллектора: выходим тихо
  // (workflow зелёный), владельца тревожим не чаще раза в час.
  if (e && e.upstream) {
    console.error('⚠️ Источник недоступен: ' + e.message);
    await tgUpstreamThrottled('⚠️ GdeBenz недоступен (похоже на DDoS или защиту). Цикл пропущен, сайт показывает последние данные; вернусь через 10 минут.');
    process.exit(0);
  }
  console.error('❌ Ошибка: ' + e.message);
  process.exit(1);
});