// UBICACIÓN DURANTE TODO EL TURNO (10-nov-2026).
//
// driver-rutas.js solo manda la posición con una vuelta EN CURSO: cuando el
// conductor entrega y vuelve vacío al aeropuerto, el mapa lo deja clavado en la
// última casa (28-oct: «Lennin acabó de dejar y sigue apareciendo muy lejos»).
// Para repartir las llegadas hace falta saber dónde está cada carro ENTRE
// vueltas, así que con el turno abierto se manda un punto cada PING_MS, y otro
// apenas la app vuelve a primer plano (el navegador no entrega GPS con la app
// atrás: al volver de Waze se pone al día de una).
//
// No toca driver-rutas.js: durante una vuelta él sigue mandando cada 6 s con el
// id de la vuelta. Esto es la red de fondo, sin vuelta. Con el turno cerrado no
// se pide ni se manda nada.
(function () {
  'use strict';
  const PING_MS = 45000, REVISA_MS = 20000;
  const G = { watch: null, last: 0, pos: null };

  const turno = () => (typeof sf !== 'undefined' && sf && sf.activeShift && !sf.activeShift.end_at) ? sf.activeShift : null;
  const conductor = () => { const t = turno(); return t ? (t.driver_id || t.driver_profile_id || null) : null; };

  function mandar(c, fuerza) {
    const id = conductor();
    if (!id || !c || !isFinite(c.latitude) || !(window.Api && Api.sendDriverLocation)) return;
    const now = Date.now();
    if (!fuerza && now - G.last < PING_MS) return;
    G.last = now;
    Api.sendDriverLocation(id, c.latitude, c.longitude, {
      heading: c.heading,
      speedKmh: isFinite(c.speed) && c.speed != null ? c.speed * 3.6 : undefined,
    }).catch(() => { /* un punto perdido no rompe nada: llega el siguiente */ });
  }
  function alPunto(p) { if (p && p.coords) { G.pos = p.coords; mandar(p.coords, false); } }
  function prender() {
    if (G.watch != null || !navigator.geolocation) return;
    try { G.watch = navigator.geolocation.watchPosition(alPunto, () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }); }
    catch (e) { G.watch = null; }
  }
  function apagar() {
    if (G.watch != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(G.watch); } catch (e) { /* */ } }
    G.watch = null; G.pos = null;
  }
  function revisar() { if (conductor()) prender(); else apagar(); }
  function alVolver() {
    if (document.visibilityState !== 'visible' || !conductor() || !navigator.geolocation) return;
    try { navigator.geolocation.getCurrentPosition((p) => { if (p && p.coords) { G.pos = p.coords; mandar(p.coords, true); } }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }); }
    catch (e) { /* sin permiso */ }
  }

  setInterval(revisar, REVISA_MS);
  document.addEventListener('visibilitychange', alVolver);
  window.RendioGpsTurno = { revisar, _estado: G, _mandar: mandar, _conductor: conductor };
})();
