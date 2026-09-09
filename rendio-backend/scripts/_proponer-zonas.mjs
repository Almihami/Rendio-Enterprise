// ¿Se pueden inferir las zonas que faltan? Primero se PRUEBA el método contra
// las que Julián ya confirmó (leave-one-out): se esconde cada ancla y se mira si
// el método la vuelve a clasificar bien. Si falla ahí, no se propone nada.
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await sb.from('residences').select('name, latitude, longitude, zona_jefe');
const km = (a, b) => { const R=6371, dLat=(b.latitude-a.latitude)*Math.PI/180,
  dLon=(b.longitude-a.longitude)*Math.PI/180, la=a.latitude*Math.PI/180, lb=b.latitude*Math.PI/180;
  const h=Math.sin(dLat/2)**2+Math.cos(la)*Math.cos(lb)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h)); };
const anclas = data.filter(r => r.zona_jefe && r.latitude != null);
const K = 3;
function clasificar(x, pool) {
  const d = pool.filter(a => a.name !== x.name).map(a => ({ z: a.zona_jefe, d: km(x, a) })).sort((p,q) => p.d - q.d);
  const votos = {};
  for (const v of d.slice(0, K)) votos[v.z] = (votos[v.z] || 0) + 1 / Math.max(v.d, 0.05);
  const orden = Object.entries(votos).sort((a,b) => b[1] - a[1]);
  return { zona: orden[0][0], seguro: orden.length === 1 || orden[0][1] > orden[1][1] * 2, cerca: d[0] };
}
console.log(`═══ PRUEBA DEL MÉTODO sobre las ${anclas.length} que él confirmó ═══\n`);
let ok = 0;
for (const a of anclas) {
  const p = clasificar(a, anclas);
  const bien = p.zona === a.zona_jefe; if (bien) ok++;
  console.log(`  ${bien ? '✓' : '✗'} ${a.name.padEnd(28)} él: ${a.zona_jefe.padEnd(19)} método: ${p.zona}`);
}
console.log(`\n  ACIERTA ${ok} de ${anclas.length}`);
if (ok < anclas.length) {
  console.log('\n⚠ Falla en las que él YA confirmó → no se puede inferir el resto.');
  console.log('  Las 28 hay que preguntárselas: es la misma conclusión de la vez pasada.');
  process.exit(0);
}
console.log('\n═══ PROPUESTA ═══\n');
for (const x of data.filter(r => !r.zona_jefe && r.latitude != null)) {
  const p = clasificar(x, anclas);
  console.log(`  ${x.name.padEnd(28)} → ${p.zona.padEnd(19)} ${p.seguro ? '' : '(DUDOSO)'}`);
}
