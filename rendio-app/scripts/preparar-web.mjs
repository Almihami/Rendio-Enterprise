// Copia rendio-turnos/ a www/ (la carpeta que Capacitor mete en la app) y le
// pone la configuración del entorno: node scripts/preparar-web.mjs dev|prod
//
//   dev  → Supabase de pruebas (Rendio-dev). Para probar en teléfonos.
//   prod → Supabase de producción (Rendio-Main), tal como está en config.js
//          de main. Es lo que se sube a las tiendas.
//
// No copia lo que solo sirve en la web (service worker, página sin conexión,
// vercel.json, notas). Los valores de cada entorno están en entornos.json.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, '..');
const origen = join(raiz, '..', 'rendio-turnos');
const destino = join(raiz, 'www');

const entorno = process.argv[2];
const entornos = JSON.parse(readFileSync(join(raiz, 'entornos.json'), 'utf8'));
if (!entornos[entorno]) {
  console.error(`Uso: node scripts/preparar-web.mjs ${Object.keys(entornos).join('|')}`);
  process.exit(1);
}
const e = entornos[entorno];

const FUERA = new Set(['_dev', 'correo-registro', 'sw.js', 'offline.html', 'vercel.json',
  'manifest.json', 'privacidad.html', 'eliminar-cuenta.html', 'soporte.html', 'app-version.json']);
rmSync(destino, { recursive: true, force: true });
cpSync(origen, destino, {
  recursive: true,
  filter: (src) => {
    const n = basename(src);
    if (src === origen) return true;
    if (FUERA.has(n) || n.endsWith('.md') || n === '.DS_Store') return false;
    return true;
  },
});

// config.js: el de rendio-turnos (main = producción) con las llaves del entorno
// encima, y el bloque APP que lee native.js.
const cfgPath = join(destino, 'config.js');
let cfg = readFileSync(cfgPath, 'utf8');
const poner = (clave, valor) => {
  const re = new RegExp(`(${clave}:\\s*)'[^']*'`);
  if (!re.test(cfg)) throw new Error(`config.js no tiene ${clave}`);
  cfg = cfg.replace(re, `$1'${valor}'`);
};
if (e.SUPABASE_URL) poner('SUPABASE_URL', e.SUPABASE_URL);
if (e.SUPABASE_ANON_KEY) poner('SUPABASE_ANON_KEY', e.SUPABASE_ANON_KEY);
if (e.VAPID_PUBLIC_KEY) poner('VAPID_PUBLIC_KEY', e.VAPID_PUBLIC_KEY);
cfg += `\n// Agregado por rendio-app/scripts/preparar-web.mjs (${entorno}): lo lee native.js.\n`
  + `window.RENDIO_CONFIG.APP = ${JSON.stringify(e.APP, null, 2)};\n`;
writeFileSync(cfgPath, cfg);

// index.html sin el <link rel="manifest">: dentro de la app no hay PWA que instalar.
const idx = join(destino, 'index.html');
writeFileSync(idx, readFileSync(idx, 'utf8').replace(/\s*<link rel="manifest"[^>]*>/, ''));

if (!existsSync(join(destino, 'native.js'))) throw new Error('falta native.js en rendio-turnos');
const url = (cfg.match(/SUPABASE_URL:\s*'([^']*)'/) || [])[1];
console.log(`www/ listo (${entorno}) → ${url}`);
