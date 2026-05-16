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

  function getRawState(availability, profileId, day, shift) {
    return availability?.[profileId]?.[day]?.[shift] || 'available';
  }

  function getEffectiveState(availability, profileId, day, shift) {
    const cell = availability?.[profileId]?.[day];
    if (!cell) return 'available';
    const raw = cell[shift] || 'available';
    if (raw === 'available') return 'available';
    const req = cell[`${shift}_request`];
    if (!req) return raw; // weekday prefer_rest sin conflicto: honor directo
    if (req.state === 'approved') return raw;
    return 'available'; // pending o rejected: el generador no lo respeta todavía
  }

  function getState(availability, profileId, day, shift) {
    return getEffectiveState(availability, profileId, day, shift);
  }

  function pickForShift(eligibles, workerLoads, availability, day, shift, count) {
    const sorted = [...eligibles].sort((a, b) => {
      const loadA = workerLoads.get(a.id) || 0;
      const loadB = workerLoads.get(b.id) || 0;
      if (loadA !== loadB) return loadA - loadB;
      const prefA = getState(availability, a.id, day, shift) === 'prefer_rest' ? 1 : 0;
      const prefB = getState(availability, b.id, day, shift) === 'prefer_rest' ? 1 : 0;
      if (prefA !== prefB) return prefA - prefB;
      return a.name.localeCompare(b.name);
    });
    return sorted.slice(0, count);
  }

  function pickCoordinators(admins, coordLoads, count, exclude) {
    const sorted = admins
      .filter(a => !exclude.has(a.id))
      .sort((a, b) => {
        const la = coordLoads.get(a.id) || 0;
        const lb = coordLoads.get(b.id) || 0;
        if (la !== lb) return la - lb;
        return (a.name || '').localeCompare(b.name || '');
      });
    return sorted.slice(0, count);
  }

  function generateSchedule({ drivers, settings, availability, admins = [], flexCoordinatorId = null }) {
    const warnings = [];
    const workerLoads = new Map(drivers.map(d => [d.id, 0]));
    const coordLoads = new Map(admins.map(a => [a.id, 0]));
    const COORD_SLOTS = 1; // 1 coordinador AM + 1 PM por día
    const result = {};

    for (const day of DAYS) {
      const usedToday = new Set();

      const morningEligible = drivers.filter(d =>
        getState(availability, d.id, day, 'am') !== 'unavailable'
      );
      const morning = pickForShift(morningEligible, workerLoads, availability, day, 'am', settings.morningSlots);
      morning.forEach(d => {
        usedToday.add(d.id);
        workerLoads.set(d.id, (workerLoads.get(d.id) || 0) + 1);
      });
      if (morning.length < settings.morningSlots) {
        warnings.push(`Faltan ${settings.morningSlots - morning.length} cupos de Mañana en ${DAY_LABELS_ES[day]}.`);
      }

      const afternoonEligible = drivers.filter(d =>
        !usedToday.has(d.id) &&
        getState(availability, d.id, day, 'pm') !== 'unavailable'
      );
      const afternoon = pickForShift(afternoonEligible, workerLoads, availability, day, 'pm', settings.afternoonSlots);
      afternoon.forEach(d => {
        usedToday.add(d.id);
        workerLoads.set(d.id, (workerLoads.get(d.id) || 0) + 1);
      });
      if (afternoon.length < settings.afternoonSlots) {
        warnings.push(`Faltan ${settings.afternoonSlots - afternoon.length} cupos de Tarde en ${DAY_LABELS_ES[day]}.`);
      }

      const rest = drivers.filter(d => !usedToday.has(d.id)).map(d => d.id);

      // Coordinación (admins): 1 en AM, 1 en PM, balanceado entre admins.
      const usedCoord = new Set();
      const coordAm = pickCoordinators(admins, coordLoads, COORD_SLOTS, usedCoord);
      coordAm.forEach(a => { usedCoord.add(a.id); coordLoads.set(a.id, (coordLoads.get(a.id) || 0) + 1); });
      // Si hay 2+ admins, el de AM no repite en PM ese día; con 1 admin sí cubre ambos.
      const excludePm = admins.length > 1 ? usedCoord : new Set();
      const coordPm = pickCoordinators(admins, coordLoads, COORD_SLOTS, excludePm);
      coordPm.forEach(a => { coordLoads.set(a.id, (coordLoads.get(a.id) || 0) + 1); });

      result[day] = {
        morning: morning.map(d => d.id),
        afternoon: afternoon.map(d => d.id),
        rest,
        coord_am: coordAm.map(a => a.id),
        coord_pm: coordPm.map(a => a.id),
      };
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

        // Sacarlo de conducción TODO ese día.
        result[day].morning = (result[day].morning || []).filter(id => id !== flexCoordinatorId);
        result[day].afternoon = (result[day].afternoon || []).filter(id => id !== flexCoordinatorId);

        // Rellenar cupos liberados con otros conductores disponibles ese día.
        const usedDay = new Set([...result[day].morning, ...result[day].afternoon]);
        const refill = (arr, slots, shift) => {
          while (arr.length < slots) {
            const cand = drivers.find(dd =>
              dd.id !== flexCoordinatorId && !usedDay.has(dd.id) &&
              getState(availability, dd.id, day, shift) !== 'unavailable'
            );
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
          .filter(d => d.id !== flexCoordinatorId && !usedFinal.has(d.id))
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
    weekDates, startOfWeekISO, addDays,
    generateSchedule, emptySchedule, getState, getRawState, getEffectiveState,
  };
})();
