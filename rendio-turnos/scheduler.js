(function () {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_INDEX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const DAY_LABELS_ES = {
    mon: 'LUNES', tue: 'MARTES', wed: 'MIÉRCOLES', thu: 'JUEVES',
    fri: 'VIERNES', sat: 'SÁBADO', sun: 'DOMINGO'
  };

  function addDays(isoDate, n) {
    const d = new Date(isoDate + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function startOfWeekISO(date) {
    const d = new Date(typeof date === 'string' ? date + 'T00:00:00' : date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  }

  // Semana por defecto al cargar la app. Lun–Jue → semana actual (la que ya
  // arrancó); Vie–Dom → semana SIGUIENTE (la que se está llenando para generar).
  // Antes pasaba que el viernes los conductores entraban y editaban la semana
  // que ya habían trabajado por error.
  function defaultWeekISO(date) {
    const d = new Date(typeof date === 'string' ? date + 'T00:00:00' : date);
    const dow = d.getDay(); // 0=Dom, 5=Vie, 6=Sáb
    if (dow === 0 || dow === 5 || dow === 6) {
      const dPlus = new Date(d);
      dPlus.setDate(dPlus.getDate() + 7);
      return startOfWeekISO(dPlus);
    }
    return startOfWeekISO(d);
  }

  function weekDates(weekStartISO) {
    return DAYS.map((day, i) => {
      const iso = addDays(weekStartISO, i);
      return {
        key: day,
        label: DAY_LABELS_ES[day],
        date: iso,
        dayNum: new Date(iso + 'T00:00:00').getDate(),
      };
    });
  }

  // --- Cierre de disponibilidad: domingo 6:30 PM hora Colombia ---
  // (aviso 6:00, corte duro 6:30). Colombia es UTC-5 fijo (sin horario de
  // verano) → 18:30 Bogotá = 23:30 UTC. Cálculo 100% en UTC para no depender
  // de la zona horaria de la máquina. El domingo es el de la víspera del
  // lunes en que arranca la semana objetivo.
  function availabilityCutoff(weekStartISO) {
    const d = new Date(weekStartISO + 'T00:00:00Z'); // lunes 00:00 UTC
    d.setUTCDate(d.getUTCDate() - 1);                 // domingo anterior
    d.setUTCHours(23, 30, 0, 0);                      // 18:30 Bogotá
    return d;
  }
  function availabilityClosed(weekStartISO, now = Date.now()) {
    return now >= availabilityCutoff(weekStartISO).getTime();
  }
  // Ventana de aviso: entre 6:00 y 6:30 PM del domingo (últimos 30 min).
  function availabilityClosingSoon(weekStartISO, now = Date.now()) {
    const cut = availabilityCutoff(weekStartISO).getTime();
    return now >= cut - 30 * 60 * 1000 && now < cut;
  }

  function getRawState(availability, profileId, day, shift) {
    return availability?.[profileId]?.[day]?.[shift] || 'available';
  }

  function getEffectiveState(availability, profileId, day, shift) {
    const cell = availability?.[profileId]?.[day];
    if (!cell) return 'available';
    const raw = cell[shift] || 'available';
    if (raw === 'available') return 'available';
    const req = cell[`${shift}_request`];
    if (!req) return raw;                       // sin solicitud: honor directo
    if (req.state === 'rejected') return 'available';
    return raw;                                  // pending o approved: respeta lo pedido
  }

  function getState(availability, profileId, day, shift) {
    return getEffectiveState(availability, profileId, day, shift);
  }

  // --- Aleatoriedad: cada "Generar" produce un horario distinto pero VÁLIDO ---
  // La semilla incluye un `nonce` que cambia en cada clic, así cada generación
  // baraja diferente. Las reglas duras (disponibilidad, Juan Andrés/Cardona/
  // Sebas, cupos, Daniel) son filtros previos: el azar nunca las viola, solo
  // elige entre opciones ya válidas. La reproducibilidad/persistencia se logra
  // al Guardar/Publicar (ese horario queda fijo en BD; ya no se regenera).
  // Sin nonce (ej. tests), la semilla depende solo de la semana = determinista.
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Baraja Fisher-Yates con la semilla y devuelve un mapa id -> rango (desempate).
  // Orden canónico previo (por id) => el resultado depende solo de (semilla, conjunto
  // de ids), no del orden en que la BD/red devolvió los conductores. Así el horario
  // es idéntico en cualquier sesión o equipo: persistencia real de la aleatoriedad.
  function seededRankMap(items, rng) {
    const ids = items.map(x => x.id).sort();
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const m = new Map();
    ids.forEach((id, idx) => m.set(id, idx));
    return m;
  }

  // Sesgo por preferencia de jornada (shift_pref). Solo aplica si el conductor
  // dejó la celda en 'available' (si pidió descanso, no tiene sentido la pref).
  // Devuelve: -1 (prefiere ESTA jornada), +1 (prefiere la OTRA), 0 (any/sin pref).
  function shiftPrefBias(availability, profileId, day, shift) {
    const cell = availability?.[profileId]?.[day];
    if (!cell) return 0;
    if ((cell[shift] || 'available') !== 'available') return 0;
    const pref = cell.shift_pref;
    if (!pref || pref === 'any') return 0;
    return pref === shift ? -1 : 1;
  }

  function pickForShift(eligibles, workerLoads, availability, day, shift, count, rank) {
    const sorted = [...eligibles].sort((a, b) => {
      const loadA = workerLoads.get(a.id) || 0;
      const loadB = workerLoads.get(b.id) || 0;
      if (loadA !== loadB) return loadA - loadB;
      const prefA = getState(availability, a.id, day, shift) === 'prefer_rest' ? 1 : 0;
      const prefB = getState(availability, b.id, day, shift) === 'prefer_rest' ? 1 : 0;
      if (prefA !== prefB) return prefA - prefB;
      // Preferencia AM/PM del conductor: si pidió ESTA jornada, entra antes.
      const spA = shiftPrefBias(availability, a.id, day, shift);
      const spB = shiftPrefBias(availability, b.id, day, shift);
      if (spA !== spB) return spA - spB;
      // Prioridad por antigüedad (1=nuevo … 3=antiguo). Sesgo SUAVE: solo decide
      // cuando empatan en carga y en preferencia, así no rompe la equidad.
      const prioA = a.priority || 1;
      const prioB = b.priority || 1;
      if (prioA !== prioB) {
        // Ambos disponibles: el más antiguo entra primero (más trabajo).
        // Ambos pidieron Descanso: el más nuevo cubre primero (el antiguo
        // conserva su descanso "si quiere pedir muchos, los tendrá").
        return prefA === 1 ? (prioA - prioB) : (prioB - prioA);
      }
      const ra = rank ? (rank.get(a.id) ?? 0) : 0;
      const rb = rank ? (rank.get(b.id) ?? 0) : 0;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    return sorted.slice(0, count);
  }

  // Selecciona coordinadores RESPETANDO la disponibilidad pedida:
  //  - 'unavailable' (con o sin solicitud) → filtro DURO, no entra.
  //  - 'prefer_rest' → filtro BLANDO, va al fondo (solo entra si no hay otra opción).
  // Si todos los del pool pidieron unavailable y faltan cupos, el generador
  // devolverá < count y se reporta como warning (no hay con quién cubrir).
  function pickCoordinators(admins, coordLoads, count, exclude, rank, availability, day, shift) {
    const eligible = admins.filter(a => !exclude.has(a.id) && (
      !availability || getState(availability, a.id, day, shift) !== 'unavailable'
    ));
    const sorted = eligible.sort((a, b) => {
      // Quien pidió 'prefer_rest' ese día/jornada va al fondo.
      const restA = availability && getState(availability, a.id, day, shift) === 'prefer_rest' ? 1 : 0;
      const restB = availability && getState(availability, b.id, day, shift) === 'prefer_rest' ? 1 : 0;
      if (restA !== restB) return restA - restB;
      const la = coordLoads.get(a.id) || 0;
      const lb = coordLoads.get(b.id) || 0;
      if (la !== lb) return la - lb;
      const ra = rank ? (rank.get(a.id) ?? 0) : 0;
      const rb = rank ? (rank.get(b.id) ?? 0) : 0;
      if (ra !== rb) return ra - rb;
      return (a.name || '').localeCompare(b.name || '');
    });
    return sorted.slice(0, count);
  }

  function generateSchedule({ drivers, settings, availability, admins = [], flexCoordinatorId = null, weekStart = '', nonce = '' }) {
    const warnings = [];
    const workerLoads = new Map(drivers.map(d => [d.id, 0]));
    const coordLoads = new Map(admins.map(a => [a.id, 0]));
    const COORD_SLOTS = 1; // 1 coordinador AM + 1 PM por día
    const result = {};

    // Orden de desempate barajado para esta generación.
    const rng = mulberry32(hashSeed('rendio-turnos|' + (weekStart || '') + '|' + (nonce || '')));
    const driverRank = seededRankMap(drivers, rng);

    // --- Reglas fijas por conductor (hardcode por email, como Daniel) ---
    const SPECIAL = {
      JUAN_ANDRES: 'juan.mery@rendio.co',      // Juan Andres Mery Franco
      CARDONA: 'andres.cardona@rendio.co',     // Andres Felipe Cardona Arias (NO Jefferson)
      SEBAS: 'sebastian.gomez@rendio.co',      // Sebastian Gomez Ciro
    };
    const byEmail = em => drivers.find(d => (d.email || '').toLowerCase() === em) || null;
    const juanAndres = byEmail(SPECIAL.JUAN_ANDRES);
    const cardona = byEmail(SPECIAL.CARDONA);
    const sebas = byEmail(SPECIAL.SEBAS);

    // Tope duro de días trabajados por semana (cada conductor toma a lo sumo
    // 1 turno/día, así que "días" == turnos asignados).
    const dayCap = new Map();
    if (cardona) dayCap.set(cardona.id, 2);
    if (sebas) dayCap.set(sebas.id, 2);
    const daysWorked = new Map(drivers.map(d => [d.id, 0]));
    const atCap = id => dayCap.has(id) && (daysWorked.get(id) || 0) >= dayCap.get(id);
    // Para saber, dentro del pool de coordinadores, quién es conductor.
    const driverIds = new Set(drivers.map(d => d.id));

    // Turnos bloqueados duro por regla (se tratan como 'No disponible').
    function ruleBlocked(id, day, shift) {
      if (juanAndres && id === juanAndres.id) {
        if (day === 'wed') return true;                 // siempre descansa miércoles
        if (day === 'thu' && shift === 'pm') return true; // jueves descansa PM
        if (day === 'tue' && shift === 'pm') return true; // martes solo madruga (AM)
      }
      if (cardona && id === cardona.id) {
        if (day === 'fri' || day === 'sat' || day === 'sun') return true; // solo lun-jue
      }
      return false;
    }
    // Regla DURA "PM hoy ⇒ no AM mañana": un conductor que cerró el día anterior
    // a las ~2am no puede arrancar a las 2am del día siguiente. Se rastrea entre
    // iteraciones del loop (los días van en orden lun→dom).
    let prevPmIds = new Set();
    const eligibleFor = (d, day, shift) =>
      getState(availability, d.id, day, shift) !== 'unavailable' &&
      !ruleBlocked(d.id, day, shift) &&
      !atCap(d.id) &&
      !(shift === 'am' && prevPmIds.has(d.id));

    for (const day of DAYS) {
      const usedToday = new Set();

      // --- Coordinación PRIMERO (para excluir luego al conductor que coordina) ---
      // Pool = admins (is_coordinator) + conductores con can_coordinate; ambos
      // llegan en `admins`. Barajado NUEVO por día → rotan día a día y por
      // generación (el nonce mueve el rng). coordLoads equilibra el total.
      // Respeta disponibilidad: 'unavailable' bloquea duro; 'prefer_rest' suave.
      const dayAdminRank = seededRankMap(admins, rng);
      const usedCoord = new Set();
      const coordAm = pickCoordinators(admins, coordLoads, COORD_SLOTS, usedCoord, dayAdminRank, availability, day, 'am');
      coordAm.forEach(a => { usedCoord.add(a.id); coordLoads.set(a.id, (coordLoads.get(a.id) || 0) + 1); });
      // Con 2+ en el pool, el de AM no repite en PM ese día; con 1 sí cubre ambos.
      const excludePm = admins.length > 1 ? usedCoord : new Set();
      const coordPm = pickCoordinators(admins, coordLoads, COORD_SLOTS, excludePm, dayAdminRank, availability, day, 'pm');
      coordPm.forEach(a => { coordLoads.set(a.id, (coordLoads.get(a.id) || 0) + 1); });
      if (coordAm.length < COORD_SLOTS) warnings.push(`Falta coordinador AM en ${DAY_LABELS_ES[day]} (todos pidieron descanso o no disponibilidad).`);
      if (coordPm.length < COORD_SLOTS) warnings.push(`Falta coordinador PM en ${DAY_LABELS_ES[day]} (todos pidieron descanso o no disponibilidad).`);
      // Si un CONDUCTOR coordina hoy: ese día NO maneja ni descansa (como Daniel).
      const coordDriversToday = new Set(
        [...coordAm, ...coordPm].map(a => a.id).filter(id => driverIds.has(id))
      );

      const morningEligible = drivers.filter(d =>
        !coordDriversToday.has(d.id) && eligibleFor(d, day, 'am')
      );
      let morning = pickForShift(morningEligible, workerLoads, availability, day, 'am', settings.morningSlots, driverRank);
      // Regla dura Juan Andrés: martes SIEMPRE madruga (turno AM garantizado).
      if (day === 'tue' && juanAndres && !morning.some(d => d.id === juanAndres.id)) {
        morning = [juanAndres, ...morning.filter(d => d.id !== juanAndres.id)]
          .slice(0, settings.morningSlots);
      }
      morning.forEach(d => {
        usedToday.add(d.id);
        workerLoads.set(d.id, (workerLoads.get(d.id) || 0) + 1);
        daysWorked.set(d.id, (daysWorked.get(d.id) || 0) + 1);
      });
      if (morning.length < settings.morningSlots) {
        warnings.push(`Faltan ${settings.morningSlots - morning.length} cupos de Mañana en ${DAY_LABELS_ES[day]}.`);
      }

      const afternoonEligible = drivers.filter(d =>
        !usedToday.has(d.id) && !coordDriversToday.has(d.id) && eligibleFor(d, day, 'pm')
      );
      const afternoon = pickForShift(afternoonEligible, workerLoads, availability, day, 'pm', settings.afternoonSlots, driverRank);
      afternoon.forEach(d => {
        usedToday.add(d.id);
        workerLoads.set(d.id, (workerLoads.get(d.id) || 0) + 1);
        daysWorked.set(d.id, (daysWorked.get(d.id) || 0) + 1);
      });
      if (afternoon.length < settings.afternoonSlots) {
        warnings.push(`Faltan ${settings.afternoonSlots - afternoon.length} cupos de Tarde en ${DAY_LABELS_ES[day]}.`);
      }

      const rest = drivers
        .filter(d => !usedToday.has(d.id) && !coordDriversToday.has(d.id))
        .sort((a, b) => (driverRank.get(a.id) ?? 0) - (driverRank.get(b.id) ?? 0))
        .map(d => d.id);

      result[day] = {
        morning: morning.map(d => d.id),
        afternoon: afternoon.map(d => d.id),
        rest,
        coord_am: coordAm.map(a => a.id),
        coord_pm: coordPm.map(a => a.id),
      };
      // Para la regla PM→AM del día siguiente: PM de manejo + coord PM.
      prevPmIds = new Set([
        ...afternoon.map(d => d.id),
        ...coordPm.map(a => a.id).filter(id => driverIds.has(id)),
      ]);
    }

    // --- Daniel: conductor que coordina ≥1 jornada/semana; ese día NO conduce ---
    if (flexCoordinatorId && drivers.some(d => d.id === flexCoordinatorId)) {
      const alreadyCoord = DAYS.some(day =>
        (result[day].coord_am || []).includes(flexCoordinatorId) ||
        (result[day].coord_pm || []).includes(flexCoordinatorId)
      );
      if (!alreadyCoord) {
        // Preferir un día donde ya descansa (cero impacto en cobertura).
        let day = DAYS.find(d => (result[d].rest || []).includes(flexCoordinatorId));
        if (!day) {
          day = DAYS.find(d =>
            (result[d].morning || []).includes(flexCoordinatorId) ||
            (result[d].afternoon || []).includes(flexCoordinatorId)
          ) || DAYS[0];
        }

        // Conductores que coordinan ESE día (vía pool): no se les puede meter
        // a manejar ni a descansar al recalcular por el caso Daniel.
        const dayCoordDrivers = new Set(
          (result[day].coord_pm || []).filter(id => driverIds.has(id))
        );

        // Sacarlo de conducción TODO ese día.
        result[day].morning = (result[day].morning || []).filter(id => id !== flexCoordinatorId);
        result[day].afternoon = (result[day].afternoon || []).filter(id => id !== flexCoordinatorId);

        // Rellenar cupos liberados con otros conductores disponibles ese día.
        const usedDay = new Set([...result[day].morning, ...result[day].afternoon]);
        const refill = (arr, slots, shift) => {
          while (arr.length < slots) {
            const cand = drivers
              .filter(dd =>
                dd.id !== flexCoordinatorId && !usedDay.has(dd.id) &&
                !dayCoordDrivers.has(dd.id) && eligibleFor(dd, day, shift)
              )
              .sort((a, b) => (driverRank.get(a.id) ?? 0) - (driverRank.get(b.id) ?? 0))[0];
            if (!cand) {
              warnings.push(`Falta cubrir un cupo de ${shift === 'am' ? 'Mañana' : 'Tarde'} en ${DAY_LABELS_ES[day]} (Daniel coordina ese día).`);
              break;
            }
            arr.push(cand.id);
            usedDay.add(cand.id);
          }
        };
        refill(result[day].morning, settings.morningSlots, 'am');
        refill(result[day].afternoon, settings.afternoonSlots, 'pm');

        // Daniel coordina la mañana de ese día (reemplaza al admin coordinador AM).
        result[day].coord_am = [flexCoordinatorId];
        const usedFinal = new Set([...result[day].morning, ...result[day].afternoon]);
        result[day].rest = drivers
          .filter(d => d.id !== flexCoordinatorId && !usedFinal.has(d.id) && !dayCoordDrivers.has(d.id))
          .sort((a, b) => (driverRank.get(a.id) ?? 0) - (driverRank.get(b.id) ?? 0))
          .map(d => d.id);
      }
    }

    return { schedule: result, warnings, loads: Object.fromEntries(workerLoads) };
  }

  function emptySchedule() {
    const r = {};
    DAYS.forEach(d => { r[d] = { morning: [], afternoon: [], rest: [], coord_am: [], coord_pm: [] }; });
    return r;
  }

  window.Scheduler = {
    DAYS, DAY_INDEX, DAY_LABELS_ES,
    weekDates, startOfWeekISO, defaultWeekISO, addDays,
    availabilityCutoff, availabilityClosed, availabilityClosingSoon,
    generateSchedule, emptySchedule, getState, getRawState, getEffectiveState,
  };
})();
