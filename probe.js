// ===== Разведка покрытия GdeBenz (без записи в базу) =====
// Цель: до расширения сбора понять, в каких рамках реально есть данные.
// Запуск: node probe.js (или Actions → probe → Run workflow)

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  'Referer': 'https://gdebenz.ru/'
};

const FRAMES = [
  { name: 'Текущая широкая (Новоросс+Геленджик+Анапа+Крымск)', lat1: 44.40, lon1: 37.20, lat2: 45.20, lon2: 38.60 },
  { name: 'Кубань+Адыгея (Краснодар, Сочи, Майкоп)', lat1: 43.30, lon1: 38.60, lat2: 46.00, lon2: 41.00 },
  { name: 'Ростовская область', lat1: 46.00, lon1: 38.80, lat2: 48.60, lon2: 44.50 },
  { name: 'Ставрополье', lat1: 44.20, lon1: 40.80, lat2: 46.60, lon2: 45.90 },
  { name: 'Крым', lat1: 44.20, lon1: 32.30, lat2: 46.30, lon2: 36.80 },
  { name: 'КОНТРОЛЬ: Москва', lat1: 55.40, lon1: 37.20, lat2: 56.20, lon2: 38.20 },
  { name: 'КОНТРОЛЬ: Новосибирск', lat1: 54.80, lon1: 82.60, lat2: 55.30, lon2: 83.40 }
];

function url(f) {
  return 'https://gdebenz.ru/api/stations?lat1=' + f.lat1 + '&lon1=' + f.lon1 + '&lat2=' + f.lat2 + '&lon2=' + f.lon2;
}

async function fetchFrame(f) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url(f), { headers: BROWSER_HEADERS });
    if (r.ok) return r.json();
    console.log('   ' + f.name + ': попытка ' + attempt + ' статус ' + r.status + ', жду 10с...');
    await new Promise(res => setTimeout(res, 10000));
  }
  throw new Error(f.name + ': не ответил после 3 попыток');
}

async function main() {
  if (process.argv.includes('--dump')) { await dumpKeys(); return; }
  console.log('=== РАЗВЕДКА ПОКРЫТИЯ GdeBenz ===');
  for (const f of FRAMES) {
    const list = await fetchFrame(f);
    const total = list.length;
    let fuels = 0, prices = 0, queue = 0;
    for (const s of list) {
      if (s.fuels_now && String(s.fuels_now).length) fuels++;
      if (s.prices_now && Object.keys(s.prices_now).length) prices++;
      if (s.conflict === 'queue') queue++;
    }
    const pct = total ? Math.round(100 * fuels / total) : 0;
    console.log(f.name + ': станций ' + total +
      ', с топливом ' + fuels + ' (' + pct + '%)' +
      ', с ценами ' + prices +
      ', с очередями ' + queue);
    await new Promise(res => setTimeout(res, 1500)); // вежливо к источнику
  }
  console.log('✅ Разведка завершена');
}

async function dumpKeys() {
  console.log('=== ДАМП КЛЮЧЕЙ ОДНОЙ СТАНЦИИ ===');
  const list = await fetchFrame(FRAMES[0]);
  if (!list.length) { console.log('Станций нет в первой рамке.'); return; }
  const s = list[0];
  console.log('Станция: ' + (s.name || '?') + ' (' + (s.brand || 'без бренда') + ')');
  console.log('Адрес: ' + (s.addr || '—'));
  console.log('Всего ключей: ' + Object.keys(s).length);
  console.log('---');
  for (const k of Object.keys(s)) {
    const v = s[k];
    const type = v === null ? 'null' : Array.isArray(v) ? 'array[' + v.length + ']' : typeof v;
    const preview = JSON.stringify(v).slice(0, 200);
    console.log(k + ' (' + type + '): ' + preview);
  }
  console.log('---');
  console.log('=== АГРЕГАТЫ ПО РАМКЕ (' + list.length + ' станций) ===');
  const stat = {};
  let dtOnly = 0, hasMeta = 0, fuelsEmpty = 0, fuelsFilled = 0, conflictQueue = 0, pricesOld7 = 0, pricesNull = 0;
  for (const x of list) {
    const sv = (x.status === null || x.status === undefined) ? 'null' : String(x.status);
    stat[sv] = (stat[sv] || 0) + 1;
    if (x.dt_only === 1) dtOnly++;
    if (x.meta && x.meta.f && x.meta.f.length) hasMeta++;
    if (x.fuels_now && String(x.fuels_now).length) fuelsFilled++; else fuelsEmpty++;
    if (x.conflict === 'queue') conflictQueue++;
    let pt = null;
    for (const k of Object.keys(x.prices_now || {})) { const t = (x.prices_now[k] || {}).t; if (t && (!pt || t > pt)) pt = t; }
    if (!pt) pricesNull++;
    else if ((Date.now() - new Date(pt.replace(' ', 'T') + '+03:00').getTime()) / 86400000 > 7) pricesOld7++;
  }
  console.log('значения status: ' + JSON.stringify(stat));
  console.log('dt_only=1: ' + dtOnly + ' | meta.f есть: ' + hasMeta + ' | conflict=queue: ' + conflictQueue);
  console.log('fuels_now: заполнен ' + fuelsFilled + ', пустой ' + fuelsEmpty);
  console.log('цены: старше 7 сут ' + pricesOld7 + ', отсутствуют ' + pricesNull);
}

main().catch(e => { console.error('❌ Ошибка разведки: ' + e.message); process.exit(1); });