'use strict';
// Автопатч newsroom.js v4: исправления ошибок статей + RSS/SEO.
// Идемпотентный: уже применённые правки пропускает по probe-строке.
const fs = require('fs');
const EDITS = {
'newsroom.js': [
{ name: 'unesc helper', probe: 'function unesc', start: 'function p2(n)', end: 'function p2(n)', insert:
"function unesc(s) { return String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&amp;/g, '&'); }\n" },
{ name: 'RK_FIX map', probe: 'const RK_FIX', find: "const FILE_REG = { 'svodka.json': 'south', 'svodka-sz.json': 'northwest', 'svodka-ch.json': 'chuvashia' };", replace:
"const FILE_REG = { 'svodka.json': 'south', 'svodka-sz.json': 'northwest', 'svodka-ch.json': 'chuvashia' };\nconst RK_FIX = { south: 'south', nw: 'northwest', ch: 'chuvashia' };" },
{ name: 'winsByReg', probe: 'const winsByReg', start: 'const d = msk(t), day =', end: 'const d = msk(t), day =', insert:
"const winsByReg = {};\nfor (const sv of svodkas) { const rk0 = RK_FIX[sv.region] || sv.region || FILE_REG[sv.file]; winsByReg[rk0] = (sv.totals && sv.totals.wins) || 0; }\n" },
{ name: 'loss wins', probe: 'wins: winsByReg[r] || 0, names: names(E.lostSt', find: 'names: names(E.lostSt, 4), wins: 0', replace: 'names: names(E.lostSt, 4), wins: winsByReg[r] || 0' },
{ name: 'ret wins', probe: 'wins: winsByReg[r] || 0, names: names(E.retSt', find: 'names: names(E.retSt, 4), wins: 0', replace: 'names: names(E.retSt, 4), wins: winsByReg[r] || 0' },
{ name: 'rk normalize', probe: 'const rk = RK_FIX[sv.region]', find: 'const rk = sv.region || FILE_REG[sv.file];', replace: 'const rk = RK_FIX[sv.region] || sv.region || FILE_REG[sv.file];' },
{ name: 'city lost/ret', probe: 'base.lost =', find: 'base.cmp = { ly: (regEvs[rk] || {}).lostY || 0, ry: (regEvs[rk] || {}).retY || 0, lw: (regEvs[rk] || {}).lostW || 0, rw: (regEvs[rk] || {}).retW || 0 };', replace:
"base.cmp = { ly: (regEvs[rk] || {}).lostY || 0, ry: (regEvs[rk] || {}).retY || 0, lw: (regEvs[rk] || {}).lostW || 0, rw: (regEvs[rk] || {}).retW || 0 };\nbase.lost = (regEvs[rk] || {}).lost || 0; base.ret = (regEvs[rk] || {}).ret || 0;" },
{ name: 'acc lost/ret/wins', probe: 'wins: winsByReg.south', find: "brands: brandList('south'), stamp: stamp(t), hhmm: stamp(t).split(', ')[1], wins: 0 });", replace:
"brands: brandList('south'), stamp: stamp(t), hhmm: stamp(t).split(', ')[1], wins: winsByReg.south || 0, lost: (regEvs.south || {}).lost || 0, ret: (regEvs.south || {}).ret || 0 });" },
{ name: 'cmpText v4', probe: 'const isWave =', start: 'function cmpText(c) {', end: 'function brandNote(c)', insert:
"function cmpText(c) {\nconst m = c.cmp || {};\nconst isWave = c.family === 'loss' || c.family === 'ret';\nconst L = isWave ? (c.family === 'ret' ? c.ret : c.lost) : (c.lost || 0);\nconst R = isWave ? (c.family === 'ret' ? c.lost : c.ret) : (c.ret || 0);\nconst ly = m.ly || 0, ry = m.ry || 0, lw = m.lw || 0, rw = m.rw || 0;\nlet s;\nif (isWave) {\ns = 'За текущие сутки ' + c.where + ' отмечено ' + L + ' ' + plural(L, ['событие', 'события', 'событий']) + ' этого типа. ';\ns += 'Сутки назад за такое же окно было ' + (c.family === 'ret' ? ry : ly) + ', а в тот же день недели неделей ранее — ' + (c.family === 'ret' ? rw : lw) + '. ';\n} else {\ns = 'Для контекста: за текущие сутки ' + c.where + ' топливо пропало с ' + L + ' ' + plural(L, ['АЗС', 'АЗС', 'АЗС']) + ' и вернулось на ' + R + '. ';\ns += 'Сутки назад было ' + ly + ' ' + plural(ly, ['исчезновение', 'исчезновения', 'исчезновений']) + ' и ' + ry + ' ' + plural(ry, ['возврат', 'возврата', 'возвратов']) + ', неделей ранее — ' + lw + ' и ' + rw + '. ';\n}\nconst yBase = isWave ? (c.family === 'ret' ? ry : ly) : ly;\nconst wBase = isWave ? (c.family === 'ret' ? rw : lw) : lw;\nconst day = yBase ? (L > yBase * 1.25 ? 'up' : L < yBase * 0.75 ? 'down' : 'flat') : 'nodata';\nconst week = wBase ? (L > wBase * 1.25 ? 'up' : L < wBase * 0.75 ? 'down' : 'flat') : 'nodata';\nif (day === 'up' && week !== 'down') s += w(['Динамика растущая: волна набирает силу.', 'То есть картина ухудшается быстрее, чем вчера.']);\nelse if (day === 'down' && week !== 'up') s += w(['Динамика спадающая: пик, похоже, позади.', 'Вчерашний день был тяжелее — есть повод для осторожного оптимизма.']);\nelse if (day === 'flat' && week === 'down') s += 'К вчерашнему дню картина ровная, но неделей ранее событий было заметно больше: относительно прошлой недели ситуация спокойнее.';\nelse if (day === 'flat' && week === 'up') s += 'К вчерашнему дню картина ровная, но неделей ранее событий было меньше: относительно прошлой недели напряжение выросло.';\nelse if (day === 'nodata' && week === 'nodata') s += 'Истории для сравнения пока мало: цифры появятся, когда накопятся события за прошлые сутки и неделю.';\nelse s += w(['Показатели держатся примерно на уровне вчерашнего дня: это плато, а не скачок.', 'Разница с сутками и неделей назад невелика: ситуация стабильно напряжённая, без резких движений.']);\nreturn s;\n}\n" },
{ name: 'attr decapitalize', probe: 'const at = i === 0', find: "whatParas.forEach((p, i) => { body += '<p>' + esc(i === 0 ? attrOnce(a) + p : p) + '</p>'; });", replace:
"whatParas.forEach((p, i) => { const at = i === 0 ? attrOnce(a) : ''; body += '<p>' + esc(at ? at + p.charAt(0).toLowerCase() + p.slice(1) : p) + '</p>'; });" },
{ name: 'deficit lead queues 1', probe: "это лотерея' + (c.q", find: "lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Езда наугад при такой картине — это лотерея с очередями в придачу.',", replace:
"lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Езда наугад при такой картине — это лотерея' + (c.q ? ' с очередями в придачу' : '') + '.',"},
{ name: 'deficit lead queues 2', probe: 'спрос и маршруты стягиваются', find: "lead: 'Когда с топливом остаётся ' + c.a95 + ' ' + plural(c.a95, ['заправка', 'заправки', 'заправок']) + ' из ' + c.known + ', город перестраивается: спрос, очереди и маршруты стягиваются к этим адресам.',", replace:
"lead: 'Когда с топливом остаётся ' + c.a95 + ' ' + plural(c.a95, ['заправка', 'заправки', 'заправок']) + ' из ' + c.known + ', город перестраивается: спрос и маршруты стягиваются к этим адресам' + (c.q ? ', а вместе с ними и очереди' : '') + '.',"},
{ name: 'city links anchor', probe: "'#c-' + f.slug", find: "else if (f.family === 'deficit' || f.family === 'queue') a.links = [[SITE + '/svodka-' + f.slug.replace(/^(deficit|ocheredi)-/, '').replace(/-\\d{8}$/, '') + '.html', 'Сводка по городу'], [SITE + '/', 'Живая карта']];", replace:
"else if (f.family === 'deficit' || f.family === 'queue') a.links = [[SITE + '/' + (REG[f.rk] ? REG[f.rk].file : 'svodka.html') + '#c-' + f.slug.replace(/^(deficit|ocheredi)-/, '').replace(/-\\d{8}$/, ''), 'Сводка по городу'], [SITE + '/', 'Живая карта']];"},
{ name: 'index title unesc', probe: 'title = unesc(', find: "if (m) title = m[1].replace(/<[^>]+>/g, '').trim();", replace: "if (m) title = unesc(m[1].replace(/<[^>]+>/g, '').trim());" },
{ name: 'rss v4', probe: 'xmlns:atom', start: 'const rssItems = items.concat', end: 'const nowT = Date.now();', insert:
"const rssItems = all.map(slug => ({ slug, t: new Date(manifest[slug]).getTime() }))\n.sort((a, b) => b.t - a.t).slice(0, 50).map(a => {\nlet title = a.slug, lead = '';\ntry {\nconst h = fs.readFileSync(path.join(newsDir, a.slug + '.html'), 'utf8');\nconst m1 = h.match(/<h1>([\\s\\S]*?)<\\/h1>/), m2 = h.match(/class=\"lead\">([\\s\\S]*?)<\\/p>/);\nif (m1) title = unesc(m1[1].replace(/<[^>]+>/g, '').trim());\nif (m2) lead = unesc(m2[1].replace(/<[^>]+>/g, '').trim());\n} catch (e) {}\nreturn '<item><title>' + esc(title) + '</title><link>' + SITE + '/news/' + a.slug + '.html</link>' +\n'<guid isPermaLink=\"true\">' + SITE + '/news/' + a.slug + '.html</guid>' +\n'<pubDate>' + new Date(a.t).toUTCString() + '</pubDate>' +\n'<description>' + esc(lead) + '</description></item>';\n}).join('\\n');\nfs.writeFileSync(path.join(newsDir, 'rss.xml'), '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\">\\n<channel>\\n' +\n'<title>КогдаБенз — новости топлива</title><link>' + SITE + '/news/</link>\\n' +\n'<atom:link href=\"' + SITE + '/news/rss.xml\" rel=\"self\" type=\"application/rss+xml\"/>\\n' +\n'<description>Волны дефицита, возвраты топлива, очереди и точность прогнозов привоза по данным живой карты.</description>\\n' +\n'<language>ru</language><category>Топливо и цены</category><ttl>60</ttl>\\n' +\n'<image><url>' + SITE + '/icon-512.png</url><title>КогдаБенз — новости топлива</title><link>' + SITE + '/news/</link></image>\\n' +\n'<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\\n' + rssItems + '\\n</channel></rss>');\n" },
{ name: 'sitemap-news real titles', probe: 'let nt =', start: 'const newsUrls = all.filter', end: "fs.writeFileSync(path.join(dir, 'sitemap-news.xml'),", insert:
"const newsUrls = all.filter(s => nowT - new Date(manifest[s]).getTime() < 48 * H).map(s => {\nlet nt = 'КогдаБенз: выпуск данных';\ntry { const h = fs.readFileSync(path.join(newsDir, s + '.html'), 'utf8'); const m = h.match(/<h1>([\\s\\S]*?)<\\/h1>/); if (m) nt = unesc(m[1].replace(/<[^>]+>/g, '').trim()); } catch (e) {}\nreturn '<url><loc>' + SITE + '/news/' + s + '.html</loc><news:news><news:publication><news:name>КогдаБенз</news:name><news:language>ru</news:language></news:publication><news:publication_date>' + manifest[s] + '</news:publication_date><news:title>' + esc(nt) + '</news:title></news:news></url>';\n}).join('\\n');\n" },
{ name: 'robots sitemaps', probe: 'for (const u of [SITE', find: "fs.writeFileSync(path.join(newsDir, 'manifest.json'), JSON.stringify(manifest, null, 1));", replace:
"try {\nconst rp = path.join(dir, 'robots.txt');\nlet rb = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : 'User-agent: *\\nAllow: /\\n';\nfor (const u of [SITE + '/sitemap.xml', SITE + '/sitemap-news.xml', SITE + '/news/rss.xml']) {\nconst line = 'Sitemap: ' + u;\nif (rb.indexOf(line) < 0) rb = rb.replace(/\\s+$/, '') + '\\n' + line + '\\n';\n}\nfs.writeFileSync(rp, rb);\n} catch (e) {}\nfs.writeFileSync(path.join(newsDir, 'manifest.json'), JSON.stringify(manifest, null, 1));" }
],
'index.html': [
{ name: 'rss autodiscovery', probe: 'href="/news/rss.xml"', find: '<link rel="manifest" href="manifest.json">', replace:
'<link rel="manifest" href="manifest.json">\n<link rel="alternate" type="application/rss+xml" title="КогдаБенз — новости топлива" href="/news/rss.xml">' }
],
'sw.js': [
{ name: 'cache bump', probe: 'kogdabenz-v235', find: "const CACHE_VERSION = 'kogdabenz-v234';", replace: "const CACHE_VERSION = 'kogdabenz-v235';" }
]
};
const missing = [];
for (const f of Object.keys(EDITS)) {
let src;
try { src = fs.readFileSync(f, 'utf8'); } catch (e) { missing.push(f + ': файл не найден'); continue; }
for (const p of EDITS[f]) {
if (p.probe && src.indexOf(p.probe) >= 0) { console.log('skip (уже применено): ' + p.name); continue; }
if (p.start) {
const i = src.indexOf(p.start);
const j = src.indexOf(p.end, i + p.start.length);
if (i < 0 || j < 0) { missing.push(f + ': не найден блок «' + p.start + '»'); continue; }
src = src.slice(0, i) + p.insert + src.slice(j);
} else {
const n = src.split(p.find).length - 1;
if (n !== 1) { missing.push(f + ': совпадений ' + n + ' для «' + p.find.slice(0, 60) + '»'); continue; }
src = src.replace(p.find, p.replace);
}
console.log('ok: ' + p.name);
}
fs.writeFileSync(f, src);
}
if (missing.length) { console.log('! НЕ ПРИМЕНЕНО:\n' + missing.join('\n')); process.exit(1); }
console.log('newsroom-patch: все правки применены');