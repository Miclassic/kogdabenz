// ===== КогдаБенз Score: теневой скорер v1 (этап 3) =====
// Ночью после верификатора и калибратора (02:40 MSK).
// Считает Score домашнего бокса по связкам «станция + топливо» из пяти
// составляющих и пишет в score_shadow. Пользователю не показываем ничего:
// это тень для сверки оценок с последующими событиями до публикации (этап 4).
//
// Составляющие (веса v1 по концепции):
//  1) confirm (25) — сумма весов независимых подтверждений из witness_journal
//     минус опровержения; полный балл при сумме весов >= 5.
//  2) match (30) — доля SUCCESS верификатора по проверенным прогнозам связки;
//     n>=5 — по факту, 1..4 — половинный кредит по числу, 0 — нейтраль 15.
//  3) fresh (20) — свежесть последнего факта по топливу: наблюдение с
//     ненулевым статусом или народное заявление/подтверждение журнала.
//  4) stable (15) — доля «мигающих» состояний машины (SUSPECTED_LOSS /
//     RECOVERY_STARTED) в наблюдениях за 6 ч: <10% полный, <30% средний, иначе минимум.
//  5) srcq (10) — reliability_score источника (коллектор уже считает его по станции).
// Уровень доказательности — по числу событий за связкой (claims+confirms+verified).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Только домашний бокс: у доноров разреженный heartbeat, Score там был бы выдумкой
const HOME = { lat1: 44.60, lat2: 44.85, lon1: 37.55, lon2: 38.05 };
const FUELS = ['92', '95', 'diesel'];
const FUEL_COL = { '92': 'fuel_92_status', '95': 'fuel_95_status', 'diesel': 'diesel_status' };
async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status + ' ' + await r.text());
  return r.json();
}
async function sbGetAll(path) {
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbGet(path + sep + 'limit=1000&offset=' + offset);
    for (const r of page) out.push(r);
    if (page.length < 1000) break;
  }
  return out;
}
async function sbPost(path, rows, prefer) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: prefer || 'return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error('POST ' + path + ' → ' + r.status + ' ' + await r.text());
}
function freshScore(ageMin) {
  if (ageMin === null || ageMin === undefined || !isFinite(ageMin)) return 0;
  if (ageMin <= 360) return 20;
  if (ageMin <= 1440) return Math.round(20 - 10 * (ageMin - 360) / 1080);
  if (ageMin <= 2880) return Math.round(10 - 10 * (ageMin - 1440) / 1440);
  return 0;
}
async function main() {
  console.log('=== SCORE SCORER v1 (тень) ===');
  const stations = (await sbGetAll('/rest/v1/stations?select=id,name,lat,lon&order=id.asc'))
    .filter(s => Number(s.lat) >= HOME.lat1 && Number(s.lat) <= HOME.lat2 && Number(s.lon) >= HOME.lon1 && Number(s.lon) <= HOME.lon2);
  console.log('   Домашних станций: ' + stations.length);
  if (!stations.length) { console.log('   Домашних станций нет — выходим.'); return; }
  const inIds = 'station_id=in.(' + stations.map(s => '"' + s.id + '"').join(',') + ')';
  // 1) журнал свидетеля по связкам
  const jRows = await sbGetAll('/rest/v1/witness_journal?' + inIds + '&select=station_id,fuel_type,role,weight,created_at&order=id.asc');
  const J = {};
  for (const r of jRows) {
    const k = r.station_id + '|' + r.fuel_type;
    const a = J[k] = J[k] || { cw: 0, rw: 0, claims: 0, confirms: 0, lastT: 0 };
    if (r.role === 'claim') a.claims++;
    else if (r.role === 'confirm') { a.confirms++; a.cw += Number(r.weight) || 0; }
    else if (r.role === 'refute') a.rw += Number(r.weight) || 0;
    const t = new Date(r.created_at).getTime();
    if (r.role !== 'refute' && t > a.lastT) a.lastT = t;
  }
  // 2) верификатор по связкам
  const vRows = await sbGetAll('/rest/v1/predictions?' + inIds + '&is_verified=eq.true&select=station_id,fuel_type,result&order=id.asc');
  const V = {};
  for (const p of vRows) {
    const k = p.station_id + '|' + p.fuel_type;
    const a = V[k] = V[k] || { n: 0, hit: 0 };
    a.n++;
    if (p.result === 'SUCCESS') a.hit++;
  }
  // 4/5) наблюдения за 6 ч: мигание состояний, надёжность, последний факт по топливу
  const oRows = await sbGetAll('/rest/v1/observations?' + inIds + '&timestamp=gte.' + new Date(Date.now() - 6 * 3600 * 1000).toISOString() + '&select=station_id,timestamp,fuel_92_status,fuel_95_status,diesel_status,fuel_state,reliability_score&order=timestamp.desc');
  const O = {};
  for (const o of oRows) {
    const a = O[o.station_id] = O[o.station_id] || { n: 0, flick: 0, rel: null, lastFuel: {} };
    a.n++;
    if (o.fuel_state === 'SUSPECTED_LOSS' || o.fuel_state === 'RECOVERY_STARTED') a.flick++;
    if (a.rel === null) a.rel = o.reliability_score;
    for (const f of FUELS) {
      if (a.lastFuel[f] === undefined && o[FUEL_COL[f]] !== null && o[FUEL_COL[f]] !== undefined) {
        a.lastFuel[f] = new Date(o.timestamp).getTime();
      }
    }
  }
  const now = Date.now();
  const rows = [];
  for (const st of stations) {
    const o = O[st.id] || { n: 0, flick: 0, rel: null, lastFuel: {} };
    const flickShare = o.n ? o.flick / o.n : 1;
    const stable = o.n === 0 ? 0 : flickShare < 0.1 ? 15 : flickShare < 0.3 ? 10 : 5;
    const srcq = (o.rel === null || o.rel === undefined) ? 0 : Math.round(10 * Number(o.rel));
    for (const f of FUELS) {
      const k = st.id + '|' + f;
      const j = J[k] || { cw: 0, rw: 0, claims: 0, confirms: 0, lastT: 0 };
      const v = V[k] || { n: 0, hit: 0 };
      const confW = Math.max(0, j.cw - j.rw);
      const confirm = Math.round(25 * Math.min(1, confW / 5));
      const match = v.n >= 5 ? Math.round(30 * v.hit / v.n) : v.n >= 1 ? Math.round(15 * v.n / 5) : 15;
      const lastT = Math.max(o.lastFuel[f] || 0, j.lastT);
      const fresh = freshScore(lastT ? (now - lastT) / 60000 : null);
      const eventsN = j.claims + j.confirms + v.n;
      const evidence = eventsN < 10 ? 'none' : eventsN < 30 ? 'forming' : eventsN < 100 ? 'stable' : 'strong';
      rows.push({
        station_id: st.id,
        fuel_type: f,
        score: confirm + match + fresh + stable + srcq,
        evidence: evidence,
        events_n: eventsN,
        comp: { confirm: confirm, match: match, fresh: fresh, stable: stable, srcq: srcq },
        computed_at: new Date().toISOString()
      });
    }
  }
  for (let i = 0; i < rows.length; i += 150) {
    await sbPost('score_shadow?on_conflict=station_id,fuel_type', rows.slice(i, i + 150), 'return=minimal,resolution=merge-duplicates');
  }
  const byEv = {};
  for (const r of rows) byEv[r.evidence] = (byEv[r.evidence] || 0) + 1;
  const avg = Math.round(100 * rows.reduce((s, r) => s + r.score, 0) / rows.length) / 100;
  console.log('   Записано строк: ' + rows.length + ', средний Score: ' + avg);
  console.log('   По уровням доказательности: ' + JSON.stringify(byEv));
  for (const r of rows.slice().sort((a, b) => b.score - a.score).slice(0, 3)) {
    const st = stations.find(s => s.id === r.station_id);
    console.log('   топ ' + r.score + '/100 · ' + (st ? st.name : r.station_id) + ' · ' + r.fuel_type + ' · ' + r.evidence + ' · ' + JSON.stringify(r.comp));
  }
  console.log('✅ Скорер (тень) завершил работу');
}
main().catch(e => { console.error('❌ Ошибка скорера: ' + e.message); process.exit(1); });