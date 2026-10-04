// ===== Бот КогдаБенз v3: кнопки владельца + личные подписки водителей =====
// Сервера нет: читаем обновления Telegram по расписанию (cron-job.org -> workflow).
// Кнопки — клавиатурные (нажатие = текст), поэтому колбэки и сервер не нужны.
// Отчёты и тихий режим владельца — ТОЛЬКО хозяйскому чату (TELEGRAM_CHAT_ID).
// Личные команды подписчиков (/start КОД, /quiet, /loud, /stop, /help) — любому чату.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TG = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const OWN_BOX = { lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.05 };
const CODE_TTL = 15 * 60 * 1000; // код связки живёт 15 минут

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

async function tgChat(chatId, text, markup) {
  if (!TG) return;
  const body = { chat_id: chatId, text: text, disable_web_page_preview: true };
  if (markup) body.reply_markup = markup;
  await fetch('https://api.telegram.org/bot' + TG + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function tg(text, markup) {
  if (!CHAT) return;
  await tgChat(CHAT, text, markup);
}

async function getUpdates(offset) {
  const r = await fetch('https://api.telegram.org/bot' + TG + '/getUpdates?offset=' + offset + '&limit=100');
  const j = await r.json();
  return j.ok ? j.result : [];
}

const KEYBOARD = {
  keyboard: [
    [{ text: '📊 Сводка города' }, { text: '🔮 Прогнозы' }],
    [{ text: '🌅 Дайджест' }, { text: '🔕 Тихий режим' }],
    [{ text: '🔔 Уведомлять' }, { text: '❓ Помощь' }]
  ],
  resize_keyboard: true
};

function isOwn(s) {
  return s.lat >= OWN_BOX.lat1 && s.lat <= OWN_BOX.lat2 && s.lon >= OWN_BOX.lon1 && s.lon <= OWN_BOX.lon2;
}

async function reportStatus() {
  const obs = await sbGet('/rest/v1/observations?order=timestamp.desc&limit=1000&select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level');
  const stations = await sbGet('/rest/v1/stations?select=id,name,lat,lon&limit=2000');
  const lastBy = {};
  for (const o of obs) if (!lastBy[o.station_id]) lastBy[o.station_id] = o;
  const lines = [];
  let queues = 0;
  for (const s of stations) {
    if (!isOwn(s)) continue;
    const o = lastBy[s.id];
    if (!o) continue;
    if (o.queue_level === 'high') queues++;
    const miss = [];
    if (o.fuel_92_status === false) miss.push('АИ-92');
    if (o.fuel_95_status === false) miss.push('АИ-95');
    if (o.diesel_status === false) miss.push('дизель');
    if (miss.length) lines.push('• ' + (s.name || 'АЗС') + ': нет ' + miss.join(', '));
  }
  let txt = '📊 Сводка города\n\nОчереди сейчас: ' + queues + ' АЗС.\n';
  txt += lines.length ? 'Дефициты:\n' + lines.slice(0, 8).join('\n') : 'Дефицитов не видим.';
  return txt;
}

async function reportPredictions() {
  const preds = await sbGet('/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&select=station_id,fuel_type,from_time,to_time,target_date&limit=50');
  const stations = await sbGet('/rest/v1/stations?select=id,name&limit=2000');
  const name = {};
  for (const s of stations) name[s.id] = s.name;
  if (!preds.length) return '🔮 Активных прогнозов нет: копим события.';
  const lines = preds.slice(0, 8).map(p =>
    '• ' + (name[p.station_id] || 'АЗС') + ' ' +
    (p.fuel_type === '92' ? 'АИ-92' : p.fuel_type === '95' ? 'АИ-95' : 'дизель') + ': ' +
    String(p.from_time).slice(0, 5) + '–' + String(p.to_time).slice(0, 5) + ' (' + p.target_date + ')'
  );
  return '🔮 Активные прогнозы:\n' + lines.join('\n');
}

async function reportDigest() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const events = await sbGet('/rest/v1/events?detected_at=gte.' + since + '&select=event_type,detected_at&limit=1000');
  const cnt = {};
  for (const e of events) cnt[e.event_type] = (cnt[e.event_type] || 0) + 1;
  const hours = {};
  for (const e of events) if (e.event_type === 'queue_appeared') {
    const h = (new Date(e.detected_at).getUTCHours() + 3) % 24;
    hours[h] = (hours[h] || 0) + 1;
  }
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
  return '🌅 Дайджест за 24 ч\n\n🟢 Вернулся: ' + (cnt.fuel_restored || 0) +
    '\n🔴 Закончился: ' + (cnt.fuel_disappeared || 0) +
    '\n🚗 Очереди: +' + (cnt.queue_appeared || 0) + ' / −' + (cnt.queue_gone || 0) +
    (peak ? '\nПик очередей: ' + String(peak[0]).padStart(2, '0') + ':00' : '');
}

// === подписчики: связка кода из сайта с чатом ===
async function linkCode(code, chatId) {
  const rows = await sbGet('/rest/v1/tg_link_codes?code=eq.' + encodeURIComponent(code) + '&select=device_id,created_at');
  if (!rows.length) return null;
  if (Date.now() - new Date(rows[0].created_at).getTime() > CODE_TTL) {
    await sbDel('/rest/v1/tg_link_codes?code=eq.' + encodeURIComponent(code)).catch(() => {});
    return 'expired';
  }
  await sbWrite('/rest/v1/tg_subscriptions',
    { device_id: rows[0].device_id, chat_id: Number(chatId), enabled: true },
    'return=minimal,resolution=merge-duplicates');
  await sbDel('/rest/v1/tg_link_codes?code=eq.' + encodeURIComponent(code)).catch(() => {});
  return rows[0].device_id;
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

async function main() {
  console.log('=== БОТ v3: читаю обновления ===');
  const offset = Number(await metaGet('update_offset', '0'));
  const updates = await getUpdates(offset);
  let next = offset;

  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    const msg = u.message;
    const text = (msg && msg.text) || '';
    const chatId = msg && msg.chat ? String(msg.chat.id) : '';
    if (!text || !chatId) continue;
    const t = text.trim();

    // 1) связка сайт→бот: /start kb… (приходит по ссылке из окна сайта)
    const m = t.match(/^\/start\s+(kb[0-9a-z]+)$/i);
    if (m) {
      let res = null;
      try { res = await linkCode(m[1], chatId); } catch (e) { console.log('   ! связка: ' + e.message); }
      if (res && res !== 'expired') {
        await tgChat(chatId, '✅ Готово! Теперь я лично пишу вам, когда на избранных АЗС (сердечко на сайте) вернётся или кончится топливо, либо появится очередь.\nПауза: /quiet, отключить: /stop.');
      } else if (res === 'expired') {
        await tgChat(chatId, 'Код устарел (живёт 15 минут). Вернитесь на сайт и нажмите «Подключить Телеграм» ещё раз.');
      } else {
        await tgChat(chatId, 'Код не найден. Откройте карточку избранной АЗС на сайте и нажмите полоску «Подключить Телеграм» — получится новый код.');
      }
      if (chatId === CHAT) await tgChat(CHAT, 'Этот чат связан с сайтом как устройство-подписчик. Кнопки владельца ниже.', KEYBOARD);
      continue;
    }

    // 2) личные команды подписчиков (любой чат, кроме хозяйского)
    if (chatId !== CHAT) {
      if (t === '/quiet') {
        try { await subSetEnabled(chatId, false); await tgChat(chatId, '🔕 Пауза: по избранным АЗС писать не буду. Вернуть: /loud'); }
        catch (e) { await tgChat(chatId, 'Не получилось поставить паузу, попробуйте ещё раз.'); }
      } else if (t === '/loud') {
        try { await subSetEnabled(chatId, true); await tgChat(chatId, '🔔 Уведомления по избранным АЗС снова включены!'); }
        catch (e) { await tgChat(chatId, 'Не получилось включить, попробуйте ещё раз.'); }
      } else if (t === '/stop') {
        try { await subSetEnabled(chatId, false); await tgChat(chatId, 'Подписка отключена. Чтобы вернуть — нажмите «Подключить Телеграм» на сайте ещё раз.'); }
        catch (e) {}
      } else if (t === '/help' || t === '❓ Помощь') {
        await tgChat(chatId, SUB_HELP);
      } else if (t === '/start') {
        await tgChat(chatId, 'Привет! Я КогдаБенз. Личные уведомления включаются с сайта: откройте карточку избранной АЗС и нажмите «Подключить Телеграм».\n' + SUB_HELP);
      }
      continue;
    }

    // 3) хозяйский чат: кнопки и команды владельца (как раньше)
    if (t === '/start') {
      await tg('Привет! Я КогдаБенз, суточный диспетчер.\nДержу кнопки ниже, а ещё понимаю команды:\n/status /predict /digest /quiet /loud /help\nОтвечаю в пределах пары минут: живу не на сервере, а по расписанию.', KEYBOARD);
    } else if (t === '📊 Сводка города' || t === '/status') {
      await tg(await reportStatus());
    } else if (t === '🔮 Прогнозы' || t === '/predict') {
      await tg(await reportPredictions());
    } else if (t === '🌅 Дайджест' || t === '/digest') {
      await tg(await reportDigest());
    } else if (t === '🔕 Тихий режим' || t === '/quiet') {
      await metaSet('notify', '0');
      await tg('Принял. Событийные уведомления ставлю на паузу. Отчёты по кнопкам и аварии продолжу присылать. Вернуть: «🔔 Уведомлять».');
    } else if (t === '🔔 Уведомлять' || t === '/loud') {
      await metaSet('notify', '1');
      await tg('Уведомления снова включены!');
    } else if (t === '❓ Помощь' || t === '/help') {
      await tg('Что я умею:\n📊 Сводка города — дефициты и очереди сейчас\n🔮 Прогнозы — активные окна пополнения\n🌅 Дайджест — сводка за 24 ч\n🔕 / 🔔 — выключить/включить событийные уведомления\n\nЛичные подписки водителей: /start КОД с сайта связывает устройство с чатом; подписчики управляют собой командами /quiet /loud /stop.');
    }
  }

  if (next !== offset) await metaSet('update_offset', String(next));
  console.log('   Обновлений обработано: ' + updates.length);
  console.log('✅ Бот завершил проход');
}

main().catch(e => { console.error('❌ Ошибка бота: ' + e.message); process.exit(1); });