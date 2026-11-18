// El CHAT DEL TURNO (0173, 17-nov-2026) — prueba jsdom de chat-turno.js + api-chat-turno.js.
//
// Harold: «un chat donde desde el sistema nos podamos comunicar con los conductores…
// un chat grupal que se limpie cada que cambian de turno».
//
// Con los archivos de verdad y una base FALSA en memoria (las cinco funciones
// shift_chat_*), comprueba:
//   A) Sin 0173 en la base: nadie muestra el chat (resumen().falta).
//   B) Conductor en turno: quiénes están, burbujas, marca JEFE, chulitos, respuestas
//      de un toque, enviar (con el aviso a jefes y compañeros), que el campo de
//      escribir NO se repinta con cada lectura, y que lo que ve queda leído.
//   C) Conductor fuera de turno: no entra y la pantalla dice por qué.
//   D) Jefe: cajitas de los conductores, «Leído por 1 de 2» y quiénes, turnos
//      anteriores (solo lectura) y volver.
//   E) Un envío que falla: se dice y lo escrito vuelve al campo.
//   F) La fila «Chat del turno» del Inicio del conductor.
//   G) Un mensaje con HTML no se ejecuta.
//
// LO QUE NO CUBRE: cómo se ve (jsdom no dibuja: se miró con Chromium, celular y PC),
// la base de verdad (eso es _aplicar-0173.mjs, en seco) y un teléfono real.
//
//   cd rendio-backend && node scripts/_smoke-chat-turno-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + String(d).slice(0, 300) : '')); } };
const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const tx = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');

const JEFE = 'a0000000-0000-4000-8000-000000000001', JEFE2 = 'a0000000-0000-4000-8000-000000000002';
const MIGUEL = 'd0000000-0000-4000-8000-000000000001', JUAN = 'd0000000-0000-4000-8000-000000000002';
const NOMBRE = { [JEFE]: 'Julián', [JEFE2]: 'Camilo', [MIGUEL]: 'Miguel Ángel', [JUAN]: 'Juan Andrés' };

function mundo() {
  const DB = {
    falta: false, yo: MIGUEL, rol: 'driver', miembro: true, fallaEnvio: null, llamadas: [],
    turno: { day: '2026-11-17', band: 'pm' }, drivers: [MIGUEL, JUAN], admins: [JEFE, JEFE2],
    msgs: [
      { id: 'm1', s: MIGUEL, r: 'driver', body: 'Ya estoy en JMC, esperando el AV9304.', at: '2026-11-17T23:02:00Z', read: [MIGUEL, JEFE] },
      { id: 'm2', s: JEFE, r: 'admin', body: 'Miguel, ese vuelo viene 30 min tarde. Espera ahí.', at: '2026-11-17T23:03:00Z', read: [JEFE, MIGUEL] },
      { id: 'm3', s: JEFE, r: 'admin', body: '<img src=x onerror="window.__xss=1">Ojo con el trancón', at: '2026-11-17T23:04:00Z', read: [JEFE] },
    ],
    viejos: { '2026-11-16|pm': [{ id: 'v1', s: JEFE, r: 'admin', body: 'Mensaje de ayer', at: '2026-11-16T23:00:00Z', read: [JEFE, JUAN] }] },
  };
  const fila = (m, drv) => ({ id: m.id, body: m.body, at: m.at, sender_id: m.s, role: m.r, sender: NOMBRE[m.s], mine: m.s === DB.yo,
    read_any: m.read.some((u) => u !== m.s), read_drivers: m.read.filter((u) => u !== m.s && drv.includes(u)).length,
    read_ids: m.read.filter((u) => u !== m.s), read_names: m.read.filter((u) => u !== m.s).map((u) => NOMBRE[u]) });
  const noHay = { code: 'PGRST202', message: 'Could not find the function public.shift_chat' };
  const sb = {
    auth: { getSession: async () => ({ data: { session: { user: { id: DB.yo } } } }) },
    rpc: async (fn, args) => {
      DB.llamadas.push(fn);
      if (DB.falta) return { data: null, error: noHay };
      if (fn === 'shift_chat_unread') {
        if (!DB.miembro) return { data: { member: false, n: 0, last: null }, error: null };
        const u = DB.msgs[DB.msgs.length - 1];
        return { data: { member: true, day: DB.turno.day, band: DB.turno.band, n: DB.msgs.filter((m) => m.s !== DB.yo && !m.read.includes(DB.yo)).length,
          last: u ? { body: u.body, at: u.at, role: u.r, sender: NOMBRE[u.s], mine: u.s === DB.yo } : null }, error: null };
      }
      if (fn === 'shift_chat_list') {
        const pasado = args && args.p_day && !(args.p_day === DB.turno.day && args.p_band === DB.turno.band);
        if (pasado && DB.rol !== 'admin') return { data: { ok: false, reason: 'solo_jefes' }, error: null };
        if (!pasado && !DB.miembro) return { data: { ok: false, reason: 'fuera_de_turno', day: DB.turno.day, band: DB.turno.band }, error: null };
        const lista = pasado ? (DB.viejos[args.p_day + '|' + args.p_band] || []) : DB.msgs;
        return { data: { ok: true, day: pasado ? args.p_day : DB.turno.day, band: pasado ? args.p_band : DB.turno.band, current: !pasado, can_write: !pasado && DB.miembro,
          since: '2026-11-17T19:00:00Z', me: DB.yo, role: DB.rol,
          drivers: DB.drivers.map((id) => ({ id, name: NOMBRE[id] })), admins: DB.admins.map((id) => ({ id, name: NOMBRE[id] })),
          messages: lista.map((m) => fila(m, DB.drivers)) }, error: null };
      }
      if (fn === 'shift_chat_send') {
        if (DB.fallaEnvio) return { data: null, error: { code: '42501', message: DB.fallaEnvio } };
        const m = { id: 'n' + (DB.msgs.length + 1), s: DB.yo, r: DB.rol, body: String(args.p_body).trim(), at: new Date().toISOString(), read: [DB.yo] };
        DB.msgs.push(m);
        return { data: { id: m.id, at: m.at, day: DB.turno.day, band: DB.turno.band, sender: NOMBRE[DB.yo], role: DB.rol,
          to_admins: DB.admins.filter((x) => x !== DB.yo), to_drivers: DB.drivers.filter((x) => x !== DB.yo) }, error: null };
      }
      if (fn === 'shift_chat_mark_read') { let n = 0; DB.msgs.forEach((m) => { if (m.s !== DB.yo && !m.read.includes(DB.yo)) { m.read.push(DB.yo); n++; } }); return { data: n, error: null }; }
      if (fn === 'shift_chat_history') return { data: DB.rol === 'admin' ? [{ day: '2026-11-16', band: 'pm', n: 1, first_at: '2026-11-16T23:00:00Z', last_at: '2026-11-16T23:00:00Z' }] : [], error: null };
      return { data: null, error: { code: 'XX', message: 'función desconocida ' + fn } };
    },
  };
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div><div id="fila"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const pushes = [];
  w.sb = sb; w.Api = { sendPush: async (p) => { pushes.push(p); return { sent: p.profileIds.length }; } };
  w.eval(read('api-chat-turno.js')); w.eval(read('chat-turno.js'));
  const host = w.document.getElementById('host');
  const $ = (s) => host.querySelector(s), $$ = (s) => [...host.querySelectorAll(s)];
  const escribe = (txt) => { const i = $('[data-ct-in]'); i.value = txt; i.dispatchEvent(new w.Event('input', { bubbles: true })); return i; };
  return { DB, w, host, $, $$, pushes, escribe, C: w.ChatTurno };
}

console.log('\nA) Sin 0173 en la base');
{ const M = mundo(); M.DB.falta = true;
  const v = await M.C.refrescarResumen();
  t('resumen().falta = true: la pestaña no sale', v.falta === true && M.C.resumen().falta === true);
  M.C.montar(M.host, { rol: 'driver' }); await wait();
  t('y si alguien lo monta, dice que no está disponible (sin campo de escribir)', /todavía no está disponible/.test(tx(M.host)) && M.$('[data-ct-foot]').hidden === true, tx(M.host));
  M.C.desmontar(); }

console.log('\nB) Conductor en turno');
{ const M = mundo();
  const v0 = await M.C.refrescarResumen();
  t('antes de abrir: 1 sin leer y el último mensaje', v0.falta === false && v0.member === true && v0.n === 1 && /trancón/.test(v0.last.body), JSON.stringify(v0));
  M.C.montar(M.host, { rol: 'driver' }); await wait();
  t('dice quiénes están: los jefes, el compañero y «tú»', /En este chat: Julián y Camilo \(jefes\), Juan Andrés y tú/.test(tx(M.$('[data-ct-top]'))), tx(M.$('[data-ct-top]')));
  t('rótulo del turno: «Turno de la tarde · desde las 2:00 p. m.»', /Turno de la tarde · desde las 2:00 p\. m\./.test(tx(M.$('.ct-sep'))), tx(M.$('.ct-sep')));
  const bs = M.$$('.ct-b');
  t('tres burbujas: la mía a la derecha, las del jefe a la izquierda', bs.length === 3 && bs[0].classList.contains('out') && bs[1].classList.contains('in') && bs[2].classList.contains('in'));
  t('el mensaje del jefe lleva su nombre y la marca JEFE', /Julián\s*JEFE/.test(tx(bs[1].querySelector('.ct-by'))), tx(bs[1]));
  t('misma persona seguida: el nombre va una sola vez', !bs[2].querySelector('.ct-by'));
  t('mi mensaje ya leído lleva ✓✓ y la hora', !!bs[0].querySelector('.ct-ck.leido') && /6:02 p\. m\./.test(tx(bs[0].querySelector('small'))), tx(bs[0].querySelector('small')));
  t('G) el HTML de un mensaje sale como texto y no se ejecuta', !M.host.querySelector('img') && !M.w.__xss && /<img/.test(bs[2].querySelector('p').textContent));
  t('salen las respuestas de un toque y el campo de escribir', M.$('[data-ct-qr]').hidden === false && M.$$('[data-ct="rapida"]').length === 4 && M.$('[data-ct-foot]').hidden === false);
  t('el campo va a 16 px o más (zoom de iPhone): lo da el CSS', /\.ct-foot textarea\{[^}]*font-size:16px/.test(read('chat-turno.css')));
  await wait();
  t('lo que ve queda leído: se marcó UNA vez', M.DB.llamadas.filter((f) => f === 'shift_chat_mark_read').length === 1 && M.DB.msgs.every((m) => m.read.includes(MIGUEL)));
  t('y el globo de sin leer baja a 0', M.C.resumen().n === 0);
  // Escribir y que una lectura no lo borre.
  const campo = M.escribe('Voy saliendo de Rionegro');
  t('con texto, el botón de enviar se enciende', M.$('[data-ct="enviar"]').disabled === false);
  M.DB.msgs.push({ id: 'm4', s: JUAN, r: 'driver', body: 'Yo termino en 10 min', at: '2026-11-17T23:10:00Z', read: [JUAN] });
  await M.C._leer(true); await wait();
  t('llega un mensaje nuevo (lectura de fondo) y sale en el hilo', M.$$('.ct-b').length === 4 && /Juan Andrés/.test(tx(M.$$('.ct-b')[3])));
  t('el campo de escribir es EL MISMO y conserva lo escrito', M.$('[data-ct-in]') === campo && campo.value === 'Voy saliendo de Rionegro');
  // Enviar con Enter.
  campo.dispatchEvent(new M.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await wait(60);
  const ult = M.$$('.ct-b').pop();
  t('Enter envía: sale a la derecha, con ✓ (enviado, sin leer)', ult.classList.contains('out') && /Voy saliendo de Rionegro/.test(tx(ult)) && !!ult.querySelector('.ct-ck') && !ult.querySelector('.ct-ck.leido'), tx(ult));
  t('y el campo queda vacío', M.$('[data-ct-in]').value === '' && M.$('[data-ct="enviar"]').disabled === true);
  t('el aviso sale a los jefes (abre Operación) y al compañero (abre su chat), no a mí',
    M.pushes.length === 2 && M.pushes[0].url === '/#/operacion?chatturno=1' && M.pushes[0].profileIds.join() === [JEFE, JEFE2].join()
    && M.pushes[1].url === '/#/chat-turno' && M.pushes[1].profileIds.join() === JUAN && /^💬 Miguel Ángel$/.test(M.pushes[0].title) && M.pushes[0].body === 'Voy saliendo de Rionegro', JSON.stringify(M.pushes));
  // Respuesta de un toque.
  M.$$('[data-ct="rapida"]')[0].click(); await wait(60);
  t('«Recibido» de un toque se envía tal cual', /Recibido/.test(tx(M.$$('.ct-b').pop())) && M.DB.msgs[M.DB.msgs.length - 1].body === 'Recibido');
  t('el conductor NO ve «Turnos anteriores»', !M.host.querySelector('[data-ct="hist"]'));
  M.C.desmontar(); }

console.log('\nC) Conductor fuera de turno');
{ const M = mundo(); M.DB.miembro = false;
  const v = await M.C.refrescarResumen();
  t('el resumen dice que no entra (la fila del Inicio no sale)', v.falta === false && v.member === false && v.n === 0);
  M.C.montar(M.host, { rol: 'driver' }); await wait();
  t('la pantalla dice por qué y no deja escribir', /El chat es de quienes están en turno/.test(tx(M.host)) && M.$('[data-ct-foot]').hidden === true && M.$('[data-ct-qr]').hidden === true, tx(M.host));
  M.C.desmontar(); }

console.log('\nD) Jefe');
{ const M = mundo(); M.DB.yo = JEFE; M.DB.rol = 'admin';
  M.C.montar(M.host, { rol: 'admin' }); await wait();
  t('cajitas con los conductores del turno y «Turnos anteriores»', M.$$('.ct-chip').map(tx).join('|') === 'Miguel Ángel|Juan Andrés' && !!M.$('[data-ct="hist"]'), M.$$('.ct-chip').map(tx).join('|'));
  t('el jefe no tiene respuestas de un toque y sí campo de escribir', M.$('[data-ct-qr]').hidden === true && M.$('[data-ct-foot]').hidden === false);
  const mio = M.$$('.ct-b.out')[0];
  t('su mensaje dice «Leído por 1 de 2»', /Leído por 1 de 2/.test(tx(mio.querySelector('.ct-leido'))), tx(mio));
  mio.querySelector('.ct-leido').click(); await wait();
  t('al tocarlo dice quién lo leyó y quién falta', /Lo leyó Miguel Ángel\. Falta Juan Andrés\./.test(tx(M.$$('.ct-b.out')[0].querySelector('.ct-quien'))), tx(M.$$('.ct-b.out')[0]));
  t('el mensaje del conductor lleva su nombre, sin la marca JEFE', /^Miguel Ángel$/.test(tx(M.$$('.ct-b.in')[0].querySelector('.ct-by'))));
  M.escribe('Juan Andrés, toma la llegada de las 7:55'); M.$('[data-ct="enviar"]').click(); await wait(60);
  t('el jefe envía: el aviso dice «· jefe» y va al otro jefe y a los dos conductores', M.pushes.length === 2 && /^💬 Julián · jefe$/.test(M.pushes[0].title) && M.pushes[0].profileIds.join() === JEFE2 && M.pushes[1].profileIds.join() === [MIGUEL, JUAN].join(), JSON.stringify(M.pushes));
  M.$('[data-ct="hist"]').click(); await wait();
  t('«Turnos anteriores» lista el de ayer', /Lun 16 nov · tarde/i.test(tx(M.$('.ct-hrow'))) && /1 mensaje/.test(tx(M.$('.ct-hrow'))) && M.$('[data-ct-foot]').hidden === true, tx(M.host));
  M.$('.ct-hrow').click(); await wait();
  t('abre ese turno solo para leer', /Mensaje de ayer/.test(tx(M.host)) && M.$('[data-ct-foot]').hidden === true && /turno de la tarde/i.test(tx(M.$('.ct-sep'))), tx(M.host));
  M.$('[data-ct="volver"]').click(); await wait();
  t('«Turno de ahora» vuelve al chat y se puede escribir', M.$$('.ct-b').length >= 4 && M.$('[data-ct-foot]').hidden === false && !!M.$('[data-ct="hist"]'));
  M.C.desmontar(); }

console.log('\nE) Un envío que falla');
{ const M = mundo();
  M.C.montar(M.host, { rol: 'driver' }); await wait();
  M.DB.fallaEnvio = 'El chat es de quienes están en turno';
  M.escribe('¿Me copian?'); M.$('[data-ct="enviar"]').click(); await wait(60);
  const f = M.$('.ct-b.fallo');
  t('se dice que no se envió y por qué', !!f && /No se envió: El chat es de quienes están en turno/.test(tx(f)), tx(M.host));
  t('lo escrito vuelve al campo para reintentar', M.$('[data-ct-in]').value === '¿Me copian?');
  t('no salió ningún aviso', M.pushes.length === 0);
  M.C.desmontar(); }

console.log('\nF) La fila del Inicio del conductor');
{ const M = mundo();
  const box = M.w.document.getElementById('fila'); let abrio = 0;
  M.C.filaInicio(box, () => { abrio++; }); await wait();
  t('en turno: «Chat del turno», el último mensaje con su autor y 1 sin leer', /Chat del turno/.test(tx(box)) && /Julián: /.test(tx(box)) && tx(box.querySelector('.ct-n')) === '1', tx(box));
  t('el HTML del último mensaje tampoco se ejecuta', !box.querySelector('img'));
  box.querySelector('[data-chat-turno]').click();
  t('al tocarla abre el chat', abrio === 1);
  M.DB.miembro = false; await M.C.refrescarResumen(); await wait();
  t('fuera de turno la fila desaparece', box.innerHTML === ''); }

console.log(`\n${bad ? '✗' : '✓'} chat del turno: ${ok} bien, ${bad} mal`);
process.exit(bad ? 1 : 0);
