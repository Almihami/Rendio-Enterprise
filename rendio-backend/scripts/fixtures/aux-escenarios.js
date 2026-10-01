// fixtures/aux-escenarios.js — escenarios del rol auxiliar para pruebas y
// capturas (rediseño del 27-sep-2026, paquete P9, plan final §7.2).
//
// SOLO VIVE EN scripts/ Y EN javascript_tool. Nunca se registra en index.html
// ni en el service worker: son datos de mentira para ver pantallas, no para
// mostrarle a nadie.
//
//   AuxEscenarios.list()                    → nombres
//   AuxEscenarios.info(nombre)              → una línea de qué muestra
//   AuxEscenarios.datos(nombre)             → copia fresca de los datos (sin montar)
//   AuxEscenarios.montar(nombre, {noche, abrir})
//        Escribe Auxiliar.state (perfil, viajes, fuente) y Auxiliar.header,
//        state.settings, y REEMPLAZA en memoria las lecturas de Api / ApiAux
//        (listMyReservations, trackReservation, listMyTrips, getMyStats,
//        crew*, getOpsContact…) para que devuelvan el escenario. Las escrituras
//        (createReservation, cancelMyReservation, crewSend, changeFlight…) no
//        salen a la red: quedan anotadas en AuxEscenarios.llamadas.
//        Pagos y Puntos quedan EN BLANCO en todos (AuxPagos.summary() → null,
//        AuxPuntos.enabled() → false, y cada función de ApiCobro / ApiPuntos →
//        null), salvo el escenario puntos-en-blanco.
//        noche:true → nocturno; noche:false → 'auto'; sin noche → no lo toca.
//        abrir:true → abre el viaje principal del escenario (Auxiliar.openTrip).
//   AuxEscenarios.restaurar()               → devuelve Api/ApiAux/… a lo original
//   AuxEscenarios.llamadas                  → [{fn, args}] de las escrituras
//
// En jsdom: window.eval(readFileSync('scripts/fixtures/aux-escenarios.js')) DESPUÉS
// de cargar auxiliar.js. En el navegador: pegarlo entero en javascript_tool.
//
// Los datos imitan la forma real (T = ApiAux.mapTrip, I = auxiliar_track_reservation
// v5, H = Api.getMyAuxHeader). Nombres, placas y vuelos son inventados y NO son
// los del diseño («Carlos Mejía», «AV9525», «Juliana» están prohibidos en la UI;
// si aparecieran en una pantalla, vendrían del código, no de aquí).
(function (g) {
  'use strict';

  // ── Fechas en hora de Bogotá, relativas a AHORA ──────────────────────────
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  function bog(ms) {
    const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  const iso = (date, time) => new Date(`${date}T${time}:00-05:00`).toISOString();
  const dia = (n) => bog(Date.now() + n * 86400e3).date;            // n días desde hoy (Bogotá)
  const enMin = (m) => bog(Date.now() + m * 60e3);                  // {date,time} dentro de m minutos
  const haceMin = (m) => new Date(Date.now() - m * 60e3).toISOString();
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

  // ── Catálogo y personas de mentira ───────────────────────────────────────
  const RES = {
    olivar: { id: 'esc-res-olivar', name: 'El Olivar', sector: 'Rionegro', access_note: '', latitude: 6.1523, longitude: -75.3781 },
    llano: { id: 'esc-res-llano', name: 'Quintas de Llanogrande', sector: 'Llanogrande', access_note: '', latitude: 6.1175, longitude: -75.4152 },
    cerezos: { id: 'esc-res-cerezos', name: 'Los Cerezos', sector: 'Rionegro', access_note: '', latitude: 6.1402, longitude: -75.3860 },
  };
  const AEROLINEAS = [
    { id: 'esc-air-av', name: 'Avianca', iata_code: 'AV', sort_order: 1, is_active: true },
    { id: 'esc-air-ja', name: 'JetSMART', iata_code: 'JA', sort_order: 2, is_active: true },
    { id: 'esc-air-la', name: 'LATAM', iata_code: 'LA', sort_order: 3, is_active: true },
    { id: 'esc-air-p5', name: 'Wingo', iata_code: 'P5', sort_order: 4, is_active: true },
  ];
  const PERFIL = {
    id: 'esc-perfil-laura', full_name: 'Laura Gómez Ruiz', email: 'laura.escenario@prueba.local',
    phone: '3001234567', role: 'auxiliar', organization_id: 'esc-org', is_active: true,
    deleted_at: null, must_change_password: false, suspended_reason: null,
  };
  const HEADER = {
    auxProfileId: 'esc-ap-laura', joinedAt: '2026-03-02', airlineName: 'Avianca', airlineIata: 'AV',
    preferredLevel: null, meetingPoint: '',
    residenceId: RES.olivar.id, residence: { id: RES.olivar.id, name: RES.olivar.name, sector: RES.olivar.sector },
    unit: 'Torre 2 · 504', residenceId2: null, residence2: null, unit2: '',
  };
  const CONDUCTOR = { name: 'Mauricio Arango Pérez', first: 'Mauricio', initials: 'MA', phone: '3104567890', avatarUrl: '', rating: null, ratingN: 6, plate: 'RDO481' };
  const CONDUCTOR_TOP = Object.assign({}, CONDUCTOR, { rating: 4.8, ratingN: 37 });
  const CARRO = { plate: 'RDO481', brand: 'Chevrolet', model: 'Onix', color: 'Gris' };
  const CAMIONETA = { plate: 'KTQ220', brand: 'Toyota', model: 'Fortuner', color: 'Negro' };
  const CODIGO = '4827';

  // Ajustes como los de producción: privado APAGADO (primicia), puntos apagados,
  // sin teléfono ni horario de Coordinación.
  const AJUSTES = {
    _loaded: true, aux_wait_minutes: 5, aux_min_lead_hours: 6,
    aux_private_enabled: false, aux_private_vehicle_id: null, aux_private_price_cop: null, aux_private_block_min: 150,
    aux_points_enabled: false, ops_contact_phone: '', ops_contact_hours: '',
    reservation_idle_minutes: 60, shift_hours: 12, auto_close_hours: 14,
  };
  // El privado encendido de verdad (las tres cosas). La tarifa existe en la
  // base, pero NINGUNA pantalla debe pintarla (D1): si el barrido de textos
  // prohibidos encuentra una cifra, salió del código.
  const AJUSTES_PRIVADO = Object.assign({}, AJUSTES, { aux_private_enabled: true, aux_private_vehicle_id: 'esc-veh-camioneta', aux_private_price_cop: 150000 });

  let nId = 0;
  // Un viaje T con TODOS los campos de ApiAux.mapTrip (y los de listMyReservations).
  function T(o) {
    const t = Object.assign({
      id: 'esc-t' + (++nId), type: 'sal',
      residenceId: RES.olivar.id, residenceUnit: 'Torre 2 · 504',
      level: 'shared', privateStatus: null, price: null, privateReason: '',
      flight: 'AV9412', date: dia(1), time: '05:10',
      address: 'El Olivar · Rionegro', lat: RES.olivar.latitude, lng: RES.olivar.longitude,
      notes: 'Vuelo AV9412.', notesUser: '',
      published: false, pickupAt: null, meetCode: '',
      // 0093: el orden en el carro (solo publicado) y la marca de tierra.
      pickupPos: null, pickupTotal: null, groundOps: false,
      status: 'pending', rawStatus: 'requested',
      driver: null, vehicle: null,
      bags: null, quiet: false, meetingPoint: '',
      createdAt: haceMin(60 * 30), stopStatus: null, arrivedAt: null, pickedAt: null, droppedAt: null,
      cancelledAt: null, cancelReason: '',
      isPernocta: false, isReserva: true, readyAt: null, rated: false, rating: 0,
    }, o || {});
    if (t.type === 'lle' && !(o && 'rawStatus' in o)) t.rawStatus = 'scheduled';
    if (!(o && 'notes' in o)) t.notes = 'Vuelo ' + t.flight + '.' + (t.notesUser ? ' ' + t.notesUser : '');
    t.requiredAt = iso(t.date, t.time);
    return t;
  }
  // Publicado: conductor, carro, código y (si se da) la hora de recogida.
  function pub(o) {
    return Object.assign({ published: true, meetCode: CODIGO, driver: clone(CONDUCTOR), vehicle: clone(CARRO), stopStatus: 'pending' }, o);
  }
  // I = lo que devuelve auxiliar_track_reservation v5 para ese viaje.
  function I(t, raw, o) {
    const activo = ['en_route', 'at_pickup', 'on_board', 'picked_up', 'en_route_home'].includes(raw);
    return Object.assign({
      cancelled: false, assigned: true, raw_status: raw,
      direction: t.type === 'lle' ? 'airport_to_home' : 'home_to_airport',
      stop_status: 'pending', arrived_at: null, ready_confirmed_at: null, wait_minutes: 5,
      driver: { name: t.driver.name, phone: t.driver.phone, avatar_url: t.driver.avatarUrl || null, rating: t.driver.rating, rating_n: t.driver.ratingN },
      plate: t.vehicle.plate, vehicle: clone(t.vehicle),
      pickup_at: t.pickupAt, meet_code: t.meetCode || null,
      stop_order: 2, total_stops: 3, remaining_before: 1, remaining_after: 1,
      next_stops: [
        { order: 1, mine: false, lat: 6.140, lng: -75.386, sector: 'Rionegro' },
        { order: 2, mine: true, lat: t.lat, lng: t.lng, sector: null },
      ],
      route_start: t.pickupAt ? new Date(Date.parse(t.pickupAt) - 25 * 60e3).toISOString() : null,
      pickup: { lat: t.lat, lng: t.lng },
      // D14: la posición solo existe en estado activo.
      pos: activo ? { lat: 6.1461, lng: -75.3812, source: 'gps', at: new Date(Date.now() - 20e3).toISOString() } : null,
    }, o || {});
  }
  const SIN_RUTA = (t) => ({ cancelled: false, assigned: false, raw_status: t.rawStatus, direction: t.type === 'lle' ? 'airport_to_home' : 'home_to_airport', ready_confirmed_at: null, wait_minutes: 5, pickup: { lat: t.lat, lng: t.lng }, pickup_at: null, meet_code: null, pos: null });

  const STATS0 = { done: 0, onTimePct: null, onTimeN: 0, on_time_pct: null, on_time_n: 0 };
  const STATS = { done: 23, onTimePct: 91, onTimeN: 11, on_time_pct: 91, on_time_n: 11 };

  // ── Los escenarios ───────────────────────────────────────────────────────
  // Cada uno: {info, trips, track{id:I}, principal, settings?, profile?, header?,
  //            stats?, source?, crew?, ops?, chat?, puntos?}
  const ESC = {
    'vacio': () => ({ info: 'Sin traslados', trips: [] }),

    'error-carga': () => ({ info: 'No se pudieron leer los viajes (source=error)', trips: [], source: 'error' }),

    'pendiente-sin-plan': () => {
      const t = T({ date: dia(1), time: '05:10', notesUser: 'Llevo maleta grande', bags: 2 });
      return { info: 'Salida mañana 05:10, sin ruta: sin hora de recogida ni código', trips: [t], principal: t.id, track: { [t.id]: SIN_RUTA(t) } };
    },

    'pendiente-vencido': () => {
      const v = enMin(-8 * 60);
      const t = T({ date: v.date, time: v.time });
      return { info: 'Pendiente de hace 8 h que nunca se hizo: NO sale en Inicio; en Viajes va al historial «Sin realizar»', trips: [t], principal: t.id, track: { [t.id]: SIN_RUTA(t) } };
    },

    'asignado-publicado': () => {
      const t = T(pub({ date: dia(1), time: '05:10', status: 'assigned', rawStatus: 'assigned', pickupAt: iso(dia(1), '03:48'), bags: 1 }));
      return { info: 'Salida mañana, conductor asignado, recogida 03:48, código', trips: [t], principal: t.id, track: { [t.id]: I(t, 'assigned') } };
    },

    'asignado-sin-hora': () => {
      const t = T(pub({ date: dia(1), time: '05:10', status: 'assigned', rawStatus: 'assigned', pickupAt: null }));
      return { info: 'Conductor asignado pero sin hora publicada: «hora por confirmar»', trips: [t], principal: t.id, track: { [t.id]: I(t, 'assigned', { pickup_at: null, route_start: null }) } };
    },

    'en-camino': () => {
      const r = enMin(12), l = enMin(95);
      const t = T(pub({ date: l.date, time: l.time, status: 'onway', rawStatus: 'en_route', pickupAt: iso(r.date, r.time) }));
      return { info: 'El conductor va por ti (GPS, ETA real solo con OSRM)', trips: [t], principal: t.id, track: { [t.id]: I(t, 'en_route') } };
    },

    'llego': () => {
      const r = enMin(-1), l = enMin(80);
      const t = T(pub({ date: l.date, time: l.time, status: 'onway', rawStatus: 'at_pickup', pickupAt: iso(r.date, r.time), stopStatus: 'arrived', arrivedAt: haceMin(1) }));
      return { info: 'Llegó por ti: fase «Llegó», código de encuentro y espera de 5 min', trips: [t], principal: t.id, track: { [t.id]: I(t, 'at_pickup', { stop_status: 'arrived', arrived_at: haceMin(1), remaining_before: 0 }) } };
    },

    'a-bordo-salida': () => {
      const r = enMin(-20), l = enMin(55);
      const t = T(pub({ date: l.date, time: l.time, status: 'onboard', rawStatus: 'on_board', pickupAt: iso(r.date, r.time), stopStatus: 'picked_up', arrivedAt: haceMin(24), pickedAt: haceMin(20) }));
      return { info: 'A bordo rumbo a MDE (texto de margen de auxLateness)', trips: [t], principal: t.id, track: { [t.id]: I(t, 'on_board', { stop_status: 'picked_up', arrived_at: haceMin(24), remaining_before: 0, remaining_after: 1 }) } };
    },

    'a-bordo-llegada': () => {
      const l = enMin(-35), sal = enMin(-15);
      const t = T(pub({ type: 'lle', flight: 'JA5116', date: l.date, time: l.time, status: 'onboard', rawStatus: 'en_route_home', pickupAt: iso(sal.date, sal.time), stopStatus: 'picked_up', pickedAt: haceMin(15) }));
      return { info: 'Llegada: a bordo rumbo a casa (el carro aparece desde «recogí»)', trips: [t], principal: t.id, track: { [t.id]: I(t, 'en_route_home', { stop_status: 'picked_up', stop_order: 1, remaining_before: 0, remaining_after: 1 }) } };
    },

    'entregado-sin-calificar': () => {
      const l = enMin(-3 * 60);
      const t = T(pub({ date: l.date, time: l.time, status: 'done', rawStatus: 'delivered', pickupAt: iso(enMin(-4 * 60).date, enMin(-4 * 60).time), stopStatus: 'picked_up', pickedAt: haceMin(4 * 60), droppedAt: haceMin(3 * 60 + 10) }));
      t.driver.phone = '';   // cerrado: el servidor ya no da el teléfono
      return { info: 'Entregado hace 3 h, sin calificar: tarjeta «¿Cómo te fue con Mauricio?»', trips: [t], principal: t.id, track: { [t.id]: I(t, 'delivered', { stop_status: 'picked_up', driver: { name: CONDUCTOR.name, phone: null, avatar_url: null, rating: null, rating_n: 6 } }) }, stats: Object.assign({}, STATS0, { done: 1 }) };
    },

    'cancelado': () => {
      const t = T({ date: dia(2), time: '06:30', status: 'cancelled', rawStatus: 'cancelled', cancelledAt: haceMin(40), cancelReason: 'Me cambiaron la programación' });
      return { info: 'Cancelado por el tripulante, con motivo', trips: [t], principal: t.id, track: { [t.id]: { cancelled: true, assigned: false, raw_status: 'cancelled' } } };
    },

    'historial': () => {
      const d = (n, time, o) => T(Object.assign({ date: dia(n), time }, o));
      const done5 = d(-2, '04:40', pub({ status: 'done', rawStatus: 'delivered', rated: true, rating: 5 }));
      const done4 = d(-5, '05:20', pub({ status: 'done', rawStatus: 'delivered', rated: true, rating: 4, type: 'lle', flight: 'AV8520' }));
      const sinCal = d(-3, '06:10', pub({ status: 'done', rawStatus: 'delivered' }));
      const canc = d(-6, '05:00', { status: 'cancelled', rawStatus: 'cancelled', cancelledAt: new Date(Date.now() - 6.5 * 86400e3).toISOString(), cancelReason: 'Vuelo cancelado' });
      const nosh = d(-8, '04:30', pub({ status: 'noshow', rawStatus: 'no_show' }));
      const venc = d(-9, '05:40', {});
      const prox = d(3, '05:10', {});
      [done5, done4, sinCal, nosh].forEach(x => { x.driver.phone = ''; });
      return { info: 'Historial: entregados (★5, ★4, sin calificar), cancelado, no-show, vencido «Sin realizar» y uno próximo', trips: [venc, nosh, canc, done4, sinCal, done5, prox], principal: sinCal.id, stats: STATS };
    },

    'privado-solicitado': () => {
      const t = T({ date: dia(2), time: '05:30', level: 'private', privateStatus: 'requested', quiet: true, notesUser: 'Prefiero la camioneta' });
      return { info: 'Privado pedido, Coordinación confirma (sin cifras)', trips: [t], principal: t.id, settings: AJUSTES_PRIVADO, track: { [t.id]: SIN_RUTA(t) } };
    },

    'privado-aprobado': () => {
      const t = T(pub({ date: dia(1), time: '05:30', level: 'private', privateStatus: 'approved', quiet: true, status: 'assigned', rawStatus: 'assigned', pickupAt: iso(dia(1), '04:15'), vehicle: clone(CAMIONETA), driver: clone(CONDUCTOR_TOP) }));
      t.driver.plate = CAMIONETA.plate;
      return { info: 'Privado aprobado con camioneta, silencio y conductor con ★ (37 calificaciones)', trips: [t], principal: t.id, settings: AJUSTES_PRIVADO, track: { [t.id]: I(t, 'assigned') } };
    },

    'privado-rechazado': () => {
      const t = T({ date: dia(2), time: '05:30', level: 'private', privateStatus: 'rejected', privateReason: 'La camioneta ya está ocupada a esa hora' });
      return { info: 'Privado rechazado: sigue como compartido, con el motivo', trips: [t], principal: t.id, settings: AJUSTES_PRIVADO, track: { [t.id]: SIN_RUTA(t) } };
    },

    'primicia': () => {
      const t = T({ date: dia(2), time: '05:10' });
      return { info: 'Privado APAGADO (como producción): Select se ve en primicia, no se puede elegir', trips: [t], principal: t.id, settings: AJUSTES, track: { [t.id]: SIN_RUTA(t) } };
    },

    'suspendido': () => {
      const t = T({ date: dia(1), time: '05:10' });
      return {
        info: 'Cuenta suspendida: no pide nuevos; lo ya pedido sigue en pie', trips: [t], principal: t.id, track: { [t.id]: SIN_RUTA(t) },
        profile: Object.assign({}, PERFIL, { is_active: false, suspended_reason: 'Tres ausencias sin aviso' }),
      };
    },

    'traslado-noche': () => {
      const s = T({ date: dia(1), time: '20:30', flight: 'LA2345' });
      const l = T({ type: 'lle', date: dia(1), time: '22:40', flight: 'AV8520' });
      return { info: 'Salida 20:30 y llegada 22:40 de Bogotá: la fecha es la de ESE día, no la siguiente', trips: [s, l], principal: s.id, track: { [s.id]: SIN_RUTA(s), [l.id]: SIN_RUTA(l) } };
    },

    'dos-unidades': () => ({
      info: 'Tripulante con dos unidades (el pedido tiene 5 pasos)', trips: [],
      header: Object.assign({}, HEADER, { residenceId2: RES.llano.id, residence2: { id: RES.llano.id, name: RES.llano.name, sector: RES.llano.sector }, unit2: 'Casa 14' }),
    }),

    'coordinacion-con-mensajes': () => {
      const t = T(pub({ date: dia(1), time: '05:10', status: 'assigned', rawStatus: 'assigned', pickupAt: iso(dia(1), '03:48') }));
      return {
        info: 'Hilo con Coordinación: 1 sin leer, teléfono y horario cargados', trips: [t], principal: t.id, track: { [t.id]: I(t, 'assigned') },
        ops: { phone: '6045551234', hours: 'Todos los días · 3:00 a. m. a 11:00 p. m.' },
        crew: [
          { id: 'esc-m1', role: 'auxiliar', mine: true, body: 'Mi vuelo se retrasó: ahora sale a las 07:10', at: haceMin(30), read: true, readAt: haceMin(25), reservation: { id: t.id, type: 'sal', date: t.date, time: t.time } },
          { id: 'esc-m2', role: 'admin', mine: false, body: 'Listo, movemos tu recogida y te confirmamos.', at: haceMin(20), read: false, readAt: null, reservation: null },
        ],
      };
    },

    // ── Pedido del 29-sep: orden en el carro y traslados de tierra ──
    'ruta-2-de-3': () => {
      const t = T(pub({ date: dia(1), time: '05:10', status: 'assigned', rawStatus: 'assigned', pickupAt: iso(dia(1), '03:48'), bags: 1, pickupPos: 2, pickupTotal: 3 }));
      return { info: 'Ruta publicada: eres la 2.ª recogida de 3 (la tarjeta dice «Recogida 2/3»)', trips: [t], principal: t.id, track: { [t.id]: I(t, 'assigned') } };
    },

    'ruta-sola': () => {
      const t = T(pub({ date: dia(1), time: '05:10', status: 'assigned', rawStatus: 'assigned', pickupAt: iso(dia(1), '04:05'), bags: 2, pickupPos: 1, pickupTotal: 1 }));
      return { info: 'Ruta publicada y vas sola en el carro: «Recogida 1/1»', trips: [t], principal: t.id, track: { [t.id]: I(t, 'assigned', { stop_order: 1, total_stops: 1, remaining_before: 0, remaining_after: 0, next_stops: [{ order: 1, mine: true, lat: t.lat, lng: t.lng, sector: null }] }) } };
    },

    'llegada-parada': () => {
      const t = T(pub({ type: 'lle', flight: 'LA4021', date: dia(1), time: '21:40', status: 'assigned', rawStatus: 'driver_assigned', pickupAt: iso(dia(1), '22:05'), pickupPos: 3, pickupTotal: 3 }));
      return { info: 'Llegada con ruta publicada: te dejan de 3.ª de 3 («Parada 3/3»)', trips: [t], principal: t.id, track: { [t.id]: I(t, 'driver_assigned', { stop_order: 3, total_stops: 3, remaining_before: 2, remaining_after: 0 }) } };
    },

    'tierra-llegada': () => {
      const t = T({ type: 'lle', groundOps: true, flight: '', notes: '', date: dia(1), time: '14:00', bags: 1 });
      return { info: 'Operación de tierra (sin vuelo): regreso a casa; la hora es la de salir del aeropuerto', trips: [t], principal: t.id, track: { [t.id]: SIN_RUTA(t) } };
    },

    'cobro-en-blanco': () => ({ info: 'Sin mensualidad registrada: «Todavía no tienes mensualidad registrada» (nunca una cifra inventada)', trips: [] }),

    'puntos-en-blanco': () => ({
      info: 'Rendio Points ENCENDIDO pero en cero: sin movimientos ni referidos', trips: [],
      settings: Object.assign({}, AJUSTES, { aux_points_enabled: true }),
      puntos: { enabled: true, summary: { balance: 0, nextRewardPts: 180, nextRewardName: 'Traslado gratis para un colega' } },
    }),
  };

  function datos(nombre) {
    const f = ESC[nombre]; if (!f) return null;
    nId = 0;
    const d = f();
    return {
      nombre, info: d.info,
      trips: d.trips || [], track: d.track || {}, principal: d.principal || null,
      source: d.source || 'live',
      profile: clone(d.profile || PERFIL),
      header: clone(d.header || HEADER),
      settings: clone(d.settings || AJUSTES),
      stats: clone(d.stats || STATS0),
      crew: clone(d.crew || []),
      ops: clone(d.ops || { phone: '', hours: '' }),
      chat: clone(d.chat || {}),
      puntos: clone(d.puntos || { enabled: false, summary: null }),
      residencias: clone([RES.olivar, RES.llano, RES.cerezos]),
      aerolineas: clone(AEROLINEAS),
    };
  }

  // ── Montaje ──────────────────────────────────────────────────────────────
  // Lo original, por OBJETO y clave (si la página cambia window.AuxPuntos por
  // otro objeto entre dos montajes, cada uno se restaura por separado).
  const orig = [];
  const creados = [];         // globales que el arnés tuvo que crear (se borran al restaurar)
  const llamadas = [];
  function poner(objName, obj, key, fn) {
    if (!orig.some(o => o.obj === obj && o.key === key)) {
      orig.push({ obj, key, had: Object.prototype.hasOwnProperty.call(obj, key), val: obj[key] });
    }
    obj[key] = fn;
  }
  function crear(name) {
    const o = { _escenario: true };
    g[name] = o; creados.push({ name, obj: o });
    return o;
  }
  const anota = (fn, ret) => (...args) => { llamadas.push({ fn, args: clone(args) }); return Promise.resolve(typeof ret === 'function' ? ret(...args) : clone(ret)); };
  const da = (v) => () => Promise.resolve(clone(v));

  function montar(nombre, o) {
    const opts = o || {};
    const d = datos(nombre);
    if (!d) throw new Error(`Escenario desconocido: «${nombre}». Hay: ${Object.keys(ESC).join(', ')}`);
    const A = g.Auxiliar;
    if (!A || !A.state) throw new Error('Carga primero auxiliar.js (no existe window.Auxiliar)');
    try { if (typeof A.stopTrack === 'function') A.stopTrack(); } catch (_) {}

    // Ajustes (state es el global de core.js; en jsdom puede no existir).
    try {
      // eslint-disable-next-line no-undef
      if (typeof state !== 'undefined' && state) state.settings = clone(d.settings);
      else g.state = { settings: clone(d.settings) };
    } catch (_) { g.state = { settings: clone(d.settings) }; }

    // Estado del auxiliar.
    const st = A.state;
    Object.assign(st, {
      profile: clone(d.profile), trips: clone(d.trips), source: d.source,
      view: 'home', tab: 'inicio', step: 1, form: {}, editingTrip: null,
      alarm: null, confirmingCancel: false, chatOpen: false, chatMsgs: [], chatUnread: 0,
      ratingSel: 0, ratingTags: [], supportOpen: false, onbStep: 0,
    });
    A.header = clone(d.header);

    // Api (lecturas del escenario; escrituras anotadas, sin red).
    const Api = g.Api || crear('Api');
    const viajes = () => (d.source === 'error' ? null : clone(d.trips));
    poner('Api', Api, 'listMyReservations', () => Promise.resolve(viajes()));
    poner('Api', Api, 'trackReservation', (id) => Promise.resolve(clone(d.track[id] || null)));
    poner('Api', Api, 'getMyAuxHeader', da(d.header));
    poner('Api', Api, 'getCurrentProfile', da(d.profile));
    poner('Api', Api, 'getSettings', da(d.settings));
    poner('Api', Api, 'listResidences', da(d.residencias));
    poner('Api', Api, 'getMyAuxiliarPlace', da({
      residenceId: d.header.residenceId, residence: d.header.residence && Object.assign({}, d.residencias.find(r => r.id === d.header.residenceId)),
      unit: d.header.unit, residenceId2: d.header.residenceId2,
      residence2: d.header.residenceId2 ? Object.assign({}, d.residencias.find(r => r.id === d.header.residenceId2)) : null,
      unit2: d.header.unit2, homeAddress: '', homeLat: null, homeLng: null, airlineIata: d.header.airlineIata,
    }));
    poner('Api', Api, 'listAirlines', da(d.aerolineas));
    poner('Api', Api, 'getMyAirlineIata', da(d.header.airlineIata));
    poner('Api', Api, 'listReservationMessages', (id) => Promise.resolve(clone(d.chat[id] || [])));
    poner('Api', Api, 'markReservationMessagesRead', da(0));
    poner('Api', Api, 'getReservationRisk', da(null));
    poner('Api', Api, 'privateBusyAt', da(false));
    let nuevo = 0;
    poner('Api', Api, 'createReservation', anota('Api.createReservation', () => 'esc-nuevo-' + (++nuevo)));
    poner('Api', Api, 'cancelMyReservation', anota('Api.cancelMyReservation', { ok: true }));
    poner('Api', Api, 'confirmReservationReady', anota('Api.confirmReservationReady', true));
    poner('Api', Api, 'rateReservation', anota('Api.rateReservation', true));
    poner('Api', Api, 'sendReservationMessage', anota('Api.sendReservationMessage', { notified: null, recipients: [] }));
    poner('Api', Api, 'reportIncident', anota('Api.reportIncident', 'esc-inc-1'));
    poner('Api', Api, 'saveMyResidence', anota('Api.saveMyResidence', true));
    poner('Api', Api, 'signOut', anota('Api.signOut', undefined));

    // ApiAux (se crea si la página no lo cargó).
    const X = g.ApiAux || crear('ApiAux');
    poner('ApiAux', X, 'listMyTrips', () => Promise.resolve(viajes()));
    poner('ApiAux', X, 'getMyStats', da(d.stats));
    poner('ApiAux', X, 'crewList', da(d.crew));
    poner('ApiAux', X, 'crewUnread', () => Promise.resolve(d.crew.filter(m => m.role === 'admin' && !m.read).length));
    poner('ApiAux', X, 'crewMarkRead', anota('ApiAux.crewMarkRead', () => { const n = d.crew.filter(m => m.role === 'admin' && !m.read).length; d.crew.forEach(m => { if (m.role === 'admin') m.read = true; }); return n; }));
    poner('ApiAux', X, 'crewThreadsAdmin', da([]));
    poner('ApiAux', X, 'getOpsContact', da(d.ops));
    poner('ApiAux', X, 'saveMyPrefs', anota('ApiAux.saveMyPrefs', true));
    poner('ApiAux', X, 'changeFlight', anota('ApiAux.changeFlight', { mode: 'updated', incidentId: null, requiredAt: null, unchanged: false, notified: null }));
    poner('ApiAux', X, 'crewSend', anota('ApiAux.crewSend', { id: 'esc-envio', recipients: [], notified: null }));
    poner('ApiAux', X, 'setOpsContact', anota('ApiAux.setOpsContact', true));
    poner('ApiAux', X, 'setVehicleColor', anota('ApiAux.setVehicleColor', true));

    // Pagos y Puntos: en blanco (salvo lo que diga el escenario).
    ['ApiCobro', 'ApiPuntos'].forEach(n => {
      const obj = g[n]; if (!obj) return;
      Object.keys(obj).forEach(k => { if (typeof obj[k] === 'function') poner(n, obj, k, () => Promise.resolve(null)); });
    });
    if (g.AuxPagos) {
      poner('AuxPagos', g.AuxPagos, 'summary', () => null);
      poner('AuxPagos', g.AuxPagos, 'paused', () => false);
    }
    if (d.puntos.enabled && !g.AuxPuntos) crear('AuxPuntos');
    if (g.AuxPuntos) {
      poner('AuxPuntos', g.AuxPuntos, 'enabled', () => !!d.puntos.enabled);
      poner('AuxPuntos', g.AuxPuntos, 'summary', () => (d.puntos.enabled ? clone(d.puntos.summary) : null));
      poner('AuxPuntos', g.AuxPuntos, 'cancelBonus', () => null);
    }

    // Nocturno.
    if (opts.noche === true || opts.noche === false) {
      if (g.AuxPresentacion && typeof g.AuxPresentacion.setThemePref === 'function') {
        g.AuxPresentacion.setThemePref(opts.noche ? 'night' : 'auto');
      } else {
        const el = g.document && g.document.getElementById('auxiliar-ui');
        if (el) el.setAttribute('data-ax-night', opts.noche ? 'on' : 'off');
      }
    }

    // Pintar.
    if (opts.abrir && d.principal && typeof A.openTrip === 'function') A.openTrip(d.principal);
    else if (typeof A.rerender === 'function') A.rerender();
    return d;
  }

  function restaurar() {
    orig.forEach(({ obj, key, had, val }) => { if (had) obj[key] = val; else delete obj[key]; });
    orig.length = 0;
    creados.forEach(({ name, obj }) => { if (g[name] === obj) delete g[name]; });
    creados.length = 0;
    llamadas.length = 0;
  }

  g.AuxEscenarios = {
    list: () => Object.keys(ESC),
    info: (n) => (ESC[n] ? datos(n).info : null),
    datos, montar, restaurar, llamadas,
    // Piezas para armar escenarios propios en una prueba.
    piezas: { T, pub, I, SIN_RUTA, PERFIL, HEADER, CONDUCTOR, CARRO, CODIGO, AJUSTES, AJUSTES_PRIVADO, RES, dia, enMin, iso },
  };
})(typeof window !== 'undefined' ? window : globalThis);
