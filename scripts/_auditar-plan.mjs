// AUDITOR DEL PLAN — la lista de todo lo que se ha roto antes.
//
// Nació el 23-ago-2026 después de once entregas en las que siempre se colaba
// algo: una persona que desaparecía del mensaje, un bloque que se devolvía,
// alguien madrugando de más. Las reglas de acá no son inventadas: cada una
// tiene su cita en docs/ESTUDIO-RUTAS-JULIAN.md. Se corre SIEMPRE antes de
// mandarle el mensaje a Julián.
//
//   node scripts/_auditar-plan.mjs /tmp/p.json /tmp/form.json 2026-08-23
//
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { catalogo, osrmMin, guardarCache } from './planes-jefe/lib-plan.mjs';

const [planPath, formPath, DIA] = process.argv.slice(2);
if (!planPath || !formPath || !DIA) { console.error('uso: _auditar-plan.mjs <plan.json> <form.json> <YYYY-MM-DD>'); process.exit(2); }

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const form = JSON.parse(readFileSync(formPath, 'utf8')).filter((r) => r.fecha === DIA);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: resid } = await sb.from('residences').select('*');
const { buscar } = catalogo(resid || []);
const MDE = { lat: 6.170795, lon: -75.427887 };   // pin corregido en la migración 0059
const TOL = 2;                                     // empatar no es devolverse
const TECHO_MADRUGADA = 60;
const t = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
// LA HORA QUE SE AUDITA ES LA QUE SE MANDA. El mensaje redondea la recogida al
// múltiplo de 5 más cercano (plan-a-whatsapp.mjs `suave`) porque Julián escribe
// así; la persona lee esa hora y a esa hora sale a la portería. Medir el minuto
// interno da fallos que nadie ve (8-sep-2026: Leslie 10:44 → "61 min", con el
// mensaje diciendo 10:45 → 60) y esconde los de al revés (10:42 impreso 10:40
// son 2 min más de madrugada que el minuto interno). Misma fórmula que el mensaje.
const impresa = (hm) => Math.round(t(hm) / 5) * 5;

const fallos = [];

// 1 · EL BARRIDO: cada vuelta de salida arranca en lo más lejano EN MINUTOS y
//     solo se acerca (audio del 21-ago; 32/32 de sus bloques lo cumplen).
console.log('── BARRIDO (minutos a MDE, deben ir bajando · tolerancia 2) ──');
for (const v of plan.vueltas.filter((v) => v.tipo === 'sal')) {
  if (v.paradas.length < 2) continue;
  const mins = [];
  for (const p of v.paradas) {
    const c = buscar(p.zona);
    const d = c && c.lat != null ? await osrmMin({ lat: c.lat, lon: c.lon }, MDE) : null;
    mins.push(d == null ? null : Math.round(d));
  }
  const ok = mins.every((m, i) => i === 0 || m == null || mins[i - 1] == null || m <= mins[i - 1] + TOL);
  const etq = v.paradas.map((p, i) => `${p.zona} ${mins[i] ?? '?'}`).join(' → ');
  console.log(`${ok ? 'ok ' : '✗✗ '} ${v.sale}  ${etq}`);
  if (!ok) fallos.push(`el barrido se devuelve en la vuelta de ${v.sale}: ${etq}`);
}

// 2 · TECHO DE MADRUGADA: nadie se recoge más de 60 min antes de SU PROPIA
//     presentación por acompañar a otro (sus 20 vueltas del 22-ago).
console.log('\n── MADRUGADA (recogida vs su propia presentación · techo 60) ──');
let alFilo = 0;
for (const v of plan.vueltas.filter((v) => v.tipo === 'sal')) {
  for (const p of v.paradas) for (const per of p.personas) {
    const d = t(per.dl) - impresa(p.eta);
    if (d > TECHO_MADRUGADA) { console.log(`✗✗ ${per.n}: ${d} min`); fallos.push(`${per.n} madruga ${d} min`); }
    else if (d > TECHO_MADRUGADA - 5) { console.log(`ok ${per.n}: ${d} min (al filo)`); alFilo++; }
  }
}
if (!alFilo) console.log('ninguno pasa de 55 min');

// 2b · EL ÚLTIMO DE LA VUELTA, DE NOCHE: nadie sube al carro más de 40 min
//      antes de su presentación si es el último recogido (o va solo) y su
//      presentación cae entre las 0:00 y las 6:00. Es la queja del 7-sep-2026
//      ("Danna León debe estar 3:10 y la recoges 2:25… es la madrugada, no hay
//      carros, más de 30 min"): de la última recogida al "deben estar" él pone
//      20 min (310 vueltas, máximo 30 de noche) y de noche entrega 5-20 antes
//      de la presentación → 25-40, máximo visto 40 (sus 7 vueltas nocturnas
//      del 7-sep). Con la tabla de zona metida en las vueltas de una parada y el
//      colchón de salida encima, nosotros le poníamos 45-55.
//      UMBRAL PROVISIONAL: 40 + 5 de tolerancia por el redondeo a múltiplos de
//      5 (n=7 de sus vueltas de noche con presentación conocida; ampliar con
//      cada corrección suya que llegue con formulario).
const TECHO_NOCHE = 45;
console.log(`\n── EL ÚLTIMO DE LA VUELTA, DE NOCHE (recogida vs presentación · techo ${TECHO_NOCHE} entre 0:00 y 6:00) ──`);
let noche = 0;
for (const v of plan.vueltas.filter((v) => v.tipo === 'sal')) {
  const ultima = v.paradas[v.paradas.length - 1];
  if (!ultima) continue;
  for (const per of ultima.personas) {
    const pres = t(per.dl);
    if (pres >= 6 * 60) continue;
    noche++;
    const d = pres - t(ultima.eta);
    if (d > TECHO_NOCHE) { console.log(`✗✗ ${per.n}: recogida ${ultima.eta}, presentación ${per.dl} → ${d} min`); fallos.push(`${per.n} sube al carro ${d} min antes de su presentación de madrugada (último de la vuelta)`); }
    else console.log(`ok ${per.n}: ${d} min`);
  }
}
if (!noche) console.log('sin vueltas de madrugada');

// 3 · CUPO: 4 personas, 0 excepciones en 99 vueltas suyas.
const maxPax = Math.max(...plan.vueltas.map((v) => v.pax));
console.log(`\n── CUPO ── máximo ${maxPax} personas`);
if (maxPax > 4) fallos.push(`una vuelta lleva ${maxPax} personas`);

// 4 · COBERTURA: nadie del formulario puede desaparecer callado. Si no se pudo
//     programar, tiene que estar declarado en el mensaje.
console.log('\n── COBERTURA ──');
// `ambiguos` también cuenta como declarado desde el 28-ago: el mensaje ya los
// nombra ("no sabemos quién es"). Antes no estaba en esta lista y KAREN DANIELA
// SUAREZ CARREÑO figuraba como desaparecida en silencio cuando sí se avisaba.
const declarado = new Set([...(plan.faltaPin || []), ...(plan.sinCasa || []), ...(plan.ambiguos || [])].map((s) => String(s).split('→')[0].trim()));
// `sinRutear` también cuenta como declarado, y por TRAMO: el mensaje sí los
// escribe, con su hora y su conjunto, marcados "(QUIZÁS NO HAYA CARRO)" — que
// es justo donde él pone su propio carro o un Uber. No estaban en esta lista y
// el 7-sep tres personas figuraban como desaparecidas en silencio cuando el
// mensaje las nombraba.
const sinCarro = { sal: new Set(), lle: new Set() };
for (const s of plan.sinRutear || []) (sinCarro[s.tipo] || sinCarro.sal).add(s.n);
for (const r of form) {
  const tiene = (tipo) => plan.vueltas.some((v) => v.tipo === tipo && v.paradas.some((p) => p.personas.some((x) => x.n === r.nombre)));
  const declara = [...declarado].some((d) => r.nombre.includes(d) || d.includes(r.nombre));
  const marcado = (tipo) => sinCarro[tipo].has(r.nombre);
  if (r.presentacion && !tiene('sal') && !declara && !marcado('sal')) fallos.push(`${r.nombre} no tiene salida y nadie lo dice`);
  if (r.llegada && !tiene('lle') && !declara && !marcado('lle')) fallos.push(`${r.nombre} no tiene llegada y nadie lo dice`);
  if (declara) console.log(`— ${r.nombre}: fuera del plan, PERO declarado en el mensaje`);
  else if (marcado('sal') || marcado('lle')) console.log(`— ${r.nombre}: sin carro, PERO el mensaje lo marca "quizás no haya carro"`);
}

console.log(`\n════ ${fallos.length ? 'FALLOS: ' + fallos.length : 'sin fallos'}`);
fallos.forEach((f) => console.log(' ✗ ' + f));
guardarCache();
process.exit(fallos.length ? 1 : 0);
