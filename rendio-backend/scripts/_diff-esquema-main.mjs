// QUÉ MIGRACIÓN LE FALTA A PRODUCCIÓN, DE VERDAD.
//
// El registro supabase_migrations.schema_migrations dice 0039, pero hay objetos
// de 0040+ ya creados: alguien aplicó SQL a mano sin anotarlo. Así que el
// registro no sirve. Esto NO le pregunta al registro: por cada archivo extrae
// los objetos que crea (tablas, columnas, funciones, enums, políticas) y
// comprueba en producción cuáles existen.
//
// SOLO LECTURA. Bloquea cualquier consulta que no sea SELECT.
import { readFileSync, readdirSync } from 'fs';
const ref = process.env.SUPABASE_PROJECT_REF || '', tok = process.env.SUPABASE_ACCESS_TOKEN || '';
if (ref !== 'wvuurnfdrrdondrbbkhd') { console.error('ABORT: no es producción'); process.exit(2); }
const sel = async (sql) => {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('BLOQUEADO: solo SELECT');
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method:'POST', headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},
    body: JSON.stringify({ query: sql, read_only: true })});
  const j = await r.json().catch(()=>null);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return j;
};

// Inventario de producción, de una sola vez.
const tablas = new Set((await sel(`SELECT table_name t FROM information_schema.tables WHERE table_schema='public'`)).map(r=>r.t));
const cols   = new Set((await sel(`SELECT table_name||'.'||column_name c FROM information_schema.columns WHERE table_schema='public'`)).map(r=>r.c));
const funcs  = new Set((await sel(`SELECT p.proname f FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`)).map(r=>r.f));
const enums  = new Set((await sel(`SELECT t.typname||'.'||e.enumlabel v FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid`)).map(r=>r.v));

const DIR = new URL('../supabase/migrations/', import.meta.url).pathname;
const archivos = readdirSync(DIR).filter(f=>f.endsWith('.sql') && f >= '0040').sort();

const rx = {
  tabla:  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.(\w+)/gi,
  col:    /ALTER\s+TABLE\s+(?:ONLY\s+)?public\.(\w+)[\s\S]{0,400}?ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi,
  func:   /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)/gi,
  enumv:  /ALTER\s+TYPE\s+public\.(\w+)\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi,
};
const faltan = [], estan = [], parciales = [];
for (const f of archivos) {
  const sql = readFileSync(DIR + f, 'utf8');
  const objs = [];
  for (const m of sql.matchAll(rx.tabla)) objs.push({ k:'tabla', id:m[1], ok:tablas.has(m[1]) });
  for (const m of sql.matchAll(rx.col))   objs.push({ k:'col',   id:`${m[1]}.${m[2]}`, ok:cols.has(`${m[1]}.${m[2]}`) });
  for (const m of sql.matchAll(rx.func))  objs.push({ k:'func',  id:m[1], ok:funcs.has(m[1]) });
  for (const m of sql.matchAll(rx.enumv)) objs.push({ k:'enum',  id:`${m[1]}.${m[2]}`, ok:enums.has(`${m[1]}.${m[2]}`) });
  if (!objs.length) { parciales.push({ f, nota:'sin objetos detectables (datos/políticas/índices)' }); continue; }
  const si = objs.filter(o=>o.ok).length;
  if (si === objs.length) estan.push({ f, n:objs.length });
  else if (si === 0) faltan.push({ f, n:objs.length, objs });
  else parciales.push({ f, nota:`${si}/${objs.length} objetos`, objs: objs.filter(o=>!o.ok) });
}
console.log(`\n══════ YA APLICADAS (${estan.length}) ══════`);
estan.forEach(x=>console.log(`  ✓ ${x.f}`));
console.log(`\n══════ FALTAN ENTERAS (${faltan.length}) ══════`);
faltan.forEach(x=>{ console.log(`  ✗ ${x.f}`); x.objs.forEach(o=>console.log(`       falta ${o.k} ${o.id}`)); });
console.log(`\n══════ REVISAR A MANO (${parciales.length}) ══════`);
parciales.forEach(x=>{ console.log(`  ? ${x.f} — ${x.nota}`); (x.objs||[]).slice(0,4).forEach(o=>console.log(`       falta ${o.k} ${o.id}`)); });
