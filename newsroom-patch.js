'use strict';
// Автопатч newsroom.js v5.
// 0) снимает дубль старого run() (v3), если он остался ниже нового (v4);
// 1) точечные исправления детектора/текстов/ссылок/robots;
// 2) шаги, уже закрытые ньюсрумом v4, пропускаются без ошибки;
// 3) bump кэша sw.js только вместе с правкой index.html.
const fs = require('fs');

const RUN = '(async function run() {';
const END = "})().catch(e => { console.log('! newsroom: ' + e.message); process.exit(1); });";

function dedup() {
  let src;
  try { src = fs.readFileSync('newsroom.js', 'utf8'); } catch (e) { return; }
  const i1 = src.indexOf(RUN);
  const i2 = src.indexOf(RUN, i1 + 1);
  if (i1 < 0 || i2 < 0) { console.log('skip: dedup (run один)'); return; }
  const e1 = src.indexOf(END, i1);
  if (e1 < 0 || e1 > i2) { console.log('! dedup: не нашёл конец первого run — не трогаю'); return; }
  const b1 = src.slice(i1, e1 + END.length);
  const b2 = src.slice(i2);
  let out;
  if (b2.indexOf('heroScore') >= 0 && b1.indexOf('heroScore') < 0) out = src.slice(0, i1) + b2;
  else if (b1.indexOf('heroScore') >= 0 && b2.indexOf('heroScore') < 0) out = src.slice(0, i2);
  else { console.log('! dedup: не понял, какой run новый — не трогаю'); return; }
  fs.writeFileSync('newsroom.js', out);
  console.log('ok: dedup — удалён старый дубль run()');
}
dedup();

const EDITS = {
'newsroom.js': [
{ name: 'unesc helper', probe: 'function unesc', before: 'function p2(n)', insert:
"function unesc(s) { return String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&amp;/g, '&'); }\n" },
{ name: 'RK_FIX map', probe: 'const RK_FIX', find: "const FILE_REG = { 'svodka.json': 'south', 'svodka-sz.json': 'northwest', 'svodka-ch.json': 'chuvashia' };", replace:
"const FILE_REG = { 'svodka.json': 'south', 'svodka-sz.json': 'northwest', 'svodka-ch.json': 'chuvashia' };\nconst RK_FIX = { south: 'south', nw: 'northwest', ch: 'chuvashia' };" },
{ name: 'winsByReg', probe: 'const winsByReg', before: 'const d = msk(t), day =', insert:
"const winsByReg = {};\nfor (const sv of svodkas) { const rk0 = RK_FIX[sv.region] || sv.region || FILE_REG[sv.file]; winsByReg[rk0] = (sv.totals && sv.totals.wins) || 0; }\n" },
{ name: 'loss wins', probe: 'wins: winsByReg[r] || 0, names: names(E.lostSt', find: 'names: names(E.lostSt, 4), wins: 0', replace: 'names: names(E.lostSt, 4), wins: winsByReg[r] || 0' },
{ name: 'ret wins', probe: 'wins: winsByReg[r] || 0, names: names(E.retSt', find: 'names: names(E.retSt, 4), wins: 0', replace: 'names: names(E.retSt, 4), wins: winsByReg[r] || 0' },
{ name: 'rk normalize', probe: 'const rk = RK_FIX[sv.region]', find: 'const rk = sv.region || FILE_REG[sv.file];', replace: 'const rk = RK_FIX[sv.region] || sv.region || FILE_REG[sv.file];' },
{ name: 'city lost/ret', probe: 'base.lost =', find: 'base.cmp = { ly: (regEvs[rk] || {}).lostY || 0, ry: (regEvs[rk] || {}).retY || 0, lw: (regEvs[rk] || {}).lostW || 0, rw: (regEvs[rk] || {}).retW || 0 };', replace:
"base.cmp = { ly: (regEvs[rk] || {}).lostY || 0, ry: (regEvs[rk] || {}).retY || 0, lw: (regEvs[rk] || {}).lostW || 0, rw: (regEvs[rk] || {}).retW || 0 };\nbase.lost = (regEvs[rk] || {}).lost || 0; base.ret = (regEvs[rk] || {}).ret || 0;" },
{ name: 'acc lost/ret/wins', probe: 'wins: winsByReg.south', find: "brands: brandList('south'), stamp: stamp(t), hhmm: stamp(t).split(', ')[1], wins: 0 });", replace:
"brands: brandList('south'), stamp: stamp(t), hhmm: stamp(t).split(', ')[1], wins: winsByReg.south || 0, lost: (regEvs.south || {}).lost || 0, ret: (regEvs.south || {}).ret || 0 });" },
{ name: 'cmpText v4', probe: 'const isWave =', start: 'function cmpText(c) {', end: 'function brandNote(c)', insert:
`function cmpText(c) {
const m = c.cmp || {};
const isWave = c.family === 'loss' || c.family === 'ret';
const L = isWave ? (c.family === 'ret' ? c.ret : c.lost) : (c.lost || 0);
const R = isWave ? (c.family === 'ret' ? c.lost : c.ret) : (c.ret || 0);
const ly = m.ly || 0, ry = m.ry || 0, lw = m.lw || 0, rw = m.rw || 0;
let s;
if (isWave) {
s = 'За текущие сутки ' + c.where + ' отмечено ' + L + ' ' + plural(L, ['событие', 'события', 'событий']) + ' этого типа. ';
s += 'Сутки назад за такое же окно было ' + (c.family === 'ret' ? ry : ly) + ', а в тот же день недели неделей ранее — ' + (c.family === 'ret' ? rw : lw) + '. ';
} else {
s = 'Для контекста: за текущие сутки ' + c.where + ' топливо пропало с ' + L + ' ' + plural(L, ['АЗС', 'АЗС', 'АЗС']) + ' и вернулось на ' + R + '. ';
s += 'Сутки назад было ' + ly + ' ' + plural(ly, ['исчезновение', 'исчезновения', 'исчезновений']) + ' и ' + ry + ' ' + plural(ry, ['возврат', 'возврата', 'возвратов']) + ', неделей ранее — ' + lw + ' и ' + rw + '. ';
}
const yBase = isWave ? (c.family === 'ret' ? ry : ly) : ly;
const wBase = isWave ? (c.family === 'ret' ? rw : lw) : lw;
const day = yBase ? (L > yBase * 1.25 ? 'up' : L < yBase * 0.75 ? 'down' : 'flat') : 'nodata';
const week = wBase ? (L > wBase * 1.25 ? 'up' : L < wBase * 0.75 ? 'down' : 'flat') : 'nodata';
if (day === 'up' && week !== 'down') s += w(['Динамика растущая: волна набирает силу.', 'То есть картина ухудшается быстрее, чем вчера.']);
else if (day === 'down' && week !== 'up') s += w(['Динамика спадающая: пик, похоже, позади.', 'Вчерашний день был тяжелее — есть повод для осторожного оптимизма.']);
else if (day === 'flat' && week === 'down') s += 'К вчерашнему дню картина ровная, но неделей ранее событий было заметно больше: относительно прошлой недели ситуация спокойнее.';
else if (day === 'flat' && week === 'up') s += 'К вчерашнему дню картина ровная, но неделей ранее событий было меньше: относительно прошлой недели напряжение выросло.';
else if (day === 'nodata' && week === 'nodata') s += 'Истории для сравнения пока мало: цифры появятся, когда накопятся события за прошлые сутки и неделю.';
else s += w(['Показатели держатся примерно на уровне вчерашнего дня: это плато, а не скачок.', 'Разница с сутками и неделей назад невелика: ситуация стабильно напряжённая, без резких движений.']);
return s;
}
` },
{ name: 'attr decapitalize', probe: 'const at = i === 0', find: "whatParas.forEach((p, i) => { body += '<p>' + esc(i === 0 ? attrOnce(a) + p : p) + '</p>'; });", replace:
"whatParas.forEach((p, i) => { const at = i === 0 ? attrOnce(a) : ''; body += '<p>' + esc(at ? at + p.charAt(0).toLowerCase() + p.slice(1) : p) + '</p>'; });" },
{ name: 'deficit lead queues 1', probe: "это лотерея' + (c.q", find: "lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Езда наугад при такой картине — это лотерея с очередями в придачу.',", replace:
"lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Езда наугад при такой картине — это лотерея' + (c.q ? ' с очередями в придачу' : '') + '.',"},
{ name: 'deficit lead queues 2', probe: 'спрос и маршруты стягиваются', find: "lead: 'Когда с топливом остаётся ' + c.a95 + ' ' + plural(c.a95, ['заправка', 'заправки', 'заправок']) + ' из ' + c.known + ', город перестраивается: спрос, очереди и маршруты стягиваются к этим адресам.',", replace:
"lead: 'Когда с топливом остаётся ' + c.a95 + ' ' + plural(c.a95, ['заправка', 'заправки', 'заправок']) + ' из ' + c.known + ', город перестраивается: спрос и маршруты стягиваются к этим адресам' + (c.q ? ', а вместе с ними и очереди' : '') + '.',"},
{ name: 'city links anchor', probe: "'#c-' + f.slug", find: "else if (f.family === 'deficit' || f.family === 'queue') a.links = [[SITE + '/svodka-' + f.slug.replace(/^(deficit|ocheredi)-/, '').replace(/-\\d{8}$/, '') + '.html', 'Сводка по городу'], [SITE + '/', 'Живая карта']];", replace:
"else if (f.family === 'deficit' || f.family === 'queue') a.links = [[SITE + '/' + (REG[f.rk] ? REG[f.rk].file : 'svodka.html') + '#c-' + f.slug.replace(/^(deficit|ocheredi)-/, '').replace(/-\\d{8}$/, ''), 'Сводка по городу'], [SITE + '/', 'Живая карта']];" },
{ name: 'rss atom self-link', probe: 'xmlns:atom', find: `<rss version="2.0"><channel>\\n' +`, replace:
`<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>\\n' +
' <atom:link href="' + SITE + '/news/rss.xml" rel="self" type="application/rss+xml"/>\\n' +` },
{ name: 'robots sitemaps', probe: 'for (const u of [SITE', find: `fs.writeFileSync(path.join(newsDir, 'manifest.json'), JSON.stringify(manifest, null, 1));`, replace:
`try {
const rp = path.join(dir, 'robots.txt');
let rb = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : 'User-agent: *\\nAllow: /\\n';
for (const u of [SITE + '/sitemap.xml', SITE + '/sitemap-news.xml', SITE + '/news/rss.xml']) {
const line = 'Sitemap: ' + u;
if (rb.indexOf(line) < 0) rb = rb.replace(/\\s+$/, '') + '\\n' + line + '\\n';
}
fs.writeFileSync(rp, rb);
} catch (e) {}
fs.writeFileSync(path.join(newsDir, 'manifest.json'), JSON.stringify(manifest, null, 1));` }
],
'index.html': [
{ name: 'rss autodiscovery', probe: 'href="/news/rss.xml"', find: '<link rel="manifest" href="manifest.json">', replace:
'<link rel="manifest" href="manifest.json">\n<link rel="alternate" type="application/rss+xml" title="КогдаБенз — новости топлива" href="/news/rss.xml">' }
]
};

// bump кэша нужен только если index.html реально меняется в этом прогоне
let needBump = false;
try { needBump = fs.readFileSync('index.html', 'utf8').indexOf('href="/news/rss.xml"') < 0; } catch (e) {}

const missing = [];
for (const f of Object.keys(EDITS)) {
let src;
try { src = fs.readFileSync(f, 'utf8'); } catch (e) { missing.push(f + ': файл не найден'); continue; }
let changed = false;
for (const p of EDITS[f]) {
if (p.probe && src.indexOf(p.probe) >= 0) { console.log('skip (уже применено): ' + p.name); continue; }
if (p.before) {
const i = src.indexOf(p.before);
if (i < 0) { console.log('skip (нет якоря — уже v4): ' + p.name); continue; }
src = src.slice(0, i) + p.insert + src.slice(i);
} else if (p.start) {
const i = src.indexOf(p.start);
const j = i < 0 ? -1 : src.indexOf(p.end, i + p.start.length);
if (i < 0 || j < 0) { console.log('skip (блок уже v4): ' + p.name); continue; }
src = src.slice(0, i) + p.insert + src.slice(j);
} else {
const n = src.split(p.find).length - 1;
if (n === 0) { console.log('skip (цель уже v4): ' + p.name); continue; }
if (n > 1) { missing.push(f + ': совпадений ' + n + ' для «' + p.find.slice(0, 60) + '»'); continue; }
src = src.replace(p.find, p.replace);
}
changed = true;
console.log('ok: ' + p.name);
}
if (changed) fs.writeFileSync(f, src);
}

// sw.js: поднимаем CACHE_VERSION регуляркой (любой vN -> vN+1), только вместе с правкой index
try {
let sw = fs.readFileSync('sw.js', 'utf8');
if (!needBump) console.log('skip: cache bump (index.html уже с RSS-ссылкой)');
else {
const m = sw.match(/const CACHE_VERSION = 'kogdabenz-v(\d+)';/);
if (m) {
const next = Number(m[1]) + 1;
sw = sw.replace(m[0], "const CACHE_VERSION = 'kogdabenz-v" + next + "';");
fs.writeFileSync('sw.js', sw);
console.log('ok: cache bump v' + m[1] + ' -> v' + next);
} else {
console.log('! ВНИМАНИЕ: не нашёл строку CACHE_VERSION в sw.js. Подними версию кэша вручную (правило проекта).');
}
}
} catch (e) { console.log('! sw.js не прочитан: ' + e.message); }

if (missing.length) { console.log('! НЕ ПРИМЕНЕНО:\n' + missing.join('\n')); process.exit(1); }
console.log('newsroom-patch: готово');