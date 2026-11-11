// DESPACHO DE LLEGADAS EN STANDBY (10-nov-2026).
//
// Las llegadas no se le dan a un carro la noche anterior: quedan en espera
// («StandBy») y se reparten cuando el vuelo ya tiene hora real (FlightRadar),
// al conductor que está en el aeropuerto o que va a estar ahí a tiempo.
//
// Este archivo es SOLO la decisión: no lee la base ni pinta nada. Recibe una
// foto («estado») y devuelve qué asignar ahora y a quién avisar. Lo usan igual
// el simulador (scripts/simular-despacho.mjs) y el servidor, para que lo que se
// midió sea lo que corre.
//
// Reglas, en este orden (dictadas por Harold el 10-nov):
//   1. Las SALIDAS mandan: a un conductor solo se le da una llegada si después
//      alcanza la primera casa de su siguiente salida a la hora que tenía.
//   2. Que nadie espere: gana el carro que puede recoger MÁS TEMPRANO; si
//      empatan, el que lleva más rato libre.
//   3. Llenar el carro cuando sale gratis: se junta a quien sale del avión casi
//      al tiempo (cfg.juntar) y vive de camino, o a quien de todas formas iba a
//      esperar a ese mismo carro. Nunca se retiene a alguien por llenar.
//   4. Se decide TARDE: solo se reparte lo que sale en los próximos
//      cfg.horizonte minutos; lo demás sigue en espera por si el vuelo se mueve.
//   5. Si nadie alcanza dentro de cfg.esperaMax, se avisa (ahí entra el apoyo)
//      y aun así se deja con el carro que llega primero.
(function (root) {
  'use strict';

  const DEF = {
    horizonte: 20,   // min antes de que salga la persona en que se decide su carro
    juntar: 6,       // min que el primero puede esperar a otro para irse juntos
    esperaMax: 15,   // espera a partir de la cual se pide apoyo
    servicio: 2,     // min por parada (bajar maletas)
    desvioMax: 15,   // min de más que alguien puede ir montado por compartir
    agrupar: true,   // false = cada llegada va sola (el servidor reparte vueltas ya armadas)
    cupo: 4,
  };

  const paxDe = (g) => g.reduce((s, x) => s + (x.pax || 1), 0);

  function permutar(a) {
    if (a.length <= 1) return [a.slice()];
    const out = [];
    a.forEach((x, i) => permutar(a.slice(0, i).concat(a.slice(i + 1))).forEach(p => out.push([x].concat(p))));
    return out;
  }

  // Mejor orden de entrega saliendo del aeropuerto. Devuelve la duración hasta la
  // última casa y cuánto va montado cada uno. Los que comparten portería (misma
  // `puerta`) se bajan juntos.
  function ruta(grupo, leg, servicio) {
    const puertas = [];
    grupo.forEach(x => { const k = x.puerta || x.id; let p = puertas.find(q => q.k === k); if (!p) { p = { k, ref: x.id, ids: [] }; puertas.push(p); } p.ids.push(x.id); });
    let mejor = null;
    permutar(puertas).forEach(perm => {
      let t = 0, prev = 'airport'; const montado = {};
      perm.forEach(p => { t += leg(prev, p.ref); p.ids.forEach(id => { montado[id] = t; }); t += servicio; prev = p.ref; });
      if (!mejor || t < mejor.dur) mejor = { dur: t, ord: perm.flatMap(p => p.ids), ultima: prev, montado };
    });
    return mejor;
  }

  // Grupos posibles alrededor de A, del más lleno al más pequeño ([A] solo).
  function grupos(A, vecinos, leg, cfg, cupo) {
    const g = [A];
    const lista = [[A]];
    vecinos.slice().sort((x, y) => x.sale - y.sale).forEach(B => {
      const cand = g.concat([B]);
      if (paxDe(cand) > cupo) return;
      const junto = ruta(cand, leg, cfg.servicio), base = ruta(g, leg, cfg.servicio), solo = ruta([B], leg, cfg.servicio);
      // ¿un carro sale más barato que dos? (mismo criterio del tablero)
      if (junto.dur > base.dur + solo.dur) return;
      // nadie va montado mucho más de lo que iría solo
      const directo = (x) => leg('airport', x.id);
      if (cand.some(x => junto.montado[x.id] - directo(x) > cfg.desvioMax)) return;
      g.push(B);
      lista.unshift(g.slice());
    });
    return lista;
  }

  // estado = {
  //   ahora,                               minuto actual
  //   carros: [{ id, listoEn, cupo,        listoEn: minuto en que está LIBRE EN EL AEROPUERTO
  //              salida: { primera, etaPrimera } | null }],   su siguiente salida fija
  //   llegadas: [{ id, sale, pax, puerta }],                  sale: minuto estimado en que está afuera
  //   leg(a, b),                           minutos entre dos puntos ('airport' o id de llegada/parada)
  //   cfg                                  opcional, pisa DEF
  // }
  // Devuelve { asignar: [{ carro, ids, recoge, fin, ultima, espera }], avisos: [{ tipo, id, espera }] }
  function decidir(estado) {
    const cfg = Object.assign({}, DEF, estado.cfg || {});
    const leg = estado.leg, ahora = estado.ahora;
    const carros = estado.carros.map(c => Object.assign({}, c, { listo: Math.max(c.listoEn, ahora) }));
    const pend = estado.llegadas.slice().sort((a, b) => a.sale - b.sale);
    const out = { asignar: [], avisos: [] };
    const usados = new Set();

    // conApoyo=false: solo los carros fijos. El de apoyo (c.apoyo) entra únicamente
    // cuando los fijos no alcanzan dentro de esperaMax (regla: siempre 2, el 3º
    // solo si hace falta).
    const mejorCarro = (G, conApoyo) => {
      const sale = Math.max.apply(null, G.map(x => x.sale));
      const r = ruta(G, leg, cfg.servicio);
      let best = null;
      carros.forEach(c => {
        if (c.apoyo && !conApoyo) return;
        if (paxDe(G) > (c.cupo || cfg.cupo)) return;
        const recoge = Math.max(c.listo, sale);
        const fin = recoge + r.dur;
        // 1. las salidas mandan
        //    (`holgura`: minutos que esa salida aguanta sin llegar tarde, si los trae)
        if (c.salida && fin + leg(r.ultima, c.salida.primera) > c.salida.etaPrimera + (c.salida.holgura || 0)) return;
        if (!best || recoge < best.recoge || (recoge === best.recoge && c.listoEn < best.c.listoEn)) best = { c, recoge, fin, r, G };
      });
      return best;
    };

    for (const A of pend) {
      if (usados.has(A.id)) continue;
      if (A.sale - ahora > cfg.horizonte) break;            // 4. todavía no: sigue en espera
      let elegido = null;
      for (const conApoyo of [false, true]) {
        if (conApoyo && !carros.some(c => c.apoyo)) break;
        const solo = mejorCarro([A], conApoyo);
        const vecinos = cfg.agrupar === false ? [] : pend.filter(B => B !== A && !usados.has(B.id) && B.sale >= A.sale
          && B.sale - A.sale <= Math.max(cfg.juntar, solo ? solo.recoge - A.sale : 0));
        const cupoMax = Math.max.apply(null, carros.map(c => c.cupo || cfg.cupo).concat([0]));
        elegido = null;
        for (const G of grupos(A, vecinos, leg, cfg, cupoMax)) {
          if (G.length === 1) { elegido = solo; break; }
          const m = mejorCarro(G, conApoyo);
          // 3. gratis: A no sale más tarde que solo, o espera a lo sumo `juntar`
          if (m && m.recoge <= Math.max(solo ? solo.recoge : -Infinity, A.sale + cfg.juntar)) { elegido = m; break; }
        }
        if (elegido && elegido.recoge - A.sale <= cfg.esperaMax) break;   // los fijos alcanzan: no se llama al apoyo
      }
      if (!elegido) { out.avisos.push({ tipo: 'sin_carro', id: A.id, sale: A.sale }); continue; }
      const espera = elegido.recoge - A.sale;
      if (espera > cfg.esperaMax) out.avisos.push({ tipo: 'espera_larga', id: A.id, sale: A.sale, espera, carro: elegido.c.id });
      elegido.G.forEach(x => usados.add(x.id));
      out.asignar.push({ carro: elegido.c.id, apoyo: !!elegido.c.apoyo, ids: elegido.r.ord, recoge: elegido.recoge, fin: elegido.fin, ultima: elegido.r.ultima, espera });
      // el carro queda comprometido: vuelve al aeropuerto después de la última casa
      elegido.c.listo = elegido.fin + leg(elegido.r.ultima, 'airport');
      elegido.c.listoEn = elegido.c.listo;
    }
    return out;
  }

  const api = { decidir, ruta, DEF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RendioDespacho = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
