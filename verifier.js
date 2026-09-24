// ===== Верификатор Новороссийска v1.2 =====
// Ночью оценивает вчерашние прогнозы по факту.
// SUCCESS — возврат топлива пойман в окне [from-30мин, to+60мин], иначе MISS.
// Допуски: -30мин (привезли чуть раньше окна) и +60мин (отметка/детектор запоздали).
// v1.2: величина ошибки (error_minutes) + baseline_error_minutes;
//       actual_restore_at берём как событие внутри окна (если есть hit),
//       иначе первое после окна (показывает «на сколько опоздали»),
//       а не любое первое — иначе «ранний возврат до окна» давал выброс;
//       пагинация: циклом по 1000, не теряем прогнозы при накоплении >1000.

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

function timeToMin(t) {
  const p = String(t).split(':');
  return Number(p[0]) * 60 + Number(p[1] || 0);
}

async function logTrainingData() {
  try {
    const all = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await sbGet(
        '/rest/v1/predictions?is_verified=eq.true&select=error_minutes,baseline_error_minutes,prediction_source,features' +
        '&order=id.asc&limit=1000&offset=' + offset
      );
      for (const t of page) all.push(t);
      if (page.length < 1000) break;
    }
    const censored = all.filter(t => t.error_minutes === null || t.error_minutes === undefined).length;
    const train = all.filter(t => t.error_minutes !== null && t.error_minutes !== undefined);
    if (!train.length) { console.log('   TRAINING DATA: верифицированных с ошибкой пока нет (цензурировано без факта: ' + censored + ')'); return; }
    const absSort = a => a.map(x => Math.abs(x)).sort((x, y) => x - y);
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
    const mae = a => Math.round(a.reduce((s, x) => s + Math.abs(x), 0) / a.length);
    const bias = a => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
    const fmtBias = a => (bias(a) > 0 ? '+' : '') + bias(a);
    const e = absSort(train.map(t => t.error_minutes));
    const b = absSort(train.filter(t => t.baseline_error_minutes !== null && t.baseline_error_minutes !== undefined).map(t => t.baseline_error_minutes));
    console.log('   TRAINING DATA: с ошибкой: ' + train.length + ', цензурировано: ' + censored +
      ' | модель: MAE ' + mae(e) + ', медиана ' + q(e, 0.5) + ', p90 ' + q(e, 0.9) + ', bias ' + fmtBias(train.map(t => t.error_minutes)) +
      (b.length ? ' | baseline: MAE ' + mae(b) + ', медиана ' + q(b, 0.5) + ', p90 ' + q(b, 0.9) : ''));
    const groups = {};
    for (const t of train) {
      const f = t.features || {};
      const regime = f.regime || 'UNKNOWN';
      const src = t.prediction_source || 'unknown';
      const eta = (f.knn_support || 0) >= 8 ? 'knn' : 'median';
      const h = f.hour_msk;
      const hb = h === null || h === undefined ? 'UNKNOWN' : h < 6 ? 'ночь' : h < 12 ? 'утро' : h < 18 ? 'день' : 'вечер';
      (groups['regime:' + regime] = groups['regime:' + regime] || []).push(t);
      (groups['source:' + src] = groups['source:' + src] || []).push(t);
      (groups['eta:' + eta] = groups['eta:' + eta] || []).push(t);
      (groups['час:' + hb] = groups['час:' + hb] || []).push(t);
    }
    for (const key of Object.keys(groups).sort()) {
      const rows = groups[key];
      if (rows.length < 5) continue;
      const errs = rows.map(t => t.error_minutes);
      const ge = absSort(errs);
      const gb = absSort(rows.filter(t => t.baseline_error_minutes !== null && t.baseline_error_minutes !== undefined).map(t => t.baseline_error_minutes));
      console.log('     ' + key + ': n ' + ge.length +
        ', bias ' + fmtBias(errs) +
        ', MAE ' + mae(ge) + ', мед ' + q(ge, 0.5) + ', p90 ' + q(ge, 0.9) +
        (gb.length ? ' | baseline MAE ' + mae(gb) : ''));
    }
  } catch (e) { console.log('   ! TRAINING DATA: ' + e.message); }
}

async function main() {
  console.log('=== ВЕРИФИКАТОР v1.2 ===');
  const mskNow = new Date(Date.now() + 3 * 3600 * 1000);
  const todayStr = mskNow.toISOString().slice(0, 10);
  // v1.2: пагинация по 1000 — иначе при накоплении >1000 PENDING-прогнозов
  // (глубокий дефицит, редкие возвраты) часть прогнозоров остаётся навсегда
  // непроверенной и засоряет базу + панель точности.
  const preds = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(
      '/rest/v1/predictions?result=eq.PENDING&is_verified=eq.false&target_date=lt.' + todayStr +
      '&select=id,station_id,fuel_type,from_time,to_time,target_date,expected_restore_at,baseline_restore_at,created_at' +
      '&order=id.asc&limit=1000&offset=' + offset
    );
    for (const p of page) preds.push(p);
    if (page.length < 1000) break;
  }
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
    await logTrainingData();
    console.log('✅ Верификатор завершил работу');
    return;
  }

  const minDay = Math.min(...queue.map(x => x.dayStart));
  const events = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(
      '/rest/v1/events?event_type=eq.fuel_restored&detected_at=gte.' + new Date(minDay - 24 * 3600 * 1000).toISOString() +
      '&select=station_id,fuel_type,detected_at&order=id.asc&limit=1000&offset=' + offset
    );
    for (const e of page) events.push(e);
    if (page.length < 1000) break;
  }

  let checked = 0, success = 0;
  for (const { p, winStart, winEnd, dayStart } of queue) {
    const createdMs = p.created_at ? new Date(p.created_at).getTime() : 0;
    const pairEvents = events
      .filter(e => e.station_id === p.station_id && e.fuel_type === p.fuel_type)
      .map(e => ({ e: e, t: new Date(e.detected_at).getTime() }))
      .filter(x => x.t >= createdMs)
      .sort((a, b) => a.t - b.t);
    const hit = pairEvents.find(x => x.t >= winStart && x.t <= winEnd);
    // v1.2: actual_restore_at = событие внутри окна (если есть),
    // иначе первое событие ПОСЛЕ окна (показывает «на сколько опоздали»).
    // Раньше брали просто первое — при раннем возврате до окна это давало
    // гигантский отрицательный error_minutes и портило медиану.
    const afterWindow = pairEvents.find(x => x.t > winEnd);
    const actual = hit || afterWindow || null;
    let expectedMs;
    if (p.expected_restore_at) expectedMs = new Date(p.expected_restore_at).getTime();
    else expectedMs = dayStart + ((timeToMin(p.from_time) + timeToMin(p.to_time)) / 2) * 60000;
    const patch = {
      result: hit ? 'SUCCESS' : 'MISS',
      is_verified: true,
      verified_at: new Date().toISOString()
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
  await logTrainingData();
  const story = pct === 0
    ? (events.length ? ' Возвраты были, но мимо окон.' : ' Возвратов в период окон не было.')
    : pct >= 50 ? ' Половина окон попала.' : ' Часть окон попала.';
  await tg('🧮 Ночь: ' + checked + ' прогнозов, точных ' + success + ' (' + pct + '%).' + story);
  console.log('✅ Верификатор завершил работу');
}

main().catch(e => { console.error('❌ Ошибка верификатора: ' + e.message); process.exit(1); });