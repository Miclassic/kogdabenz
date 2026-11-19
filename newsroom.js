'use strict';
// ============================================================
// КогдаБенз · НЬЮСРУМ v1
// Сам находит в данных новостной повод и пишет из него статью:
// заголовок с цифрами, лид, 2–4 абзаца текста, методика, ссылки.
// Статьи ложатся в /news/, плюс RSS и news-sitemap — это то,
// что читают Яндекс Новости и Google News. Публикует только
// НОВЫЕ факты (манифест), не чаще одного раза в сутки на повод.
//   node newsroom.js [--no-git]
// ============================================================
const fs = require('fs');
const path = require('path');
const SITE = 'https://kogdabenz.ru';
const NO_GIT = process.argv.includes('--no-git');
const SUP = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const H = 3600000;

// пороги новостности (ниже — шум, не новость)
const TH = { lossSouth: 12, lossOther: 6, retSouth: 10, retOther: 5, queueCity: 3, accMin: 15 };

const REG = {
south: { label: 'Юг', where: 'на юге', file: 'svodka.html' },
northwest: { label: 'Северо-Запад', where: 'на Северо-Западе', file: 'svodka-sz.html' },
chuvashia: { label: 'Чувашия', where: 'в Чувашии', file: 'svodka-ch.html' }
};
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function p2(n) { return String(n).padStart(2, '0'); }
function msk(t) { return new Date(t + 3 * H); }
function stamp(t) { const d = msk(t); return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ', ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
function dateRu(t) { const d = msk(t); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
function plural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }
function t5(v) { return String(v || '').slice(0, 5); }
function fuelName(f) { return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : 'топливо'; }
async function sbGet(p) {
const r = await fetch(SUP + '/rest/v1/' + p, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
if (!r.ok) throw new Error('GET ' + p + ' → ' + r.status);
return r.json();
}
function findDir() {
const cands = [process.env.KB_SITE_DIR, process.env.SVODKA_DIR, process.cwd(), __dirname].filter(Boolean);
for (const d of cands) { try { if (fs.existsSync(path.join(d, 'index.html'))) return d; } catch (e) {} }
for (const root of ['/root', '/home', '/var/www', '/opt']) {
let subs = []; try { subs = fs.readdirSync(root); } catch (e) { continue; }
for (const s of subs) { const d = path.join(root, s); try { if (fs.existsSync(path.join(d, 'index.html'))) return d; } catch (e) {} }
}
return null;
}

// ---------- данные ----------
async function load() {
const stations = await sbGet('stations?select=id,name,brand,address,lat,lon,region&limit=2000');
const since24 = new Date(Date.now() - 24 * H).toISOString();
const evs = await sbGet('events?event_type=in.(fuel_disappeared,fuel_restored)&detected_at=gte.' + since24 + '&select=station_id,event_type,fuel_type,detected_at&limit=3000');
const ver = await sbGet('predictions?is_verified=eq.true&verified_at=gte.' + new Date(Date.now() - 30 * 24 * H).toISOString() + '&select=result,verified_at&limit=1000');
return { stations, evs, ver };
}
function readSvodkas(dir) {
const out = [];
for (const f of ['svodka.json', 'svodka-sz.json', 'svodka-ch.json']) {
try {
const p = path.join(dir, f);
if (!fs.existsSync(p)) continue;
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
out.push({ file: f, region: j.region, totals: j.totals, cities: j.cities || [] });
} catch (e) {}
}
return out;
}

// ---------- статьи ----------
const CSS = `
*{box-sizing:border-box}html{background:#0a1024;scrollbar-color:#3f74d6 rgba(148,180,255,.1)}
body{margin:0;background:linear-gradient(180deg,#0d1526,#0a1024 60%,#080d1c);color:#e8eefb;
font:17px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:#7db4ff}::selection{background:#2465ee;color:#fff}
.wrap{max-width:700px;margin:0 auto;padding:22px 18px 60px}
.top{display:flex;align-items:center;gap:10px;padding:14px 0 18px;border-bottom:1px solid rgba(148,180,255,.16);margin-bottom:26px}
.top .tile{width:34px;height:34px;border-radius:11px;background:linear-gradient(140deg,#4b93ff,#1746c8);display:grid;place-items:center;flex:none}
.top .tile svg{width:17px;height:17px;fill:#fff}
.top b{font-size:15px;letter-spacing:-.2px}.top small{display:block;font-size:9.5px;font-weight:800;letter-spacing:.14em;color:#6b7a96;text-transform:uppercase}
.top nav{margin-left:auto;display:flex;gap:14px;font-size:12.5px;font-weight:700}
.kicker{display:inline-block;font-size:10.5px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#2fd39a;margin:0 0 10px}
h1{margin:0 0 12px;font-size:clamp(24px,5.6vw,36px);line-height:1.15;font-weight:900;letter-spacing:-.8px}
.meta{font-size:12.5px;color:#93a0b8;margin:0 0 20px}
.lead{font-size:18px;font-weight:700;line-height:1.55;color:#f2f6ff;margin:0 0 18px}
p{margin:0 0 15px}
.facts{margin:22px 0;padding:16px 18px;border:1px solid rgba(148,180,255,.18);border-radius:16px;background:rgba(148,180,255,.05)}
.facts b{display:block;font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#93a0b8;margin-bottom:9px}
.facts ul{margin:0;padding-left:18px}.facts li{margin:5px 0;font-size:15px}
.method{margin:26px 0 0;padding:14px 16px;border-radius:14px;background:rgba(245,160,90,.08);border:1px solid rgba(245,160,90,.22);font-size:13px;color:#f0c9a4}
.more{margin:26px 0 0;display:flex;flex-wrap:wrap;gap:10px}
.more a{display:inline-flex;padding:10px 15px;border-radius:12px;border:1px solid rgba(148,180,255,.25);background:rgba(148,180,255,.07);color:#e8eefb;font-size:13px;font-weight:800;text-decoration:none}
.more a:hover{background:rgba(148,180,255,.14)}
.list{display:flex;flex-direction:column;gap:14px}
.item{padding:16px 18px;border:1px solid rgba(148,180,255,.16);border-radius:16px;background:rgba(148,180,255,.04)}
.item a{color:#e8eefb;text-decoration:none;font-size:17px;font-weight:800;line-height:1.35}
.item a:hover{color:#7db4ff}
.item time{display:block;margin-top:6px;font-size:11.5px;color:#6b7a96}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
const DROP = '<svg viewBox="0 0 24 24"><path d="M12 2.6C12 2.6 5 10.6 5 14.6a7 7 0 0 0 14 0C19 10.6 12 2.6 12 2.6Z"/></svg>';
const METHOD = 'КогдаБенз каждые 10 минут собирает отметки о наличии топлива из открытого источника и от водителей на местах, а окна привоза строит по собственной истории возвратов топлива на каждой АЗС. Прогноз — вероятность по прошлым возвратам, а не гарантия привоза. Данные обновляются каждые 4 часа: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 МСК.';

function page(a) {
const url = SITE + '/news/' + a.slug + '.html';
const iso = new Date(a.t).toISOString();
const ld = {
'@context': 'https://schema.org', '@type': 'NewsArticle',
headline: a.title, description: a.lead,
datePublished: iso, dateModified: iso,
author: { '@type': 'Organization', name: 'КогдаБенз', url: SITE },
publisher: { '@type': 'Organization', name: 'КогдаБенз', url: SITE },
mainEntityOfPage: url, articleSection: 'Топливо и цены'
};
return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)}</title>
<meta name="description" content="${esc(a.lead)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="article">
<meta property="og:site_name" content="КогдаБенз">
<meta property="og:locale" content="ru_RU">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:description" content="${esc(a.lead)}">
<meta property="og:image" content="${SITE + '/' + a.og}">
<meta property="article:published_time" content="${iso}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(a.title)}">
<meta name="twitter:description" content="${esc(a.lead)}">
<meta name="twitter:image" content="${SITE + '/' + a.og}">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${CSS}</style></head><body><div class="wrap">
<header class="top"><span class="tile">${DROP}</span><span><b>КогдаБенз</b><small>данные о топливе</small></span>
<nav><a href="${SITE}/">Карта</a><a href="/news/">Все новости</a></nav></header>
<p class="kicker">${esc(a.kicker)}</p>
<h1>${esc(a.title)}</h1>
<p class="meta">${stamp(a.t)} МСК · КогдаБенз · данные на ${stamp(a.t)}</p>
<p class="lead">${esc(a.lead)}</p>
${a.paras.map(p => '<p>' + esc(p) + '</p>').join('')}
${a.facts.length ? '<div class="facts"><b>Цифры выпуска</b><ul>' + a.facts.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul></div>' : ''}
<div class="method">${METHOD}</div>
<div class="more">${a.links.map(l => '<a href="' + l[0] + '">' + esc(l[1]) + '</a>').join('')}</div>
</div></body></html>`;
}

function buildArticles(dir, D, svodkas) {
const out = [];
const t = Date.now();
const stById = {};
for (const s of D.stations) stById[s.id] = s;
const regOf = s => (s && s.region) ? s.region : 'south';
// волны за сутки
const byReg = { lost: {}, ret: {}, lostSt: {}, retSt: {} };
for (const e of D.evs) {
const s = stById[e.station_id]; if (!s) continue;
const r = regOf(s);
const lost = e.event_type === 'fuel_disappeared';
if (lost) { byReg.lost[r] = (byReg.lost[r] || 0) + 1; (byReg.lostSt[r] = byReg.lostSt[r] || {})[e.station_id] = 1; }
else { byReg.ret[r] = (byReg.ret[r] || 0) + 1; (byReg.retSt[r] = byReg.retSt[r] || {})[e.station_id] = 1; }
}
function topNames(map, n) {
return Object.keys(map || {}).slice(0, n).map(id => stById[id]).filter(Boolean)
.map(s => '«' + (s.name || 'АЗС') + '»' + (s.address ? ', ' + s.address : ''));
}
for (const r of Object.keys(REG)) {
const lost = byReg.lost[r] || 0, ret = byReg.ret[r] || 0;
const thL = r === 'south' ? TH.lossSouth : TH.lossOther;
const thR = r === 'south' ? TH.retSouth : TH.retOther;
const d = new Date(t); const day = d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
if (lost >= thL) {
const names = topNames(byReg.lostSt[r], 4);
out.push({
slug: 'volna-uhod-' + r + '-' + day, t, og: 'og-' + r + '.png', kicker: REG[r].label + ' · дефицит',
title: REG[r].where[0].toUpperCase() + REG[r].where.slice(1) + ' за сутки топливо пропало с ' + lost + ' ' + plural(lost, ['АЗС', 'АЗС', 'АЗС']),
lead: 'За последние 24 часа отметки «топлива нет» появились на ' + lost + ' ' + plural(lost, ['заправке', 'заправках', 'заправках']) + ' (' + REG[r].label.toLowerCase() + '). Это похоже на волну: топливо уходит группами, а не по одной АЗС.',
paras: [
'Волна означает, что сети снимают остатки с колонок примерно одновременно — обычно так бывает, когда поставка не приходит в срок сразу нескольким брендам.',
names.length ? 'Среди отметок за сутки: ' + names.join('; ') + '.' : 'Отметки пришли с разных сетей, одиночного сбоя не видно.',
'Водителям стоит проверять наличие перед выездом и смотреть окна привоза: по истории возвратов видно, в какие часы топливо обычно возвращается.'
],
facts: ['АЗС с потерей за 24 ч: ' + lost, 'Регион: ' + REG[r].label, 'Окно данных: ' + stamp(t - 24 * H) + ' — ' + stamp(t) + ' МСК'],
links: [[SITE + '/', 'Живая карта'], [SITE + '/' + REG[r].file, 'Сводка: ' + REG[r].label]]
});
}
if (ret >= thR) {
const names = topNames(byReg.retSt[r], 4);
out.push({
slug: 'volna-vozvrat-' + r + '-' + day, t, og: 'og-' + r + '.png', kicker: REG[r].label + ' · возврат',
title: REG[r].where[0].toUpperCase() + REG[r].where.slice(1) + ' за сутки топливо вернулось на ' + ret + ' ' + plural(ret, ['АЗС', 'АЗС', 'АЗС']),
lead: 'За последние 24 часа ' + ret + ' ' + plural(ret, ['заправка снова показала', 'заправки снова показали', 'заправок снова показали']) + ' наличие топлива (' + REG[r].label.toLowerCase() + '). Волна возврата обычно идёт вслед за привозом на базы.',
paras: [
'Возвраты редко бывают одиночными: когда машина приходит на сеть, колонки оживают сразу на нескольких адресах.',
names.length ? 'Вернули топливо, в частности: ' + names.join('; ') + '.' : 'Возвраты распределены по разным сетям региона.',
'Окна привоза на карте строятся по истории таких возвратов: чем их больше, тем точнее прогноз по конкретной АЗС.'
],
facts: ['АЗС с возвратом за 24 ч: ' + ret, 'Регион: ' + REG[r].label, 'Окно данных: ' + stamp(t - 24 * H) + ' — ' + stamp(t) + ' МСК'],
links: [[SITE + '/', 'Живая карта'], [SITE + '/' + REG[r].file, 'Сводка: ' + REG[r].label]]
});
}
}
// городские срезы из сводок
for (const sv of svodkas) {
const day = new Date(t).getUTCFullYear() + p2(new Date(t).getUTCMonth() + 1) + p2(new Date(t).getUTCDate());
for (const c of sv.cities) {
if (!c.known) continue;
if (c.level === 'r' && c.known >= 8) {
out.push({
slug: 'deficit-' + c.key + '-' + day, t, og: 'og-' + c.key + '.png', kicker: c.name + ' · наличие',
title: c.name + ': АИ-95 есть только на ' + c.a95 + ' из ' + c.known + ' ' + plural(c.known, ['АЗС', 'АЗС', 'АЗС']) + ' с данными',
lead: 'В городе ' + c.name + ' подтверждённый АИ-95 остался на ' + c.a95 + ' ' + plural(c.a95, ['заправке', 'заправках', 'заправках']) + ' из ' + c.known + ', по которым есть свежие отметки. Остальные либо показывают «нет», либо молчат.',
paras: [
'Такая картина обычно держится до привоза: часть сетей снимает остатки с колонок, а водители видят очереди даже там, где топливо формально есть.',
'Прогнозов возврата по городу сейчас: ' + c.wins + '. Это интервалы, в которые топливо на конкретных АЗС возвращалось раньше всего чаще.',
'Отметки водителей с места закрывают дыры источника: там, где поставщик молчит, карта живёт голосами людей у колонок.'
],
facts: ['АИ-95 есть: ' + c.a95 + ' из ' + c.known, 'АИ-92 есть: ' + c.a92 + ' из ' + c.known, 'Дизель есть: ' + c.adt + ' из ' + c.known, 'Окон привоза: ' + c.wins, 'АЗС с очередью: ' + c.q],
links: [[SITE + '/svodka-' + c.key + '.html', 'Сводка по городу ' + c.name], [SITE + '/', 'Живая карта']]
});
}
if (c.q >= TH.queueCity) {
out.push({
slug: 'ocheredi-' + c.key + '-' + day, t, og: 'og-' + c.key + '.png', kicker: c.name + ' · очереди',
title: c.name + ': очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']),
lead: 'Водители сообщают о высокой очереди на ' + c.q + ' ' + plural(c.q, ['заправке', 'заправках', 'заправках']) + ' города ' + c.name + '. Очередь — ранний признак того, что топливо в городе на исходе.',
paras: [
'Очереди появляются раньше, чем источник успевает снять отметки наличия: люди видят колонки пустыми ещё до обновления данных.',
'Отметка об очереди живёт около часа и ставится одним тапом из карточки АЗС — поэтому карта очередей всегда свежее, чем сводка наличия.'
],
facts: ['АЗС с высокой очередью: ' + c.q, 'АИ-95 есть: ' + c.a95 + ' из ' + c.known, 'Окон привоза: ' + c.wins],
links: [[SITE + '/svodka-' + c.key + '.html', 'Сводка по городу ' + c.name], [SITE + '/', 'Живая карта']]
});
}
}
}
// точность прогнозов
const verified = D.ver.filter(v => v.verified_at);
if (verified.length >= TH.accMin) {
const hit = verified.filter(v => v.result === 'SUCCESS').length;
const rate = Math.round(100 * hit / verified.length);
const day = new Date(t).getUTCFullYear() + p2(new Date(t).getUTCMonth() + 1) + p2(new Date(t).getUTCDate());
out.push({
slug: 'tochnost-' + day, t, og: 'og-south.png', kicker: 'Прогнозы · проверка',
title: 'Прогноз привоза топлива сбылся в ' + hit + ' из ' + verified.length + ' ' + plural(verified.length, ['случая', 'случаев', 'случаев']) + ' (' + rate + '%)',
lead: 'За последние 30 дней проверено ' + verified.length + ' ' + plural(verified.length, ['прогноз', 'прогноза', 'прогнозов']) + ' привоза топлива: топливо действительно вернулось в объявленное окно в ' + hit + ' ' + plural(hit, ['случае', 'случаях', 'случаях']) + ' (' + rate + '%).',
paras: [
'Каждый прогноз проверяется задним числом: когда источник или водители подтверждают возврат, окно сравнивается с фактом и ошибка уходит в статистику.',
'Окно привоза строится по квантилям 20–80% прошлых возвратов конкретной АЗС (или её бренда, если своей истории мало). Поэтому окно широкое — 4–6 часов — но честное: оно говорит «примерно в этот интервал», а не «ровно в 14:00».',
'Точность считается открыто и обновляется вместе с каждой сводкой: цифра в заголовке — это факт проверки, а не обещание.'
],
facts: ['Проверено прогнозов за 30 дней: ' + verified.length, 'Совпало с окном: ' + hit, 'Точность: ' + rate + '%'],
links: [[SITE + '/', 'Живая карта и окна привоза'], [SITE + '/svodka.html', 'Сводка по югу']]
});
}
return out;
}

// ---------- выпуск ----------
(async function run() {
if (!SUP || !KEY) { console.log('! newsroom: нет SUPABASE_URL/SUPABASE_KEY'); process.exit(1); }
const dir = findDir();
if (!dir) { console.log('! newsroom: папка сайта не найдена'); process.exit(1); }
const newsDir = path.join(dir, 'news');
fs.mkdirSync(newsDir, { recursive: true });
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(path.join(newsDir, 'manifest.json'), 'utf8')); } catch (e) {}
const D = await load();
const svodkas = readSvodkas(dir);
if (!svodkas.length) { console.log('! newsroom: нет svodka*.json — сначала собери сводки'); process.exit(1); }
const fresh = buildArticles(dir, D, svodkas).filter(a => !manifest[a.slug]);
if (!fresh.length) { console.log('newsroom: новых поводов нет (проверено поводов: ' + buildArticles(dir, D, svodkas).length + ')'); }
const items = [];
for (const a of fresh) {
fs.writeFileSync(path.join(newsDir, a.slug + '.html'), page(a));
manifest[a.slug] = new Date(a.t).toISOString();
items.push(a);
console.log('✓ статья: /news/' + a.slug + '.html — ' + a.title);
}
// индекс
const all = Object.keys(manifest).sort().reverse().slice(0, 60);
const idxItems = all.map(slug => {
const f = path.join(newsDir, slug + '.html');
let title = slug, when = manifest[slug];
try {
const h = fs.readFileSync(f, 'utf8');
const m = h.match(/<h1>([\s\S]*?)<\/h1>/);
if (m) title = m[1].replace(/<[^>]+>/g, '').trim();
} catch (e) {}
return '<div class="item"><a href="/news/' + slug + '.html">' + esc(title) + '</a><time>' + stamp(new Date(when).getTime()) + ' МСК</time></div>';
}).join('');
fs.writeFileSync(path.join(newsDir, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Новости топлива юга, Северо-Запада и Чувашии — КогдаБенз</title>
<meta name="description" content="Короткие выпуски по данным о наличии топлива: волны дефицита, возвраты, очереди и точность прогнозов привоза.">
<link rel="canonical" href="${SITE}/news/">
<meta name="robots" content="index,follow">
<link rel="alternate" type="application/rss+xml" title="КогдаБенз — новости топлива" href="${SITE}/news/rss.xml">
<style>${CSS}</style></head><body><div class="wrap">
<header class="top"><span class="tile">${DROP}</span><span><b>КогдаБенз</b><small>данные о топливе</small></span>
<nav><a href="${SITE}/">Карта</a><a href="/news/rss.xml">RSS</a></nav></header>
<h1>Новости топлива</h1>
<p class="meta">Выпуски собираются автоматически из данных карты: волны дефицита, возвраты, очереди, точность прогнозов.</p>
<div class="list">${idxItems || '<div class="item">Выпусков пока нет — первые появятся, когда в данных будет новостной повод.</div>'}</div>
</div></body></html>`);
// RSS
const rssItems = items.concat(all.slice(items.length).map(slug => ({ slug, t: new Date(manifest[slug]).getTime() })))
.sort((a, b) => b.t - a.t).slice(0, 50).map(a => {
const f = path.join(newsDir, a.slug + '.html');
let title = a.title || a.slug, lead = a.lead || '';
try {
const h = fs.readFileSync(f, 'utf8');
const m1 = h.match(/<h1>([\s\S]*?)<\/h1>/), m2 = h.match(/class="lead">([\s\S]*?)<\/p>/);
if (m1) title = m1[1].replace(/<[^>]+>/g, '').trim();
if (m2) lead = m2[1].replace(/<[^>]+>/g, '').trim();
} catch (e) {}
return '<item><title>' + esc(title) + '</title><link>' + SITE + '/news/' + a.slug + '.html</link>' +
'<guid isPermaLink="true">' + SITE + '/news/' + a.slug + '.html</guid>' +
'<pubDate>' + new Date(a.t).toUTCString() + '</pubDate>' +
'<description>' + esc(lead) + '</description></item>';
}).join('\n');
fs.writeFileSync(path.join(newsDir, 'rss.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n' +
'<title>КогдаБенз — новости топлива</title><link>' + SITE + '/news/</link>\n' +
'<description>Волны дефицита, возвраты топлива, очереди и точность прогнозов привоза по данным живой карты.</description>\n' +
'<language>ru</language><lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' + rssItems + '\n</channel></rss>');
// news-sitemap (только свежее, < 48 ч)
const nowT = Date.now();
const newsUrls = Object.keys(manifest).filter(s => nowT - new Date(manifest[s]).getTime() < 48 * H).map(s =>
'<url><loc>' + SITE + '/news/' + s + '.html</loc><news:news><news:publication><news:name>КогдаБенз</news:name><news:language>ru</news:language></news:publication><news:publication_date>' + manifest[s] + '</news:publication_date><news:title>КогдаБенз: выпуск данных</news:title></news:news></url>').join('\n');
fs.writeFileSync(path.join(dir, 'sitemap-news.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/news-sitemap">\n' + newsUrls + '\n</urlset>');
// основной sitemap: добавить /news/ и статьи
const sp = path.join(dir, 'sitemap.xml');
let sm = fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8') : '';
if (sm.indexOf('<urlset') < 0) sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>';
if (sm.indexOf(SITE + '/news/') < 0) {
const add = ['  <url><loc>' + SITE + '/news/</loc><changefreq>hourly</changefreq><priority>0.7</priority></url>']
.concat(Object.keys(manifest).map(s => '  <url><loc>' + SITE + '/news/' + s + '.html</loc><changefreq>daily</changefreq><priority>0.6</priority></url>')).join('\n');
sm = sm.replace(/<\/urlset>/i, add + '\n</urlset>');
fs.writeFileSync(sp, sm);
}
fs.writeFileSync(path.join(newsDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('newsroom: статей добавлено ' + items.length + ', всего в индексе ' + Object.keys(manifest).length);
if (NO_GIT) { console.log('Публикация пропущена (--no-git).'); return; }
if (!fs.existsSync(path.join(dir, '.git'))) { console.log('! нет .git — закоммить вручную.'); return; }
try {
const cp = require('child_process');
const gr = c => cp.execSync(c, { cwd: dir, stdio: 'pipe', timeout: 120000 });
gr('git add -A');
try { gr('git -c user.name="kogdabenz-bot" -c user.email="bot@kogdabenz.ru" commit -m "newsroom: auto news"'); } catch (e) {}
gr('git push');
console.log('Опубликовано.');
} catch (e) { console.log('! git push: ' + String(e.message).split('\n')[0]); }
})().catch(e => { console.log('! newsroom: ' + e.message); process.exit(1); });