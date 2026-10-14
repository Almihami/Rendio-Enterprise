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

  // El MES al que pertenece una fecha, como el día 1 en ISO.
  // Mismo patrón que startOfWeekISO: se hace la cuenta en hora local y solo al
  // final se pasa a ISO. Ojo, esto NO es cosmético: `new Date().toISOString()`
  // a secas devuelve la fecha en UTC, y Bogotá va en -5. El 30 de septiembre a
  // las 8 p.m. eso daría "2026-10-01" y el contador de strikes se reiniciaría
  // cinco horas antes de tiempo, todos los meses.
  function monthStartISO(date) {
    const d = new Date(typeof date === 'string' ? date + 'T00:00:00' : (date || new Date()));
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  }

  const MONTH_LABELS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  // "septiembre" / "septiembre de 2025". El año solo se dice cuando NO es el
  // año en curso: en el historial de strikes, repetir "de 2026" en cada línea
  // es ruido, pero omitirlo en uno de hace año y medio es engañar.
  function monthLabelES(iso, conAnio) {
    const d = new Date(iso + 'T00:00:00');
    const mes = MONTH_LABELS_ES[d.getMonth()];
    const distinto = d.getFullYear() !== new Date().getFullYear();
    return (conAnio || distinto) ? mes + ' de ' + d.getFullYear() : mes;
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

  // --- Cierre de disponibilidad: sábado 4:00 PM hora Colombia ---
  // (aviso los últimos 30 min). Colombia es UTC-5 fijo (sin horario de
  // verano) → 16:00 Bogotá = 21:00 UTC. Cálculo 100% en UTC para no depender
  // de la zona horaria de la máquina. El sábado es el de dos días antes del
  // lunes en que arranca la semana objetivo.
  // Hasta el 19-sep-2026 el corte era el domingo 2:00 PM. El jefe lo movió al
  // sábado ese mismo sábado, así que la semana del 21-sep cerró a las 7:00 PM
  // para darles tiempo a los conductores. Las semanas anteriores conservan su
  // regla (domingo 2:00 PM): el candado da igual, pero el admin que regenera
  // una semana vieja lee «fuera por no llenar antes del…» con la hora real.
  const SATURDAY_RULE_FROM = '2026-09-21';
  const CUTOFF_EXCEPTIONS = {
    '2026-09-21': '2026-09-20T00:00:00Z', // sábado 19-sep 7:00 PM Bogotá
  };
  function availabilityCutoff(weekStartISO) {
    if (CUTOFF_EXCEPTIONS[weekStartISO]) return new Date(CUTOFF_EXCEPTIONS[weekStartISO]);
    const d = new Date(weekStartISO + 'T00:00:00Z'); // lunes 00:00 UTC
    if (weekStartISO < SATURDAY_RULE_FROM) {
      d.setUTCDate(d.getUTCDate() - 1);               // domingo anterior
      d.setUTCHours(19, 0, 0, 0);                     // 14:00 Bogotá (2:00 PM)
      return d;
    }
    d.setUTCDate(d.getUTCDate() - 2);                 // sábado anterior
    d.setUTCHours(21, 0, 0, 0);                       // 16:00 Bogotá (4:00 PM)
    return d;
  }

  // Un límite dicho en palabras, para que ningún texto repita la hora a mano:
  // la hora del corte vive SOLO en availabilityCutoff (y la de la reapertura, en
  // app_settings.reopen_until).
  //   at     el instante en ms
  //   day    'sábado'      date  26
  //   time   '4:00 p.m.'   (ya termina en punto: no ponerle otro)
  //   closed true si ya pasó
  //   today  true si es hoy (fecha Bogotá) y todavía no pasó
  //   when   'hoy' | 'el sábado 26' → «Cierra hoy a las…» / «Cierra el sábado 26 a las…»
  //          (con fecha: el sábado en la noche, «el sábado» a secas es ambiguo)
  const WEEKDAY_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const BOGOTA_MS = -5 * 3600000;
  function deadlineLabel(instant, now = Date.now()) {
    const at = +instant;
    now = +now; // acepta Date o número, como availabilityClosed
    const b = new Date(at + BOGOTA_MS);
    const h = b.getUTCHours();
    const day = WEEKDAY_ES[b.getUTCDay()];
    const date = b.getUTCDate();
    const time = `${h % 12 || 12}:${String(b.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
    const closed = now >= at;
    const sameDay = new Date(now + BOGOTA_MS).toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
    const today = sameDay && !closed;
    return { at, day, date, time, closed, today, when: today ? 'hoy' : `el ${day} ${date}` };
  }
  function availabilityCutoffLabel(weekStartISO, now = Date.now()) {
    return deadlineLabel(availabilityCutoff(weekStartISO), now);
  }
  function availabilityClosed(weekStartISO, now = Date.now()) {
    return now >= availabilityCutoff(weekStartISO).getTime();
  }
  // Ventana de aviso: los últimos 30 min antes del corte (sábado 3:30–4:00 PM).
  function availabilityClosingSoon(weekStartISO, now = Date.now()) {
    const cut = availabilityCutoff(weekStartISO).getTime();
    return now >= cut - 30 * 60 * 1000 && now < cut;
  }

  // --- Reglas fijas por conductor (parametrizadas por el admin desde Ajustes) ---
  // El admin configura los descansos fijos por conductor (tabla driver_rules,
  // editor "Descansos fijos" en Ajustes). Un turno bloqueado se trata como 'No
  // disponible' en el generador y se muestra como 🔒 en la consolidada admin y en
  // la vista del conductor. NO hay reglas hardcodeadas: la ÚNICA fuente es lo que
  // el admin parametriza. Mapa cargado desde la BD: { profileId: Set('day-shift') }.
  let DYNAMIC_RULES = null;
  function setRules(rulesByProfileId) {
    DYNAMIC_RULES = rulesByProfileId || null;
  }

  // API pública: recibe el objeto driver ({ id, ... }). Sin reglas cargadas → false.
  function ruleBlocked(driverOrEmail, day, shift) {
    if (!driverOrEmail || !DYNAMIC_RULES) return false;
    const id = typeof driverOrEmail === 'string' ? null : driverOrEmail.id;
    if (!id) return false;
    return DYNAMIC_RULES[id] ? DYNAMIC_RULES[id].has(`${day}-${shift}`) : false;
  }

  // OJO — cambio de fondo del 2026-08-16 (rediseño de Disponibilidad, Modelo A):
  // la ausencia de dato ya NO significa 'available'. Significa 'unset' (Sin marcar),
  // y una jornada sin marcar no entra a la generación. Antes, el conductor que no
  // abría la app quedaba disponible por omisión y se le programaba igual.
  function getRawState(availability, profileId, day, shift) {
    return availability?.[profileId]?.[day]?.[shift] || 'unset';
  }

  function getEffectiveState(availability, profileId, day, shift) {
    const cell = availability?.[profileId]?.[day];
    if (!cell) return 'unset';
    const raw = cell[shift] || 'unset';
    if (raw === 'available') return 'available';
    // 'unset' se honra tal cual: no es una petición, es la falta de respuesta.
    // (Si no se corta acá, una solicitud vieja ya rechazada sobre una jornada que
    // el conductor después desmarcó la volvería 'available' por la puerta de atrás.)
    if (raw === 'unset') return 'unset';
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
    if ((cell[shift] || 'unset') !== 'available') return 0;
    const pref = cell.shift_pref;
    // 'both' es «Puedo doblar» (27-sep-2026): no dice qué jornada prefiere, y
    // leerlo como «prefiere la otra» lo mandaba al final de las dos.
    if (!pref || pref === 'any' || pref === 'both') return 0;
    return pref === shift ? -1 : 1;
  }

  function pickForShift(eligibles, workerLoads, availability, day, shift, count, rank) {
    const sorted = [...eligibles].sort((a, b) => {
      const loadA = workerLoads.get(a.id) || 0;
      const loadB = workerLoads.get(b.id) || 0;
      const prefA = getState(availability, a.id, day, shift) === 'prefer_rest' ? 1 : 0;
      const prefB = getState(availability, b.id, day, shift) === 'prefer_rest' ? 1 : 0;
      // Antigüedad 4 (DURA): entre quienes NO pidieron descanso, el conductor de
      // máxima prioridad (Julián) entra SIEMPRE primero, por encima de la carga.
      const topA = (a.priority || 1) >= 4 && prefA === 0 ? 1 : 0;
      const topB = (b.priority || 1) >= 4 && prefB === 0 ? 1 : 0;
      if (topA !== topB) return topB - topA;
      if (loadA !== loadB) return loadA - loadB;
      if (prefA !== prefB) return prefA - prefB;
      // Prioridad por antigüedad 1–3 (desempate SUAVE).
      const prioA = a.priority || 1;
      const prioB = b.priority || 1;
      if (prioA !== prioB) {
        // Ambos disponibles: el más antiguo entra primero (más trabajo).
        // Ambos pidieron Descanso: el más nuevo cubre primero (el antiguo
        // conserva su descanso "si quiere pedir muchos, los tendrá").
        return prefA === 1 ? (prioA - prioB) : (prioB - prioA);
      }
      // Preferencia AM/PM: sesgo SUAVE.
      const spA = shiftPrefBias(availability, a.id, day, shift);
      const spB = shiftPrefBias(availability, b.id, day, shift);
      if (spA !== spB) return spA - spB;
      const ra = rank ? (rank.get(a.id) ?? 0) : 0;
      const rb = rank ? (rank.get(b.id) ?? 0) : 0;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    return sorted.slice(0, count);
  }

  function generateSchedule({ drivers, settings, availability, admins = [], flexCoordinatorId = null, weekStart = '', nonce = '', seedPmIds = [], doubles = [], restSlots = 2 }) {
    const warnings = [];
    // Dobles que el jefe ya marcó (D1: el generador nunca dobla por su cuenta,
    // pero si se regenera con dobles marcadas, las respeta): esas dos jornadas
    // quedan fijas y las del descanso posterior (y la anterior), bloqueadas.
    const fixedKeys = new Set(), blockedKeys = new Set();
    const keepDoubles = doubles.filter(x => drivers.some(d => d.id === x.id) && doubleStartSlot(x) >= 0 && doubleStartSlot(x) + 1 < DAYS.length * 2);
    keepDoubles.forEach(x => {
      const k = doubleStartSlot(x);
      fixedKeys.add(x.id + '|' + k); fixedKeys.add(x.id + '|' + (k + 1));
      blockedKeys.add(x.id + '|' + (k - 1));
      for (let j = 2; j < 2 + restSlots; j++) blockedKeys.add(x.id + '|' + (k + j));
    });
    const fixedFor = (day, shift) => drivers.filter(d => fixedKeys.has(d.id + '|' + slotOf(day, shift)));
    const isBlocked = (id, day, shift) => blockedKeys.has(id + '|' + slotOf(day, shift));
    const workerLoads = new Map(drivers.map(d => [d.id, 0]));
    // Carga de LIDERAZGO por conductor (cuántas jornadas ha liderado esta semana),
    // para que el rol de líder rote y nadie quede liderando toda la semana.
    const leaderLoads = new Map(drivers.map(d => [d.id, 0]));
    const COORD_SLOTS = settings.coordSlots || 1; // nº de líderes por jornada (parametrizable; default 1)
    const result = {};

    // Orden de desempate barajado para esta generación.
    const rng = mulberry32(hashSeed('rendio-turnos|' + (weekStart || '') + '|' + (nonce || '')));
    const driverRank = seededRankMap(drivers, rng);

    // Regla DURA "PM hoy ⇒ no AM mañana": un conductor que cerró el día anterior
    // a las ~2am no puede arrancar a las 2am del día siguiente. Se rastrea entre
    // iteraciones del loop (los días van en orden lun→dom). `seedPmIds` arrastra
    // el domingo PM de la semana ANTERIOR para que no madruguen el lunes (bug fix).
    let prevPmIds = new Set(seedPmIds || []);
    // 'unset' pesa igual que 'unavailable': quien no marcó no entra. Es el cambio
    // que introduce el rediseño 2026-08-16; ver nota en getRawState().
    const eligibleFor = (d, day, shift) => {
      const st = getState(availability, d.id, day, shift);
      return st !== 'unavailable' && st !== 'unset' &&
        !ruleBlocked(d, day, shift) &&
        !isBlocked(d.id, day, shift) &&
        !fixedKeys.has(d.id + '|' + slotOf(day, shift === 'am' ? 'pm' : 'am')) &&
        !(shift === 'am' && prevPmIds.has(d.id));
    };

    // ------- LIDERAZGO: el líder es UNO de los conductores de la jornada -------
    // El líder NO es un cupo aparte: es uno de los conductores en turno que puede
    // liderar (can_coordinate) y que además conduce esa jornada. Nunca alguien
    // "lidera 24h": el líder AM sale de la mañana y el líder PM de la tarde, que
    // son personas distintas (nadie hace doble turno). leaderLoads hace que rote.
    const hasLeader = (set) => set.some(d => d.can_coordinate);
    const leaderCmp = (a, b) => {
      const la = leaderLoads.get(a.id) || 0, lb = leaderLoads.get(b.id) || 0;
      if (la !== lb) return la - lb;                       // el que menos ha liderado, primero
      const wa = workerLoads.get(a.id) || 0, wb = workerLoads.get(b.id) || 0;
      if (wa !== wb) return wa - wb;
      return (driverRank.get(a.id) ?? 0) - (driverRank.get(b.id) ?? 0);
    };
    // Asegura que en la jornada haya ≥1 conductor que pueda liderar. Si no cayó
    // ninguno: mete al mejor líder disponible (si hay cupo libre lo agrega; si no,
    // cambia al conductor menos crítico, sin sacar nunca a la prioridad 4 dura).
    function ensureLeaderCapable(set, day, shift, usedToday, slots) {
      if (hasLeader(set)) return set;
      const fijo = (d) => fixedKeys.has(d.id + '|' + slotOf(day, shift));
      const inSet = new Set(set.map(d => d.id));
      const cand = drivers
        .filter(d => d.can_coordinate && !usedToday.has(d.id) && !inSet.has(d.id) && eligibleFor(d, day, shift))
        .sort(leaderCmp)[0];
      if (!cand) return set;                                // no hay líder disponible → warning aparte
      if (set.length < slots) return [...set, cand];        // hay cupo libre: agrégalo
      const removable = set
        .filter(d => (d.priority || 1) < 4 && !fijo(d))     // nunca se saca a la prioridad 4 dura ni a una doble
        .sort((a, b) => {
          const wa = workerLoads.get(a.id) || 0, wb = workerLoads.get(b.id) || 0;
          if (wa !== wb) return wb - wa;                    // el de mayor carga sale primero
          return (driverRank.get(b.id) ?? 0) - (driverRank.get(a.id) ?? 0);
        })[0];
      if (!removable) return set;                           // todos son prioridad dura: no se cambia
      return [...set.filter(d => d.id !== removable.id), cand];
    }
    // Designa hasta COORD_SLOTS líderes ENTRE los conductores de la jornada.
    function pickLeaders(set) {
      const chosen = set.filter(d => d.can_coordinate).sort(leaderCmp).slice(0, COORD_SLOTS);
      chosen.forEach(d => leaderLoads.set(d.id, (leaderLoads.get(d.id) || 0) + 1));
      return chosen;
    }

    for (const day of DAYS) {
      const usedToday = new Set();

      // --- MAÑANA: elige conductores y asegura que uno de ellos pueda liderar ---
      const fixAm = fixedFor(day, 'am');
      let morning = [...fixAm, ...pickForShift(
        drivers.filter(d => !fixAm.includes(d) && eligibleFor(d, day, 'am')),
        workerLoads, availability, day, 'am', Math.max(0, settings.morningSlots - fixAm.length), driverRank
      )];
      morning = ensureLeaderCapable(morning, day, 'am', usedToday, settings.morningSlots);
      morning.forEach(d => { usedToday.add(d.id); workerLoads.set(d.id, (workerLoads.get(d.id) || 0) + 1); });
      if (morning.length < settings.morningSlots) {
        warnings.push(`Faltan ${settings.morningSlots - morning.length} cupos de Mañana en ${DAY_LABELS_ES[day]}.`);
      }
      const coordAm = pickLeaders(morning); // líder(es) elegidos ENTRE los de la mañana
      if (!coordAm.length) warnings.push(`Falta líder en la Mañana de ${DAY_LABELS_ES[day]} (ningún conductor de la jornada puede liderar; marca a más como "Líder de turno").`);

      // --- TARDE ---
      const fixPm = fixedFor(day, 'pm');
      let afternoon = [...fixPm, ...pickForShift(
        drivers.filter(d => !fixPm.includes(d) && !usedToday.has(d.id) && eligibleFor(d, day, 'pm')),
        workerLoads, availability, day, 'pm', Math.max(0, settings.afternoonSlots - fixPm.length), driverRank
      )];
      afternoon = ensureLeaderCapable(afternoon, day, 'pm', usedToday, settings.afternoonSlots);
      afternoon.forEach(d => { usedToday.add(d.id); workerLoads.set(d.id, (workerLoads.get(d.id) || 0) + 1); });
      if (afternoon.length < settings.afternoonSlots) {
        warnings.push(`Faltan ${settings.afternoonSlots - afternoon.length} cupos de Tarde en ${DAY_LABELS_ES[day]}.`);
      }
      const coordPm = pickLeaders(afternoon); // líder(es) elegidos ENTRE los de la tarde
      if (!coordPm.length) warnings.push(`Falta líder en la Tarde de ${DAY_LABELS_ES[day]} (ningún conductor de la jornada puede liderar; marca a más como "Líder de turno").`);

      const rest = drivers
        .filter(d => !usedToday.has(d.id))
        .sort((a, b) => (driverRank.get(a.id) ?? 0) - (driverRank.get(b.id) ?? 0))
        .map(d => d.id);

      result[day] = {
        morning: morning.map(d => d.id),
        afternoon: afternoon.map(d => d.id),
        rest,
        coord_am: coordAm.map(d => d.id), // ⊆ morning
        coord_pm: coordPm.map(d => d.id), // ⊆ afternoon
      };
      // Para la regla PM→AM del día siguiente: los de la tarde (el líder PM ya va incluido).
      prevPmIds = new Set(afternoon.map(d => d.id));
    }

    if (keepDoubles.length) result._doubles = keepDoubles.map(x => ({ ...x }));
    return { schedule: result, warnings, loads: Object.fromEntries(workerLoads) };
  }

  // ===================== Doble turno (27-sep-2026) =====================
  // Una doble son dos jornadas SEGUIDAS del mismo conductor que el jefe autoriza
  // con un motivo (D1). Viven en data._doubles = [{ day, id, tipo, nota }]:
  //   tipo 'dia'   → mañana + tarde de `day`
  //   tipo 'noche' → tarde de `day` + madrugada del día siguiente (misma semana)
  // Cada jornada es un "slot" de ~12 h: k = índiceDía*2 (+1 si es la tarde). Dos
  // slots seguidos son 24 h, el máximo (D3), y después van restSlots de descanso.
  function slotOf(day, shift) { const i = DAYS.indexOf(day); return i < 0 ? -99 : i * 2 + (shift === 'pm' ? 1 : 0); }
  function slotDay(k) { return DAYS[Math.floor(k / 2)]; }
  function slotShift(k) { return k % 2 ? 'pm' : 'am'; }
  function doublesOf(data) { return (data && Array.isArray(data._doubles)) ? data._doubles : []; }
  function doubleStartSlot(x) { return slotOf(x.day, x.tipo === 'noche' ? 'pm' : 'am'); }
  function workedSlots(data, id) {
    const out = new Set();
    DAYS.forEach(day => {
      const d = (data && data[day]) || {};
      if ((d.morning || []).includes(id)) out.add(slotOf(day, 'am'));
      if ((d.afternoon || []).includes(id)) out.add(slotOf(day, 'pm'));
    });
    return out;
  }
  // Cuántas jornadas de descanso van después de una doble (D3: 24 h).
  function restSlotsFor(settings) {
    const rest = Number(settings && settings.double_rest_hours) || 24;
    // Una jornada es media día (AM/PM) aunque shift_hours diga otra cosa.
    return Math.max(0, Math.ceil(rest / 12));
  }
  // La doble de `id` que cubre ese día/jornada, o null.
  function doubleAt(data, id, day, shift) {
    const k = slotOf(day, shift);
    const w = workedSlots(data, id);
    return doublesOf(data).find(x => x.id === id && (doubleStartSlot(x) === k || doubleStartSlot(x) + 1 === k)
      && w.has(doubleStartSlot(x)) && w.has(doubleStartSlot(x) + 1)) || null;
  }
  // Problemas de `id` por jornada: Map(slot -> código)
  //   'triple'  más de 24 h seguidas
  //   'double'  mañana + tarde del mismo día sin autorizar
  //   'pmam'    tarde + madrugada del día siguiente sin autorizar
  //   'rest'    trabaja dentro del descanso obligatorio después de una doble
  function doubleIssues(data, id, restSlots = 2) {
    const w = workedSlots(data, id);
    const out = new Map();
    const put = (k, code) => { if (!out.has(k)) out.set(k, code); };
    const auth = new Set(doublesOf(data).filter(x => x.id === id).map(doubleStartSlot));
    w.forEach(k => { if (w.has(k + 1) && w.has(k + 2)) { put(k, 'triple'); put(k + 1, 'triple'); put(k + 2, 'triple'); } });
    w.forEach(k => {
      if (!w.has(k + 1) || auth.has(k)) return;
      const code = k % 2 === 0 ? 'double' : 'pmam';
      put(k, code); put(k + 1, code);
    });
    auth.forEach(k => {
      if (!(w.has(k) && w.has(k + 1))) return;   // doble a medias: no aplica
      for (let j = 2; j < 2 + restSlots; j++) if (w.has(k + j)) put(k + j, 'rest');
    });
    return out;
  }
  // Quita las dobles que ya no existen (el jefe sacó al conductor de una de las
  // dos jornadas): la marca no puede quedar colgando de un turno que no está.
  function cleanDoubles(data) {
    if (!data || !Array.isArray(data._doubles)) return;
    data._doubles = data._doubles.filter(x => {
      const w = workedSlots(data, x.id), k = doubleStartSlot(x);
      return k >= 0 && w.has(k) && w.has(k + 1);
    });
  }

  // ===================== Swaps entre conductores (Fase 3) =====================
  const SLOT_OF = { am: 'morning', pm: 'afternoon' };

  function replaceInArr(arr, from, to) {
    return (arr || []).map(x => (x === from ? to : x));
  }

  // Aplica swaps 'accepted' como OVERLAY sobre el horario base (no muta el
  // original; devuelve una copia). Cada swap intercambia el turno de A (from)
  // con el de B (to). Si el horario cambió y ya no calzan, ese swap se ignora.
  function applySwaps(data, swaps) {
    if (!data || !swaps || !swaps.length) return data;
    const out = JSON.parse(JSON.stringify(data));
    swaps.forEach(s => {
      const fromKey = DAYS[s.from_day], toKey = DAYS[s.to_day];
      const fromSlot = SLOT_OF[s.from_shift], toSlot = SLOT_OF[s.to_shift];
      if (!out[fromKey] || !out[toKey]) return;
      const aInFrom = (out[fromKey][fromSlot] || []).includes(s.requester_id);
      const bInTo = (out[toKey][toSlot] || []).includes(s.target_id);
      if (!aInFrom || !bInTo) return; // swap obsoleto
      out[fromKey][fromSlot] = replaceInArr(out[fromKey][fromSlot], s.requester_id, s.target_id);
      out[toKey][toSlot] = replaceInArr(out[toKey][toSlot], s.target_id, s.requester_id);
    });
    return out;
  }

  // Valida un swap propuesto sobre el horario PUBLICADO base.
  // driversById: { id: { email, name } }. Devuelve { ok, reason }.
  function validateSwap(data, swap, driversById = {}, restSlots = 2) {
    const fromKey = DAYS[swap.from_day], toKey = DAYS[swap.to_day];
    const a = swap.requester_id, b = swap.target_id;
    const fromSlot = SLOT_OF[swap.from_shift], toSlot = SLOT_OF[swap.to_shift];
    const aName = driversById[a]?.name || 'Solicitante';
    const bName = driversById[b]?.name || 'Compañero';

    // 1. Ambos deben tener hoy el turno que ofrecen.
    if (!(data?.[fromKey]?.[fromSlot] || []).includes(a))
      return { ok: false, reason: `${aName} ya no tiene ese turno en el horario.` };
    if (!(data?.[toKey]?.[toSlot] || []).includes(b))
      return { ok: false, reason: `${bName} ya no tiene ese turno en el horario.` };

    // 2. Reglas fijas: el turno que cada uno RECIBE no puede estar bloqueado.
    if (ruleBlocked(driversById[a], toKey, swap.to_shift))
      return { ok: false, reason: `${aName} tiene descanso fijo (parametrización) en ${DAY_LABELS_ES[toKey]} ${swap.to_shift.toUpperCase()}.` };
    if (ruleBlocked(driversById[b], fromKey, swap.from_shift))
      return { ok: false, reason: `${bName} tiene descanso fijo (parametrización) en ${DAY_LABELS_ES[fromKey]} ${swap.from_shift.toUpperCase()}.` };

    // 3. Construir el resultado y validar por persona. Desde el 27-sep-2026 una
    //    doble AUTORIZADA por el jefe no es error; sí lo son las no autorizadas,
    //    más de 24 h seguidas y trabajar en el descanso posterior a una doble.
    const res = JSON.parse(JSON.stringify(data));
    const out = (id, day, slot) => { if (res[day]) res[day][slot] = (res[day][slot] || []).map(x => (x === id ? null : x)); };
    const inn = (id, day, slot) => { res[day] = res[day] || {}; res[day][slot] = [...(res[day][slot] || []), id]; };
    out(a, fromKey, fromSlot); out(b, toKey, toSlot);
    inn(a, toKey, toSlot); inn(b, fromKey, fromSlot);
    const MSG = {
      triple: (l) => `${l} quedaría con más de 24 horas seguidas.`,
      double: (l, k) => `${l} quedaría con Mañana y Tarde el mismo día (${DAY_LABELS_ES[slotDay(k)]}) sin una doble autorizada.`,
      pmam: (l, k) => `${l} cerraría ${DAY_LABELS_ES[slotDay(k)]} PM y madrugaría ${DAY_LABELS_ES[slotDay(k + 1)] || 'al día siguiente'} AM (no permitido sin una doble autorizada).`,
      rest: (l, k) => `${l} trabajaría ${DAY_LABELS_ES[slotDay(k)]} ${slotShift(k).toUpperCase()}, dentro del descanso obligatorio después de su doble.`,
    };
    for (const [id, label] of [[a, aName], [b, bName]]) {
      const iss = doubleIssues(res, id, restSlots);
      const first = [...iss.entries()].sort((x, y) => x[0] - y[0])[0];
      if (first) return { ok: false, reason: MSG[first[1]](label, first[0]) };
    }
    return { ok: true, reason: '' };
  }

  function emptySchedule() {
    const r = {};
    DAYS.forEach(d => { r[d] = { morning: [], afternoon: [], rest: [], coord_am: [], coord_pm: [] }; });
    return r;
  }

  window.Scheduler = {
    DAYS, DAY_INDEX, DAY_LABELS_ES,
    weekDates, startOfWeekISO, defaultWeekISO, addDays,
    monthStartISO, monthLabelES,
    availabilityCutoff, availabilityCutoffLabel, deadlineLabel, availabilityClosed, availabilityClosingSoon,
    generateSchedule, emptySchedule, getState, getRawState, getEffectiveState,
    ruleBlocked, setRules, applySwaps, validateSwap,
    slotOf, doublesOf, doubleAt, doubleIssues, cleanDoubles, restSlotsFor, workedSlots,
  };
})();
