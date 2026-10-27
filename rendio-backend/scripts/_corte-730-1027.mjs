// 27-oct-2026: el corte de pedidos (y el aviso «El Excel de mañana está listo»)
// pasa de las 7:40 p. m. (1180) a las 7:30 p. m. (1170). Pedido de Camilo, OK de la profa.
//   set -a; source <.env.dev|.env.main>; set +a; node scripts/_corte-730-1027.mjs [--produccion]
import pg from 'pg';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('BEGIN');
try {
  const antes = (await c.query(`SELECT crew_request_cutoff_min FROM public.app_settings WHERE id = 'singleton' FOR UPDATE`)).rows[0];
  console.log(`${prod ? 'PRODUCCIÓN' : 'dev'} · antes: ${antes && antes.crew_request_cutoff_min}`);
  if (!antes) throw new Error('no hay fila singleton');
  if (antes.crew_request_cutoff_min === 1170) { await c.query('ROLLBACK'); console.log('ya estaba en 1170 (7:30 p. m.)'); await c.end(); process.exit(0); }
  if (antes.crew_request_cutoff_min !== 1180) throw new Error(`esperaba 1180 y hay ${antes.crew_request_cutoff_min}: alguien lo cambió, no toco`);
  const r = await c.query(`UPDATE public.app_settings SET crew_request_cutoff_min = 1170 WHERE id = 'singleton' AND crew_request_cutoff_min = 1180`);
  if (r.rowCount !== 1) throw new Error('no cambió exactamente una fila');
  const desp = (await c.query(`SELECT crew_request_cutoff_min FROM public.app_settings WHERE id = 'singleton'`)).rows[0];
  await c.query('COMMIT');
  console.log(`después: ${desp.crew_request_cutoff_min} (7:30 p. m.) · ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`);
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('NO SE CAMBIÓ: ' + e.message); await c.end(); process.exit(1); }
await c.end();
