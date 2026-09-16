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
  const mskNow = new Date(Date.now() + 3 * 3600 * 1000);
  const todayStr = mskNow.toISOString().slice(0, 10);
  const preds = await sbGet(
    '/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&target_date=lt.' + todayStr +
    '&select=id,station_id,fuel_type,from_time,to_time,target_date,expected_restore_at,baseline_restore_at,created_at&limit=1000'
  );
  console.log('   Ожидают проверки: ' + preds.length);

  const now = Date.now();
  const queue = [];
  for (const p of preds) {
    const dayStart = Date.UTC(Number(p.target_date.slice(0, 4)), Number(p.target_date.slice(5, 7)) - 1, Number(p.target_date.slice(8, 10))) - 3 * 3600 * 1000;
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
    '/rest/v1/events?event_type=eq.fuel_restored&detected_at=gte.' + new Date(minDay - 24 * 3600 * 1000).toISOString() +
    '&select=station_id,fuel_type,detected_at&limit=5000'
  );

  let checked = 0, success = 0;
  for (const { p, winStart, winEnd, dayStart } of queue) {
    const createdMs = p.created_at ? new Date(p.created_at).getTime() : 0;
    const pairEvents = events
      .filter(e => e.station_id === p.station_id && e.fuel_type === p.fuel_type)
      .map(e => ({ e: e, t: new Date(e.detected_at).getTime() }))
      .filter(x => x.t >= createdMs)
      .sort((a, b) => a.t - b.t);
    const hit = pairEvents.find(x => x.t >= winStart && x.t <= winEnd);
    // v1.2: величина ошибки, а не только SUCCESS/MISS
    const actual = pairEvents.length ? pairEvents[0] : null;
    let expectedMs;
    if (p.expected_restore_at) expectedMs = new Date(p.expected_restore_at).getTime();
    else expectedMs = dayStart + ((timeToMin(p.from_time) + timeToMin(p.to_time)) / 2) * 60000;
    const patch = {
      result: hit ? 'SUCCESS' : 'MISS',
      is_verified: true,
      verified_at: new Date().toISOString(),
      actual_event_time: hit ? hit.e.detected_at : null
    };
    if (actual) {
      patch.actual_restore_at = actual.e.detected_at;
      patch.error_minutes = Math.round((actual.t - expectedMs) / 60000);
      if (p.baseline_restore_at) patch.baseline_error_minutes = Math.round((actual.t - new Date(p.baseline_restore_at).getTime()) / 60000);
    }
    await sbPatch('predictions?id=eq.' + p.id, patch);
    checked++;
    if (hit) success++;
    console.log('   ' + (hit ? '✅ SUCCESS' : '❌ MISS') + ' · ' + p.fuel_type +
      ' · окно ' + p.from_time.slice(0, 5) + '–' + p.to_time.slice(0, 5) +
      (patch.error_minutes !== undefined
        ? ' · ошибка ' + (patch.error_minutes > 0 ? '+' : '') + patch.error_minutes + ' мин'
        : ''));
  }

  const pct = checked ? Math.round(success / checked * 100) : 0;
  console.log('   Проверено: ' + checked + ', точных: ' + success + ' (' + pct + '%)');
  // измерение: объём учебной выборки и ошибка модели против baseline на одних и тех же прогнозах
  try {
    const train = await sbGet('/rest/v1/predictions?is_verified=eq.true&error_minutes=not.is.null&select=error_minutes,baseline_error_minutes&limit=5000');
    if (train.length) {
      const absSort = a => a.map(x => Math.abs(x)).sort((x, y) => x - y);
      const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
      const mae = a => Math.round(a.reduce((s, x) => s + Math.abs(x), 0) / a.length);
      const e = absSort(train.map(t => t.error_minutes));
      const b = absSort(train.filter(t => t.baseline_error_minutes !== null && t.baseline_error_minutes !== undefined).map(t => t.baseline_error_minutes));
      console.log('   TRAINING DATA: с ошибкой: ' + train.length +
        ' | модель: MAE ' + mae(e) + ', медиана ' + q(e, 0.5) + ', p90 ' + q(e, 0.9) +
        (b.length ? ' | baseline: MAE ' + mae(b) + ', медиана ' + q(b, 0.5) + ', p90 ' + q(b, 0.9) : ''));
    } else {
      console.log('   TRAINING DATA: верифицированных с ошибкой пока нет');
    }
  } catch (e) { console.log('   ! TRAINING DATA: ' + e.message); }
  await tg('🧮 КогдаБенз-верификатор: проверил ' + checked + ' прогнозов, точных ' + success + ' (' + pct + '%). Ячейка «Точность» на сайте обновляется.');
  console.log('✅ Верификатор завершил работу');
}

main().catch(e => { console.error('❌ Ошибка верификатора: ' + e.message); process.exit(1); });