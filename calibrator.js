// ===== Калибратор уверенности v3 =====
// Ночью после верификатора (02:25 MSK).
// Отличия v2 от v1:
//   1) Свежесть: только верифицированные строки за 14 дней (если их мало — 30).
//      Таблица следует за режимом города, а не тащит всю историю.
//   2) Ворота успеха: таблица строится только при >= 10 SUCCESS в выборке.
//      Пока возвратов около нуля, калибровать нечего — калибратор САМ удаляет
//      старую таблицу из bot_meta, предиктор автоматически на сырой уверенности.
//   3) Бины от 5 строк (максимум 8), изотония PAVA, value — строка JSON.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MIN_ROWS = 30;
const MIN_SUCCESS = 10;
const FRESH_DAYS = 14;
const FRESH_DAYS_WIDE = 30;
const MIN_PER_BIN = 5;
const MAX_BINS = 8;
const MIN_SPREAD = 0.15; // минимальный разброс бинов, иначе таблица не отличает станцию от станции

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status + ' ' + await r.text());
  return r.json();
}
async function sbUpsertMeta(key, value) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/bot_meta?on_conflict=key', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates'
    },
    body: JSON.stringify([{ key: key, value: value, updated_at: new Date().toISOString() }])
  });
  if (!r.ok) throw new Error('UPSERT bot_meta → ' + r.status + ' ' + await r.text());
}
async function sbDeleteMeta(key) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/bot_meta?key=eq.' + key, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Prefer: 'return=minimal' }
  });
  if (!r.ok) throw new Error('DELETE bot_meta → ' + r.status + ' ' + await r.text());
}
async function fetchVerified() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(
      '/rest/v1/predictions?is_verified=eq.true' +
      '&select=confidence,result,features,verified_at&order=id.asc&limit=1000&offset=' + offset
    );
    for (const p of page) rows.push(p);
    if (page.length < 1000) break;
  }
  return rows;
}
function toData(rows, days) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  return rows.map(p => {
    const f = p.features || {};
const v = (f.v === null || f.v === undefined) ? 0 : Number(f.v);
const raw = (v < 1 || f.conf_raw === null || f.conf_raw === undefined) 
  ? Number(p.confidence)   // старый прогноз — берём что есть
  : Number(f.conf_raw);
    return { raw: raw, hit: p.result === 'SUCCESS', at: p.verified_at ? new Date(p.verified_at).getTime() : 0 };
  }).filter(x => isFinite(x.raw) && x.raw > 0 && x.at >= since);
}

async function main() {
  console.log('=== КАЛИБРАТОР v3 ===');
  const rows = await fetchVerified();
  console.log('Верифицированных прогнозов всего: ' + rows.length);
  let data = toData(rows, FRESH_DAYS);
  let windowDays = FRESH_DAYS;
  if (data.length < MIN_ROWS) { data = toData(rows, FRESH_DAYS_WIDE); windowDays = FRESH_DAYS_WIDE; }
  const successes = data.filter(x => x.hit).length;
  console.log('Окно ' + windowDays + ' дн: строк ' + data.length + ', попаданий ' + successes);
  if (data.length < MIN_ROWS) {
    await sbDeleteMeta('calibration_table');
    console.log('Мало строк (' + data.length + ' < ' + MIN_ROWS + '): таблица удалена (если была), предиктор на сырой уверенности.');
    return;
  }
  if (successes < MIN_SUCCESS) {
    await sbDeleteMeta('calibration_table');
    console.log('Мало попаданий (' + successes + ' < ' + MIN_SUCCESS + '): в текущем режиме калибровать нечего.');
    console.log('Таблица удалена (если была), предиктор на сырой уверенности. Включится само при накоплении попаданий.');
    return;
  }
  data.sort((a, b) => a.raw - b.raw);
  const binSize = Math.max(MIN_PER_BIN, Math.ceil(data.length / MAX_BINS));
  const bins = [];
  for (let i = 0; i < data.length; i += binSize) {
    const g = data.slice(i, i + binSize);
    bins.push({ c: g.reduce((s, x) => s + x.raw, 0) / g.length, p: g.filter(x => x.hit).length / g.length, n: g.length });
  }
  const iso = [];
  for (const b of bins) {
    iso.push({ c: b.c, p: b.p, n: b.n });
    while (iso.length >= 2 && iso[iso.length - 2].p > iso[iso.length - 1].p) {
      const a = iso.pop(), prev = iso.pop();
      const n = prev.n + a.n;
      iso.push({ c: (prev.c * prev.n + a.c * a.n) / n, p: (prev.p * prev.n + a.p * a.n) / n, n: n });
    }
  }
  for (const b of iso) console.log('   сырая ' + b.c.toFixed(2) + ' → факт ' + Math.round(b.p * 100) + '% (n ' + b.n + ')');
  // Ворота 3: различимость. Плоская таблица (дефицит: все бины 0-3%) не отличает
  // станцию от станции - на экран такое не годится, только в лог как измерение.
  const ps = iso.map(b => b.p);
  const spread = Math.max(...ps) - Math.min(...ps);
  if (spread < MIN_SPREAD) {
    await sbDeleteMeta('calibration_table');
    console.log('Таблица плоская (разброс ' + Math.round(spread * 100) + '% < ' + Math.round(MIN_SPREAD * 100) + '%): на экран не годится.');
    console.log('Таблица удалена (если была), предиктор на сырой уверенности. Бины остаются в логе как измерение.');
    return;
  }
  const table = {
    v: 2,
    built_at: new Date().toISOString(),
    window_days: windowDays,
    n: data.length,
    successes: successes,
    points: iso.map(b => [Math.round(b.c * 1000) / 1000, Math.round(b.p * 1000) / 1000])
  };
  await sbUpsertMeta('calibration_table', JSON.stringify(table));
  console.log('✅ Таблица калибровки записана (бинов: ' + iso.length + ', строк: ' + data.length + ', попаданий: ' + successes + ', окно: ' + windowDays + ' дн)');
}
main().catch(e => { console.error('❌ Ошибка калибратора: ' + e.message); process.exit(1); });