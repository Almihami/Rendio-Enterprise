// Rutas › Análisis › Calificaciones (28-oct-2026, Camilo: «lo de calificadas ponlo
// en otro lado, de servicio al cliente o métricas») — prueba jsdom.
//
// Carga index.html + api.js DE VERDAD + admin-consola.js + admin-calificaciones.js
// con un `sb` FALSO y comprueba:
//   · la entrada «Calificaciones» está en Rutas › Análisis (antes de Métricas) y abre
//     su pantalla;
//   · Api.listRatings pide solo las calificadas del periodo y saca el conductor de
//     la parada que se hizo;
//   · el resumen (promedio, % de 5, bajas, lo que más dicen), las barras, la tabla por
//     conductor y la lista (lo más nuevo primero; «Solo las bajas»);
//   · cambiar el periodo vuelve a leer; sin calificaciones lo dice; si la base falla
//     lo dice (no inventa un promedio).
//
// NO CUBRE: cómo se ve (capturas), la base real (RLS, el embed de las vueltas).
//
//   cd rendio-backend && node scripts/_smoke-calificaciones-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
// Con un espacio entre elementos (textContent pega «Promedio» con «★ 4,0»).
const txs = (el) => (el ? el.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null);

const viaje = (drv, st) => ({ status: st, route_assignments: drv ? { driver_profiles: { profiles: { full_name: drv } } } : null });
const fila = (id, rating, tags, ratedAt, drvStops, dir) => ({
  id, direction: dir || 'home_to_airport', required_arrival_at: '2026-10-27T10:00:00Z', rating, rating_tags: tags, rated_at: ratedAt,
  auxiliar_profiles: { profiles: { full_name: 'Tripulante ' + id } }, route_stops: drvStops || [],
});
const FILAS = [
  fila('a', 5, ['Puntual', 'Amable'], '2026-10-27T15:00:00Z', [viaje('Daniel Alvarez Torres', 'delivered')]),
  fila('b', 5, ['Puntual'], '2026-10-27T16:00:00Z', [viaje('Juan Ospina', 'delivered')]),
  // La parada borrada (de una vuelta vieja) va primero: manda la que se hizo.
  fila('c', 2, ['Llegó tarde'], '2026-10-28T09:00:00Z', [viaje('Otro Viejo', 'pending'), viaje('Daniel Alvarez Torres', 'delivered')], 'airport_to_home'),
  fila('d', 4, [], '2026-10-26T12:00:00Z', []),
];

function fakeSb(DB) {
  const log = [];
  return {
    log,
    from(name) {
      const q = { name, cols: '', ops: [] };
      const b = {
        select(c) { q.cols = c; return b; },
        not(...a) { q.ops.push(['not', ...a]); return b; }, gte(...a) { q.ops.push(['gte', ...a]); return b; },
        order(...a) { q.ops.push(['order', ...a]); return b; }, limit() { return b; }, eq() { return b; }, in() { return b; },
        then(res, rej) {
          log.push(q);
          if (DB.falla) return Promise.resolve({ data: null, error: { message: 'sin red' } }).then(res, rej);
          if (name !== 'reservations') return Promise.resolve({ data: [], error: null }).then(res, rej);
          const desde = (q.ops.find((o) => o[0] === 'gte' && o[1] === 'rated_at') || [])[2];
          const rows = DB.filas.filter((r) => !desde || Date.parse(r.rated_at) >= Date.parse(desde)).sort((a, z) => Date.parse(z.rated_at) - Date.parse(a.rated_at));
          return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej);
        },
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
  };
}
async function boot(DB) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => errors.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(`Date.now = () => ${Date.parse('2026-10-28T20:00:00Z')};`);
  w.RENDIO_CONFIG = {};
  w.sb = fakeSb(DB);
  w.eval(read('api.js'));
  const STUBS = `
    var state = { profile: { id: 'jefe', role: 'admin' }, settings: {} };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
  `;
  try { w.eval(read('admin-calificaciones.js')); } catch (e) { errors.push('calificaciones: ' + e.message); }
  try { w.eval(STUBS + read('admin-consola.js') + '\n;window.__CN = typeof CN_DATA !== "undefined" ? CN_DATA : null;'); } catch (e) { errors.push('consola: ' + e.message); }
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = async (el) => { if (!el) throw new Error('no existe'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(); };
  return { w, errors, q, qa, click };
}

console.log('\n── El menú ──');
{
  const B = await boot({ filas: FILAS });
  const CN = B.w.__CN;
  const g = CN && CN.rutas.groups.find((x) => x.id === 'data');
  const ids = g ? g.items.map((i) => i.id) : [];
  t('Rutas › Análisis trae «Calificaciones» antes de «Métricas»', ids.join(',') === 'calif,metricas', ids.join(','));
  const it = g && g.items[0];
  t('…con su pantalla (tab calificaciones) y solo si el módulo cargó', it && it.tab === 'calificaciones' && it.need === 'renderCalificaciones' && typeof B.w.renderCalificaciones === 'function');
  t('hay un panel «calificaciones» en la página', !!B.q('section[data-panel="calificaciones"] #cal-ui'));
  const rv = CN.rutas.groups.find((x) => x.id === 'plan').items.find((i) => i.id === 'reservas');
  t('Reservas ya no dice «calificaciones» en su descripción', rv && !/calificaci/i.test(rv.desc), rv && rv.desc);
}

console.log('\n── La pantalla con datos ──');
{
  const B = await boot({ filas: FILAS });
  await B.w.renderCalificaciones(); await wait();
  const L = B.w.sb.log.filter((x) => x.name === 'reservations');
  const op = (k, c) => L[0] && L[0].ops.find((o) => o[0] === k && o[1] === c);
  t('pide solo las calificadas (rating no nulo) de los últimos 30 días, lo más nuevo primero', L.length && op('not', 'rating') && op('gte', 'rated_at')
    && Math.abs(Date.parse(op('gte', 'rated_at')[2]) - (Date.parse('2026-10-28T20:00:00Z') - 30 * 86400000)) < 1000 && op('order', 'rated_at'), JSON.stringify(L[0] && L[0].ops));
  t('…con el conductor de su vuelta (embed de las paradas)', L[0] && /route_stops\(status, route_assignments\(driver_profiles\(profiles\(full_name\)\)\)\)/.test(L[0].cols));
  const sum = txs(B.q('#cal-ui .cal-sum'));
  t('resumen: promedio ★ 4,0 de 4 calificaciones', /Promedio ★ 4,0 de 4 calificaciones/.test(sum), sum);
  t('…50% con 5 estrellas (2 de 4)', /Con 5 estrellas 50% 2 de 4/.test(sum), sum);
  t('…1 baja (1 a 3★), en rojo', /Bajas \(1 a 3★\) 1/.test(sum) && B.q('#cal-ui .cal-k.is-bad'), sum);
  t('…lo que más dicen: «Puntual» (2 veces)', /Lo que más dicen Puntual 2 veces/.test(sum), sum);
  const barras = B.qa('#cal-ui .cal-bars li').map((li) => txs(li));
  t('barras 5→1: 2 · 1 · 0 · 1 · 0', barras.join(' | ') === '5★ 2 | 4★ 1 | 3★ 0 | 2★ 1 | 1★ 0', barras.join(' | '));
  const tabla = B.qa('#cal-ui .cal-tab tbody tr').map((tr) => txs(tr));
  t('por conductor: Daniel ★ 3,5 (2, 1 baja) primero; Juan ★ 5,0; «Sin conductor en la app» al final', tabla[0] === 'Daniel Alvarez Torres ★ 3,5 2 1' && tabla[1] === 'Juan Ospina ★ 5,0 1 0' && /^Sin conductor en la app ★ 4,0 1 0$/.test(tabla[2] || ''), tabla.join(' | '));
  t('el conductor sale de la parada que se HIZO, no de la vieja', !tabla.some((r) => /Otro Viejo/.test(r)));
  const lista = B.qa('#cal-ui .cal-row');
  t('la lista: lo más nuevo primero (c, b, a, d)', lista.map((r) => txt(r.querySelector('.cal-main b'))).join(',') === 'Tripulante c,Tripulante b,Tripulante a,Tripulante d');
  t('la baja va en rojo con su etiqueta mala en rojo', lista[0].classList.contains('is-bad') && lista[0].querySelector('.cal-tags span.bad') && txt(lista[0].querySelector('.cal-tags')) === 'Llegó tarde');
  t('…dice si fue salida o llegada y con quién', /↓ Llegada/.test(txt(lista[0])) && /con Daniel A\./.test(txt(lista[0])), txt(lista[0]));
  t('…y las 2 de 5★ tienen sus etiquetas buenas (no rojas)', !lista[1].querySelector('.cal-tags span.bad') && txs(lista[2].querySelector('.cal-tags')) === 'Puntual Amable');
  await B.click(B.q('[data-cal-solo="bajas"]'));
  t('«Solo las bajas»: queda la de 2★', B.qa('#cal-ui .cal-row').length === 1 && /Tripulante c/.test(txt(B.q('#cal-ui .cal-row'))));
  t('…sin volver a leer la base', B.w.sb.log.filter((x) => x.name === 'reservations').length === 1);
  await B.click(B.q('[data-cal-dias="7"]'));
  const L2 = B.w.sb.log.filter((x) => x.name === 'reservations');
  t('«Últimos 7 días» vuelve a leer con 7 días', L2.length === 2 && Math.abs(Date.parse(L2[1].ops.find((o) => o[0] === 'gte')[2]) - (Date.parse('2026-10-28T20:00:00Z') - 7 * 86400000)) < 1000);
  t('sin errores de script', B.errors.length === 0, B.errors.join(' | '));
}

console.log('\n── Sin calificaciones / la base falla ──');
{
  const B = await boot({ filas: [] });
  await B.w.renderCalificaciones(); await wait();
  t('sin calificaciones: lo dice, sin promedio inventado', /Sin calificaciones/.test(txt(B.q('#cal-ui'))) && !B.q('#cal-ui .cal-sum'));
  const C = await boot({ filas: FILAS, falla: true });
  await C.w.renderCalificaciones(); await wait();
  t('la base falla: «No se pudieron leer las calificaciones»', /No se pudieron leer las calificaciones/.test(txt(C.q('#cal-ui'))) && !C.q('#cal-ui .cal-sum'), txt(C.q('#cal-ui')));
  t('sin errores de script', B.errors.length === 0 && C.errors.length === 0, B.errors.concat(C.errors).join(' | '));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
