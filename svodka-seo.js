'use strict';
// ============================================================
// КогдаБенз · SEO-модуль: городские страницы + OG-картинки.
// Zero-dependency: PNG собирается вручную (zlib), кириллица —
// собственный штриховый шрифт. Данные берутся из buildRegion().
// ============================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SITE = 'https://kogdabenz.ru';
const H = 3600000;
const BUCKET = 4 * H;

const C = {
bg0: '#0b1226', bg1: '#070c1a', card: '#101a33', card2: '#0d1528',
ink: '#eef3fc', mut: '#93a0b8', dim: '#6b7a96', line: '#1e2a48',
blue: '#4b93ff', blue2: '#2465ee', mint: '#2fd39a', mint2: '#12855c',
amber: '#f5a05a', amber2: '#c26a2a', red: '#ef5350', red2: '#a32b28',
violet: '#7c6dff', steel: '#8fa4c4'
};
const LVL = {
g: { word: 'СПОКОЙНО', col: C.mint, col2: C.mint2, ru: 'спокойно' },
y: { word: 'НАПРЯЖЁННО', col: C.amber, col2: C.amber2, ru: 'напряжённо' },
r: { word: 'ДЕФИЦИТ', col: C.red, col2: C.red2, ru: 'дефицит' },
n: { word: 'МАЛО ДАННЫХ', col: C.steel, col2: '#4a5c7a', ru: 'мало данных' }
};
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function esc(s) {
return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function msk(t) { return new Date(t + 3 * H); }
function p2(n) { return String(n).padStart(2, '0'); }
function stamp(t) { const d = msk(t); return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ', ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
function dateRu(t) { const d = msk(t); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
function isoDate(t) { const d = msk(t); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
function t5(v) { return String(v || '').slice(0, 5); }
function fuelName(f) { return f === '92' ? 'АИ-92' : f === '95' ? 'АИ-95' : f === 'diesel' ? 'дизель' : 'топливо'; }
function plural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }
function ago(m) { if (m == null) return ''; if (m < 1) return 'только что'; if (m < 60) return m + ' мин'; if (m < 1440) return Math.round(m / 60) + ' ч'; return Math.round(m / 1440) + ' дн'; }
function winWord(k) { return k === 0 ? 'сейчас' : k >= 1440 ? 'завтра' : k <= 180 ? 'скоро' : 'потом'; }

// ============================================================
// 1. PNG-кодек (RGB, filter 0) — только встроенный zlib
// ============================================================
const CRC_T = (() => {
const t = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
return Buffer.concat([len, td, crc]);
}
function pngEncode(w, h, rgb) {
const stride = w * 3;
const raw = Buffer.alloc((stride + 1) * h);
for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
return Buffer.concat([
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
chunk('IHDR', ihdr),
chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
chunk('IEND', Buffer.alloc(0))
]);
}
function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// ============================================================
// 2. Растр с суперсэмплингом
// ============================================================
class Raster {
constructor(w, h, s) { this.w = w; this.h = h; this.s = s || 3; this.W = w * this.s; this.H = h * this.s; this.b = Buffer.alloc(this.W * this.H * 3); }
rect(x, y, w, h, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; if (A <= 0) return;
const X0 = Math.max(0, Math.round(x * this.s)), Y0 = Math.max(0, Math.round(y * this.s));
const X1 = Math.min(this.W, Math.round((x + w) * this.s)), Y1 = Math.min(this.H, Math.round((y + h) * this.s));
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
const i = (Y * this.W + X) * 3;
if (A >= 1) { this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = bl; }
else { this.b[i] += (r - this.b[i]) * A; this.b[i + 1] += (g - this.b[i + 1]) * A; this.b[i + 2] += (bl - this.b[i + 2]) * A; }
}
}
vgrad(x, y, w, h, c1, c2, a) {
const A = hex(c1), B = hex(c2); const al = a == null ? 1 : a;
const Y0 = Math.max(0, Math.round(y * this.s)), Y1 = Math.min(this.H, Math.round((y + h) * this.s));
const X0 = Math.max(0, Math.round(x * this.s)), X1 = Math.min(this.W, Math.round((x + w) * this.s));
const span = Math.max(1, Y1 - Y0);
for (let Y = Y0; Y < Y1; Y++) {
const t = (Y - Y0) / span;
const r = A[0] + (B[0] - A[0]) * t, g = A[1] + (B[1] - A[1]) * t, bl = A[2] + (B[2] - A[2]) * t;
for (let X = X0; X < X1; X++) {
const i = (Y * this.W + X) * 3;
if (al >= 1) { this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = bl; }
else { this.b[i] += (r - this.b[i]) * al; this.b[i + 1] += (g - this.b[i + 1]) * al; this.b[i + 2] += (bl - this.b[i + 2]) * al; }
}
}
}
glow(cx, cy, rad, col, maxA) {
const [r, g, bl] = hex(col); const s = this.s;
const X0 = Math.max(0, Math.round((cx - rad) * s)), X1 = Math.min(this.W, Math.round((cx + rad) * s));
const Y0 = Math.max(0, Math.round((cy - rad) * s)), Y1 = Math.min(this.H, Math.round((cy + rad) * s));
const R = rad * s, CX = cx * s, CY = cy * s;
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
const dx = X - CX, dy = Y - CY; const d = Math.sqrt(dx * dx + dy * dy); if (d >= R) continue;
const f = 1 - d / R; const A = maxA * f * f;
const i = (Y * this.W + X) * 3;
this.b[i] += (r - this.b[i]) * A; this.b[i + 1] += (g - this.b[i + 1]) * A; this.b[i + 2] += (bl - this.b[i + 2]) * A;
}
}
round(x, y, w, h, rad, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; if (A <= 0) return; const s = this.s;
const X0 = Math.max(0, Math.round(x * s)), Y0 = Math.max(0, Math.round(y * s));
const X1 = Math.min(this.W, Math.round((x + w) * s)), Y1 = Math.min(this.H, Math.round((y + h) * s));
const R = rad * s, L = x * s, T = y * s, Rt = (x + w) * s, Bt = (y + h) * s;
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
let dx = 0, dy = 0;
if (X < L + R) dx = L + R - X; else if (X > Rt - R) dx = X - (Rt - R);
if (Y < T + R) dy = T + R - Y; else if (Y > Bt - R) dy = Y - (Bt - R);
if (dx && dy && (dx * dx + dy * dy) > R * R) continue;
const i = (Y * this.W + X) * 3;
if (A >= 1) { this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = bl; }
else { this.b[i] += (r - this.b[i]) * A; this.b[i + 1] += (g - this.b[i + 1]) * A; this.b[i + 2] += (bl - this.b[i + 2]) * A; }
}
}
seg(x1, y1, x2, y2, wd, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; if (A <= 0) return; const s = this.s;
const hw = wd * s / 2;
const X0 = Math.max(0, Math.floor(Math.min(x1, x2) * s - hw - 1)), X1 = Math.min(this.W, Math.ceil(Math.max(x1, x2) * s + hw + 1));
const Y0 = Math.max(0, Math.floor(Math.min(y1, y2) * s - hw - 1)), Y1 = Math.min(this.H, Math.ceil(Math.max(y1, y2) * s + hw + 1));
const ax = x1 * s, ay = y1 * s, bx = x2 * s, by = y2 * s;
const vx = bx - ax, vy = by - ay; const len2 = vx * vx + vy * vy || 1;
for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
let t = ((X - ax) * vx + (Y - ay) * vy) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
const dx = X - (ax + vx * t), dy = Y - (ay + vy * t);
if (dx * dx + dy * dy > hw * hw) continue;
const i = (Y * this.W + X) * 3;
if (A >= 1) { this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = bl; }
else { this.b[i] += (r - this.b[i]) * A; this.b[i + 1] += (g - this.b[i + 1]) * A; this.b[i + 2] += (bl - this.b[i + 2]) * A; }
}
}
dot(cx, cy, rad, col, a) { this.seg(cx, cy, cx, cy, rad * 2, col, a); }
poly(pts, col, a) {
const [r, g, bl] = hex(col); const A = a == null ? 1 : a; const s = this.s;
const P = pts.map(p => [p[0] * s, p[1] * s]);
let minY = Infinity, maxY = -Infinity;
for (const p of P) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
const Y0 = Math.max(0, Math.floor(minY)), Y1 = Math.min(this.H, Math.ceil(maxY));
for (let Y = Y0; Y < Y1; Y++) {
const yc = Y + 0.5; const xs = [];
for (let i = 0; i < P.length; i++) {
const a1 = P[i], b1 = P[(i + 1) % P.length];
if ((a1[1] <= yc && b1[1] > yc) || (b1[1] <= yc && a1[1] > yc)) xs.push(a1[0] + (yc - a1[1]) / (b1[1] - a1[1]) * (b1[0] - a1[0]));
}
xs.sort((m, n) => m - n);
for (let k = 0; k + 1 < xs.length; k += 2) {
const X0 = Math.max(0, Math.round(xs[k])), X1 = Math.min(this.W, Math.round(xs[k + 1]));
for (let X = X0; X < X1; X++) {
const i = (Y * this.W + X) * 3;
if (A >= 1) { this.b[i] = r; this.b[i + 1] = g; this.b[i + 2] = bl; }
else { this.b[i] += (r - this.b[i]) * A; this.b[i + 1] += (g - this.b[i + 1]) * A; this.b[i + 2] += (bl - this.b[i + 2]) * A; }
}
}
}
}
png() {
const s = this.s, w = this.w, h = this.h;
if (s === 1) return pngEncode(w, h, this.b);
const out = Buffer.alloc(w * h * 3); const n = s * s;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
let r = 0, g = 0, b = 0;
for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
const i = ((y * s + dy) * this.W + (x * s + dx)) * 3;
r += this.b[i]; g += this.b[i + 1]; b += this.b[i + 2];
}
const o = (y * w + x) * 3;
out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
}
return pngEncode(w, h, out);
}
}

// ============================================================
// 3. Штриховый шрифт (кириллица + латиница + цифры)
// ============================================================
const RAW_G = {
'А': '0,10 3,0 6,10|1.2,6.6 4.8,6.6',
'Б': '0,0 0,10 4.4,10 6,8.6 6,6.6 4.4,5.2 0,5.2|0,0 5.6,0',
'В': '0,5.2 0,0 4.4,0 6,1.4 6,3.8 4.4,5.2 0,5.2|4.4,5.2 6,6.6 6,8.6 4.4,10 0,10 0,5.2',
'Г': '0,10 0,0 6,0',
'Д': '0.4,8 1.5,0 5.2,0 5.2,8|0,8 6,8|0.7,8 0.7,10.6|5.3,8 5.3,10.6',
'Е': '6,0 0,0 0,10 6,10|0,5 4.6,5',
'Ё': '6,0 0,0 0,10 6,10|0,5 4.6,5|1.6,-2.4 1.6,-1.8|4.4,-2.4 4.4,-1.8',
'Ж': '3,0 3,10|0,0 3,5 0,10|6,0 3,5 6,10',
'З': '0,1.4 1.4,0 4.6,0 6,1.4 6,3.6 4.6,5 1.9,5|4.6,5 6,6.4 6,8.6 4.6,10 1.4,10 0,8.6',
'И': '0,0 0,10 6,0 6,10',
'Й': '0,0 0,10 6,0 6,10|1.5,-2.4 3,-1.2 4.5,-2.4',
'К': '0,0 0,10|6,0 0,5.4 6,10',
'Л': '0,10 1.5,0 5.5,0 5.5,10',
'М': '0,10 0,0 3,4.8 6,0 6,10',
'Н': '0,0 0,10|6,0 6,10|0,5 6,5',
'О': '1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4 0,1.6 1.6,0',
'П': '0,10 0,0 6,0 6,10',
'Р': '0,10 0,0 4.4,0 6,1.4 6,4 4.4,5.4 0,5.4',
'С': '6,1.6 4.4,0 1.6,0 0,1.6 0,8.4 1.6,10 4.4,10 6,8.4',
'Т': '0,0 6,0|3,0 3,10',
'У': '0,0 3,6 6,0|3,6 1.2,10',
'Ф': '3,0 3,10|3,1.6 1.3,1.6 0,3.2 0,6 1.3,7.6 3,7.6|3,1.6 4.7,1.6 6,3.2 6,6 4.7,7.6 3,7.6',
'Х': '0,0 6,10|6,0 0,10',
'Ц': '0,0 0,9 6,9|6,0 6,11.2',
'Ч': '0,0 0,4.6 1.5,6 6,6|6,0 6,10',
'Ш': '0,0 0,10 6,10 6,0|3,0 3,10',
'Щ': '0,0 0,9.4 6,9.4|3,0 3,9.4|6,0 6,11.4',
'Ъ': '0,0 1.7,0 1.7,10 4.4,10 6,8.6 6,6.6 4.4,5.2 1.7,5.2',
'Ы': '0,0 0,10 3.2,10 4.6,8.6 4.6,6.6 3.2,5.2 0,5.2|6,0 6,10',
'Ь': '0,0 0,10 4.4,10 6,8.6 6,6.6 4.4,5.2 0,5.2',
'Э': '0,1.6 1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4|2.4,5 6,5',
'Ю': '0,0 0,10|0,5 2,5|3.4,0 4.6,0 6,1.6 6,8.4 4.6,10 3.4,10 2,8.4 2,1.6 3.4,0',
'Я': '6,0 6,10|6,0 1.6,0 0,1.4 0,3.6 1.6,5 6,5|2.8,5 0,10',
'0': '1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4 0,1.6 1.6,0',
'1': '0.8,1.9 3,0 3,10|1,10 5,10',
'2': '0,1.6 1.6,0 4.4,0 6,1.6 6,3.5 0,10 6,10',
'3': '0,0 6,0 3.1,4.2|3.1,4.2 4.6,4.2 6,5.7 6,8.4 4.4,10 1.4,10 0,8.6',
'4': '4.6,10 4.6,0 0,6.7 6,6.7',
'5': '6,0 0,0 0,4.3 4.4,4.3 6,5.8 6,8.4 4.4,10 1.4,10 0,8.6',
'6': '5.4,0.5 4,0 1.6,0 0,1.6 0,8.4 1.6,10 4.4,10 6,8.4 6,6.3 4.4,4.8 1.6,4.8 0,6.3',
'7': '0,0 6,0 2.3,10',
'8': '1.7,0 4.3,0 5.7,1.3 5.7,3.5 4.3,4.9 1.7,4.9 0.3,3.5 0.3,1.3 1.7,0|1.7,4.9 4.3,4.9 6,6.4 6,8.5 4.3,10 1.7,10 0,8.5 0,6.4 1.7,4.9',
'9': '0.6,9.5 2,10 4.4,10 6,8.4 6,1.6 4.4,0 1.6,0 0,1.6 0,3.7 1.6,5.2 4.4,5.2 6,3.7',
'.': '3,9.3 3,10',
',': '3,9.3 2.1,11.4',
':': '3,3 3,3.7|3,7 3,7.7',
'-': '0.7,5 5.3,5',
'–': '0.2,5 5.8,5',
'·': '3,4.6 3,5.4',
'/': '5.6,0 0.4,10',
'%': '0.9,0.5 2.1,0.5 2.7,1.2 2.7,2.5 2.1,3.2 0.9,3.2 0.3,2.5 0.3,1.2 0.9,0.5|5.7,0 0.3,10|3.9,6.8 5.1,6.8 5.7,7.5 5.7,8.8 5.1,9.5 3.9,9.5 3.3,8.8 3.3,7.5 3.9,6.8',
'₽': '1.5,10 1.5,0 4.4,0 6,1.4 6,3.7 4.4,5.1 1.5,5.1|0,7.2 4.6,7.2',
'(': '4.2,0 2.2,2.5 2.2,7.5 4.2,10',
')': '1.8,0 3.8,2.5 3.8,7.5 1.8,10',
'+': '3,2.4 3,7.6|0.6,5 5.4,5',
'!': '3,0 3,6.6|3,9.3 3,10',
'?': '0.3,1.5 1.7,0 4.3,0 5.7,1.5 5.7,3.4 3,5.4 3,6.9|3,9.3 3,10',
'D': '0,0 0,10 4.2,10 6,8.2 6,1.8 4.2,0 0,0',
'G': '6,1.6 4.4,0 1.6,0 0,1.6 0,8.4 1.6,10 4.4,10 6,8.4 6,5.6 3.4,5.6',
'N': '0,10 0,0 6,10 6,0',
'Z': '0,0 6,0 0,10 6,10',
'U': '0,0 0,8.4 1.6,10 4.4,10 6,8.4 6,0',
'L': '0,0 0,10 6,10',
'I': '3,0 3,10',
'S': '6,1.4 4.4,0 1.6,0 0,1.4 0,3.6 1.6,5 4.4,5 6,6.4 6,8.6 4.4,10 1.6,10 0,8.6',
'F': '6,0 0,0 0,10|0,5 4.4,5',
'V': '0,0 3,10 6,0',
'W': '0,0 1.4,10 3,4.2 4.6,10 6,0',
'J': '5.2,0 5.2,8.4 3.6,10 1.6,10 0,8.4',
'Q': '1.6,0 4.4,0 6,1.6 6,8.4 4.4,10 1.6,10 0,8.4 0,1.6 1.6,0|4,7.6 6.3,10.6'
};
const LATIN_MAP = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const NARROW = { '.': 2.4, ',': 2.4, ':': 2.4, '·': 2.4, '!': 2.6, 'I': 2.6, '(': 4.2, ')': 4.2, ' ': 3.4, '-': 5.6, '–': 6.2 };
const GLYPH = {};
for (const k in RAW_G) {
GLYPH[k] = RAW_G[k].split('|').map(pl => pl.trim().split(/\s+/).map(pt => pt.split(',').map(Number)));
}
function glyphOf(ch) { return GLYPH[ch] || GLYPH[LATIN_MAP[ch]] || null; }
function charW(ch) { return NARROW[ch] != null ? NARROW[ch] : 6; }
function measure(s, u, tr) { let w = 0; for (let i = 0; i < s.length; i++) w += charW(s[i]) * u + (i ? tr : 0); return w; }
function text(r, str, x, y, size, col, opt) {
opt = opt || {};
const u = size / 10, wt = (opt.weight || 1.15) * u, tr = (opt.track == null ? 1.5 : opt.track) * u;
const s = String(str == null ? '' : str).toUpperCase();
const w = measure(s, u, tr);
let cx = opt.align === 'right' ? x - w : opt.align === 'center' ? x - w / 2 : x;
const a = opt.alpha == null ? 1 : opt.alpha;
for (const ch of s) {
const g = glyphOf(ch);
if (g) {
for (const pl of g) {
for (let i = 0; i < pl.length - 1; i++) r.seg(cx + pl[i][0] * u, y + pl[i][1] * u, cx + pl[i + 1][0] * u, y + pl[i + 1][1] * u, wt, col, a);
for (let i = 1; i < pl.length - 1; i++) r.dot(cx + pl[i][0] * u, y + pl[i][1] * u, wt / 2, col, a);
}
}
cx += charW(ch) * u + tr;
}
return w;
}
function fitText(r, str, x, y, size, col, opt, maxW) {
let s = size;
const u0 = s / 10, tr0 = ((opt && opt.track) == null ? 1.5 : opt.track) * u0;
while (s > 16 && measure(String(str).toUpperCase(), s / 10, ((opt && opt.track) == null ? 1.5 : opt.track) * (s / 10)) > maxW) s -= 2;
return text(r, str, x, y, s, col, opt);
}
function clip(str, max) { const s = String(str || ''); return s.length > max ? s.slice(0, max - 1) + '…' : s; }

// ============================================================
// 4. OG-картинка 1200×630
// ============================================================
function droplet(r, cx, cy, k, col) {
r.poly([[cx, cy - 11 * k], [cx + 5.4 * k, cy - 2 * k], [cx + 7 * k, cy + 3.4 * k], [cx + 5.2 * k, cy + 8.2 * k],
[cx, cy + 10.4 * k], [cx - 5.2 * k, cy + 8.2 * k], [cx - 7 * k, cy + 3.4 * k], [cx - 5.4 * k, cy - 2 * k]], col);
}
function ogCard(d) {
const W = 1200, Hh = 630;
const r = new Raster(W, Hh, 3);
const L = LVL[d.level] || LVL.n;
r.vgrad(0, 0, W, Hh, C.bg0, C.bg1);
r.glow(1090, 40, 540, L.col, 0.26);
r.glow(70, 620, 460, C.blue2, 0.20);
r.glow(620, 330, 420, C.violet, 0.07);
for (let i = -14; i < 34; i++) r.seg(i * 46, 0, i * 46 + 320, Hh, 1, '#ffffff', 0.028);
r.vgrad(0, 0, 9, Hh, L.col, L.col2);
r.round(56, 40, 64, 64, 19, C.blue2);
r.round(56, 40, 64, 40, 19, C.blue, 0.55);
droplet(r, 88, 72, 2.0, '#ffffff');
text(r, 'КОГДАБЕНЗ', 138, 50, 30, C.ink, { weight: 1.7, track: 1.2 });
text(r, 'ГДЕ ЕСТЬ БЕНЗИН · ОБНОВЛЕНИЕ КАЖДЫЕ 4 ЧАСА', 138, 90, 14, C.mut, { weight: 1.15, track: 1.6 });
const rw = measure(String(d.region).toUpperCase(), 1.6, 1.6 * 1.6) + 34;
r.round(1144 - rw, 52, rw, 40, 20, L.col, 0.14);
r.round(1144 - rw, 52, rw, 40, 20, '#ffffff', 0.04);
text(r, d.region, 1144 - rw / 2, 64, 16, L.col, { weight: 1.6, align: 'center', track: 1.6 });
r.rect(56, 128, 1088, 1.5, C.line);
fitText(r, d.title, 56, 152, 62, C.ink, { weight: 2.0, track: 0.8 }, 1088);
text(r, d.stamp + ' МСК · ВЫПУСК СВОДКИ', 58, 228, 18, C.mut, { weight: 1.2, track: 1.5 });
const sw = measure(L.word, 1.8, 1.8 * 1.5) + 52;
r.round(56, 262, sw, 42, 21, L.col, 0.15);
r.dot(80, 283, 6, L.col);
text(r, L.word, 96, 274, 18, L.col, { weight: 1.7, track: 1.5 });
const tiles = [
{ lab: 'АИ-95 ЕСТЬ', big: String(d.a95), sub: 'ИЗ ' + d.known + ' АЗС С ДАННЫМИ', col: L.col },
{ lab: 'ОКНА ПРИВОЗА', big: String(d.wins), sub: 'ПРОГНОЗОВ ВОЗВРАТА', col: C.blue },
{ lab: 'ОЧЕРЕДИ', big: String(d.q), sub: 'АЗС С ОЧЕРЕДЬЮ СЕЙЧАС', col: d.q > 0 ? C.amber : C.steel }
];
tiles.forEach((t, i) => {
const x = 56 + i * 368, y = 322, w = 350, h = 132;
r.round(x, y, w, h, 20, C.card);
r.round(x, y, w, 2.5, 2, t.col, 0.75);
r.round(x, y, w, h, 20, '#ffffff', 0.022);
text(r, t.lab, x + 22, y + 22, 14, C.mut, { weight: 1.3, track: 1.7 });
text(r, t.big, x + 22, y + 46, 56, t.col, { weight: 2.1, track: 0.4 });
text(r, t.sub, x + 22, y + 112, 12.5, C.dim, { weight: 1.2, track: 1.4 });
});
text(r, 'БЛИЖАЙШИЕ ОКНА ПРИВОЗА', 58, 478, 14, C.mut, { weight: 1.35, track: 1.8 });
const rows = (d.rows || []).slice(0, 2);
if (!rows.length) {
text(r, 'ОКОН ПОКА НЕТ — ПРОГНОЗЫ КОПЯТСЯ ПО МЕРЕ НАБЛЮДЕНИЙ', 58, 512, 19, C.dim, { weight: 1.3, track: 1.2 });
} else {
rows.forEach((w, i) => {
const y = 506 + i * 36;
r.dot(64, y + 10, 4, i === 0 ? C.mint : C.steel);
fitText(r, clip(w.name + (w.addr ? ' · ' + w.addr : ''), 46), 82, y, 21, C.ink, { weight: 1.4, track: 0.6 }, 700);
text(r, w.time + '  ' + w.conf + '%', 1144, y, 21, C.mint, { weight: 1.8, align: 'right', track: 0.6 });
});
}
r.rect(56, 578, 1088, 1.5, C.line);
text(r, 'KOGDABENZ.RU', 56, 592, 19, C.blue, { weight: 1.9, track: 1.4 });
text(r, 'ПРОГНОЗ — ВЕРОЯТНОСТЬ, НЕ ГАРАНТИЯ ПРИВОЗА', 1144, 595, 13, C.dim, { weight: 1.2, align: 'right', track: 1.3 });
return r.png();
}

// ============================================================
// 5. Городская страница
// ============================================================
const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
--bg:#070c1a;--bg2:#0b1226;--surf:#101a33;--surf2:#0d1528;--over:#16223f;
--ink:#eef3fc;--mut:#93a0b8;--dim:#6b7a96;--line:rgba(148,180,255,.16);--line2:rgba(148,180,255,.09);
--blue:#4b93ff;--blue2:#2465ee;--mint:#2fd39a;--mint2:#12855c;--amber:#f5a05a;--red:#ef5350;--violet:#7c6dff;--steel:#8fa4c4;
--r:20px;--rs:14px;--nav:64px;
}
html{scroll-behavior:smooth;scroll-padding-top:calc(var(--nav) + 18px);background:var(--bg);scrollbar-color:#3f74d6 rgba(148,180,255,.10);scrollbar-width:thin}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
color:var(--ink);background:var(--bg);line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;z-index:-2;pointer-events:none;
background:radial-gradient(900px 520px at 88% -10%,rgba(36,101,238,.30),transparent 62%),
radial-gradient(760px 480px at 6% 8%,rgba(124,109,255,.18),transparent 60%),
radial-gradient(900px 600px at 50% 108%,rgba(25,183,122,.14),transparent 62%),
linear-gradient(180deg,#0d1526,#070c1a 62%,#05080f)}
body::after{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5;
background-image:repeating-linear-gradient(115deg,rgba(255,255,255,.028) 0 1px,transparent 1px 7px)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:rgba(148,180,255,.07)}
::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#4b93ff,#2465ee);border-radius:99px;border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,#7db4ff,#3f74d6);background-clip:padding-box}
a{color:var(--blue);text-decoration:none}
a:hover{color:#7db4ff}
:focus-visible{outline:2px solid var(--blue);outline-offset:3px;border-radius:8px}
.wrap{width:min(1120px,100% - 32px);margin-inline:auto}
header.top{position:sticky;top:0;z-index:50;height:var(--nav);display:flex;align-items:center;
background:rgba(9,14,30,.82);backdrop-filter:blur(18px) saturate(1.5);-webkit-backdrop-filter:blur(18px) saturate(1.5);
border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:12px;width:min(1120px,100% - 32px)}
.brand{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.brand .tile{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;flex:none;
background:linear-gradient(140deg,#4b93ff,#1746c8);box-shadow:0 4px 14px rgba(36,101,238,.45)}
.brand .tile svg{width:17px;height:17px;fill:#fff}
.brand b{font-size:16px;font-weight:900;letter-spacing:-.3px;color:var(--ink);white-space:nowrap}
.brand b i{font-style:normal;color:var(--blue)}
.brand small{display:block;font-size:9px;font-weight:800;letter-spacing:.14em;color:var(--dim);text-transform:uppercase}
.top-cta{flex:none;display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:12px;font-size:12.5px;font-weight:800;
color:#fff;background:linear-gradient(135deg,#2fd39a,#12855c);box-shadow:0 5px 16px rgba(25,183,122,.35);transition:transform .15s,box-shadow .2s}
.top-cta:hover{color:#fff;transform:translateY(-1px);box-shadow:0 8px 22px rgba(25,183,122,.45)}
.top-cta svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
main{padding:26px 0 60px}
.crumbs{display:flex;flex-wrap:wrap;gap:7px;font-size:11.5px;font-weight:700;color:var(--dim);margin-bottom:18px}
.crumbs a{color:var(--mut)}
.crumbs span{opacity:.5}
.rise{opacity:0;transform:translateY(14px);animation:rise .6s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes rise{to{opacity:1;transform:none}}
.card{background:linear-gradient(165deg,var(--surf),var(--surf2));border:1px solid var(--line);border-radius:var(--r);
box-shadow:0 10px 34px rgba(3,7,18,.5)}
.hero{padding:26px 24px 24px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;inset:0;pointer-events:none;
background:radial-gradient(520px 240px at 96% -20%,var(--acc-soft),transparent 70%)}
.eyebrow{position:relative;display:inline-flex;align-items:center;gap:8px;font-size:10.5px;font-weight:900;letter-spacing:.16em;
text-transform:uppercase;color:var(--mut);margin:0 0 12px}
.eyebrow i{width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 4px var(--acc-soft);animation:blip 2.4s ease-in-out infinite}
@keyframes blip{0%,100%{opacity:1}50%{opacity:.35}}
h1{position:relative;margin:0 0 12px;font-size:clamp(27px,5.4vw,46px);line-height:1.08;font-weight:900;letter-spacing:-1.2px}
h1 em{font-style:normal;background:linear-gradient(100deg,var(--acc),#ffffff 78%);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{position:relative;margin:0 0 18px;font-size:15px;color:#c3cfe4;max-width:70ch}
.lead b{color:var(--ink);font-weight:800}
.status{position:relative;display:inline-flex;align-items:center;gap:10px;padding:9px 16px 9px 13px;border-radius:99px;
background:var(--acc-soft);border:1px solid var(--acc-line);font-size:12.5px;font-weight:800;color:var(--acc);margin-bottom:20px}
.status i{width:9px;height:9px;border-radius:50%;background:var(--acc);flex:none}
.status span{color:var(--mut);font-weight:600}
.kpis{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.kpi{padding:14px 15px;border-radius:var(--rs);background:rgba(148,180,255,.055);border:1px solid var(--line2);position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;left:0;top:0;width:100%;height:2px;background:var(--k)}
.kpi small{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
.kpi b{display:block;font-size:34px;font-weight:900;line-height:1.1;letter-spacing:-1.6px;color:var(--k);font-variant-numeric:tabular-nums;margin-top:4px}
.kpi i{display:block;font-style:normal;font-size:10.5px;color:var(--dim);font-weight:600}
.hero-cta{position:relative;display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:13px;font-size:13px;font-weight:800;
border:1px solid var(--line);background:rgba(148,180,255,.07);color:var(--ink);transition:transform .15s,background .2s,border-color .2s}
.btn:hover{transform:translateY(-1px);background:rgba(148,180,255,.13);color:var(--ink);border-color:rgba(148,180,255,.3)}
.btn.pri{background:linear-gradient(135deg,#4b93ff,#1746c8);border-color:transparent;color:#fff;box-shadow:0 6px 20px rgba(36,101,238,.4)}
.btn.pri:hover{color:#fff;box-shadow:0 10px 26px rgba(36,101,238,.5)}
.btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}
section{margin-top:22px}
.sec-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 12px;padding:0 4px}
.sec-h h2{margin:0;font-size:19px;font-weight:900;letter-spacing:-.4px}
.sec-h p{margin:0;font-size:11.5px;color:var(--dim);font-weight:600}
.wins{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:10px}
.win{padding:15px 16px;border-radius:var(--rs);background:linear-gradient(160deg,rgba(47,211,154,.11),rgba(47,211,154,.03));
border:1px solid rgba(47,211,154,.26);position:relative;overflow:hidden;transition:transform .16s,border-color .2s}
.win:hover{transform:translateY(-2px);border-color:rgba(47,211,154,.5)}
.win .t{display:flex;align-items:center;justify-content:space-between;gap:10px}
.win .time{font-size:23px;font-weight:900;letter-spacing:-1px;color:var(--mint);font-variant-numeric:tabular-nums}
.win .badge{font-size:9.5px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;padding:4px 9px;border-radius:99px;
background:rgba(47,211,154,.18);color:var(--mint)}
.win .badge.now{background:rgba(47,211,154,.3);color:#c9f7e4}
.win .nm{margin-top:8px;font-size:14px;font-weight:800}
.win .ad{font-size:11.5px;color:var(--mut)}
.win .meta{margin-top:9px;display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;color:var(--mut)}
.win .bar{flex:1;height:5px;border-radius:99px;background:rgba(148,180,255,.14);overflow:hidden}
.win .bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2fd39a,#7db4ff)}
.empty{padding:26px 20px;text-align:center;color:var(--mut);font-size:13px;border:1px dashed var(--line);border-radius:var(--rs);background:rgba(148,180,255,.03)}
.tools{display:flex;flex-wrap:wrap;gap:9px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line2)}
.seg{display:inline-flex;padding:3px;gap:3px;border-radius:12px;background:rgba(148,180,255,.07);border:1px solid var(--line2)}
.seg button{border:0;background:transparent;color:var(--mut);font:inherit;font-size:12px;font-weight:800;padding:7px 13px;border-radius:9px;cursor:pointer;transition:.18s}
.seg button:hover{color:var(--ink)}
.seg button.on{background:linear-gradient(135deg,#4b93ff,#2465ee);color:#fff;box-shadow:0 3px 10px rgba(36,101,238,.4)}
.search{flex:1;min-width:170px;display:flex;align-items:center;gap:8px;padding:8px 13px;border-radius:12px;
background:rgba(148,180,255,.06);border:1px solid var(--line2)}
.search svg{width:14px;height:14px;flex:none;fill:none;stroke:var(--dim);stroke-width:2.2;stroke-linecap:round}
.search input{flex:1;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;font-size:12.5px;outline:none}
.search input::placeholder{color:var(--dim)}
select.sort{padding:9px 12px;border-radius:12px;background:rgba(148,180,255,.06);border:1px solid var(--line2);color:var(--ink);font:inherit;font-size:12px;font-weight:700;cursor:pointer}
select.sort option{background:#101a33;color:#eef3fc}
.tgl{display:inline-flex;align-items:center;gap:8px;padding:9px 13px;border-radius:12px;background:rgba(148,180,255,.06);
border:1px solid var(--line2);font-size:12px;font-weight:800;color:var(--mut);cursor:pointer;user-select:none;transition:.18s}
.tgl:hover{color:var(--ink)}
.tgl.on{background:rgba(47,211,154,.14);border-color:rgba(47,211,154,.4);color:var(--mint)}
.tgl i{width:15px;height:15px;border-radius:5px;border:1.6px solid currentColor;display:grid;place-items:center;font-style:normal;font-size:10px;line-height:1}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{position:sticky;top:var(--nav);z-index:5;background:#0e1730;text-align:left;padding:11px 14px;font-size:10px;font-weight:900;
letter-spacing:.1em;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:12px 14px;border-bottom:1px solid var(--line2);vertical-align:middle}
tbody tr{transition:background .16s}
tbody tr:hover{background:rgba(148,180,255,.05)}
tbody tr:last-child td{border-bottom:0}
.st b{display:block;font-size:13.5px;font-weight:800}
.st .ad{display:block;font-size:11px;color:var(--mut)}
.st .br{display:inline-block;margin-top:3px;font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.pill{display:inline-flex;flex-direction:column;gap:1px;min-width:78px;padding:6px 10px;border-radius:10px;font-size:11.5px;font-weight:800;line-height:1.25}
.pill i{font-style:normal;font-size:9px;font-weight:700;opacity:.72}
.pill.y{background:rgba(47,211,154,.15);color:var(--mint)}
.pill.n{background:rgba(239,83,80,.14);color:#ff8b86}
.pill.w{background:rgba(245,160,90,.15);color:var(--amber)}
.pill.u{background:rgba(148,180,255,.08);color:var(--steel)}
.qy{color:var(--amber);font-weight:800;font-size:12px}
.qn{color:var(--dim);font-size:11.5px}
.wt{font-weight:900;color:var(--mint);font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
.wt small{display:block;font-size:9.5px;font-weight:700;color:var(--mut)}
.wn{color:var(--dim);font-size:11.5px}
.count{padding:11px 16px;font-size:11.5px;color:var(--dim);font-weight:700;border-top:1px solid var(--line2)}
.faq{display:flex;flex-direction:column;gap:9px}
details{border:1px solid var(--line);border-radius:var(--rs);background:linear-gradient(165deg,var(--surf),var(--surf2));overflow:hidden}
summary{cursor:pointer;padding:15px 18px;font-size:14px;font-weight:800;list-style:none;display:flex;align-items:center;gap:12px}
summary::-webkit-details-marker{display:none}
summary::after{content:'+';margin-left:auto;font-size:19px;font-weight:800;color:var(--blue);transition:transform .22s}
details[open] summary::after{transform:rotate(45deg)}
details[open] summary{border-bottom:1px solid var(--line2)}
.faq-a{padding:14px 18px;font-size:13.5px;color:#c3cfe4}
.faq-a b{color:var(--ink)}
.cities{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:9px}
.city-link{display:flex;align-items:center;gap:10px;padding:13px 15px;border-radius:var(--rs);border:1px solid var(--line2);
background:rgba(148,180,255,.045);color:var(--ink);transition:transform .15s,border-color .2s,background .2s}
.city-link:hover{transform:translateY(-2px);border-color:rgba(75,147,255,.45);background:rgba(75,147,255,.1);color:var(--ink)}
.city-link i{width:8px;height:8px;border-radius:50%;flex:none}
.city-link b{flex:1;min-width:0;font-size:13px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.city-link small{font-size:10.5px;font-weight:800;color:var(--mut);font-variant-numeric:tabular-nums}
.method{padding:20px 22px}
.method h2{margin:0 0 12px;font-size:17px;font-weight:900}
.method ul{margin:0;padding:0;list-style:none;display:grid;gap:10px}
.method li{display:flex;gap:11px;font-size:13px;color:#c3cfe4}
.method li i{flex:none;width:9px;height:9px;border-radius:50%;margin-top:6px}
.method .note{margin-top:14px;padding:12px 14px;border-radius:12px;background:rgba(245,160,90,.09);border:1px solid rgba(245,160,90,.24);
font-size:12px;color:#f0c9a4}
footer{border-top:1px solid var(--line);padding:26px 0 40px;margin-top:34px}
footer .wrap{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between}
footer .l{font-size:12px;color:var(--dim)}
footer .l b{display:block;color:var(--mut);font-size:13px;font-weight:800;margin-bottom:3px}
footer nav{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;font-weight:700}
@media (max-width:860px){
.kpis{grid-template-columns:repeat(2,1fr)}
thead{display:none}
table,tbody,tr,td{display:block;width:100%}
tbody tr{padding:13px 14px;border-bottom:1px solid var(--line2)}
tbody tr:hover{background:transparent}
tbody td{padding:0;border:0}
tbody td.st{margin-bottom:9px}
tbody td[data-col]{display:inline-block;width:auto;margin:0 6px 6px 0}
tbody td.cq,tbody td.cw{display:inline-block;width:auto;margin-right:12px;margin-top:2px}
.pill{min-width:0}
.pill b::before{content:attr(data-f) ' '}
}
@media (max-width:520px){
.hero{padding:20px 16px}
.kpi b{font-size:28px}
.wrap{width:min(1120px,100% - 22px)}
.top-cta span{display:none}
.top-cta{padding:9px 12px}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
html{scroll-behavior:auto}
.rise{opacity:1;transform:none}
}
`;

const SVG_DROP = '<svg viewBox="0 0 24 24"><path d="M12 2.6C12 2.6 5 10.6 5 14.6a7 7 0 0 0 14 0C19 10.6 12 2.6 12 2.6Z"/></svg>';
const SVG_PIN = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
const SVG_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>';
const SVG_ARROW = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

function pillHtml(v, f) {
const val = v && typeof v.v === 'number' ? v.v : -2;
const cls = val === 1 ? 'y' : val === 0 ? 'n' : val === -1 ? 'w' : 'u';
const word = val === 1 ? 'есть' : val === 0 ? 'нет' : val === -1 ? 'не точно' : 'нет данных';
let sub = '';
if (val !== -2 && v && v.src) sub = '<i>' + esc(v.src) + (v.m != null ? ' · ' + ago(v.m) : '') + '</i>';
return '<span class="pill ' + cls + '"><b data-f="' + fuelName(f) + '">' + word + '</b>' + sub + '</span>';
}
function lvlOf(share, known, cover) {
if (known < 5 || cover < 0.2) return 'n';
if (share >= 0.6) return 'g';
if (share >= 0.25) return 'y';
return 'r';
}
function accVars(level) {
const L = LVL[level] || LVL.n;
const rgb = hex(L.col);
return '--acc:' + L.col + ';--acc-soft:rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.13);--acc-line:rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.36)';
}

function cityPage(c, cap) {
const RG = cap.RG;
const t = cap.t;
const st = stamp(t);
const level = c.level || lvlOf(c.share || 0, c.known, c.cover || 0);
const L = LVL[level] || LVL.n;
const url = SITE + '/svodka-' + c.key + '.html';
const og = SITE + '/og-' + c.key + '.png';
const regUrl = SITE + '/' + RG.file;
const wins = (c.wins || []).slice().sort((a, b) => a.k - b.k);
const rows = c.rows || [];
const title = 'Бензин в ' + c.inn + ' сегодня: АИ-95 на ' + c.a95 + ' из ' + c.known + ' АЗС';
const desc = 'Обновлено ' + st + ' МСК. Где есть АИ-92, АИ-95 и дизель в ' + c.inn + ': ' + c.known + ' АЗС с данными, ' +
wins.length + ' ' + plural(wins.length, ['прогноз', 'прогноза', 'прогнозов']) + ' привоза, ' + c.q + ' с очередью. Ближайшие окна возврата топлива и живая карта.';

const topYes = rows.filter(r => r.v95 && r.v95.v === 1).slice(0, 3).map(r => r.name);
const near = wins[0];
const faq = [
{
q: 'Где сейчас есть АИ-95 в ' + c.inn + '?',
a: c.a95 > 0
? 'По сводке на ' + st + ' МСК АИ-95 подтверждён на <b>' + c.a95 + '</b> из <b>' + c.known + '</b> АЗС с данными' +
(topYes.length ? '. Ближайшие подтверждённые: <b>' + topYes.map(esc).join('</b>, <b>') + '</b>' : '') +
'. Часть отметок приходит от водителей на месте — они помечены словом «народ» или «с места».'
: 'На ' + st + ' МСК подтверждённого АИ-95 в ' + c.inn + ' нет:either источник молчит, либо отметки не подтверждены. Смотрите ближайшие окна привоза ниже — они показывают, когда топливо обычно возвращается.'
},
{
q: 'Когда привезут бензин в ' + c.inn + '?',
a: near
? 'Ближайшее окно возврата по прогнозу: <b>' + t5(near.p.from_time) + '–' + t5(near.p.to_time) + '</b> на АЗС <b>' + esc(near.row.name) + '</b>' +
(near.row.address ? ' (' + esc(near.row.address) + ')' : '') + ', уверенность <b>' + near.conf + '%</b>. Всего по городу ' + wins.length + ' ' + plural(wins.length, ['окно', 'окна', 'окон']) + '. Прогноз — это вероятность по прошлым возвратам, а не гарантия привоза.'
: 'Окон привоза по ' + c.inn + ' пока нет: прогнозы строятся после того, как накопится история возвратов топлива на конкретных АЗС. Данные обновляются каждые 4 часа.'
},
{
q: 'Есть ли очереди на заправках в ' + c.inn + '?',
a: c.q > 0
? 'Сейчас <b>' + c.q + '</b> ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + ' города отмечены высокой очередью. В таблице они помечены словом «очередь». Отметки об очереди приходят от водителей и живут около часа.'
: 'Высоких очередей по ' + c.inn + ' сейчас не отмечали. Это значит, что водители не сообщали об очереди, а не что её точно нет.'
},
{
q: 'Откуда берутся данные о наличии топлива?',
a: 'Из трёх источников: снимки наличия топлива у поставщика данных, отметки водителей на месте и голоса водителей в приложении. Отметка «с места» весит больше всего, «народ» —共识 двух и более водителей, «источник» — снимок не старше 6 часов. Если данных нет, мы пишем «нет данных», а не угадываем. Сводка обновляется каждые 4 часа: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 МСК.'
}
];
faq[0].a = faq[0].a.replace('нет:either', 'нет: либо');
faq[3].a = faq[3].a.replace('共识', 'согласие');

const jsonld = {
'@context': 'https://schema.org',
'@graph': [
{
'@type': 'BreadcrumbList',
itemListElement: [
{ '@type': 'ListItem', position: 1, name: 'КогдаБенз', item: SITE + '/' },
{ '@type': 'ListItem', position: 2, name: RG.bread || RG.descHead, item: regUrl },
{ '@type': 'ListItem', position: 3, name: c.name, item: url }
]
},
{
'@type': 'FAQPage',
mainEntity: faq.map(f => ({
'@type': 'Question', name: f.q,
acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') }
}))
}
]
};

const winCards = wins.slice(0, 8).map((w, i) => {
const k = w.k;
const bw = winWord(k);
return '<article class="win rise" style="animation-delay:' + (0.05 + i * 0.04).toFixed(2) + 's">' +
'<div class="t"><span class="time">' + t5(w.p.from_time) + '–' + t5(w.p.to_time) + '</span>' +
'<span class="badge' + (k === 0 ? ' now' : '') + '">' + bw + '</span></div>' +
'<div class="nm">' + esc(w.row.name) + '</div>' +
'<div class="ad">' + esc(w.row.address || 'адрес не указан') + '</div>' +
'<div class="meta"><span>' + fuelName(w.p.fuel_type) + '</span><span class="bar"><i style="width:' + Math.max(4, Math.min(100, w.conf)) + '%"></i></span><span>' + w.conf + '%</span></div>' +
'</article>';
}).join('');

const tableRows = rows.map(r => {
const p = r.pred;
const win = p
? '<span class="wt">' + t5(p.from_time) + '–' + t5(p.to_time) + '<small>' + fuelName(p.fuel_type) + ' · ' + r.conf + '%</small></span>'
: '<span class="wn">окна нет</span>';
const hay = (r.name + ' ' + (r.address || '') + ' ' + (r.brand || '')).toLowerCase();
return '<tr data-name="' + esc(hay) + '" data-f92="' + (r.v92 ? r.v92.v : -2) + '" data-f95="' + (r.v95 ? r.v95.v : -2) +
'" data-fdt="' + (r.vdt ? r.vdt.v : -2) + '" data-win="' + (p ? 1 : 0) + '" data-key="' + (p ? r.key : 1e9) +
'" data-q="' + (r.q ? 1 : 0) + '">' +
'<td class="st"><b>' + esc(r.name) + '</b><span class="ad">' + esc(r.address || 'адрес не указан') + '</span>' +
(r.brand ? '<span class="br">' + esc(r.brand) + '</span>' : '') + '</td>' +
'<td data-col="92">' + pillHtml(r.v92, '92') + '</td>' +
'<td data-col="95">' + pillHtml(r.v95, '95') + '</td>' +
'<td data-col="diesel">' + pillHtml(r.vdt, 'diesel') + '</td>' +
'<td class="cq">' + (r.q ? '<span class="qy">очередь</span>' : '<span class="qn">не сообщали</span>') + '</td>' +
'<td class="cw">' + win + '</td></tr>';
}).join('');

const others = cap.cities.filter(x => x.key !== c.key && x.total > 0).slice(0, 14).map(x => {
const xl = LVL[x.level || lvlOf(x.share || 0, x.known, x.cover || 0)] || LVL.n;
return '<a class="city-link" href="' + SITE + '/svodka-' + x.key + '.html"><i style="background:' + xl.col + '"></i>' +
'<b>' + esc(x.name) + '</b><small>' + x.a95 + '/' + x.known + '</small></a>';
}).join('');

return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="theme-color" content="#070c1a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="КогдаБенз">
<meta property="og:locale" content="ru_RU">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${og}">
<link rel="icon" href="/icon-192.png">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
<a class="brand" href="${SITE}/"><span class="tile">${SVG_DROP}</span><span><b>Когда<i>Бенз</i></b><small>${esc(RG.whole || RG.bread)}</small></span></a>
<a class="top-cta" href="${SITE}/?city=${encodeURIComponent(c.key)}">${SVG_PIN}<span>Живая карта</span></a>
</div></header>

<main class="wrap">
<nav class="crumbs"><a href="${SITE}/">КогдаБенз</a><span>/</span><a href="${regUrl}">${esc(RG.bread || RG.descHead)}</a><span>/</span>${esc(c.name)}</nav>

<section class="card hero rise" style="${accVars(level)}">
<p class="eyebrow"><i></i>Сводка · обновлено ${st} МСК</p>
<h1>Где есть бензин<br>в <em>${esc(c.inn)}</em></h1>
<p class="lead">${c.known > 0
? `АИ-95 подтверждён на <b>${c.a95}</b> из <b>${c.known}</b> АЗС с данными. Всего в городе <b>${c.total}</b> ${plural(c.total, ['заправка', 'заправки', 'заправок'])}, ${wins.length} ${plural(wins.length, ['прогноз', 'прогноза', 'прогнозов'])} возврата топлива и <b>${c.q}</b> ${plural(c.q, ['АЗС', 'АЗС', 'АЗС'])} с очередью.`
: `По городу пока нет свежих отметок о наличии топлива. Данные собираются каждые 4 часа — как только источник или водители отметят наличие, сводка обновится.`}</p>
<div class="status"><i></i>${L.ru.charAt(0).toUpperCase() + L.ru.slice(1)}<span>· ${c.known > 0 ? Math.round((c.share || 0) * 100) + '% АЗС с АИ-95' : 'данных мало'}</span></div>
<div class="kpis">
<div class="kpi" style="--k:${L.col}"><small>АИ-95</small><b>${c.a95}</b><i>из ${c.known} с данными</i></div>
<div class="kpi" style="--k:var(--mint)"><small>АИ-92</small><b>${c.a92}</b><i>из ${c.known} с данными</i></div>
<div class="kpi" style="--k:var(--steel)"><small>Дизель</small><b>${c.adt}</b><i>из ${c.known} с данными</i></div>
<div class="kpi" style="--k:var(--blue)"><small>Окна</small><b>${wins.length}</b><i>прогнозов привоза</i></div>
</div>
<div class="hero-cta">
<a class="btn pri" href="${SITE}/?city=${encodeURIComponent(c.key)}">${SVG_PIN}Открыть живую карту</a>
<a class="btn" href="${regUrl}">${SVG_ARROW}${esc(RG.bread || RG.descHead)}</a>
</div>
</section>

<section id="wins">
<div class="sec-h"><h2>Ближайшие окна привоза</h2><p>когда топливо обычно возвращается · ${dateRu(t)}</p></div>
${winCards ? '<div class="wins">' + winCards + '</div>' : '<div class="empty">Окон привоза по городу пока нет — прогнозы копятся по мере наблюдений. Наличие топлива смотрите в таблице ниже.</div>'}
</section>

<section id="table">
<div class="sec-h"><h2>Наличие топлива по АЗС</h2><p>${rows.length} ${plural(rows.length, ['заправка', 'заправки', 'заправок'])} · источник, народ и отметки с места</p></div>
<div class="card">
<div class="tools">
<div class="seg" id="fuelSeg">
<button type="button" data-f="95" class="on">АИ-95</button>
<button type="button" data-f="92">АИ-92</button>
<button type="button" data-f="diesel">Дизель</button>
<button type="button" data-f="all">Все</button>
</div>
<label class="search">${SVG_SEARCH}<input id="q" type="search" placeholder="Поиск: название, адрес, бренд" autocomplete="off"></label>
<select class="sort" id="sort">
<option value="win">Сначала окна</option>
<option value="deficit">Сначала дефицит</option>
<option value="queue">Сначала очереди</option>
<option value="name">По названию</option>
</select>
<button type="button" class="tgl" id="onlyWin"><i></i>Только с окнами</button>
</div>
<div class="tbl-wrap"><table>
<thead><tr><th>АЗС</th><th>АИ-92</th><th>АИ-95</th><th>Дизель</th><th>Очередь</th><th>Окно привоза</th></tr></thead>
<tbody id="tb">${tableRows}</tbody>
</table></div>
<div class="count" id="cnt"></div>
</div>
</section>

<section id="faq">
<div class="sec-h"><h2>Частые вопросы</h2><p>ответы по данным этого выпуска</p></div>
<div class="faq">
${faq.map((f, i) => '<details class="rise" style="animation-delay:' + (0.04 * i).toFixed(2) + 's"' + (i === 0 ? ' open' : '') + '><summary>' + esc(f.q) + '</summary><div class="faq-a">' + f.a + '</div></details>').join('')}
</div>
</section>

${others ? `<section id="cities">
<div class="sec-h"><h2>Другие города региона</h2><p>${esc(RG.whole || '')} · АИ-95 есть / с данными</p></div>
<div class="cities">${others}</div>
</section>` : ''}

<section class="card method rise">
<h2>Как читать эту сводку</h2>
<ul>
<li><i style="background:var(--mint)"></i><span><b>«есть»</b> — наличие подтверждено: свежий снимок источника, согласие водителей или отметка с места. Под статусом видно, откуда именно она пришла и сколько минут назад.</span></li>
<li><i style="background:var(--red)"></i><span><b>«нет»</b> — топлива нет по достоверной отметке. Это не «нет данных», а именно отрицательный ответ.</span></li>
<li><i style="background:var(--amber)"></i><span><b>«не точно»</b> — отметка есть, но она устарела или источники противоречат друг другу. Проверяйте перед выездом.</span></li>
<li><i style="background:var(--steel)"></i><span><b>«нет данных»</b> — свежих отметок нет. Мы не подставляем догадки вместо факта.</span></li>
<li><i style="background:var(--blue)"></i><span><b>Окно привоза</b> — интервал, в который топливо на этой АЗС обычно возвращалось раньше, с процентом уверенности.</span></li>
</ul>
<div class="note">Прогноз — это вероятность по прошлым возвратам, а не гарантия привоза. Сводка обновляется каждые 4 часа: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 МСК. Следующий выпуск — <b id="next">через —</b>.</div>
</section>
</main>

<footer><div class="wrap">
<div class="l"><b>КогдаБенз · ${esc(c.name)}</b>Наличие топлива и окна привоза. Данные обновляются каждые 4 часа.</div>
<nav><a href="${SITE}/">Живая карта</a><a href="${regUrl}">${esc(RG.bread || RG.descHead)}</a><a href="${SITE}/svodka.html">Сводка по Югу</a><a href="${SITE}/svodka-sz.html">Северо-Запад</a><a href="${SITE}/svodka-ch.html">Чувашия</a></nav>
</div></footer>

<script>
(function(){
'use strict';
var tb=document.getElementById('tb');
var rows=Array.prototype.slice.call(tb.querySelectorAll('tr'));
var cnt=document.getElementById('cnt');
var fuel='95', q='', sort='win', onlyWin=false;
function val(r,f){return Number(r.getAttribute('data-f'+f));}
function apply(){
var vis=0;
rows.forEach(function(r){
var ok=true;
if(fuel!=='all'&&val(r,fuel)!==1)ok=false;
if(onlyWin&&r.getAttribute('data-win')!=='1')ok=false;
if(q&&r.getAttribute('data-name').indexOf(q)<0)ok=false;
r.style.display=ok?'':'none';
if(ok)vis++;
});
var arr=rows.slice().sort(function(a,b){
if(sort==='name')return a.getAttribute('data-name').localeCompare(b.getAttribute('data-name'),'ru');
if(sort==='queue')return Number(b.getAttribute('data-q'))-Number(a.getAttribute('data-q'))||Number(a.getAttribute('data-key'))-Number(b.getAttribute('data-key'));
if(sort==='deficit'){
var av=fuel==='all'?Math.max(val(a,'95'),val(a,'92'),val(a,'dt')):val(a,fuel);
var bv=fuel==='all'?Math.max(val(b,'95'),val(b,'92'),val(b,'dt')):val(b,fuel);
return av-bv||Number(a.getAttribute('data-key'))-Number(b.getAttribute('data-key'));
}
return Number(a.getAttribute('data-key'))-Number(b.getAttribute('data-key'))||a.getAttribute('data-name').localeCompare(b.getAttribute('data-name'),'ru');
});
arr.forEach(function(r){tb.appendChild(r);});
cnt.textContent='Показано '+vis+' из '+rows.length+' АЗС'+(fuel==='all'?'':' · фильтр: есть '+document.querySelector('#fuelSeg .on').textContent);
}
document.getElementById('fuelSeg').addEventListener('click',function(e){
var b=e.target.closest('button');if(!b)return;
this.querySelectorAll('button').forEach(function(x){x.classList.remove('on');});
b.classList.add('on');fuel=b.getAttribute('data-f');apply();
});
document.getElementById('q').addEventListener('input',function(){q=this.value.trim().toLowerCase();apply();});
document.getElementById('sort').addEventListener('change',function(){sort=this.value;apply();});
document.getElementById('onlyWin').addEventListener('click',function(){onlyWin=!onlyWin;this.classList.toggle('on',onlyWin);this.querySelector('i').textContent=onlyWin?'✓':'';apply();});
var NEXT=${cap.t + BUCKET};
function tick(){
var el=document.getElementById('next');if(!el)return;
var d=Math.max(0,NEXT-Date.now());
var h=Math.floor(d/3600000),m=Math.floor((d%3600000)/60000);
el.textContent=d<=0?'со минуты на минуту':h+' ч '+String(m).padStart(2,'0')+' мин';
}
tick();setInterval(tick,30000);
apply();
})();
</script>
</body>
</html>`;
}

// ============================================================
// 6. Захват данных и выпуск
// ============================================================
let CAP = [];
function citiesOf(built) {
if (!built) return [];
if (Array.isArray(built)) return built;
if (Array.isArray(built.cities)) return built.cities;
if (Array.isArray(built.list)) return built.list;
for (const k in built) {
const v = built[k];
if (Array.isArray(v) && v.length && v[0] && Array.isArray(v[0].rows)) return v;
}
return [];
}
exports.capture = function (RG, built, raw) {
const cities = citiesOf(built);
if (!RG || !cities.length) return;
const t = (raw && typeof raw.B === 'number') ? raw.B : Date.now();
CAP.push({ RG: RG, cities: cities, t: t });
};

function ogRowsOf(wins) {
return (wins || []).slice().sort((a, b) => a.k - b.k).slice(0, 2).map(w => ({
name: w.row.name || 'АЗС',
addr: w.row.address || '',
time: t5(w.p.from_time) + '–' + t5(w.p.to_time),
conf: w.conf
}));
}
function injectMeta(html, tags) {
let h = html;
h = h.replace(/<meta[^>]+property=["']og:(?:title|description|image|image:width|image:height|type|url|site_name|locale)["'][^>]*>\s*/gi, '');
h = h.replace(/<meta[^>]+name=["']twitter:(?:card|title|description|image)["'][^>]*>\s*/gi, '');
const block = tags.map(t => t.p
? '<meta property="' + t.p + '" content="' + esc(t.c) + '">'
: '<meta name="' + t.n + '" content="' + esc(t.c) + '">').join('\n') + '\n';
return h.replace(/<\/head>/i, block + '</head>');
}
function patchRegion(dir, cap, cityList) {
const f = path.join(dir, cap.RG.file);
if (!fs.existsSync(f)) return;
let h = fs.readFileSync(f, 'utf8');
h = h.replace(/<!--kb-cities-->[\s\S]*?<!--\/kb-cities-->\s*/g, '');
const title = (cap.RG.descHead || 'Сводка') + ' — ' + stamp(cap.t) + ' МСК';
const T = cap.cities.reduce((a, c) => {
a.a95 += c.a95; a.known += c.known; a.wins += (c.wins || []).length; a.q += c.q; return a;
}, { a95: 0, known: 0, wins: 0, q: 0 });
const desc = 'АИ-95 есть на ' + T.a95 + ' из ' + T.known + ' АЗС с данными. ' + T.wins + ' прогнозов привоза, ' + T.q + ' АЗС с очередью. Обновлено ' + stamp(cap.t) + ' МСК.';
const ogUrl = SITE + '/' + cap.RG.file;
const ogImg = SITE + '/og-' + cap.RG.key + '.png';
h = injectMeta(h, [
{ p: 'og:type', c: 'website' }, { p: 'og:site_name', c: 'КогдаБенз' }, { p: 'og:locale', c: 'ru_RU' },
{ p: 'og:url', c: ogUrl }, { p: 'og:title', c: title }, { p: 'og:description', c: desc },
{ p: 'og:image', c: ogImg }, { p: 'og:image:width', c: '1200' }, { p: 'og:image:height', c: '630' },
{ n: 'twitter:card', c: 'summary_large_image' }, { n: 'twitter:title', c: title },
{ n: 'twitter:description', c: desc }, { n: 'twitter:image', c: ogImg }
]);
const links = cityList.map(x =>
'<a href="' + SITE + '/svodka-' + x.key + '.html" style="display:flex;align-items:center;gap:9px;padding:12px 14px;border-radius:14px;' +
'border:1px solid rgba(148,180,255,.16);background:rgba(148,180,255,.05);color:#eef3fc;text-decoration:none;font-size:13px;font-weight:800">' +
'<i style="width:8px;height:8px;border-radius:50%;flex:none;background:' + (LVL[x.level] || LVL.n).col + '"></i>' +
'<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(x.name) + '</span>' +
'<small style="font-size:10.5px;color:#93a0b8;font-weight:800">' + x.a95 + '/' + x.known + '</small></a>').join('');
const nav = '<!--kb-cities--><section style="width:min(1120px,100% - 32px);margin:26px auto 0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif">' +
'<h2 style="margin:0 0 4px;font-size:19px;font-weight:900;color:#eef3fc;letter-spacing:-.4px">Сводка по городам</h2>' +
'<p style="margin:0 0 12px;font-size:11.5px;color:#6b7a96;font-weight:600">АИ-95 есть / АЗС с данными · отдельная страница на каждый город</p>' +
'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:9px">' + links + '</div></section><!--/kb-cities-->';
h = h.replace(/<\/body>/i, nav + '\n</body>');
fs.writeFileSync(f, h);
}
function patchSitemap(dir, list, t) {
const p = path.join(dir, 'sitemap.xml');
let sm = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
if (sm.indexOf('<urlset') < 0) sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>';
const locs = new Set(list.map(x => x.loc));
sm = sm.replace(/[ \t]*<url>[\s\S]*?<\/url>\s*/g, blk => {
const m = blk.match(/<loc>\s*([^<\s]+)\s*<\/loc>/);
return (m && locs.has(m[1])) ? '' : blk;
});
const d = isoDate(t);
const add = list.map(x => '  <url><loc>' + x.loc + '</loc><lastmod>' + d + '</lastmod><changefreq>hourly</changefreq><priority>0.8</priority></url>').join('\n');
sm = sm.replace(/<\/urlset>/i, add + '\n</urlset>');
fs.writeFileSync(p, sm);
}
exports.emit = function (dir) {
if (!dir || !CAP.length) { CAP = []; return 0; }
const made = [];
for (const cap of CAP) {
const cityList = [];
for (const c of cap.cities) {
if (!c || !c.total || !c.key) continue;
const file = 'svodka-' + c.key + '.html';
fs.writeFileSync(path.join(dir, file), cityPage(c, cap));
const L = c.level || lvlOf(c.share || 0, c.known, c.cover || 0);
fs.writeFileSync(path.join(dir, 'og-' + c.key + '.png'), ogCard({
title: c.name, region: cap.RG.whole || cap.RG.bread || 'КогдаБенз', stamp: stamp(cap.t),
level: L, a95: c.a95, known: c.known, wins: (c.wins || []).length, q: c.q,
rows: ogRowsOf(c.wins)
}));
cityList.push({ key: c.key, name: c.name, a95: c.a95, known: c.known, level: L });
made.push({ loc: SITE + '/' + file, name: c.name });
}
const T = cap.cities.reduce((a, c) => {
a.a95 += c.a95; a.known += c.known; a.total += c.total; a.q += c.q;
a.wins += (c.wins || []).length; a.all = a.all.concat(c.wins || []); return a;
}, { a95: 0, known: 0, total: 0, q: 0, wins: 0, all: [] });
const share = T.known ? T.a95 / T.known : 0;
const rl = lvlOf(share, T.known, T.total ? T.known / T.total : 0);
fs.writeFileSync(path.join(dir, 'og-' + cap.RG.key + '.png'), ogCard({
title: cap.RG.whole || cap.RG.bread || 'Сводка', region: 'СВОДКА РЕГИОНА', stamp: stamp(cap.t),
level: rl, a95: T.a95, known: T.known, wins: T.wins, q: T.q, rows: ogRowsOf(T.all)
}));
patchRegion(dir, cap, cityList);
}
patchSitemap(dir, made, CAP[0].t);
CAP = [];
return made.length;
};