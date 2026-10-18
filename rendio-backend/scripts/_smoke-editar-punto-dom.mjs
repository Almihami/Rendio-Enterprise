// El jefe cambia el punto de recogida del tripulante (0114, 18-oct-2026), en jsdom.
//
// «Editar datos» del tripulante (Tripulantes › Gestionar) traía nombre, correo,
// teléfono y aerolínea. Ahora también conjunto, apartamento y segunda unidad.
// Esta prueba abre el modal de usuarios.js con la API de mentira y comprueba:
//
//   1. Lo que sale: el conjunto actual elegido, los activos ofrecidos, los
//      desactivados no (salvo el que ya tiene, marcado «desactivado»), «Sin
//      conjunto» solo con dirección propia, el apartamento de la 2ª unidad
//      apagado mientras no tenga 2ª unidad.
//   2. Lo que se manda: solo lo que cambió, y nada si no cambió nada.
//   3. Los bordes: la lista de conjuntos que no carga, la base sin 0114, y que
//      a un conductor no le salen estos campos.
//   4. Lo cableado: getProfileForEdit pide las columnas, sw.js subió.
//
// NO cubre: el layout real (jsdom no pinta: cómo se ven los dos selectores
// lado a lado en el teléfono hay que mirarlo), la base (eso es _verify-0114)
// ni la app contra Supabase.
//
//   cd rendio-backend/scripts && node _smoke-editar-punto-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' ? ' → ' + d : '')); } };
const espera = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

const RES = [
  { id: 'r-olivar', name: 'El Olivar', is_active: true },
  { id: 'r-cerezos', name: 'Los Cerezos', is_active: false },
  { id: 'r-llano', name: 'Quintas de Llanogrande', is_active: true },
  { id: 'r-solare', name: 'Solare', is_active: true },
];
const AUX = (extra = {}) => ({
  id: 'p-laura', full_name: 'Laura Gómez Ríos', email: 'laura@rendio.test', phone: '3001234567', role: 'auxiliar',
  aux: { airline_id: 'av', residence_id: 'r-olivar', residence_unit: 'Torre 2 · 504', residence_id_2: null, residence_unit_2: null,
         home_address: null, home_latitude: null, home_longitude: null, ...extra },
});

function montar(ficha, { residences = RES, falla = null } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window, d = w.document;
  w.eval(read('admin-disponibilidad.js').match(/  function escapeAttr[\s\S]*?\n  }\n  function escapeHtml[\s\S]*?\n  }\n/)[0]);
  const log = { calls: [], toasts: [], done: 0 };
  w.toast = (m) => log.toasts.push(m);
  w.alert = () => {};
  w.eval(`var state = { profile: { id: 'u-yo', role: 'admin', organization_id: 'org' } };`);
  w.Api = {
    getProfileForEdit: async () => JSON.parse(JSON.stringify(ficha)),
    listAirlines: async () => [{ id: 'av', name: 'Avianca', is_active: true }],
    listResidencesAdmin: async () => { if (residences === null) throw new Error('red'); return residences; },
    adminUpdateProfile: async (...a) => { log.calls.push(['adminUpdateProfile', ...a]); if (falla) throw new Error(falla); },
    adminSetEmail: async (...a) => { log.calls.push(['adminSetEmail', ...a]); },
  };
  w.eval(read('usuarios.js'));
  return { w, d, log };
}
const abrir = async (m) => { m.w.openEditarDatos('p-laura', async () => { m.log.done++; }); await espera(); return m.d.getElementById('usr-edit-modal'); };
const f = (ov, k) => ov.querySelector(`[data-f="${k}"]`);
const opciones = (sel) => [...sel.options].map((o) => o.textContent.trim());
const elegir = (ov, k, v) => { const s = f(ov, k); s.value = v; s.dispatchEvent(new s.ownerDocument.defaultView.Event('change')); };
const guardar = async (ov) => { ov.querySelector('[data-usr="save"]').click(); await espera(); };

// ───────────────────────────────────────────────────────────────────────────
console.log('\n1 · Lo que sale');
{
  const m = montar(AUX());
  const ov = await abrir(m);
  const conj = f(ov, 'residence_id');
  t('sale el selector de conjunto', !!conj);
  t('con El Olivar elegido', conj && conj.value === 'r-olivar', conj && conj.value);
  t('ofrece los activos y no el desactivado', conj && opciones(conj).join('|') === 'El Olivar|Quintas de Llanogrande|Solare', conj && opciones(conj).join('|'));
  t('sin dirección propia no ofrece «Sin conjunto»', conj && ![...conj.options].some((o) => o.value === ''));
  t('el apartamento trae el actual', f(ov, 'residence_unit').value === 'Torre 2 · 504');
  const s2 = f(ov, 'residence_id_2');
  t('segunda unidad en «No tiene»', s2 && s2.value === '' && opciones(s2)[0] === '— No tiene —');
  t('el apartamento de la 2ª unidad sale apagado', f(ov, 'residence_unit_2').disabled === true);
  t('avisa que los traslados ya pedidos no cambian', /ya pidió no cambian/.test(ov.textContent));
}
{
  const m = montar(AUX({ residence_id: 'r-cerezos' }));
  const ov = await abrir(m);
  const conj = f(ov, 'residence_id');
  t('el conjunto desactivado que ya tiene sí sale, marcado y elegido',
    conj.value === 'r-cerezos' && opciones(conj).includes('Los Cerezos (desactivado)'), opciones(conj).join('|'));
  t('…y en la 2ª unidad no se ofrece', !opciones(f(ov, 'residence_id_2')).some((o) => /Cerezos/.test(o)));
}
{
  const m = montar(AUX({ residence_id: null, residence_unit: null, home_address: 'Casa azul, reja verde', home_latitude: 6.16, home_longitude: -75.37 }));
  const ov = await abrir(m);
  const conj = f(ov, 'residence_id');
  t('con dirección propia y sin conjunto: «Sin conjunto · dirección propia» elegido',
    conj.value === '' && opciones(conj)[0] === 'Sin conjunto · dirección propia: Casa azul, reja verde', opciones(conj)[0]);
  elegir(ov, 'residence_id', 'r-solare');
  await guardar(ov);
  const c = m.log.calls.find((x) => x[0] === 'adminUpdateProfile');
  t('pasarlo a un conjunto manda solo residence_id', c && JSON.stringify(c[2]) === '{"residence_id":"r-solare"}', c && JSON.stringify(c[2]));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2 · Lo que se manda');
{
  const m = montar(AUX());
  const ov = await abrir(m);
  elegir(ov, 'residence_id', 'r-llano');
  f(ov, 'residence_unit').value = '  Casa 12 ';
  await guardar(ov);
  const c = m.log.calls.find((x) => x[0] === 'adminUpdateProfile');
  t('cambiar conjunto y apartamento manda los dos (sin espacios)', c && c[1] === 'p-laura'
    && JSON.stringify(c[2]) === '{"residence_id":"r-llano","residence_unit":"Casa 12"}', c && JSON.stringify(c[2]));
  t('cierra, avisa y recarga la lista', !m.d.getElementById('usr-edit-modal') && m.log.toasts.includes('Datos guardados.') && m.log.done === 1);
}
{
  const m = montar(AUX());
  const ov = await abrir(m);
  await guardar(ov);
  t('sin cambios no llama a la base', m.log.calls.length === 0 && !m.d.getElementById('usr-edit-modal'));
}
{
  const m = montar(AUX());
  const ov = await abrir(m);
  elegir(ov, 'residence_id_2', 'r-olivar');
  t('elegir 2ª unidad prende su apartamento', f(ov, 'residence_unit_2').disabled === false);
  f(ov, 'residence_unit_2').value = 'Torre 3 · 302';
  await guardar(ov);
  const c = m.log.calls.find((x) => x[0] === 'adminUpdateProfile');
  t('agregar 2ª unidad manda conjunto y apartamento de la 2ª', c
    && JSON.stringify(c[2]) === '{"residence_id_2":"r-olivar","residence_unit_2":"Torre 3 · 302"}', c && JSON.stringify(c[2]));
}
{
  const m = montar(AUX({ residence_id_2: 'r-solare', residence_unit_2: 'Apto 9' }));
  const ov = await abrir(m);
  t('con 2ª unidad: elegida y su apartamento prendido', f(ov, 'residence_id_2').value === 'r-solare' && f(ov, 'residence_unit_2').disabled === false
    && f(ov, 'residence_unit_2').value === 'Apto 9');
  elegir(ov, 'residence_id_2', '');
  t('quitarla apaga su apartamento', f(ov, 'residence_unit_2').disabled === true);
  await guardar(ov);
  const c = m.log.calls.find((x) => x[0] === 'adminUpdateProfile');
  t('quitar la 2ª unidad manda residence_id_2 vacío (la base borra su apartamento)', c && JSON.stringify(c[2]) === '{"residence_id_2":""}', c && JSON.stringify(c[2]));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n3 · Los bordes');
{
  const m = montar(AUX(), { residences: null });
  const ov = await abrir(m);
  t('si la lista de conjuntos no carga: lo dice y no pinta selectores', !f(ov, 'residence_id') && !f(ov, 'residence_unit')
    && /No se pudo cargar la lista de conjuntos/.test(ov.textContent));
  f(ov, 'full_name').value = 'Laura Gómez Ríos Pérez';
  await guardar(ov);
  const c = m.log.calls.find((x) => x[0] === 'adminUpdateProfile');
  t('…y el resto del formulario se guarda igual', c && JSON.stringify(c[2]) === '{"full_name":"Laura Gómez Ríos Pérez"}', c && JSON.stringify(c[2]));
}
{
  const m = montar(AUX(), { falla: 'Campo no editable: residence_id' });
  const ov = await abrir(m);
  elegir(ov, 'residence_id', 'r-llano');
  await guardar(ov);
  const err = ov.querySelector('[data-usr="err"]');
  t('base sin 0114: mensaje claro y el modal sigue abierto', !!m.d.getElementById('usr-edit-modal') && /migración 0114/.test(err.textContent), err.textContent);
  t('…y el botón vuelve a quedar usable', ov.querySelector('[data-usr="save"]').disabled === false);
}
{
  const m = montar(AUX(), { falla: 'Elige un conjunto: no tiene una dirección propia donde recogerlo' });
  const ov = await abrir(m);
  f(ov, 'residence_unit').value = 'Torre 9';
  await guardar(ov);
  t('el mensaje de la base sale tal cual', /Elige un conjunto/.test(ov.querySelector('[data-usr="err"]').textContent));
}
{
  const m = montar({ id: 'p-jose', full_name: 'José Pérez', email: 'jose@rendio.co', phone: '', role: 'driver', driver: {} });
  m.w.openEditarDatos('p-jose');
  await espera();
  const ov = m.d.getElementById('usr-edit-modal');
  t('a un conductor no le salen conjunto ni 2ª unidad', ov && !f(ov, 'residence_id') && !f(ov, 'residence_id_2') && !!f(ov, 'license_number'));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n4 · Lo cableado');
{
  const api = read('api.js'), sw = read('sw.js');
  const sel = (api.match(/async function getProfileForEdit[\s\S]*?\n  }\n/) || [''])[0];
  t('getProfileForEdit pide conjunto, apartamentos, 2ª unidad y dirección propia',
    ['residence_id', 'residence_unit', 'residence_id_2', 'residence_unit_2', 'home_latitude', 'home_longitude'].every((c) => sel.includes(c)));
  t('sw.js en v188 o posterior', Number((sw.match(/CACHE_VERSION = 'rendio-turnos-v(\d+)'/) || [])[1]) >= 188);
}

console.log(`\n${ok} bien, ${bad} mal`);
process.exit(bad ? 1 : 0);
