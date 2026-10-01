// T5 · ADMIN › Repuestos › Documentos del carro (0095) — prueba jsdom.
//
// Carga index.html + api.js + admin-repuestos.js. Para la pantalla, las
// funciones de Api se reemplazan por unas de PRUEBA (nada sale a la red); para
// la capa de datos, api.js corre contra un `window.sb` falso que anota cada
// llamada (tabla, columnas, filtros, RPC y parámetros).
//
// Comprueba:
//   · el estado por fecha, con los bordes: hoy, 1, 30 (dentro de la ventana), 31
//     (al día), vencido hace 1 y hace varios días, sin fecha, «No aplica», la
//     tarjeta de propiedad (no vence) y una ventana de 45/60 días;
//   · el resumen de la flota (arriba): conteos, orden por urgencia, sin dato,
//     «el aviso diario todavía no ha corrido», y dónde queda (después de los
//     indicadores de repuestos, antes de «Flota»);
//   · los puntos de la tarjeta de cada carro y el apartado del detalle (7 filas);
//   · el cajón: vista previa del estado mientras se escribe, guardar llama a la
//     API con los datos correctos (fecha, número, entidad, nota, No aplica), la
//     tarjeta sin fecha, y el error de la base traducido sin cerrar el cajón;
//   · los días de anticipación: mínimo 30 (no llama a la API), guardar 45 y
//     releer; si la base no lo tomó, lo dice;
//   · sin la tabla (0095 sin aplicar) lo dice y el resto de Repuestos sigue;
//   · el enlace del aviso (renderParts.focus) abre el carro; y el camino REAL de
//     la push (#/repuestos?veh=…): en frío con el applyDeepLink de core.js
//     recortado del archivo, con la app abierta (hashchange), carro borrado,
//     sin carro y quien no es jefe;
//   · Flota: la línea que une las dos pantallas, y que un formulario abierto
//     desde antes no pise el SOAT / la técnico-mecánica cargados en Repuestos;
//   · api.js: tabla, RPC y parámetros de las 5 funciones nuevas;
//   · la migración (lectura estática: NO se ejecuta) tiene lo que promete,
//     incluida la RPC del conductor driver_vehicle_documents (su pantalla se
//     prueba en _smoke-docs-conductor-dom.mjs y la base en _verify-0095.mjs).
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: el cajón, las filas en el celular y
// los colores se miran en el navegador), la base real (RLS, disparadores del
// espejo, el reloj de pg_cron, la bandeja de avisos, la push al teléfono) ni el
// resto de core.js (solo se corre su applyDeepLink; setTab es uno de prueba) ni
// el service worker abriendo la URL. La migración NO se corrió contra ninguna base.
//
//   cd rendio-backend && node scripts/_smoke-documentos-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const MIG = new URL('../supabase/migrations/0095_documentos_del_carro.sql', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addD = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

// Recorta una función de core.js por nombre (llaves pareadas) para correrla tal
// cual está en la app, sin cargar el resto de core.
function coreFn(name) {
  const src = read('core.js');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('core.js no tiene ' + name);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(i, j + 1);
}

// El arreglo que el revisor le propuso a core.js (conocer #/repuestos y pasar el
// carro con renderParts.focus). Todavía NO está en core.js: se simula para
// comprobar que, el día que llegue, los dos caminos no se pisan.
function coreConRepuestos() {
  let f = coreFn('applyDeepLink');
  const n0 = f.length;
  f = f.replace(/: null;/, ": m[1] === 'repuestos' ? 'parts' : null;");
  f = f.replace(/(\n\s*)setTab\(tab\);/, "$1const veh = params.get('veh'); if (veh && tab === 'parts' && typeof renderParts.focus === 'function') renderParts.focus(veh);$1setTab(tab);");
  if (f.length === n0) throw new Error('no se pudo simular el arreglo de core.js');
  return f;
}

// ── datos de PRUEBA (dos carros, un repuesto cada uno) ────────────────────────
const VEHS = () => [
  { id: 'v1', internal_code: 'C01', license_plate: 'PRB001', brand: 'Marca', model: 'Uno', capacity: 4, current_km: 50000, status: 'available' },
  { id: 'v2', internal_code: 'C02', license_plate: 'PRB002', brand: 'Marca', model: 'Dos', capacity: 4, current_km: 30000, status: 'available' },
];
const STATUS = () => VEHS().map((v) => ({
  vehicle_id: v.id, internal_code: v.internal_code, license_plate: v.license_plate, current_km: v.current_km,
  part_code: 'aceite', part_name: 'Aceite de motor', system: 'motor', interval_km: 6500, km_since: 1000, km_until: 5500,
  light: 'green', is_critical: false, sort_order: 1,
}));
const DOCS = () => [
  { id: 'd1', vehicle_id: 'v1', kind: 'soat', expires_on: addD(HOY, -3), number: 'POL-1', issuer: 'Aseguradora de prueba', notes: null, not_applicable: false },
  { id: 'd2', vehicle_id: 'v1', kind: 'tecnomecanica', expires_on: addD(HOY, 30), number: null, issuer: null, notes: null, not_applicable: false },
  { id: 'd3', vehicle_id: 'v1', kind: 'tarjeta_propiedad', expires_on: null, number: 'LT-99', issuer: null, notes: null, not_applicable: false },
  { id: 'd4', vehicle_id: 'v2', kind: 'soat', expires_on: HOY, number: null, issuer: null, notes: null, not_applicable: false },
  { id: 'd5', vehicle_id: 'v2', kind: 'seguro', expires_on: addD(HOY, 31), number: null, issuer: null, notes: null, not_applicable: false },
  // Vencido pero «No aplica»: no cuenta en nada.
  { id: 'd6', vehicle_id: 'v2', kind: 'extintor', expires_on: addD(HOY, -40), number: null, issuer: null, notes: null, not_applicable: true },
];

async function boot(o = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: o.url || 'http://localhost/' });
  const w = dom.window;
  const errors = [], toasts = [], calls = [], prompts = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.scrollTo = () => {};
  w.toast = (m) => toasts.push(m);
  w.confirm = () => true;
  w.prompt = (msg, def) => { prompts.push([msg, def]); return o.promptAnswers ? o.promptAnswers.shift() : null; };
  // Como en core.js ($ y $$). Con function: un const dentro de eval no sale al global.
  w.eval(`
    function $(sel) { return document.querySelector(sel); }
    function $$(sel) { return document.querySelectorAll(sel); }
    function rdWhy(r, h) { return '<details class="rd-why"><summary>' + r + '</summary><div class="rd-why-body">' + h + '</div></details>'; }
  `);
  // api.js se carga de verdad (para que existan las funciones) y luego se pisan.
  w.sb = { from: () => { throw new Error('sin red en la prueba'); }, rpc: () => { throw new Error('sin red en la prueba'); } };
  try { w.eval(read('api.js')); } catch (e) { errors.push('api.js: ' + e.message); }
  const A = w.Api;
  const D = { docs: o.docs ? o.docs() : DOCS(), days: o.days === undefined ? 30 : o.days, lastRun: o.lastRun === undefined ? null : o.lastRun, keepDays: !!o.keepDays };
  const cl = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  A.listPartStatus = async () => STATUS();
  A.listPartCatalog = async () => [{ id: 'p1', code: 'aceite', name: 'Aceite de motor', system: 'motor', interval_km: 6500 }];
  A.listPartRealLife = async () => [];
  A.listPartHistory = async () => [];
  A.listInspectionTiers = async () => [];
  A.listVehiclesForShift = async () => VEHS();
  if (o.sinApiDocs) {
    delete A.listVehicleDocuments; delete A.saveVehicleDocument;
  } else {
    A.listVehicleDocuments = async () => { calls.push(['listVehicleDocuments']); if (o.docsErr) throw new Error(o.docsErr); return cl(D.docs); };
    A.saveVehicleDocument = async (vid, kind, d) => {
      calls.push(['saveVehicleDocument', vid, kind, cl(d)]);
      if (o.saveErr) throw new Error(o.saveErr);
      // Lo que haría la RPC: upsert por carro × tipo; la tarjeta sin fecha.
      const row = { vehicle_id: vid, kind, expires_on: kind === 'tarjeta_propiedad' ? null : (d.expiresOn || null),
        number: d.number || null, issuer: d.issuer || null, notes: d.notes || null, not_applicable: !!d.notApplicable };
      const i = D.docs.findIndex((x) => x.vehicle_id === vid && x.kind === kind);
      if (i >= 0) D.docs[i] = { ...D.docs[i], ...row }; else D.docs.push({ id: 'n' + D.docs.length, ...row });
      return { id: 'x', ...row };
    };
  }
  A.getVehicleDocAlertDays = async () => { calls.push(['getVehicleDocAlertDays']); return D.days; };
  A.setVehicleDocAlertDays = async (n) => { calls.push(['setVehicleDocAlertDays', n]); if (!D.keepDays) D.days = n; };
  A.getVehicleDocLastRun = async () => cl(D.lastRun);
  // o.core: lo mínimo de core.js para el enlace del aviso — state, setTab (marca
  // la pestaña, muestra su sección y pinta Repuestos como core.setTab) y el
  // applyDeepLink DE VERDAD, recortado de core.js, con su oyente de hashchange.
  if (o.core) {
    w.eval(`
      var state = { activeTab: 'arranque', profile: null };
      var evtState = {}, rvState = {};
      function setTab(name) {
        state.activeTab = name;
        document.querySelectorAll('section[data-panel]').forEach((s) => s.classList.toggle('hidden', s.dataset.panel !== name));
        if (name === 'parts') renderParts();
      }
      ${o.core === 'conRepuestos' ? coreConRepuestos() : coreFn('applyDeepLink')}
      window.addEventListener('hashchange', () => { try { applyDeepLink(); } catch (e) { /* */ } });
    `);
  }
  try { w.eval(read('admin-repuestos.js')); } catch (e) { errors.push('admin-repuestos.js: ' + e.message); }
  const sec = w.document.querySelector('section[data-panel="parts"]');
  if (sec && !o.core) sec.classList.remove('hidden');
  const R = () => w.document.getElementById('parts-ui');
  const q = (s) => R().querySelector(s);
  const qa = (s) => [...R().querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const check = (el, v) => { el.checked = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  return { w, D, A, calls, toasts, errors, prompts, R, q, qa, click, type, check };
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Estado por fecha (bordes) ──');
{
  const b = await boot();
  const RD = b.w.RepuestosDocs;
  t('exporta window.RepuestosDocs con docState', !!RD && typeof RD.docState === 'function');
  const S = (exp, extra = {}, n = 30, kind = 'soat') => RD.docState(exp === undefined ? null : { expires_on: exp, ...extra }, kind, HOY, n);
  const lab = (x) => x.light + '|' + x.label;
  t('hoy → «Vence hoy» (rojo)', lab(S(HOY)) === 'red|Vence hoy', lab(S(HOY)));
  t('mañana → «Vence en 1 día» (singular, ámbar)', lab(S(addD(HOY, 1))) === 'amber|Vence en 1 día', lab(S(addD(HOY, 1))));
  t('a 30 días con ventana de 30 → «Vence en 30 días» (dentro)', lab(S(addD(HOY, 30))) === 'amber|Vence en 30 días', lab(S(addD(HOY, 30))));
  t('a 31 días → «Al día»', lab(S(addD(HOY, 31))) === 'green|Al día', lab(S(addD(HOY, 31))));
  t('ayer → «Vencido hace 1 día»', lab(S(addD(HOY, -1))) === 'red|Vencido hace 1 día', lab(S(addD(HOY, -1))));
  t('hace 12 días → «Vencido hace 12 días»', lab(S(addD(HOY, -12))) === 'red|Vencido hace 12 días', lab(S(addD(HOY, -12))));
  t('sin fila → «Sin dato»', lab(S(undefined)) === 'nodata|Sin dato');
  t('fila sin fecha → «Sin dato» (nunca una fecha asumida)', lab(S(null)) === 'nodata|Sin dato');
  t('«No aplica» manda aunque la fecha esté vencida', lab(S(addD(HOY, -40), { not_applicable: true })) === 'na|No aplica');
  t('tarjeta de propiedad con número → «Registrada»; sin número → «Sin dato»',
    lab(S(null, { number: 'LT-1' }, 30, 'tarjeta_propiedad')) === 'green|Registrada' && lab(S(null, {}, 30, 'tarjeta_propiedad')) === 'nodata|Sin dato');
  t('ventana de 60: a 45 días ya «Vence en 45 días»', lab(S(addD(HOY, 45), {}, 60)) === 'amber|Vence en 45 días');
  t('ventana de 10 (fuera de la regla): se toma 30 → a 20 días «Vence en 20 días»', lab(S(addD(HOY, 20), {}, 10)) === 'amber|Vence en 20 días');
  t('los 7 documentos, en orden', RD.KINDS.map(k => k.code).join(',') === 'soat,tecnomecanica,seguro,polizas_rc,impuesto,extintor,tarjeta_propiedad');
  t('sin errores al cargar', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Resumen de la flota ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderParts(); await wait();
  const box = b.q('#ptd-flota');
  t('el resumen existe', !!box);
  const next = box && box.nextElementSibling;
  t('queda después de los indicadores de repuestos y antes de «Flota»',
    box && box.previousElementSibling && box.previousElementSibling.id === 'pt-kpis' && next && /Flota/.test(txt(next)), next && txt(next));
  const rt = txt(b.q('#ptd-flota .rule1 .rt'));
  t('titular con los conteos: 1 vencido · 1 vence hoy · 1 por vencer en los próximos 30 días',
    /^Documentos: 1 vencido · 1 vence hoy · 1 por vencer en los próximos 30 días\./.test(rt), rt);
  // 2 carros × 7 = 14; con dato: soat/tecno/tarjeta de C01, soat/seguro de C02; No aplica: extintor de C02 → 8 sin dato
  t('cuenta lo que está sin dato (8), sin contar el «No aplica»', /8 documentos sin dato/.test(rt), rt);
  t('el reloj nunca corrió → lo dice', /El aviso diario todavía no ha corrido\./.test(rt), rt);
  const rows = b.qa('#ptd-due .qrow');
  const rowTxt = rows.map(r => r.getAttribute('data-ptd-row') + ':' + txt(r.querySelector('.st'))).join(' | ');
  t('lista de lo que pide acción, de lo más urgente a lo menos',
    rowTxt === `v1|soat:Vencido hace 3 días | v2|soat:Vence hoy | v1|tecnomecanica:Vence en 30 días`, rowTxt);
  t('el vencido lleva borde rojo y el de 30 días ámbar', rows[0].classList.contains('red') && rows[2].classList.contains('amber'));
  t('cada fila dice fecha, número y entidad reales', /Vence el .* · Nº POL-1 · Aseguradora de prueba/.test(txt(rows[0].querySelector('.sys'))), txt(rows[0].querySelector('.sys')));
  t('al día (31 días), «No aplica» y sin dato no aparecen en la lista', !rows.some(r => /seguro|extintor|impuesto/.test(r.getAttribute('data-ptd-row'))));
  t('botón de anticipación: «Avisar 30 días antes»', txt(b.q('[data-ptd-alert]')) === 'Avisar 30 días antes');
  // Solo los puntos de documentos (los de repuestos dicen «0 vencidos»).
  const dots = (vid) => b.qa(`.vcard[data-pt-veh="${vid}"] .dots .dot`).map(txt).filter(x => /documento/.test(x)).join(' | ');
  t('tarjeta de C01: «1 documento vencido» y «1 documento por vencer»', /1 documento vencido/.test(dots('v1')) && /1 documento por vencer/.test(dots('v1')), dots('v1'));
  t('tarjeta de C02: «1 documento vence hoy» (no dice vencido)', /1 documento vence hoy/.test(dots('v2')) && !/vencido/.test(dots('v2')), dots('v2'));
  t('sin errores', b.errors.length === 0, b.errors.join(' | '));
}
{
  const b = await boot({ docs: () => [], lastRun: { run_on: HOY, ran_at: HOY + 'T12:00:00Z', alerts: 0, pushes: 0 } });
  await b.w.renderParts(); await wait();
  const rt = txt(b.q('#ptd-flota .rule1 .rt'));
  t('sin documentos: «Ningún documento vence…» + 14 sin dato, y ninguna fila inventada',
    /^Ningún documento vence en los próximos 30 días\. 14 documentos sin dato/.test(rt) && !b.q('#ptd-due'), rt);
  t('con el reloj de hoy: «Aviso diario: corrió hoy.»', /Aviso diario: corrió hoy\./.test(rt), rt);
  t('el borde del aviso queda verde', /--green/.test(b.q('#ptd-flota .rule1').getAttribute('style')));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Detalle del carro y cajón ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderParts(); await wait();
  b.click(b.q('.vcard[data-pt-veh="v1"]')); await wait();
  const card = b.q('#ptd-veh-card');
  t('el detalle trae el apartado «Documentos del vehículo» antes de los repuestos',
    !!card && /Documentos del vehículo/.test(txt(card.querySelector('h2'))) && /Repuestos del vehículo/.test(txt(card.nextElementSibling && card.nextElementSibling.querySelector('h2'))));
  const fila = (k) => b.q(`#ptd-veh-card .prow[data-ptd-row="v1|${k}"]`);
  const pr = (k) => txt(fila(k).querySelector('.pr'));
  t('7 filas, una por documento', b.qa('#ptd-veh-card .prow').length === 7);
  t('SOAT vencido · técnico-mecánica a 30 días · tarjeta registrada · seguro sin dato',
    pr('soat') === 'Vencido hace 3 días' && pr('tecnomecanica') === 'Vence en 30 días' && pr('tarjeta_propiedad') === 'Registrada' && pr('seguro') === 'Sin dato',
    ['soat', 'tecnomecanica', 'tarjeta_propiedad', 'seguro'].map(pr).join(' | '));
  t('sin fecha → «—»; la tarjeta dice «no vence»', txt(fila('seguro').querySelector('.pi')) === '—' && txt(fila('tarjeta_propiedad').querySelector('.pi')) === 'no vence');
  const [yy, mm, dd] = addD(HOY, -3).split('-');
  t('la columna de fecha va corta (dd/mm/aaaa) para caber', txt(fila('soat').querySelector('.pi')) === `${dd}/${mm}/${yy}`, txt(fila('soat').querySelector('.pi')));
  t('número y entidad del SOAT a la vista', /Nº POL-1 · Aseguradora de prueba/.test(txt(fila('soat').querySelector('.pb'))));

  // Editar el seguro (sin dato)
  b.click(fila('seguro').querySelector('[data-ptd-edit]')); await wait();
  const dr = () => b.q('[data-ptd-drawer]');
  t('abre el cajón «Seguro todo riesgo · C01» con la fecha vacía', !!dr() && txt(dr().querySelector('.dh b')) === 'Seguro todo riesgo · C01' && b.q('#ptd-f-date').value === '');
  t('vista previa sin fecha: «Sin dato»', /Sin dato/.test(txt(b.q('#ptd-f-calc'))));
  t('el seguro no dice que se ve en Flota (Flota solo tiene SOAT y técnico-mecánica)', !/Flota/.test(txt(dr())));
  const exp = addD(HOY, 10);
  b.type(b.q('#ptd-f-date'), exp);
  t('al escribir la fecha, la vista previa dice «Vence en 10 días»', /Vence en 10 días/.test(txt(b.q('#ptd-f-calc'))), txt(b.q('#ptd-f-calc')));
  b.type(b.q('#ptd-f-num'), '  POL-77 ');
  b.type(b.q('#ptd-f-iss'), 'Aseguradora dos');
  b.type(b.q('#ptd-f-note'), 'Renovado en la oficina');
  b.click(b.q('#ptd-f-save')); await wait(30);
  const sv = b.calls.filter(c => c[0] === 'saveVehicleDocument').pop();
  t('guardar llama a la API con carro, tipo y los datos limpios',
    sv && sv[1] === 'v1' && sv[2] === 'seguro' && JSON.stringify(sv[3]) === JSON.stringify({ expiresOn: exp, number: 'POL-77', issuer: 'Aseguradora dos', notes: 'Renovado en la oficina', notApplicable: false }),
    JSON.stringify(sv));
  t('cierra el cajón y la fila queda «Vence en 10 días» sin volver arriba', !dr() && pr('seguro') === 'Vence en 10 días' && !!b.q('#pt-v-veh.on'), pr('seguro'));
  t('aviso de guardado con el estado', b.toasts.some(m => /Guardado: Seguro todo riesgo de C01 · Vence en 10 días/.test(m)), b.toasts.join(' | '));
  t('el resumen de la flota se repintó (ahora 2 por vencer)', /2 por vencer/.test(txt(b.q('#ptd-flota .rule1 .rt'))), txt(b.q('#ptd-flota .rule1 .rt')));

  // SOAT: dice que es la misma fecha de Flota
  b.click(fila('soat').querySelector('[data-ptd-edit]')); await wait();
  t('el SOAT avisa que es la misma fecha que se ve en Flota', /misma fecha que se ve en Flota/.test(txt(dr())));
  t('el cajón trae los datos guardados (fecha, número, entidad)',
    b.q('#ptd-f-date').value === addD(HOY, -3) && b.q('#ptd-f-num').value === 'POL-1' && b.q('#ptd-f-iss').value === 'Aseguradora de prueba');
  b.click(b.q('[data-ptd-drawer] [data-pt-close]')); await wait();
  t('Cancelar cierra sin guardar', !dr() && b.calls.filter(c => c[0] === 'saveVehicleDocument').length === 1);

  // No aplica
  b.click(fila('polizas_rc').querySelector('[data-ptd-edit]')); await wait();
  b.check(b.q('#ptd-f-na'), true);
  t('marcar «No aplica» → vista previa «No aplica»', /No aplica/.test(txt(b.q('#ptd-f-calc'))));
  b.click(b.q('#ptd-f-save')); await wait(30);
  const na = b.calls.filter(c => c[0] === 'saveVehicleDocument').pop();
  t('guarda con notApplicable = true y sin fecha', na[2] === 'polizas_rc' && na[3].notApplicable === true && na[3].expiresOn === null, JSON.stringify(na));
  t('la fila queda «No aplica» y con «—» en la fecha', pr('polizas_rc') === 'No aplica' && txt(fila('polizas_rc').querySelector('.pi')) === '—');

  // Tarjeta de propiedad: sin fecha
  b.click(fila('tarjeta_propiedad').querySelector('[data-ptd-edit]')); await wait();
  t('la tarjeta de propiedad no pide fecha', !b.q('#ptd-f-date') && /no vence/.test(txt(dr())));
  b.type(b.q('#ptd-f-num'), 'LT-100');
  b.click(b.q('#ptd-f-save')); await wait(30);
  const tp = b.calls.filter(c => c[0] === 'saveVehicleDocument').pop();
  t('guarda la tarjeta con expiresOn null y el número nuevo', tp[2] === 'tarjeta_propiedad' && tp[3].expiresOn === null && tp[3].number === 'LT-100');
  t('sin errores', b.errors.length === 0, b.errors.join(' | '));
}
{
  const b = await boot({ saveErr: 'BAD_DATE: esa fecha de vencimiento no se ve bien (1990-01-01)' });
  await b.w.renderParts(); await wait();
  b.click(b.q('.vcard[data-pt-veh="v2"]')); await wait();
  b.click(b.q('#ptd-veh-card [data-ptd-edit="v2|impuesto"]')); await wait();
  t('el impuesto pide «Fecha límite de pago»', /Fecha límite de pago/.test(txt(b.q('[data-ptd-drawer] .fld label'))));
  t('Cancelar con el velo también cierra', (() => { b.click(b.q('#parts-drawer-root .scrim')); return !b.q('[data-ptd-drawer]'); })());
  b.click(b.q('#ptd-veh-card [data-ptd-edit="v2|impuesto"]')); await wait();
  b.type(b.q('#ptd-f-date'), '1990-01-01');
  b.click(b.q('#ptd-f-save')); await wait(30);
  t('error de la base traducido y el cajón sigue abierto con el botón activo',
    b.toasts.includes('Esa fecha de vencimiento no se ve bien. Revísala.') && !!b.q('[data-ptd-drawer]') && !b.q('#ptd-f-save').disabled, b.toasts.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Días de anticipación ──');
{
  const b = await boot({ promptAnswers: ['15', '45'], docs: () => [
    { id: 'a', vehicle_id: 'v1', kind: 'soat', expires_on: addD(HOY, 40), number: null, issuer: null, notes: null, not_applicable: false }] });
  await b.w.renderParts(); await wait();
  t('a 40 días con ventana de 30: al día (nada en la lista)', !b.q('#ptd-due'));
  b.click(b.q('[data-ptd-alert]')); await wait(20);
  t('15 días: se rechaza (mínimo un mes) y NO llama a la API',
    b.toasts.some(m => /entre 30 y 180 días/.test(m)) && !b.calls.some(c => c[0] === 'setVehicleDocAlertDays'), b.toasts.join(' | '));
  t('el prompt ofrece el valor actual (30)', b.prompts[0] && b.prompts[0][1] === 30);
  b.click(b.q('[data-ptd-alert]')); await wait(30);
  t('45 días: guarda y relee', b.calls.some(c => c[0] === 'setVehicleDocAlertDays' && c[1] === 45)
    && b.calls.filter(c => c[0] === 'getVehicleDocAlertDays').length >= 2);
  t('el botón dice «Avisar 45 días antes» y el SOAT a 40 días ya aparece por vencer',
    txt(b.q('[data-ptd-alert]')) === 'Avisar 45 días antes' && /Vence en 40 días/.test(txt(b.q('#ptd-due'))), txt(b.q('#ptd-flota')));
}
{
  const b = await boot({ promptAnswers: ['60'], keepDays: true });
  await b.w.renderParts(); await wait();
  b.click(b.q('[data-ptd-alert]')); await wait(30);
  t('si la base no tomó el cambio (sin permiso), lo dice y no finge',
    b.toasts.some(m => /No se guardó el cambio/.test(m)) && txt(b.q('[data-ptd-alert]')) === 'Avisar 30 días antes', b.toasts.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Sin la migración / sin la API ──');
{
  const b = await boot({ docsErr: 'relation "public.vehicle_documents" does not exist' });
  await b.w.renderParts(); await wait();
  t('sin la tabla: el resumen lo dice (sin inventar filas)',
    /No se pudieron leer los documentos del carro\..*Puede faltar la migración 0095\./.test(txt(b.q('#ptd-flota'))) && !b.q('#ptd-due'), txt(b.q('#ptd-flota')));
  t('…y Repuestos sigue: tarjetas de carros y cola pintadas', b.qa('.vcard').length === 2 && !!b.q('#pt-kpis .kpi'));
  b.click(b.q('.vcard[data-pt-veh="v1"]')); await wait();
  t('el detalle muestra la nota en vez de filas', !!b.q('#ptd-veh-card .note') && !b.q('#ptd-veh-card .prow'));
  t('las tarjetas no pintan puntos de documentos', !/documento/.test(txt(b.q('.vcard[data-pt-veh="v2"] .dots')) || ''));
}
{
  const b = await boot({ sinApiDocs: true });
  await b.w.renderParts(); await wait();
  t('sin las funciones en Api: lo dice y no revienta', /No se pudieron leer los documentos del carro/.test(txt(b.q('#ptd-flota'))) && b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Enlace del aviso ──');
{
  const b = await boot();
  t('renderParts.focus existe (como renderCobro.focus)', typeof b.w.renderParts.focus === 'function');
  b.w.renderParts.focus('v2');
  await b.w.renderParts(); await wait();
  t('abre C02 con sus documentos', !!b.q('#pt-v-veh.on') && b.q('#ptd-veh-card') && b.q('#ptd-veh-card').dataset.vid === 'v2');
  await b.w.renderParts(); await wait();
  t('el foco se usa una sola vez (volver a Repuestos abre la flota)', !!b.q('#pt-v-estado.on') && !b.q('#pt-v-veh.on'));
}

// ══════════════════════════════════════════════════════════════════════════
// El camino de verdad: la push abre /#/repuestos?veh=<id>. Con el applyDeepLink
// de core.js (recortado del archivo) y un setTab como el de core.
console.log('\n── Enlace del aviso: el camino real (#/repuestos?veh=…) ──');
{
  // En frío: la app arranca con el hash puesto; enterApp hace lo de core.js.
  const b = await boot({ core: true, url: 'http://localhost/#/repuestos?veh=v2' });
  b.w.state.profile = { role: 'admin' };
  const tomoCore = b.w.eval('applyDeepLink()');
  if (!tomoCore) b.w.eval("setTab('consola')");
  console.log('  · core.applyDeepLink ' + (tomoCore ? 'ya conoce' : 'todavía no conoce') + ' #/repuestos (si no, lo resuelve admin-repuestos.js)');
  await wait(700);
  t('en frío: termina en Repuestos, no en la consola', b.w.state.activeTab === 'parts', b.w.state.activeTab);
  t('…con la sección de Repuestos visible', !b.w.document.querySelector('section[data-panel="parts"]').classList.contains('hidden'));
  t('…abierto en C02 con sus documentos', !!b.q('#pt-v-veh.on') && b.q('#ptd-veh-card') && b.q('#ptd-veh-card').dataset.vid === 'v2');
  t('…y el hash se limpia (un refresco no vuelve a abrir lo mismo)', b.w.location.hash === '', b.w.location.hash);

  // Con la app ya abierta: el service worker solo cambia el hash.
  b.w.eval("setTab('consola')"); await wait();
  const antes = b.calls.filter((c) => c[0] === 'listVehicleDocuments').length;
  b.w.location.hash = '#/repuestos?veh=v1';
  await wait(60);
  if (b.w.state.activeTab !== 'parts') { b.w.dispatchEvent(new b.w.HashChangeEvent('hashchange')); await wait(60); }
  t('app abierta (hashchange): pasa de la consola a Repuestos', b.w.state.activeTab === 'parts', b.w.state.activeTab);
  t('…abierto en C01', b.q('#ptd-veh-card') && b.q('#ptd-veh-card').dataset.vid === 'v1');
  t('…relee los documentos (el aviso pudo llegar con la pantalla vieja)', b.calls.filter((c) => c[0] === 'listVehicleDocuments').length > antes);
  t('…y limpia el hash', b.w.location.hash === '', b.w.location.hash);

  // Un carro que ya no está en la flota.
  b.w.eval("setTab('consola')"); await wait();
  b.w.location.hash = '#/repuestos?veh=borrado';
  await wait(60);
  if (b.w.state.activeTab !== 'parts') { b.w.dispatchEvent(new b.w.HashChangeEvent('hashchange')); await wait(60); }
  t('carro que ya no existe: Repuestos en la vista de la flota', b.w.state.activeTab === 'parts' && !!b.q('#pt-v-estado.on') && !b.q('#pt-v-veh.on'));
  t('…y lo dice (no se queda callado)', b.toasts.some((m) => /ya no está en la flota/.test(m)), b.toasts.slice(-2).join(' | '));

  // Sin carro en el enlace: la flota.
  b.w.eval("setTab('consola')"); await wait();
  b.w.location.hash = '#/repuestos';
  await wait(60);
  if (b.w.state.activeTab !== 'parts') { b.w.dispatchEvent(new b.w.HashChangeEvent('hashchange')); await wait(60); }
  t('#/repuestos sin carro: abre Repuestos en la flota', b.w.state.activeTab === 'parts' && !!b.q('#pt-v-estado.on'));
  t('sin errores en todo el recorrido', b.errors.length === 0, b.errors.join(' | '));
}
{
  // El día que core.js conozca #/repuestos (arreglo propuesto, simulado): core lo
  // toma primero y este módulo ya no encuentra hash. Una sola carga, mismo final.
  const b = await boot({ core: 'conRepuestos', url: 'http://localhost/#/repuestos?veh=v2' });
  b.w.state.profile = { role: 'admin' };
  const tomo = b.w.eval('applyDeepLink()');
  if (!tomo) b.w.eval("setTab('consola')");
  await wait(700);
  t('con el arreglo en core.js: core lo toma y abre C02', tomo === true && b.w.state.activeTab === 'parts' && b.q('#ptd-veh-card') && b.q('#ptd-veh-card').dataset.vid === 'v2');
  t('…sin segunda carga de este módulo (no se pisan)', b.calls.filter((c) => c[0] === 'listVehicleDocuments').length === 1, b.calls.filter((c) => c[0] === 'listVehicleDocuments').length);
  b.w.eval("setTab('consola')"); await wait();
  b.w.location.hash = '#/repuestos?veh=v1';
  await wait(60);
  if (b.w.state.activeTab !== 'parts') { b.w.dispatchEvent(new b.w.HashChangeEvent('hashchange')); await wait(60); }
  t('…y con la app abierta también (un oyente de cada lado)', b.w.state.activeTab === 'parts' && b.q('#ptd-veh-card') && b.q('#ptd-veh-card').dataset.vid === 'v1' && b.w.location.hash === '');
  t('…sin errores', b.errors.length === 0, b.errors.join(' | '));
}
{
  // Quien entra no es jefe: el enlace no es suyo, no se toca.
  const b = await boot({ core: true, url: 'http://localhost/#/repuestos?veh=v2' });
  b.w.state.profile = { role: 'driver' };
  b.w.state.activeTab = 'disponibilidad';
  await wait(400);
  t('no jefe: no abre Repuestos ni lee documentos', b.w.state.activeTab === 'disponibilidad' && !b.calls.some((c) => c[0] === 'listVehicleDocuments'), b.w.state.activeTab);
  t('…y deja el hash como estaba', b.w.location.hash === '#/repuestos?veh=v2', b.w.location.hash);
  b.w.dispatchEvent(new b.w.HashChangeEvent('hashchange')); await wait(60);
  t('…tampoco en hashchange', b.w.state.activeTab === 'disponibilidad');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Flota (admin-flota.js): la misma fecha, sin pisar la de Repuestos ──');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], upd = [], cre = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.toast = () => {}; w.alert = (m) => errors.push('alert: ' + m); w.confirm = () => true;
  w.Element.prototype.scrollIntoView = function () {};   // jsdom no lo trae
  w.eval(`
    function $(sel) { return document.querySelector(sel); }
    function $$(sel) { return document.querySelectorAll(sel); }
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
    function setOilBadge() {}
    var state = { profile: { id: 'jefe', role: 'admin', organization_id: 'org1' } };
  `);
  const V = [{ ...VEHS()[0], soat_expires_at: addD(HOY, 100), tecnomec_expires_at: addD(HOY, 200), last_maintenance_km: 45000, maintenance_interval_km: 7000 }];
  w.Api = {
    listVehiclesForShift: async () => JSON.parse(JSON.stringify(V)),
    updateVehicle: async (id, patch) => { upd.push([id, JSON.parse(JSON.stringify(patch))]); },
    createVehicle: async (v) => { cre.push(JSON.parse(JSON.stringify(v))); return 'nuevo'; },
  };
  try { w.eval(read('admin-flota.js')); } catch (e) { errors.push('admin-flota.js: ' + e.message); }
  await w.renderVehiclesSettings(); await wait();
  const hint = w.document.getElementById('new-veh-docs-hint');
  t('debajo de SOAT y técnico-mecánica dice que son las mismas fechas de Repuestos', !!hint && /mismas fechas de Repuestos › Documentos del carro/.test(txt(hint)));
  await w.renderVehiclesSettings(); await wait();
  t('la línea se pone una sola vez', w.document.querySelectorAll('#new-veh-docs-hint').length === 1);
  w.onEditVehicle('v1');
  w.document.getElementById('new-veh-capacity').value = '3';
  await w.onCreateVehicle(); await wait();
  const p1 = upd.pop();
  t('editar otra cosa NO manda SOAT ni técnico-mecánica (no pisa lo cargado en Repuestos)',
    p1 && p1[1].capacity === 3 && !('soat_expires_at' in p1[1]) && !('tecnomec_expires_at' in p1[1]), JSON.stringify(p1));
  w.onEditVehicle('v1');
  const nueva = addD(HOY, 365);
  w.document.getElementById('new-veh-soat').value = nueva;
  await w.onCreateVehicle(); await wait();
  const p2 = upd.pop();
  t('cambiar el SOAT en Flota sí lo manda (y solo ese)', p2 && p2[1].soat_expires_at === nueva && !('tecnomec_expires_at' in p2[1]), JSON.stringify(p2));
  w.document.getElementById('new-veh-code').value = 'C09';
  w.document.getElementById('new-veh-plate').value = 'prb009';
  w.document.getElementById('new-veh-soat').value = nueva;
  await w.onCreateVehicle(); await wait();
  t('un carro nuevo se crea con su SOAT (la base lo copia a Documentos)', cre.length === 1 && cre[0].soat_expires_at === nueva && cre[0].tecnomec_expires_at === null, JSON.stringify(cre[0]));
  t('sin errores', errors.length === 0, errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── api.js contra un cliente falso ──');
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const log = [];
  const RESP = { vehicle_documents: { data: [{ id: 'd' }], error: null }, app_settings: { data: { vehicle_doc_alert_days: 45 }, error: null },
    vehicle_document_job_runs: { data: [{ run_on: HOY }], error: null } };
  const builder = (table) => {
    const q = { _t: table };
    ['select', 'eq', 'order', 'limit', 'update', 'maybeSingle', 'is', 'in', 'not'].forEach((m) => {
      q[m] = (...a) => { log.push([table, m, JSON.parse(JSON.stringify(a))]); return q; };
    });
    q.then = (res, rej) => Promise.resolve(RESP[table] || { data: null, error: null }).then(res, rej);
    return q;
  };
  w.sb = { from: (t) => { log.push([t, 'from']); return builder(t); },
    rpc: async (fn, args) => { log.push(['rpc', fn, JSON.parse(JSON.stringify(args))]); return { data: { ok: true }, error: null }; } };
  w.eval(read('api.js'));
  const A = w.Api;
  t('api.js exporta las 5 funciones nuevas',
    ['listVehicleDocuments', 'saveVehicleDocument', 'getVehicleDocAlertDays', 'setVehicleDocAlertDays', 'getVehicleDocLastRun'].every(f => typeof A[f] === 'function'));
  const list = await A.listVehicleDocuments();
  t('listVehicleDocuments lee vehicle_documents con sus columnas', list.length === 1
    && log.some(l => l[0] === 'vehicle_documents' && l[1] === 'select' && /vehicle_id, kind, expires_on, number, issuer, notes, not_applicable/.test(l[2][0])));
  await A.saveVehicleDocument('v9', 'soat', { expiresOn: '2027-01-15', number: 'N1', issuer: null, notes: '', notApplicable: false });
  const r1 = log.filter(l => l[0] === 'rpc').pop();
  t('saveVehicleDocument → rpc save_vehicle_document con los 7 parámetros',
    r1[1] === 'save_vehicle_document' && JSON.stringify(r1[2]) === JSON.stringify({ p_vehicle_id: 'v9', p_kind: 'soat', p_expires_on: '2027-01-15', p_number: 'N1', p_issuer: null, p_notes: null, p_not_applicable: false }),
    JSON.stringify(r1));
  await A.saveVehicleDocument('v9', 'extintor', { notApplicable: true });
  const r2 = log.filter(l => l[0] === 'rpc').pop();
  t('…«No aplica» sin fecha → p_expires_on null, p_not_applicable true', r2[2].p_expires_on === null && r2[2].p_not_applicable === true);
  t('getVehicleDocAlertDays lee app_settings.vehicle_doc_alert_days del singleton',
    (await A.getVehicleDocAlertDays()) === 45 && log.some(l => l[0] === 'app_settings' && l[1] === 'select' && l[2][0] === 'vehicle_doc_alert_days')
    && log.some(l => l[0] === 'app_settings' && l[1] === 'eq' && l[2][0] === 'id' && l[2][1] === 'singleton'));
  await A.setVehicleDocAlertDays(60);
  t('setVehicleDocAlertDays actualiza solo esa columna', log.some(l => l[0] === 'app_settings' && l[1] === 'update' && JSON.stringify(l[2][0]) === '{"vehicle_doc_alert_days":60}'));
  const run = await A.getVehicleDocLastRun();
  t('getVehicleDocLastRun: la corrida más reciente de vehicle_document_job_runs', run && run.run_on === HOY
    && log.some(l => l[0] === 'vehicle_document_job_runs' && l[1] === 'order' && l[2][0] === 'run_on' && l[2][1].ascending === false));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── La migración 0095 (lectura estática: NO se ejecuta) ──');
{
  const sql = readFileSync(MIG, 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');
  t('BEGIN … COMMIT', /^\s*BEGIN;/m.test(code) && /COMMIT;\s*$/.test(code));
  t('los $$ de las funciones están pareados', (code.match(/\$\$/g) || []).length % 2 === 0);
  t('tablas con IF NOT EXISTS', (code.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || []).length === 0);
  const pols = [...code.matchAll(/CREATE POLICY (\w+)/g)].map(m => m[1]);
  t('cada política se borra antes de crearse', pols.length === 3 && pols.every(p => code.includes('DROP POLICY IF EXISTS ' + p)), pols.join(','));
  const trg = [...code.matchAll(/CREATE TRIGGER (\w+)/g)].map(m => m[1]);
  t('cada disparador se borra antes de crearse', trg.length === 3 && trg.every(x => code.includes('DROP TRIGGER IF EXISTS ' + x)), trg.join(','));
  const fns = code.split(/CREATE OR REPLACE FUNCTION/).slice(1);
  t('toda función SECURITY DEFINER fija el search_path',
    fns.filter(f => /SECURITY DEFINER/.test(f.split('AS $$')[0])).every(f => /SET search_path = public, pg_temp/.test(f.split('AS $$')[0])));
  t('los dos disparadores del espejo cortan con pg_trigger_depth()', (code.match(/IF pg_trigger_depth\(\) > 1 THEN RETURN NULL; END IF;/g) || []).length === 2);
  const chk = (code.match(/CONSTRAINT vehicle_documents_kind CHECK \(kind IN \(([^)]*)\)/) || [])[1] || '';
  const arr = (code.match(/SELECT ARRAY\[([^\]]*)\]::text\[\]/) || [])[1] || '';
  const norm = (s) => s.replace(/[\s']/g, '');
  t('el CHECK, vehicle_document_kinds() y el front tienen los mismos 7 tipos',
    norm(chk) === norm(arr) && norm(arr) === 'soat,tecnomecanica,seguro,polizas_rc,impuesto,extintor,tarjeta_propiedad', norm(chk) + ' / ' + norm(arr));
  t('UNIQUE (vehicle_id, kind)', /UNIQUE \(vehicle_id, kind\)/.test(code));
  t('relleno desde vehicles.soat/tecnomec/insurance_expires_at', /\('soat', v\.soat_expires_at\)/.test(code) && /\('tecnomecanica', v\.tecnomec_expires_at\)/.test(code) && /\('seguro', v\.insurance_expires_at\)/.test(code));
  t('aviso por notification_outbox a ops_alert_recipients() de la organización (como 0090)',
    /INSERT INTO public\.notification_outbox/.test(code) && /FROM public\.ops_alert_recipients\(\) rc\s+JOIN public\.profiles p ON p\.id = rc\.profile_id\s+WHERE p\.organization_id = r\.organization_id/.test(code));
  t('umbrales N («ventana») / 15 / 7 / 1 / hoy / vencido semanal', ["'ventana'", 'faltan:1', 'faltan:7', 'faltan:15', "'hoy'", "'vencido:'", '/ 7)'].every(s => code.includes(s)));
  t('registro de avisos con clave única (no repite)', /vehicle_document_alerts_dedupe_key UNIQUE \(dedupe_key\)/.test(code) && /a\.day = v_today/.test(code));
  const cron0090 = (readFileSync(new URL('../supabase/migrations/0090_facturario.sql', import.meta.url).pathname, 'utf8').match(/cron\.schedule\('billing-daily', '([^']+)'/) || [])[1];
  t('el reloj corre a la misma hora que el de 0090', !!cron0090 && code.includes(`cron.schedule('vehicle-docs-daily', '${cron0090}'`), cron0090);
  t('mínimo de anticipación 30 días en la base', /CHECK \(vehicle_doc_alert_days BETWEEN 30 AND 180\)/.test(code));
  t('nada bloquea: la migración no toca vehicles.status', !/status\s*=\s*'blocked'|SET status/.test(code));

  // Lo que ve el conductor (30-sep-2026). La prueba de verdad es _verify-0095.mjs
  // contra la base local; esto solo vigila el texto por si esa no se corre.
  const drv = (code.split('CREATE OR REPLACE FUNCTION public.driver_vehicle_documents(')[1] || '').split('COMMENT ON FUNCTION')[0];
  t('existe driver_vehicle_documents(p_vehicle_ids uuid[] DEFAULT NULL)', /^p_vehicle_ids uuid\[\] DEFAULT NULL\)/.test(drv), drv.slice(0, 60));
  t('…SECURITY DEFINER con search_path fijo', /SECURITY DEFINER\s+SET search_path = public, pg_temp/.test(drv));
  t('…valida un conductor activo leyendo profiles (no el JWT)', /FROM public\.profiles p WHERE p\.id = v_uid/.test(drv) && /role::text <> 'driver'/.test(drv) && /is_active/.test(drv) && /deleted_at IS NOT NULL/.test(drv) && /RAISE EXCEPTION 'NOT_A_DRIVER/.test(drv));
  const drvKinds = (drv.match(/unnest\(ARRAY\[([^\]]*)\]::text\[\]\)/) || [])[1] || '';
  t('…solo los 5 de la vía (sin impuesto ni tarjeta de propiedad)', norm(drvKinds) === 'soat,tecnomecanica,seguro,polizas_rc,extintor', norm(drvKinds));
  t('…no devuelve número, entidad ni nota', !/\b(number|issuer|notes)\b/.test(drv));
  t('…solo carros de SU organización y vivos', /v\.organization_id = v_me\.organization_id/.test(drv) && /v\.deleted_at IS NULL/.test(drv));
  t('…misma ventana del aviso a los jefes (mínimo 30)', /greatest\(30, coalesce\(v_window, 30\)\)/.test(drv) && /vehicle_doc_alert_days/.test(drv));
  t('…estados no_aplica / sin_dato / vencido / hoy / por_vencer / al_dia', ["'no_aplica'", "'sin_dato'", "'vencido'", "'hoy'", "'por_vencer'", "'al_dia'"].every(s => drv.includes(s)));
  t('…EXECUTE para authenticated, nada para anon/PUBLIC', /'public\.driver_vehicle_documents\(uuid\[\]\)',\s*'public\.vehicle_document_kinds\(\)'/.test(code) && /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon/.test(code));
  t('…la tabla sigue cerrada: ninguna política nueva para el conductor', !/CREATE POLICY \w+ ON public\.vehicle_documents[^;]*'driver'/.test(code));
  const down = readFileSync(new URL('../down_migrations/0095_documentos_del_carro.down.sql', import.meta.url).pathname, 'utf8');
  t('…y el down la borra', /DROP FUNCTION IF EXISTS public\.driver_vehicle_documents\(uuid\[\]\);/.test(down));
}

console.log(`\n${ok} ok · ${bad} fallos`);
process.exit(bad ? 1 : 0);
