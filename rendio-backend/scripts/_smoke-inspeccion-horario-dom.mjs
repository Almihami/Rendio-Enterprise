// ADMIN › Inspecciones › detalle: «Horario del turno» y fotos borradas por
// antigüedad (11-oct-2026) — prueba jsdom.
//
// El jefe de operación: «la Revisión no es la hora de inicio del turno». El
// detalle ahora trae un bloque con Inicio de turno (shifts.start_at), Inspección
// enviada (performed_at), Revisada por el jefe (reviewed_at + quién), Fin de
// turno (shifts.end_at, o la inspección de cierre) y Duración en «h y min»; y si
// el turno lo cerró el sistema, lo dice. Además las fotos de rutina de más de 60
// días se borran (inspection_photos.purged_at, la agrega otra persona): una foto
// así sale como «Foto eliminada por antigüedad», nunca como imagen rota.
//
// Carga index.html + api.js (DE VERDAD, contra un `sb` falso que imita a
// PostgREST y anota cada consulta) + api-jefe.js + admin-balance.js (BalanceCore)
// + admin-inspecciones.js. Nada sale a la red.
//
// Comprueba:
//   · el bloque, justo debajo de la cabecera, con las cinco horas y la duración
//     del motor del Balance; quién revisó (de state.admins o de profiles);
//   · auto-cerrado por el cron / forzado por un jefe: lo dice y «no se paga»;
//     en curso; arranque falso; sin turno; el turno no se pudo leer o no existe;
//   · la tarjeta «Revisión» dice «Revisada por el jefe · nombre»;
//   · fotos: purged_at → recuadro y su ruta ni se firma; sin URL en una
//     inspección de más de 60 días → «eliminada por antigüedad»; sin URL en una
//     reciente → «Foto no disponible» (no se inventa la causa); la <img> que
//     falla al cargar se cambia por el recuadro y deja de abrir el visor;
//   · base SIN la columna purged_at: la consulta se repite sin ella y el detalle
//     sale igual;
//   · api-jefe.js: getShiftTimes y profileNames piden lo que deben.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: cómo se ve el recuadro punteado en
// la cuadrícula de 3 o de 2 columnas), admin-inspecciones.css (no se carga), la
// base real (RLS de shifts para el jefe, que PostgREST acepte el select con
// purged_at), ni el proceso que borra las fotos.
//
//   cd rendio-backend && node scripts/_smoke-inspeccion-horario-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const iso = (s) => new Date(s).toISOString();
const DIA = 86400000;
const haceDias = (d, hhmm = '05:12') => { const x = new Date(Date.now() - d * DIA); const [h, m] = hhmm.split(':').map(Number); x.setUTCHours(h + 5, m, 0, 0); return x.toISOString(); };
const fmt = (s) => new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });

// ── datos de PRUEBA ───────────────────────────────────────────────────────────
const VEH = { internal_code: 'R01', license_plate: 'HNV760', brand: 'Renault', model: 'Logan', status: 'available', current_km: 1250, last_maintenance_km: 1000, maintenance_interval_km: 5000 };
const DRV = { profiles: { id: 'p-1', full_name: 'Julián Pérez', email: 'julian@prueba.test' } };
const foto = (tipo, path, o = {}) => ({ photo_type: tipo, storage_path: path, size_bytes: 1000, ...(o.purged ? { purged_at: o.purged } : {}) });
const insp = (id, o) => ({
  id, kind: o.kind || 'initial', has_damage: false, checklist: { items: [], severity: 'leve' }, notes: null, odometer_km: o.km || 1000,
  review_status: o.st || 'approved', reviewed_by: o.by || null, reviewed_at: o.at || null, review_notes: null,
  performed_at: o.perf, shift_id: o.shift === undefined ? 's-' + id : o.shift, vehicle_id: 'v-1', driver_id: 'dp-1',
  is_apt: true, signed_name: 'Julián Pérez', vehicles: VEH, driver_profiles: DRV, inspection_photos: o.fotos || [],
});
const turno = (id, ini, fin, okm, ckm, notes) => ({ id, status: fin ? 'closed' : 'active', start_at: ini, end_at: fin, opening_km: okm, closing_km: ckm, notes: notes || null, fueled: null, no_fuel_reason: null });
const VIEJA = haceDias(80);
function dataset() {
  return {
    insp: [
      insp('i-ok', { perf: iso('2026-10-10T05:12:00-05:00'), by: 'jefe-1', at: iso('2026-10-10T09:40:00-05:00'), shift: 's-ok',
        fotos: [foto('front', 'i-ok/front.jpg'), foto('rear', 'i-ok/rear.jpg', { purged: iso('2026-10-11T03:00:00-05:00') }), foto('left', 'i-ok/left.jpg'), foto('right', 'i-ok/right.jpg')] }),
      insp('i-ok-final', { kind: 'final', perf: iso('2026-10-10T17:28:00-05:00'), shift: 's-ok', km: 1250 }),
      insp('i-auto', { perf: VIEJA, by: 'jefe-2', at: haceDias(79, '10:00'), shift: 's-auto',
        fotos: [foto('front', 'i-auto/front.jpg'), foto('dashboard', 'i-auto/dash.jpg', { purged: haceDias(19) })] }),
      insp('i-forz', { perf: iso('2026-10-09T05:10:00-05:00'), shift: 's-forz', st: 'approved', by: 'jefe-1', at: iso('2026-10-09T08:00:00-05:00') }),
      insp('i-curso', { perf: new Date(Date.now() - 3 * 3600000).toISOString(), shift: 's-curso', st: 'pending' }),
      insp('i-sin', { perf: iso('2026-10-08T05:00:00-05:00'), shift: null }),
      insp('i-err', { perf: iso('2026-10-07T05:00:00-05:00'), shift: 's-err' }),
      insp('i-nada', { perf: iso('2026-10-06T05:00:00-05:00'), shift: 's-noexiste' }),
      insp('i-falso', { perf: iso('2026-10-05T05:00:00-05:00'), shift: 's-falso' }),
    ],
    shifts: [
      turno('s-ok', iso('2026-10-10T05:00:00-05:00'), iso('2026-10-10T17:30:00-05:00'), 1000, 1250),
      turno('s-auto', haceDias(80, '05:00'), haceDias(79, '04:00'), 1300, null, 'CIERRE AUTOMÁTICO: turno activo más de 23h sin cerrar.'),
      turno('s-forz', iso('2026-10-09T05:00:00-05:00'), iso('2026-10-09T21:15:00-05:00'), 1400, null, 'CIERRE FORZADO (admin): Cierre manual desde Turnos activos'),
      turno('s-curso', new Date(Date.now() - (3 * 60 + 20) * 60000).toISOString(), null, 1500, null),
      turno('s-falso', iso('2026-10-05T04:50:00-05:00'), iso('2026-10-05T06:00:00-05:00'), null, null),
    ],
    profiles: [{ id: 'jefe-2', full_name: 'Otro Jefe' }],
    // Lo que el almacenamiento todavía tiene: right.jpg firma pero el archivo «ya no está» (la <img> falla).
    urls: new Set(['i-ok/front.jpg', 'i-ok/right.jpg']),
    sinPurged: false,
  };
}

function fakeSb(DB, log) {
  const cl = (x) => JSON.parse(JSON.stringify(x));
  function from(name) {
    const q = { table: name, ops: [] };
    log.push(q);
    let one = null;
    const b = {
      select(cols) { q.ops.push(['select', cols]); return b; },
      eq(c, v) { q.ops.push(['eq', c, v]); return b; },
      in(c, v) { q.ops.push(['in', c, v]); return b; },
      gte(c, v) { q.ops.push(['gte', c, v]); return b; },
      lt(c, v) { q.ops.push(['lt', c, v]); return b; },
      order(c, o) { q.ops.push(['order', c, o || {}]); return b; },
      limit(n) { q.ops.push(['limit', n]); return b; },
      single() { one = 'single'; return b; },
      maybeSingle() { one = 'maybe'; return b; },
      then(res, rej) {
        const sel = (q.ops.find(o => o[0] === 'select') || [])[1] || '';
        const done = (x) => Promise.resolve(x).then(res, rej);
        if (name === 'inspections' && DB.sinPurged && /purged_at/.test(sel)) {
          return done({ data: null, error: { code: '42703', message: 'column inspection_photos_1.purged_at does not exist' } });
        }
        if (name === 'shifts' && q.ops.some(o => o[0] === 'eq' && o[1] === 'id' && o[2] === 's-err')) {
          return done({ data: null, error: { message: 'la red se cayó' } });
        }
        let rows = (name === 'inspections' ? DB.insp : name === 'shifts' ? DB.shifts : name === 'profiles' ? DB.profiles : name === 'fuel_receipts' ? [] : null);
        if (!rows) return done({ data: null, error: { message: 'tabla desconocida: ' + name } });
        rows = rows.slice();
        for (const [op, c, v] of q.ops) {
          if (op === 'eq') rows = rows.filter(r => r[c] === v);
          else if (op === 'in') rows = rows.filter(r => v.includes(r[c]));
        }
        // Sin purged_at en el select, la columna no viaja (como PostgREST).
        if (name === 'inspections' && !/purged_at/.test(sel)) rows = rows.map(r => ({ ...r, inspection_photos: (r.inspection_photos || []).map(({ purged_at, ...p }) => p) }));
        const data = one ? (rows[0] ? cl(rows[0]) : null) : cl(rows);
        if (one === 'single' && !data) return done({ data: null, error: { message: 'no rows' } });
        return done({ data, error: null });
      },
    };
    return b;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: { message: 'rpc desconocida' } }),
    storage: { from: () => ({ createSignedUrls: async (paths) => {
      log.push({ storage: 'createSignedUrls', paths: paths.slice() });
      return { data: paths.map(p => (DB.urls.has(p) ? { path: p, signedUrl: 'https://almacen.prueba/firmado/' + p, error: null } : { path: p, signedUrl: null, error: 'Object not found' })), error: null };
    } }) },
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
}

async function boot(o = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], log = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => { if (e.message) errors.push(e.message); });
  w.RENDIO_CONFIG = {};
  const DB = dataset();
  if (o.sinPurged) DB.sinPurged = true;
  w.sb = fakeSb(DB, log);
  w.eval(read('api.js'));
  if (!o.sinApiJefe) w.eval(read('api-jefe.js'));
  w.toast = () => {}; w.notify = async () => {}; w.confirm = () => true;
  w.eval(read('scheduler.js'));
  if (!o.sinBalance) w.eval(read('admin-balance.js'));
  const STUBS = `
    var state = { profile: { id: 'jefe-1', role: 'admin', organization_id: 'org-1' }, drivers: [], admins: [{ id: 'jefe-1', name: 'Jefa Prueba' }] };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function colorOfId() { return '#888'; }
    function initialsOf(n) { return String(n || '?').slice(0, 2).toUpperCase(); }
    const VEH_STATUS_ES = { available: 'Disponible' };
  `;
  try { w.eval(STUBS + '\n' + read('admin-inspecciones.js') + '\n;window.__inspState = inspState;'); } catch (e) { errors.push('admin-inspecciones.js: ' + e.message); }
  w.document.querySelector('section[data-panel="inspections"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const abrir = async (id) => { await w.openInspectionDetail(id); await wait(20); };
  // Las filas .kv del bloque, como { k: v }.
  const horario = () => {
    const card = q('#insp-v-detalle [data-insp-horario]');
    const out = {};
    if (card) card.querySelectorAll('.kv').forEach(kv => { out[txt(kv.querySelector('.k'))] = txt(kv.querySelector('.v')); });
    return { card, kv: out, nota: card ? txt(card.querySelector('.note')) : '' };
  };
  const fotos = () => qa('#insp-v-detalle .pgrid .photo').map(p => ({ el: p, label: txt(p.querySelector('.plabel')), gone: p.classList.contains('gone'), txt: txt(p.querySelector('.gone-t')), img: !!p.querySelector('img'), zoom: p.hasAttribute('data-insp-photo') }));
  return { w, DB, log, errors, q, qa, abrir, horario, fotos };
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Turno completo: las cinco horas y la duración ──');
{
  const b = await boot();
  await b.abrir('i-ok');
  const h = b.horario();
  t('el bloque «Horario del turno» existe', !!h.card && /Horario del turno/.test(txt(h.card.querySelector('h2'))));
  t('va justo debajo de la cabecera (antes de fotos y datos)', !!h.card && !!h.card.previousElementSibling && !!h.card.previousElementSibling.querySelector('.dhead') && h.card.nextElementSibling.classList.contains('cols'));
  t('Inicio de turno = shifts.start_at', h.kv['Inicio de turno'] === fmt('2026-10-10T05:00:00-05:00'), JSON.stringify(h.kv));
  t('Inspección enviada = performed_at', h.kv['Inspección enviada'] === fmt('2026-10-10T05:12:00-05:00'));
  t('Revisada por el jefe = reviewed_at · Jefa Prueba (de state.admins)', h.kv['Revisada por el jefe'] === fmt('2026-10-10T09:40:00-05:00') + ' · Jefa Prueba', h.kv['Revisada por el jefe']);
  t('Fin de turno = shifts.end_at', h.kv['Fin de turno'] === fmt('2026-10-10T17:30:00-05:00'), h.kv['Fin de turno']);
  t('Duración «12 h 30 min» (BalanceCore)', h.kv['Duración'] === '12 h 30 min', h.kv['Duración']);
  t('sin nota (nada raro)', !h.nota, h.nota);
  t('la subtítulo explica que la revisión es otra hora', /La revisión del jefe es otra hora/.test(txt(h.card)));
  const rev = b.qa('#insp-v-detalle .card').find(c => /^Revisión/.test(txt(c.querySelector('h2'))));
  t('la tarjeta «Revisión» dice «Revisada por el jefe · Jefa Prueba»', !!rev && /Revisada por el jefe/.test(txt(rev)) && /Jefa Prueba/.test(txt(rev)) && !/(^|\s)Revisada\s+\d/.test(txt(rev)), rev && txt(rev));
  const qs = b.log.filter(x => x.table === 'shifts' && x.ops.some(o => o[0] === 'eq' && o[1] === 'id' && o[2] === 's-ok'));
  const qHoras = qs.find(x => /start_at/.test((x.ops.find(o => o[0] === 'select') || [])[1]));
  t('Api.getShiftTimes pidió id, status, start_at, end_at, km y notas del turno', !!qHoras && /id, status, start_at, end_at, opening_km, closing_km, notes/.test(qHoras.ops.find(o => o[0] === 'select')[1]));
  t('no preguntó a profiles (el nombre estaba en state.admins)', !b.log.some(x => x.table === 'profiles'));

  console.log('\n── Fotos ──');
  const f = b.fotos();
  const de = (l) => f.find(x => x.label === l);
  t('la frontal (con URL) sale como imagen y abre el visor', de('Frontal') && de('Frontal').img && de('Frontal').zoom && !de('Frontal').gone);
  t('la trasera (purged_at) sale «Foto eliminada por antigüedad», sin imagen ni visor', de('Trasera') && de('Trasera').gone && de('Trasera').txt === 'Foto eliminada por antigüedad' && !de('Trasera').img && !de('Trasera').zoom, JSON.stringify(de('Trasera') && { ...de('Trasera'), el: 0 }));
  const firmadas = b.log.filter(x => x.storage === 'createSignedUrls').flatMap(x => x.paths);
  t('la ruta borrada ni se manda a firmar', !firmadas.includes('i-ok/rear.jpg') && firmadas.includes('i-ok/front.jpg'), JSON.stringify(firmadas));
  t('la lateral izquierda (sin URL, inspección RECIENTE) dice «Foto no disponible», no «por antigüedad»', de('Lat. izq.') && de('Lat. izq.').gone && de('Lat. izq.').txt === 'Foto no disponible', JSON.stringify(de('Lat. izq.') && de('Lat. izq.').txt));
  const der = de('Lat. der.');
  t('la lateral derecha llegó con URL (imagen)', der && der.img && der.zoom);
  der.el.querySelector('img').dispatchEvent(new b.w.Event('error'));
  await wait(5);
  const der2 = b.fotos().find(x => x.label === 'Lat. der.');
  t('si la <img> falla al cargar, se cambia por el recuadro y deja de abrir el visor', der2 && der2.gone && der2.txt === 'Foto no disponible' && !der2.img && !der2.zoom, JSON.stringify(der2 && { ...der2, el: 0 }));
  t('el subtítulo de Fotos avisa que las de rutina se borran a los 60 días', /se borran a los 60 días/.test(txt(b.q('#insp-v-detalle .cols .card .csub'))), txt(b.q('#insp-v-detalle .cols .card .csub')));
  t('el select pidió purged_at en las fotos', b.log.some(x => x.table === 'inspections' && /inspection_photos\([^)]*purged_at/.test((x.ops.find(o => o[0] === 'select') || [])[1] || '')));
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── Lo cerró el sistema / un jefe ──');
{
  const b = await boot();
  await b.abrir('i-auto');
  let h = b.horario();
  t('auto-cerrado: Fin de turno con «(lo cerró el sistema)»', /\(lo cerró el sistema\)$/.test(h.kv['Fin de turno'] || ''), h.kv['Fin de turno']);
  t('auto-cerrado: Duración «23 h · no se paga»', h.kv['Duración'] === '23 h · no se paga', h.kv['Duración']);
  t('auto-cerrado: la nota dice que no lo cerró el conductor y que fue el cierre automático', /no lo cerró el conductor/.test(h.nota) && /cierre automático/.test(h.nota) && /no entra al pago/.test(h.nota), h.nota);
  t('quién revisó, desde profiles (no está en state.admins): «· Otro Jefe»', /· Otro Jefe$/.test(h.kv['Revisada por el jefe'] || ''), h.kv['Revisada por el jefe']);
  const qp = b.log.find(x => x.table === 'profiles');
  t('Api.profileNames pidió id, full_name con in(id, [jefe-2])', qp && /id, full_name/.test(qp.ops.find(o => o[0] === 'select')[1]) && JSON.stringify(qp.ops.find(o => o[0] === 'in')) === '["in","id",["jefe-2"]]', qp && JSON.stringify(qp.ops));
  const f = b.fotos();
  t('inspección de hace 80 días: la frontal sin URL sale «eliminada por antigüedad»', f.find(x => x.label === 'Frontal') && f.find(x => x.label === 'Frontal').txt === 'Foto eliminada por antigüedad');
  t('…y la del tablero con purged_at también', f.find(x => x.label === 'Tablero') && f.find(x => x.label === 'Tablero').txt === 'Foto eliminada por antigüedad');
  t('«Las fotos de rutina se borran a los 60 días» (todas)', /Las fotos de rutina se borran a los 60 días/.test(txt(b.q('#insp-v-detalle .cols .card .csub'))));
  await b.abrir('i-forz');
  h = b.horario();
  t('forzado: «un jefe lo cerró a la fuerza desde Turnos activos» y «no se paga»', /un jefe lo cerró a la fuerza desde Turnos activos/.test(h.nota) && h.kv['Duración'] === '16 h 15 min · no se paga', h.nota + ' | ' + h.kv['Duración']);
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── En curso, falso, sin turno, no se pudo leer ──');
{
  const b = await boot();
  await b.abrir('i-curso');
  let h = b.horario();
  t('en curso: Fin «Turno abierto» y Duración «En curso · lleva 3 h 20 min»', h.kv['Fin de turno'] === 'Turno abierto' && /^En curso · lleva 3 h (19|20|21) min$/.test(h.kv['Duración'] || ''), JSON.stringify(h.kv));
  t('pendiente de revisar: «Todavía no»', h.kv['Revisada por el jefe'] === 'Todavía no');
  await b.abrir('i-falso');
  h = b.horario();
  t('arranque falso: «No arrancó (sin km de salida) · 0 h»', h.kv['Duración'] === 'No arrancó (sin km de salida) · 0 h', h.kv['Duración']);
  const nShifts0 = b.log.filter(x => x.table === 'shifts').length;
  await b.abrir('i-sin');
  h = b.horario();
  t('sin shift_id: lo dice y no consulta shifts', /no quedó ligada a un turno/.test(h.nota) && h.kv['Inicio de turno'] === '—' && !h.kv['Duración']
    && b.log.filter(x => x.table === 'shifts').length === nShifts0, h.nota);
  const nShiftsAntes = b.log.filter(x => x.table === 'shifts').length;
  await b.abrir('i-err');
  h = b.horario();
  t('el turno no se pudo leer: lo dice, y el resto del detalle sale', /No se pudo leer el turno/.test(h.nota) && /Checklist/.test(txt(b.q('#insp-v-detalle'))), h.nota);
  t('…y Fin de turno cae a la inspección de cierre si la hay (aquí no hay: «—»)', h.kv['Fin de turno'] === '—', h.kv['Fin de turno']);
  t('sí consultó el turno', b.log.filter(x => x.table === 'shifts').length > nShiftsAntes);
  await b.abrir('i-nada');
  h = b.horario();
  t('el turno no existe: «No se encontró el turno»', /No se encontró el turno/.test(h.nota), h.nota);
  const errsEsperados = b.errors.filter(e => !/la red se cayó/.test(e));
  t('sin otros errores de consola (solo el de la red caída, a propósito)', errsEsperados.length === 0, errsEsperados.join(' | '));
}

console.log('\n── Base SIN la columna purged_at ──');
{
  const b = await boot({ sinPurged: true });
  await b.abrir('i-ok');
  const sels = b.log.filter(x => x.table === 'inspections' && x.ops.some(o => o[0] === 'eq' && o[1] === 'id')).map(x => (x.ops.find(o => o[0] === 'select') || [])[1]);
  t('primero pidió con purged_at y, al fallar, repitió sin la columna', sels.length === 2 && /purged_at/.test(sels[0]) && !/purged_at/.test(sels[1]), JSON.stringify(sels.map(s => /purged_at/.test(s))));
  const f = b.fotos();
  t('el detalle sale igual: 4 fotos; la trasera (sin URL, reciente) «Foto no disponible»', f.length === 4 && f.find(x => x.label === 'Trasera').txt === 'Foto no disponible', JSON.stringify(f.map(x => x.label + ':' + (x.txt || 'img'))));
  t('…y el horario también', b.horario().kv['Duración'] === '12 h 30 min');
}

console.log('\n── Sin api-jefe.js ni BalanceCore (despliegue a medias) ──');
{
  const b = await boot({ sinApiJefe: true, sinBalance: true });
  await b.abrir('i-ok');
  const h = b.horario();
  t('el bloque sale con lo que sí se sabe (enviada, revisada, fin por la inspección de cierre)', !!h.card && h.kv['Inspección enviada'] === fmt('2026-10-10T05:12:00-05:00') && /\(inspección de cierre\)$/.test(h.kv['Fin de turno'] || ''), JSON.stringify(h.kv));
  t('…sin inventar duración', !h.kv['Duración']);
  t('el detalle no se cae', /Checklist/.test(txt(b.q('#insp-v-detalle'))) && b.errors.length === 0, b.errors.join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubre: layout del recuadro, admin-inspecciones.css, la base real (RLS, PostgREST con purged_at) ni el borrado de fotos.');
process.exit(bad ? 1 : 0);
