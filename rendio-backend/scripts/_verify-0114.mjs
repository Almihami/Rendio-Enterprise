// 0114 · el jefe cambia el conjunto, el apartamento y la segunda unidad del
// tripulante, contra la base LOCAL (supabase start).
//
//   cd rendio-backend/scripts && node _verify-0114.mjs
//
// Todo dentro de una transacción que se deshace: aplica 0114, arma sus propias
// filas (_local-fixtures) y comprueba
//   · un admin cambia conjunto + apartamento, agrega y quita la segunda unidad;
//   · quitar la segunda unidad se lleva su apartamento;
//   · mandar solo el apartamento no mueve el conjunto;
//   · un conjunto de otra organización se rechaza;
//   · dejarlo sin conjunto solo se puede si tiene dirección propia con pin;
//   · un tripulante y un conductor no pueden usarlo (_admin_target);
//   · a un conductor no se le escribe nada de tripulante;
//   · queda en la bitácora;
//   · lo de 0081 sigue igual (nombre, teléfono, aerolínea, campo no editable).
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

const c = await localClient();
const one = async (s, p) => (await c.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
// Corre como `quien` y devuelve el mensaje de error, o null si pasó.
const como = async (quien, rol, id, data) => {
  await c.query('SAVEPOINT s');
  try {
    await asUser(c, quien, rol);
    await c.query(`SELECT public.admin_update_profile($1, $2::jsonb)`, [id, JSON.stringify(data)]);
    await asAdminDb(c);
    await c.query('RELEASE SAVEPOINT s');
    return null;
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); await asAdminDb(c); return e.message; }
};
const SQL = readFileSync(new URL('../supabase/migrations/0114_jefe_edita_punto_tripulante.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

await c.query('BEGIN');
try {
  await c.query(SQL);
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa 0114');
  const aux = fx.auxUser;
  const ficha = () => one(`SELECT residence_id, residence_unit, residence_id_2, residence_unit_2, airline_id
    FROM public.auxiliar_profiles WHERE profile_id = $1`, [aux]);
  await c.query(`UPDATE public.auxiliar_profiles SET residence_unit = 'Torre 1 · 101' WHERE profile_id = $1`, [aux]);

  console.log('El jefe cambia el punto');
  check('cambia conjunto y apartamento', await como(jefe, 'admin', aux, { residence_id: fx.llano, residence_unit: ' Casa 12 ' }) === null);
  let f = await ficha();
  check('quedó en Quintas de Llanogrande, Casa 12 (sin espacios)', f.residence_id === fx.llano && f.residence_unit === 'Casa 12', JSON.stringify(f));

  check('solo el apartamento no mueve el conjunto', await como(jefe, 'admin', aux, { residence_unit: 'Casa 14' }) === null);
  f = await ficha();
  check('sigue en Llanogrande con Casa 14', f.residence_id === fx.llano && f.residence_unit === 'Casa 14', JSON.stringify(f));

  check('agrega segunda unidad', await como(jefe, 'admin', aux, { residence_id_2: fx.olivar, residence_unit_2: 'Torre 3 · 302' }) === null);
  f = await ficha();
  check('la segunda unidad es El Olivar, Torre 3 · 302', f.residence_id_2 === fx.olivar && f.residence_unit_2 === 'Torre 3 · 302', JSON.stringify(f));

  check('quitar la segunda unidad', await como(jefe, 'admin', aux, { residence_id_2: '' }) === null);
  f = await ficha();
  check('sin segunda unidad y sin su apartamento', f.residence_id_2 === null && f.residence_unit_2 === null, JSON.stringify(f));

  check('apartamento de 2ª unidad sin 2ª unidad no se guarda', await como(jefe, 'admin', aux, { residence_unit_2: 'Apto 9' }) === null
    && (await ficha()).residence_unit_2 === null);

  console.log('Lo que se rechaza');
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra', 'otra-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const ajeno = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude) VALUES ($1, 'Ajeno', 6.15, -75.38) RETURNING id`, [otraOrg])).id;
  let e = await como(jefe, 'admin', aux, { residence_id: ajeno });
  check('conjunto de otra organización', /no está en el catálogo/.test(e || ''), e);
  e = await como(jefe, 'admin', aux, { residence_id_2: ajeno });
  check('segunda unidad de otra organización', /segunda unidad no está en el catálogo/.test(e || ''), e);
  e = await como(jefe, 'admin', aux, { residence_id: '' });
  check('sin conjunto y sin dirección propia', /Elige un conjunto/.test(e || ''), e);
  check('nada quedó a medias', (await ficha()).residence_id === fx.llano);

  e = await como(jefe, 'admin', aux, { residence_id: '', residence_unit: 'X', full_name: 'Nombre Que No Debe Quedar' });
  check('si el punto falla, tampoco se guarda el nombre', /Elige un conjunto/.test(e || '')
    && (await one(`SELECT full_name FROM public.profiles WHERE id = $1`, [aux])).full_name !== 'Nombre Que No Debe Quedar', e);

  await c.query(`UPDATE public.auxiliar_profiles SET home_address = 'Casa azul', home_latitude = 6.1601, home_longitude = -75.3702 WHERE profile_id = $1`, [aux]);
  check('con dirección propia sí se puede quitar el conjunto', await como(jefe, 'admin', aux, { residence_id: '' }) === null
    && (await ficha()).residence_id === null);

  await c.query(`UPDATE public.residences SET is_active = false WHERE id = $1`, [fx.olivar]);
  check('un conjunto desactivado se puede elegir (la pantalla solo ofrece activos + el que ya tenía)',
    await como(jefe, 'admin', aux, { residence_id: fx.olivar }) === null && (await ficha()).residence_id === fx.olivar);
  await c.query(`UPDATE public.residences SET is_active = true WHERE id = $1`, [fx.olivar]);

  console.log('Quién puede');
  e = await como(fx.vecinoUser, 'auxiliar', aux, { residence_id: fx.llano });
  check('un tripulante no puede cambiarle el punto a otro', /Solo un administrador/.test(e || ''), e);
  e = await como(fx.drvUser, 'driver', aux, { residence_id: fx.llano });
  check('un conductor tampoco', /Solo un administrador/.test(e || ''), e);
  check('a un conductor no se le escribe ficha de tripulante', await como(jefe, 'admin', fx.drvUser, { residence_id: fx.llano }) === null
    && !(await one(`SELECT 1 x FROM public.auxiliar_profiles WHERE profile_id = $1`, [fx.drvUser])));

  console.log('Bitácora y lo de siempre');
  const b = await one(`SELECT count(*)::int n FROM public.audit_events WHERE entity_id = $1 AND event_type = 'profile_edited' AND payload ? 'residence_id'`, [aux]);
  check('cada cambio de conjunto quedó en la bitácora', b.n >= 3, b.n);
  const air = (await one(`INSERT INTO public.airlines (organization_id, name, iata_code) VALUES ($1, 'Prueba Air', 'PA') RETURNING id`, [fx.org])).id;
  check('nombre, teléfono y aerolínea siguen andando', await como(jefe, 'admin', aux, { full_name: 'Laura  Gómez  Ríos', phone: '300 123 4567', airline_id: air }) === null);
  const p = await one(`SELECT full_name, phone FROM public.profiles WHERE id = $1`, [aux]);
  check('…y quedaron bien', p.full_name === 'Laura Gómez Ríos' && p.phone === '3001234567' && (await ficha()).airline_id === air, JSON.stringify(p));
  e = await como(jefe, 'admin', aux, { home_address: 'algo' });
  check('un campo que no está en la lista sigue rechazado', /Campo no editable/.test(e || ''), e);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien, ${fail} mal`);
process.exit(fail ? 1 : 0);
