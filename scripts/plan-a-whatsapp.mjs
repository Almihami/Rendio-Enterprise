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
// Las llegadas de madrugada vienen como 24:43 (día siguiente) para que el solver
// las ponga al cierre del día; él las escribe 0:43. Módulo 24 al imprimir.
const crudo = (hm) => `${Number(hm.split(':')[0]) % 24}:${hm.split(':')[1]}`;
// LA HORA DEL "DEBEN ESTAR" NO ES LA PRESENTACIÓN. Julián lo confirmó el
// 17-ago-2026: "a la hora que debe estar en el aeropuerto, siempre coloca antes
// de la presentación, obviamente, porque hay trayecto desde donde se deja hasta
// el filtro". Y dio el número: "Melina, presentación 15:55, el vehículo por más
// tardar debe llegar 15:45". O sea presentación − colchonAeropuerto.
// Se redondea hacia ABAJO a múltiplo de 5 porque él escribe en múltiplos de 5 y
// porque adelantarse es gratis; llegar tarde no. Antes se imprimía la
// presentación tal cual, así que el plan le llegaba 10 minutos corrido y con
// horas como "Deben estar 15:32", que nunca son de él.
const deben = (hm, colchon) => {
  const t = Math.floor((min(hm) - colchon) / 5) * 5;
  return `${Math.floor(t / 60) % 24}:${String(t % 60).padStart(2, '0')}`;
};

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
  // "Reserva" no es un vuelo: es lo que escribe quien llena el formulario cuando
  // no voló. Sale por el camino de la reserva, no como sigla.
  if (/^[a-z]/i.test(s)) {
    if (/^reserva/i.test(s)) return null;
    // "J6" ES COMO LA TRIPULACIÓN ESCRIBE JETSMART. El formulario del 21-ago
    // trajo "J65116" y él lo escribió **JA5116**: no es un prefijo nuevo de
    // aerolínea, es que teclean J6 en vez de JA. Con J6 adelante el modelo no
    // reconocía la aerolínea y no sabía cuánto dura el desembarque.
    const j6 = s.replace(/\s+/g, '').match(/^j6\s*(\d{4})$/i);
    if (j6) return 'JA' + j6[1];
    return s.toUpperCase().replace(/\s+/g, '');
  }
  // CEROS A LA IZQUIERDA: el formulario del 23-ago trajo "043" y él escribe
  // AV43 (su plan del 20-ago, con el mismo vuelo). Sin quitarlos salía "AV043".
  const n = s.replace(/^0+(?=\d)/, '');
  if (!/^\d{2,4}$/.test(n)) return n;          // 5 dígitos o rarezas: se deja crudo
  // DOS Y TRES DÍGITOS TAMBIÉN LLEVAN SIGLA. El formulario del 20-ago trajo "43"
  // (Daniela) y "31" (Gloria) y él los escribió AV43 y AV31: en la regla que
  // dictó, AV con 2 o 3 dígitos es vuelo internacional. Sin sigla el modelo no
  // sabe cuánto dura el desembarque.
  if (n.length <= 3) return 'AV' + n;
  return (n[0] === '7' ? 'P5' : n[0] === '5' ? 'JA' : 'AV') + n;
};

// "Erika, Jolene y Juanita" — como los escribe él.
// El nombre sale tal como lo escribió la persona en el formulario — corregirlo
// sería adivinar. Lo único que se limpia son los espacios de más ("Sara  valencia").
const limpio = (n) => String(n).replace(/\s+/g, ' ').trim();
const listar = (ns0) => { const ns = ns0.map(limpio); return ns.length === 1 ? ns[0]
  : ns.slice(0, -1).join(', ') + ' y ' + ns[ns.length - 1]; };

// Se ordena por la PRIMERA hora que va a leer quien recibe el mensaje: en una
// llegada es el vuelo más temprano de la vuelta, no la hora con que el solver la
// etiquetó (una vuelta puede recoger tres vuelos).
// Un suelto se ordena por la hora que se IMPRIME (en una salida, la recogida
// `eta`; `dl` es la presentación). Ordenar por `dl` e imprimir `eta` sacaba el
// renglón de orden: "9:26" caía después de las 10:00.
const orden = (v) => v.sinCarro ? min(v.tipo === 'lle' ? v.dl : (v.eta || v.dl))
  : v.tipo === 'lle'
    ? Math.min(...v.paradas.flatMap((p) => p.personas.map((q) => min(q.dl))))
    : min(v.paradas[0].eta);

// LOS QUE NO CABEN VAN DENTRO DEL ITINERARIO, no en una lista al final. Es
// pedido explícito del jefe: "que la app los ponga en el itinerario pero si no
// hay carro que nos ponga un paréntesis de que quizás no haya carro". Sacarlos
// aparte le obligaba a cruzar dos listas a mano para ver el día completo.
const sueltos = (plan.sinRutear || []).map((s) => ({ ...s, sinCarro: true }));
const bloques = [...plan.vueltas, ...sueltos].sort((a, b) => orden(a) - orden(b));

console.log(`Programación ${plan.dia} · ${plan.traslados} traslados (${plan.salidas} salidas + ${plan.llegadas} llegadas) · ${plan.carros.length} carros`);
// No se anuncia un trato especial que no se está dando: si el corrimiento está
// en 0 el día se programó igual que uno normal, y eso hay que decirlo.
if (plan.diaLento) console.log(plan.diaLentoShift
  ? `${plan.diaLento} — se recoge ${plan.diaLentoShift} min más tarde de lo normal`
  : `${plan.diaLento} — programado como día normal (falta definir cuánto más tarde sacarlos)`);
console.log('');

for (const v of bloques) {
  const etiqueta = CON_CARRO ? `[${v.carro}] ` : '';

  if (v.sinCarro) {
    // Mismo renglón que los demás, con el paréntesis que él pidió: entra en la
    // hora que le toca para que se vea el hueco donde está.
    // En una SALIDA el renglón lleva la hora de RECOGIDA (v.eta); `dl` es la
    // presentación y ponerla acá decía "recójanlo a la hora en que ya tiene que
    // estar en el aeropuerto". En una LLEGADA sí manda la hora del vuelo.
    console.log(`${crudo(v.eta || v.dl)} ${v.n} (${v.zona}) (QUIZÁS NO HAYA CARRO)`);
    console.log('');
    continue;
  }

  if (v.tipo === 'lle') {
    // LLEGADA: la línea es por VUELO —hora de aterrizaje y número—, no por casa.
    // Varias personas del MISMO vuelo van en una sola línea; una vuelta puede
    // recoger dos o tres vuelos distintos, y cada uno lleva SU hora (el jefe
    // junta 21:15, 21:25 y 21:30 en un carro y escribe las tres líneas).
    const porVuelo = new Map();
    for (const p of v.paradas) for (const q of p.personas) {
      // LOS DE RESERVA SE RECOGEN EN EL HOTEL, no en el aeropuerto. Julián lo
      // escribió así al corregir el plan del 18-ago: "18:30 Karol L (Hotel)" y
      // "0:00 Yerly España (Hotel)". Y dio la regla: "si recoge en hotel, va
      // para casa; si recoge en casa y dice hotel, va para hotel". Su "llegada"
      // del formulario es la hora en que los pasa a recoger allá. No tienen
      // número de vuelo justamente porque no volaron: quedaron de reserva.
      // LA MARCA "R" DE RESERVA. Él la escribe siempre: "9:00 Andrea Núñez
      // (Aero R)", "16:00 Juan Bedoya (Aero R)", "23:59 Fernando y Angely
      // Rubiano (Hotel R)". Y OJO: reserva NO implica hotel — de las cuatro del
      // 20-ago mandó dos al hotel y dos al aeropuerto, y cuál es cuál solo lo
      // sabe él (depende de dónde los dejó al salir). Se escribe el aeropuerto,
      // que es a donde llegó nuestra salida, con la R para que él la mueva.
      const v = q.vuelo ? sigla(q.vuelo) : null;
      const donde = v || (q.hotel ? 'Aero R' : 'Aero');
      // Se agrupa por hora + vuelo. Cuando dos personas del mismo avión traen
      // horas MUY distintas ya se unificaron antes de resolver, en
      // plan-desde-formulario.mjs; las que llegan acá con 1 o 2 minutos de
      // diferencia se dejan en líneas separadas, que es como las escribe él (el
      // JA5477 del 18-ago: 13:13, 13:14 y 13:15, una línea cada una).
      const k = `${q.dl}|${donde}`;
      if (!porVuelo.has(k)) porVuelo.set(k, { hora: q.dl, vuelo: donde, gente: [] });
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
    console.log(`${pax > 1 ? 'Deben' : 'Debe'} estar ${deben(v.presentacion, plan.ajustes?.colchonAeropuerto ?? 10)}`);
  }
  console.log('');
}

if (plan.sinRutear?.length) {
  console.log(`(${plan.sinRutear.length} marcados "quizás no haya carro" — con ${plan.carros.length} carros no alcanzan)`);
}

// LOS QUE QUEDARON POR FUERA VAN AL FINAL DEL MENSAJE. Antes solo se avisaban
// por consola y el mensaje salía sin ellos, callado: el 23-ago Santiago Carmona
// desapareció entero porque su casa ("Primera") no tiene coordenada. Es mejor
// que Julián lea "a este no lo programé y por qué" a que cuente los renglones.
const pendientes = [];
if (plan.faltaPin?.length) pendientes.push(`Sin programar, nos falta la coordenada de la casa: ${plan.faltaPin.join(' · ')}`);
if (plan.sinCasa?.length) pendientes.push(`Sin programar, no sabemos dónde vive: ${plan.sinCasa.join(' · ')}`);
// UN NOMBRE QUE NO SE PUDO AMARRAR SE CAÍA DEL MENSAJE SIN DECIR NADA. El
// 28-ago "KAREN DANIELA SUAREZ CARREÑO" empataba con Daniela Villa y con
// Daniela Hincapié, así que el plan la descartó entera —salida Y llegada— y el
// mensaje no la mencionaba. Que alguien desaparezca en silencio es peor que
// dejarla sin carro: nadie la va a echar de menos hasta que llame.
if (plan.ambiguos?.length) pendientes.push(`Sin programar, no sabemos quién es (el nombre empata con dos personas): ${plan.ambiguos.join(' · ')}`);
if (plan.habituales?.length) pendientes.push(`Suelen ir y hoy el formulario no los trae — ¿van?: ${plan.habituales.join(' · ')}`);
if (pendientes.length) { console.log(''); pendientes.forEach((l) => console.log(l)); }
