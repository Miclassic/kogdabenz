#!/usr/bin/env node
'use strict';
// ============================================================
// КОГДАБЕНЗ · СВОДКИ ПО РЕГИОНАМ — генератор индексируемых страниц.
// Юг: svodka.html + svodka.json. Северо-Запад: svodka-sz.html + svodka-sz.json.
// Сайт на GitHub Pages / VPS: пишем обе страницы + sitemap.xml + robots.txt
// в репозиторий сайта. Выпуск каждые 4 часа (00/04/08/12/16/20 МСК),
// гейт в bot_meta.svodka_bucket (один на выпуск, обе страницы сразу).
// Запуск: node svodka.js [--force] или из коллектора: require('./svodka.js').run()
// ============================================================
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const API = process.env.SUPABASE_URL || 'https://api.kogdabenz.ru';
const KEY = process.env.SUPABASE_KEY ||
'eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJyb2xlIjogImFub24iLCAiaXNzIjogImtvZ2RhYmVueiIsICJpYXQiOiAxNzkzMTgwMDg2LCAiZXhwIjogMjEwODU0MDA4Nn0.XgC7MHgl-gwkbPeOUP8rtCR4wt5Ddcw4TDfy5elrzTQ';
const SITE = 'https://kogdabenz.ru';
const H = 3600000;
const SUSPECT = { SUSPECTED_LOSS: 1, CONFIRMED_LOSS: 1, DEPLETION: 1, RECOVERY_STARTED: 1 };
// ---------- города регионов (рамки те же, что в app.js) ----------
const CITIES_SOUTH = [
{ key: 'novorossiysk', name: 'Новороссийск', inn: 'Новороссийске', reg: 'Краснодарский край', lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.00 },
{ key: 'gelendzhik', name: 'Геленджик', inn: 'Геленджике', reg: 'Краснодарский край', lat1: 44.45, lat2: 44.68, lon1: 37.95, lon2: 38.25 },
{ key: 'anapa', name: 'Анапа', inn: 'Анапе', reg: 'Краснодарский край', lat1: 44.80, lat2: 45.10, lon1: 37.20, lon2: 37.60 },
{ key: 'krymsk', name: 'Крымск', inn: 'Крымске', reg: 'Краснодарский край', lat1: 44.85, lat2: 45.05, lon1: 37.85, lon2: 38.15 },
{ key: 'krasnodar', name: 'Краснодар', inn: 'Краснодаре', reg: 'Краснодарский край', lat1: 44.90, lat2: 45.15, lon1: 38.80, lon2: 39.15 },
{ key: 'sochi', name: 'Сочи', inn: 'Сочи', reg: 'Краснодарский край', lat1: 43.35, lat2: 43.75, lon1: 39.60, lon2: 40.10 },
{ key: 'tuapse', name: 'Туапсе', inn: 'Туапсе', reg: 'Краснодарский край', lat1: 44.00, lat2: 44.20, lon1: 39.00, lon2: 39.25 },
{ key: 'armavir', name: 'Армавир', inn: 'Армавире', reg: 'Краснодарский край', lat1: 44.90, lat2: 45.10, lon1: 40.90, lon2: 41.20 },
{ key: 'maykop', name: 'Майкоп', inn: 'Майкопе', reg: 'Адыгея', lat1: 44.55, lat2: 44.75, lon1: 40.00, lon2: 40.30 },
{ key: 'rostov', name: 'Ростов-на-Дону', inn: 'Ростове-на-Дону', reg: 'Ростовская область', lat1: 47.15, lat2: 47.35, lon1: 39.55, lon2: 39.85 },
{ key: 'stavropol', name: 'Ставрополь', inn: 'Ставрополе', reg: 'Ставропольский край', lat1: 44.80, lat2: 45.25, lon1: 41.60, lon2: 42.30 }
];
const CITIES_NW = [
{ key: 'spb', name: 'Санкт-Петербург', inn: 'Санкт-Петербурге', reg: 'Санкт-Петербург', lat1: 59.80, lat2: 60.10, lon1: 30.05, lon2: 30.55 },
{ key: 'vsevolozhsk', name: 'Всеволожск', inn: 'Всеволожске', reg: 'Ленинградская область', lat1: 59.95, lat2: 60.12, lon1: 30.55, lon2: 30.82 },
{ key: 'kolpino', name: 'Колпино', inn: 'Колпине', reg: 'Санкт-Петербург', lat1: 59.66, lat2: 59.82, lon1: 30.45, lon2: 30.75 },
{ key: 'gatchina', name: 'Гатчина', inn: 'Гатчине', reg: 'Ленинградская область', lat1: 59.48, lat2: 59.66, lon1: 29.95, lon2: 30.32 },
{ key: 'sosnovybor', name: 'Сосновый Бор', inn: 'Сосновом Бору', reg: 'Ленинградская область', lat1: 59.80, lat2: 59.99, lon1: 28.90, lon2: 29.32 },
{ key: 'ustluga', name: 'Усть-Луга', inn: 'Усть-Луге', reg: 'Ленинградская область', lat1: 59.58, lat2: 59.78, lon1: 28.15, lon2: 28.50 },
{ key: 'vyborg', name: 'Выборг', inn: 'Выборге', reg: 'Ленинградская область', lat1: 60.58, lat2: 60.84, lon1: 28.55, lon2: 29.00 },
{ key: 'luga', name: 'Луга', inn: 'Луге', reg: 'Ленинградская область', lat1: 58.62, lat2: 58.84, lon1: 29.68, lon2: 30.02 },
{ key: 'vnovgorod', name: 'Великий Новгород', inn: 'Великом Новгороде', reg: 'Новгородская область', lat1: 58.44, lat2: 58.64, lon1: 31.08, lon2: 31.48 },
{ key: 'kirishi', name: 'Кириши', inn: 'Киришах', reg: 'Ленинградская область', lat1: 59.36, lat2: 59.54, lon1: 31.88, lon2: 32.18 },
{ key: 'volhov', name: 'Волхов', inn: 'Волхове', reg: 'Ленинградская область', lat1: 59.84, lat2: 60.02, lon1: 32.18, lon2: 32.50 },
{ key: 'tikhvin', name: 'Тихвин', inn: 'Тихвине', reg: 'Ленинградская область', lat1: 59.56, lat2: 59.74, lon1: 33.38, lon2: 33.68 },
{ key: 'sortavala', name: 'Сортавала', inn: 'Сортавале', reg: 'Республика Карелия', lat1: 61.60, lat2: 61.80, lon1: 30.52, lon2: 30.88 },
{ key: 'petrozavodsk', name: 'Петрозаводск', inn: 'Петрозаводске', reg: 'Республика Карелия', lat1: 61.68, lat2: 61.90, lon1: 34.18, lon2: 34.52 }
];
const CITIES_CH = [
{ key: 'cheboksary', name: 'Чебоксары', inn: 'Чебоксарах', reg: 'Чувашия', lat1: 56.05, lat2: 56.25, lon1: 47.10, lon2: 47.40 },
{ key: 'novocheboksarsk', name: 'Новочебоксарск', inn: 'Новочебоксарске', reg: 'Чувашия', lat1: 56.05, lat2: 56.18, lon1: 47.40, lon2: 47.62 },
{ key: 'kanash', name: 'Канаш', inn: 'Канаше', reg: 'Чувашия', lat1: 55.45, lat2: 55.57, lon1: 47.40, lon2: 47.60 },
{ key: 'alatyr', name: 'Алатырь', inn: 'Алатыре', reg: 'Чувашия', lat1: 54.78, lat2: 54.92, lon1: 46.48, lon2: 46.70 },
{ key: 'shumerlya', name: 'Шумерля', inn: 'Шумерле', reg: 'Чувашия', lat1: 55.44, lat2: 55.56, lon1: 46.32, lon2: 46.52 },
{ key: 'tsivilsk', name: 'Цивильск', inn: 'Цивильске', reg: 'Чувашия', lat1: 55.80, lat2: 55.93, lon1: 47.38, lon2: 47.56 },
{ key: 'mariinskyposad', name: 'Мариинский Посад', inn: 'Мариинском Посаде', reg: 'Чувашия', lat1: 56.05, lat2: 56.18, lon1: 47.62, lon2: 47.82 },
{ key: 'kozlovka', name: 'Козловка', inn: 'Козловке', reg: 'Чувашия', lat1: 55.78, lat2: 55.90, lon1: 48.15, lon2: 48.36 },
{ key: 'yadrin', name: 'Ядрин', inn: 'Ядрине', reg: 'Чувашия', lat1: 55.88, lat2: 56.00, lon1: 46.10, lon2: 46.30 }
];
const REGIONS = [
{
key: 'south', cities: CITIES_SOUTH,
file: 'svodka.html', json: 'svodka.json',
otherFile: 'svodka-sz.html', otherName: 'Северо-Запад',
where: 'на юге России', descHead: 'Сводка по югу',
genRegion: 'юга', whole: 'юг', calm: 'на юге спокойно',
leadGeo: 'Краснодарский край, Адыгея, Ростовская область и Ставрополье',
descGeo: 'Краснодарский край, Адыгея, Ростовская область, Ставрополье',
kpiCities: 'Городов юга', bread: 'Сводка по Югу'
},
{
key: 'nw', cities: CITIES_NW,
file: 'svodka-sz.html', json: 'svodka-sz.json',
otherFile: 'svodka.html', otherName: 'Юг',
where: 'на северо-западе России', descHead: 'Сводка по Северо-Западу',
genRegion: 'Северо-Запада', whole: 'Северо-Запад', calm: 'на северо-западе спокойно',
leadGeo: 'Санкт-Петербург, Ленинградская и Новгородская области, Карелия',
descGeo: 'Санкт-Петербург, Ленинградская область, Новгородская область, Карелия',kpiCities: 'Городов Северо-Запада', bread: 'Сводка по Северо-Западу'},
{key: 'ch', cities: CITIES_CH,file: 'svodka-ch.html', json: 'svodka-ch.json',otherFile: 'svodka.html', otherName: 'Юг',where: 'в Чувашии', descHead: 'Сводка по Чувашии',genRegion: 'Чувашии', whole: 'Чувашия', calm: 'в Чувашии спокойно',leadGeo: 'Чебоксары и республика Чувашия',descGeo: 'Чувашия, Чебоксары',kpiCities: 'Городов Чувашии', bread: 'Сводка по Чувашии'}];
// ---------- утилиты ----------
const pad = n => String(n).padStart(2, '0');
const e = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const msk = ms => new Date((ms == null ? Date.now() : ms) + 3 * H);
const t5 = v => String(v || '').slice(0, 5);
const mins = v => Number(String(v || '').slice(0, 2)) * 60 + Number(String(v || '').slice(3, 5));
const fuelRu = f => f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : 'топливо';
function plural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }
function bucketStart() {
const m = msk();
return Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate(), Math.floor(m.getUTCHours() / 4) * 4) - 3 * H;
}
function stamp(ms) { const d = msk(ms); return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
function hhmm(ms) { const d = msk(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
function cityOf(st, cities) {
const lat = Number(st.lat), lon = Number(st.lon);
if (!isFinite(lat) || !isFinite(lon)) return null;
for (const c of cities) if (lat >= c.lat1 && lat <= c.lat2 && lon >= c.lon1 && lon <= c.lon2) return c.key;
return null;
}
function freshMin(o) {
if (!o) return null;
if (o.data_freshness_minutes != null) return Number(o.data_freshness_minutes);
if (o.timestamp) return Math.max(0, Math.round((Date.now() - new Date(o.timestamp).getTime()) / 60000));
return null;
}
const trust = o => { const m = freshMin(o); return m !== null && m <= 360 && !SUSPECT[o.fuel_state]; };
// газовые заправки бензин не продают — в сводку не берём.
// Бензиновые сети со словом «газ» в имени остаются.
function isGasOnly(st) {
const t = String((st.name || '') + ' ' + (st.brand || '')).toLowerCase();
if (/газпром|газон|газпрайм|нефтегаз|gas\s*oil/.test(t)) return false;
if (/агзс|агнкс|пропан|метан|бутан|газовая заправка|заправка газ|автогаз|трансгаз|росгаз|сибгаз|техгаз/.test(t)) return true;
return /(^|[^а-яёa-z])газ([^а-яёa-z]|$)/.test(t);
}
function agoTxt(m) {
if (m == null) return 'давно';
if (m < 60) return m + ' мин назад';
if (m < 1440) return Math.round(m / 60) + ' ч назад';
return Math.round(m / 1440) + ' дн назад';
}
function winKey(p, nowM, today) {
if (!p || !p.from_time) return 1e9;
const f = mins(p.from_time), t = mins(p.to_time);
if (p.target_date && p.target_date > today) return 1440 + f;
if (p.target_date && p.target_date < today) return 1e9;
if (nowM >= f && nowM <= t) return 0;
if (f > nowM) return f - nowM;
return 1e8;
}
// ---------- API ----------
async function api(p) {
let last = null;
for (let i = 0; i < 4; i++) {
const ctrl = new AbortController();
const tm = setTimeout(() => ctrl.abort(), 45000);
try {
const r = await fetch(API + p, {
headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Accept: 'application/json' },
signal: ctrl.signal
});
if (!r.ok) throw new Error('HTTP ' + r.status);
return await r.json();
} catch (err) { last = err; await new Promise(r => setTimeout(r, 4000 * (i + 1))); }
finally { clearTimeout(tm); }
}
throw new Error(p.slice(0, 60) + ' → ' + (last && last.message));
}
async function apiAll(p) {
const sep = p.indexOf('?') >= 0 ? '&' : '?';
const out = [];
for (let off = 0; ; off += 1000) {
const page = await api(p + sep + 'limit=1000&offset=' + off);
for (const r of page) out.push(r);
if (page.length < 1000) break;
}
return out;
}
// ---------- сырые данные: качаем ОДИН раз на выпуск для обоих регионов ----------
async function fetchRaw() {
const B = bucketStart();
const nowM = msk().getUTCHours() * 60 + msk().getUTCMinutes();
const today = msk().toISOString().slice(0, 10);
const stations = await apiAll('/rest/v1/stations?select=id,name,brand,address,lat,lon&order=id.asc');
const obsRows = await apiAll('/rest/v1/observations?timestamp=gte.' + new Date(Date.now() - 90 * 60000).toISOString() +
'&order=timestamp.desc&select=station_id,timestamp,fuel_92_status,fuel_95_status,diesel_status,queue_level,data_freshness_minutes,fuel_state');
const last = {};
for (const o of obsRows) if (!last[o.station_id]) last[o.station_id] = o;
const preds = await apiAll('/rest/v1/predictions?result=eq.PENDING&select=station_id,fuel_type,from_time,to_time,target_date,confidence&order=id.asc');
const evs = await apiAll('/rest/v1/events?event_type=in.(fuel_disappeared,fuel_restored)&detected_at=gte.' +
new Date(Date.now() - 24 * H).toISOString() + '&order=detected_at.desc&select=station_id,event_type,fuel_type,detected_at');
const fb = await api('/rest/v1/user_feedback?order=created_at.desc&limit=500&select=station_id,fuel_type,feedback_type,created_at,verified_on_site,device_id');
const pairChg = {};
for (const ev of evs) {
const t = new Date(ev.detected_at).getTime();
const k = ev.station_id + '|' + ev.fuel_type;
if (!pairChg[k] || t > pairChg[k]) pairChg[k] = t;
}
const onSite = {}, folk = {};
for (const f of fb) {
const t = new Date(f.created_at).getTime();
const k = f.station_id + '|' + f.fuel_type;
if (f.feedback_type === 'available' && f.verified_on_site && Date.now() - t <= 2 * H) onSite[k] = t;
if (Date.now() - t > 24 * H) continue;
if (f.feedback_type !== 'available' && f.feedback_type !== 'unavailable') continue;
if (!f.fuel_type) continue;
if (pairChg[k] && t <= pairChg[k]) continue;
const g = folk[k] || (folk[k] = { y: {}, n: {}, ty: 0, tn: 0 });
if (f.feedback_type === 'available') { g.y[f.device_id || '?'] = 1; g.ty = Math.max(g.ty, t); }
else { g.n[f.device_id || '?'] = 1; g.tn = Math.max(g.tn, t); }
}
const predBy = {};
for (const p of preds) (predBy[p.station_id] = predBy[p.station_id] || []).push(p);
return { B, nowM, today, stations, last, evs, pairChg, onSite, folk, predBy };
}
// ---------- сбор выпуска по региону ----------
function buildRegion(raw, RG) {
const { B, nowM, today, stations, last, evs, onSite, folk, predBy } = raw;
function view(id, o, fl) {
const col = fl === '92' ? 'fuel_92_status' : fl === '95' ? 'fuel_95_status' : 'diesel_status';
const k = id + '|' + fl;
if (onSite[k]) return { v: 1, src: 'с места', m: Math.round((Date.now() - onSite[k]) / 60000) };
const rawS = o ? o[col] : null;
if (trust(o)) {
if (rawS === true) return { v: 1, src: 'источник', m: freshMin(o) };
if (rawS === false) return { v: 0, src: 'источник', m: freshMin(o) };
}
const g = folk[k];
if (g) {
const ny = Object.keys(g.y).length, nn = Object.keys(g.n).length;
if (ny >= 2 && ny > nn) return { v: 1, src: 'народ · ' + ny, m: Math.round((Date.now() - g.ty) / 60000) };
if (nn >= 2 && nn > ny) return { v: 0, src: 'народ · ' + nn, m: Math.round((Date.now() - g.tn) / 60000) };
if (ny >= 1 && nn >= 1) return { v: -1, src: 'спорно', m: null };
}
if (rawS === true) return { v: -1, src: 'не подтверждён', m: freshMin(o) };
if (rawS === false) return { v: 0, src: 'источник · ' + agoTxt(freshMin(o)), m: freshMin(o) };
return { v: -2, src: 'нет данных', m: null };
}
const cities = {};
for (const c of RG.cities) cities[c.key] = Object.assign({}, c, { total: 0, known: 0, a92: 0, a95: 0, adt: 0, q: 0, rows: [], wins: [] });
for (const st of stations) {
const ck = cityOf(st, RG.cities);
if (!ck || isGasOnly(st)) continue;
const c = cities[ck], o = last[st.id];
c.total++;
const v92 = view(st.id, o, '92'), v95 = view(st.id, o, '95'), vdt = view(st.id, o, 'diesel');
if (v92.v !== -2 || v95.v !== -2 || vdt.v !== -2) c.known++;
if (v92.v === 1) c.a92++;
if (v95.v === 1) c.a95++;
if (vdt.v === 1) c.adt++;
if (o && o.queue_level === 'high') c.q++;
let best = null, bk = 1e9;
for (const p of (predBy[st.id] || [])) {
const conf = Math.round((p.confidence || 0) * 100);
const k = winKey(p, nowM, today);
if (conf < 35 || k >= 1e8) continue;
if (k < bk) { bk = k; best = p; }
}
const row = {
id: st.id, name: st.name || 'АЗС', brand: st.brand || '', address: st.address || '',
v92, v95, vdt, q: !!(o && o.queue_level === 'high'),
pred: best, key: best ? bk : 1e9, conf: best ? Math.round((best.confidence || 0) * 100) : 0
};
c.rows.push(row);
if (best) c.wins.push({ row, city: c.name, cityKey: c.key, p: best, k: bk, conf: row.conf });
}
const list = Object.keys(cities).map(k => cities[k]).filter(c => c.total > 0);
for (const c of list) {
c.share = c.known ? c.a95 / c.known : null;
c.cover = c.total ? c.known / c.total : 0;
c.level = (c.known < 5 || c.cover < 0.2) ? 'n' : c.share >= 0.6 ? 'g' : c.share >= 0.25 ? 'y' : 'r';
c.wins.sort((a, b) => a.k - b.k);
c.rows.sort((a, b) => a.key - b.key || a.name.localeCompare(b.name, 'ru'));
}
list.sort((a, b) => (a.level === 'n' ? 1 : 0) - (b.level === 'n' ? 1 : 0) ||
(a.share == null ? 9 : a.share) - (b.share == null ? 9 : b.share) || b.total - a.total);
const T = { total: 0, known: 0, a92: 0, a95: 0, adt: 0, q: 0, wins: 0, cities: list.length };
for (const c of list) { T.total += c.total; T.known += c.known; T.a92 += c.a92; T.a95 += c.a95; T.adt += c.adt; T.q += c.q; T.wins += c.wins.length; }
const topWins = list.flatMap(c => c.wins).sort((a, b) => a.k - b.k).slice(0, 12);
const byId = {};
for (const s of stations) byId[s.id] = s;
const changes = [];
for (const ev of evs) {
const t = new Date(ev.detected_at).getTime();
if (t < B) continue;
const st = byId[ev.station_id];
if (!st) continue;
const ck = cityOf(st, RG.cities);
if (!ck) continue;
changes.push({ t, city: cities[ck].name, name: st.name || 'АЗС', address: st.address || '', fuel: fuelRu(ev.fuel_type), back: ev.event_type === 'fuel_restored' });
}
changes.sort((a, b) => b.t - a.t);
return { B, T, cities: list, wins: topWins, changes: changes.slice(0, 16), changeN: changes.length, RG: RG };
}
// ---------- страница ----------
const CSS = `
:root{
--ink:#070c18;--petrol:#0b1526;--surf:#101c33;--surf2:#15243d;--surf3:#1b2f4d;
--line:rgba(120,160,235,.16);--line2:rgba(120,160,235,.30);
--txt:#e8f0ff;--mut:#8ea3c4;--dim:#63779a;
--blue:#3f86ff;--blue2:#1e56d6;--green:#2fd39a;--green2:#12855c;
--amber:#f5a05a;--sky:#6ea8ff;--red:#ff6b6b;--violet:#b7a8ff;--gold:#ffc83d;
--nav:64px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ink);color:var(--txt);line-height:1.55;overflow-x:hidden;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',system-ui,sans-serif;
font-feature-settings:'tnum' 0}
body::before{content:'';position:fixed;inset:-20%;z-index:0;pointer-events:none;
background:
radial-gradient(46vw 40vw at 82% -6%,rgba(63,134,255,.30),transparent 62%),
radial-gradient(40vw 36vw at 6% 16%,rgba(47,211,154,.16),transparent 60%),
radial-gradient(44vw 40vw at 74% 78%,rgba(183,168,255,.16),transparent 62%),
radial-gradient(38vw 34vw at 20% 96%,rgba(245,160,90,.10),transparent 60%);
animation:drift 34s ease-in-out infinite alternate;filter:blur(6px)}
@keyframes drift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-2.5%,1.8%,0) scale(1.06)}100%{transform:translate3d(2%,-2%,0) scale(1.02)}}
body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.05;mix-blend-mode:overlay;
background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:#0a1120;border-radius:9px}
::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--blue),var(--blue2));border-radius:9px;border:2px solid #0a1120}
::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,#6ba6ff,#3f74d6)}
*{scrollbar-color:var(--blue2) #0a1120;scrollbar-width:thin}
a{color:var(--blue);text-decoration:none}
.wrap{position:relative;z-index:2;max-width:1120px;margin:0 auto;padding:0 16px}
.progress{position:fixed;top:0;left:0;height:2px;width:0;z-index:60;
background:linear-gradient(90deg,var(--green),var(--blue) 45%,var(--violet));box-shadow:0 0 12px rgba(63,134,255,.7)}
header{position:fixed;top:0;left:0;right:0;height:var(--nav);z-index:50;
background:rgba(7,12,24,.78);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);
border-bottom:1px solid var(--line)}
.hd{max-width:1120px;margin:0 auto;height:var(--nav);padding:0 16px;display:flex;align-items:center;gap:14px}
.logo{display:flex;align-items:center;gap:9px;font-weight:900;font-size:16px;letter-spacing:-.3px;color:var(--txt);flex:none}
.logo i{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;flex:none;
background:linear-gradient(140deg,var(--blue),var(--blue2) 60%,#123a9e);box-shadow:0 4px 14px rgba(63,134,255,.45)}
.logo i svg{width:15px;height:15px;fill:#fff}
.logo b{color:var(--blue);font-weight:900}
nav{display:flex;gap:4px;overflow-x:auto;flex:1;scrollbar-width:none}
nav::-webkit-scrollbar{height:0}
nav a{flex:none;font-size:12.5px;font-weight:700;color:var(--mut);padding:7px 12px;border-radius:99px;
border:1px solid transparent;transition:.22s;white-space:nowrap}
nav a:hover{color:var(--txt);background:rgba(120,160,235,.08)}
nav a.on{color:#fff;background:linear-gradient(135deg,rgba(63,134,255,.28),rgba(30,86,214,.34));border-color:var(--line2)}
nav a.x{border:1px dashed var(--line2);color:var(--sky)}
.go{flex:none;display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:99px;font-weight:800;font-size:12.5px;color:#fff;
background:linear-gradient(135deg,#4b93ff,var(--blue2) 62%,#123a9e);box-shadow:0 6px 20px rgba(63,134,255,.42);transition:.2s}
.go:hover{filter:brightness(1.1);transform:translateY(-1px)}
.go svg{width:14px;height:14px;fill:#fff}
main{padding-top:var(--nav)}
section{scroll-margin-top:calc(var(--nav) + 62px)}
.hero{padding:44px 0 8px;position:relative}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:10.5px;font-weight:900;letter-spacing:1.1px;text-transform:uppercase;
color:var(--green);background:rgba(47,211,154,.10);border:1px solid rgba(47,211,154,.32);padding:6px 13px;border-radius:99px}
.eyebrow i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(47,211,154,.6);animation:pulse 2.2s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 8px rgba(47,211,154,0)}100%{box-shadow:0 0 0 0 rgba(47,211,154,0)}}
h1{font-size:clamp(29px,6vw,52px);line-height:1.06;margin:16px 0 12px;font-weight:900;letter-spacing:-1.6px}
h1 em{font-style:normal;background:linear-gradient(100deg,#4b93ff 0%,var(--green) 42%,var(--violet) 82%);
-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:15px;color:var(--mut);max-width:74ch;font-weight:500}
.stamp{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:16px;font-size:12.5px;font-weight:700;color:var(--dim)}
.stamp b{color:var(--txt)}
.stamp .next{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:99px;
background:rgba(63,134,255,.10);border:1px solid var(--line2);color:#9dc4ff;font-variant-numeric:tabular-nums}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:11px;margin:24px 0 6px}
.k{position:relative;overflow:hidden;border-radius:18px;padding:15px 16px;border:1px solid var(--line);
background:linear-gradient(158deg,var(--surf2),var(--surf))}
.k::after{content:'';position:absolute;right:-38px;top:-38px;width:120px;height:120px;border-radius:50%;
background:radial-gradient(circle,rgba(63,134,255,.22),transparent 70%)}
.k small{display:block;font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--mut)}
.k b{display:block;font-size:36px;font-weight:900;letter-spacing:-1.8px;line-height:1;margin-top:6px;font-variant-numeric:tabular-nums}
.k i{display:block;font-style:normal;font-size:11.5px;color:var(--dim);margin-top:6px;font-weight:600}
.k.g b{color:var(--green)}.k.b b{color:var(--blue)}.k.y b{color:var(--amber)}.k.v b{color:var(--violet)}
.k.g::after{background:radial-gradient(circle,rgba(47,211,154,.22),transparent 70%)}
.k.y::after{background:radial-gradient(circle,rgba(245,160,90,.20),transparent 70%)}
.k.v::after{background:radial-gradient(circle,rgba(183,168,255,.22),transparent 70%)}
.bar{position:sticky;top:var(--nav);z-index:40;margin:22px 0 0;padding:10px 0;
background:rgba(7,12,24,.86);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
.bar-in{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.seg{display:inline-flex;padding:3px;gap:3px;border-radius:99px;background:var(--surf);border:1px solid var(--line)}
.seg button{border:0;background:none;color:var(--mut);font:inherit;font-size:12px;font-weight:800;padding:6px 13px;border-radius:99px;cursor:pointer;transition:.2s}
.seg button.on{color:#fff;background:linear-gradient(135deg,#4b93ff,var(--blue2));box-shadow:0 3px 10px rgba(63,134,255,.4)}
.seg button:active{transform:scale(.95)}
.fld{display:flex;align-items:center;gap:7px;background:var(--surf);border:1px solid var(--line);border-radius:99px;padding:6px 13px;min-width:0}
.fld svg{width:13px;height:13px;fill:var(--dim);flex:none}
.fld input{border:0;background:none;color:var(--txt);font:inherit;font-size:12.5px;font-weight:600;outline:none;width:150px;min-width:0}
.fld input::placeholder{color:var(--dim)}
select.sel{background:var(--surf);border:1px solid var(--line);color:var(--txt);border-radius:99px;padding:7px 13px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;outline:none}
.chip{border:1px solid var(--line);background:var(--surf);color:var(--mut);border-radius:99px;padding:7px 13px;font:inherit;font-size:12px;font-weight:800;cursor:pointer;transition:.2s}
.chip.on{background:rgba(47,211,154,.14);border-color:rgba(47,211,154,.45);color:var(--green)}
.chip:active{transform:scale(.95)}
.found{margin-left:auto;font-size:11.5px;font-weight:700;color:var(--dim);white-space:nowrap}
h2{font-size:clamp(21px,3.6vw,30px);margin:46px 0 6px;font-weight:900;letter-spacing:-.8px;display:flex;align-items:center;gap:11px}
h2 span.n{flex:none;width:28px;height:28px;border-radius:10px;display:grid;place-items:center;font-size:12px;font-weight:900;color:#fff;
background:linear-gradient(140deg,var(--blue),var(--blue2));box-shadow:0 4px 12px rgba(63,134,255,.4)}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 18px;font-weight:500;max-width:80ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:11px}
.win{position:relative;overflow:hidden;display:flex;gap:12px;align-items:center;padding:13px 15px;border-radius:17px;
border:1px solid var(--line);background:linear-gradient(158deg,var(--surf2),var(--surf));transition:.25s}
.win:hover{border-color:var(--line2);transform:translateY(-2px);box-shadow:0 12px 30px rgba(0,0,0,.35)}
.win .t{flex:none;text-align:center;border-radius:13px;padding:8px 10px;min-width:92px;
background:rgba(63,134,255,.13);border:1px solid rgba(63,134,255,.30)}
.win .t b{display:block;font-size:15px;font-weight:900;color:#9dc4ff;font-variant-numeric:tabular-nums;letter-spacing:-.4px}
.win .t span{display:block;font-size:9px;font-weight:900;color:var(--dim);text-transform:uppercase;letter-spacing:.6px;margin-top:2px}
.win.now .t{background:rgba(47,211,154,.14);border-color:rgba(47,211,154,.36)}
.win.now .t b{color:var(--green)}
.win.tom .t{background:rgba(183,168,255,.14);border-color:rgba(183,168,255,.34)}
.win.tom .t b{color:var(--violet)}
.win .m{min-width:0;flex:1}
.win .m b{display:block;font-size:13.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.win .m span{display:block;font-size:11.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.win .m em{display:block;font-style:normal;font-size:10.5px;color:var(--dim);margin-top:3px}
.win .c{flex:none;text-align:right}
.win .c b{display:block;font-size:18px;font-weight:900;color:var(--green);font-variant-numeric:tabular-nums}
.win .c i{display:block;font-style:normal;font-size:9px;color:var(--dim);font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.chg{display:flex;flex-direction:column;gap:7px}
.cr{display:flex;align-items:center;gap:11px;padding:10px 14px;border-radius:13px;font-size:13px;
border:1px solid var(--line);background:linear-gradient(158deg,var(--surf2),var(--surf))}
.cr i.d{width:9px;height:9px;border-radius:50%;flex:none}
.cr i.d.g{background:var(--green);box-shadow:0 0 10px rgba(47,211,154,.7)}
.cr i.d.r{background:var(--red);box-shadow:0 0 10px rgba(255,107,107,.6)}
.cr .x{min-width:0;flex:1}
.cr .x b{font-weight:800}
.cr .x span{display:block;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cr em{font-style:normal;color:var(--mut);font-weight:800;font-variant-numeric:tabular-nums;flex:none}
.city{border:1px solid var(--line);border-radius:20px;margin-bottom:13px;overflow:hidden;
background:linear-gradient(165deg,var(--surf2),var(--surf))}
.city-h{display:flex;align-items:center;gap:11px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--line);
background:linear-gradient(120deg,rgba(63,134,255,.07),transparent 70%)}
.dot{width:11px;height:11px;border-radius:50%;flex:none}
.dot.g{background:var(--green);box-shadow:0 0 12px rgba(47,211,154,.6)}
.dot.y{background:var(--amber);box-shadow:0 0 12px rgba(245,160,90,.5)}
.dot.r{background:var(--red);box-shadow:0 0 12px rgba(255,107,107,.5)}
.dot.n{background:#5c6f92}
.city-h h3{margin:0;font-size:18px;font-weight:900;letter-spacing:-.4px}
.city-h .reg{font-size:10.5px;color:var(--dim);font-weight:700}
.tag{font-size:10px;font-weight:900;padding:4px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px}
.tag.g{background:rgba(47,211,154,.14);color:var(--green)}
.tag.y{background:rgba(245,160,90,.14);color:var(--amber)}
.tag.r{background:rgba(255,107,107,.14);color:var(--red)}
.tag.n{background:rgba(120,160,235,.10);color:var(--mut)}
.city-h .cnt{margin-left:auto;display:flex;gap:14px;font-size:12px;font-weight:800;color:var(--mut);flex-wrap:wrap}
.city-h .cnt b{color:var(--txt);font-size:15px;font-variant-numeric:tabular-nums}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:660px}
th{position:sticky;top:0;background:#16243d;text-align:left;padding:10px 14px;font-size:9.5px;font-weight:900;
letter-spacing:.8px;text-transform:uppercase;color:var(--mut);white-space:nowrap;border-bottom:1px solid var(--line)}
th.hl{color:#9dc4ff;background:#1a2c4a}
td{padding:10px 14px;border-top:1px solid rgba(120,160,235,.09);vertical-align:middle}
tbody tr:hover td{background:rgba(63,134,255,.06)}
td b{font-weight:800;font-size:13px}
td .ad{display:block;font-size:11px;color:var(--dim);margin-top:1px}
.pill{display:inline-block;border-radius:8px;padding:3px 9px;font-size:11px;font-weight:900;white-space:nowrap}
.pill.y{background:rgba(47,211,154,.15);color:var(--green)}
.pill.n{background:rgba(255,107,107,.14);color:var(--red)}
.pill.u{background:rgba(120,160,235,.09);color:var(--dim)}
.pill.w{background:rgba(245,160,90,.14);color:var(--amber)}
.src{display:block;font-size:9.5px;color:var(--dim);margin-top:2px;white-space:nowrap}
.wt{font-weight:900;color:#9dc4ff;white-space:nowrap;font-variant-numeric:tabular-nums}
.cf{display:flex;align-items:center;gap:7px;margin-top:3px}
.cf .track{width:52px;height:4px;border-radius:99px;background:rgba(120,160,235,.16);overflow:hidden}
.cf .track i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--green),var(--blue));width:0;transition:width 1s cubic-bezier(.2,.8,.2,1)}
.cf span{font-size:10.5px;color:var(--mut);font-weight:800;font-variant-numeric:tabular-nums}
.none{color:var(--dim);font-size:11.5px;font-style:italic}
.idle{margin:10px 2px 4px;border:1px solid var(--line);border-radius:12px;padding:9px 13px;background:rgba(120,160,235,.04)}
.idle summary{cursor:pointer;font-size:12px;font-weight:800;color:var(--mut);list-style:none;display:flex;gap:8px;align-items:center}
.idle summary::-webkit-details-marker{display:none}
.idle summary::before{content:'+';color:var(--blue);font-weight:900}
.idle[open] summary::before{content:'–'}
.idle p{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--dim)}
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:11px}
.pil{padding:16px;border-radius:18px;border:1px solid var(--line);background:linear-gradient(158deg,var(--surf2),var(--surf))}
.pil i{display:grid;place-items:center;width:34px;height:34px;border-radius:12px;margin-bottom:10px}
.pil i svg{width:17px;height:17px;fill:#fff}
.pil.a i{background:linear-gradient(140deg,var(--green),var(--green2))}
.pil.b i{background:linear-gradient(140deg,#4b93ff,var(--blue2))}
.pil.c i{background:linear-gradient(140deg,var(--violet),#7c5cff)}
.pil b{display:block;font-size:14px;font-weight:900;margin-bottom:5px}
.pil p{margin:0;font-size:12.5px;color:var(--mut);line-height:1.5}
.faq{display:flex;flex-direction:column;gap:9px}
details{border:1px solid var(--line);border-radius:16px;padding:13px 16px;background:linear-gradient(158deg,var(--surf2),var(--surf));transition:.2s}
details[open]{border-color:var(--line2)}
summary{cursor:pointer;font-weight:800;font-size:14.5px;list-style:none;display:flex;gap:11px;align-items:center}
summary::-webkit-details-marker{display:none}
summary::before{content:'+';flex:none;width:22px;height:22px;border-radius:8px;display:grid;place-items:center;
background:rgba(63,134,255,.14);color:var(--blue);font-weight:900;font-size:15px;line-height:1}
details[open] summary::before{content:'–'}
details p{margin:11px 0 0;color:var(--mut);font-size:13.5px;line-height:1.6}
.cta{margin:44px 0 0;border-radius:24px;padding:30px 24px;text-align:center;position:relative;overflow:hidden;
border:1px solid var(--line2);background:linear-gradient(135deg,rgba(63,134,255,.24),rgba(47,211,154,.14) 55%,rgba(183,168,255,.20))}
.cta h2{margin:0 0 8px;justify-content:center}
.cta p{color:var(--mut);margin:0 auto 18px;font-size:14px;max-width:60ch}
.cta a{display:inline-flex;align-items:center;gap:9px;padding:14px 28px;border-radius:99px;font-weight:900;font-size:15px;color:#fff;
background:linear-gradient(135deg,#4b93ff,var(--blue2) 60%,#123a9e);box-shadow:0 12px 34px rgba(63,134,255,.5);transition:.2s}
.cta a:hover{transform:translateY(-2px);filter:brightness(1.08)}
.cta a svg{width:16px;height:16px;fill:#fff}
footer{margin-top:40px;padding:22px 0 40px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px;line-height:1.65}
footer b{color:var(--mut)}
footer .row{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;margin-top:10px}
footer button{border:1px solid var(--line);background:var(--surf);color:var(--mut);border-radius:99px;padding:7px 14px;font:inherit;font-size:11.5px;font-weight:800;cursor:pointer}
footer button:hover{color:var(--txt);border-color:var(--line2)}
.rv{opacity:0;transform:translateY(18px);transition:opacity .6s cubic-bezier(.2,.8,.2,1),transform .6s cubic-bezier(.2,.8,.2,1)}
.rv.in{opacity:1;transform:none}
.empty{padding:18px;border-radius:16px;border:1px dashed var(--line2);color:var(--mut);font-size:13px;text-align:center}
@media(max-width:640px){
:root{--nav:58px}
.hd{gap:9px;padding:0 12px}
.logo span{display:none}
.go{padding:8px 12px;font-size:11.5px}
.wrap{padding:0 12px}
.k b{font-size:29px}
.fld input{width:110px}
.found{margin-left:0;width:100%}
.city-h .cnt{margin-left:0;width:100%}
h2{font-size:21px}
}
@media(prefers-reduced-motion:reduce){
body::before{animation:none}.rv{opacity:1;transform:none;transition:none}.eyebrow i{animation:none}
}
`;
const ICON = {
drop: '<svg viewBox="0 0 24 24"><path d="M12 2.6C12 2.6 5 10.6 5 14.6a7 7 0 0 0 14 0C19 10.6 12 2.6 12 2.6Z"/></svg>',
pin: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>',
clock: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 10.6 4 2.3-1 1.7-5-2.9V6h2Z"/></svg>',
check: '<svg viewBox="0 0 24 24"><path d="M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6L20.4 8.2 19 6.8Z"/></svg>',
chart: '<svg viewBox="0 0 24 24"><path d="M4 20h16v2H2V2h2Zm3-3V9h3v8Zm5 0V4h3v13Zm5 0v-6h3v6Z"/></svg>',
search: '<svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"/></svg>',
arrow: '<svg viewBox="0 0 24 24"><path d="M13 5l7 7-7 7-1.4-1.4 4.6-4.6H4v-2h12.2l-4.6-4.6Z"/></svg>'
};
function pill(v) {
const cls = v.v === 1 ? 'y' : v.v === 0 ? 'n' : v.v === -1 ? 'w' : 'u';
const txt = v.v === 1 ? 'есть' : v.v === 0 ? 'нет' : v.v === -1 ? (v.src === 'спорно' ? 'спорно' : 'не точно') : '—';
return '<span class="pill ' + cls + '">' + txt + '</span><span class="src">' + e(v.src) + '</span>';
}
const LEVEL_WORD = { g: 'спокойно', y: 'напряжённо', r: 'дефицит', n: 'мало данных' };
function render(D) {
const RG = D.RG;
const T = D.T, B = D.B;
const st = stamp(B), nxt = hhmm(B + 4 * H), iso = new Date(B).toISOString();
const pageUrl = SITE + '/' + RG.file;
const title = 'Когда привезут бензин ' + RG.where + ' — сводка по АЗС на ' + st + ' МСК';
const desc = RG.descHead + ' на ' + st + ' МСК: АИ-95 есть на ' + T.a95 + ' из ' + T.known + ' АЗС, ' +
T.wins + ' прогнозов окон привоза, ' + T.q + ' АЗС с очередью. ' + T.cities + ' городов: ' + RG.descGeo + '. Обновление каждые 4 часа.';
const kpi =
'<div class="k g rv"><small>АИ-95 есть</small><b data-kpi="95">' + T.a95 + '</b><i>из <span data-kpi="known">' + T.known + '</span> АЗС с данными</i></div>' +
'<div class="k b rv"><small>Окна привоза</small><b>' + T.wins + '</b><i>прогнозов на сегодня и завтра</i></div>' +
'<div class="k y rv"><small>Очереди</small><b>' + T.q + '</b><i>АЗС с очередью сейчас</i></div>' +
'<div class="k v rv"><small>' + RG.kpiCities + '</small><b>' + T.cities + '</b><i>' + T.total + ' заправок в сводке</i></div>';
const wins = D.wins.length ? D.wins.map(w => {
const cls = w.k === 0 ? ' now' : w.k >= 1440 ? ' tom' : '';
const when = w.k === 0 ? 'сейчас' : w.k >= 1440 ? 'завтра' : 'сегодня';
return '<div class="win rv' + cls + '" data-fuel="' + e(w.p.fuel_type) + '">' +
'<div class="t"><b>' + t5(w.p.from_time) + '–' + t5(w.p.to_time) + '</b><span>' + when + '</span></div>' +
'<div class="m"><b>' + e(w.row.name) + '</b><span>' + e(w.city) + '</span>' +
'<em>' + e(w.row.address || 'адрес не указан') + ' · ' + fuelRu(w.p.fuel_type) + '</em></div>' +
'<div class="c"><b>' + w.conf + '%</b><i>увер.</i></div></div>';
}).join('') : '<div class="empty">Прогнозы окон привоза пока накапливаются — история возвратов по станциям ещё короткая.</div>';
const changes = D.changes.length ? D.changes.map(c =>
'<div class="cr rv"><i class="d ' + (c.back ? 'g' : 'r') + '"></i>' +
'<span class="x"><b>' + e(c.city) + '</b> · ' + e(c.name) + ' — ' + e(c.fuel) + (c.back ? ' вернулось' : ' пропало') +
'<span>' + e(c.address || '') + '</span></span><em>' + hhmm(c.t) + '</em></div>').join('')
: '<div class="empty">С начала выпуска изменений не зафиксировано — ' + RG.calm + '.</div>';
const nav = D.cities.map(c => '<a href="#c-' + c.key + '">' + e(c.name) + '</a>').join('');
const cityBlocks = D.cities.map(c => {
const live = c.rows.filter(r => r.pred || r.v92.v !== -2 || r.v95.v !== -2 || r.vdt.v !== -2);
const idle = c.rows.filter(r => !r.pred && r.v92.v === -2 && r.v95.v === -2 && r.vdt.v === -2);
const rows = live.map(r => {
const p = r.pred;
const win = p
? '<span class="wt">' + t5(p.from_time) + '–' + t5(p.to_time) + '</span>' +
'<div class="cf"><span class="track"><i data-w="' + r.conf + '"></i></span><span>' + r.conf + '%</span></div>' +
'<span class="src">' + fuelRu(p.fuel_type) + '</span>'
: '<span class="none">окно копится</span>';
const hay = (r.name + ' ' + r.address + ' ' + r.brand).toLowerCase();
return '<tr data-name="' + e(hay) + '" data-win="' + (p ? 1 : 0) + '" data-f95="' + r.v95.v + '" data-f92="' + r.v92.v + '" data-fdt="' + r.vdt.v + '">' +
'<td><b>' + e(r.name) + '</b><span class="ad">' + e(r.address || 'адрес не указан') + '</span></td>' +
'<td data-col="92">' + pill(r.v92) + '</td>' +
'<td data-col="95">' + pill(r.v95) + '</td>' +
'<td data-col="diesel">' + pill(r.vdt) + '</td>' +
'<td>' + (r.q ? '<span class="pill w">очередь</span>' : '<span class="none">не сообщали</span>') + '</td>' +
'<td>' + win + '</td></tr>';
}).join('');
return '<article class="city rv" id="c-' + c.key + '" data-city="' + c.key + '" data-level="' + c.level + '"' +
' data-known="' + c.known + '" data-a92="' + c.a92 + '" data-a95="' + c.a95 + '" data-adt="' + c.adt + '"' +
' data-wins="' + c.wins.length + '" data-name="' + e(c.name) + '">' +
'<div class="city-h"><span class="dot ' + c.level + '"></span>' +
'<h3>Бензин в ' + e(c.inn) + '</h3><span class="reg">' + e(c.reg) + '</span>' +
'<span class="tag ' + c.level + '">' + LEVEL_WORD[c.level] + '</span>' +
'<span class="cnt"><span>АИ-95 <b class="c-fuel">' + c.a95 + '</b>/' + c.known + '</span>' +
'<span>окон <b>' + c.wins.length + '</b></span><span>очередей <b>' + c.q + '</b></span></span></div>' +
'<div class="tw"><table><thead><tr><th>АЗС и адрес</th><th data-col="92">АИ-92</th>' +
'<th data-col="95" class="hl">АИ-95</th><th data-col="diesel">Дизель</th><th>Очередь</th><th>Окно привоза</th>' +
'</tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="none">Свежих данных по этому городу пока нет</td></tr>') + '</tbody></table></div>' +
(idle.length ? '<details class="idle"><summary>Ещё ' + idle.length + ' АЗС без данных</summary><p>' +
idle.map(r => e(r.name + (r.address ? ' (' + r.address + ')' : ''))).join(', ') + '</p></details>' : '') +
'</article>';
}).join('');
const faq = [
['Где сейчас есть бензин ' + RG.where + '?',
'На ' + st + ' МСК АИ-95 подтверждён на ' + T.a95 + ' из ' + T.known + ' АЗС с данными, АИ-92 — на ' + T.a92 + ', дизель — на ' + T.adt + '. В сводке ' + T.cities + ' городов и ' + T.total + ' заправок ' + RG.genRegion + ': ' + RG.leadGeo + '. Выпуск обновляется каждые 4 часа.'],
['Когда привезут бензин на заправку?',
'Для каждой АЗС считается окно возврата — интервал часов, в который топливо обычно возвращается на эту станцию. Сейчас по региону активно ' + T.wins + ' таких окон. Рядом с окном указана уверенность в процентах: это вероятность по истории станции, а не гарантия привоза.'],
['Что значит «народ» и «с места» в таблице?',
'«Источник» — снимок наличия топлива на АЗС, который мы забираем каждые 10 минут. «Народ» — согласованные отметки самих водителей: два и более разных устройства с одинаковым вердиктом. «С места» — отметка водителя, который физически находился у колонки (GPS в пределах 200 метров): она сильнее устаревших данных источника.'],
['Почему у части станций «нет данных»?',
'Мы не показываем выдуманные статусы. Если источник давно не отдавал станцию и водители о ней не сообщали, честнее написать «нет данных», чем раскрасить пин наугад. Такие станции в таблице помечены прочерком и не участвуют в подсчёте доли топлива.'],
['Чем эта сводка отличается от карты наличия?',
'Карта отвечает на вопрос «где есть сейчас». В глубокий дефицит она вся красная и не подсказывает, что делать. Эта сводка отвечает на вопрос «когда привезут и стоит ли ехать»: по всем городам ' + RG.genRegion + ' сразу, с окнами возврата, очередями и указанием происхождения каждого статуса.']
];
const faqHtml = faq.map(q => '<details class="rv"><summary>' + e(q[0]) + '</summary><p>' + e(q[1]) + '</p></details>').join('');
const ldArticle = {
'@context': 'https://schema.org', '@type': 'Article', headline: title, description: desc,
datePublished: iso, dateModified: iso, inLanguage: 'ru-RU',
author: { '@type': 'Organization', name: 'КогдаБенз', url: SITE + '/' },
publisher: { '@type': 'Organization', name: 'КогдаБенз', logo: { '@type': 'ImageObject', url: SITE + '/icon-192.png' } },
image: SITE + '/icon-512.png',
mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl },
spatialCoverage: D.cities.map(c => c.name)
};
const ldFaq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(q => ({ '@type': 'Question', name: q[0], acceptedAnswer: { '@type': 'Answer', text: q[1] } })) };
const ldBread = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
{ '@type': 'ListItem', position: 1, name: 'КогдаБенз', item: SITE + '/' },
{ '@type': 'ListItem', position: 2, name: RG.bread, item: pageUrl }] };
const island = JSON.stringify({
region: RG.key,
bucket: B,
totals: T,
cities: D.cities.map(c => ({ key: c.key, name: c.name, known: c.known, a92: c.a92, a95: c.a95, adt: c.adt, wins: c.wins.length, level: c.level }))
});
return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${pageUrl}">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<meta property="og:type" content="article"><meta property="og:locale" content="ru_RU">
<meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(desc)}">
<meta property="og:url" content="${pageUrl}"><meta property="og:image" content="${SITE}/icon-512.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#070c18">
<link rel="icon" href="${SITE}/icon-192.png">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(ldArticle)}</script>
<script type="application/ld+json">${JSON.stringify(ldFaq)}</script>
<script type="application/ld+json">${JSON.stringify(ldBread)}</script>
</head><body>
<div class="progress" id="prog"></div>
<header><div class="hd">
<a class="logo" href="${SITE}/"><i>${ICON.drop}</i><span>Когда<b>Бенз</b></span></a>
<nav id="nav">
<a href="#okna">Окна привоза</a><a href="#izmeneniya">Изменения</a><a href="#goroda">Города</a>
<a href="#metod">Как считаем</a><a href="#faq">Вопросы</a>
<a class="x" href="${SITE}/${RG.otherFile}">Сводка: ${RG.otherName}</a>
</nav>
<a class="go" href="${SITE}/">${ICON.pin}Живая карта</a>
</div></header>
<main>
<div class="wrap">
<section class="hero">
<span class="eyebrow"><i></i>Автовыпуск каждые 4 часа</span>
<h1>Когда привезут бензин <em>${RG.h1em || RG.where}</em></h1>
<p class="lead">Общая сводка по всем городам ${RG.genRegion}: где топливо есть сейчас, на каких АЗС очередь и в какие часы ожидается привоз. Не один город — весь ${RG.whole} сразу: ${RG.leadGeo}. Каждый статус подписан: источник, водители или отметка с места.</p>
<div class="stamp"><span>Выпуск <b>${st} МСК</b></span><span class="next" id="next">следующий через —</span>
<span>${T.cities} ${plural(T.cities, ['город', 'города', 'городов'])} · ${T.total} АЗС</span></div>
<div class="kpi">${kpi}</div>
</section>
</div>
<div class="bar"><div class="wrap"><div class="bar-in">
<span class="seg" id="segFuel">
<button data-f="92">АИ-92</button><button data-f="95" class="on">АИ-95</button><button data-f="diesel">Дизель</button>
</span>
<label class="fld">${ICON.search}<input id="q" type="search" placeholder="АЗС или адрес…" autocomplete="off"></label>
<select class="sel" id="sort">
<option value="deficit">сначала дефицит</option><option value="fuel">больше топлива</option>
<option value="wins">больше окон</option><option value="alpha">по алфавиту</option>
</select>
<button class="chip" id="onlyWin">только с окнами</button>
<button class="chip" id="reset">сбросить</button>
<span class="found" id="found"></span>
</div></div></div>
<div class="wrap">
<section id="okna">
<h2><span class="n">1</span>Ближайшие окна привоза</h2>
<p class="sub">Интервалы, в которые топливо обычно возвращается на заправку. Процент — уверенность прогноза по истории станции; она проверяется по фактическим привозам каждую ночь.</p>
<div class="grid" id="wins">${wins}</div>
</section>
<section id="izmeneniya">
<h2><span class="n">2</span>Что изменилось за выпуск</h2>
<p class="sub">События по всем городам ${RG.genRegion} с ${hhmm(B)} МСК: ${D.changeN} ${plural(D.changeN, ['событие', 'события', 'событий'])}.</p>
<div class="chg">${changes}</div>
</section>
<section id="goroda">
<h2><span class="n">3</span>Наличие топлива по городам</h2>
<p class="sub">Сначала города, где напряжённее. По каждой АЗС: марки топлива с происхождением статуса, очередь и окно возврата с уверенностью.</p>
<div id="cities">${cityBlocks}</div>
<div class="empty" id="noRes" style="display:none">Ничего не найдено — измените запрос или сбросьте фильтры.</div>
</section>
<section id="metod">
<h2><span class="n">4</span>Как считается сводка</h2>
<p class="sub">Мы не выдаём желаемое за действительное: у каждого статуса есть происхождение, а у прогноза — измеренная точность.</p>
<div class="pillars">
<div class="pil a rv"><i>${ICON.check}</i><b>Два независимых потока</b><p>Снимки наличия топлива на АЗС каждые 10 минут и отметки самих водителей: «есть», «нет», «очередь», «привезли». Отметка с места по GPS перекрывает устаревшие данные источника.</p></div>
<div class="pil b rv"><i>${ICON.clock}</i><b>Окно, а не обещание</b><p>Окно возврата строится по истории конкретной станции: когда и как часто туда возвращалось топливо. Рядом всегда уверенность в процентах — это вероятность, а не гарантия.</p></div>
<div class="pil c rv"><i>${ICON.chart}</i><b>Ночная проверка</b><p>Каждую ночь вчерашние прогнозы сверяются с фактом. Медианная ошибка и доля попаданий в окно публикуются на сайте открыто — без округлений в свою пользу.</p></div>
</div>
</section>
<section id="faq">
<h2><span class="n">5</span>Частые вопросы</h2>
<div class="faq">${faqHtml}</div>
</section>
<div class="cta rv">
<h2>Проверить свою заправку прямо сейчас</h2>
<p>Живая карта обновляется каждые 10 минут, показывает очереди, расстояния и отправляет уведомление в Telegram, когда топливо вернулось на избранную АЗС.</p>
<a href="${SITE}/">${ICON.arrow}Открыть КогдаБенз</a>
</div>
<footer>
<b>КогдаБенз</b> — карта наличия топлива и прогнозов привоза ${RG.where}. Сводка формируется автоматически каждые 4 часа: 00:00, 04:00, 08:00, 12:00, 16:00 и 20:00 МСК. Прогноз — вероятность, а не гарантия фактического появления топлива. Данные: снимки АЗС и сообщения водителей.
<div class="row"><span>Обновлено ${st} МСК</span><a href="${SITE}/${RG.otherFile}">Сводка: ${RG.otherName}</a><button id="copy">Скопировать ссылку</button><a href="${SITE}/">kogdabenz.ru</a></div>
</footer>
</div>
</main>
<script id="kbData" type="application/json">${island}</script>
<script>
(function(){
'use strict';
var D=JSON.parse(document.getElementById('kbData').textContent);
var fuel='95', onlyWin=false, query='', sort='deficit';
var cities=[].slice.call(document.querySelectorAll('.city'));
var host=document.getElementById('cities');
var found=document.getElementById('found');
var noRes=document.getElementById('noRes');
function key(c){return fuel==='92'?'a92':fuel==='diesel'?'adt':'a95';}
function apply(){
var k=key(c), tot=0, known=0, shownRows=0, shownCities=0;
document.querySelectorAll('[data-col]').forEach(function(el){
el.classList.toggle('hl', el.getAttribute('data-col')===fuel);
});
cities.forEach(function(c){
var rows=[].slice.call(c.querySelectorAll('tbody tr'));
var vis=0;
rows.forEach(function(r){
var ok=true;
if(query && (r.getAttribute('data-name')||'').indexOf(query)<0) ok=false;
if(onlyWin && r.getAttribute('data-win')!=='1') ok=false;
r.style.display=ok?'':'none';
if(ok) vis++;
});
var show=vis>0;
c.style.display=show?'':'none';
if(show){shownCities++;shownRows+=vis;
var n=Number(c.getAttribute('data-'+k));
c.querySelector('.c-fuel').textContent=n;
tot+=n; known+=Number(c.getAttribute('data-known'));
}
});
document.querySelector('[data-kpi="95"]').textContent=tot;
document.querySelector('[data-kpi="known"]').textContent=known;
document.querySelector('.k.g small').textContent=(fuel==='92'?'АИ-92':fuel==='diesel'?'Дизель':'АИ-95')+' есть';
var arr=cities.slice().sort(function(a,b){
if(sort==='alpha') return a.getAttribute('data-name').localeCompare(b.getAttribute('data-name'),'ru');
if(sort==='fuel') return Number(b.getAttribute('data-'+k))-Number(a.getAttribute('data-'+k));
if(sort==='wins') return Number(b.getAttribute('data-wins'))-Number(a.getAttribute('data-wins'));
var la=a.getAttribute('data-level'), lb=b.getAttribute('data-level');
var rank={r:0,y:1,g:2,n:3};
return rank[la]-rank[lb];
});
arr.forEach(function(c){host.appendChild(c);});
document.querySelectorAll('#wins .win').forEach(function(w){
w.style.display=(!fuel||w.getAttribute('data-fuel')===fuel||!document.querySelector('#wins .win[data-fuel="'+fuel+'"]'))?'':'none';
});
found.textContent=(query||onlyWin)?('найдено: '+shownRows+' АЗС в '+shownCities+' гор.'):(shownCities+' городов · '+D.totals.total+' АЗС');
noRes.style.display=shownCities?'none':'';
}
document.getElementById('segFuel').addEventListener('click',function(ev){
var b=ev.target.closest('button'); if(!b) return;
fuel=b.getAttribute('data-f');
[].forEach.call(this.querySelectorAll('button'),function(x){x.classList.toggle('on',x===b);});
apply();
});
document.getElementById('q').addEventListener('input',function(){query=this.value.trim().toLowerCase();apply();});
document.getElementById('sort').addEventListener('change',function(){sort=this.value;apply();});
document.getElementById('onlyWin').addEventListener('click',function(){onlyWin=!onlyWin;this.classList.toggle('on',onlyWin);apply();});
document.getElementById('reset').addEventListener('click',function(){
fuel='95';onlyWin=false;query='';sort='deficit';
document.getElementById('q').value='';document.getElementById('sort').value='deficit';
document.getElementById('onlyWin').classList.remove('on');
[].forEach.call(document.querySelectorAll('#segFuel button'),function(x){x.classList.toggle('on',x.getAttribute('data-f')==='95');});
apply();
});
document.getElementById('copy').addEventListener('click',function(){
var b=this, u=location.href.split('#')[0];
function ok(){b.textContent='Ссылка скопирована';setTimeout(function(){b.textContent='Скопировать ссылку';},2200);}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(ok,ok);}else{ok();}
});
function tick(){
var left=D.bucket+4*3600000-Date.now();
if(left<0)left=0;
var h=Math.floor(left/3600000), m=Math.floor(left%3600000/60000);
document.getElementById('next').textContent='следующий через '+h+':'+String(m).padStart(2,'0');
}
tick();setInterval(tick,30000);
var prog=document.getElementById('prog');
function onScroll(){
var h=document.documentElement.scrollHeight-innerHeight;
prog.style.width=(h>0?Math.min(100,scrollY/h*100):0)+'%';
}
addEventListener('scroll',onScroll,{passive:true});onScroll();
if('IntersectionObserver' in window){
var ro=new IntersectionObserver(function(es){
es.forEach(function(x){ if(x.isIntersecting){ x.target.classList.add('in'); ro.unobserve(x.target);
x.target.querySelectorAll&&x.target.querySelectorAll('.cf .track i').forEach(function(i){i.style.width=i.getAttribute('data-w')+'%';});
}});
},{rootMargin:'0px 0px -8% 0px',threshold:.06});
document.querySelectorAll('.rv').forEach(function(el){ro.observe(el);});
var links=[].slice.call(document.querySelectorAll('#nav a'));
var so=new IntersectionObserver(function(es){
es.forEach(function(x){
if(!x.isIntersecting)return;
links.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+x.target.id);});
});
},{rootMargin:'-72px 0px -70% 0px'});
['okna','izmeneniya','goroda','metod','faq'].forEach(function(id){var s=document.getElementById(id);if(s)so.observe(s);});
}else{
document.querySelectorAll('.rv').forEach(function(el){el.classList.add('in');});
document.querySelectorAll('.cf .track i').forEach(function(i){i.style.width=i.getAttribute('data-w')+'%';});
}
document.querySelectorAll('a[href^="#"]').forEach(function(a){
a.addEventListener('click',function(ev){
var t=document.querySelector(this.getAttribute('href'));
if(!t)return;
ev.preventDefault();
var nav=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav'))||64;
var extra=document.querySelector('.bar')?document.querySelector('.bar').offsetHeight:0;
scrollTo({top:t.getBoundingClientRect().top+scrollY-nav-extra-12,behavior:'smooth'});
});
});
apply();
})();
</script>
</body></html>`;
}
// ---------- публикация ----------
function findSiteDir() {
const cands = [process.env.KB_SITE_DIR, process.env.SVODKA_DIR, process.cwd(), __dirname,
'/var/www/kogdabenz', '/var/www/kogdabenz.ru', '/var/www/html', '/var/www'];
const roots = ['/root', '/home', '/var/www', '/opt'];
for (const r of roots) {
try {
for (const a of fs.readdirSync(r)) {
const p1 = path.join(r, a);
cands.push(p1);
try { for (const b of fs.readdirSync(p1)) cands.push(path.join(p1, b)); } catch (e) {}
}
} catch (e) {}
}
for (const d of cands) {
if (!d) continue;
try {
if (fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, '.git'))) return d;
} catch (e) {}
}
for (const d of cands) {
if (!d) continue;
try { if (fs.existsSync(path.join(d, 'index.html'))) return d; } catch (e) {}
}
return null;
}
function write(dir, name, text) {
const p = path.join(dir, name), tmp = p + '.tmp';
fs.writeFileSync(tmp, text, 'utf8');
fs.renameSync(tmp, p);
}
function git(dir, args) {
return cp.execFileSync('git', ['-C', dir].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function run(opts) {
const force = (opts && opts.force) || process.argv.indexOf('--force') >= 0 || process.env.KB_SVODKA_FORCE === '1';
const B = bucketStart(), bIso = new Date(B).toISOString();
if (!force) {
try {
const g = await api('/rest/v1/bot_meta?key=eq.svodka_bucket&select=value');
if (g.length && g[0].value === bIso) return { skipped: true };
} catch (e) {}
}
const dir = findSiteDir();
if (!dir) {
console.log('   ! Сводки: репозиторий сайта не найден. Клонируй его на VPS и задай KB_SITE_DIR=/путь/репозитория');
return { error: 'no-site-dir' };
}
const isGit = fs.existsSync(path.join(dir, '.git'));
if (isGit) { try { git(dir, ['pull', '--rebase', '--autostash']); } catch (e) {} }
const raw = await fetchRaw();
const logs = [];
for (const RG of REGIONS) {
const D = buildRegion(raw, RG);
write(dir, RG.file, render(D));
write(dir, RG.json, JSON.stringify({
generated: bIso, region: RG.key, totals: D.T,
cities: D.cities.map(c => ({ key: c.key, name: c.name, total: c.total, known: c.known, a92: c.a92, a95: c.a95, adt: c.adt, q: c.q, wins: c.wins.length, level: c.level }))
}, null, 1));
logs.push(RG.key + ': ' + D.T.cities + ' гор., ' + D.T.total + ' АЗС, АИ-95 ' + D.T.a95 + '/' + D.T.known + ', окон ' + D.T.wins);
}
let keep = [];
try {
const old = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
keep = (old.match(/<url>[\s\S]*?<\/url>/g) || []).filter(u => {
const loc = (u.match(/<loc>([^<]+)<\/loc>/) || [])[1] || '';
const bare = loc.replace(/\/$/, '');
return bare !== SITE && bare !== SITE + '/svodka.html' && bare !== SITE + '/svodka-sz.html';
});
} catch (e) {}
write(dir, 'sitemap.xml',
'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
'  <url><loc>' + SITE + '/</loc><lastmod>' + bIso + '</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>\n' +
'  <url><loc>' + SITE + '/svodka.html</loc><lastmod>' + bIso + '</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>\n' +
'  <url><loc>' + SITE + '/svodka-sz.html</loc><lastmod>' + bIso + '</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>\n' +
(keep.length ? keep.map(u => '  ' + u.replace(/\s+/g, ' ').trim()).join('\n') + '\n' : '') +
'</urlset>\n');
const rp = path.join(dir, 'robots.txt');
let body = '';
try { if (fs.existsSync(rp)) body = fs.readFileSync(rp, 'utf8'); } catch (e) {}
const line = 'Sitemap: ' + SITE + '/sitemap.xml';
if (body.indexOf(line) < 0) {
if (body.indexOf('User-agent') < 0) body = 'User-agent: *\nAllow: /\n';
write(dir, 'robots.txt', body.replace(/\s+$/, '') + '\n' + line + '\n');
}
try {
await fetch(API + '/rest/v1/bot_meta?on_conflict=key', {
method: 'POST',
headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates' },
body: JSON.stringify([{ key: 'svodka_bucket', value: bIso, updated_at: new Date().toISOString() }])
});
} catch (e) {}
try {
if (fs.existsSync(path.join(dir, '.git'))) {
const cp = require('child_process');
const gr = c => cp.execSync(c, { cwd: dir, stdio: 'pipe', timeout: 90000 });
gr('git add -A');
try { gr('git -c user.name="kogdabenz-bot" -c user.email="bot@kogdabenz.ru" commit -m "svodka: auto update (south/nw/ch)"'); } catch (e) {}
gr('git push');
console.log(' Сводки: опубликовано в GitHub Pages');
} else {
console.log(' ! Сводки: папка сайта без .git — файлы записаны, но не опубликованы. Задай KB_SITE_DIR/SVODKA_DIR на git-клон репозитория сайта.');
}
} catch (e) { console.log(' ! Сводки: git push не удался: ' + e.message); }
console.log('   Сводки (юг + СЗ): ' + logs.join(' | ') + ' → ' + dir);
return { ok: true, dir: dir, logs: logs };
}
module.exports = { run: run };
if (require.main === module) {
run().then(r => { if (r && r.skipped) console.log('Сводки: выпуск уже собран, ждём следующий 4-часовой слот.'); })
.catch(e => { console.error('❌ Сводки: ' + e.message); process.exit(1); });
}