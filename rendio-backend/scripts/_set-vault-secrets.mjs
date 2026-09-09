// Guarda en Supabase Vault lo que la base necesita para despachar los avisos de
// madrugada: la URL de la Edge Function y la llave de servicio.
//
// Estos DOS valores no pueden ir en una migración porque las migraciones se
// commitean. Por eso viven en Vault y este script se corre UNA VEZ por ambiente.
//
//   set -a; source .env.dev; set +a; node scripts/_set-vault-secrets.mjs
//
// No imprime ningún secreto: solo dice si quedó guardado.
import pg from 'pg';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!ref || !url || !key) {
  console.error('Faltan SUPABASE_PROJECT_REF / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Corre:  set -a; source .env.dev; set +a');
  process.exit(1);
}
if (ref !== DEV_REF) {
  console.error(`ABORT: este script está apuntando a ${ref}, que no es dev.`);
  console.error('Para otro ambiente, cambia DEV_REF a conciencia.');
  process.exit(2);
}

const dispatchUrl = url.replace(/\/$/, '') + '/functions/v1/dispatch-notifications';

const c = new pg.Client({
  host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres', ssl: { rejectUnauthorized: false },
});
await c.connect();

async function guardar(nombre, valor, descripcion) {
  const { rows } = await c.query('SELECT id FROM vault.secrets WHERE name = $1', [nombre]);
  if (rows.length) {
    await c.query('SELECT vault.update_secret($1, $2, $3, $4)', [rows[0].id, valor, nombre, descripcion]);
    console.log(`  ✓ ${nombre} actualizado`);
  } else {
    await c.query('SELECT vault.create_secret($1, $2, $3)', [valor, nombre, descripcion]);
    console.log(`  ✓ ${nombre} creado`);
  }
}

console.log(`Guardando secretos en el Vault de ${ref}:`);
await guardar('dispatch_notifications_url', dispatchUrl,
  'URL de la Edge Function que drena notification_outbox (migración 0066).');
await guardar('service_role_key', key,
  'Llave de servicio con la que el cron dispara dispatch-notifications. Rotarla obliga a volver a correr este script.');

// Comprobación: que la función de despacho los pueda leer de verdad.
const { rows } = await c.query(`
  SELECT (SELECT count(*) FROM vault.decrypted_secrets WHERE name='dispatch_notifications_url')::int AS url_ok,
         (SELECT count(*) FROM vault.decrypted_secrets WHERE name='service_role_key')::int AS key_ok`);
console.log(`\nLegibles desde la base: url=${rows[0].url_ok === 1 ? 'sí' : 'NO'} · llave=${rows[0].key_ok === 1 ? 'sí' : 'NO'}`);
console.log('\nSi rotas la llave de servicio, vuelve a correr esto o los avisos dejan de despacharse.');

await c.end();
