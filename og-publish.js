'use strict';
// ============================================================
// КогдаБенз · OG-PUBLISH
// Читает уже собранные страницы svodka*.html, достаёт из них
// реальные цифры, рисует OG-картинку 1200×630 (PNG без зависимостей),
// врезает og/twitter-теги с версией против кэша Телеграма и
// публикует всё в репозиторий. Идемпотентно.
//   node og-publish.js [папка_сайта] [--no-git] [--force]
// ============================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const SITE = 'https://kogdabenz.ru';
const ARGS = process.argv.slice(2);
const NO_GIT = ARGS.includes('--no-git');
const FORCE = ARGS.includes('--force');
const DIR_ARG = ARGS.find(a => !a.startsWith('--'));

const C = {
bg0: '#071022', bg1: '#04070f', card: '#0E1A33', ink: '#EEF3FC', mut: '#93A0B8', dim: '#67789A',
line: '#1E2A48', blue: '#4B93FF', blue2: '#2465EE', mint: '#2FD39A', mint2: '#12855C',
amber: '#F5A05A', amber2: '#C26A2A', red: '#EF5350', red2: '#A32B28', violet: '#7C6DFF', steel: '#8FA4C4'
};
const LVL = {
g: { word: 'СПОКОЙНО', col: C.mint, col2: C.mint2 },
y: { word: 'НАПРЯЖЁННО', col: C.amber, col2: C.amber2 },
r: { word: 'ДЕФИЦИТ', col: C.red, col2: C.red2 },
n: { word: 'МАЛО ДАННЫХ', col: C.steel, col2: '#44567A' }
};
const REGION_NAME = { 'svodka': 'ЮГ', 'svodka-sz': 'СЕВЕРО-ЗАПАД', 'svodka-ch': 'ЧУВАШИЯ' };
const CITY_NOM = {
novorossiysk: 'НОВОРОССИЙСК', anapa: 'АНАПА', gelendzhik: 'ГЕЛЕНДЖИК', sochi: 'СОЧИ',
krasnodar: 'КРАСНОДАР', maykop: 'МАЙКОП', rostov: 'РОСТОВ-НА-ДОНУ', stavropol: 'СТАВРОПОЛЬ',
spb: 'САНКТ-ПЕТЕРБУРГ', gatchina: 'ГАТЧИНА', vyborg: 'ВЫБОРГ', kolpino: 'КОЛПИНО',
cheboksary: 'ЧЕБОКСАРЫ', novocheboksarsk: 'НОВОЧЕБОКСАРСК', kanash: 'КАНАШ', alatyr: 'АЛАТЫРЬ',
shumerlya: 'ШУМЕРЛЯ', tsivilsk: 'ЦИВИЛЬСК', mariinskyposad: 'МАРИИНСКИЙ ПОСАД',
kozlovka: 'КОЗЛОВКА', yadrin: 'ЯДРИН'
};

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function strip(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function plural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }

// ---------- PNG ----------
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0);
const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td), 0);
return Buffer.concat([l, td, cr]);
}
function pngEncode(w, h, rgb) {
const st = w * 3, raw = Buffer.alloc((st + 1) * h);
for (let y = 0; y < h; y++) { raw[y * (st + 1)] = 0; rgb.copy(raw, y * (st + 1) + 1, y * st, y * st + st); }
const ih = Buffer.alloc(13);
ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- растр ----------
class R {
constructor(w, h, s) { this.w = w; this.h = h; this.s = s; this.W = w * s; this.H = h * s; this.b = Buffer.alloc(this.W * this.H * 3); }
_put(i, r, g, bl, a) { if (a >= 1) { this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = bl; } else { this.b[i] += (r - this.b[i]) * a; this.b[i + 1] += (g - this.b[i + 1]) * a; this.b[i + 2] += (bl - this.b[i + 2]) * a; } }
vgrad(x, y, w, h, c1, c2) {
const A = hex(c1), B = hex(c2), s = this.s;
const Y0 = Math.max(0, Math.round(y * s)), Y1 = Math.min(this.H, Math.round((y + h) * s));
const X0 = Math.max(0, Math.round(x * s)), X1 = Math.min(this.W, Math.round((x + w) * s)), sp = Math.max(1, Y1 - Y0);
for (let Y = Y0; Y < Y1; Y++) {
const t = (Y - Y0) / sp, r = A[0] + (B[0] - A[0]) * t, g = A[1] + (B[1] - A[1]) * t, bl = A[2] + (B[2] - A[2]) * t;
for (let X = X0; X < X1; X++) { const i = (Y * this.W + X) * 3; this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = bl; }
}
}
rect(x, y, w, h, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; if (A <= 0) return; const s = this.s;
const X0 = Math.max(0, Math.round(x * s)), Y0 = Math.max(0, Math.round(y * s));
const X1 = Math.min(this.W, Math.round((x + w) * s)), Y1 = Math.min(this.H, Math.round((y + h) * s));
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) this._put((Y * this.W + X) * 3, r, g, bl, A);
}
glow(cx, cy, rad, col, ma) {
const [r, g, bl] = hex(col), s = this.s, RR = rad * s, CX = cx * s, CY = cy * s;
const X0 = Math.max(0, Math.round(CX - RR)), X1 = Math.min(this.W, Math.round(CX + RR));
const Y0 = Math.max(0, Math.round(CY - RR)), Y1 = Math.min(this.H, Math.round(CY + RR));
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
const dx = X - CX, dy = Y - CY, d = Math.sqrt(dx * dx + dy * dy); if (d >= RR) continue;
const f = 1 - d / RR; this._put((Y * this.W + X) * 3, r, g, bl, ma * f * f);
}
}
round(x, y, w, h, rad, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; if (A <= 0) return; const s = this.s;
const X0 = Math.max(0, Math.round(x * s)), Y0 = Math.max(0, Math.round(y * s));
const X1 = Math.min(this.W, Math.round((x + w) * s)), Y1 = Math.min(this.H, Math.round((y + h) * s));
const RR = rad * s, L = x * s, T = y * s, Rt = (x + w) * s, Bt = (y + h) * s;
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
let dx = 0, dy = 0;
if (X < L + RR) dx = L + RR - X; else if (X > Rt - RR) dx = X - (Rt - RR);
if (Y < T + RR) dy = T + RR - Y; else if (Y > Bt - RR) dy = Y - (Bt - RR);
if (dx && dy && dx * dx + dy * dy > RR * RR) continue;
this._put((Y * this.W + X) * 3, r, g, bl, A);
}
}
seg(x1, y1, x2, y2, wd, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; if (A <= 0) return; const s = this.s, hw = wd * s / 2;
const X0 = Math.max(0, Math.floor(Math.min(x1, x2) * s - hw - 1)), X1 = Math.min(this.W, Math.ceil(Math.max(x1, x2) * s + hw + 1));
const Y0 = Math.max(0, Math.floor(Math.min(y1, y2) * s - hw - 1)), Y1 = Math.min(this.H, Math.ceil(Math.max(y1, y2) * s + hw + 1));
const ax = x1 * s, ay = y1 * s, vx = x2 * s - ax, vy = y2 * s - ay, l2 = vx * vx + vy * vy || 1;
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
let t = ((X - ax) * vx + (Y - ay) * vy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
const dx = X - (ax + vx * t), dy = Y - (ay + vy * t);
if (dx * dx + dy * dy > hw * hw) continue;
this._put((Y * this.W + X) * 3, r, g, bl, A);
}
}
dot(cx, cy, rad, col, a) { this.seg(cx, cy, cx, cy, rad * 2, col, a); }
poly(pts, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; const s = this.s;
const P = pts.map(p => [p[0] * s, p[1] * s]);
let mn = Infinity, mx = -Infinity; for (const p of P) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; }
const Y0 = Math.max(0, Math.floor(mn)), Y1 = Math.min(this.H, Math.ceil(mx));
for (let Y = Y0; Y < Y1; Y++) {
const yc = Y + 0.5, xs = [];
for (let i = 0; i < P.length; i++) {
const a1 = P[i], b1 = P[(i + 1) % P.length];
if ((a1[1] <= yc && b1[1] > yc) || (b1[1] <= yc && a1[1] > yc)) xs.push(a1[0] + (yc - a1[1]) / (b1[1] - a1[1]) * (b1[0] - a1[0]));
}
xs.sort((m, n) => m - n);
for (let k = 0; k + 1 < xs.length; k += 2) {
const X0 = Math.max(0, Math.round(xs[k])), X1 = Math.min(this.W, Math.round(xs[k + 1]));
for (let X = X0; X < X1; X++) this._put((Y * this.W + X) * 3, r, g, bl, A);
}
}
}
png() {
const s = this.s, w = this.w, h = this.h;
if (s === 1) return pngEncode(w, h, this.b);
const out = Buffer.alloc(w * h * 3), n = s * s;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
let r = 0, g = 0, b = 0;
for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) { const i = ((y * s + dy) * this.W + x * s + dx) * 3; r += this.b[i]; g += this.b[i + 1]; b += this.b[i + 2]; }
const o = (y * w + x) * 3; out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
}
return pngEncode(w, h, out);
}
}

// ---------- штриховый шрифт ----------
const RAW_G = {
'А': '0,10 3,0 6,10|1.2,6.6 4.8,6.6', 'Б': '0,0 0,10 4.4,10 6,8.6 6,6.6 4.4,5.2 0,5.2|0,0 5.6,0',
'В': '0,5.2 0,0 4.4,0 6,1.4 6,3.8 4.4,5.2 0,5.2|4.4,5.2 6,6.6 6,8.6 4.4,10 0,10 0,5.2',
'Г': '0,10 0,0 6,0', 'Д': '0.4,8 1.5,0 5.2,0 5.2,8|0,8 6,8|0.7,8 0.7,10.6|5.3,8 5.3,10.6',
'Е': '6,0 0,0 0,10 6,10|0,5 4.6,5', 'Ё': '6,0 0,0 0,10 6,10|0,5 4.6,5|1.6,-2.4 1.6,-1.8|4.4,-2.4 4.4,-1.8',
'Ж': '3,0 3,10|0,0 3,5 0,10|6,0 3,5 6,10', 'З': '0,1.4 1.4,0 4.6,0 6,1.4 6,3.6 4.6,5 1.9,5|4.6,5 6,6.4 6,8.6 4.6,10 1.4,10 0,8.6',
'И': '0,0 0,10 6,0 6,10', 'Й': '0,0 0,10 6,0 6,10|1.5,-2.4 3,-1.2 4.5,-2.4',
'К': '0,0 0,10|6,0 0,5.4 6,10', 'Л': '0,10 1.5,0 5.5,0 5.5,10', 'М': '0,10 0,0 3,4.8 6,0 6,10',
'Н': '0,0 0,10|6,0 6,10|0,5 6,5', 'О': '1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4 0,1.6 1.6,0',
'П': '0,10 0,0 6,0 6,10', 'Р': '0,10 0,0 4.4,0 6,1.4 6,4 4.4,5.4 0,5.4',
'С': '6,1.6 4.4,0 1.6,0 0,1.6 0,8.4 1.6,10 4.4,10 6,8.4', 'Т': '0,0 6,0|3,0 3,10',
'У': '0,0 3,6 6,0|3,6 1.2,10', 'Ф': '3,0 3,10|3,1.6 1.3,1.6 0,3.2 0,6 1.3,7.6 3,7.6|3,1.6 4.7,1.6 6,3.2 6,6 4.7,7.6 3,7.6',
'Х': '0,0 6,10|6,0 0,10', 'Ц': '0,0 0,9 6,9|6,0 6,11.2', 'Ч': '0,0 0,4.6 1.5,6 6,6|6,0 6,10',
'Ш': '0,0 0,10 6,10 6,0|3,0 3,10', 'Щ': '0,0 0,9.4 6,9.4|3,0 3,9.4|6,0 6,11.4',
'Ъ': '0,0 1.7,0 1.7,10 4.4,10 6,8.6 6,6.6 4.4,5.2 1.7,5.2',
'Ы': '0,0 0,10 3.2,10 4.6,8.6 4.6,6.6 3.2,5.2 0,5.2|6,0 6,10',
'Ь': '0,0 0,10 4.4,10 6,8.6 6,6.6 4.4,5.2 0,5.2',
'Э': '0,1.6 1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4|2.4,5 6,5',
'Ю': '0,0 0,10|0,5 2,5|3.4,0 4.6,0 6,1.6 6,8.4 4.6,10 3.4,10 2,8.4 2,1.6 3.4,0',
'Я': '6,0 6,10|6,0 1.6,0 0,1.4 0,3.6 1.6,5 6,5|2.8,5 0,10',
'0': '1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4 0,1.6 1.6,0', '1': '0.8,1.9 3,0 3,10|1,10 5,10',
'2': '0,1.6 1.6,0 4.4,0 6,1.6 6,3.5 0,10 6,10', '3': '0,0 6,0 3.1,4.2|3.1,4.2 4.6,4.2 6,5.7 6,8.4 4.4,10 1.4,10 0,8.6',
'4': '4.6,10 4.6,0 0,6.7 6,6.7', '5': '6,0 0,0 0,4.3 4.4,4.3 6,5.8 6,8.4 4.4,10 1.4,10 0,8.6',
'6': '5.4,0.5 4,0 1.6,0 0,1.6 0,8.4 1.6,10 4.4,10 6,8.4 6,6.3 4.4,4.8 1.6,4.8 0,6.3',
'7': '0,0 6,0 2.3,10',
'8': '1.7,0 4.3,0 5.7,1.3 5.7,3.5 4.3,4.9 1.7,4.9 0.3,3.5 0.3,1.3 1.7,0|1.7,4.9 4.3,4.9 6,6.4 6,8.5 4.3,10 1.7,10 0,8.5 0,6.4 1.7,4.9',
'9': '0.6,9.5 2,10 4.4,10 6,8.4 6,1.6 4.4,0 1.6,0 0,1.6 0,3.7 1.6,5.2 4.4,5.2 6,3.7',
'.': '3,9.3 3,10', ',': '3,9.3 2.1,11.4', ':': '3,3 3,3.7|3,7 3,7.7', '-': '0.7,5 5.3,5',
'–': '0.2,5 5.8,5', '·': '3,4.6 3,5.4', '/': '5.6,0 0.4,10',
'%': '0.9,0.5 2.1,0.5 2.7,1.2 2.7,2.5 2.1,3.2 0.9,3.2 0.3,2.5 0.3,1.2 0.9,0.5|5.7,0 0.3,10|3.9,6.8 5.1,6.8 5.7,7.5 5.7,8.8 5.1,9.5 3.9,9.5 3.3,8.8 3.3,7.5 3.9,6.8',
'(': '4.2,0 2.2,2.5 2.2,7.5 4.2,10', ')': '1.8,0 3.8,2.5 3.8,7.5 1.8,10',
'+': '3,2.4 3,7.6|0.6,5 5.4,5', '!': '3,0 3,6.6|3,9.3 3,10',
'D': '0,0 0,10 4.2,10 6,8.2 6,1.8 4.2,0 0,0',
'G': '6,1.6 4.4,0 1.6,0 0,1.6 0,8.4 1.6,10 4.4,10 6,8.4 6,5.6 3.4,5.6',
'N': '0,10 0,0 6,10 6,0', 'Z': '0,0 6,0 0,10 6,10', 'U': '0,0 0,8.4 1.6,10 4.4,10 6,8.4 6,0',
'L': '0,0 0,10 6,10', 'I': '3,0 3,10',
'S': '6,1.4 4.4,0 1.6,0 0,1.4 0,3.6 1.6,5 4.4,5 6,6.4 6,8.6 4.4,10 1.6,10 0,8.6',
'F': '6,0 0,0 0,10|0,5 4.4,5', 'V': '0,0 3,10 6,0', 'W': '0,0 1.4,10 3,4.2 4.6,10 6,0',
'J': '5.2,0 5.2,8.4 3.6,10 1.6,10 0,8.4',
'Q': '1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4 0,1.6 1.6,0|4,7.6 6.3,10.6'
};
const LAT = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const NARROW = { '.': 2.4, ',': 2.4, ':': 2.4, '·': 2.4, '!': 2.6, 'I': 2.6, '(': 4.2, ')': 4.2, ' ': 3.4, '-': 5.6, '–': 6.2 };
const G = {};
for (const k in RAW_G) G[k] = RAW_G[k].split('|').map(p => p.trim().split(/\s+/).map(q => q.split(',').map(Number)));
function glyph(ch) { return G[ch] || G[LAT[ch]] || null; }
function cw(ch) { return NARROW[ch] != null ? NARROW[ch] : 6; }
function measure(s, u, tr) { let w = 0; for (let i = 0; i < s.length; i++) w += cw(s[i]) * u + (i ? tr : 0); return w; }
function text(r, str, x, y, size, col, o) {
o = o || {}; const u = size / 10, wt = (o.weight || 1.15) * u, tr = (o.track == null ? 1.5 : o.track) * u;
const s = String(str == null ? '' : str).toUpperCase();
const w = measure(s, u, tr);
let cx = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
const a = o.alpha == null ? 1 : o.alpha;
for (const ch of s) {
const g = glyph(ch);
if (g) for (const pl of g) {
for (let i = 0; i < pl.length - 1; i++) r.seg(cx + pl[i][0] * u, y + pl[i][1] * u, cx + pl[i + 1][0] * u, y + pl[i + 1][1] * u, wt, col, a);
for (let i = 1; i < pl.length - 1; i++) r.dot(cx + pl[i][0] * u, y + pl[i][1] * u, wt / 2, col, a);
}
cx += cw(ch) * u + tr;
}
return w;
}
function fit(r, str, x, y, size, col, o, maxW) {
let s = size; const tr = (o && o.track) == null ? 1.5 : o.track;
while (s > 18 && measure(String(str).toUpperCase(), s / 10, tr * (s / 10)) > maxW) s -= 2;
return text(r, str, x, y, s, col, o);
}
function droplet(r, cx, cy, k, col) {
r.poly([[cx, cy - 11 * k], [cx + 5.4 * k, cy - 2 * k], [cx + 7 * k, cy + 3.4 * k], [cx + 5.2 * k, cy + 8.2 * k],
[cx, cy + 10.4 * k], [cx - 5.2 * k, cy + 8.2 * k], [cx - 7 * k, cy + 3.4 * k], [cx - 5.4 * k, cy - 2 * k]], col);
}

// ---------- карточка ----------
function card(d) {
const W = 1200, H = 630, r = new R(W, H, 3), L = LVL[d.level] || LVL.n;
r.vgrad(0, 0, W, H, C.bg0, C.bg1);
r.glow(1080, 30, 560, L.col, 0.24);
r.glow(60, 620, 470, C.blue2, 0.22);
r.glow(600, 340, 430, C.violet, 0.06);
for (let i = -14; i < 34; i++) r.seg(i * 46, 0, i * 46 + 320, H, 1, '#ffffff', 0.026);
r.vgrad(0, 0, 9, H, L.col, L.col2);
r.round(56, 38, 62, 62, 19, C.blue2);
r.round(56, 38, 62, 38, 19, C.blue, 0.5);
droplet(r, 87, 69, 1.95, '#ffffff');
text(r, 'КОГДАБЕНЗ', 134, 47, 29, C.ink, { weight: 1.75, track: 1.2 });
text(r, 'НАЛИЧИЕ ТОПЛИВА И ОКНА ПРИВОЗА', 134, 86, 13.5, C.mut, { weight: 1.15, track: 1.6 });
const chip = d.kind === 'city' ? 'ГОРОД' : 'РЕГИОН';
const cwid = measure(chip, 1.5, 1.5 * 1.5) + 34;
r.round(1144 - cwid, 50, cwid, 38, 19, L.col, 0.14);
r.round(1144 - cwid, 50, cwid, 38, 19, '#ffffff', 0.04);
text(r, chip, 1144 - cwid / 2, 61, 15, L.col, { weight: 1.6, align: 'center', track: 1.5 });
r.rect(56, 124, 1088, 1.5, C.line);
fit(r, d.place, 56, 146, 64, C.ink, { weight: 2.05, track: 0.7 }, 1088);
text(r, (d.stamp ? d.stamp + ' МСК' : 'СВЕЖАЯ СВОДКА') + ' · ОБНОВЛЕНИЕ КАЖДЫЕ 4 ЧАСА', 58, 224, 17, C.mut, { weight: 1.2, track: 1.4 });
const sw = measure(L.word, 1.8, 1.8 * 1.5) + 52;
r.round(56, 256, sw, 42, 21, L.col, 0.15);
r.dot(80, 277, 6, L.col);
text(r, L.word, 96, 268, 18, L.col, { weight: 1.7, track: 1.5 });
const pct = d.known ? Math.round(d.a95 / d.known * 100) : 0;
text(r, pct + '% АЗС С АИ-95', 1144, 268, 18, C.mut, { weight: 1.5, align: 'right', track: 1.4 });
const tiles = [
{ l: 'АИ-95 ЕСТЬ', v: String(d.a95), s: 'ИЗ ' + d.known + ' С ДАННЫМИ', c: L.col },
{ l: 'ОКНА ПРИВОЗА', v: String(d.wins), s: plural(d.wins, ['ПРОГНОЗ', 'ПРОГНОЗА', 'ПРОГНОЗОВ']).toUpperCase(), c: C.blue },
{ l: 'ОЧЕРЕДИ', v: String(d.q), s: 'АЗС С ОЧЕРЕДЬЮ', c: d.q > 0 ? C.amber : C.steel }
];
tiles.forEach((t, i) => {
const x = 56 + i * 368, y = 316, w = 350, h = 128;
r.round(x, y, w, h, 20, C.card);
r.round(x, y, w, 2.5, 2, t.c, 0.8);
r.round(x, y, w, h, 20, '#ffffff', 0.022);
text(r, t.l, x + 22, y + 20, 13.5, C.mut, { weight: 1.3, track: 1.7 });
text(r, t.v, x + 22, y + 42, 54, t.c, { weight: 2.1, track: 0.3 });
text(r, t.s, x + 22, y + 108, 12, C.dim, { weight: 1.2, track: 1.4 });
});
text(r, 'КАРТА НАЛИЧИЯ · ОДНА ТОЧКА = ОДНА АЗС', 58, 470, 13.5, C.mut, { weight: 1.35, track: 1.8 });
const n = Math.max(0, d.known), lit = Math.max(0, Math.min(n, d.a95));
if (n > 0 && n <= 120) {
const per = n <= 45 ? n : 60, rows = Math.ceil(n / per);
const gap = Math.min(24, 1088 / per), rad = Math.min(8, gap * 0.34);
for (let i = 0; i < n; i++) {
const row = Math.floor(i / per), col = i % per;
const cx = 62 + col * gap + (row === rows - 1 && n % per ? 0 : 0), cy = 506 + row * 26;
if (i < lit) { r.dot(cx, cy, rad, C.mint); r.dot(cx, cy, rad * 0.42, '#ffffff', 0.55); }
else r.dot(cx, cy, rad * 0.82, '#ffffff', 0.13);
}
} else if (n > 120) {
const bw = 1088, bh = 18, bx = 56, by = 502;
r.round(bx, by, bw, bh, 9, '#ffffff', 0.10);
r.round(bx, by, Math.max(10, bw * (lit / n)), bh, 9, C.mint);
text(r, lit + ' ИЗ ' + n, 1144, 530, 15, C.mut, { weight: 1.5, align: 'right', track: 1.3 });
} else {
text(r, 'СВЕЖИХ ОТМЕТОК ПОКА НЕТ', 58, 508, 19, C.dim, { weight: 1.35, track: 1.2 });
}
r.rect(56, 574, 1088, 1.5, C.line);
text(r, 'KOGDABENZ.RU', 56, 590, 19, C.blue, { weight: 1.9, track: 1.4 });
text(r, 'ПРОГНОЗ — ВЕРОЯТНОСТЬ, НЕ ГАРАНТИЯ ПРИВОЗА', 1144, 593, 13, C.dim, { weight: 1.2, align: 'right', track: 1.3 });
return r.png();
}

// ---------- разбор страницы ----------
function numOf(re, html, def) { const m = html.match(re); return m ? Number(m[1]) : def; }
function parse(html, slug) {
const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [, ''])[1];
const ogd = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) || [, ''])[1];
const hay = desc + ' ' + ogd + ' ' + strip(html.slice(0, 60000));
const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
let place = null, kind = 'city';
if (REGION_NAME[slug]) { place = REGION_NAME[slug]; kind = 'region'; }
if (!place) {
const key = slug.replace(/^svodka-/, '');
if (CITY_NOM[key]) place = CITY_NOM[key];
}
if (!place) {
const cr = html.match(/<nav class="crumbs">([\s\S]*?)<\/nav>/i);
if (cr) { const parts = strip(cr[1]).split('/').map(s => s.trim()).filter(Boolean); if (parts.length) place = parts[parts.length - 1].toUpperCase(); }
}
if (!place) {
const h1 = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, ''])[1]);
place = (h1 || title || slug).replace(/^где есть бензин\s*в\s*/i, '').replace(/^бензин\s*в\s*/i, '').split(/[—·:]/)[0].trim().toUpperCase();
}
let a95 = null, known = null;
let m = hay.match(/АИ-95[^0-9]{0,24}(\d+)\s*из\s*(\d+)/i);
if (m) { a95 = Number(m[1]); known = Number(m[2]); }
if (a95 == null) {
const yes = (html.match(/data-f95=["']1["']/g) || []).length;
const tot = (html.match(/<tr\s[^>]*data-name=/g) || []).length;
if (tot) { a95 = yes; known = tot; }
}
if (a95 == null) { a95 = numOf(/АИ-95[^0-9]{0,24}(\d+)/i, hay, 0); known = numOf(/из\s*(\d+)\s*АЗС/i, hay, 0); }
const wins = numOf(/(\d+)\s*прогноз\w*\s*окон/i, hay, numOf(/(\d+)\s*окн/i, hay, 0));
const q = numOf(/(\d+)\s*АЗС\s*с\s*очередью/i, hay, 0);
const sm = hay.match(/(\d{2}\.\d{2}\.\d{4},\s*\d{2}:\d{2})/) || hay.match(/(\d{2}\.\d{2}\.\d{4},\s*\d{2}:\d{2})/);
const stamp = sm ? sm[1].replace(/\s+/g, ' ') : '';
const share = known ? a95 / known : 0;
const level = known < 5 ? 'n' : share >= 0.6 ? 'g' : share >= 0.25 ? 'y' : 'r';
return { place, kind, a95, known, wins, q, stamp, level, title, desc: ogd || desc };
}

// ---------- врезка тегов ----------
function inject(html, d, imgUrl, ver) {
let h = html;
h = h.replace(/<!--ogpub-->[\s\S]*?<!--\/ogpub-->\s*/gi, '');
h = h.replace(/<meta[^>]+property=["']og:(?:title|description|image|image:secure_url|image:type|image:width|image:height|image:alt|type|url|site_name|locale)["'][^>]*>\s*/gi, '');
h = h.replace(/<meta[^>]+name=["']twitter:(?:card|title|description|image|image:alt)["'][^>]*>\s*/gi, '');
h = h.replace(/<meta[^>]+itemprop=["']image["'][^>]*>\s*/gi, '');
h = h.replace(/<link[^>]+rel=["']image_src["'][^>]*>\s*/gi, '');
const title = d.place.charAt(0) + d.place.slice(1).toLowerCase() + ': бензин сегодня — АИ-95 на ' + d.a95 + ' из ' + d.known + ' АЗС';
const desc = 'Сводка на ' + (d.stamp || 'свежие данные') + ' МСК. АИ-95 есть на ' + d.a95 + ' из ' + d.known +
' АЗС с данными, ' + d.wins + ' ' + plural(d.wins, ['прогноз', 'прогноза', 'прогнозов']) + ' привоза, ' + d.q +
' с очередью. Наличие топлива, очереди и окна возврата — на живой карте.';
const url = SITE + '/' + d.file;
const img = imgUrl + '?v=' + ver;
const tags = [
'<meta property="og:type" content="website">',
'<meta property="og:site_name" content="КогдаБенз">',
'<meta property="og:locale" content="ru_RU">',
'<meta property="og:url" content="' + esc(url) + '">',
'<meta property="og:title" content="' + esc(title) + '">',
'<meta property="og:description" content="' + esc(desc) + '">',
'<meta property="og:image" content="' + esc(img) + '">',
'<meta property="og:image:secure_url" content="' + esc(img) + '">',
'<meta property="og:image:type" content="image/png">',
'<meta property="og:image:width" content="1200">',
'<meta property="og:image:height" content="630">',
'<meta property="og:image:alt" content="' + esc(d.place + ' · АИ-95 на ' + d.a95 + ' из ' + d.known + ' АЗС') + '">',
'<meta name="twitter:card" content="summary_large_image">',
'<meta name="twitter:title" content="' + esc(title) + '">',
'<meta name="twitter:description" content="' + esc(desc) + '">',
'<meta name="twitter:image" content="' + esc(img) + '">',
'<link rel="image_src" href="' + esc(img) + '">'
].join('\n');
const block = '<!--ogpub-->\n' + tags + '\n<!--/ogpub-->\n';
if (/<\/head>/i.test(h)) h = h.replace(/<\/head>/i, block + '</head>');
else h = block + h;
return h;
}

// ---------- папка сайта ----------
function findDir() {
const cands = [DIR_ARG, process.env.KB_SITE_DIR, process.env.SVODKA_DIR, process.cwd(), __dirname].filter(Boolean);
for (const d of cands) { try { if (fs.existsSync(path.join(d, 'index.html'))) return d; } catch (e) {} }
for (const root of ['/root', '/home', '/var/www', '/opt']) {
let subs = []; try { subs = fs.readdirSync(root); } catch (e) { continue; }
for (const s of subs) {
const d = path.join(root, s);
try { if (fs.existsSync(path.join(d, 'index.html')) && fs.readdirSync(d).some(f => /^svodka.*\.html$/.test(f))) return d; } catch (e) {}
}
}
for (const d of cands) { try { if (fs.readdirSync(d).some(f => /^svodka.*\.html$/.test(f))) return d; } catch (e) {} }
return null;
}

// ---------- прогон ----------
const dir = findDir();
if (!dir) { console.log('! Папка сайта не найдена. Укажи путь: node og-publish.js /путь/до/сайта'); process.exit(1); }
const files = fs.readdirSync(dir).filter(f => /^svodka[a-z0-9-]*\.html$/i.test(f)).sort();
if (!files.length) { console.log('! В ' + dir + ' нет страниц svodka*.html'); process.exit(1); }
console.log('Папка сайта: ' + dir);
let made = 0, skipped = 0, failed = 0;
for (const f of files) {
try {
const p = path.join(dir, f);
const html = fs.readFileSync(p, 'utf8');
const slug = f.replace(/\.html$/i, '');
const d = parse(html, slug);
d.file = f;
const ver = (d.stamp || '').replace(/[^0-9]/g, '') || String(Date.now());
const pngName = 'og-' + slug + '.png';
const pngPath = path.join(dir, pngName);
const already = html.indexOf('<!--ogpub-->') >= 0 && html.indexOf(pngName + '?v=' + ver) >= 0 && fs.existsSync(pngPath);
if (already && !FORCE) { skipped++; console.log('= ' + f + ' — уже актуально'); continue; }
const buf = card(d);
fs.writeFileSync(pngPath, buf);
fs.writeFileSync(p, inject(html, d, SITE + '/' + pngName, ver));
made++;
console.log('✓ ' + f + ' → ' + pngName + ' ' + Math.round(buf.length / 1024) + ' КБ · ' +
d.place + ' · АИ-95 ' + d.a95 + '/' + d.known + ' · окон ' + d.wins + ' · очередей ' + d.q);
} catch (e) { failed++; console.log('! ' + f + ': ' + e.message); }
}
console.log('Итог: обновлено ' + made + ', без изменений ' + skipped + ', ошибок ' + failed);
if (NO_GIT) { console.log('Публикация пропущена (--no-git).'); process.exit(failed ? 1 : 0); }
if (!fs.existsSync(path.join(dir, '.git'))) {
console.log('! В папке нет .git — файлы записаны, но не опубликованы.');
console.log('  Закоммить вручную: git add -A && git commit -m "og previews" && git push');
process.exit(failed ? 1 : 0);
}
try {
const gr = c => cp.execSync(c, { cwd: dir, stdio: 'pipe', timeout: 120000 });
gr('git add -A');
try { gr('git -c user.name="kogdabenz-bot" -c user.email="bot@kogdabenz.ru" commit -m "og: previews for svodka pages"'); } catch (e) {}
gr('git push');
console.log('Опубликовано в репозиторий.');
} catch (e) {
console.log('! git push не удался: ' + String(e.message).split('\n')[0]);
process.exit(1);
}