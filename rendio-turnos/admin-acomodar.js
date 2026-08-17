// admin-acomodar.js — "¿Dónde acomodo esta reserva?" (bloque D, eventualidad #6)
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // COSTO MARGINAL DE INSERCIÓN SOBRE EL PLAN PUBLICADO
  //
  // La pregunta de las 4 de la mañana no es "cómo sería el día ideal", es "esta
  // persona que acaba de aparecer, ¿en cuál de los carros que YA están rodando
  // la meto, y qué rompo?".
  //
  // POR QUÉ NO SE USA EL SOLVER (`rtSolveDay`), que es lo primero que uno
  // pensaría: ese reconstruye el día ENTERO desde cero — arranca a las 01:30 con
  // el carro en el depósito, no sabe qué paradas ya se atendieron ni dónde está
  // el carro ahora. Correrlo a las 4am produce el plan de un día que ya pasó a
  // medias, y `saveRoutePlan` descartaría en silencio lo que proponga para
  // paradas ya atendidas: el jefe vería opciones que no existen.
  //
  // Acá se hace lo contrario: se parte del plan REAL (route_assignments +
  // route_stops vigentes + última posición del conductor) y se prueba meter UNA
  // parada en cada hueco de cada vuelta viva. Se responde con números, no con un
  // plan nuevo: cuántos minutos cuesta, qué se rompe, y quién queda apretado.
  //
  // LA ETIQUETA "NECESITA UN TERCER VEHÍCULO" SE PONE SOLO ACÁ, y solo cuando
  // ninguna opción es viable. La base de datos (0068) nunca la pone: allá los
  // tiempos son haversine ×1.4 a 30 km/h y acá son OSRM con el factor del tramo
  // al aeropuerto. La primera vez que el sistema despierte a alguien por un
  // traslado que sí cabía, la alerta pierde el crédito y ya nadie la abre.
  // ====================================================================

  const acState = { open: false, loading: false, rid: null, res: null, plan: null, opts: null, error: null };

  // Matriz de tiempos SOLO para esta pregunta. No se reconstruye la NxN del
  // tablero: con 80 traslados serían 82×82 celdas, justo el gasto que el propio
  // código dice evitar. Se piden únicamente la fila y la columna del punto nuevo
  // (OSRM `table` acepta sources/destinations), o sea 2N celdas en vez de N².
  async function acMatrizIncremental(nuevo, puntos) {
    const M = { to: {}, from: {} };
    const todos = [nuevo].concat(puntos.map(p => p.coord));
    const coords = todos.map(p => `${p.lng},${p.lat}`).join(';');
    const dest = puntos.map((_, i) => i + 1).join(';');
    try {
      const url = `https://router.project-osrm.org/table/v1/driving/${coords}`
        + `?annotations=duration&sources=0&destinations=${dest}`;
      const j = await (await fetch(url)).json();
      if (j.code === 'Ok' && j.durations && j.durations[0]) {
        puntos.forEach((p, i) => {
          const s = j.durations[0][i];
          if (s != null) M.from[p.key] = Math.max(1, s / 60);
        });
      }
      // La vuelta: de cada punto AL nuevo. OSRM no es simétrico en vías reales.
      const url2 = `https://router.project-osrm.org/table/v1/driving/${coords}`
        + `?annotations=duration&sources=${dest}&destinations=0`;
      const j2 = await (await fetch(url2)).json();
      if (j2.code === 'Ok' && j2.durations) {
        puntos.forEach((p, i) => {
          const s = j2.durations[i] && j2.durations[i][0];
          if (s != null) M.to[p.key] = Math.max(1, s / 60);
        });
      }
    } catch (e) { /* sin OSRM: cae a haversine abajo, y se DICE en pantalla */ }
    M.real = Object.keys(M.from).length > 0;
    return M;
  }

  // Minutos entre dos puntos de esta pregunta. `M` solo conoce los tramos que
  // tocan al punto nuevo; para los tramos entre paradas que YA estaban se usa la
  // ETA que el tablero calculó al publicar, y si no hay, haversine.
  function acLeg(M, a, b) {
    if (a.key === 'nuevo' && M.from[b.key] != null) return M.from[b.key] * acFactor(b);
    if (b.key === 'nuevo' && M.to[a.key] != null) return M.to[a.key] * acFactor(a);
    return rtHaversineMin(a.coord, b.coord) * (rt.TRAFFIC_FACTOR || 1.25);
  }
  // El tramo al aeropuerto lleva su propio factor: OSRM lo sobreestima ahí y no
  // entre casas (ver AIRPORT_FACTOR, migración 0060).
  const acFactor = (p) => (p.key === 'airport' ? (rt.AIRPORT_FACTOR || 1) : 1) * (rt.TRAFFIC_FACTOR || 1.25);

  const acISOaMin = (iso) => {
    if (!iso) return null;
    try {
      const s = new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    } catch (_) { return null; }
  };
  const acHM = (min) => {
    if (min == null || !isFinite(min)) return '—';
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };

  // ---- El cálculo ----
  // Para cada vuelta viva del mismo sentido, se prueba insertar la parada nueva
  // en cada posición entre las PENDIENTES (las atendidas no se tocan: ya pasaron)
  // y se mide qué cambia.
  async function acCalcular(res, plan) {
    rtCfg();   // los parámetros de Ajustes (cupo, colchón, factores, servicio)
    const SERV = rt.SERVICE_MIN || 4;
    const BUF  = rt.AIRPORT_BUFFER || 10;

    const candidatas = plan.vueltas.filter(v =>
      v.type === res.type && v.driverProfileId && v.pendientes.length >= 0
      && v.status !== 'completed');

    if (!candidatas.length) {
      return { opciones: [], motivo: 'sin-vueltas' };
    }

    // Todos los puntos que tocan esta pregunta, para pedir la matriz una sola vez.
    const puntos = [{ key: 'airport', coord: RT_AIRPORT }];
    candidatas.forEach(v => {
      v.pendientes.forEach(s => {
        if (s.lat != null) puntos.push({ key: 's:' + s.stopId, coord: { lat: s.lat, lng: s.lng } });
      });
      if (v.pos) puntos.push({ key: 'p:' + v.id, coord: { lat: v.pos.lat, lng: v.pos.lng } });
    });
    const M = await acMatrizIncremental({ lat: res.lat, lng: res.lng }, puntos);

    const P = {};
    puntos.forEach(p => { P[p.key] = p; });
    const NUEVO = { key: 'nuevo', coord: { lat: res.lat, lng: res.lng } };

    const opciones = [];
    candidatas.forEach(v => {
      const pend = v.pendientes.filter(s => s.lat != null);
      const cupoLibre = v.cap - v.paxABordo - v.paxPendiente;

      // Punto de partida: si la vuelta ya arrancó y el carro reportó posición, es
      // donde ESTÁ. Si no, la primera parada pendiente. Esto es justo lo que el
      // solver no puede saber.
      const arranque = (v.status === 'in_progress' && v.pos) ? P['p:' + v.id] : null;
      const t0 = acISOaMin(v.pos ? v.pos.at : v.startAt);

      // Recorrido actual (solo lo pendiente) y el que quedaría con la parada nueva
      // metida en cada hueco.
      const recorrido = (secuencia) => {
        let t = 0, prev = arranque;
        secuencia.forEach(s => {
          const p = (s === NUEVO) ? NUEVO : P['s:' + s.stopId];
          if (prev) t += acLeg(M, prev, p);
          t += SERV;
          prev = p;
        });
        if (v.type === 'sal' && prev) t += acLeg(M, prev, P.airport);
        return t;
      };

      const base = recorrido(pend);

      for (let i = 0; i <= pend.length; i++) {
        const seq = pend.slice(0, i).concat([NUEVO], pend.slice(i));
        const total = recorrido(seq);
        const extra = Math.round(total - base);

        // ¿Qué se rompe? Se listan TODOS los problemas, no solo el primero: el
        // jefe decide distinto si es cupo que si es el deadline de alguien.
        const rompe = [];
        if (cupoLibre < res.pax) rompe.push(`el carro va lleno (${v.cap} puestos)`);

        // Deadline: con la parada nueva adentro, ¿alguien llega tarde?
        // `recorrido` ya incluye el tramo final al aeropuerto en las salidas, así
        // que la llegada absoluta es la hora de arranque más esa duración.
        let holg = null, llegada = null, dlMin = null;
        if (v.type === 'sal' && t0 != null) {
          const llegadaAero = t0 + total;
          const dls = seq.map(s => acISOaMin(s === NUEVO ? res.dueAt : s.dueAt)).filter(x => x != null);
          dlMin = dls.length ? Math.min(...dls) : null;
          llegada = acHM(llegadaAero);
          if (dlMin != null) {
            holg = Math.round(dlMin - llegadaAero - BUF);
            if (holg < 0) rompe.push(`llegaría ${Math.abs(holg)} min tarde a la presentación`);
          }
        }
        // En una LLEGADA (MDE → casas) no hay hora de presentación que romper: lo
        // que cuesta es alargarle el viaje a los que ya van montados, y eso ya lo
        // dice `extra`.

        opciones.push({
          vueltaId: v.id, carro: v.carro, conductor: v.conductor, tipo: v.type,
          pos: i, despuesDe: i === 0 ? null : (pend[i - 1] && pend[i - 1].name),
          extra, holg, llegada, dlMin,
          enCurso: v.status === 'in_progress', desdeGps: !!(v.status === 'in_progress' && v.pos),
          rompe, viable: rompe.length === 0,
          apretada: rompe.length === 0 && holg != null && holg < (rt.MARGIN_TIGHT || 15),
        });
      }
    });

    // La mejor posición POR VUELTA (no tiene sentido ofrecerle al jefe cinco
    // huecos del mismo carro), ordenadas por lo que de verdad cuesta.
    const mejorPorVuelta = new Map();
    opciones.forEach(o => {
      const prev = mejorPorVuelta.get(o.vueltaId);
      const mejor = !prev
        || (o.viable && !prev.viable)
        || (o.viable === prev.viable && o.extra < prev.extra);
      if (mejor) mejorPorVuelta.set(o.vueltaId, o);
    });
    const lista = [...mejorPorVuelta.values()].sort((a, b) =>
      (b.viable - a.viable) || (a.extra - b.extra));

    return {
      opciones: lista,
      real: M.real,
      motivo: lista.some(o => o.viable) ? null : 'no-cabe',
    };
  }

  // ---- La hoja ----
  // Se abre desde la eventualidad "Reserva tardía" en la bandeja del jefe.
  // Reusa `#jefe-chat` en espíritu pero tiene su propio nodo: son dos cosas
  // distintas y mezclarlas obligaría a que una supiera de la otra.
  async function acAbrir(rid) {
    const panel = document.getElementById('acomodar'); if (!panel) return;
    acBind();
    acState.open = true; acState.rid = rid; acState.loading = true;
    acState.res = null; acState.plan = null; acState.opts = null; acState.error = null;
    panel.classList.remove('hidden');
    acPintar();

    try {
      const res = await Api.getReservationForFit(rid);
      if (!res) throw new Error('No se encontró esa reserva.');
      if (res.cancelled) throw new Error('Esa reserva está cancelada.');
      if (res.lat == null) throw new Error('Esa reserva no tiene punto en el mapa, así que no se puede calcular dónde cabe.');
      acState.res = res;
      const day = (res.dueAt || '').slice(0, 10)
        || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      const plan = await Api.getPublishedPlan(day);
      acState.plan = plan;
      if (!plan.publicado) throw new Error('Ese día todavía no tiene plan publicado: acomódala desde Asignación, como cualquier otra.');
      acState.opts = await acCalcular(res, plan);
    } catch (e) {
      acState.error = (e && e.message) ? e.message : 'No se pudo calcular.';
    } finally {
      acState.loading = false;
      if (acState.open) acPintar();
    }
  }

  function acCerrar() {
    acState.open = false;
    const panel = document.getElementById('acomodar'); if (panel) panel.classList.add('hidden');
  }

  function acPintar() {
    const body = document.getElementById('ac-body'); if (!body) return;
    const head = document.getElementById('ac-sub');

    if (acState.loading) {
      if (head) head.textContent = 'Mirando los carros que están rodando…';
      body.innerHTML = '<p class="ac-load">Calculando sobre el plan publicado…</p>';
      return;
    }
    if (acState.error) {
      if (head) head.textContent = '';
      body.innerHTML = `<div class="ac-nope"><b>No se puede calcular</b><span>${escapeHtml(acState.error)}</span></div>`;
      return;
    }

    const r = acState.res, o = acState.opts || { opciones: [] };
    if (head) {
      head.textContent = `${r.name} · ${(r.address || '').split(',')[0]} · presentación ${acHM(acISOaMin(r.dueAt))}`;
    }

    const viables = o.opciones.filter(x => x.viable);

    // NINGUNA opción sirve → acá, y solo acá, se dice lo del tercer vehículo.
    if (!viables.length) {
      const razones = [...new Set(o.opciones.flatMap(x => x.rompe))];
      body.innerHTML = `
        <div class="ac-nope tercero">
          <b>No cabe en ningún carro: necesita un tercer vehículo.</b>
          <span>${o.motivo === 'sin-vueltas'
            ? 'No hay ninguna vuelta publicada de ese sentido para ese día.'
            : 'Se probaron todas las posiciones de todas las vueltas vivas.'}</span>
          ${razones.length ? `<ul class="ac-why">${razones.map(z => `<li>${escapeHtml(z)}</li>`).join('')}</ul>` : ''}
        </div>
        ${acDescargo(o)}
        ${o.opciones.length ? `<p class="ac-lbl">Lo más cerca que estuvo:</p>${o.opciones.slice(0, 3).map(acFila).join('')}` : ''}`;
      return;
    }

    body.innerHTML = `
      <p class="ac-lbl">${viables.length === 1 ? 'Cabe en un carro:' : `Cabe en ${viables.length} carros — de mejor a peor:`}</p>
      ${viables.map(acFila).join('')}
      ${o.opciones.filter(x => !x.viable).length
        ? `<p class="ac-lbl off">Descartadas:</p>${o.opciones.filter(x => !x.viable).map(acFila).join('')}`
        : ''}
      ${acDescargo(o)}`;
  }

  // Lo que el jefe NO puede adivinar mirando la pantalla, dicho en pantalla.
  function acDescargo(o) {
    const partes = [];
    if (!o.real) partes.push('No se pudo consultar el ruteo real (OSRM): estos tiempos son estimados en línea recta y pueden quedarse cortos.');
    if ((acState.opts?.opciones || []).some(x => x.enCurso && !x.desdeGps)) {
      partes.push('Alguna vuelta ya arrancó pero su carro no ha reportado posición: para esa, el cálculo sale de la hora planeada, no de dónde está.');
    }
    partes.push('Esto no mueve nada: es una recomendación. La reserva se acomoda desde Asignación.');
    return `<div class="ac-nota">${partes.map(p => `<p>${escapeHtml(p)}</p>`).join('')}</div>`;
  }

  function acFila(x) {
    const donde = x.despuesDe
      ? `después de ${escapeHtml(x.despuesDe.split(' ')[0])}`
      : 'de primera';
    const sello = x.viable
      ? (x.apretada ? '<span class="ac-tag tight">ajustado</span>' : '<span class="ac-tag ok">cabe</span>')
      : '<span class="ac-tag bad">no cabe</span>';
    const gps = x.enCurso
      ? (x.desdeGps ? '<span class="ac-gps">desde donde está el carro</span>'
                    : '<span class="ac-gps stale">sin GPS: desde la hora planeada</span>')
      : '';
    return `<div class="ac-opt ${x.viable ? (x.apretada ? 'tight' : 'ok') : 'bad'}">
      <div class="ac-opt-top">
        <b>${escapeHtml(x.carro)}</b>${sello}
        <span class="ac-extra">+${x.extra} min</span>
      </div>
      <div class="ac-opt-sub">${escapeHtml(x.conductor)} · ${donde}${
        x.llegada ? ` · llegaría ${escapeHtml(x.llegada)}` : ''}${
        x.holg != null ? ` · holgura ${x.holg} min` : ''}</div>
      ${gps ? `<div class="ac-opt-sub">${gps}</div>` : ''}
      ${x.rompe.length ? `<ul class="ac-why">${x.rompe.map(z => `<li>${escapeHtml(z)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }

  function acBind() {
    const panel = document.getElementById('acomodar');
    if (!panel || panel._acBound) return;
    panel._acBound = true;
    panel.addEventListener('click', (e) => {
      if (e.target === panel || e.target.closest('#ac-close')) { acCerrar(); return; }
      if (e.target.closest('#ac-again')) { acAbrir(acState.rid); return; }
    });
  }
