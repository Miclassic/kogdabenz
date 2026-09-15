// ===== Утренний дайджест Новороссийска =====
// Запускается раз в сутки в 08:00 по Москве (через cron-job.org -> workflow_dispatch).
// Собирает прошедшие 24 часа в ОДНО сообщение. Оперативные уведомления коллектора не трогает.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const OWN_BOX = { lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.05 };

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status + ' ' + await r.text());
  return r.json();
}

async function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('Нет телеграм-секретов');
  const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error('Telegram: ' + r.status);
}

function isOwn(s) {
  return s.lat >= OWN_BOX.lat1 && s.lat <= OWN_BOX.lat2 && s.lon >= OWN_BOX.lon1 && s.lon <= OWN_BOX.lon2;
}

async function main() {
  console.log('=== ДАЙДЖЕСТ за 24 часа ===');
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const events = await sbGet('/rest/v1/events?detected_at=gte.' + since + '&select=event_type,fuel_type,station_id,detected_at&limit=1000');
  const stations = await sbGet('/rest/v1/stations?select=id,name,address,lat,lon&limit=2000');
  const obs = await sbGet('/rest/v1/observations?order=timestamp.desc&limit=1000&select=station_id,fuel_92_status,fuel_95_status,diesel_status');
  const preds = await sbGet('/rest/v1/predictions?result=eq.PENDING&select=station_id,fuel_type,from_time,to_time&limit=1000');
  const fb = await sbGet('/rest/v1/user_feedback?created_at=gte.' + since + '&select=id&limit=1000');

  const nameById = {};
  for (const s of stations) nameById[s.id] = s.name || 'АЗС';

  const lastBy = {};
  for (const o of obs) if (!lastBy[o.station_id]) lastBy[o.station_id] = o;

  const cnt = {};
  for (const e of events) cnt[e.event_type] = (cnt[e.event_type] || 0) + 1;
  const restored = cnt.fuel_restored || 0;
  const disappeared = cnt.fuel_disappeared || 0;
  const qApp = cnt.queue_appeared || 0;
  const qGone = cnt.queue_gone || 0;

  const hours = {};
  for (const e of events) if (e.event_type === 'queue_appeared') {
    const d = new Date(e.detected_at);
    const h = (d.getUTCHours() + 3) % 24;
    hours[h] = (hours[h] || 0) + 1;
  }
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];

  const deficits = [];
  for (const s of stations) {
    if (!isOwn(s)) continue;
    const o = lastBy[s.id];
    if (!o) continue;
    const missing = [];
    if (o.fuel_92_status === false) missing.push('АИ-92');
    if (o.fuel_95_status === false) missing.push('АИ-95');
    if (o.diesel_status === false) missing.push('дизель');
    if (missing.length) deficits.push(nameById[s.id] + ': нет ' + missing.join(', '));
  }

  const L = [];
  L.push('🌅 КогдаБенз · дайджест за сутки');
  L.push('');
  L.push(restored || disappeared
    ? '⛽ Топливо: вернулось ' + restored + ' раз, закончилось ' + disappeared + ' раз'
    : '⛽ Топливо: за сутки возвратов не поймали');
  L.push('🚗 Очереди: появилась ' + qApp + ', рассосалась ' + qGone + (peak ? ', пик в ' + String(peak[0]).padStart(2, '0') + ':00' : ''));
  if (fb.length) L.push('🙋 Народных отметок: ' + fb.length);
  L.push('');
  if (deficits.length) {
    L.push('🔴 Сейчас нет топлива:');
    for (const d of deficits.slice(0, 6)) L.push('• ' + d);
  } else {
    L.push('🟢 Сейчас дефицитов по городу не видим');
  }
  L.push('');
  if (preds.length) {
    L.push('🔮 Активных прогнозов: ' + preds.length);
    for (const p of preds.slice(0, 3)) {
      L.push('• ' + nameById[p.station_id] + ' ' + (p.fuel_type || '') + ': ' + String(p.from_time).slice(0, 5) + '–' + String(p.to_time).slice(0, 5));
    }
  } else {
    L.push('🔮 Прогнозов пока нет: копим события возвратов');
  }
  const verified = await sbGet('/rest/v1/predictions?is_verified=eq.true&select=result&limit=1000');
  if (verified.length >= 10) {
    const vOk = verified.filter(v => v.result === 'SUCCESS').length;
    L.push('🎯 Точность прогнозов: ' + Math.round(vOk / verified.length * 100) + '% (' + verified.length + ' проверок)');
  }
  L.push('');
  L.push('Хорошего дня! 🚗');

  await tg(L.join('\n'));
  console.log('Дайджест отправлен:\n' + L.join('\n'));
}

main().catch(e => { console.error('❌ Ошибка дайджеста: ' + e.message); process.exit(1); });