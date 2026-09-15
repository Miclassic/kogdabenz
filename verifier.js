// ===== Верификатор Новороссийска v1 =====
// Ночью оценивает вчерашние прогнозы по факту.
// SUCCESS — возврат топлива пойман в окне [from-30мин, to+60мин], иначе MISS.
// Допуски: -30мин (привезли чуть раньше окна) и +60мин (отметка/детектор запоздали).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const BEFORE_MIN = 30;
const AFTER_MIN = 60;

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status + ' ' + await r.text());
  return r.json();
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

async function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true })
    });
  } catch (e) { console.log('   ! Телеграм: ' + e.message); }
}

function mskDayStartUtc(iso) {
  const d = new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 3 * 3600 * 1000;
}

function timeToMin(t) {
  const p = String(t).split(':');
  return Number(p[0]) * 60 + Number(p[1] || 0);
}

async function main() {
  console.log('=== ВЕРИФИКАТОР v1 ===');
  const preds = await sbGet(
    '/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&select=id,station_id,fuel_type,from_time,to_time,created_at&limit=1000'
  );
  console.log('   Ожидают проверки: ' + preds.length);

  const now = Date.now();
  const queue = [];
  for (const p of preds) {
    const dayStart = mskDayStartUtc(p.created_at);
    const winStart = dayStart + (timeToMin(p.from_time) - BEFORE_MIN) * 60000;
    const winEnd = dayStart + (timeToMin(p.to_time) + AFTER_MIN) * 60000;
    if (now <= winEnd) continue; // окно ещё не закрылось
    queue.push({ p, winStart, winEnd, dayStart });
  }

  if (!queue.length) {
    console.log('   Закрывшихся окон пока нет — выходим.');
    console.log('✅ Верификатор завершил работу');
    return;
  }

  const minDay = Math.min(...queue.map(x => x.dayStart));
  const events = await sbGet(
    '/rest/v1/events?event_type=eq.fuel_restored&detected_at=gte.' + new Date(minDay).toISOString() +
    '&select=station_id,fuel_type,detected_at&limit=5000'
  );

  let checked = 0, success = 0;
  for (const { p, winStart, winEnd } of queue) {
    const hit = events.find(e =>
      e.station_id === p.station_id &&
      e.fuel_type === p.fuel_type &&
      new Date(e.detected_at).getTime() >= winStart &&
      new Date(e.detected_at).getTime() <= winEnd
    );
    await sbPatch('predictions?id=eq.' + p.id, {
      result: hit ? 'SUCCESS' : 'MISS',
      is_verified: true,
      verified_at: new Date().toISOString(),
      actual_event_time: hit ? hit.detected_at : null
    });
    checked++;
    if (hit) success++;
    console.log('   ' + (hit ? '✅ SUCCESS' : '❌ MISS') + ' · ' + p.fuel_type +
      ' · окно ' + p.from_time.slice(0, 5) + '–' + p.to_time.slice(0, 5));
  }

  const pct = checked ? Math.round(success / checked * 100) : 0;
  console.log('   Проверено: ' + checked + ', точных: ' + success + ' (' + pct + '%)');
  await tg('🧮 КогдаБенз-верификатор: проверил ' + checked + ' прогнозов, точных ' + success + ' (' + pct + '%). Ячейка «Точность» на сайте обновляется.');
  console.log('✅ Верификатор завершил работу');
}

main().catch(e => { console.error('❌ Ошибка верификатора: ' + e.message); process.exit(1); });