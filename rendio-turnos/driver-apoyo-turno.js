// EL CARRO DE APOYO, DEL LADO DEL CONDUCTOR (15-nov-2026, con 0163).
//
// El jefe marca en Asignación quién tiene el apoyo de cada turno (0162), pero el
// conductor no lo veía en ningún lado: se enteraba con la primera llegada. Y
// como el apoyo no abre turno, la app no mandaba su ubicación, así que el
// despacho lo contaba siempre «a 25 minutos» del aeropuerto.
//
// Esto hace dos cosas y nada más:
//   1. Una tarjeta en Inicio: «Tienes el carro de apoyo» (ahora, o desde cuándo).
//   2. Le dice a driver-gps-turno.js que, mientras el apoyo sea suyo, mande la
//      ubicación aunque no tenga turno abierto (RendioApoyo.activo/conductor).
//
// Los turnos son los de apoyo_de_turno (0162): mañana = 2:00 a 14:00 del día;
// tarde = 14:00 a 2:00 (la madrugada es del turno de la tarde de ayer).
// La tabla support_duty solo le deja ver al conductor sus propias filas.
(function () {
  'use strict';
  const REFRESCA_MS = 5 * 60000;
  const A = { filas: [], pedido: 0, cargando: null };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Día y minuto de Bogotá, sin depender de la zona del teléfono.
  function bogota(d) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    return { dia: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
  }
  function suma(dia, n) { const d = new Date(dia + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function turnoDe(b) {
    if (b.min < 120) return { day: suma(b.dia, -1), band: 'pm' };
    return { day: b.dia, band: b.min < 840 ? 'am' : 'pm' };
  }
  const orden = (f) => f.day + (f.band === 'am' ? 'a' : 'p');
  const esConductor = () => typeof state !== 'undefined' && !!state && !!state.profile && state.profile.role === 'driver';

  function filaDeAhora(ahora) { const t = turnoDe(bogota(ahora)); return A.filas.find((f) => f.day === t.day && f.band === t.band) || null; }
  function activo(ahora) { return !!filaDeAhora(ahora); }
  function conductor(ahora) { const f = filaDeAhora(ahora); return f ? f.driver_profile_id : null; }
  function proximo(ahora) {
    const ya = orden(turnoDe(bogota(ahora)));
    return A.filas.filter((f) => orden(f) > ya).sort((x, y) => (orden(x) < orden(y) ? -1 : 1))[0] || null;
  }

  // Qué decir. `ahora` solo para las pruebas.
  function texto(ahora) {
    const b = bogota(ahora);
    if (activo(ahora)) {
      const t = turnoDe(b);
      return { sub: `Ahora · hasta las ${t.band === 'am' ? '2:00 p. m.' : '2:00 a. m.'}`,
        cuerpo: 'Si los carros fijos no alcanzan con una llegada, te la mandamos aquí. Deja la app abierta para saber dónde estás.' };
    }
    const f = proximo(ahora);
    if (!f) return null;
    const dia = f.day === b.dia ? 'Hoy' : f.day === suma(b.dia, 1) ? 'Mañana' : (() => { const [, m, d] = f.day.split('-'); return `El ${d}/${m}`; })();
    return { sub: `${dia} desde las ${f.band === 'am' ? '2:00 a. m.' : '2:00 p. m.'}`,
      cuerpo: 'Cuando empiece tu turno de apoyo, deja la app abierta: si hay una llegada para ti, te llega aquí.' };
  }

  async function cargar(fuerza) {
    if (!esConductor() || !(window.Api && Api.mySupportDuty)) { A.filas = []; return A.filas; }
    if (!fuerza && Date.now() - A.pedido < 60000) return A.filas;
    if (A.cargando) return A.cargando;
    const b = bogota();
    A.cargando = Api.mySupportDuty(suma(b.dia, -1), suma(b.dia, 2))
      .then((r) => { A.filas = Array.isArray(r) ? r : []; A.pedido = Date.now(); return A.filas; })
      .catch(() => A.filas)
      .finally(() => { A.cargando = null; });
    return A.cargando;
  }

  function pintar() {
    const box = document.getElementById('driver-home-apoyo');
    if (!box) return;
    const t = esConductor() ? texto() : null;
    if (!t) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="rc-card rc-apoyo rc-in d2" role="status">'
      + '<span class="rc-apoyo-ic" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17H3v-5l2-5h11l3 5h2v5h-2"/><circle cx="7.5" cy="17.5" r="2"/><circle cx="16.5" cy="17.5" r="2"/><path d="M9.5 17h5M5 12h14"/></svg></span>'
      + '<span class="rc-apoyo-tx"><b>Tienes el carro de apoyo</b><em>' + esc(t.sub) + '</em><small>' + esc(t.cuerpo) + '</small></span>'
      + '</div>';
  }

  async function render(fuerza) {
    await cargar(fuerza);
    pintar();
    // Que la ubicación arranque de una si el apoyo ya es suyo.
    if (window.RendioGpsTurno && RendioGpsTurno.revisar) RendioGpsTurno.revisar();
  }

  if (typeof window !== 'undefined') {
    setInterval(() => { if (esConductor()) render(true).catch(() => {}); }, REFRESCA_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && esConductor()) render(true).catch(() => {}); });
    window.RendioApoyo = { render, activo, conductor, _texto: texto, _turnoDe: turnoDe, _bogota: bogota, _estado: A };
  }
})();
