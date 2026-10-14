// Verificación de 0109: sectores de cobro dibujados en el mapa.
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0109.mjs
// Junto con esta, correr _verify-0090, _verify-0094 y _verify-0103: 0109 reemplaza
// billing_rate_of, admin_billing_save_sector_rate y admin_billing_sector_rates.
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';
// La regla de la pantalla, tal cual (el mismo archivo que carga index.html).
const { zonaContienePunto } = new Function(
  `${readFileSync(new URL('../../rendio-turnos/zonas-dibujo.js', import.meta.url), 'utf8')}\nreturn { zonaContienePunto };`)();
const BARRO_BLANCO = [[6.152325, -75.396986], [6.150539, -75.397782], [6.149232, -75.399958], [6.148753, -75.402929], [6.149232, -75.405901], [6.150539, -75.408076], [6.152325, -75.408873], [6.154111, -75.408076], [6.155419, -75.405901], [6.155897, -75.402929], [6.155419, -75.399958], [6.154111, -75.397782]];
// Una figura cóncava (una «L»), donde un cálculo descuidado se equivoca.
const ELE = [[6.140, -75.400], [6.140, -75.380], [6.146, -75.380], [6.146, -75.394], [6.160, -75.394], [6.160, -75.400]];
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + JSON.stringify(det) : ''}`); } };
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
async function asDb() { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); }
const rate = async (aux) => { await asDb(); return one(`SELECT * FROM public.billing_rate_of($1)`, [aux]); };

// Un cuadro alrededor de El Olivar (6.1523, -75.3781), que es lo que arman las fixtures.
const CUADRO = JSON.stringify([[6.150, -75.380], [6.150, -75.376], [6.154, -75.376], [6.154, -75.380]]);

await c.query('BEGIN');
try {
  console.log('0. Sin dibujos nadie cambia de sector (la base sembrada)');
  const todos = await q(`
    SELECT ap.id, rt.sector_name s, coalesce(nullif(btrim(ab.sector), ''), nullif(btrim(r.sector), '')) antes
      FROM public.auxiliar_profiles ap
      LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
      LEFT JOIN public.residences r ON r.id = ap.residence_id
      LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
     WHERE NOT EXISTS (SELECT 1 FROM public.billing_sector_rates sr JOIN public.profiles pr ON pr.organization_id = sr.organization_id
                        WHERE pr.id = ap.profile_id AND sr.polygon IS NOT NULL)`);
  const distintos = todos.filter(x => (x.s || null) !== (x.antes || null));
  check(`los ${todos.length} tripulantes de organizaciones sin dibujos tienen el mismo sector que con 0094`, todos.length > 0 && distintos.length === 0, distintos.slice(0, 3));

  const fx = await fixtures(c);                 // fx.aux y fx.vecino viven en El Olivar (rótulo «Rionegro»)
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0109');
  const casaUser = await user(c, fx.org, 'auxiliar', 'Vive en casa 0109');
  const casa = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, home_address, home_latitude, home_longitude)
    VALUES ($1, 'Casa de prueba', 6.1515, -75.3770) RETURNING id`, [casaUser])).id;
  const lejosUser = await user(c, fx.org, 'auxiliar', 'Vive lejos 0109');
  const lejos = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, home_address, home_latitude, home_longitude)
    VALUES ($1, 'Casa lejos', 6.1000, -75.4500) RETURNING id`, [lejosUser])).id;

  check('antes de dibujar: El Olivar paga el rótulo de su conjunto (Rionegro)', (await rate(fx.aux)).sector_name === 'Rionegro');

  console.log('1. Dibujar un sector');
  await asUser(c, jefe, 'admin');
  const sh = (await one(`SELECT public.admin_billing_sector_shape('Centro', $1::jsonb) r`, [CUADRO])).r;
  check('dibujar crea el sector (sin valores todavía)', sh.sector === 'Centro' && Array.isArray(sh.polygon) && sh.polygon.length === 4, sh);
  let r = await rate(fx.aux);
  check('El Olivar cae en el dibujo → sector Centro («el de su residencia»)', r.sector_name === 'Centro' && r.sector_origin === 'residence' && r.res_sector === 'Centro', r);
  check('…sin tarifa cargada: sin mensualidad (nunca inventada)', r.monthly === null, r.monthly);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_sector_rate('centro', 480000, 25000)`);
  r = await rate(fx.aux);
  check('con la tarifa: mensualidad del sector $480.000 y viaje $25.000', r.monthly === 480000 && r.monthly_origin === 'sector' && r.sector_per_trip === 25000, r);
  check('Quintas de Llanogrande (fuera del dibujo) sigue con su rótulo', (await one(`SELECT rt.sector_name s FROM public.auxiliar_profiles ap JOIN LATERAL public.billing_rate_of(ap.id) rt ON true WHERE ap.residence_id = $1 LIMIT 1`, [fx.llano]))?.s !== 'Centro');
  check('una casa con pin dentro del dibujo paga Centro', (await rate(casa)).sector_name === 'Centro');
  check('una casa fuera de todo dibujo queda sin sector', (await rate(lejos)).sector_name === null);

  console.log('2. A mano gana, encimados no deciden');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, '2026-10-14'::date)`, [fx.aux]);
  const ss = (await one(`SELECT public.admin_billing_set_sector($1, 'Llanogrande') r`, [fx.aux])).r;
  check('sector a mano gana sobre el dibujo', ss.sector === 'Llanogrande' && ss.sectorSource === 'manual' && ss.residenceSector === 'Centro', ss);
  await q(`SELECT public.admin_billing_set_sector($1, NULL)`, [fx.aux]);
  await q(`SELECT public.admin_billing_sector_shape('Otro', $1::jsonb)`, [CUADRO]);
  check('dos dibujos encimados: no desempata, vuelve al rótulo (Rionegro)', (await rate(fx.aux)).sector_name === 'Rionegro');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_sector_shape('Otro', NULL)`);
  check('borrar el dibujo de un sector sin valores lo quita', (await one(`SELECT count(*)::int n FROM public.billing_sector_rates WHERE organization_id = $1 AND sector = 'Otro'`, [fx.org])).n === 0);
  check('…y El Olivar vuelve a Centro', (await rate(fx.aux)).sector_name === 'Centro');

  console.log('3. La pantalla «Tarifas por sector»');
  await asUser(c, jefe, 'admin');
  const tr = (await one(`SELECT public.admin_billing_sector_rates() r`)).r;
  const cen = tr.sectors.find(x => x.sector === 'Centro');
  check('Centro trae su dibujo, 1 conjunto y 3 tripulantes (2 del Olivar + la casa)', cen && Array.isArray(cen.polygon) && cen.residences === 1 && cen.crew === 3 && cen.monthlyCOP === 480000, cen);
  check('el rótulo viejo «Rionegro» ya no sale: su único conjunto quedó dentro de Centro', !tr.sectors.some(x => x.sector === 'Rionegro'), tr.sectors.map(x => x.sector));
  check('«Llanogrande» (sin dibujo) sigue saliendo de su conjunto', tr.sectors.some(x => x.sector === 'Llanogrande' && x.residences === 1));
  check('sin sector: solo la casa lejana', tr.crewWithoutSector === 1, tr.crewWithoutSector);
  const del = (await one(`SELECT public.admin_billing_save_sector_rate('Centro', NULL, NULL) r`)).r;
  check('vaciar la tarifa de un sector dibujado NO borra el sector ni el dibujo', del.deleted === false
    && (await one(`SELECT polygon IS NOT NULL d, monthly_cop m FROM public.billing_sector_rates WHERE organization_id = $1 AND sector = 'Centro'`, [fx.org])).d === true);
  await q(`SELECT public.admin_billing_save_sector_rate('Centro', 480000, 25000)`);

  console.log('4. Renombrar y quitar');
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, '2026-10-14'::date)`, [fx.vecino]);
  await q(`SELECT public.admin_billing_set_sector($1, 'Centro')`, [fx.vecino]);
  await q(`SELECT public.admin_billing_save_sector_rate('Llanogrande', 550000, NULL)`);
  let e = await debeFallar(`SELECT public.admin_billing_sector_rename('Centro', 'llanogrande')`);
  check('renombrar a un nombre que ya existe: error claro', e && /Ya hay un sector con ese nombre/.test(e.message), e && e.message);
  const rn = (await one(`SELECT public.admin_billing_sector_rename('Centro', 'Centro histórico') r`)).r;
  check('renombrar se lleva al que lo tenía a mano', rn.manualMoved === 1 && (await one(`SELECT sector FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.vecino])).sector === 'Centro histórico', rn);
  check('…y la tarifa y el dibujo', (await rate(fx.aux)).sector_name === 'Centro histórico' && (await rate(fx.aux)).monthly === 480000);
  await asUser(c, jefe, 'admin');
  const dl = (await one(`SELECT public.admin_billing_sector_delete('Centro histórico') r`)).r;
  check('quitar: el que lo tenía a mano queda sin sector a mano', dl.manualCleared === 1 && (await one(`SELECT sector FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.vecino])).sector === null, dl);
  check('…y El Olivar vuelve al rótulo de su conjunto', (await rate(fx.aux)).sector_name === 'Rionegro');

  console.log('5. La base y la pantalla dicen lo mismo');
  await asDb();
  // 2.000 puntos al azar alrededor de Rionegro (semilla fija) + todos los conjuntos.
  let semilla = 7; const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  const pts = Array.from({ length: 2000 }, () => [6.135 + azar() * 0.03, -75.415 + azar() * 0.04]);
  (await q(`SELECT latitude, longitude FROM public.residences`)).forEach(r => pts.push([r.latitude, r.longitude]));
  for (const [nombre, fig] of [['Barro Blanco', BARRO_BLANCO], ['la L', ELE]]) {
    const sql = (await q(`SELECT public.zona_contiene($1::jsonb, (x->>0)::float8, (x->>1)::float8) d FROM jsonb_array_elements($2::jsonb) x`,
      [JSON.stringify(fig), JSON.stringify(pts)])).map(r => r.d);
    const js = pts.map(p => zonaContienePunto(fig, p[0], p[1]));
    const distintos = pts.filter((_, i) => sql[i] !== js[i]);
    check(`${nombre}: ${pts.length} puntos, la base y zonas-dibujo.js coinciden en todos (${js.filter(Boolean).length} adentro)`, distintos.length === 0, distintos.slice(0, 3));
  }
  check('Guayacán (13 m afuera del borde de Barro Blanco) queda afuera en la base', (await one(`SELECT public.zona_contiene($1::jsonb, 6.153389, -75.397333) d`, [JSON.stringify(BARRO_BLANCO)])).d === false);

  console.log('6. Permisos');
  await asUser(c, fx.auxUser, 'auxiliar');
  e = await debeFallar(`SELECT public.admin_billing_sector_shape('Mío', $1::jsonb)`, [CUADRO]);
  check('un tripulante no puede dibujar sectores', !!e, e && e.message);
  e = await debeFallar(`SELECT public.admin_billing_sector_delete('Llanogrande')`);
  check('ni quitarlos', !!e, e && e.message);
  await asDb();
  const priv = await one(`SELECT has_function_privilege('authenticated', 'public.zona_contiene(jsonb,double precision,double precision)', 'EXECUTE') a,
    has_function_privilege('authenticated', 'public.billing_sector_at(uuid,double precision,double precision)', 'EXECUTE') b,
    has_function_privilege('anon', 'public.admin_billing_sector_shape(text,jsonb)', 'EXECUTE') c2,
    has_function_privilege('authenticated', 'public.admin_billing_sector_shape(text,jsonb)', 'EXECUTE') d`);
  check('las internas no se llaman desde la app; las del admin sí (y anon no)', !priv.a && !priv.b && !priv.c2 && priv.d, priv);
  e = await debeFallar(`SELECT public.admin_billing_sector_shape('X', '[[1,2],[3,4]]'::jsonb)`);
  check('un dibujo de menos de 3 puntos se rechaza', !!e);
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
