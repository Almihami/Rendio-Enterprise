// Verificación de 0124 (el carro de la vuelta sale del turno del conductor) contra
// la base LOCAL (127.0.0.1:54322).
//
//   cd rendio-backend/scripts && node _verify-0124.mjs
//
// Todo dentro de una transacción que se deshace: en la base local no queda ni 0124
// ni ningún dato. Nunca apunta a dev ni a producción (_local-fixtures se niega).
//
// Qué prueba:
//   1. Una vuelta publicada antes de 0124 con la placa vieja del tablero y cuyo
//      conductor YA tiene turno abierto en otro carro: al aplicar, queda en el carro
//      del turno (el «HYU376 · Juan» del 25-oct).
//   2. Publicar sin placa («Carro 1»): si el conductor no ha iniciado turno, queda
//      sin carro (NULL) y con su carro del plan.
//   3. El conductor elige carro (vehicle_selected) → todavía nada; inspecciona y el
//      turno queda 'active' → sus vueltas sin terminar de esa ventana pasan a ese
//      carro; una de mañana (fuera de la ventana), no.
//   4. Publicar con el turno abierto → la vuelta nace en ese carro (aunque venga
//      con otra placa).
//   5. Cambiar el conductor de una vuelta → toma el carro del turno del nuevo.
//   6. El conductor cierra y abre turno en otro carro → lo pendiente se muda; lo
//      terminado se queda en el carro con que se hizo.
//   7. Una vuelta sin conductor (borrador) no se toca. Permisos: lo nuevo es interno.
//
// NO cubre: la pantalla (_smoke-rutas-v2-dom), el flujo real de inicio de turno
// en el teléfono (aquí el estado del turno se cambia a mano) ni dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
const veh = async (ra) => (await one(`SELECT vehicle_id v, plan_car pc FROM public.route_assignments WHERE id = $1`, [ra]));

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  // Flota: tres carros reales. Conductores: Juan y Daniel (y uno sin turno).
  const car = async (code, plate) => (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, $2, $3) RETURNING id`, [fx.org, code, plate])).id;
  const HYU = await car('HYU376', 'HYU376'), PRW = await car('PRW443', 'PRW443'), ZZZ = await car('ZZZ999', 'ZZZ999');
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id; };
  const JUAN = await drv('Juan prueba 0124'), DANI = await drv('Daniel prueba 0124'), OTRO = await drv('Otro prueba 0124');
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const dia = (n) => new Date(Date.parse(hoy + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const at = (hhmm, n = 0) => `${dia(n)}T${hhmm}:00-05:00`;
  const ruta = async (o) => (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at${o.pc ? ', plan_car' : ''})
      VALUES ($1, $2, $3, $4, $5::timestamptz${o.pc ? ', $6' : ''}) RETURNING id`,
    [o.d || null, o.v || null, o.dir || 'airport_to_home', o.st || 'planned', o.t].concat(o.pc ? [o.pc] : []))).id;
  const turno = async (d, v, st, start) => (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id`,
    [fx.org, d, v, st, start])).id;

  // ── Antes de 0124 ─────────────────────────────────────────────────────────
  // Juan abrió turno en PRW443 a las 13:42; el tablero viejo le publicó la vuelta
  // de las 22:55 en el HYU376 (el primero de la flota). Daniel abrió en HYU376.
  const tJuan = await turno(JUAN, PRW, 'active', at('13:42'));
  await turno(DANI, HYU, 'active', at('15:37'));
  const vieja = await ruta({ d: JUAN, v: HYU, t: at('22:55') });
  const terminada = await ruta({ d: JUAN, v: ZZZ, t: at('14:30'), st: 'completed' });

  const sql = fs.readFileSync(new URL('../supabase/migrations/0124_carro_del_turno.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
  await c.query(sql);
  await c.query(sql);                                   // idempotente
  check('0124 se aplica (y se puede volver a correr)', true);

  console.log('\n1. Lo que ya estaba publicado');
  check('la vuelta de Juan (22:55) pasó del HYU376 al PRW443, el carro de su turno', (await veh(vieja)).v === PRW, await veh(vieja));
  check('una vuelta ya terminada no se toca', (await veh(terminada)).v === ZZZ);

  console.log('\n2. Publicar sin placa, conductor sin turno');
  const sinTurno = await ruta({ d: OTRO, t: at('20:00'), pc: 'Carro 2' });
  check('queda sin carro y con «Carro 2»', (await veh(sinTurno)).v === null && (await veh(sinTurno)).pc === 'Carro 2', await veh(sinTurno));

  console.log('\n3. El conductor inicia turno');
  const manana = await ruta({ d: OTRO, t: at('20:00', 1), pc: 'Carro 2' });
  const tOtro = await turno(OTRO, ZZZ, 'vehicle_selected', at('19:00'));
  check('eligió carro pero no ha inspeccionado: todavía sin carro', (await veh(sinTurno)).v === null);
  await q(`UPDATE public.shifts SET status = 'inspection_in_progress' WHERE id = $1`, [tOtro]);
  check('inspeccionando: todavía sin carro', (await veh(sinTurno)).v === null);
  await q(`UPDATE public.shifts SET status = 'active' WHERE id = $1`, [tOtro]);
  check('turno activo: su vuelta de hoy queda en ZZZ999', (await veh(sinTurno)).v === ZZZ, await veh(sinTurno));
  check('…y conserva su carro del plan («Carro 2»)', (await veh(sinTurno)).pc === 'Carro 2');
  check('la de mañana a la misma hora (fuera de la ventana del turno) no', (await veh(manana)).v === null, await veh(manana));

  console.log('\n4. Publicar con el turno abierto');
  const nueva = await ruta({ d: JUAN, v: HYU, t: at('23:30'), pc: 'Carro 1' });
  check('nace en el carro del turno de Juan (PRW443) aunque viniera con otra placa', (await veh(nueva)).v === PRW, await veh(nueva));
  const madrugada = await ruta({ d: JUAN, t: at('00:40', 1), pc: 'Carro 1' });
  check('la de la madrugada siguiente (00:40) también: es de su turno PM', (await veh(madrugada)).v === PRW, await veh(madrugada));

  console.log('\n5. Cambiar el conductor de una vuelta');
  await q(`UPDATE public.route_assignments SET driver_profile_id = $2 WHERE id = $1`, [nueva, DANI]);
  check('pasa a Daniel → toma el HYU376, el carro de su turno', (await veh(nueva)).v === HYU, await veh(nueva));

  console.log('\n6. Cambiar de carro a mitad del día');
  await q(`UPDATE public.route_assignments SET status = 'completed' WHERE id = $1`, [vieja]);
  await q(`UPDATE public.shifts SET status = 'closed', end_at = start_at + interval '2 hours' WHERE id = $1`, [tJuan]);
  const tJuan2 = await turno(JUAN, ZZZ, 'active', at('18:00'));
  check('la madrugada pendiente de Juan se muda al ZZZ999', (await veh(madrugada)).v === ZZZ, await veh(madrugada));
  check('la que ya terminó se queda en el PRW443 (con ese se hizo)', (await veh(vieja)).v === PRW, await veh(vieja));
  await q(`UPDATE public.shifts SET vehicle_id = $2 WHERE id = $1`, [tJuan2, PRW]);
  check('si corrige el carro del turno abierto, sus vueltas lo siguen', (await veh(madrugada)).v === PRW, await veh(madrugada));

  console.log('\n7. Borradores y permisos');
  const borrador = await ruta({ t: at('21:00'), st: 'draft', pc: 'Carro 3' });
  check('una vuelta sin conductor no se toca', (await veh(borrador)).v === null);
  await asUser(c, fx.drvUser, 'driver');
  const e1 = await debeFallar(`SELECT public.route_vehicle_from_shift($1, now())`, [JUAN]);
  check('route_vehicle_from_shift no se puede llamar desde la app', e1 && /permission|permiso/i.test(e1.message), e1 && e1.message);
  await c.query('RESET ROLE');
} catch (e) {
  fail++;
  console.error('  ✗ ERROR:', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien · ${fail} mal`);
console.log('NO cubre: la pantalla, el inicio de turno real en el teléfono ni las bases de dev/prod.');
process.exit(fail ? 1 : 0);
