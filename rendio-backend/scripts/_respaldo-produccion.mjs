// COPIA DE SEGURIDAD DE PRODUCCIÓN — SOLO LECTURA.
//
// POR QUÉ EXISTE: el proyecto de producción NO tiene copias automáticas ni PITR
// (comprobado 4-sep-2026 con la API de administración). Antes de aplicar
// migraciones a una base con 262 turnos y la nómina dentro, tiene que haber de
// dónde volver.
//
// Qué guarda: TODAS las filas de TODAS las tablas de `public`, en JSON, una por
// archivo, paginadas. Es un respaldo LÓGICO de datos — el esquema se reconstruye
// desde las migraciones, los datos no se reconstruyen de ningún lado.
//
//   set -a; source .env.main; set +a; node scripts/_respaldo-produccion.mjs <carpeta>
import { writeFileSync, mkdirSync } from 'fs';
const ref = process.env.SUPABASE_PROJECT_REF || '', tok = process.env.SUPABASE_ACCESS_TOKEN || '';
if (ref !== 'wvuurnfdrrdondrbbkhd') { console.error('ABORT: no es producción'); process.exit(2); }
const DEST = process.argv[2]; if (!DEST) { console.error('uso: node _respaldo-produccion.mjs <carpeta>'); process.exit(1); }
mkdirSync(DEST, { recursive: true });

const sel = async (sql) => {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('BLOQUEADO: solo SELECT');
  for (let intento = 1; intento <= 3; intento++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql, read_only: true }) });
    if (r.ok) return r.json();
    if (intento === 3) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    await new Promise(s => setTimeout(s, 1500 * intento));
  }
};

const tablas = (await sel(`SELECT table_name t FROM information_schema.tables
                            WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).map(r => r.t);
console.log(`${tablas.length} tablas a respaldar\n`);
const PAG = 500;
const resumen = [];
for (const t of tablas) {
  const [{ n }] = await sel(`SELECT count(*)::int n FROM public."${t}"`);
  const filas = [];
  for (let off = 0; off < n; off += PAG) {
    // Orden estable por ctid: sirve aunque la tabla no tenga PK.
    filas.push(...await sel(`SELECT * FROM public."${t}" ORDER BY ctid LIMIT ${PAG} OFFSET ${off}`));
  }
  writeFileSync(`${DEST}/${t}.json`, JSON.stringify(filas, null, 1));
  const ok = filas.length === n;
  console.log(`  ${ok ? '✓' : '✗'} ${t.padEnd(30)} ${String(filas.length).padStart(6)}/${n}`);
  resumen.push({ tabla: t, esperadas: n, guardadas: filas.length, completa: ok });
}
// El esquema, para poder comparar después.
const esquema = await sel(`SELECT table_name, column_name, data_type, is_nullable, column_default
                             FROM information_schema.columns WHERE table_schema='public'
                            ORDER BY table_name, ordinal_position`);
writeFileSync(`${DEST}/_esquema.json`, JSON.stringify(esquema, null, 1));
writeFileSync(`${DEST}/_resumen.json`, JSON.stringify({ proyecto: ref, tablas: resumen, columnas: esquema.length }, null, 1));
const malas = resumen.filter(r => !r.completa);
console.log(`\n${resumen.reduce((s, r) => s + r.guardadas, 0)} filas guardadas · ${esquema.length} columnas de esquema`);
console.log(malas.length ? `✗ INCOMPLETAS: ${malas.map(m => m.tabla).join(', ')}` : '✓ todas las tablas completas');
process.exit(malas.length ? 1 : 0);
