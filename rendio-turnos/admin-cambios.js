// admin-cambios.js — Rutas › Asignación › «Cambios» (0153, 28-oct-2026).
//
// Camilo (jefe), 7:45 a. m.: «necesito una opción que me muestre los cambios que
// hacen los TC, porque no me estoy dando cuenta de los cambios en la programación».
//
// Un botón en la barra de Asignación con el número de cambios NUEVOS (desde la
// última vez que lo abrió ese jefe en ese equipo) y una hoja con lo que los
// tripulantes pidieron, cancelaron o cambiaron en la app para el día que se ve:
// pedidos nuevos, cancelaciones y cambios de hora, vuelo, lugar (hotel/JMC), punto
// o nivel. Cada uno dice cómo quedó AHORA en el tablero: en qué carro va, si quedó
// sin carro (con «Ubicar»), o si pidió después de que se abrió el día (con
// «Recargar el día»). Lo que hizo Coordinación o el sistema no sale: eso ya lo ve
// el jefe en la pantalla.
//
// Lo de antes del corte (las 7:30 p. m. del día anterior) ya venía en el Excel de
// Julián: va aparte, plegado.
//
// Módulo cerrado (IIFE): window.RendioCambios.pintar(día) lo llama admin-rutas-v2.js
// en cada render. Lee la base como mucho cada 60 s (y cada 90 s solo, mientras
// Asignación está a la vista). Datos: Api.listCrewChanges (admin_cambios_tripulantes).
// Para las pruebas: RendioCambios._st.
(function () {
  'use strict';
  const W = window;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (iso) => {
    try { return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(/^0/, ''); } catch (_) { return ''; }
  };
  const diaDe = (iso) => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); } catch (_) { return ''; } };
  const sumarDia = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const diaTxt = (d) => { const x = new Date(d + 'T12:00:00Z'); return `${DIAS[x.getUTCDay()]} ${x.getUTCDate()} ${MES[x.getUTCMonth()]}`; };
  // «4:12 p. m.» si es de hoy; «ayer 9:40 p. m.» / «lun 26 9:40 p. m.» si no.
  const cuando = (iso) => {
    const h = hm(iso); if (!h) return '';
    const [H, M] = h.split(':').map(Number);
    const t = `${H % 12 === 0 ? 12 : H % 12}:${String(M).padStart(2, '0')} ${H < 12 ? 'a. m.' : 'p. m.'}`;
    const d = diaDe(iso), hoy = diaDe(new Date().toISOString());
    return d === hoy ? t : (d === sumarDia(hoy, -1) ? 'ayer ' + t : diaTxt(d) + ' ' + t);
  };
  const corto = (n) => { const p = String(n || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1] : ''); };
  const LUGAR = { rio_verde: 'el Hotel Río Verde', movich: 'el Hotel Movich', aero: 'JMC', aeropuerto: 'JMC' };
  const lugarTxt = (k) => (k ? (LUGAR[k] || k) : 'su casa');
  const NIVEL = { shared: 'compartido', private: 'privado' };
  const LS = (dia) => 'rendio.cambios.visto.' + dia;

  const st = { dia: null, filas: null, leido: 0, leyendo: null, sinBase: false, error: '', abierto: false, verAntes: false };
  const V2 = () => W.RendioRutasV2 || null;
  const btn = () => document.getElementById('rv2-cambios');

  function visto(dia) { try { return W.localStorage.getItem(LS(dia)) || ''; } catch (_) { return ''; } }
  function marcarVisto(dia) { try { W.localStorage.setItem(LS(dia), new Date().toISOString()); } catch (_) { /* sin almacenamiento: el número vuelve a salir */ } }
  // Lo que se muestra: solo lo que hizo el mismo tripulante.
  const deTripulantes = () => (st.filas || []).filter((f) => f.by_owner);
  // Las horas vienen de la base con otro formato que el del equipo: se comparan como fecha.
  const despues = (a, b) => !b || Date.parse(a) > Date.parse(b);
  const nuevos = () => { const v = visto(st.dia); return deTripulantes().filter((f) => f.tarde && despues(f.at, v)); };

  // La ventana del día de Asignación: del día a las 00:00 hasta las 4 a. m. del
  // siguiente (la madrugada que se programa con este día).
  const ventana = (dia) => [dia + 'T00:00:00-05:00', sumarDia(dia, 1) + 'T04:00:00-05:00'];
  async function leer(dia, forzar) {
    if (!W.Api || typeof Api.listCrewChanges !== 'function' || !dia) return;
    if (!forzar && st.dia === dia && Date.now() - st.leido < 60000) return;
    if (st.leyendo) return st.leyendo;
    const [d0, d1] = ventana(dia);
    st.leyendo = (async () => {
      try {
        const r = await Api.listCrewChanges(new Date(d0).toISOString(), new Date(d1).toISOString());
        if (st.dia !== dia) { st.filas = null; }
        st.dia = dia; st.leido = Date.now(); st.error = '';
        st.sinBase = r === null; st.filas = (r || []).slice().sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
      } catch (e) { st.error = (e && e.message) || 'error'; st.leido = Date.now(); }
      finally { st.leyendo = null; }
      pintarBoton();
      if (st.abierto) pintarHoja();
    })();
    return st.leyendo;
  }
  function pintarBoton() {
    const b = btn(); if (!b) return;
    b.hidden = st.sinBase;
    const n = st.filas ? nuevos().length : 0;
    const badge = b.querySelector('.rv2-badge');
    if (badge) { badge.hidden = !n; badge.textContent = String(n); }
    b.classList.toggle('is-new', n > 0);
    b.title = n ? `${n} ${n === 1 ? 'cambio nuevo' : 'cambios nuevos'} de los tripulantes en este día` : 'Lo que pidieron, cancelaron o cambiaron los tripulantes en la app';
  }
  // Lo llama admin-rutas-v2.js en cada render: el día cambió → se lee ya.
  function pintar(dia) {
    if (!dia) return;
    if (st.dia !== dia) { st.dia = dia; st.filas = null; st.leido = 0; pintarBoton(); }
    leer(dia, false);
    pintarBoton();
  }

  // ── Qué cambió, en palabras ────────────────────────────────────────────────
  function queCambio(f) {
    const a = f.after || {}, b = f.before || {};
    const tipo = f.dir === 'lle' ? 'llegada' : 'salida';
    const hora = (x) => (x ? hm(x) : '—');
    switch (f.kind) {
      case 'nuevo': return `Pidió una ${tipo}: ${f.dir === 'lle' ? 'aterriza' : 'presentación'} ${hora(a.when || f.when)}${a.vuelo ? ' · ' + a.vuelo : ''}${a.lugar ? ' · desde ' + lugarTxt(a.lugar) : ''}`;
      case 'cancelado': return `Canceló su ${tipo} de las ${hora(b.when || f.when)}${b.vuelo ? ' (' + b.vuelo + ')' : ''}${a.motivo ? ': «' + a.motivo + '»' : ''}`;
      case 'vuelo': return `Cambió su vuelo: ${b.vuelo || 'sin vuelo'} → ${a.vuelo || 'sin vuelo'}${b.when && a.when && b.when !== a.when ? ` · ${hora(b.when)} → ${hora(a.when)}` : ''}`;
      case 'hora': return `Cambió la hora de su ${tipo}: ${hora(b.when)} → ${hora(a.when)}${a.vuelo ? ' · ' + a.vuelo : ''}`;
      case 'lugar': return `Cambió ${f.dir === 'lle' ? 'dónde la recogen' : 'a dónde va'}: ${lugarTxt(b.lugar)} → ${lugarTxt(a.lugar)}`;
      case 'punto': {
        const p = (x) => [x.punto || x.direccion || 'sin punto', x.unidad ? 'apto ' + x.unidad : ''].filter(Boolean).join(', ');
        return `Cambió su punto de recogida: ${p(b)} → ${p(a)}`;
      }
      case 'nivel': return `Cambió el servicio: ${NIVEL[b.nivel] || b.nivel || '—'} → ${NIVEL[a.nivel] || a.nivel || '—'}`;
      default: return 'Cambió su pedido';
    }
  }
  // Cómo quedó AHORA: primero el tablero que está abierto (si es ese día), si no lo
  // que dice la base.
  function comoQueda(f) {
    const R = typeof rt !== 'undefined' ? rt : null;
    const enTablero = R && R.day === st.dia && R.aux;
    const k = enTablero ? Object.keys(R.aux).find((x) => R.aux[x] && R.aux[x].reservationId === f.rid) : null;
    const lane = k ? (R.lanes || []).find((l) => (R.order[l.id] || []).includes(k)) : null;
    if (f.cancelled) {
      if (lane) return { cls: 'bad', txt: `Ya no va, pero en tu tablero sigue en ${lane.car} (lo abriste antes de que cancelara)`, act: 'recargar' };
      return { cls: 'ok', txt: f.vuelta ? 'Ya no va (sigue en una vuelta: revísala)' : 'Ya no va: salió de su vuelta' };
    }
    if (enTablero) {
      if (lane) {
        const D = V2() && V2().dia ? V2().dia() : null;
        const r = D && D.byId ? D.byId[lane.id] : null;
        const s = r && r.stops ? r.stops.find((x) => x.crewId === k) : null;
        const h = s && s.time != null ? `${String(Math.floor(((s.time % 1440) + 1440) % 1440 / 60))}:${String(((s.time % 60) + 60) % 60).padStart(2, '0')}` : (lane.start || '');
        const quien = r && r.delegada ? `delegada${r.delegName ? ' a ' + corto(r.delegName) : ''}` : r && r.tomar ? 'para tomar' : r && r.driverId ? corto(nombreConductor(r.driverId)) : 'sin conductor';
        return { cls: 'ok', txt: `Va en ${lane.car} · ${h}${quien ? ' · ' + quien : ''}` };
      }
      if (k) return { cls: 'warn', txt: 'Sin carro en el tablero', act: 'ubicar', crew: k };
      return { cls: 'warn', txt: 'Pidió después de que abriste el día: no está en el tablero', act: 'recargar' };
    }
    if (f.vuelta) return { cls: 'ok', txt: `En la app: vuelta de las ${hm(f.vuelta.at)}${f.vuelta.delegada ? ' · delegada' : f.vuelta.para_tomar ? ' · para tomar' : f.vuelta.conductor ? ' · ' + corto(f.vuelta.conductor) : ' · sin conductor'}` };
    return { cls: 'warn', txt: 'Sin vuelta publicada' };
  }
  function nombreConductor(id) {
    const R = typeof rt !== 'undefined' ? rt : null;
    const d = R && (R.drivers || []).find((x) => x.id === id);
    return d ? d.n : 'Conductor';
  }

  function filaHTML(f, nueva) {
    const c = comoQueda(f);
    const boton = c.act === 'ubicar' ? `<button class="rv2-btn rv2-btn--sm" data-act="route" data-crew="${esc(c.crew)}">Ubicar</button>`
      : c.act === 'recargar' ? '<button class="rv2-btn rv2-btn--sm" data-cambios="recargar">Recargar el día</button>' : '';
    return `<li class="rc-row${nueva ? ' is-new' : ''}" data-kind="${esc(f.kind)}">`
      + `<span class="rc-at">${esc(cuando(f.at))}${nueva ? '<em>Nuevo</em>' : ''}</span>`
      + `<span class="rc-que"><b>${esc(corto(f.name))}</b> ${esc(queCambio(f))}</span>`
      + `<span class="rc-ahora rc-ahora--${c.cls}">${esc(c.txt)}</span>${boton}</li>`;
  }
  function pintarHoja() {
    const cont = document.getElementById('rc-body'); if (!cont) return;
    if (st.error && !st.filas) { cont.innerHTML = `<p class="rv2-impact">No se pudieron leer los cambios: ${esc(st.error)}.</p>`; return; }
    if (!st.filas) { cont.innerHTML = '<p class="rv2-impact">Leyendo los cambios…</p>'; return; }
    if (st.sinBase) { cont.innerHTML = '<p class="rv2-impact">Para ver los cambios falta la actualización 0153 de la base.</p>'; return; }
    const v = st.vistoAlAbrir || '';
    const todos = deTripulantes();
    const tarde = todos.filter((f) => f.tarde), antes = todos.filter((f) => !f.tarde);
    const sinCarro = tarde.filter((f) => comoQueda(f).cls !== 'ok').length;
    let h = `<p class="rc-sum">${tarde.length ? `<b>${tarde.length} ${tarde.length === 1 ? 'cambio' : 'cambios'} después del corte</b>` : '<b>Sin cambios después del corte</b>'}`
      + (sinCarro ? ` · <span class="rc-ahora--warn">${sinCarro} por revisar</span>` : '') + '</p>';
    h += tarde.length ? `<ul class="rc-list">${tarde.map((f) => filaHTML(f, despues(f.at, v))).join('')}</ul>`
      : '<p class="rv2-impact">Nadie ha pedido, cancelado ni cambiado nada para este día desde el corte.</p>';
    if (antes.length) {
      h += `<button class="rv2-linkbtn rv2-linkbtn--ink" data-cambios="antes" aria-expanded="${st.verAntes}">${st.verAntes ? 'Ocultar' : 'Ver'} ${antes.length} de antes del corte (ya venían en el Excel)</button>`;
      if (st.verAntes) h += `<ul class="rc-list rc-list--antes">${antes.map((f) => filaHTML(f, false)).join('')}</ul>`;
    }
    cont.innerHTML = h;
  }
  async function abrir() {
    const v2 = V2(); const S = v2 && v2._sheet; if (!S) return;
    const dia = (typeof rt !== 'undefined' && rt.day) || (v2.diaActual && v2.diaActual()) || st.dia;
    if (!dia) return;
    if (st.dia !== dia) { st.dia = dia; st.filas = null; }
    st.vistoAlAbrir = visto(dia);
    st.abierto = true; st.verAntes = false;
    S.open(S.head(`Cambios de los tripulantes · ${esc(diaTxt(dia))}`, 'Lo que pidieron, cancelaron o cambiaron en la app para este día, y cómo quedó en el tablero. «Nuevo» = desde la última vez que lo abriste.')
      + '<div class="rv2-sh-body rc-body" id="rc-body"></div>'
      + '<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cerrar</button><button class="rv2-btn" data-cambios="leer">Actualizar</button></div>');
    pintarHoja();
    await leer(dia, true);
    marcarVisto(dia);
    pintarBoton();
  }
  // La hoja se cierra (cualquier botón que la cierre): deja de repintarse.
  function cerrada() { const sh = document.getElementById('rv2-sheet'); return !sh || sh.hidden || !document.getElementById('rc-body'); }

  let atado = false;
  function atar() {
    if (atado) return; atado = true;
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('#rv2-cambios'); if (b) { e.preventDefault(); abrir(); return; }
      const x = e.target.closest && e.target.closest('[data-cambios]'); if (!x) { if (st.abierto && cerrada()) st.abierto = false; return; }
      const k = x.getAttribute('data-cambios');
      if (k === 'antes') { st.verAntes = !st.verAntes; pintarHoja(); }
      else if (k === 'leer') leer(st.dia, true);
      else if (k === 'recargar') {
        const v2 = V2(); const S = v2 && v2._sheet;
        if (S) S.close();
        st.abierto = false;
        if (v2 && typeof v2.cargarDia === 'function') v2.cargarDia(st.dia);
      }
    });
    // Mientras Asignación está a la vista, se vuelve a leer cada 90 s (el número del botón).
    if (typeof setInterval === 'function') setInterval(() => {
      const b = btn();
      if (!b || !st.dia || (typeof document !== 'undefined' && document.hidden)) return;
      const r = document.getElementById('routes-v2');
      if (!r || r.hidden) return;
      leer(st.dia, true);
    }, 90000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', atar); else atar();

  // cuando y _queCambio también los usa Reservas › Cambios (admin-reservas.js, 28-oct).
  W.RendioCambios = { pintar, abrir, leer, cuando, _st: st, _queCambio: queCambio };
})();
