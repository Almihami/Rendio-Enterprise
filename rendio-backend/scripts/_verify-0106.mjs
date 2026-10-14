// Verificación de 0106: personal de tierra (auxiliar_profiles.ground_staff).
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0106.mjs
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
// Corre SQL como una persona dentro de un savepoint: si revienta, devuelve el error.
async function como(userId, role, sql, params) {
  await c.query('SAVEPOINT s');
  try { await asUser(c, userId, role); const r = await q(sql, params); await asAdminDb(c); await c.query('RELEASE SAVEPOINT s'); return { r }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); await asAdminDb(c); return { e }; }
}
await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const col = await one(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'auxiliar_profiles' AND column_name = 'ground_staff'`);
  check('existe ground_staff boolean NOT NULL DEFAULT false', col && col.data_type === 'boolean' && col.is_nullable === 'NO' && col.column_default === 'false', JSON.stringify(col));
  check('los tripulantes que ya existían quedan en false', (await one(`SELECT count(*)::int n FROM public.auxiliar_profiles WHERE ground_staff`)).n === 0);

  const air = (await one(`INSERT INTO public.airlines (organization_id, name, iata_code, is_active) VALUES ($1, 'Prueba Air', 'PZ', true) RETURNING id`, [fx.org])).id;
  await q(`UPDATE public.auxiliar_profiles SET airline_id = $1 WHERE id = $2`, [air, fx.aux]);
  const est = async () => one(`SELECT ground_staff, airline_id FROM public.auxiliar_profiles WHERE id = $1`, [fx.aux]);

  // Lo que manda la app (ApiAux.saveMyPrefs): las dos cosas juntas.
  const a = await como(fx.auxUser, 'auxiliar', `UPDATE public.auxiliar_profiles SET ground_staff = true, airline_id = NULL WHERE profile_id = auth.uid() RETURNING id`);
  const e1 = await est();
  check('el tripulante se marca personal de tierra en su propia fila (y queda sin aerolínea)', !a.e && a.r.length === 1 && e1.ground_staff === true && e1.airline_id === null, a.e ? a.e.message : JSON.stringify(e1));

  const b = await como(fx.auxUser, 'auxiliar', `UPDATE public.auxiliar_profiles SET airline_id = $1 WHERE profile_id = auth.uid()`, [air]);
  check('tierra + aerolínea a la vez: la base lo rechaza (CHECK)', b.e && /auxiliar_profiles_ground_sin_aerolinea/.test(b.e.message), b.e ? b.e.message : 'pasó');

  const d = await como(fx.auxUser, 'auxiliar', `UPDATE public.auxiliar_profiles SET ground_staff = false, airline_id = $1 WHERE profile_id = auth.uid() RETURNING id`, [air]);
  const e2 = await est();
  check('volver a una aerolínea (ground_staff=false + airline_id) funciona', !d.e && e2.ground_staff === false && e2.airline_id === air, d.e ? d.e.message : JSON.stringify(e2));

  const v = await como(fx.auxUser, 'auxiliar', `UPDATE public.auxiliar_profiles SET ground_staff = true, airline_id = NULL WHERE id = $1 RETURNING id`, [fx.vecino]);
  const ev = await one(`SELECT ground_staff FROM public.auxiliar_profiles WHERE id = $1`, [fx.vecino]);
  check('no puede marcar a OTRO tripulante (RLS: 0 filas)', !v.e && v.r.length === 0 && ev.ground_staff === false, v.e ? v.e.message : JSON.stringify(v.r));

  const lee = await como(fx.auxUser, 'auxiliar', `SELECT ground_staff FROM public.auxiliar_profiles WHERE profile_id = auth.uid()`);
  check('el tripulante lee su propia marca', !lee.e && lee.r.length === 1 && lee.r[0].ground_staff === false, lee.e ? lee.e.message : JSON.stringify(lee.r));

  const adm = await user(c, fx.org, 'admin', 'Jefe Prueba');
  const j = await como(adm, 'admin', `UPDATE public.auxiliar_profiles SET ground_staff = true, airline_id = NULL WHERE id = $1 RETURNING id`, [fx.vecino]);
  check('el jefe sí puede marcar a un tripulante', !j.e && j.r.length === 1, j.e ? j.e.message : JSON.stringify(j.r));
  const jl = await como(adm, 'admin', `SELECT count(*)::int n FROM public.auxiliar_profiles WHERE ground_staff`);
  check('…y lo ve en el padrón', !jl.e && jl.r[0].n === 1, jl.e ? jl.e.message : JSON.stringify(jl.r));

  const drv = await como(fx.drvUser, 'driver', `UPDATE public.auxiliar_profiles SET ground_staff = true, airline_id = NULL WHERE id = $1 RETURNING id`, [fx.aux]);
  check('un conductor no puede cambiarlo', drv.e || drv.r.length === 0, drv.e ? drv.e.message : JSON.stringify(drv.r));
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
