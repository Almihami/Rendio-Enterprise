// 0112 · conjuntos desde la app, contra la base LOCAL (supabase start).
//
//   cd rendio-backend/scripts && node _verify-0112.mjs
//
// Todo dentro de una transacción que se deshace: aplica 0112, arma sus propias
// filas (_local-fixtures) y comprueba
//   · mover el pin pone al día SOLO las reservas futuras, no canceladas, que
//     heredaron el punto del conjunto (no las pasadas, ni las canceladas, ni las
//     de pin propio, ni las de otro conjunto);
//   · renombrar o cambiar la nota de acceso pone al día su dirección;
//   · un admin crea, edita y desactiva; un tripulante no puede (RLS);
//   · nombres repetidos (sin importar mayúsculas) y pines fuera de la caja de
//     0055 se rechazan;
//   · desactivar no rompe a quien ya vive ahí: su reserva nueva sigue llenando
//     el punto.
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
const SQL = readFileSync(new URL('../supabase/migrations/0112_conjuntos_desde_la_app.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

await c.query('BEGIN');
try {
  await c.query(SQL);
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa 0112');
  const OLIVAR = await one(`SELECT latitude, longitude, name FROM public.residences WHERE id = $1`, [fx.olivar]);

  // Las reservas: nacen como las crea la app (sin coordenadas: las llena el conjunto).
  const reserva = async (cuando, extra = {}) => (await one(`
    INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, residence_id,
      pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, cancelled_at)
    VALUES ($1, 'home_to_airport', 'requested', $2, $3, $4, $5, now() + $6::interval, $7)
    RETURNING id`, [fx.aux, extra.residence || fx.olivar, extra.address || null, extra.lat || null, extra.lng || null,
    cuando, extra.cancelada ? new Date().toISOString() : null])).id;
  const futura = await reserva('1 day');
  const pasada = await reserva('-1 day');
  const cancelada = await reserva('2 days', { cancelada: true });
  const pinPropio = await reserva('1 day', { lat: 6.1601, lng: -75.3702, address: 'Casa azul, reja verde' });
  const otra = await reserva('1 day', { residence: fx.llano });
  const punto = async (id) => one(`SELECT pickup_latitude lat, pickup_longitude lng, pickup_address a FROM public.reservations WHERE id = $1`, [id]);

  console.log('El punto se hereda al nacer (0055, sin cambios)');
  const f0 = await punto(futura);
  check('la reserva futura copió la coordenada y el nombre del conjunto', f0.lat === OLIVAR.latitude && f0.lng === OLIVAR.longitude && f0.a === OLIVAR.name, JSON.stringify(f0));

  console.log('Mover el pin (como admin)');
  await asUser(c, jefe, 'admin');
  const r1 = await c.query(`UPDATE public.residences SET latitude = 6.1531, longitude = -75.3790 WHERE id = $1`, [fx.olivar]);
  check('el admin puede mover el pin', r1.rowCount === 1);
  await asAdminDb(c);
  const f1 = await punto(futura);
  check('la reserva futura va al punto nuevo', f1.lat === 6.1531 && f1.lng === -75.379, JSON.stringify(f1));
  const p1 = await punto(pasada);
  check('la que ya pasó se queda con el punto viejo', p1.lat === OLIVAR.latitude && p1.lng === OLIVAR.longitude);
  const c1 = await punto(cancelada);
  check('la cancelada no se toca', c1.lat === OLIVAR.latitude && c1.lng === OLIVAR.longitude);
  const x1 = await punto(pinPropio);
  check('la de pin propio no se toca', x1.lat === 6.1601 && x1.lng === -75.3702 && x1.a === 'Casa azul, reja verde', JSON.stringify(x1));
  const o1 = await punto(otra);
  const LLANO = await one(`SELECT latitude, longitude FROM public.residences WHERE id = $1`, [fx.llano]);
  check('la de otro conjunto no se toca', o1.lat === LLANO.latitude && o1.lng === LLANO.longitude);

  console.log('Renombrar y nota de acceso');
  await asUser(c, jefe, 'admin');
  await c.query(`UPDATE public.residences SET name = 'Olivar Apartamentos', access_note = 'Portería 2' WHERE id = $1`, [fx.olivar]);
  await asAdminDb(c);
  check('la futura toma el nombre y la nota nuevos', (await punto(futura)).a === 'Olivar Apartamentos · Portería 2', (await punto(futura)).a);
  check('la pasada conserva su dirección', (await punto(pasada)).a === OLIVAR.name);
  check('la de pin propio conserva la suya', (await punto(pinPropio)).a === 'Casa azul, reja verde');
  const sinCambio = await c.query(`UPDATE public.residences SET is_active = is_active WHERE id = $1`, [fx.olivar]);
  check('un UPDATE que no cambia punto ni nombre no dispara nada (WHEN)', sinCambio.rowCount === 1);

  console.log('Crear');
  await asUser(c, jefe, 'admin');
  const nuevo = await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, access_note)
    VALUES ($1, 'Torres de Barro Blanco', 6.1512, -75.4041, 'Portería principal') RETURNING id, is_active, zona_jefe`, [fx.org]);
  check('el admin crea un conjunto (activo, zona «según el mapa»)', !!nuevo && nuevo.is_active === true && nuevo.zona_jefe === null);
  check('mismo nombre con otras mayúsculas/espacios: rechazado', await falla(
    `INSERT INTO public.residences (organization_id, name, latitude, longitude) VALUES ($1, ' torres de barro blanco ', 6.15, -75.40)`, [fx.org], /duplicate|23505/));
  // La caja de 0055 (lat 5,9–6,5 · lng −75,7 a −75,1) es amplia: Medellín cabe. Bogotá no.
  check('pin fuera de la caja de Antioquia (Bogotá): rechazado', await falla(
    `INSERT INTO public.residences (organization_id, name, latitude, longitude) VALUES ($1, 'En Bogotá', 4.7110, -74.0721)`, [fx.org], /residences_coords_oriente|23514/));
  check('nombre vacío: rechazado', await falla(
    `INSERT INTO public.residences (organization_id, name, latitude, longitude) VALUES ($1, '   ', 6.15, -75.40)`, [fx.org], /residences_name_len|23514/));
  await asAdminDb(c);

  console.log('Desactivar');
  await asUser(c, jefe, 'admin');
  await c.query(`UPDATE public.residences SET is_active = false WHERE id = $1`, [fx.olivar]);
  await asAdminDb(c);
  check('desactivar no toca las reservas', (await punto(futura)).lat === 6.1531);
  const despues = await reserva('3 days');
  const d1 = await punto(despues);
  check('quien vive en un conjunto desactivado sigue pidiendo: su reserva llena el punto', d1.lat === 6.1531 && d1.lng === -75.379, JSON.stringify(d1));

  console.log('Permisos');
  await asUser(c, fx.auxUser, 'auxiliar');
  const t1 = await c.query(`UPDATE public.residences SET latitude = 6.16 WHERE id = $1`, [fx.llano]);
  check('un tripulante no puede mover un pin (0 filas)', t1.rowCount === 0);
  check('un tripulante no puede crear conjuntos', await falla(
    `INSERT INTO public.residences (organization_id, name, latitude, longitude) VALUES ($1, 'Del tripulante', 6.15, -75.40)`, [fx.org], /row-level security|42501/));
  await asAdminDb(c);
} catch (e) {
  fail++; console.log('  ✗ FALLÓ: ' + e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien · ${fail} mal (todo se deshizo)`);
process.exit(fail ? 1 : 0);
