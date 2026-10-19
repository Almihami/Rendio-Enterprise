// 0113 · Coordinación por conversaciones, contra la base LOCAL (supabase start).
//
//   cd rendio-backend/scripts && node _verify-0113.mjs
//
// Todo dentro de una transacción que se deshace: arma sus propias filas
// (_local-fixtures), siembra mensajes «de antes» con la forma de 0088, aplica
// 0113 y comprueba
//   · lo que ya había se reparte en conversaciones por los huecos de 12 h;
//   · el tripulante que vuelve a escribir después de 12 h abre un chat NUEVO;
//   · el jefe cierra («Resuelta») y el siguiente mensaje abre otra;
//   · el tripulante ve el nombre del jefe (sender_name) y no su id;
//   · una respuesta sin leer en una conversación cerrada no se le pierde;
//   · el historial lista todas, con quién la cerró;
//   · solo un jefe de la misma organización puede cerrar;
//   · nunca hay dos abiertas a la vez.
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

const c = await localClient();
const one = async (s, p) => (await c.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const falla = async (sql, params, re) => {
  await c.query('SAVEPOINT s');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT s'); return false; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); return re ? re.test(e.message) || re.test(e.code || '') : true; }
};
const SQL = readFileSync(new URL('../supabase/migrations/0113_conversaciones_coordinacion.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const julian = await user(c, fx.org, 'admin', 'Julián Prueba Ríos');
  const daniela = await user(c, fx.org, 'admin', 'Daniela Prueba');
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra', 'otra-' || substr(md5(random()::text),1,6)) RETURNING id`)).id;
  const intruso = await user(c, otraOrg, 'admin', 'Jefe De Otra');

  // Mensajes «de antes» (forma de 0088, sin conversación): dos tandas separadas
  // por 20 h y una tercera hace 30 min.
  const viejo = async (quien, rol, cuerpo, hace) => c.query(`
    INSERT INTO public.crew_messages (organization_id, auxiliar_profile_id, sender_profile_id, sender_role, body, created_at, read_at, read_by)
    VALUES ($1, $2, $3, $4, $5, now() - $6::interval, now(), '{}')`, [fx.org, fx.aux, quien, rol, cuerpo, hace]);
  await viejo(fx.auxUser, 'auxiliar', 'Hola, mi vuelo cambió', '45 hours');
  await viejo(julian, 'admin', 'Listo, ya lo ajustamos', '44 hours 50 minutes');
  await viejo(fx.auxUser, 'auxiliar', '¿Puedo llevar mascota?', '24 hours');
  await viejo(daniela, 'admin', 'Sí, en guacal', '23 hours 55 minutes');
  await viejo(fx.auxUser, 'auxiliar', 'Ya estoy en la portería', '30 minutes');

  console.log('Aplicar 0113 (con lo que ya había)');
  await c.query(SQL);
  const convs0 = (await c.query(`SELECT id, closed_at, close_reason, opened_at, last_message_at FROM public.crew_conversations
                                  WHERE auxiliar_profile_id = $1 ORDER BY opened_at`, [fx.aux])).rows;
  check('lo de antes queda en 3 conversaciones (huecos de más de 12 h)', convs0.length === 3, convs0.length);
  check('las dos viejas quedan cerradas solas («auto») y la de hace 30 min sigue abierta',
    convs0[0].close_reason === 'auto' && convs0[1].close_reason === 'auto' && convs0[2].closed_at === null, JSON.stringify(convs0.map(x => x.close_reason)));
  const sinConv = (await one(`SELECT count(*)::int n FROM public.crew_messages WHERE auxiliar_profile_id = $1 AND conversation_id IS NULL`, [fx.aux])).n;
  check('ningún mensaje quedó sin conversación', sinConv === 0, sinConv);
  await c.query(SQL);
  const convs0b = (await one(`SELECT count(*)::int n FROM public.crew_conversations WHERE auxiliar_profile_id = $1`, [fx.aux])).n;
  check('volver a correr 0113 no duplica nada', convs0b === 3, convs0b);

  console.log('El tripulante escribe');
  await asUser(c, fx.auxUser, 'auxiliar');
  let r = (await one(`SELECT public.crew_send_message('Ya bajo') AS r`)).r;
  check('sigue en la conversación abierta (no abre otra)', r.new_conversation === false && r.conversation_id === convs0[2].id, JSON.stringify(r));
  let hilo = (await one(`SELECT public.crew_list_messages() AS r`)).r;
  check('el tripulante ve SOLO la conversación de hoy (2 mensajes)', hilo.length === 2 && hilo.every(m => m.conversation_id === convs0[2].id), hilo.length);
  check('…marcada como abierta', hilo.every(m => m.conversation_open === true));
  check('…y en lo suyo no viaja ningún id de remitente', hilo.every(m => !('sender_profile_id' in m)));

  console.log('Responde Julián (el tripulante ve su nombre)');
  await asAdminDb(c); await asUser(c, julian, 'admin');
  r = (await one(`SELECT public.crew_send_message('Ya va el carro', $1) AS r`, [fx.aux])).r;
  check('el envío del jefe devuelve su primer nombre', r.sender_name === 'Julián', r.sender_name);
  await asAdminDb(c); await asUser(c, fx.auxUser, 'auxiliar');
  hilo = (await one(`SELECT public.crew_list_messages() AS r`)).r;
  const deJulian = hilo.find(m => m.sender_role === 'admin');
  check('el tripulante ve «Julián» en el mensaje del jefe', deJulian && deJulian.sender_name === 'Julián', JSON.stringify(deJulian));
  check('lo del tripulante no trae nombre', hilo.filter(m => m.sender_role === 'auxiliar').every(m => m.sender_name == null));

  console.log('Julián la marca «Resuelta»');
  await asAdminDb(c); await asUser(c, julian, 'admin');
  r = (await one(`SELECT public.crew_close_conversation($1) AS r`, [convs0[2].id])).r;
  check('queda cerrada, por Julián', r.closed === true && r.closed_by_name === 'Julián' && r.already_closed === false, JSON.stringify(r));
  r = (await one(`SELECT public.crew_close_conversation($1) AS r`, [convs0[2].id])).r;
  check('cerrarla otra vez no cambia nada (ya estaba)', r.already_closed === true);
  let jefeHilo = (await one(`SELECT public.crew_list_messages($1) AS r`, [fx.aux])).r;
  check('el jefe sigue viendo la última (cerrada) para tener el contexto', jefeHilo.length === 3 && jefeHilo.every(m => m.conversation_open === false), jefeHilo.length);
  let th = (await one(`SELECT public.crew_threads_admin() AS r`)).r.find(t => t.auxiliar_profile_id === fx.aux);
  check('la bandeja dice que no hay conversación abierta y cuántas lleva', th && th.open === false && Number(th.conversations) === 3, JSON.stringify(th && { open: th.open, n: th.conversations }));

  console.log('Lo que el tripulante no ha leído no se le pierde');
  await asAdminDb(c); await asUser(c, fx.auxUser, 'auxiliar');
  hilo = (await one(`SELECT public.crew_list_messages() AS r`)).r;
  check('con la respuesta de Julián sin leer, ve esa conversación (cerrada)', hilo.length === 3 && hilo[0].conversation_open === false, hilo.length);
  await c.query(`SELECT public.crew_mark_read()`);
  hilo = (await one(`SELECT public.crew_list_messages() AS r`)).r;
  check('ya leída: el chat queda vacío (uno NUEVO)', Array.isArray(hilo) && hilo.length === 0, JSON.stringify(hilo));
  r = (await one(`SELECT public.crew_send_message('Otra cosa: mañana viajo') AS r`)).r;
  check('su siguiente mensaje abre una conversación nueva', r.new_conversation === true && r.conversation_id !== convs0[2].id, JSON.stringify(r));
  const nueva = r.conversation_id;

  console.log('Historial');
  const hist = (await one(`SELECT public.crew_conversations_list() AS r`)).r;
  check('4 conversaciones, la más reciente primero y abierta', hist.length === 4 && hist[0].id === nueva && hist[0].open === true, hist.map(h => h.open).join(','));
  const resuelta = hist.find(h => h.id === convs0[2].id);
  check('la resuelta dice quién la cerró y cuántos mensajes tiene', resuelta && resuelta.close_reason === 'admin' && resuelta.closed_by_name === 'Julián' && Number(resuelta.messages) === 3, JSON.stringify(resuelta));
  check('las viejas dicen que se cerraron solas', hist.slice(2).every(h => h.close_reason === 'auto' && h.closed_at));
  hilo = (await one(`SELECT public.crew_list_messages(NULL, 100, $1) AS r`, [convs0[0].id])).r;
  check('se puede abrir una vieja: trae sus 2 mensajes', hilo.length === 2 && hilo[0].body === 'Hola, mi vuelo cambió', hilo.length);
  check('el tripulante NO puede cerrar', await falla(`SELECT public.crew_close_conversation($1)`, [nueva], /Solo un jefe/));

  console.log('Cierre solo, por tiempo (12 h sin mensajes)');
  await asAdminDb(c);
  await c.query(`UPDATE public.crew_conversations SET last_message_at = now() - interval '13 hours' WHERE id = $1`, [nueva]);
  await asUser(c, fx.auxUser, 'auxiliar');
  hilo = (await one(`SELECT public.crew_list_messages() AS r`)).r;
  check('quieta más de 12 h ya cuenta como cerrada (el chat sale nuevo)', hilo.length === 0, hilo.length);
  r = (await one(`SELECT public.crew_send_message('Hola de nuevo') AS r`)).r;
  const vieja = await one(`SELECT closed_at, close_reason, last_message_at FROM public.crew_conversations WHERE id = $1`, [nueva]);
  check('el siguiente mensaje la cierra de verdad («auto») y abre otra', r.new_conversation === true && vieja.close_reason === 'auto' && vieja.closed_at, JSON.stringify(vieja));

  console.log('Permisos');
  await asAdminDb(c); await asUser(c, intruso, 'admin');
  check('un jefe de otra organización no puede cerrar', await falla(`SELECT public.crew_close_conversation($1)`, [r.conversation_id], /no existe/));
  const ajeno = (await one(`SELECT public.crew_conversations_list($1) AS r`, [fx.aux])).r;
  check('ni ver el historial', ajeno === null, JSON.stringify(ajeno));
  await asAdminDb(c);
  const abiertas = (await one(`SELECT count(*)::int n FROM public.crew_conversations WHERE auxiliar_profile_id = $1 AND closed_at IS NULL`, [fx.aux])).n;
  check('nunca hay dos abiertas a la vez', abiertas === 1, abiertas);
  check('el índice único no deja abrir otra a mano', await falla(
    `INSERT INTO public.crew_conversations (organization_id, auxiliar_profile_id) VALUES ($1, $2)`, [fx.org, fx.aux], /uq_crew_conversations_open|duplicate/));
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗ (todo se deshizo: la base local quedó igual)`);
process.exit(fail ? 1 : 0);
