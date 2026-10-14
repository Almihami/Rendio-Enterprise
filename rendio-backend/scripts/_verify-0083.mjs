// Verificación de 0083: la dirección escrita a mano ya no hereda el conjunto.
//
// Base LOCAL, todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0083.mjs
import { localClient, fixtures } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det ? ' → ' + det : ''}`); } };

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const res = (extra = '', vals = []) => q(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, required_arrival_at ${extra ? ',' + extra.cols : ''})
    VALUES ($1, 'home_to_airport', 'requested', now() + interval '1 day' ${extra ? ',' + extra.vals : ''})
    RETURNING id, residence_id, pickup_latitude, pickup_longitude, pickup_address`, [fx.aux, ...vals]).then(r => r[0]);

  console.log('\n1. Sin punto propio: hereda el conjunto (como antes)');
  const a = await res();
  check('residence_id = el conjunto del perfil', a.residence_id === fx.olivar, a.residence_id);
  check('coordenadas = las del conjunto', Math.abs(a.pickup_latitude - 6.1523) < 1e-6 && Math.abs(a.pickup_longitude + 75.3781) < 1e-6, `${a.pickup_latitude},${a.pickup_longitude}`);
  check('dirección = nombre del conjunto', a.pickup_address === 'El Olivar', a.pickup_address);

  console.log('\n2. Con conjunto elegido explícitamente: se respeta');
  const b = await res({ cols: 'residence_id', vals: '$2' }, [fx.llano]);
  check('residence_id = el que eligió', b.residence_id === fx.llano, b.residence_id);

  console.log('\n3. Pin propio escrito a mano («Hoy salgo de otro lado»): NO hereda');
  const m = await res({ cols: 'pickup_address, pickup_latitude, pickup_longitude', vals: '$2, $3, $4' },
    ['Cra. 43A #1-50, Medellín', 6.2006, -75.5696]);
  check('residence_id queda NULL', m.residence_id === null, m.residence_id);
  check('conserva sus coordenadas', Math.abs(m.pickup_latitude - 6.2006) < 1e-6, `${m.pickup_latitude}`);
  check('conserva su dirección', m.pickup_address === 'Cra. 43A #1-50, Medellín', m.pickup_address);

  console.log('\n4. El tablero ya no la junta con la vecina');
  // rtStopKey: con residencia → 'r:'+id ; sin ella → coordenada. La vecina pide desde el conjunto.
  const v = (await q(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at)
    VALUES ($1, 'home_to_airport', 'requested', now() + interval '1 day') RETURNING residence_id`, [fx.vecino]))[0];
  const key = r => r.residence_id ? 'r:' + r.residence_id : 'c:' + Number(r.pickup_latitude).toFixed(5) + ',' + Number(r.pickup_longitude).toFixed(5);
  check('la vecina queda en la parada del conjunto', key(v) === 'r:' + fx.olivar);
  check('la del pin propio queda en OTRA parada', key(m) !== key(v), `${key(m)} vs ${key(v)}`);

  console.log('\n5. Mover el pin de una reserva del conjunto no le quita el conjunto');
  const moved = (await q(`UPDATE public.reservations SET pickup_latitude = 6.1524 WHERE id = $1 RETURNING residence_id`, [a.id]))[0];
  check('sigue en El Olivar', moved.residence_id === fx.olivar, moved.residence_id);

  console.log('\n6. Corrección de las reservas futuras que ya quedaron mal');
  // Simula una reserva hecha ANTES de 0083: pin lejano pero pegada al conjunto.
  const bad = (await q(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at,
      residence_id, pickup_address, pickup_latitude, pickup_longitude)
    VALUES ($1, 'home_to_airport', 'requested', now() + interval '2 days', $2, 'Otra casa', 6.2006, -75.5696) RETURNING id`, [fx.aux, fx.olivar]))[0];
  const near = (await q(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at,
      residence_id, pickup_address, pickup_latitude, pickup_longitude)
    VALUES ($1, 'home_to_airport', 'requested', now() + interval '2 days', $2, 'Portería', 6.1530, -75.3785) RETURNING id`, [fx.aux, fx.olivar]))[0];
  const past = (await q(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at,
      residence_id, pickup_address, pickup_latitude, pickup_longitude)
    VALUES ($1, 'home_to_airport', 'requested', now() - interval '2 days', $2, 'Otra casa', 6.2006, -75.5696) RETURNING id`, [fx.aux, fx.olivar]))[0];
  // Re-ejecuta el bloque de datos de la migración (idéntico al del archivo).
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../supabase/migrations/0083_pin_manual_sin_conjunto.sql', import.meta.url), 'utf8');
  const doBlock = sql.slice(sql.indexOf('DO $$'), sql.lastIndexOf('END $$;') + 'END $$;'.length);
  await c.query(doBlock);
  const after = Object.fromEntries((await q(`SELECT id, residence_id FROM public.reservations WHERE id = ANY($1)`, [[bad.id, near.id, past.id]])).map(r => [r.id, r.residence_id]));
  check('futura con pin a 7 km: se le quita el conjunto', after[bad.id] === null, after[bad.id]);
  check('futura con pin a 80 m (la portería): se queda', after[near.id] === fx.olivar, after[near.id]);
  check('pasada: no se toca', after[past.id] === fx.olivar, after[past.id]);
} catch (e) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
