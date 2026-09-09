// BORRA LOS DOS TRIPULANTES DE PRUEBA DE PRODUCCIÓN (7-sep-2026).
//
// Se creó para poder volver a registrarse con harold.p2329@gmail.com y probar el
// flujo de alta desde cero: mientras el usuario exista en auth, ese correo está
// tomado y el registro no deja repetirlo.
//
// QUÉ BORRA, exactamente estos dos y nada más (van por id, no por nombre):
//   a45e167f… Harold Peña Lombana · harold.p2329@gmail.com  (+1 reserva de prueba)
//   adc78d07… Daniela Mejia Quintana · daniela@gmail.com
//
// ORDEN, que importa: primero la reserva. `reservations.auxiliar_profile_id`
// tiene ON DELETE RESTRICT (0003_operations.sql:59), así que bloquearía todo lo
// demás. Después el usuario de auth, y la cascada se lleva profiles →
// auxiliar_profiles → push_subscriptions.
//
// Comprobado antes de escribir esto: no hay `route_stops` colgando de esa
// reserva (el único otro RESTRICT), así que el borrado sale limpio.
//
// RESPALDO de todas las filas, por si acaso:
//   respaldo-produccion-2026-09-04/_borrados-usuarios-prueba-2026-09-07.json
//
// Uso:
//   cd rendio-backend/scripts && set -a; source ../.env.main; set +a; node _borrar-usuarios-prueba.mjs
//
import { createClient } from '@supabase/supabase-js';

const IDS = [
  'a45e167f-6a4c-457d-b94f-08744d28c6f8',   // Harold Peña Lombana
  'adc78d07-d795-4c30-98c7-a9a1430e5f86',   // Daniela Mejia Quintana
];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

// Aviso de a cuál base se está apuntando: este script borra, y equivocarse de
// ambiente aquí no tiene deshacer.
console.log('Base:', process.env.SUPABASE_URL);
if (!/wvuurnfdrrdondrbbkhd/.test(process.env.SUPABASE_URL || '')) {
  console.log('OJO: esto NO es producción. Si es lo que querías, quita este bloque.');
  process.exit(1);
}

// 1) La reserva primero (el RESTRICT).
const aux = await sb.from('auxiliar_profiles').select('id').in('profile_id', IDS);
const auxIds = (aux.data || []).map(a => a.id);
if (auxIds.length) {
  const del = await sb.from('reservations').delete().in('auxiliar_profile_id', auxIds).select('id');
  console.log('1) reservas borradas:', del.error ? 'ERR ' + del.error.message : del.data.length);
}

// 2) El usuario de auth; lo demás cae por cascada.
for (const id of IDS) {
  const { error } = await sb.auth.admin.deleteUser(id);
  console.log('2) auth', id.slice(0, 8), '→', error ? 'ERR ' + error.message : 'borrado');
}

// 3) Comprobar, no suponer.
const { data: users } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
const quedan = (users?.users || []).filter(u => /harold|daniela/i.test(u.email || ''));
const perf = await sb.from('profiles').select('id, full_name').in('id', IDS);
const auxq = await sb.from('auxiliar_profiles').select('id').in('profile_id', IDS);
const total = await sb.from('profiles').select('id', { head: true, count: 'exact' });
console.log('\nCOMPROBACIÓN');
console.log('  correos libres para volver a registrar:', quedan.length ? 'NO — ' + quedan.map(u => u.email).join(', ') : 'sí ✓');
console.log('  perfiles que quedan de esos dos       :', perf.data?.length === 0 ? 'ninguno ✓' : JSON.stringify(perf.data));
console.log('  perfiles de auxiliar que quedan       :', auxq.data?.length === 0 ? 'ninguno ✓' : auxq.data.length);
console.log('  perfiles totales en producción        :', total.count, '(eran 20)');
