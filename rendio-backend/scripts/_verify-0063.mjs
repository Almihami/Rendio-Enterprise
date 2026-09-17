// Verificación de 0062/0063 en dev. Solo lectura salvo la prueba del RPC, que
// crea una eventualidad de prueba y LA BORRA al final.
//
//   set -a; source .env.dev; set +a; node scripts/_verify-0063.mjs
import pg from 'pg';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }

const c = new pg.Client({
  host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres', ssl: { rejectUnauthorized: false },
});
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

let ok = 0, fail = 0;
const check = (nombre, cond, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? ' → ' + detalle : ''}`); }
};

console.log('\n1. Las novedades viejas no se movieron de bandeja');
const porScope = await q(`SELECT scope, status, count(*)::int FROM public.incidents GROUP BY scope, status ORDER BY 1,2`);
console.log('   ', JSON.stringify(porScope));
const operacion = porScope.filter(r => r.scope === 'operacion').reduce((s, r) => s + r.count, 0);
const flota = porScope.filter(r => r.scope === 'flota').reduce((s, r) => s + r.count, 0);
check('todo lo que existía quedó en scope=flota', operacion === 0, `hay ${operacion} en operacion`);
check('la bandeja de Eventualidades arranca vacía', operacion === 0);
console.log(`    (${flota} novedades de flota intactas)`);

console.log('\n2. El insert directo ya no puede colgarse de una reserva');
const pol = (await q(`SELECT with_check FROM pg_policies WHERE tablename='incidents' AND policyname='p_incidents_insert_own'`))[0];
check('la policy exige reservation_id NULL y scope flota',
  /reservation_id IS NULL/.test(pol.with_check) && /scope = 'flota'/.test(pol.with_check), pol.with_check);

console.log('\n3. El RPC report_incident');
const proto = (await q(`SELECT pg_get_function_identity_arguments(oid) a, prosecdef FROM pg_proc WHERE proname='report_incident'`))[0];
check('existe y es SECURITY DEFINER', !!proto && proto.prosecdef === true);
check('recibe los 8 parámetros', (proto?.a || '').split(',').length === 8, proto?.a);

// Prueba real: crear una eventualidad como el sistema y borrarla.
console.log('\n4. Se puede escribir una eventualidad del sistema (reporter_id NULL)');
const org = (await q(`SELECT id FROM public.organizations LIMIT 1`))[0];
let creada = null;
try {
  creada = (await q(`
    INSERT INTO public.incidents (organization_id, reporter_id, category, severity, status,
                                  description, scope, source, details, dedupe_key)
    VALUES ($1, NULL, 'driver_late', 'medium', 'open',
            'PRUEBA _verify-0063 — se borra sola', 'operacion', 'system',
            '{"prueba":true}'::jsonb, 'verify-0063-prueba')
    RETURNING id`, [org.id]))[0];
  check('inserta sin reportero humano', !!creada.id);
} catch (e) { check('inserta sin reportero humano', false, e.message); }

console.log('\n5. El dedupe impide duplicar la misma alerta abierta');
try {
  await q(`INSERT INTO public.incidents (organization_id, reporter_id, category, severity, status,
             description, scope, source, dedupe_key)
           VALUES ($1, NULL, 'driver_late', 'medium', 'open', 'duplicado', 'operacion', 'system', 'verify-0063-prueba')`, [org.id]);
  check('rechaza el duplicado', false, 'dejó insertar dos veces la misma llave');
} catch (e) {
  check('rechaza el duplicado', /duplicate key|unique/i.test(e.message), e.message.slice(0, 80));
}

console.log('\n6. Al resolverla, la llave se libera y el problema puede volver');
if (creada) {
  await q(`UPDATE public.incidents SET status='resolved', resolved_at=now() WHERE id=$1`, [creada.id]);
  try {
    const otra = (await q(`INSERT INTO public.incidents (organization_id, reporter_id, category, severity, status,
                 description, scope, source, dedupe_key)
               VALUES ($1, NULL, 'driver_late', 'medium', 'open', 'PRUEBA reapertura — se borra sola', 'operacion', 'system', 'verify-0063-prueba')
               RETURNING id`, [org.id]))[0];
    check('deja volver a levantarla', !!otra.id);
    await q(`DELETE FROM public.incidents WHERE id=$1`, [otra.id]);
  } catch (e) { check('deja volver a levantarla', false, e.message); }
  await q(`DELETE FROM public.incidents WHERE id=$1`, [creada.id]);
}

console.log('\n7. Limpieza');
const resto = (await q(`SELECT count(*)::int n FROM public.incidents WHERE dedupe_key='verify-0063-prueba' OR description LIKE 'PRUEBA %'`))[0];
check('no quedó basura de la prueba', resto.n === 0, `quedaron ${resto.n}`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} bien · ${fail} mal\n`);
await c.end();
process.exit(fail === 0 ? 0 : 1);
