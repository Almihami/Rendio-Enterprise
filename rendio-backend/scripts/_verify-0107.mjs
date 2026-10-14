// Verificación de 0107: corte de la madrugada + «JMC» en los avisos del servidor.
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0107.mjs
import { localClient } from './_local-fixtures.mjs';
const c = await localClient();
const one = async (s, p) => (await c.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
await c.query('BEGIN');
try {
  const col = await one(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='app_settings' AND column_name='route_night_cutoff_min'`);
  check('app_settings.route_night_cutoff_min int NOT NULL DEFAULT 120 (02:00)', col && col.data_type === 'integer' && col.is_nullable === 'NO' && col.column_default === '120', JSON.stringify(col));
  check('la fila de ajustes trae 120', (await one(`SELECT route_night_cutoff_min v FROM public.app_settings WHERE id='singleton'`)).v === 120);
  await c.query('SAVEPOINT s');
  let rechaza = false; try { await c.query(`UPDATE public.app_settings SET route_night_cutoff_min = 300 WHERE id='singleton'`); } catch (e) { rechaza = /route_night_cutoff_range/.test(e.message); }
  await c.query('ROLLBACK TO SAVEPOINT s');
  check('fuera de rango (5:00 a. m.) lo rechaza la base', rechaza);
  await c.query(`UPDATE public.app_settings SET route_night_cutoff_min = 90 WHERE id='singleton'`);
  check('se puede mover a la 01:30', (await one(`SELECT route_night_cutoff_min v FROM public.app_settings WHERE id='singleton'`)).v === 90);
  const fn = async (n) => (await one(`SELECT prosrc FROM pg_proc WHERE proname = $1`, [n])).prosrc;
  const a = await fn('detect_trip_reminders'), b = await fn('flight_delay_alerts');
  check('aviso al tripulante: «Tu conductor sale de JMC a las …»', /Tu conductor sale de JMC a las/.test(a) && !/MDE/.test(a));
  check('aviso de vuelo desviado: «… no va a aterrizar en JMC …»', /no va a aterrizar en JMC/.test(b) && !/MDE/.test(b));
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
