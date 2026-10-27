// Tarjeta del detector de cadena (admin-cadena.js DE VERDAD, con index.html) — 0152.
//
// Comprueba:
//   · «reasignar»: qué pasa (+min tarde), el recomendado con «Alcanza» y el botón
//     «Pasar a X»; al tocarlo llama admin_cadena_aplicar, refleja el cambio en el
//     tablero abierto (RendioRutasV2.reflejar) y cierra con «Listo…»;
//   · si la base dice que ya no aplica: lo dice y repinta con lo de ahora;
//   · el recomendado ya no alcanza: botón apagado y «Ya no alcanza»;
//   · «delegar»: sin «Pasar a», con «Delegarla» y «Delegar u otras opciones»;
//   · resuelta: dice por qué y no ofrece «Descartar»;
//   · «Descartar», «Ver otras opciones» (carga el día y abre la hoja de la vuelta)
//     y «Apagar estas recomendaciones»;
//   · core.js abre la tarjeta con #/rutas?cadena=<id>; api.js llama las RPC de 0152.
//
// NO cubre: la base (_aplicar-0152.mjs), la push ni el teléfono.
//
//   cd rendio-backend && node scripts/_smoke-cadena-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const at = (h) => new Date(`2026-10-27T${h}:00-05:00`).toISOString();

const BASE = {
  id: 'A1', route: 'RA9', kind: 'reasignar', activa: true,
  need_at: at('11:30'), eta_at: at('11:57'), late_min: 27, why: 'termina ~11:35 la vuelta de las 10:40',
  suggested: 'DP2', suggested_name: 'Daniel Ruiz Pérez', suggested_eta_at: at('11:28'), suggested_why: 'termina ~11:20 la vuelta de las 10:50',
  resolved_at: null, resolution: null,
  ahora: { known: true, tipo: 'Llegada', quien: 'Enrique Mesa', dia: '2026-10-27', need_at: at('11:30'), eta_at: at('11:57'), late_min: 27,
           why: 'termina ~11:35 la vuelta de las 10:40', driver_name: 'Juan Gómez Ríos' },
  sigue: { ok: true, eta: at('11:28'), motivo: null },
};

function boot(datos, opts = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const log = { ver: [], aplicar: [], descartar: [], encender: [], reflejar: [], abrirVuelta: [], cargarDia: [], toasts: [], errores: [] };
  w.addEventListener('error', (e) => log.errores.push(e.message));
  w.toast = (m) => log.toasts.push(m);
  w.confirm = () => true;
  let cola = Array.isArray(datos) ? datos.slice() : [datos];
  w.Api = {
    cadenaVer: async (id) => { log.ver.push(id); return JSON.parse(JSON.stringify(cola.length > 1 ? cola.shift() : cola[0])); },
    cadenaAplicar: async (id) => { log.aplicar.push(id); return opts.aplicar ? opts.aplicar(id) : { ok: true, name: 'Daniel Ruiz Pérez', profile_id: 'P2', route: 'RA9' }; },
    cadenaDescartar: async (id) => { log.descartar.push(id); return { ok: true }; },
    cadenaEncender: async (on) => { log.encender.push(on); return on; },
  };
  w.RendioRutasV2 = {
    reflejar: (ra, pid) => { log.reflejar.push([ra, pid]); return true; },
    diaActual: () => opts.dia || '2026-10-26',
    cargarDia: async (d) => { log.cargarDia.push(d); },
    abrirVuelta: (ra) => { log.abrirVuelta.push(ra); return true; },
  };
  w.eval(read('admin-cadena.js'));
  const $ = (s) => w.document.querySelector(s);
  return { w, log, $, txt: () => ($('#cd-body') || {}).textContent || '', hidden: () => $('#cadena').classList.contains('hidden') };
}

console.log('\n── 0152 · La tarjeta «X no alcanza · Recomendado: Y» ──');
{
  const a = boot(BASE);
  t('la tarjeta existe en index.html y empieza cerrada', !!a.$('#cadena') && a.hidden());
  await a.w.RendioCadena.abrir('A1'); await wait();
  t('abrir: pide la recomendación a la base con su id', a.log.ver[0] === 'A1');
  t('…se ve la tarjeta', !a.hidden());
  t('el encabezado dice qué vuelta: «Llegada de las 11:30 · Enrique Mesa»', /Llegada de las 11:30 · Enrique Mesa/.test(a.$('#cd-sub').textContent), a.$('#cd-sub').textContent);
  t('qué pasa: «Juan Gómez no alcanza» con +27 min y por qué', /Juan Gómez no alcanza/.test(a.txt()) && /\+27 min/.test(a.txt()) && /termina ~11:35 la vuelta de las 10:40 y llegaría 11:57/.test(a.txt()), a.txt());
  t('recomendado: Daniel Ruiz, «Alcanza», llega 11:28', /Daniel Ruiz/.test(a.txt()) && /Alcanza/.test(a.txt()) && /llega 11:28/.test(a.txt()));
  const b = a.$('[data-cd="aplicar"]');
  t('botón «Pasar a Daniel Ruiz» encendido', b && b.textContent === 'Pasar a Daniel Ruiz' && !b.disabled, b && b.outerHTML);
  t('…dice que publica solo esta vuelta y a quién avisa', /Publica solo esta vuelta/.test(a.txt()) && /El resto del día no se toca/.test(a.txt()));
  b.click(); await wait();
  t('«Pasar a»: llama admin_cadena_aplicar con el id', a.log.aplicar.length === 1 && a.log.aplicar[0] === 'A1');
  t('…refleja el cambio en el tablero abierto (vuelta y conductor nuevo)', JSON.stringify(a.log.reflejar) === JSON.stringify([['RA9', 'P2']]), JSON.stringify(a.log.reflejar));
  t('…cierra y dice «Listo: Daniel Ruiz hace esa vuelta»', a.hidden() && /Listo: Daniel Ruiz hace esa vuelta/.test(a.log.toasts.join('|')), a.log.toasts.join('|'));
  t('sin errores de JS', a.log.errores.length === 0, a.log.errores.join(' | '));
}
{
  const ya = { ...BASE, sigue: { ok: false, eta: null, motivo: 'se le cruza con otra vuelta suya' } };
  const a = boot([BASE, ya], { aplicar: () => ({ ok: false, motivo: 'Daniel Ruiz ya no alcanza: se le cruza con otra vuelta suya.' }) });
  await a.w.RendioCadena.abrir('A1'); await wait();
  a.$('[data-cd="aplicar"]').click(); await wait(40);
  t('si ya no aplica: lo dice («ya no alcanza…») y no refleja nada', /ya no alcanza/.test(a.log.toasts.join('|')) && a.log.reflejar.length === 0, a.log.toasts.join('|'));
  t('…y repinta con lo de ahora (vuelve a pedirla)', a.log.ver.length === 2 && !a.hidden());
  const b = a.$('[data-cd="aplicar"]');
  t('…el botón queda apagado y el recomendado dice «Ya no alcanza» con el motivo', b && b.disabled && /Ya no alcanza/.test(a.txt()) && /se le cruza/.test(a.txt()));
}
{
  const a = boot({ ...BASE, kind: 'delegar', suggested: null, suggested_name: null, suggested_eta_at: null, suggested_why: null, sigue: null });
  await a.w.RendioCadena.abrir('A2'); await wait();
  t('«delegar»: no hay «Pasar a»', !a.$('[data-cd="aplicar"]'));
  t('…recomienda «Delegarla» (Uber o conductor de confianza)', /Delegarla/.test(a.txt()) && /Uber o a un conductor de confianza/.test(a.txt()));
  const o = a.$('[data-cd="opciones"]');
  t('…el botón dice «Delegar u otras opciones»', o && o.textContent === 'Delegar u otras opciones', o && o.textContent);
  o.click(); await wait(40);
  t('«otras opciones»: carga el día de la vuelta si el tablero está en otro', JSON.stringify(a.log.cargarDia) === '["2026-10-27"]', JSON.stringify(a.log.cargarDia));
  t('…y abre la hoja de ESA vuelta', JSON.stringify(a.log.abrirVuelta) === '["RA9"]' && a.hidden(), JSON.stringify(a.log.abrirVuelta));
}
{
  const a = boot({ ...BASE, resolved_at: at('11:20'), resolution: 'aplicado', sigue: null });
  await a.w.RendioCadena.abrir('A3'); await wait();
  t('resuelta: «Ya se la pasaron al recomendado», sin «Pasar» ni «Descartar»', /Ya se la pasaron/.test(a.txt()) && !a.$('[data-cd="aplicar"]') && !a.$('[data-cd="descartar"]'));
}
{
  const a = boot(BASE);
  await a.w.RendioCadena.abrir('A1'); await wait();
  a.$('[data-cd="descartar"]').click(); await wait();
  t('«Descartar»: llama admin_cadena_descartar y cierra', JSON.stringify(a.log.descartar) === '["A1"]' && a.hidden() && /Descartada/.test(a.log.toasts.join('|')));
  await a.w.RendioCadena.abrir('A1'); await wait();
  const ap = a.$('[data-cd="apagar"]');
  t('«Apagar estas recomendaciones» está abajo', ap && /Apagar estas recomendaciones/.test(ap.textContent));
  ap.click(); await wait();
  t('…al tocarlo (y confirmar) apaga el detector', JSON.stringify(a.log.encender) === '[false]' && /apagadas/.test(a.log.toasts.join('|')));
  t('…y queda la opción de volver a encenderlo', /Volver a encender/.test(a.$('[data-cd="apagar"]').textContent));
  a.$('#cd-close').click();
  t('«Cerrar» cierra', a.hidden());
  t('sin errores de JS', a.log.errores.length === 0, a.log.errores.join(' | '));
}
{
  const core = read('core.js'), api = read('api.js'), sw = read('sw.js'), html = read('index.html');
  t('core.js: #/rutas?cadena=<id> abre la tarjeta', /params\.get\('cadena'\)/.test(core) && /RendioCadena\.abrir\(cad\)/.test(core));
  t('api.js: las cuatro RPC con sus parámetros', /admin_cadena_ver', \{ p_alert: id \}/.test(api) && /admin_cadena_aplicar', \{ p_alert: id \}/.test(api)
    && /admin_cadena_descartar', \{ p_alert: id \}/.test(api) && /admin_cadena_encender', \{ p_on: !!on \}/.test(api) && /cadenaVer, cadenaAplicar, cadenaDescartar, cadenaEncender/.test(api));
  t('index.html carga admin-cadena.js y el SW la guarda (v237)', /<script src="admin-cadena\.js"><\/script>/.test(html) && /'\/admin-cadena\.js'/.test(sw) && /rendio-turnos-v237/.test(sw));
}
console.log(`\n${ok} en verde, ${bad} en rojo`);
process.exit(bad ? 1 : 0);
