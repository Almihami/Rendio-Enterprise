// Verificación de 0100: recordatorio de los libres (mié/jue/vie 9 a. m. + sáb 12 m.).
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0100.mjs
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  // Miércoles 14-oct-2026 9:00 a. m. Bogotá → la semana que cierra es la del lunes 19-oct.
  const mie = '2026-10-14 09:00:00-05', jue = '2026-10-15 09:00:00-05', vie = '2026-10-16 09:00:00-05';
  const sab = '2026-10-17 12:00:00-05', sabTarde = '2026-10-17 16:30:00-05', lun = '2026-10-12 09:00:00-05';
  const semana = '2026-10-19';
  const completo = await user(c, fx.org, 'driver', 'Confirmó Todo');
  const medio = await user(c, fx.org, 'driver', 'Le Falta Uno');
  const susp = await user(c, fx.org, 'driver', 'Suspendido');
  const inact = await user(c, fx.org, 'driver', 'Inactivo');
  await q(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [inact]);
  for (let d = 0; d < 7; d++) {
    await q(`INSERT INTO public.driver_availability (profile_id, week_start_date, day_of_week, am_state, pm_state) VALUES ($1, $2, $3, 'available', 'available')`, [completo, semana, d]);
    await q(`INSERT INTO public.driver_availability (profile_id, week_start_date, day_of_week, am_state, pm_state) VALUES ($1, $2, $3, 'available', $4)`, [medio, semana, d, d === 6 ? 'unset' : 'available']);
  }
  await q(`INSERT INTO public.driver_suspensions (profile_id, week_start_date, reason) VALUES ($1, $2, 'strikes')`, [susp, semana]);
  const avisos = async (p) => q(`SELECT title, body, dedupe_key FROM public.notification_outbox WHERE profile_id = $1 ORDER BY created_at`, [p]);

  const r1 = await one(`SELECT public.remind_weekly_availability($1::timestamptz) AS t`, [mie]);
  check('miércoles: corre para la semana del 19-oct', /semana 2026-10-19/.test(r1.t), r1.t);
  check('al que confirmó todo NO le llega', (await avisos(completo)).length === 0);
  const a = await avisos(medio);
  check('al que le falta una jornada SÍ («Faltan 3 días»)', a.length === 1 && a[0].title === 'Faltan 3 días para mandar tus libres', JSON.stringify(a));
  check('dice el rango y la hora del corte', a[0] && /19 oct al 25 oct/.test(a[0].body) && /4:00 p\. m\./.test(a[0].body), a[0] && a[0].body);
  check('el conductor de las fixtures (sin nada marcado) también', (await avisos(fx.drvUser)).length === 1);
  check('ni al suspendido ni al inactivo', (await avisos(susp)).length === 0 && (await avisos(inact)).length === 0);
  await one(`SELECT public.remind_weekly_availability($1::timestamptz)`, [mie]);
  check('el mismo día no se repite', (await avisos(medio)).length === 1);
  await one(`SELECT public.remind_weekly_availability($1::timestamptz)`, [jue]);
  await one(`SELECT public.remind_weekly_availability($1::timestamptz)`, [vie]);
  await one(`SELECT public.remind_weekly_availability($1::timestamptz)`, [sab]);
  const t = (await avisos(medio)).map(x => x.title);
  check('jueves, viernes y sábado (uno por día)', t.length === 4 && t[1] === 'Faltan 2 días para mandar tus libres' && t[2] === 'Mañana cierra tu semana' && t[3] === 'Hoy a las 4:00 p. m. cierra tu semana', JSON.stringify(t));
  const tarde = await one(`SELECT public.remind_weekly_availability($1::timestamptz) AS t`, [sabTarde]);
  check('el sábado después de las 4:00 p. m. ya no', tarde.t === 'el corte ya pasó', tarde.t);
  const lunes = await one(`SELECT public.remind_weekly_availability($1::timestamptz) AS t`, [lun]);
  check('un lunes no toca', /hoy no toca/.test(lunes.t), lunes.t);
  // Si confirma, el día siguiente ya no le llega.
  await q(`UPDATE public.driver_availability SET pm_state = 'available' WHERE profile_id = $1 AND day_of_week = 6`, [medio]);
  const otro = await user(c, fx.org, 'driver', 'Otro Más');
  await one(`SELECT public.remind_weekly_availability('2026-10-15 09:00:00-05'::timestamptz)`);
  check('confirmó → no recibe más (y el que no, sí)', (await avisos(medio)).length === 4 && (await avisos(otro)).length === 1);
  const jobs = await q(`SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'remind-availability-%' ORDER BY jobname`);
  check('crons: mié–vie 14:00 UTC y sáb 17:00 UTC', jobs.length === 2 && jobs[0].schedule === '0 17 * * 6' && jobs[1].schedule === '0 14 * * 3,4,5', JSON.stringify(jobs));
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
