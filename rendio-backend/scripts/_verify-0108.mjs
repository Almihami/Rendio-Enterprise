// Verificación de 0108: zonas dibujadas (route_zones) + la regla de zonas-dibujo.js.
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0108.mjs
import { readFileSync } from 'node:fs';
import { localClient, asUser, asAdminDb } from './_local-fixtures.mjs';
const c = await localClient();
const one = async (s, p) => (await c.query(s, p)).rows[0];
const all = async (s, p) => (await c.query(s, p)).rows;
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const falla = async (sql, params, re) => {
  await c.query('SAVEPOINT s');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT s'); return false; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); return re ? re.test(e.message) || re.test(e.code || '') : true; }
};

// La regla de la app, tal cual (el mismo archivo que carga index.html).
const { zonaEfectiva, zonaContienePunto } = new Function(
  `${readFileSync(new URL('../../rendio-turnos/zonas-dibujo.js', import.meta.url), 'utf8')}\nreturn { zonaEfectiva, zonaContienePunto };`)();
// La elipse con la que la profa marcó Barro Blanco (13-oct), pasada a lat/lng.
const BARRO_BLANCO = [[6.152325, -75.396986], [6.150539, -75.397782], [6.149232, -75.399958], [6.148753, -75.402929], [6.149232, -75.405901], [6.150539, -75.408076], [6.152325, -75.408873], [6.154111, -75.408076], [6.155419, -75.405901], [6.155897, -75.402929], [6.155419, -75.399958], [6.154111, -75.397782]];

await c.query('BEGIN');
try {
  console.log('Esquema');
  const zs = await all(`SELECT name, sort_order, polygon FROM public.route_zones ORDER BY sort_order, name`);
  check('las 4 zonas de Julián, en su orden', zs.slice(0, 4).map(z => z.name).join('|') === 'Fontibón|Porvenir|Sendai/San Antonio|Marinilla', JSON.stringify(zs.map(z => z.name)));
  check('menos de 3 puntos lo rechaza la base', await falla(`INSERT INTO public.route_zones (name, polygon) VALUES ('X', '[[6.1,-75.4],[6.2,-75.4]]')`, [], /check/i));
  check('nombre repetido lo rechaza la base (23505)', await falla(`INSERT INTO public.route_zones (name) VALUES ('Porvenir')`, [], /23505|duplicate/));
  check('nombre vacío lo rechaza la base', await falla(`INSERT INTO public.route_zones (name) VALUES ('  ')`, [], /check/i));
  check('un conjunto no puede apuntar a una zona que no existe', await falla(`UPDATE public.residences SET zona_jefe = 'No existe' WHERE id = (SELECT id FROM public.residences LIMIT 1)`, [], /foreign key|23503/));
  check('la tabla de tiempos tampoco', await falla(`INSERT INTO public.route_zone_times (zone, band_from, band_to, min_minutes, max_minutes) VALUES ('No existe', 2, 6, 10, 10)`, [], /foreign key|23503/));

  console.log('Renombrar y quitar');
  // Nombre propio de la prueba: la base local puede tener ya una «Barro Blanco» de verdad.
  await c.query(`INSERT INTO public.route_zones (name, polygon, sort_order) VALUES ('Prueba 0108', $1, 50)`, [JSON.stringify(BARRO_BLANCO)]);
  await c.query(`INSERT INTO public.route_zone_times (zone, band_from, band_to, min_minutes, max_minutes)
    SELECT 'Prueba 0108', band_from, band_to, 30, 40 FROM public.route_leg_times`);
  const vallejo = await one(`SELECT id FROM public.residences WHERE name = 'Alto Vallejo / Loma Linda'`);
  await c.query(`UPDATE public.residences SET zona_jefe = 'Prueba 0108' WHERE id = $1`, [vallejo.id]);
  await c.query(`UPDATE public.route_zones SET name = 'Prueba 0108 bis' WHERE name = 'Prueba 0108'`);
  check('renombrar arrastra la columna de minutos', (await one(`SELECT count(*)::int n FROM public.route_zone_times WHERE zone = 'Prueba 0108 bis'`)).n === 6);
  check('renombrar arrastra el conjunto puesto a mano', (await one(`SELECT zona_jefe z FROM public.residences WHERE id = $1`, [vallejo.id])).z === 'Prueba 0108 bis');
  await c.query(`DELETE FROM public.route_zones WHERE name = 'Prueba 0108 bis'`);
  check('quitar la zona borra sus minutos', (await one(`SELECT count(*)::int n FROM public.route_zone_times WHERE zone = 'Prueba 0108 bis'`)).n === 0);
  check('quitar la zona deja el conjunto en «según el mapa»', (await one(`SELECT zona_jefe z FROM public.residences WHERE id = $1`, [vallejo.id])).z === null);

  console.log('Permisos');
  const jefe = await one(`SELECT id FROM public.profiles WHERE email = 'jefe.local@rendio.test'`);
  const tripu = await one(`SELECT id FROM public.profiles WHERE email = 'tripu1.local@rendio.test'`);
  if (tripu) {
    await asUser(c, tripu.id, 'auxiliar');
    check('un tripulante la lee', (await one(`SELECT count(*)::int n FROM public.route_zones`)).n >= 4);
    check('un tripulante no puede crear zonas', await falla(`INSERT INTO public.route_zones (name) VALUES ('Del tripulante')`, [], /row-level security|42501/));
    const r = await c.query(`UPDATE public.route_zones SET polygon = $1 WHERE name = 'Porvenir'`, [JSON.stringify(BARRO_BLANCO)]);
    check('un tripulante no puede cambiar un dibujo (0 filas)', r.rowCount === 0);
    await asAdminDb(c);
  } else check('tripu1.local existe (correr _seed-e2e-local.mjs)', false);
  if (jefe) {
    await asUser(c, jefe.id, 'admin');
    await c.query(`INSERT INTO public.route_zones (name, sort_order) VALUES ('Del jefe', 9)`);
    const r = await c.query(`UPDATE public.route_zones SET polygon = $1 WHERE name = 'Del jefe'`, [JSON.stringify(BARRO_BLANCO)]);
    check('el jefe crea y dibuja', r.rowCount === 1);
    await asAdminDb(c);
  } else check('jefe.local existe (correr _seed-e2e-local.mjs)', false);

  console.log('La regla (zonas-dibujo.js) sobre el catálogo');
  const dib = [{ name: 'Barro Blanco', polygon: BARRO_BLANCO }];
  const res = await all(`SELECT name, latitude lat, longitude lng FROM public.residences WHERE is_active`);
  const dentro = res.filter(r => zonaEfectiva(null, dib, r.lat, r.lng).zona === 'Barro Blanco').map(r => r.name);
  check('en Barro Blanco cae solo Alto Vallejo / Loma Linda', dentro.join('|') === 'Alto Vallejo / Loma Linda', dentro.join(', '));
  const campus = res.find(r => r.name === 'Campus Reservado');
  check('Campus Reservado queda afuera', campus && zonaEfectiva(null, dib, campus.lat, campus.lng).zona === null);
  const v = res.find(r => r.name === 'Alto Vallejo / Loma Linda');
  check('lo puesto a mano gana sobre el dibujo', zonaEfectiva('Porvenir', dib, v.lat, v.lng).zona === 'Porvenir' && zonaEfectiva('Porvenir', dib, v.lat, v.lng).origen === 'mano');
  const doble = [...dib, { name: 'Otra', polygon: BARRO_BLANCO }];
  const e2 = zonaEfectiva(null, doble, v.lat, v.lng);
  check('en dos dibujos a la vez → sin zona, y dice cuáles', e2.zona === null && e2.en.length === 2);
  check('sin coordenadas → sin zona (no revienta)', zonaEfectiva(null, dib, null, null).zona === null && zonaEfectiva(null, dib, '', '').zona === null);
  check('una zona sin dibujo no contiene nada', zonaEfectiva(null, [{ name: 'Sin dibujo', polygon: null }], v.lat, v.lng).zona === null);
  check('un punto justo afuera del borde no entra', !zonaContienePunto(BARRO_BLANCO, 6.1560, -75.4029));
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
