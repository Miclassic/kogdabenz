// ===== Утренний дайджест Новороссийска (v2: подробнее и по-человечески) =====
// Запускается раз в сутки в 08:00 по Москве (через cron-job.org -> workflow_dispatch).
// Собирает прошедшие 24 часа в ОДНО сообщение. Оперативные уведомления коллектора не трогает.
// v2: разделы с деталями (последние возвраты, очереди сейчас и самая долгая,
// цена за сутки, ритм дня, тихий час), мини-график дня эмодзи-блоками,
// без сложных терминов: говорим как водитель, а не как статистик.

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
// таблицы переросли лимит Supabase в 1000 строк: читаем страницами до конца
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
function mskDate(d) { return new Date(d.getTime() + 3 * 3600 * 1000); }
function hhmm(iso) { const d = mskDate(new Date(iso)); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
function hourMsk(iso) { return mskDate(new Date(iso)).getUTCHours(); }
function fuelLabel(f) { return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : 'топливо'; }
function ageRu(min) {
  if (min === null || min === undefined) return null;
  if (min < 60) return min + ' мин';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  return Math.floor(h / 24) + ' дн';
}
// мини-график дня: столбики из блоков, как «кардиограмма» в одну строку
function spark(arr) {
  const chars = '▁▂▃▄▅▆▇█';
  const max = Math.max(1, ...arr);
  return arr.map(v => chars[Math.min(7, Math.round(v / max * 7))]).join('');
}

async function main() {
  console.log('=== ДАЙДЖЕСТ за 24 часа (v2) ===');
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const mskNow = mskDate(new Date());
  const dayLbl = String(mskNow.getUTCDate()).padStart(2, '0') + '.' + String(mskNow.getUTCMonth() + 1).padStart(2, '0');
  const todayStr = mskNow.toISOString().slice(0, 10);

  const [events, stations, lastObs, preds, fb, priceRows, episodes, fuelHourly, verified] = await Promise.all([
    sbGetAll('/rest/v1/events?detected_at=gte.' + since + '&select=event_type,fuel_type,station_id,detected_at&order=detected_at.desc'),
    sbGet('/rest/v1/stations?select=id,name,address,lat,lon&limit=2000'),
    sbGet('/rest/v1/station_last_obs?select=station_id,fuel_92_status,fuel_95_status,diesel_status,queue_level&limit=1000'),
    sbGetAll('/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&target_date=eq.' + todayStr + '&select=station_id,fuel_type,from_time,to_time,confidence'),
    sbGet('/rest/v1/user_feedback?created_at=gte.' + since + '&select=id&limit=1000'),
    sbGet('/rest/v1/city_price_hourly?select=hour,p95&order=hour.desc&limit=24').catch(() => []),
    sbGet('/rest/v1/city_queue_episodes?select=station_id,started_at,ended_at&order=started_at.desc&limit=1000').catch(() => []),
    sbGet('/rest/v1/region_fuel_hourly?city=eq.novorossiysk&select=hour,q,selling&order=hour.desc&limit=96').catch(() => []),
    sbGetAll('/rest/v1/predictions?is_verified=eq.true&select=result')
  ]);

  const nameById = {};
  const ownIds = new Set();
  for (const s of stations) {
    nameById[s.id] = s.name || 'АЗС';
    if (isOwn(s)) ownIds.add(s.id);
  }

  // --- топливо за сутки ---
  const cnt = {};
  for (const e of events) cnt[e.event_type] = (cnt[e.event_type] || 0) + 1;
  const restored = cnt.fuel_restored || 0;
  const disappeared = cnt.fuel_disappeared || 0;
  const qApp = cnt.queue_appeared || 0;
  const qGone = cnt.queue_gone || 0;
  const restoredList = events.filter(e => e.event_type === 'fuel_restored').slice(0, 2)
    .map(e => (nameById[e.station_id] || 'АЗС') + ' (' + hhmm(e.detected_at) + ')');

  // --- сейчас по городу (последние автометки) ---
  let known = 0, avail = 0, qNow = 0;
  for (const o of lastObs) {
    if (!ownIds.has(o.station_id)) continue;
    if (o.fuel_92_status !== null && o.fuel_92_status !== undefined) { known++; if (o.fuel_95_status === true) avail++; }
    else if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) { known++; if (o.fuel_95_status === true) avail++; }
    else if (o.diesel_status !== null && o.diesel_status !== undefined) known++;
    if (o.queue_level === 'high') qNow++;
  }

  // --- очереди: сейчас стоит и самая долгая ---
  const nowMs = Date.now();
  let openOldest = null;
  for (const e of episodes) {
    if (e.ended_at || !ownIds.has(e.station_id)) continue;
    const t = new Date(e.started_at).getTime();
    if (openOldest === null || t < openOldest) openOldest = t;
  }
  const openAge = openOldest === null ? null : Math.max(0, Math.round((nowMs - openOldest) / 60000));

  // --- ритм очередей за сутки (слева — вчера, справа — сейчас) ---
  const arr = new Array(24).fill(0);
  const hours = {};
  for (const e of events) {
    if (e.event_type !== 'queue_appeared') continue;
    const b = Math.floor((nowMs - new Date(e.detected_at).getTime()) / 3600000);
    if (b >= 0 && b < 24) arr[23 - b]++;
    const h = hourMsk(e.detected_at);
    hours[h] = (hours[h] || 0) + 1;
  }
  const sparkStr = arr.some(v => v) ? spark(arr) : '';
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];

  // --- цена АИ-95 за сутки ---
  let pNow = null, pBefore = null;
  for (const r of priceRows) { if (pNow === null && r.p95 !== null && r.p95 !== undefined) pNow = Number(r.p95); }
  for (let i = priceRows.length - 1; i >= 0; i--) { const r = priceRows[i]; if (r.p95 !== null && r.p95 !== undefined) { pBefore = Number(r.p95); break; } }

  // --- тихий час за последние 3 суток ---
  const byH = {};
  for (const r of fuelHourly) {
    const h = hourMsk(r.hour);
    const b = byH[h] || (byH[h] = { q: 0, s: 0 });
    b.q += r.q || 0; b.s += r.selling || 0;
  }
  let calmH = null, calmV = Infinity;
  for (let h = 0; h < 24; h++) {
    const b = byH[h];
    if (!b || b.s < 5) continue;
    const v = b.q / b.s;
    if (v < calmV) { calmV = v; calmH = h; }
  }

  // --- сообщение ---
  const L = [];
  L.push('🌅 КогдаБенз · утренняя сводка · ' + dayLbl);
  L.push('');
  L.push('⛽ Топливо за сутки');
  L.push(restored || disappeared
    ? '   вернулось ' + restored + ' раз, закончилось ' + disappeared + ' раз'
    : '   возвратов за сутки не поймали');
  if (restoredList.length) L.push('   последние возвраты: ' + restoredList.join(', '));
  L.push('   сейчас: АИ-95 есть на ' + avail + ' из ' + known + ' станций города' + (known < ownIds.size ? ' (остальные молчат)' : ''));
  L.push('');
  L.push('🚗 Очереди за сутки');
  L.push('   появилась ' + qApp + ', рассосалась ' + qGone);
  L.push(qNow
    ? '   сейчас стоит: ' + qNow + (openAge !== null ? ' (самая долгая — ' + ageRu(openAge) + ')' : '')
    : '   сейчас в городе очередей нет');
  if (sparkStr) L.push('   ритм дня: ' + sparkStr + (peak ? ' · больше всего очередей в ' + String(peak[0]).padStart(2, '0') + ':00' : ''));
  L.push('');
  if (pNow !== null && pBefore !== null) {
    const d = pNow - pBefore;
    L.push('💰 Цена АИ-95 за сутки: ' + pBefore.toFixed(1) + ' → ' + pNow.toFixed(1) + ' ₽ (' +
      (Math.abs(d) < 0.05 ? 'не изменилась' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ' ₽') + ')');
    L.push('');
  }
  if (preds.length) {
    const top = preds.slice().sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0)).slice(0, 3);
    L.push('🔮 Когда ждать возвращения топлива сегодня:');
    for (const p of top) {
      L.push('   • ' + (nameById[p.station_id] || 'АЗС') + ' · ' + fuelLabel(p.fuel_type) + ' · ' +
        String(p.from_time).slice(0, 5) + '–' + String(p.to_time).slice(0, 5) +
        ' (уверенность ' + Math.round((Number(p.confidence) || 0) * 100) + '%)');
    }
  } else {
    L.push('🔮 Прогнозов на сегодня пока нет: копим данные');
  }
  L.push('');
  L.push(fb.length
    ? '🙋 Народ отметилcя ' + fb.length + ' раз за сутки — спасибо!'
    : '🙋 Народ за сутки молчал: всё данные автоматических отметок');
  if (verified.length >= 10) {
    const ok = verified.filter(v => v.result === 'SUCCESS').length;
    L.push('🎯 Ночные проверки: ' + ok + ' из ' + verified.length + ' прогнозов попали в окно (' + Math.round(ok / verified.length * 100) + '%)');
  }
  if (calmH !== null) L.push('💡 Самое тихое время за 3 суток — ' + String(calmH).padStart(2, '0') + ':00: если есть выбор, заправляйся тогда');
  L.push('');
  L.push('Хорошего дня и полного бака! 🚗');

  await tg(L.join('\n'));
  console.log('Дайджест отправлен:\n' + L.join('\n'));
}

main().catch(e => { console.error('❌ Ошибка дайджеста: ' + e.message); process.exit(1); });