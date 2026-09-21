// ===== Калибратор уверенности v1 =====
// Запускается ночью сразу после верификатора (02:25 MSK).
// Сравнивает сырую уверенность предиктора с тем, сколько прогнозов реально
// попало в окно, и пишет таблицу пересчёта в bot_meta (ключ calibration_table).
// Утром предиктор читает таблицу и показывает людям откалиброванную уверенность.
// Правила проекта: измерение раньше усложнения и фолбэк на малых данных —
// проверенных строк меньше MIN_ROWS — таблицы нет, предиктор работает по-старому.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MIN_ROWS = 30;      // порог старта калибровки (снижен со 100 по решению владельца)
const MIN_PER_BIN = 5;    // минимум проверенных прогнозов в одном бине
const MAX_BINS = 8;       // не мельчим: бинов не больше восьми

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

async function main() {
  console.log('=== КАЛИБРАТОР v1 ===');
  // ВСЕ верифицированные прогнозы: окно закрылось, исход известен.
  // Топливо не вернулось к моменту проверки = честный MISS (водитель его не получил);
  // выбросить их = ошибка выжившего и завышенная уверенность
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(
      '/rest/v1/predictions?is_verified=eq.true' +
      '&select=confidence,result,features&order=id.asc&limit=1000&offset=' + offset
    );
    for (const p of page) rows.push(p);
    if (page.length < 1000) break;
  }
  console.log('Проверенных прогнозов (закрытые окна): ' + rows.length);
  const data = rows.map(p => {
    const f = p.features || {};
    // v1.8+ берём сырую уверенность из features.conf_raw; старые строки — из confidence
    const raw = (f.conf_raw === null || f.conf_raw === undefined) ? Number(p.confidence) : Number(f.conf_raw);
    return { raw: raw, hit: p.result === 'SUCCESS' };
  }).filter(x => isFinite(x.raw) && x.raw > 0);
  if (data.length < MIN_ROWS) {
    console.log('Мало данных для калибровки (' + data.length + ' < ' + MIN_ROWS + ').');
    console.log('Таблицу не строим: предиктор продолжает показывать сырую уверенность.');
    return;
  }
  data.sort((a, b) => a.raw - b.raw);
  // грубые квантильные бины: на малых данных важнее плотность, чем детальность
  const binSize = Math.max(MIN_PER_BIN, Math.ceil(data.length / MAX_BINS));
  const bins = [];
  for (let i = 0; i < data.length; i += binSize) {
    const g = data.slice(i, i + binSize);
    bins.push({
      c: g.reduce((s, x) => s + x.raw, 0) / g.length,
      p: g.filter(x => x.hit).length / g.length,
      n: g.length
    });
  }
  // изотония (PAVA): откалиброванная вероятность не может падать при росте сырой;
  // соседние бины-нарушители сливаем в один
  const iso = [];
  for (const b of bins) {
    iso.push({ c: b.c, p: b.p, n: b.n });
    while (iso.length >= 2 && iso[iso.length - 2].p > iso[iso.length - 1].p) {
      const a = iso.pop(), prev = iso.pop();
      const n = prev.n + a.n;
      iso.push({ c: (prev.c * prev.n + a.c * a.n) / n, p: (prev.p * prev.n + a.p * a.n) / n, n: n });
    }
  }
  for (const b of iso) {
    console.log('   сырая ' + b.c.toFixed(2) + ' → факт ' + Math.round(b.p * 100) + '% (n ' + b.n + ')');
  }
  const table = {
    v: 1,
    built_at: new Date().toISOString(),
    n: data.length,
    points: iso.map(b => [Math.round(b.c * 1000) / 1000, Math.round(b.p * 1000) / 1000])
  };
  // value храним строкой JSON: переживёт и jsonb, и text в bot_meta
  await sbUpsertMeta('calibration_table', JSON.stringify(table));
  console.log('✅ Таблица калибровки записана в bot_meta (бинов: ' + iso.length + ', строк: ' + data.length + ')');
}
main().catch(e => { console.error('❌ Ошибка калибратора: ' + e.message); process.exit(1); });