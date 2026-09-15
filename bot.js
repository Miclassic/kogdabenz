// ===== Бот КогдаБенз v2: кнопки и отчёты =====
// Сервера нет: читаем обновления Telegram по расписанию (cron-job.org -> workflow).
// Кнопки — клавиатурные (нажатие = текст), поэтому колбэки и сервер не нужны.
// Отвечает ТОЛЬКО хозяйскому чату (TELEGRAM_CHAT_ID).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TG = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const OWN_BOX = { lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.05 };

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status);
  return r.json();
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

async function tg(text, markup) {
  if (!TG || !CHAT) return;
  const body = { chat_id: CHAT, text: text, disable_web_page_preview: true };
  if (markup) body.reply_markup = markup;
  await fetch('https://api.telegram.org/bot' + TG + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
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

async function main() {
  console.log('=== БОТ v2: читаю обновления ===');
  const offset = Number(await metaGet('update_offset', '0'));
  const updates = await getUpdates(offset);
  let next = offset;

  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    const text = (u.message && u.message.text) || '';
    const chatId = u.message && u.message.chat ? String(u.message.chat.id) : '';
    if (!text || chatId !== CHAT) continue; // отвечаем только хозяйскому чату

    const t = text.trim();
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
      await tg('Что я умею:\n📊 Сводка города — дефициты и очереди сейчас\n🔮 Прогнозы — активные окна пополнения\n🌅 Дайджест — сводка за 24 ч\n🔕 / 🔔 — выключить/включить событийные уведомления\n\nКнопки внизу чата делают то же самое.');
    }
  }

  if (next !== offset) await metaSet('update_offset', String(next));
  console.log('   Обновлений обработано: ' + updates.length);
  console.log('✅ Бот завершил проход');
}

main().catch(e => { console.error('❌ Ошибка бота: ' + e.message); process.exit(1); });