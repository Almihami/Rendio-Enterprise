#!/usr/bin/env node
// EL PLAN, EN EL IDIOMA DE LA OPERACIÓN.
//
// Toma el JSON que escupe plan-del-dia.mjs y lo escribe en el formato de
// WhatsApp con el que se le pasa la programación al jefe — el mismo en el que él
// devuelve las vueltas armadas. Ver planes-jefe/FORMATO.md.
//
// Por qué existe: el tablero de la PWA no sirve por WhatsApp, y transcribir a
// mano es justo lo que este trabajo vino a quitar. Mientras el canal siga siendo
// un mensaje escrito, la salida del algoritmo tiene que ser un mensaje escrito.
//
// Uso:
//   node scripts/plan-del-dia.mjs .env.dev 2026-08-11 --carros=3 --json=/tmp/p.json
//   node scripts/plan-a-whatsapp.mjs /tmp/p.json
//   node scripts/plan-a-whatsapp.mjs /tmp/p.json --carros   → anota qué carro hace cada vuelta

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('uso: node plan-a-whatsapp.mjs <plan.json> [--carros]'); process.exit(1); }
const CON_CARRO = process.argv.includes('--carros');
const plan = JSON.parse(readFileSync(file, 'utf8'));

// El jefe escribe 3:10, no 03:10, y siempre en múltiplos de 5: le da a la gente
// una hora redonda. Al MÁS CERCANO, como lo haría una persona — redondear
// siempre hacia abajo metía hasta 4 min de espera extra en cada parada.
const min = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const suave = (hm) => {
  const t = Math.round(min(hm) / 5) * 5;
  return `${Math.floor(t / 60) % 24}:${String(t % 60).padStart(2, '0')}`;
};
const crudo = (hm) => `${Number(hm.split(':')[0])}:${hm.split(':')[1]}`;

// LA SIGLA DE LA AEROLÍNEA. El formulario deja escribir solo los dígitos, pero
// el jefe siempre escribe AV/JA/P5 — y no es cosmético: el desembarque depende
// de la aerolínea (migración 0058), así que sin sigla el modelo no sabe cuánto
// esperar. El patrón sale de sus tres planes, donde sí la trae:
//     1xxx · 2xxx · 8xxx · 9xxx → AV (Avianca)
//     5xxx                      → JA (JetSmart)
//     7xxx                      → P5 (Wingo)
// Verificado en vivo: el jefe dijo "Juan Martínez llega en el JA5839" y el 5839
// de la hoja venía pelado. Si ya trae sigla, se respeta como la escribió.
const sigla = (v) => {
  if (!v) return 'Aero';
  const s = String(v).trim();
  if (/^[a-z]/i.test(s)) return s.toUpperCase().replace(/\s+/g, '');
  if (!/^\d{3,4}$/.test(s)) return s;          // 5 dígitos o rarezas: se deja crudo
  return (s[0] === '7' ? 'P5' : s[0] === '5' ? 'JA' : 'AV') + s;
};

// "Erika, Jolene y Juanita" — como los escribe él.
const listar = (ns) => ns.length === 1 ? ns[0]
  : ns.slice(0, -1).join(', ') + ' y ' + ns[ns.length - 1];

// Se ordena por la PRIMERA hora que va a leer quien recibe el mensaje: en una
// llegada es el vuelo más temprano de la vuelta, no la hora con que el solver la
// etiquetó (una vuelta puede recoger tres vuelos).
const orden = (v) => v.tipo === 'lle'
  ? Math.min(...v.paradas.flatMap((p) => p.personas.map((q) => min(q.dl))))
  : min(v.paradas[0].eta);
const bloques = [...plan.vueltas].sort((a, b) => orden(a) - orden(b));

console.log(`Programación ${plan.dia} · ${plan.traslados} traslados (${plan.salidas} salidas + ${plan.llegadas} llegadas) · ${plan.carros.length} carros\n`);

for (const v of bloques) {
  const etiqueta = CON_CARRO ? `[${v.carro}] ` : '';

  if (v.tipo === 'lle') {
    // LLEGADA: la línea es por VUELO —hora de aterrizaje y número—, no por casa.
    // Varias personas del MISMO vuelo van en una sola línea; una vuelta puede
    // recoger dos o tres vuelos distintos, y cada uno lleva SU hora (el jefe
    // junta 21:15, 21:25 y 21:30 en un carro y escribe las tres líneas).
    const porVuelo = new Map();
    for (const p of v.paradas) for (const q of p.personas) {
      const k = `${q.dl}|${q.vuelo || 'Aero'}`;
      if (!porVuelo.has(k)) porVuelo.set(k, { hora: q.dl, vuelo: sigla(q.vuelo), gente: [] });
      porVuelo.get(k).gente.push(q.n);
    }
    let primera = true;
    for (const { hora, vuelo, gente } of [...porVuelo.values()].sort((a, b) => min(a.hora) - min(b.hora))) {
      console.log(`${etiqueta && primera ? etiqueta : ''}${crudo(hora)} ${listar(gente)} (${vuelo})`);
      primera = false;
    }
  } else {
    // SALIDA: una línea por parada con la hora de recogida, y el deadline al final.
    let primera = true;
    let pax = 0;
    for (const p of v.paradas) {
      const gente = p.personas.map((q) => q.n);
      pax += gente.length;
      console.log(`${etiqueta && primera ? etiqueta : ''}${suave(p.eta)} ${listar(gente)} (${p.zona})`);
      primera = false;
    }
    // OJO: `hotel` viene de reservations.is_overnight, y ese campo NO significa
    // "lo dejo en el hotel de acá". El formulario pregunta "¿ES UNA PERNOCTA?" y
    // marca a quien duerme FUERA de Rionegro — por eso esa persona trae un solo
    // tramo (sale y no vuelve, o vuelve sin haber salido). El jefe lo confirmó:
    // "no sé por qué puso que iba a hotel, Juan Martínez LLEGA, en el JA5839".
    // El hotel de sus planes es otra cosa (un destino que él escribe aparte) y
    // hoy no viene en el formulario. Hasta que venga, aquí no se escribe nada.
    console.log(`${pax > 1 ? 'Deben' : 'Debe'} estar ${crudo(v.presentacion)}`);
  }
  console.log('');
}

if (plan.sinRutear?.length) {
  console.log(`⚠ SIN CARRO (${plan.sinRutear.length}) — hay que resolverlos a mano:`);
  for (const s of plan.sinRutear) console.log(`   ${s.dl} ${s.tipo} ${s.nombre} (${s.zona})`);
}
