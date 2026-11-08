// ===== Бот КогдаБенз v5: кнопки владельца + личные подписки + мост «водитель ↔ разработчик» + выжимки с выделениями =====
// v3: кнопки владельца + личные подписки водителей
// v4: доставка обращений «Написать нам» владельцу с inline-кнопкой «Ответить»
// v5: улучшенные отчёты с выжимками, отметки водителей с выделениями, быстрый обзор свежих данных

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TG = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const OWN_BOX = { lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.05 };
const CODE_TTL = 15 * 60 * 1000;
const REPLY_PENDING_TTL = 10 * 60 * 1000;

const REASON_LABEL = {
  idea: '💡 Идея',
  complaint: '😤 Жалоба',
  error: '🐞 Ошибка',
  ad: '📣 Реклама',
  reply: '💬 Диалог'
};
const REASON_SHORT = {
  idea: 'идею',
  complaint: 'жалобу',
  error: 'ошибку',
  ad: 'рекламу',
  reply: 'диалог'
};

function escTg(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status);
  return r.json();
}

async function sbWrite(path, row, prefer) {
  const r = await fetch(SUPABASE_URL + path, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: prefer || 'return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('POST ' + path + ' → ' + r.status + ' ' + await r.text());
}

async function sbPatch(path, row) {
  const r = await fetch(SUPABASE_URL + path, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('PATCH ' + path + ' → ' + r.status + ' ' + await r.text());
}

async function sbDel(path) {
  const r = await fetch(SUPABASE_URL + path, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Prefer: 'return=minimal' }
  });
  if (!r.ok) throw new Error('DELETE ' + path + ' → ' + r.status);
}

async function metaGet(key, def) {
  const rows = await sbGet('/rest/v1/bot_meta?key=eq.' + key + '&select=value');
  return rows.length ? rows[0].value : def;
}

async function metaSet(key, value) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/bot_meta', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates'
    },
    body: JSON.stringify({ key: key, value: value })
  });
  if (!r.ok) throw new Error('metaSet → ' + r.status);
}

async function metaDel(key) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/bot_meta?key=eq.' + key, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Prefer: 'return=minimal' }
  });
  if (!r.ok) throw new Error('metaDel → ' + r.status);
}

async function tgChat(chatId, text, markup, parseMode) {
  if (!TG) return;
  const body = { chat_id: chatId, text: text, disable_web_page_preview: true };
  if (markup) body.reply_markup = markup;
  if (parseMode) body.parse_mode = parseMode;
  try {
    await fetch('https://api.telegram.org/bot' + TG + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) { console.log('   ! tgChat: ' + e.message); }
}

async function tg(text, markup, parseMode) {
  if (!CHAT) return;
  await tgChat(CHAT, text, markup, parseMode);
}

async function tgTo(chatId, text) {
  await tgChat(chatId, text, null, 'HTML');
}

async function answerCallback(cbId, text) {
  if (!TG) return;
  const body = { callback_query_id: cbId };
  if (text) body.text = text;
  try {
    await fetch('https://api.telegram.org/bot' + TG + '/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) { console.log('   ! answerCallback: ' + e.message); }
}

async function getUpdates(offset) {
  const r = await fetch('https://api.telegram.org/bot' + TG + '/getUpdates?offset=' + offset + '&limit=100');
  const j = await r.json();
  return j.ok ? j.result : [];
}

const KEYBOARD = {
  keyboard: [
    [{ text: '⚡ Сводка' }, { text: '👥 Народ' }],
    [{ text: '🔮 Прогнозы' }, { text: '🌅 Дайджест' }],
    [{ text: '🔕 Тихий режим' }, { text: '🔔 Уведомлять' }],
    [{ text: '❓ Помощь' }]
  ],
  resize_keyboard: true
};

function isOwn(s) {
  return s.lat >= OWN_BOX.lat1 && s.lat <= OWN_BOX.lat2 && s.lon >= OWN_BOX.lon1 && s.lon <= OWN_BOX.lon2;
}

// === УЛУЧШЕННЫЕ ОТЧЁТЫ С ВЫДЕЛЕНИЯМИ ===

async function reportStatus() {
  const obs = await sbGet('/rest/v1/observations?order=timestamp.desc&limit=1000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level,timestamp');
  const stations = await sbGet('/rest/v1/stations?select=id,name,lat,lon&limit=2000');
  const lastBy = {};
  for (const o of obs) if (!lastBy[o.station_id]) lastBy[o.station_id] = o;
  
  let queues = 0, deficits = [], fresh = 0, stale = 0;
  const now = Date.now();
  
  for (const s of stations) {
    if (!isOwn(s)) continue;
    const o = lastBy[s.id];
    if (!o) continue;
    
    const age = (now - new Date(o.timestamp).getTime()) / 60000;
    if (age <= 30) fresh++;
    else if (age > 360) stale++;
    
    if (o.queue_level === 'high') {
      queues++;
      deficits.push({ name: s.name || 'АЗС', type: '🚗 <b>ОЧЕРЕДЬ</b>', age: Math.round(age) });
    }
    
    const miss = [];
    if (o.fuel_92_status === false) miss.push('<b>АИ-92</b>');
    if (o.fuel_95_status === false) miss.push('<b>АИ-95</b>');
    if (o.diesel_status === false) miss.push('<b>дизель</b>');
    if (miss.length) {
      deficits.push({ name: s.name || 'АЗС', type: '⛽ Нет: ' + miss.join(', '), age: Math.round(age) });
    }
  }
  
  let txt = '⚡ <b>СВОДКА ГОРОДА</b>\n\n';
  txt += '📊 <b>Данные:</b>\n';
  txt += '  ✅ Свежие (≤30 мин): <b>' + fresh + '</b>\n';
  txt += '  ⚠️ Устаревшие (>6 ч): <b>' + stale + '</b>\n\n';
  
  txt += '🚗 <b>Очереди:</b> <b>' + queues + '</b> АЗС\n';
  
  if (deficits.length) {
    txt += '\n🔴 <b>ПРОБЛЕМЫ:</b>\n';
    deficits.slice(0, 10).forEach(d => {
      txt += '• <b>' + escTg(d.name) + '</b>\n';
      txt += '  ' + d.type + '\n';
      txt += '  ⏱️ ' + d.age + ' мин назад\n\n';
    });
    if (deficits.length > 10) txt += '<i>...и ещё ' + (deficits.length - 10) + ' станций</i>\n';
  } else {
    txt += '\n✅ <b>Всё спокойно:</b> дефицитов не видим\n';
  }
  
  return txt;
}

async function reportFolkMarks() {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const feedback = await sbGet('/rest/v1/user_feedback?created_at=gte.' + since + '&select=station_id,feedback_type,fuel_type,queue_size,created_at,verified_on_site&order=created_at.desc&limit=100');
  const stations = await sbGet('/rest/v1/stations?select=id,name&limit=2000');
  const name = {};
  for (const s of stations) name[s.id] = s.name;
  
  if (!feedback.length) return '👥 <b>НАРОДНЫЕ ОТМЕТКИ</b>\n\nЗа последний час отметок нет — водители молчат.';
  
  let txt = '👥 <b>НАРОДНЫЕ ОТМЕТКИ</b> <i>(последний час)</i>\n\n';
  
  const grouped = {};
  feedback.forEach(f => {
    if (!grouped[f.station_id]) grouped[f.station_id] = [];
    grouped[f.station_id].push(f);
  });
  
  const stationIds = Object.keys(grouped).slice(0, 8);
  
  stationIds.forEach(stId => {
    const marks = grouped[stId];
    const stName = name[stId] || 'АЗС';
    txt += '📍 <b>' + escTg(stName) + '</b>\n';
    
    marks.slice(0, 3).forEach(m => {
      const time = new Date(m.created_at);
      const hhmm = String(time.getHours()).padStart(2, '0') + ':' + String(time.getMinutes()).padStart(2, '0');
      const onSite = m.verified_on_site ? ' 📍<b>с места</b>' : '';
      
      if (m.feedback_type === 'available') {
        const fuel = m.fuel_type === '92' ? 'АИ-92' : m.fuel_type === '95' ? 'АИ-95' : 'дизель';
        txt += '  ✅ <b>' + fuel + ' есть</b>' + onSite + ' <i>' + hhmm + '</i>\n';
      } else if (m.feedback_type === 'unavailable') {
        const fuel = m.fuel_type === '92' ? 'АИ-92' : m.fuel_type === '95' ? 'АИ-95' : 'дизель';
        txt += '  ❌ <b>' + fuel + ' нет</b>' + onSite + ' <i>' + hhmm + '</i>\n';
      } else if (m.feedback_type === 'queue') {
        const size = m.queue_size === 'small' ? '2-3' : m.queue_size === 'medium' ? '4-6' : m.queue_size === 'large' ? '7+' : '100+';
        txt += '  🚗 <b>Очередь ' + size + ' машин</b>' + onSite + ' <i>' + hhmm + '</i>\n';
      } else if (m.feedback_type === 'in_queue') {
        txt += '  🧍 <b>Стоит в очереди сейчас</b>' + onSite + ' <i>' + hhmm + '</i>\n';
      } else if (m.feedback_type === 'delivery') {
        txt += '  🚚 <b>Привезли топливо</b>' + onSite + ' <i>' + hhmm + '</i>\n';
      }
    });
    
    if (marks.length > 3) txt += '  <i>...и ещё ' + (marks.length - 3) + ' отметок</i>\n';
    txt += '\n';
  });
  
  if (Object.keys(grouped).length > 8) {
    txt += '<i>...и ещё ' + (Object.keys(grouped).length - 8) + ' станций с отметками</i>\n';
  }
  
  const total = feedback.length;
  const onSite = feedback.filter(f => f.verified_on_site).length;
  txt += '\n📈 <b>Итого:</b> ' + total + ' отметок, из них ' + onSite + ' с места (GPS)';
  
  return txt;
}

async function reportPredictions() {
  const preds = await sbGet('/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&select=station_id,fuel_type,from_time,to_time,target_date,confidence&limit=50');
  const stations = await sbGet('/rest/v1/stations?select=id,name&limit=2000');
  const name = {};
  for (const s of stations) name[s.id] = s.name;
  
  if (!preds.length) return '🔮 <b>ПРОГНОЗЫ</b>\n\nАктивных прогнозов нет: копим события для модели.';
  
  let txt = '🔮 <b>АКТИВНЫЕ ПРОГНОЗЫ</b>\n\n';
  
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  
  const todayPreds = preds.filter(p => p.target_date === todayStr);
  const tomorrowPreds = preds.filter(p => p.target_date !== todayStr);
  
  if (todayPreds.length) {
    txt += '📅 <b>Сегодня:</b>\n';
    todayPreds.slice(0, 5).forEach(p => {
      const fuel = p.fuel_type === '92' ? 'АИ-92' : p.fuel_type === '95' ? 'АИ-95' : 'дизель';
      const conf = p.confidence ? Math.round(p.confidence * 100) + '%' : '—';
      txt += '• <b>' + escTg(name[p.station_id] || 'АЗС') + '</b>\n';
      txt += '  ' + fuel + ': <b>' + String(p.from_time).slice(0, 5) + '–' + String(p.to_time).slice(0, 5) + '</b>\n';
      txt += '  🎯 Уверенность: <b>' + conf + '</b>\n\n';
    });
    if (todayPreds.length > 5) txt += '<i>...и ещё ' + (todayPreds.length - 5) + ' прогнозов на сегодня</i>\n\n';
  }
  
  if (tomorrowPreds.length) {
    txt += '📅 <b>Завтра и позже:</b> ' + tomorrowPreds.length + ' прогнозов\n';
  }
  
  txt += '\n📊 <b>Всего активных:</b> ' + preds.length + ' прогнозов';
  
  return txt;
}

async function reportDigest() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const events = await sbGet('/rest/v1/events?detected_at=gte.' + since + '&select=event_type,detected_at&limit=1000');
  const feedback = await sbGet('/rest/v1/user_feedback?created_at=gte.' + since + '&select=feedback_type,verified_on_site&limit=1000');
  
  const cnt = {};
  for (const e of events) cnt[e.event_type] = (cnt[e.event_type] || 0) + 1;
  
  const hours = {};
  for (const e of events) if (e.event_type === 'queue_appeared') {
    const h = (new Date(e.detected_at).getUTCHours() + 3) % 24;
    hours[h] = (hours[h] || 0) + 1;
  }
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
  
  const fbTotal = feedback.length;
  const fbOnSite = feedback.filter(f => f.verified_on_site).length;
  const fbAvailable = feedback.filter(f => f.feedback_type === 'available').length;
  const fbUnavailable = feedback.filter(f => f.feedback_type === 'unavailable').length;
  const fbQueue = feedback.filter(f => f.feedback_type === 'queue' || f.feedback_type === 'in_queue').length;
  
  let txt = '🌅 <b>ДАЙДЖЕСТ ЗА 24 ЧАСА</b>\n\n';
  
  txt += '⛽ <b>Топливо:</b>\n';
  txt += '  🟢 Вернулось: <b>' + (cnt.fuel_restored || 0) + '</b>\n';
  txt += '  🔴 Закончилось: <b>' + (cnt.fuel_disappeared || 0) + '</b>\n\n';
  
  txt += '🚗 <b>Очереди:</b>\n';
  txt += '  ➕ Появились: <b>' + (cnt.queue_appeared || 0) + '</b>\n';
  txt += '  ➖ Исчезли: <b>' + (cnt.queue_gone || 0) + '</b>\n';
  if (peak) txt += '  ⏰ Пик: <b>' + String(peak[0]).padStart(2, '0') + ':00</b>\n';
  txt += '\n';
  
  txt += '👥 <b>Народные отметки:</b>\n';
  txt += '  📊 Всего: <b>' + fbTotal + '</b>\n';
  txt += '  📍 С места (GPS): <b>' + fbOnSite + '</b> (' + (fbTotal ? Math.round(fbOnSite / fbTotal * 100) : 0) + '%)\n';
  txt += '  ✅ Подтвердили наличие: <b>' + fbAvailable + '</b>\n';
  txt += '  ❌ Подтвердили отсутствие: <b>' + fbUnavailable + '</b>\n';
  txt += '  🚗 Сообщили об очереди: <b>' + fbQueue + '</b>\n';
  
  return txt;
}

// === подписчики и мост (без изменений) ===

async function linkCode(code, chatId) {
  const rows = await sbGet('/rest/v1/tg_link_codes?code=eq.' + encodeURIComponent(code) + '&select=id,device_id,station_id,created_at');
  if (!rows.length) return null;
  if (Date.now() - new Date(rows[0].created_at).getTime() > CODE_TTL) {
    await sbDel('/rest/v1/tg_link_codes?code=eq.' + encodeURIComponent(code)).catch(() => {});
    return { expired: true };
  }
  await sbPatch('/rest/v1/tg_link_codes?id=eq.' + rows[0].id, { started_at: new Date().toISOString() });
  await sbWrite('/rest/v1/tg_subscriptions',
    { device_id: rows[0].device_id, chat_id: Number(chatId), enabled: true },
    'return=minimal,resolution=merge-duplicates');
  const res = { device_id: rows[0].device_id, station_id: rows[0].station_id || null };
  await sbPatch('/rest/v1/tg_link_codes?id=eq.' + rows[0].id, { linked_at: new Date().toISOString() });
  return res;
}

async function subSetEnabled(chatId, enabled) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/tg_subscriptions?chat_id=eq.' + chatId, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify({ enabled: enabled })
  });
  if (!r.ok) throw new Error('PATCH subs → ' + r.status);
}

const SUB_HELP = 'Личные команды:\n/quiet — пауза уведомлений по избранным АЗС\n/loud — снова уведомлять\n/stop — отключить подписку совсем\nИзбранное отмечается сердечком на сайте.';

async function fetchPendingMessages() {
  return await sbGet('/rest/v1/driver_messages?owner_notified_at=is.null&select=id,alias,reason,text,created_at&order=id.asc&limit=20');
}

async function notifyOwnerMessage(m) {
  const reasonLbl = REASON_LABEL[m.reason] || m.reason;
  const reasonShort = REASON_SHORT[m.reason] || 'обращение';
  const created = new Date(new Date(m.created_at).getTime() + 3 * 3600 * 1000);
  const hhmm = String(created.getUTCHours()).padStart(2, '0') + ':' + String(created.getUTCMinutes()).padStart(2, '0');
  const text = '📩 <b>Водитель #' + m.alias + ' · ' + reasonLbl + '</b>\n' +
    '<i>' + hhmm + ' МСК</i>\n\n' +
    '«' + escTg(m.text) + '»';
  const markup = {
    inline_keyboard: [[{
      text: '💬 Ответить на ' + reasonShort,
      callback_data: 'reply:' + m.id
    }]]
  };
  await tgChat(CHAT, text, markup, 'HTML');
  await sbPatch('/rest/v1/driver_messages?id=eq.' + m.id, {
    owner_notified_at: new Date().toISOString()
  });
}

async function setOwnerReplyPending(msgId) {
  await metaSet('owner_reply_pending', JSON.stringify({ msg_id: msgId, set_at: Date.now() }));
}

async function getOwnerReplyPending() {
  const v = await metaGet('owner_reply_pending', null);
  if (!v) return null;
  try {
    const obj = typeof v === 'string' ? JSON.parse(v) : v;
    if (!obj || !obj.msg_id) return null;
    if (Date.now() - obj.set_at > REPLY_PENDING_TTL) {
      await metaDel('owner_reply_pending');
      return null;
    }
    return obj;
  } catch (e) { return null; }
}

async function clearOwnerReplyPending() {
  await metaDel('owner_reply_pending');
}

async function deliverOwnerReply(msgId, replyText) {
  const rows = await sbGet('/rest/v1/driver_messages?id=eq.' + msgId + '&select=id,alias,device_id,reason,text');
  if (!rows.length) return { ok: false, reason: 'not_found' };
  const m = rows[0];
  const subs = await sbGet('/rest/v1/tg_subscriptions?device_id=eq.' + encodeURIComponent(m.device_id) + '&select=chat_id,enabled');
  if (!subs.length) return { ok: false, reason: 'no_link' };
  const sub = subs[0];
  if (sub.enabled === false) return { ok: false, reason: 'muted' };
  const reasonLbl = REASON_LABEL[m.reason] || m.reason;
  const kind = m.reason === 'reply' ? 'на ваше сообщение в диалоге' : 'на ваше обращение «' + reasonLbl + '»';
  const driverText = '💬 <b>Ответ разработчика</b> ' + kind + ':\n\n' +
    '«<i>' + escTg(m.text) + '</i>»\n\n' +
    '— ' + escTg(replyText);
  await tgChat(sub.chat_id, driverText, { inline_keyboard: [[{ text: '💬 Ответить разработчику', callback_data: 'drvreply' }]] }, 'HTML');
  await sbPatch('/rest/v1/driver_messages?id=eq.' + msgId, {
    reply_text: replyText,
    reply_at: new Date().toISOString(),
    reply_sent_at: new Date().toISOString()
  });
  return { ok: true, alias: m.alias };
}

async function handleDriverFollowup(chatId, text) {
  try {
    if (text.length > 350) {
      await tgChat(chatId, 'Слишком длинно для обращения (лимит 350 символов) — сократите и отправьте ещё раз.');
      return;
    }
    const subs = await sbGet('/rest/v1/tg_subscriptions?chat_id=eq.' + chatId + '&select=device_id');
    if (!subs.length) return;
    const deviceId = subs[0].device_id;
    const hist = await sbGet('/rest/v1/driver_messages?device_id=eq.' + encodeURIComponent(deviceId) + '&select=reason&order=created_at.desc&limit=20');
    if (!hist.length) {
      await tgChat(chatId, 'Мы ещё не переписывались. Чтобы написать разработчику, нажмите «Написать нам / сообщить об ошибке» на сайте — это сообщение и все следующие придут сюда диалогом.');
      return;
    }
    const aliases = await sbGet('/rest/v1/driver_aliases?device_id=eq.' + encodeURIComponent(deviceId) + '&select=num');
    const alias = aliases.length ? aliases[0].num : 0;
    await sbWrite('/rest/v1/driver_messages', { device_id: deviceId, alias: alias, reason: 'reply', text: text });
    await tgChat(chatId, '✅ Передал разработчику. Ответ придёт сюда же, в этот чат.');
  } catch (e) { console.log('   ! followup: ' + e.message); }
}

async function main() {
  console.log('=== БОТ v5: читаю обновления ===');
  const offset = Number(await metaGet('update_offset', '0'));
  const updates = await getUpdates(offset);
  let next = offset;

  try {
    const pending = await fetchPendingMessages();
    for (const m of pending) {
      try { await notifyOwnerMessage(m); }
      catch (e) { console.log('   ! notifyOwner: ' + e.message); }
    }
    if (pending.length) console.log('   Новых обращений владельцу: ' + pending.length);
  } catch (e) { console.log('   ! fetchPendingMessages: ' + e.message); }

  let replyPending = await getOwnerReplyPending();

  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    try {

    if (u.callback_query) {
      const cb = u.callback_query;
      const cbChatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
      const data = cb.data || '';
      console.log('   update ' + u.update_id + ': callback chat=' + cbChatId + ' own=' + (cbChatId === CHAT) + ' data=' + data);
      if (cbChatId === CHAT && data.startsWith('reply:')) {
        const msgId = Number(data.slice(6));
        if (msgId) {
          await setOwnerReplyPending(msgId);
          replyPending = { msg_id: msgId, set_at: Date.now() };
          await answerCallback(cb.id, 'Жду ответ');
          await tgChat(CHAT, '✏️ Напишите ответ одним сообщением (до 2000 символов).\nВаше следующее сообщение уйдёт водителю.\n\nОтмена: отправьте /cancel.');
        } else {
          await answerCallback(cb.id, 'Ошибка');
        }
      } else if (data === 'drvreply') {
        await answerCallback(cb.id, 'Напишите сообщение');
        await tgChat(cbChatId, '✏️ Напишите ответ обычным сообщением — я передам его разработчику в ближайший момент.');
      } else {
        await answerCallback(cb.id);
      }
      continue;
    }

    const msg = u.message;
    const text = (msg && msg.text) || '';
    const chatId = msg && msg.chat ? String(msg.chat.id) : '';
    if (!text || !chatId) continue;
    const t = text.trim();

    if (chatId === CHAT && replyPending && (t === '/cancel' || t === '/start')) {
      await clearOwnerReplyPending();
      replyPending = null;
      if (t === '/cancel') {
        await tg('Отменено. Ответ не отправлен.');
        continue;
      }
    }

    if (chatId === CHAT && replyPending) {
      const result = await deliverOwnerReply(replyPending.msg_id, t);
      await clearOwnerReplyPending();
      replyPending = null;
      if (result.ok) {
        await tg('✅ Ответ отправлен Водителю #' + result.alias + ' в личный чат с ботом.');
      } else if (result.reason === 'no_link') {
        await tg('⚠️ Не удалось отправить: водитель не привязал Телеграм (возможно, ещё не нажал «Старт» в боте).');
      } else if (result.reason === 'muted') {
        await tg('⚠️ Водитель поставил уведомления на паузу (/quiet). Ответ сохранён в базе и будет показан, когда он снимет паузу.');
      } else {
        await tg('⚠️ Обращение не найдено — возможно, уже было отвечено другим проходом.');
      }
      continue;
    }

    if (chatId === CHAT && t.startsWith('/reply ')) {
      const id = Number(t.slice(7));
      if (id) {
        await setOwnerReplyPending(id);
        replyPending = { msg_id: id, set_at: Date.now() };
        await tg('✏️ Режим ответа включён командой. Напишите ответ одним сообщением — оно уйдёт водителю. Отмена: /cancel');
      } else {
        await tg('Формат: /reply <номер обращения> (число после reply: на кнопке или id строки driver_messages).');
      }
      continue;
    }

    const m = t.match(/^\/start\s+(kb[0-9a-z]+)$/i);
    if (m) {
      let res = null;
      try { res = await linkCode(m[1], chatId); } catch (e) { console.log('   ! связка: ' + e.message); }
      let stName = null;
      if (res && res.station_id) {
        try {
          const ss = await sbGet('/rest/v1/stations?id=eq.' + encodeURIComponent(res.station_id) + '&select=name,address&limit=1');
          if (ss.length) stName = ss[0].name + (ss[0].address ? ', ' + ss[0].address : '');
        } catch (e) {}
      }
      if (res && !res.expired) {
        let msg;
        if (stName) {
          msg = 'Привет! 👋\n\nЯ буду следить за заправкой <b>' + escTg(stName) + '</b>.\n\nЧто буду присылать:\n🔔 Когда появится вероятность возвращения топлива\n⛽ Изменения ситуации на этой АЗС\n📍 Любые события по вашим избранным (добавляйте сердечком на сайте)\n\nУправление:\n/quiet — пауза\n/loud — снова уведомлять\n/stop — отключить совсем\n\nОтвет разработчика на «Написать нам» тоже приходит сюда.';
        } else {
          msg = '✅ Готово! Теперь я лично пишу вам, когда на избранных АЗС (сердечко на сайте) вернётся или кончится топливо, либо появится очередь.\nПауза: /quiet, отключить: /stop.\n\nА ещё сюда придёт ответ разработчика, если вы написали через «Написать нам» на сайте.';
        }
        await tgChat(chatId, msg, null, 'HTML');
      } else if (res && res.expired) {
        await tgChat(chatId, 'Код устарел (живёт 15 минут). Вернитесь на сайт и нажмите «Получать уведомления в Telegram» ещё раз.');
      } else {
        await tgChat(chatId, 'Код не найден. Откройте карточку АЗС на сайте и нажмите «Получать уведомления в Telegram» — получится новый код.');
      }
      if (chatId === CHAT) await tgChat(CHAT, 'Этот чат связан с сайтом как устройство-подписчик. Кнопки владельца ниже.', KEYBOARD);
      continue;
    }

    if (chatId !== CHAT) {
      if (t === '/quiet') {
        try { await subSetEnabled(chatId, false); await tgChat(chatId, '🔕 Пауза: по избранным АЗС и ответов от разработчика писать не буду. Вернуть: /loud'); }
        catch (e) { await tgChat(chatId, 'Не получилось поставить паузу, попробуйте ещё раз.'); }
      } else if (t === '/loud') {
        try { await subSetEnabled(chatId, true); await tgChat(chatId, '🔔 Уведомления по избранным АЗС и ответы разработчика снова включены!'); }
        catch (e) { await tgChat(chatId, 'Не получилось включить, попробуйте ещё раз.'); }
      } else if (t === '/stop') {
        try { await subSetEnabled(chatId, false); await tgChat(chatId, 'Подписка отключена. Чтобы вернуть — нажмите «Подключить Телеграм» на сайте ещё раз.'); }
        catch (e) {}
      } else if (t === '/help' || t === '❓ Помощь') {
        await tgChat(chatId, SUB_HELP);
      } else if (t === '/start') {
        await tgChat(chatId, 'Привет! Я КогдаБенз. Личные уведомления включаются с сайта: откройте карточку избранной АЗС и нажмите «Подключить Телеграм».\n' + SUB_HELP);
      } else {
        await handleDriverFollowup(chatId, t);
      }
      continue;
    }

    if (t === '/start') {
      await tg('Привет! Я КогдаБенз v5, суточный диспетчер.\n\nДержу кнопки ниже с улучшенными выжимками:\n⚡ Сводка — дефициты и очереди с подсветкой\n👥 Народ — свежие отметки водителей\n🔮 Прогнозы — активные окна пополнения\n🌅 Дайджест — полная статистика за 24 ч\n\n📩 Обращения водителей приходят с кнопкой «Ответить».', KEYBOARD);
    } else if (t === '⚡ Сводка' || t === '/status') {
      await tg(await reportStatus(), null, 'HTML');
    } else if (t === '👥 Народ' || t === '/folk') {
      await tg(await reportFolkMarks(), null, 'HTML');
    } else if (t === '🔮 Прогнозы' || t === '/predict') {
      await tg(await reportPredictions(), null, 'HTML');
    } else if (t === '🌅 Дайджест' || t === '/digest') {
      await tg(await reportDigest(), null, 'HTML');
    } else if (t === '🔕 Тихий режим' || t === '/quiet') {
      await metaSet('notify', '0');
      await tg('Принял. Событийные уведомления ставлю на паузу. Отчёты по кнопкам, аварии и обращения водителей продолжу присылать. Вернуть: «🔔 Уведомлять».');
    } else if (t === '🔔 Уведомлять' || t === '/loud') {
      await metaSet('notify', '1');
      await tg('Уведомления снова включены!');
    } else if (t === '❓ Помощь' || t === '/help') {
      await tg('Что я умею:\n\n⚡ <b>Сводка</b> — дефициты и очереди сейчас с подсветкой проблем\n👥 <b>Народ</b> — свежие отметки водителей за последний час\n🔮 <b>Прогнозы</b> — активные окна пополнения\n🌅 <b>Дайджест</b> — полная статистика за 24 ч\n🔕 / 🔔 — выключить/включить событийные уведомления\n\n📩 Мост с водителями: обращения «Написать нам» приходят с кнопкой «Ответить».\n\nЛичные подписки: /start КОД с сайта связывает устройство с чатом.', null, 'HTML');
    }

    } catch (e) {
      console.log('   ! update ' + u.update_id + ': ' + e.message);
    }
  }

  if (next !== offset) await metaSet('update_offset', String(next));
  console.log('   Обновлений обработано: ' + updates.length);
  console.log('✅ Бот завершил проход');
}

main().catch(e => { console.error('❌ Ошибка бота: ' + e.message); process.exit(1); });