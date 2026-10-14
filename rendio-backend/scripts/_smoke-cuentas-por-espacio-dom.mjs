// Cuentas segmentadas por espacio (13-oct-2026), en jsdom.
//
// La sección «Usuarios» (11-oct) juntaba conductores, jefes y tripulantes en una
// lista y salía en los dos espacios. Se quitó: conductores y jefes se gestionan
// en Turnos › Personal, y los tripulantes en Rutas › Tripulantes. Esta prueba:
//
//   1. El menú: «Usuarios» ya no sale en ningún espacio ni en la Consola;
//      Personal sigue en Turnos › Equipo y Tripulantes en Rutas › Equipo.
//   2. Lo cableado: index.html, sw.js (v175, sin admin-usuarios), los archivos
//      borrados, api.js sin listAllUsersForAdmin y el enlace del push en core.js
//      (#/workers → Personal, #/tripulantes y el viejo #/usuarios → Tripulantes).
//   3. Tripulantes: solo las solicitudes de contraseña de TRIPULANTES; los
//      eliminados no cuentan ni salen fuera de su filtro «Eliminados»;
//      «Restaurar»; «Restablecer» del banner abre el modal de siempre y deja el
//      pedido en «done»; «Descartar» lo deja en «dismissed»; al volver a entrar
//      se piden de nuevo; sin usuarios.js la pantalla sale igual (sin banner).
//   4. Personal: solo las solicitudes de CONDUCTORES y JEFES (y las que se
//      quedaron sin cuenta, solo para descartar); «Pasar a conductor» para un
//      jefe activo que no soy yo.
//
// NO cubre: el layout real (jsdom no pinta), la base (eso es _verify-0104 con
// 0110) ni la app contra Supabase.
//
//   cd rendio-backend/scripts && node _smoke-cuentas-por-espacio-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' ? ' → ' + d : '')); } };
const espera = () => new Promise((r) => setTimeout(r, 0));
const esperaMucho = async () => { for (let i = 0; i < 10; i++) await espera(); };

const PEDIDOS = () => [
  { id: 'pw-aux', profileId: 'p-maria', name: 'María Ángel Gómez', role: 'auxiliar', contact: 'maria@avianca.com', createdAt: new Date(Date.now() - 5 * 60000).toISOString() },
  { id: 'pw-drv', profileId: 'u-jose', name: 'José Pérez', role: 'driver', contact: '3001234567', createdAt: new Date(Date.now() - 2 * 3600000).toISOString() },
  { id: 'pw-adm', profileId: 'u-oscar', name: 'Óscar Peña', role: 'admin', contact: 'oscar@rendio.co', createdAt: new Date().toISOString() },
  { id: 'pw-sin', profileId: null, name: '', role: '', contact: '3009998877', createdAt: new Date().toISOString() },
];
const AUX = () => [
  { id: 'a-maria', profileId: 'p-maria', deleted: false, name: 'María Ángel Gómez', email: 'maria@avianca.com', phone: '3159998877', active: true, airline: 'Avianca', groundStaff: false, joinedAt: '2026-01-10', createdAt: '2026-09-01T10:00:00Z', res1: { name: 'Olivar' }, unit1: '302' },
  { id: 'a-luisa', profileId: 'p-luisa', deleted: false, name: 'Luisa Fernanda', email: 'luisa@wingo.com', phone: '', active: false, suspendedReason: 'Debe dos meses', airline: 'Wingo', groundStaff: false, joinedAt: null, createdAt: '2026-09-02T10:00:00Z' },
  { id: 'a-vale', profileId: 'p-vale', deleted: false, name: 'Valentina Ospina', email: 'vale@rendio.test', phone: '', active: true, airline: '', groundStaff: true, joinedAt: '2026-10-13', createdAt: '2026-10-13T10:00:00Z' },
  { id: 'a-harold', profileId: 'p-harold', deleted: true, name: 'Harold Prueba', email: 'harold@prueba.co', phone: '', active: false, suspendedReason: 'Cuenta de prueba', airline: 'Avianca', groundStaff: false, joinedAt: '2026-10-12', createdAt: '2026-10-12T10:00:00Z' },
];

function montar({ conUsuarios = true } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window, d = w.document;
  w.$ = (s) => d.querySelector(s);
  w.$$ = (s) => d.querySelectorAll(s);
  w.eval(read('admin-disponibilidad.js').match(/  function escapeAttr[\s\S]*?\n  }\n  function escapeHtml[\s\S]*?\n  }\n/)[0]);
  const log = { calls: [], toasts: [], alerts: [], confirms: [], setTab: [] };
  w.toast = (m) => log.toasts.push(m);
  w.alert = (m) => log.alerts.push(m);
  w.__resp = { confirm: [] };
  w.prompt = (m, def) => def;
  w.confirm = (m) => { log.confirms.push(m); return w.__resp.confirm.length ? w.__resp.confirm.shift() : true; };
  w.navigator.clipboard = { writeText: async () => {} };
  w.setTab = (n) => log.setTab.push(n);
  w.onLogout = () => {};
  w.strikeLimit = () => 3;
  w.strikePeriod = () => '2026-10';
  w.Scheduler = { DAYS: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], monthLabelES: () => 'octubre' };
  w.eval(`var state = { profile: { id: 'u-yo', role: 'admin', organization_id: 'org' }, drivers: [], admins: [], activeTab: 'tripulantes', settings: {}, currentWeek: '2026-10-12' };`);
  w.__pw = PEDIDOS();
  w.__aux = AUX();
  const reg = (fn, args) => log.calls.push([fn, ...args]);
  w.Api = {
    // Tripulantes
    listAuxiliares: async () => { reg('listAuxiliares', []); return JSON.parse(JSON.stringify(w.__aux)); },
    listAirlines: async () => [{ id: 'av', name: 'Avianca', is_active: true }, { id: 'wi', name: 'Wingo', is_active: true }],
    // Personal
    listAdmins: async () => { reg('listAdmins', []); return [
      { id: 'u-yo', full_name: 'Ana Jefa', email: 'ana@rendio.co', is_active: true, is_coordinator: true },
      { id: 'u-oscar', full_name: 'Óscar Peña', email: 'oscar@rendio.co', is_active: true, is_coordinator: true },
    ]; },
    listAllDriversForAdmin: async () => [{ id: 'u-jose', name: 'José Pérez', email: 'jose@rendio.co', active: true }],
    listDrivers: async () => { reg('listDrivers', []); return []; },
    getActiveStrikeCounts: async () => new Map(),
    getWeekSuspensions: async () => new Map(),
    listDriverRules: async () => [],
    rulesToMap: () => ({}),
    getSchedule: async () => null,
    listClosedShiftsAdmin: async () => [],
    listDeletedProfiles: async () => [],
    // Cuentas (0081)
    adminSetStatus: async (...a) => reg('adminSetStatus', a),
    adminSetRole: async (...a) => reg('adminSetRole', a),
    adminSetPassword: async (...a) => reg('adminSetPassword', a),
    // Solicitudes de contraseña (0104)
    listPasswordResetRequests: async () => { reg('listPasswordResetRequests', []); return JSON.parse(JSON.stringify(w.__pw)); },
    resolvePasswordResetRequest: async (...a) => { reg('resolvePasswordResetRequest', a); w.__pw = w.__pw.filter((r) => r.id !== a[0]); return a[1]; },
  };
  if (conUsuarios) w.eval(read('usuarios.js'));
  w.eval(read('admin-personal.js'));
  w.eval(read('admin-tripulantes.js'));
  w.eval(read('admin-consola.js'));
  return { w, d, log };
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n1 · El menú');
{
  const { w, d } = montar();
  w.bindAdminSidebar();
  w.renderAdminSidebar();
  const nav = (m) => d.querySelector(`#adm-snav .nav-i[data-mod="${m}"]`);
  t('Turnos › Equipo: Personal, y NO «Usuarios»', !!nav('workers') && !nav('usuarios')
    && nav('workers').closest('.grp').querySelector('.gtext').textContent === 'Equipo');
  d.querySelector('#adm-wstabs button[data-ws="rutas"]').click();
  t('Rutas › Equipo: Tripulantes, y NO «Usuarios»', !!nav('tripulantes') && !nav('usuarios'));
  t('findModuleByTab ya no conoce «usuarios»', w.findModuleByTab('usuarios') === null);
  t('Personal es de Turnos y Tripulantes de Rutas', w.findModuleByTab('workers').ws === 'turnos' && w.findModuleByTab('tripulantes').ws === 'rutas');
  t('las descripciones dicen que ahí se manejan las contraseñas',
    /contraseña/.test(w.findModuleByTab('workers').item.desc) && /contraseña/.test(w.findModuleByTab('tripulantes').item.desc));
  w.renderConsola();
  t('la Consola tampoco trae la tarjeta', !d.querySelector('#cn-groups [data-cnmod="usuarios"]'));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2 · Lo cableado');
{
  const html = read('index.html'), sw = read('sw.js'), core = read('core.js'), api = read('api.js');
  t('index.html sin el panel, el CSS ni el script de Usuarios', !/data-panel="usuarios"/.test(html) && !/admin-usuarios/.test(html));
  t('…pero con usuarios.js (los modales compartidos)', /<script src="usuarios\.js"><\/script>/.test(html));
  t('sw.js: v175 y sin admin-usuarios en el APP_SHELL', /CACHE_VERSION = 'rendio-turnos-v175'/.test(sw) && !/admin-usuarios/.test(sw));
  t('admin-usuarios.js y .css ya no existen', !existsSync(APP + 'admin-usuarios.js') && !existsSync(APP + 'admin-usuarios.css'));
  t('api.js sin listAllUsersForAdmin', !/listAllUsersForAdmin/.test(api));
  t('core.js sin renderUsuarios', !/renderUsuarios/.test(core));
  t('el push abre Personal (#/workers) o Tripulantes (#/tripulantes; el viejo #/usuarios también)',
    /m\[1\] === 'workers' \? 'workers'/.test(core) && /m\[1\] === 'tripulantes' \|\| m\[1\] === 'usuarios' \? 'tripulantes'/.test(core));
  t('Tripulantes tiene el filtro «Eliminados»', /data-tp="filtro" data-f="eliminados"/.test(html));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n3 · Tripulantes');
{
  const { w, d, log } = montar();
  const body = () => d.querySelector('#tp-body');
  const filas = () => [...d.querySelectorAll('#tp-body .tp-row')].map((r) => r.querySelector('.tp-who b').textContent.trim());
  w.renderTripulantes();
  await esperaMucho();
  const banner = () => d.querySelector('#tp-body .usr-pw');
  t('sale el banner de solicitudes de contraseña', !!banner());
  t('…solo con la de la tripulante (no la del conductor, el jefe ni la huérfana)',
    banner() && banner().querySelectorAll('.usr-pw-row').length === 1 && /María Ángel Gómez/.test(banner().textContent) && !/José|Óscar|3009998877/.test(banner().textContent),
    banner() && banner().textContent.replace(/\s+/g, ' ').slice(0, 200));
  t('…con el conteo (1) y hace cuánto', banner() && banner().querySelector('.usr-pw-n').textContent === '1' && /hace 5 min/.test(banner().textContent));
  t('el conteo del encabezado no cuenta a la eliminada (3)', d.querySelector('#tp-count').textContent === '3', d.querySelector('#tp-count').textContent);
  t('en «Todos» la eliminada no sale', filas().length === 3 && !filas().some((n) => /Harold/.test(n)), filas().join(' | '));
  const sel = d.querySelector('#tp-air-filter');
  t('el filtro de aerolínea no la cuenta (Avianca = 1)', [...sel.options].some((o) => o.textContent === 'Avianca (1)'), [...sel.options].map((o) => o.textContent).join(' | '));
  const inp = d.querySelector('#tp-search');
  inp.value = 'harold'; inp.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('buscarla en «Todos» no la trae', filas().length === 0);
  d.querySelector('[data-tp="filtro"][data-f="eliminados"]').click();
  t('en «Eliminados» sí, marcada «Eliminada»', filas().length === 1 && /Harold Prueba/.test(filas()[0]) && /Eliminada/.test(filas()[0]), filas().join(' | '));
  inp.value = ''; inp.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('«Eliminados» sin búsqueda: solo ella', filas().length === 1);
  d.querySelector('#tp-body [data-tp="edit"]').click();
  const panel = d.querySelector('#tp-body .tp-row.open');
  t('«Gestionar» trae Editar datos y Restaurar, sin Suspender ni la fecha',
    panel && !!panel.querySelector('[data-tp="restaurar"]') && !!panel.querySelector('[data-tp="datos"]')
    && !panel.querySelector('[data-tp="suspender"]') && !panel.querySelector('#tp-date'));
  t('…y el motivo', panel && /Cuenta de prueba/.test(panel.textContent));
  w.__aux = w.__aux.map((a) => (a.id === 'a-harold' ? { ...a, deleted: false, active: true } : a));
  panel.querySelector('[data-tp="restaurar"]').click();
  await esperaMucho();
  const st = log.calls.find((c) => c[0] === 'adminSetStatus');
  t('«Restaurar» pide confirmación y llama admin_set_status(…, active)', /Restaurar a Harold Prueba/.test(log.confirms.join()) && st && st[1] === 'p-harold' && st[2] === 'active', JSON.stringify(st));
  t('…avisa y la saca de «Eliminados»', log.toasts.some((m) => /Harold Prueba fue restaurada/.test(m)) && filas().length === 0);
  d.querySelector('[data-tp="filtro"][data-f="todos"]').click();
  t('…y vuelve a «Todos» (ahora son 4)', filas().length === 4 && d.querySelector('#tp-count').textContent === '4');

  // Banner: Restablecer → modal → done.
  banner().querySelector('[data-usr-pw="reset"]').click();
  const modal = d.getElementById('usr-pw-modal');
  t('«Restablecer» abre el modal de siempre, con su nombre', !!modal && /María Ángel Gómez/.test(modal.textContent));
  modal.querySelector('[data-usr="save"]').click();
  await esperaMucho();
  const pwSet = log.calls.find((c) => c[0] === 'adminSetPassword');
  const res = log.calls.filter((c) => c[0] === 'resolvePasswordResetRequest');
  t('pone la contraseña a esa persona', pwSet && pwSet[1] === 'p-maria');
  t('…el pedido queda «done» y el banner desaparece', res.length === 1 && res[0][1] === 'pw-aux' && res[0][2] === 'done' && !banner(), JSON.stringify(res));

  // Volver a entrar pide los pedidos otra vez; uno nuevo sale y se descarta.
  w.__pw.push({ id: 'pw-aux2', profileId: 'p-luisa', name: 'Luisa Fernanda', role: 'auxiliar', contact: 'luisa@wingo.com', createdAt: new Date().toISOString() });
  const antes = log.calls.filter((c) => c[0] === 'listPasswordResetRequests').length;
  w.renderTripulantes();
  await esperaMucho();
  t('al volver a entrar se piden de nuevo', log.calls.filter((c) => c[0] === 'listPasswordResetRequests').length === antes + 1 && /Luisa Fernanda/.test(banner() ? banner().textContent : ''));
  banner().querySelector('[data-usr-pw="dismiss"]').click();
  await esperaMucho();
  const r2 = log.calls.filter((c) => c[0] === 'resolvePasswordResetRequest').pop();
  t('«Descartar» lo deja «dismissed» y el banner se va', r2[1] === 'pw-aux2' && r2[2] === 'dismissed' && !banner() && log.toasts.includes('Pedido descartado.'));
}
{
  const { w, d } = montar({ conUsuarios: false });
  w.renderTripulantes();
  await esperaMucho();
  t('sin usuarios.js, Tripulantes sale igual (sin banner)', d.querySelectorAll('#tp-body .tp-row').length === 3 && !d.querySelector('#tp-body .usr-pw'));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n4 · Personal');
{
  const { w, d, log } = montar();
  await w.eval('renderWorkers()');
  await esperaMucho();
  const banner = () => d.querySelector('#workers-list .usr-pw');
  const txt = banner() ? banner().textContent.replace(/\s+/g, ' ') : '';
  t('sale el banner con las de conductores y jefes (y la huérfana): 3', banner() && banner().querySelector('.usr-pw-n').textContent === '3', txt.slice(0, 160));
  t('…sin la de la tripulante', !/María Ángel/.test(txt));
  const sin = [...(banner() ? banner().querySelectorAll('.usr-pw-row') : [])].find((r) => /3009998877/.test(r.textContent));
  t('la que ya no tiene cuenta solo se puede descartar', sin && /ya no tiene cuenta/.test(sin.textContent) && !sin.querySelector('[data-usr-pw="reset"]') && !!sin.querySelector('[data-usr-pw="dismiss"]'));

  const elegir = (id) => { d.querySelector(`#pc-rows [data-sel="${id}"]`).click(); return d.querySelector('#pc-detail'); };
  let det = elegir('u-oscar');
  t('un jefe activo (no yo) tiene «Pasar a conductor»', !!det.querySelector('[data-act="demote"]'));
  det.querySelector('[data-act="demote"]').click();
  await esperaMucho();
  const rol = log.calls.find((c) => c[0] === 'adminSetRole');
  t('…pide confirmación y llama admin_set_role(…, driver)', /Pasar a Óscar Peña a conductor/.test(log.confirms.join()) && rol && rol[1] === 'u-oscar' && rol[2] === 'driver', JSON.stringify(rol));
  t('…y avisa', log.toasts.some((m) => /Óscar Peña ahora es conductor/.test(m)));
  det = elegir('u-yo');
  t('en mi propia cuenta no sale', !det.querySelector('[data-act="demote"]'));
  det = elegir('u-jose');
  t('un conductor sigue con «Hacer administrador»', !!det.querySelector('[data-act="promote"]') && !det.querySelector('[data-act="demote"]'));

  banner().querySelector('[data-usr-pw="reset"]').click();
  const modal = d.getElementById('usr-pw-modal');
  t('«Restablecer» del banner abre el modal del conductor', !!modal && /José Pérez/.test(modal.textContent));
  const recargas = log.calls.filter((c) => c[0] === 'listDrivers').length;
  modal.querySelector('[data-usr="save"]').click();
  await esperaMucho();
  const res = log.calls.filter((c) => c[0] === 'resolvePasswordResetRequest');
  t('…deja el pedido «done» y recarga Personal', res.length === 1 && res[0][1] === 'pw-drv' && res[0][2] === 'done' && log.calls.filter((c) => c[0] === 'listDrivers').length > recargas, JSON.stringify(res));
  t('…el banner queda con 2', banner() && banner().querySelector('.usr-pw-n').textContent === '2');
}

console.log(`\n${ok} bien · ${bad} mal`);
process.exit(bad ? 1 : 0);
