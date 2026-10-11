// La sección «Usuarios» del admin (admin-usuarios.js), en jsdom.
//
//   1. El menú: la entrada sale en los DOS espacios (Turnos › Equipo y Rutas ›
//      Equipo) y en la Consola; abrirla no cambia de espacio; sin el módulo no sale.
//   2. La lista: todos los roles y estados, conteo, chips, orden, buscador sin
//      tildes (también por teléfono), filtros por rol y estado, error de carga.
//   3. Las acciones de cada cuenta (las mismas reglas que la base) y que usan
//      los modales y usrSetStatus de usuarios.js, no una copia.
//   4. «Crear usuario»: conductor o jefe, valida, promueve, marca el cambio de
//      clave, ofrece restaurar si el correo es de un eliminado. Y que «Crear
//      conductor» de Personal sigue funcionando con la pieza compartida.
//   5. Lo cableado: index.html, sw.js, core.js y el CSS responsive.
//
//   cd rendio-backend/scripts && node _smoke-usuarios-seccion-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' ? ' → ' + d : '')); } };
const espera = () => new Promise((r) => setTimeout(r, 0));
const esperaMucho = async () => { for (let i = 0; i < 8; i++) await espera(); };

const USUARIOS = () => [
  { id: 'u-yo', name: 'Ana Jefa', email: 'ana@rendio.co', phone: '', role: 'admin', active: true, deleted: false, suspendedReason: '', mustChange: false },
  { id: 'u-oscar', name: 'Óscar Peña', email: 'oscar@rendio.co', phone: '3001110000', role: 'admin', active: true, deleted: false, suspendedReason: '', mustChange: false },
  { id: 'u-rosa', name: 'Rosa Inactiva', email: 'rosa@rendio.co', phone: '', role: 'admin', active: false, deleted: false, suspendedReason: '', mustChange: false },
  { id: 'u-jose', name: 'José Pérez', email: 'jose@rendio.co', phone: '300 123 4567', role: 'driver', active: true, deleted: false, suspendedReason: '', mustChange: true },
  { id: 'u-mario', name: 'Mario Roldán', email: 'mario@rendio.co', phone: '3002223333', role: 'driver', active: false, deleted: false, suspendedReason: 'Faltó dos veces', mustChange: false },
  { id: 'u-carlos', name: 'Carlos Viejo', email: 'carlos@rendio.co', phone: '', role: 'driver', active: false, deleted: true, suspendedReason: 'Renunció', mustChange: false },
  { id: 'u-maria', name: 'María Ángel Gómez', email: 'maria@avianca.com', phone: '3159998877', role: 'auxiliar', active: true, deleted: false, suspendedReason: '', mustChange: false },
  { id: 'u-luisa', name: 'Luisa Fernanda', email: 'luisa@wingo.com', phone: '', role: 'auxiliar', active: false, deleted: false, suspendedReason: 'Debe dos meses', mustChange: false },
];

function montar({ conModulo = true } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window, d = w.document;
  w.$ = (s) => d.querySelector(s);
  w.$$ = (s) => d.querySelectorAll(s);
  w.eval(read('admin-disponibilidad.js').match(/  function escapeAttr[\s\S]*?\n  }\n  function escapeHtml[\s\S]*?\n  }\n/)[0]);
  const log = { calls: [], toasts: [], alerts: [], prompts: [], confirms: [], setTab: [] };
  w.toast = (m) => log.toasts.push(m);
  w.alert = (m) => log.alerts.push(m);
  w.__resp = { prompt: [], confirm: [] };
  w.prompt = (m, def) => { log.prompts.push(m); return w.__resp.prompt.length ? w.__resp.prompt.shift() : def; };
  w.confirm = (m) => { log.confirms.push(m); return w.__resp.confirm.length ? w.__resp.confirm.shift() : true; };
  w.navigator.clipboard = { writeText: async () => {} };
  w.setTab = (n) => log.setTab.push(n);
  w.onLogout = () => {};
  w.eval(`var state = { profile: { id: 'u-yo', role: 'admin', organization_id: 'org' }, drivers: [], admins: [], activeTab: 'usuarios', settings: {} };`);
  let lista = USUARIOS();
  const reg = (fn, args) => log.calls.push([fn, ...args]);
  w.Api = {
    listAllUsersForAdmin: async () => { reg('listAllUsersForAdmin', []); if (w.__fallaLista) throw new Error('sin red'); return JSON.parse(JSON.stringify(lista)); },
    adminSetStatus: async (...a) => { reg('adminSetStatus', a); if (w.__fallaEstado) throw new Error('Tiene que quedar al menos un administrador activo'); },
    adminSetRole: async (...a) => reg('adminSetRole', a),
    adminSetPassword: async (...a) => reg('adminSetPassword', a),
    adminUpdateProfile: async (...a) => reg('adminUpdateProfile', a),
    adminSetEmail: async (...a) => reg('adminSetEmail', a),
    getProfileForEdit: async (id) => { reg('getProfileForEdit', [id]); const u = lista.find((x) => x.id === id); return { id, full_name: u.name, email: u.email, phone: u.phone, role: u.role, driver: {}, aux: {} }; },
    listAirlines: async () => [],
    listDrivers: async () => { reg('listDrivers', []); return []; },
    listAdmins: async () => { reg('listAdmins', []); return []; },
    listDeletedProfiles: async () => { reg('listDeletedProfiles', []); return [{ id: 'u-carlos', full_name: 'Carlos Viejo', email: 'carlos@rendio.co', role: 'driver' }]; },
    createDriver: async (b) => { reg('createDriver', [b]); if (w.__dup) throw new Error('Ya existe un usuario con ese email'); return { id: 'u-nuevo', email: b.email }; },
  };
  w.eval(read('usuarios.js'));
  if (conModulo) w.eval(read('admin-usuarios.js'));
  w.eval(read('admin-consola.js'));
  return { w, d, log, setLista: (l) => { lista = l; } };
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n1 · El menú');
{
  const { w, d, log } = montar();
  w.bindAdminSidebar();
  w.renderAdminSidebar();
  const navUs = () => d.querySelector('#adm-snav .nav-i[data-mod="usuarios"]');
  t('Turnos › Equipo tiene «Usuarios»', navUs() && /Usuarios/.test(navUs().textContent)
    && navUs().closest('.grp').querySelector('.gtext').textContent === 'Equipo');
  t('…junto a Personal', !!d.querySelector('#adm-snav .nav-i[data-mod="workers"]'));
  t('estando en Turnos, Usuarios es de Turnos', w.findModuleByTab('usuarios').ws === 'turnos');
  d.querySelector('#adm-wstabs button[data-ws="rutas"]').click();
  t('Rutas › Equipo también lo tiene (las cuentas de los tripulantes viven ahí)', navUs() && !!d.querySelector('#adm-snav .nav-i[data-mod="tripulantes"]'));
  t('estando en Rutas, abrirlo NO lo devuelve a Turnos', w.findModuleByTab('usuarios').ws === 'rutas');
  t('los módulos de un solo espacio siguen igual (Personal es de Turnos)', w.findModuleByTab('workers').ws === 'turnos');
  navUs().click();
  t('tocarlo navega a la pestaña usuarios', log.setTab.includes('usuarios'), JSON.stringify(log.setTab));
  w.renderConsola();
  t('la Consola trae su tarjeta', !!d.querySelector('#cn-groups [data-cnmod="usuarios"]'));
  w.updateBreadcrumb('usuarios');
  t('la miga dice «Rutas / Usuarios»', d.querySelector('#adm-cb-ws').textContent === 'Rutas' && d.querySelector('#adm-cb-title').textContent === 'Usuarios');
  const sin = montar({ conModulo: false });
  sin.w.renderAdminSidebar();
  t('sin admin-usuarios.js cargado, la entrada no sale (need)', !sin.d.querySelector('#adm-snav .nav-i[data-mod="usuarios"]'));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2 · La lista');
const M = montar();
const { w, d, log } = M;
const rows = () => [...d.querySelectorAll('#us-body .us-row')];
const nombres = () => rows().map((r) => r.querySelector('.us-nm b').textContent.replace(/Tú$/, '').trim());
const rowDe = (id) => d.querySelector(`#us-body .us-row[data-id="${id}"]`);
w.renderUsuarios();
await esperaMucho();
t('pide todas las cuentas al entrar', log.calls.some((c) => c[0] === 'listAllUsersForAdmin'));
t('salen las 8: conductores, jefes y tripulantes, de todos los estados', rows().length === 8, rows().length);
t('el conteo del encabezado es de cuentas no eliminadas (7)', d.querySelector('#us-count').textContent === '7', d.querySelector('#us-count').textContent);
t('los eliminados van al final', nombres()[nombres().length - 1] === 'Carlos Viejo', nombres().join(' | '));
t('activos primero (los suspendidos después)', nombres().indexOf('Mario Roldán') > nombres().indexOf('José Pérez'));
const jose = rowDe('u-jose');
t('cada fila trae correo y teléfono (con enlace para llamar)', /jose@rendio\.co/.test(jose.textContent) && jose.querySelector('a.us-tel').getAttribute('href') === 'tel:3001234567');
t('sin teléfono, lo dice', /sin teléfono/.test(rowDe('u-yo').textContent));
t('rol: Conductor / Jefe / Tripulante', jose.querySelector('.us-role').textContent === 'Conductor' && rowDe('u-oscar').querySelector('.us-role').textContent === 'Jefe'
  && rowDe('u-maria').querySelector('.us-role').textContent === 'Tripulante');
t('chip de estado: Activo, Suspendido, Sin acceso (jefe), Eliminado',
  jose.querySelector('.us-state').textContent.trim() === 'Activo' && rowDe('u-mario').querySelector('.us-state').textContent.trim() === 'Suspendido'
  && rowDe('u-rosa').querySelector('.us-state').textContent.trim() === 'Sin acceso' && rowDe('u-carlos').querySelector('.us-state').textContent.trim() === 'Eliminado');
t('«Clave temporal» para quien tiene que cambiarla', /Clave temporal/.test(jose.textContent) && !/Clave temporal/.test(rowDe('u-oscar').textContent));
t('«Tú» en la propia cuenta', /Tú/.test(rowDe('u-yo').querySelector('.us-nm').textContent));

const filtro = (k, v) => d.querySelector(`#us-filters [data-us="${k}"][data-v="${v}"]`);
t('filtros con conteo: 3 conductores, 3 jefes, 2 tripulantes', /3/.test(filtro('rol', 'driver').textContent) && /3/.test(filtro('rol', 'admin').textContent) && /2/.test(filtro('rol', 'auxiliar').textContent));
filtro('rol', 'auxiliar').click();
t('filtrar por rol: solo tripulantes', rows().length === 2 && nombres().every((n) => /María|Luisa/.test(n)), nombres().join());
t('…y el botón queda marcado', filtro('rol', 'auxiliar').classList.contains('on') && filtro('rol', 'auxiliar').getAttribute('aria-pressed') === 'true');
filtro('rol', 'todos').click();
filtro('estado', 'suspendido').click();
t('filtrar por estado: los 3 suspendidos (también el jefe sin acceso)', rows().length === 3 && ['Mario Roldán', 'Rosa Inactiva', 'Luisa Fernanda'].every((n) => nombres().includes(n)), nombres().join());
filtro('estado', 'eliminado').click();
t('eliminados: solo Carlos', rows().length === 1 && nombres()[0] === 'Carlos Viejo');
filtro('estado', 'todos').click();
const buscar = (txt) => { const i = d.getElementById('us-search'); i.value = txt; i.dispatchEvent(new w.Event('input', { bubbles: true })); };
buscar('jose');
t('buscar «jose» encuentra a «José» (sin tildes)', nombres().length === 1 && nombres()[0] === 'José Pérez', nombres().join());
buscar('MARIA angel');
t('mayúsculas y tildes al revés también', nombres().length === 1 && nombres()[0] === 'María Ángel Gómez', nombres().join());
buscar('300123');
t('por teléfono, aunque esté guardado con espacios', nombres().length === 1 && nombres()[0] === 'José Pérez', nombres().join());
buscar('avianca');
t('por correo', nombres().length === 1 && nombres()[0] === 'María Ángel Gómez');
buscar('tripulante');
t('por rol escrito', nombres().length === 2);
buscar('zzz');
t('sin resultados lo dice', /Nadie coincide/.test(d.getElementById('us-body').textContent));
buscar('');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n3 · Acciones de cada cuenta');
const acts = (id) => w.AdminUsuarios.accionesDe(USUARIOS().find((u) => u.id === id)).map((a) => a.act).sort().join(',');
t('yo: solo editar mis datos y cambiar MI contraseña', acts('u-yo') === 'datos,mi-clave', acts('u-yo'));
t('conductor activo: editar, clave, suspender, hacer admin, eliminar', acts('u-jose') === 'clave,datos,eliminar,hacer-admin,suspender', acts('u-jose'));
t('jefe activo: sin «suspender» (la base no lo deja), con «pasar a conductor»', acts('u-oscar') === 'clave,datos,eliminar,hacer-conductor', acts('u-oscar'));
t('jefe sin acceso: reactivar', acts('u-rosa') === 'clave,datos,eliminar,reactivar', acts('u-rosa'));
t('conductor suspendido: reactivar o eliminar; no se le cambia el rol', acts('u-mario') === 'clave,datos,eliminar,reactivar', acts('u-mario'));
t('eliminado: editar o restaurar (no tiene sentido restablecerle la clave)', acts('u-carlos') === 'datos,restaurar', acts('u-carlos'));
t('tripulante activo: nunca eliminar ni hacer jefe (la base no lo deja)', acts('u-maria') === 'clave,datos,suspender', acts('u-maria'));
t('tripulante suspendida: reactivar', acts('u-luisa') === 'clave,datos,reactivar', acts('u-luisa'));

const boton = (id, act) => rowDe(id).querySelector(`[data-us="act"][data-act="${act}"]`);
const abrir = (id) => { const b = rowDe(id).querySelector('[data-us="toggle"]'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); };
t('«Restablecer contraseña» está a la vista en la fila (sin abrir nada)', !!boton('u-jose', 'clave'));
t('…y en el eliminado, «Restaurar»', !!boton('u-carlos', 'restaurar'));
boton('u-jose', 'clave').click();
await esperaMucho();
const pw = d.getElementById('usr-pw-modal');
t('abre el modal de usuarios.js (el mismo de Personal), con el nombre', pw && /José Pérez/.test(pw.textContent));
pw.querySelector('[data-usr="save"]').click();
await esperaMucho();
const callPw = log.calls.find((c) => c[0] === 'adminSetPassword');
t('…y restablece con la RPC, pidiendo el cambio al entrar', callPw && callPw[1] === 'u-jose' && callPw[3] === true && /\d/.test(callPw[2]) && callPw[2].length >= 10, JSON.stringify(callPw));
d.getElementById('usr-pw-modal')?.remove();

abrir('u-mario');
t('«Gestionar» abre el panel con todas las acciones', rowDe('u-mario').classList.contains('open') && !!boton('u-mario', 'reactivar') && !!boton('u-mario', 'eliminar'));
t('…y muestra el motivo de la suspensión', /Faltó dos veces/.test(rowDe('u-mario').querySelector('.us-panel').textContent));
t('…y qué significa estar suspendido', /no inicia turno/.test(rowDe('u-mario').querySelector('.us-panel').textContent));

abrir('u-maria');
log.calls.length = 0; w.__resp.prompt.push('No ha pagado');
boton('u-maria', 'suspender').click();
await esperaMucho();
t('suspender a una tripulante: pide motivo con el texto de tripulantes', /no puede pedir traslados nuevos/.test(log.prompts[log.prompts.length - 1]));
const callSus = log.calls.find((c) => c[0] === 'adminSetStatus');
t('…y va por adminSetStatus (usrSetStatus de usuarios.js)', callSus && callSus[1] === 'u-maria' && callSus[2] === 'suspended' && callSus[3] === 'No ha pagado', JSON.stringify(callSus));
t('después recarga la lista y la memoria de la app (state.drivers/admins)', log.calls.some((c) => c[0] === 'listAllUsersForAdmin') && log.calls.some((c) => c[0] === 'listDrivers') && log.calls.some((c) => c[0] === 'listAdmins'));
t('y avisa', log.toasts.some((m) => /María Ángel Gómez quedó suspendido/.test(m)), log.toasts.join(' | '));

log.calls.length = 0; w.__resp.prompt.push(null);
abrir('u-jose'); boton('u-jose', 'suspender').click(); await esperaMucho();
t('cancelar el motivo cancela la acción', !log.calls.some((c) => c[0] === 'adminSetStatus'));

log.calls.length = 0; w.__resp.confirm.push(true); w.__resp.prompt.push('Se fue');
abrir('u-jose'); boton('u-jose', 'eliminar').click(); await esperaMucho();
const callDel = log.calls.find((c) => c[0] === 'adminSetStatus');
t('eliminar: confirma, pide motivo y elimina', callDel && callDel[2] === 'deleted' && callDel[3] === 'Se fue' && /horarios pasados NO se borran/.test(log.confirms[log.confirms.length - 1]), JSON.stringify(callDel));

log.calls.length = 0; w.__resp.confirm.push(false);
boton('u-carlos', 'restaurar').click(); await esperaMucho();
t('restaurar pide confirmación; si dice que no, nada', !log.calls.some((c) => c[0] === 'adminSetStatus'));
w.__resp.confirm.push(true);
boton('u-carlos', 'restaurar').click(); await esperaMucho();
const callRes = log.calls.find((c) => c[0] === 'adminSetStatus');
t('…si dice que sí, restaura', callRes && callRes[1] === 'u-carlos' && callRes[2] === 'active', JSON.stringify(callRes));

log.calls.length = 0; w.__resp.confirm.push(true);
abrir('u-jose'); boton('u-jose', 'hacer-admin').click(); await esperaMucho();
t('hacer administrador va por adminSetRole', log.calls.some((c) => c[0] === 'adminSetRole' && c[1] === 'u-jose' && c[2] === 'admin'));
log.calls.length = 0; w.__resp.confirm.push(true);
abrir('u-oscar'); boton('u-oscar', 'hacer-conductor').click(); await esperaMucho();
t('pasar a conductor también', log.calls.some((c) => c[0] === 'adminSetRole' && c[1] === 'u-oscar' && c[2] === 'driver'));

w.__fallaEstado = true; log.alerts.length = 0; w.__resp.confirm.push(true); w.__resp.prompt.push('');
abrir('u-oscar'); boton('u-oscar', 'eliminar').click(); await esperaMucho();
t('si la base se niega, se dice por qué', log.alerts.some((m) => /al menos un administrador/.test(m)), log.alerts.join());
t('…y los botones quedan usables', !boton('u-oscar', 'eliminar').disabled);
w.__fallaEstado = false;

boton('u-oscar', 'datos') || abrir('u-oscar');
boton('u-oscar', 'datos').click(); await esperaMucho();
t('«Editar datos y correo» abre el modal de usuarios.js con su ficha', !!d.getElementById('usr-edit-modal') && log.calls.some((c) => c[0] === 'getProfileForEdit' && c[1] === 'u-oscar'));
d.getElementById('usr-edit-modal')?.remove();
boton('u-yo', 'mi-clave').click(); await esperaMucho();
t('en mi fila: «Cambiar mi contraseña» (pide la actual)', !!d.getElementById('usr-mypw-modal') && /Contraseña actual/.test(d.getElementById('usr-mypw-modal').textContent));
d.getElementById('usr-mypw-modal')?.remove();

// ───────────────────────────────────────────────────────────────────────────
console.log('\n4 · Crear usuario');
d.querySelector('[data-us="crear"]').click();
let nv = d.getElementById('usr-new-modal');
t('abre el modal de crear (conductor o jefe)', !!nv && /Conductor/.test(nv.textContent) && /Administrador/.test(nv.textContent));
t('dice que los tripulantes no se crean acá', /tripulantes no se crean/.test(nv.textContent));
const f = (k) => nv.querySelector(`[data-f="${k}"]`);
t('trae una contraseña generada que cumple la regla', w.usrPasswordOk(f('password').value), f('password').value);
f('role').value = 'admin'; f('role').dispatchEvent(new w.Event('change'));
t('como jefe se esconden prioridad y líder de turno', nv.querySelector('[data-usr="prio"]').classList.contains('hidden') && nv.querySelector('[data-usr="coord"]').classList.contains('hidden'));
f('full_name').value = 'Pedro Nuevo'; f('email').value = 'no-es-correo';
log.calls.length = 0;
nv.querySelector('[data-usr="save"]').click(); await esperaMucho();
t('valida el correo antes de llamar a nadie', /correo no parece válido/.test(nv.querySelector('[data-usr="err"]').textContent) && !log.calls.some((c) => c[0] === 'createDriver'));
f('email').value = 'Pedro@Rendio.co'; f('phone').value = '300 555-1234';
const clave = f('password').value;
nv.querySelector('[data-usr="save"]').click(); await esperaMucho();
const cd = log.calls.find((c) => c[0] === 'createDriver');
t('crea la cuenta con create-driver (correo en minúscula, teléfono limpio)', cd && cd[1].email === 'pedro@rendio.co' && cd[1].phone === '3005551234' && cd[1].full_name === 'Pedro Nuevo' && cd[1].password === clave, JSON.stringify(cd));
t('…la promueve a jefe', log.calls.some((c) => c[0] === 'adminSetRole' && c[1] === 'u-nuevo' && c[2] === 'admin'));
t('…y le marca cambiar la contraseña al entrar (misma clave)', log.calls.some((c) => c[0] === 'adminSetPassword' && c[1] === 'u-nuevo' && c[2] === clave && c[3] === true));
t('muestra correo y contraseña UNA vez, para pasárselos', /pedro@rendio\.co/.test(nv.innerHTML) && nv.innerHTML.includes(clave) && /no se vuelve a mostrar/.test(nv.textContent));
t('y recarga la lista', log.calls.some((c) => c[0] === 'listAllUsersForAdmin'));
nv.remove();

d.querySelector('[data-us="crear"]').click();
nv = d.getElementById('usr-new-modal');
f('full_name').value = 'Carlos Viejo'; f('email').value = 'carlos@rendio.co';
w.__dup = true; log.calls.length = 0; w.__resp.confirm.push(true);
nv.querySelector('[data-usr="save"]').click(); await esperaMucho();
t('correo de un eliminado: ofrece restaurarlo y lo restaura', /está eliminado/.test(log.confirms[log.confirms.length - 1]) && log.calls.some((c) => c[0] === 'adminSetStatus' && c[1] === 'u-carlos' && c[2] === 'active'));
w.__dup = false;
d.getElementById('usr-new-modal')?.remove();

console.log('\n   «Crear conductor» de Personal, con la pieza compartida');
{
  const P = montar();
  P.w.Scheduler = { DAYS: [], monthLabelES: () => '', monthStartISO: () => '' };
  P.w.eval(read('admin-personal.js'));
  const $ = (s) => P.d.querySelector(s);
  $('#new-driver-name').value = 'Laura Conductora'; $('#new-driver-email').value = 'laura@rendio.co';
  $('#new-driver-phone').value = '310 000 1111'; $('#new-driver-password').value = 'Clave12345x'; $('#new-driver-role').value = 'driver';
  $('#new-driver-priority').value = '3'; $('#new-driver-can-coord').checked = true;
  await P.w.onCreateDriver();
  const c = P.log.calls.find((x) => x[0] === 'createDriver');
  t('sigue creando con los mismos datos (prioridad y líder incluidos)', c && c[1].email === 'laura@rendio.co' && c[1].priority === 3 && c[1].can_coordinate === true && c[1].phone === '3100001111', JSON.stringify(c));
  t('no promueve ni marca cambio de clave (igual que antes)', !P.log.calls.some((x) => x[0] === 'adminSetRole' || x[0] === 'adminSetPassword'));
  t('deja las credenciales a la vista como antes', /laura@rendio\.co \/ Clave12345x/.test($('#new-driver-state').textContent), $('#new-driver-state').textContent);
}

console.log('\n   Error al cargar');
{
  const E = montar();
  E.w.console.error = () => {};               // el error de red es el esperado
  E.w.__fallaLista = true;
  E.w.renderUsuarios(); await esperaMucho();
  t('si no carga, lo dice y deja reintentar', /No pudimos cargar/.test(E.d.getElementById('us-body').textContent) && !!E.d.querySelector('#us-body [data-us="reload"]'));
  E.w.__fallaLista = false;
  E.d.querySelector('#us-body [data-us="reload"]').click(); await esperaMucho();
  t('…y al reintentar, aparece la lista', E.d.querySelectorAll('#us-body .us-row').length === 8);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n5 · Lo cableado');
const html = read('index.html'), sw = read('sw.js'), core = read('core.js'), css = read('admin-usuarios.css');
t('index.html: panel data-panel="usuarios" con #usuarios-ui', !!d.querySelector('section[data-panel="usuarios"] #usuarios-ui'));
const pos = (s) => html.indexOf(`<script src="${s}"></script>`);
t('index.html: admin-usuarios.js carga después de usuarios.js y antes de ui-push.js', pos('admin-usuarios.js') > pos('usuarios.js') && pos('admin-usuarios.js') < pos('ui-push.js') && pos('usuarios.js') > 0);
t('index.html: enlaza admin-usuarios.css', html.includes('<link rel="stylesheet" href="admin-usuarios.css" />'));
t('sw.js: los dos archivos en APP_SHELL', sw.includes("'/admin-usuarios.js',") && sw.includes("'/admin-usuarios.css',"));
t('sw.js: CACHE_VERSION con el formato de siempre (la sube quien integra)', /const CACHE_VERSION = 'rendio-turnos-v\d+';/.test(sw), (sw.match(/const CACHE_VERSION = [^;]+;/) || [''])[0]);
t('core.js: setTab pinta Usuarios (con typeof)', /name === 'usuarios' && typeof window\.renderUsuarios === 'function'/.test(core));
t('CSS: por debajo de 1180 px (menú lateral + tabla no caben) la fila se vuelve tarjeta', /@media \(max-width: 1180px\)[\s\S]*\.us-head \{ display: none; \}/.test(css));
t('CSS: en celular, botones del tamaño de un dedo y buscador a 16 px (sin zoom en iPhone)', /@media \(max-width: 768px\)[\s\S]*min-height: 44px[\s\S]*font-size: 16px/.test(css));
t('CSS: todo scopeado a #usuarios-ui', css.split('\n').filter((l) => /^[^\s/*@}].*\{/.test(l)).every((l) => l.startsWith('#usuarios-ui')));

console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: el layout real (jsdom no hace layout: que la tarjeta no se desborde a 360 px o que los');
console.log('botones no se monten hay que verlo en el teléfono), la RLS de profiles ni las RPC de verdad (0081 tiene las suyas).');
process.exit(bad ? 1 : 0);
