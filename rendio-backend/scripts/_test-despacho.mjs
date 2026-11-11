// Pruebas del motor de despacho de llegadas (rendio-turnos/despacho-llegadas.js).
//   node scripts/_test-despacho.mjs
import { createRequire } from 'node:module';
const D = createRequire(import.meta.url)(new URL('../../rendio-turnos/despacho-llegadas.js', import.meta.url).pathname);
let ok = 0, mal = 0;
const t = (n, c) => { if (c) ok++; else { mal++; console.log('✗', n); } };
// Mapa de juguete: minutos desde el aeropuerto; entre dos puntos, la diferencia (misma vía) o la suma (lados opuestos).
const P = { airport: [0, 0], a: [20, 1], b: [22, 1], c: [25, -1], s1: [15, 1] };
const leg = (x, y) => { const p = P[x], q = P[y]; return x === y ? 0 : (p[1] === 0 || q[1] === 0 || p[1] === q[1]) ? Math.abs(p[0] - q[0]) : p[0] + q[0]; };
const base = (o) => Object.assign({ ahora: 600, leg, carros: [{ id: 'C1', listoEn: 0 }, { id: 'C2', listoEn: 0 }], llegadas: [] }, o);

let r = D.decidir(base({ llegadas: [{ id: 'a', sale: 640 }] }));
t('lejos del horizonte no se asigna', r.asignar.length === 0 && r.avisos.length === 0);

r = D.decidir(base({ llegadas: [{ id: 'a', sale: 615 }] }));
t('dentro del horizonte se asigna', r.asignar.length === 1 && r.asignar[0].recoge === 615 && r.asignar[0].espera === 0);
t('empate: el que lleva más rato libre', D.decidir(base({ carros: [{ id: 'C1', listoEn: 500 }, { id: 'C2', listoEn: 300 }], llegadas: [{ id: 'a', sale: 615 }] })).asignar[0].carro === 'C2');

r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 630 }, { id: 'C2', listoEn: 612 }], llegadas: [{ id: 'a', sale: 610 }] }));
t('gana el que recoge antes', r.asignar[0].carro === 'C2' && r.asignar[0].espera === 2);

r = D.decidir(base({ llegadas: [{ id: 'a', sale: 610 }, { id: 'b', sale: 614 }] }));
t('salen casi juntos y de camino: un carro', r.asignar.length === 1 && r.asignar[0].ids.join() === 'a,b' && r.asignar[0].recoge === 614);

r = D.decidir(base({ llegadas: [{ id: 'a', sale: 610 }, { id: 'b', sale: 619 }] }));
t('no se retiene a nadie por llenar', r.asignar.length === 2 && r.asignar[0].ids.join() === 'a' && r.asignar[0].espera === 0);

r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 622 }], llegadas: [{ id: 'a', sale: 610 }, { id: 'b', sale: 619 }] }));
t('si igual iba a esperar al carro, se van juntos', r.asignar.length === 1 && r.asignar[0].ids.length === 2 && r.asignar[0].recoge === 622);

r = D.decidir(base({ llegadas: [{ id: 'a', sale: 610 }, { id: 'c', sale: 611 }] }));
t('lados opuestos no se juntan', r.asignar.length === 2);

r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 0, salida: { primera: 's1', etaPrimera: 630 } }, { id: 'C2', listoEn: 618 }], llegadas: [{ id: 'a', sale: 610 }] }));
t('las salidas mandan: no se le da al que no alcanza su salida', r.asignar[0].carro === 'C2');
r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 0, salida: { primera: 's1', etaPrimera: 630, holgura: 10 } }], llegadas: [{ id: 'a', sale: 610 }] }));
t('con holgura de la salida sí alcanza', r.asignar.length === 1);
r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 0, salida: { primera: 's1', etaPrimera: 630 } }], llegadas: [{ id: 'a', sale: 610 }] }));
t('nadie alcanza: aviso sin carro', r.asignar.length === 0 && r.avisos[0].tipo === 'sin_carro');

r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 640 }, { id: 'AP', listoEn: 0, apoyo: true }], llegadas: [{ id: 'a', sale: 610 }] }));
t('apoyo entra si el fijo hace esperar de más', r.asignar[0].carro === 'AP' && r.asignar[0].apoyo === true && r.avisos.length === 0);
r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 620 }, { id: 'AP', listoEn: 0, apoyo: true }], llegadas: [{ id: 'a', sale: 610 }] }));
t('apoyo NO entra si el fijo alcanza', r.asignar[0].carro === 'C1' && r.asignar[0].espera === 10);
r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 640 }], llegadas: [{ id: 'a', sale: 610 }] }));
t('sin apoyo: se asigna igual y se avisa la espera', r.asignar[0].carro === 'C1' && r.avisos[0].tipo === 'espera_larga' && r.avisos[0].espera === 30);

r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 0 }], llegadas: [{ id: 'a', sale: 605 }, { id: 'c', sale: 612 }] }));
t('el mismo carro encadena y cuenta la vuelta al aeropuerto', r.asignar.length === 2 && r.asignar[1].recoge === 605 + 20 + 2 + 20);
r = D.decidir(base({ carros: [{ id: 'C1', listoEn: 0, cupo: 4 }], llegadas: [1, 2, 3, 4, 5].map((i) => ({ id: 'a', sale: 610, puerta: 'p', pax: 1 })).map((x, i) => ({ ...x, id: i ? 'b' : 'a', sale: 610 + i * 0 })) }));
t('no pasa del cupo', r.asignar.every((x) => x.ids.length <= 4));
const rt = D.ruta([{ id: 'b' }, { id: 'a' }], leg, 2);
t('entrega primero al más cercano', rt.ord.join() === 'a,b' && rt.dur === 20 + 2 + 2 + 2 && rt.ultima === 'b');

// ── El servidor usa el mismo motor y arma bien el estado ────────────────────
import { readFileSync } from 'node:fs';
const F = new URL('../supabase/functions/despacho-llegadas/', import.meta.url).pathname;
t('motor.js del servidor = el de la app', readFileSync(F + 'motor.js', 'utf8') === readFileSync(new URL('../../rendio-turnos/despacho-llegadas.js', import.meta.url).pathname, 'utf8'));
const { armarEstado, minutosEntre } = await import(F + 'estado.ts');
const JMC = { lat: 6.1708, lng: -75.4279 }, RIO = { lat: 6.1537, lng: -75.3738 }, CARMEN = { lat: 6.0837, lng: -75.3341 };
t('tramo JMC–Rionegro razonable', minutosEntre(JMC, RIO, 1) > 12 && minutosEntre(JMC, RIO, 1) < 25);
t('tramo sin coordenadas = 15', minutosEntre(JMC, { lat: null, lng: null }, 1) === 15);
const ahora = '2026-11-12T15:00:00.000Z', mas = (m) => new Date(Date.parse(ahora) + m * 60000).toISOString();
const foto = (o) => Object.assign({ org: 'o1', ahora, aeropuerto: JMC, cfg: { horizonte: 20, juntar: 6, esperaMax: 15, servicio: 2, trafico: 1 }, llegadas: [], carros: [] }, o);
let e = armarEstado(foto({
  llegadas: [{ ra: 'L1', sale: mas(10), pax: 2, ...RIO }, { ra: 'L2', sale: mas(12), pax: 1, ...RIO }, { ra: 'L3', sale: mas(50), pax: 1, ...RIO }],
  carros: [{ dp: 'D1', cupo: 4, known: true, air: true, free_at: mas(-5), lat: null, lng: null, salida: null },
           { dp: 'D2', cupo: 4, known: true, air: false, free_at: mas(0), ...CARMEN, salida: null },
           { dp: 'D3', cupo: 4, known: false, air: false, free_at: mas(0), lat: null, lng: null, salida: null }],
}));
t('conductor en JMC está listo ya', e.estado.carros[0].listoEn === 0);
t('conductor lejos suma el viaje a JMC', e.estado.carros[1].listoEn > 25);
t('conductor sin posición no se promete', e.estado.carros[2].listoEn === 25);
let d = D.decidir(e.estado);
t('servidor: cada vuelta va entera, no se mezclan', d.asignar.length === 2 && d.asignar.every((x) => x.ids.length === 1));
t('servidor: la primera al que está en JMC', d.asignar[0].carro === 'D1' && d.asignar[0].ids[0] === 'L1' && d.asignar[0].espera === 0);
t('servidor: la de 50 min sigue en espera', !d.asignar.some((x) => x.ids[0] === 'L3'));
t('servidor: la hora vuelve a ISO', e.aISO(10) === mas(10));
e = armarEstado(foto({
  llegadas: [{ ra: 'L1', sale: mas(5), pax: 1, ...CARMEN }],
  carros: [{ dp: 'D1', cupo: 4, known: true, air: true, free_at: mas(0), lat: null, lng: null, salida: { eta: mas(40), air: false, ...RIO } }],
}));
d = D.decidir(e.estado);
t('servidor: no le quita un conductor a su salida', d.asignar.length === 0 && d.avisos[0].tipo === 'sin_carro' && d.avisos[0].id === 'L1');
e = armarEstado(foto({
  llegadas: [{ ra: 'L1', sale: mas(5), pax: 1, ...RIO }],
  carros: [{ dp: 'D1', cupo: 4, known: true, air: true, free_at: mas(0), lat: null, lng: null, salida: { eta: mas(60), air: true, lat: null, lng: null } }],
}));
t('servidor: alcanza a volver a JMC para su siguiente llegada', D.decidir(e.estado).asignar.length === 1);
console.log(`${ok}/${ok + mal} pasaron`); process.exit(mal ? 1 : 0);
