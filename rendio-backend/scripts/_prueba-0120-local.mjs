#!/usr/bin/env node
// _prueba-0120-local.mjs — Ajuste manual de horas (0120, 25-oct-2026) contra la
// base LOCAL. Aplica 0120 (idempotente) y prueba las dos funciones y la RLS con
// datos inventados DENTRO de una transacción que se deshace: no queda nada.
//
//   (con supabase start)  cd rendio-backend/scripts && node _prueba-0120-local.mjs
//
// NUNCA toca dev ni producción (_local-fixtures.mjs solo conecta a 127.0.0.1:54322).
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

const c = await localClient();
const one = async (s, p) => (await c.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, cond, d) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d != null ? ' → ' + d : ''}`); } };

// Corre `fn` en un SAVEPOINT y devuelve el mensaje de error (o null si no falló).
async function falla(fn) {
  await c.query('SAVEPOINT sp');
  try { await fn(); await c.query('RELEASE SAVEPOINT sp'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return e.message; }
}

await c.query(readFileSync(new URL('../supabase/migrations/0120_ajuste_manual_de_horas.sql', import.meta.url), 'utf8'));
console.log('0120 aplicada en la base local.');

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo Jefe');
  const otroUser = await user(c, fx.org, 'driver', 'Diana Ríos');
  const otro = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [otroUser])).id;
  const org2 = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra', 'otra-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefe2 = await user(c, org2, 'admin', 'Jefe de otra empresa');

  const turno = async (driver, desde, hasta, abre, cierra) => (await one(
    `INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, end_at, opening_km, closing_km)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [fx.org, driver, fx.vehicle, hasta ? 'closed' : 'active', desde, hasta, abre, cierra])).id;
  const S_ok    = await turno(fx.driver, '2026-10-14T05:00:00-05:00', '2026-10-14T17:00:00-05:00', 1000, 1100);
  const S_auto  = await turno(fx.driver, '2026-10-15T14:00:00-05:00', '2026-10-16T13:00:00-05:00', 1100, null);
  const S_falso = await turno(fx.driver, '2026-10-16T04:30:00-05:00', '2026-10-16T04:40:00-05:00', null, null);
  const S_otro  = await turno(otro,      '2026-10-14T05:00:00-05:00', '2026-10-14T17:00:00-05:00', 2000, 2100);
  const S_curso = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, opening_km)
     VALUES ($1, $2, $3, 'active', now() - interval '2 hours', 1200) RETURNING id`, [fx.org, fx.driver, fx.vehicle])).id;

  const ajustar = (quien, rol, args) => falla(async () => {
    await asUser(c, quien, rol);
    const r = await one(`SELECT public.adjust_shift_hours($1, $2, $3, $4, $5, $6) AS r`, args);
    await asAdminDb(c);
    ajustar.ultimo = r.r;
  });
  const NOTA = 'Se le apagó el celular y el sistema cerró el turno; el jefe de turno confirma la hora.';

  console.log('\n1) Quién puede');
  check('un conductor NO puede ajustar', /NOT_ADMIN/.test(await ajustar(fx.drvUser, 'driver',
    [fx.drvUser, S_auto, '2026-10-15', '2026-10-15T14:00:00-05:00', '2026-10-16T01:30:00-05:00', NOTA]) || ''));
  await asAdminDb(c);
  check('un jefe de OTRA organización no encuentra a la persona', /NO_DRIVER/.test(await ajustar(jefe2, 'admin',
    [fx.drvUser, S_auto, '2026-10-15', '2026-10-15T14:00:00-05:00', '2026-10-16T01:30:00-05:00', NOTA]) || ''));
  await asAdminDb(c);
  check('una persona sin ficha de conductor → NO_DRIVER', /NO_DRIVER/.test(await ajustar(jefe, 'admin',
    [fx.auxUser, null, '2026-10-17', '2026-10-17T05:00:00-05:00', '2026-10-17T07:00:00-05:00', NOTA]) || ''));
  await asAdminDb(c);

  console.log('\n2) Corregir un turno auto-cerrado');
  let e = await ajustar(jefe, 'admin', [fx.drvUser, S_auto, '2026-10-15', '2026-10-15T14:00:00-05:00', '2026-10-16T01:30:00-05:00', NOTA]);
  await asAdminDb(c);
  check('el jefe ajusta el auto-cerrado', e === null, e);
  const a1 = ajustar.ultimo && ajustar.ultimo.id;
  let fila = await one(`SELECT * FROM public.shift_hour_adjustments WHERE id = $1`, [a1]);
  check('guarda la foto del turno original (auto, cierre 13:00)', fila && fila.orig_kind === 'auto'
    && new Date(fila.orig_end_at).toISOString() === new Date('2026-10-16T13:00:00-05:00').toISOString(), fila && fila.orig_kind);
  check('guarda quién lo hizo', fila && fila.created_by === jefe);
  const turnoDespues = await one(`SELECT end_at, closing_km FROM public.shifts WHERE id = $1`, [S_auto]);
  check('el turno original NO se toca', new Date(turnoDespues.end_at).toISOString() === new Date('2026-10-16T13:00:00-05:00').toISOString() && turnoDespues.closing_km == null);

  e = await ajustar(jefe, 'admin', [fx.drvUser, S_auto, '2026-10-15', '2026-10-15T14:00:00-05:00', '2026-10-16T01:00:00-05:00', NOTA + ' (corrijo: 1:00)']);
  await asAdminDb(c);
  check('un segundo ajuste del mismo turno se guarda', e === null, e);
  check('…y dice que reemplazó al primero', ajustar.ultimo && ajustar.ultimo.replaced === a1, JSON.stringify(ajustar.ultimo));
  fila = await one(`SELECT voided_at, voided_by, void_note FROM public.shift_hour_adjustments WHERE id = $1`, [a1]);
  check('el primero queda ANULADO (no borrado) con motivo', fila && fila.voided_at && fila.voided_by === jefe && /Reemplazado/.test(fila.void_note || ''));
  const vigentes = await one(`SELECT count(*)::int n FROM public.shift_hour_adjustments WHERE shift_id = $1 AND voided_at IS NULL`, [S_auto]);
  check('queda UN solo ajuste vigente del turno', vigentes.n === 1, vigentes.n);

  console.log('\n3) Reglas');
  const r = async (args) => { const m = await ajustar(jefe, 'admin', args); await asAdminDb(c); return m || ''; };
  const cur = await one(`SELECT (start_at AT TIME ZONE 'America/Bogota')::date::text d, start_at s FROM public.shifts WHERE id = $1`, [S_curso]);
  check('turno abierto → ABIERTO', /ABIERTO/.test(await r([fx.drvUser, S_curso, cur.d, new Date(cur.s).toISOString(), new Date(new Date(cur.s).getTime() + 3600e3).toISOString(), NOTA])));
  check('día distinto al del turno → DIA', /DIA/.test(await r([fx.drvUser, S_ok, '2026-10-13', '2026-10-13T05:00:00-05:00', '2026-10-13T17:00:00-05:00', NOTA])));
  check('la hora inicial fuera del día elegido → DIA', /DIA/.test(await r([fx.drvUser, null, '2026-10-17', '2026-10-18T01:00:00-05:00', '2026-10-18T03:00:00-05:00', NOTA])));
  check('turno de otra persona → OTRA_PERSONA', /OTRA_PERSONA/.test(await r([fx.drvUser, S_otro, '2026-10-14', '2026-10-14T05:00:00-05:00', '2026-10-14T17:00:00-05:00', NOTA])));
  check('fin antes que inicio → RANGO', /RANGO/.test(await r([fx.drvUser, null, '2026-10-17', '2026-10-17T10:00:00-05:00', '2026-10-17T09:00:00-05:00', NOTA])));
  check('más de 24 h → RANGO', /RANGO/.test(await r([fx.drvUser, null, '2026-10-17', '2026-10-17T01:00:00-05:00', '2026-10-18T02:00:00-05:00', NOTA])));
  const manana = new Date(Date.now() + 86400e3);
  const dMan = new Date(manana.getTime() - 5 * 3600e3).toISOString().slice(0, 10);
  check('horas que no han pasado → FUTURO', /FUTURO/.test(await r([fx.drvUser, null, dMan, `${dMan}T05:00:00-05:00`, `${dMan}T07:00:00-05:00`, NOTA])));
  check('observación corta → NOTA', /NOTA/.test(await r([fx.drvUser, null, '2026-10-17', '2026-10-17T05:00:00-05:00', '2026-10-17T07:00:00-05:00', 'ok'])));

  console.log('\n4) Turno que no quedó en la app (sin turno)');
  check('se cruza con un turno completo → CRUCE', /CRUCE.*turno/.test(await r([fx.drvUser, null, '2026-10-14', '2026-10-14T06:00:00-05:00', '2026-10-14T10:00:00-05:00', NOTA])));
  e = await ajustar(jefe, 'admin', [fx.drvUser, null, '2026-10-17', '2026-10-17T05:00:00-05:00', '2026-10-17T17:00:00-05:00', NOTA]);
  await asAdminDb(c);
  check('uno suelto el 17 se guarda', e === null, e);
  const aSuelto = ajustar.ultimo && ajustar.ultimo.id;
  check('se cruza con otro ajuste → CRUCE', /CRUCE.*ajuste/.test(await r([fx.drvUser, null, '2026-10-17', '2026-10-17T16:00:00-05:00', '2026-10-17T18:00:00-05:00', NOTA])));
  e = await ajustar(jefe, 'admin', [fx.drvUser, null, '2026-10-16', '2026-10-16T05:00:00-05:00', '2026-10-16T07:00:00-05:00', NOTA]);
  await asAdminDb(c);
  check('NO choca con la hora vieja de un turno ya ajustado (13:00 → quedó 1:00)', e === null, e);
  e = await ajustar(jefe, 'admin', [fx.drvUser, S_falso, '2026-10-16', '2026-10-16T08:00:00-05:00', '2026-10-16T12:00:00-05:00', NOTA]);
  await asAdminDb(c);
  check('un arranque falso también se puede corregir', e === null, e);
  fila = await one(`SELECT orig_kind FROM public.shift_hour_adjustments WHERE shift_id = $1 AND voided_at IS NULL`, [S_falso]);
  check('…queda con orig_kind = falso', fila && fila.orig_kind === 'falso');

  console.log('\n5) Quién ve qué (RLS)');
  const cuenta = async (quien, rol) => { await asUser(c, quien, rol); const x = await one(`SELECT count(*)::int n FROM public.shift_hour_adjustments`); await asAdminDb(c); return x.n; };
  const total = (await one(`SELECT count(*)::int n FROM public.shift_hour_adjustments WHERE organization_id = $1`, [fx.org])).n;
  check(`el jefe ve los ${total} de su organización`, (await cuenta(jefe, 'admin')) === total);
  check('el conductor ve los suyos', (await cuenta(fx.drvUser, 'driver')) === total);
  check('otro conductor no ve ninguno', (await cuenta(otroUser, 'driver')) === 0);
  check('el jefe de otra organización no ve ninguno', (await cuenta(jefe2, 'admin')) === 0);
  check('el jefe NO puede escribir la tabla directo', /permission denied|row-level/.test(await falla(async () => {
    await asUser(c, jefe, 'admin');
    await c.query(`INSERT INTO public.shift_hour_adjustments (organization_id, driver_id, work_date, start_at, end_at, note, created_by)
      VALUES ($1, $2, '2026-10-18', '2026-10-18T05:00:00-05:00', '2026-10-18T06:00:00-05:00', 'directo sin función', $3)`, [fx.org, fx.driver, jefe]);
  }) || ''));
  await asAdminDb(c);
  check('ni borrarla', /permission denied|row-level/.test(await falla(async () => {
    await asUser(c, jefe, 'admin');
    await c.query(`DELETE FROM public.shift_hour_adjustments`);
  }) || ''));
  await asAdminDb(c);

  console.log('\n6) Anular');
  const anular = async (quien, rol, id, nota) => { const m = await falla(async () => { await asUser(c, quien, rol); ajustar.ultimo = (await one(`SELECT public.void_shift_hour_adjustment($1, $2) AS r`, [id, nota])).r; }); await asAdminDb(c); return m; };
  check('un conductor NO puede anular', /NOT_ADMIN/.test(await anular(fx.drvUser, 'driver', aSuelto, 'no me sirve') || ''));
  check('sin motivo no se anula', /NOTA/.test(await anular(jefe, 'admin', aSuelto, ' ') || ''));
  check('el jefe de otra organización no puede', /WRONG_ORG/.test(await anular(jefe2, 'admin', aSuelto, 'no es mío') || ''));
  e = await anular(jefe, 'admin', aSuelto, 'Me equivoqué de día');
  check('el jefe lo anula con motivo', e === null, e);
  fila = await one(`SELECT voided_at, voided_by, void_note FROM public.shift_hour_adjustments WHERE id = $1`, [aSuelto]);
  check('la fila sigue ahí, anulada, con quién y por qué', fila && fila.voided_at && fila.voided_by === jefe && fila.void_note === 'Me equivoqué de día');
  e = await anular(jefe, 'admin', aSuelto, 'otra vez');
  check('anularlo dos veces no hace nada', e === null && ajustar.ultimo && ajustar.ultimo.noop === true, e);
  e = await ajustar(jefe, 'admin', [fx.drvUser, null, '2026-10-17', '2026-10-17T16:00:00-05:00', '2026-10-17T18:00:00-05:00', NOTA]);
  await asAdminDb(c);
  check('anulado, ya no choca: se puede volver a cargar esas horas', e === null, e);

  console.log('\n7) Bitácora');
  const aud = await one(`SELECT count(*) FILTER (WHERE event_type = 'shift_hours_adjusted')::int a,
                                count(*) FILTER (WHERE event_type = 'shift_hours_adjustment_voided')::int v
                           FROM public.audit_events WHERE entity_type = 'shift_hour_adjustment'
                            AND entity_id IN (SELECT id FROM public.shift_hour_adjustments WHERE organization_id = $1)`, [fx.org]);
  check('cada ajuste y cada anulación quedan en audit_events', aud && aud.a >= 5 && aud.v >= 1, JSON.stringify(aud));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
