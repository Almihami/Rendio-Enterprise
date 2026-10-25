// admin-tiempos-reales.js — Rutas › Configuración › Calibración › «Tiempos reales
// de los viajes» (0116, 24-oct-2026).
//
// La tabla que se llena SOLA con las marcas de los conductores («llegué», «a
// bordo», «entregado»). La base convierte esas marcas en tramos medidos cada
// hora (collect_trip_legs, pg_cron) y aquí se muestran ya contados
// (admin_learned_times): con cuánto margen llegan al aeropuerto, si el plan
// acierta la hora en la puerta, cuánto dura de verdad el tramo final y la vuelta
// completa al lado de la tabla de Julián, las llegadas, cada conjunto, cuánto
// tarda la gente en bajar y quién marca a destiempo.
//
// NO CAMBIA CÓMO SE PLANEA. El optimizador sigue con su cálculo + la tabla de
// Julián; esto primero se compara. Se carga solo cuando el jefe abre la tarjeta.
//
// Contrato (cuelga de window.Api, como api-jefe.js):
//   Api.learnedTimes(dias, minimo) → lo que devuelve admin_learned_times
//   Api.collectTripLegs()          → { vueltas, tramos, dudosos } («Medir ahora»)
//
// Módulo cerrado (IIFE): no declara nada en el ámbito global salvo
// window.RendioTiemposReales.
(function () {
  'use strict';

  const MINIMO = 10;                        // viajes para que una celda sea confiable
  const st = { dias: 120, dia: 'normal', datos: null, cargando: false, error: null, cargado: false, abiertas: new Set() };

  // ── Datos ────────────────────────────────────────────────────────────────
  async function learnedTimes(dias, minimo) {
    const { data, error } = await window.sb.rpc('admin_learned_times', { p_days: dias, p_min: minimo });
    if (error) throw error;
    return data || null;
  }
  async function collectTripLegs() {
    const { data, error } = await window.sb.rpc('admin_collect_trip_legs');
    if (error) throw error;
    return data || null;
  }
  if (window.Api) Object.assign(window.Api, { learnedTimes, collectTripLegs });

  // ── Formato ──────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const min = (v) => { const n = num(v); return n == null ? '—' : `${n} min`; };
  const conSigno = (v) => { const n = num(v); return n == null ? '—' : (n > 0 ? `+${n}` : String(n)) + ' min'; };
  const h12 = (n) => n === 0 || n === 24 ? '12 a.m.' : n === 12 ? '12 m.' : n < 12 ? `${n} a.m.` : `${n - 12} p.m.`;
  function franjaTxt(desde) {
    const f = ((st.datos && st.datos.franjas) || []).find((x) => x.desde === desde);
    return f ? `${h12(f.desde)} – ${h12(f.hasta)}` : (desde == null ? '—' : h12(desde));
  }
  function haceTxt(iso) {
    if (!iso) return null;
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'hace un momento';
    if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} días`;
  }
  function fechaHora(iso) {
    try {
      return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    } catch (_) { return ''; }
  }
  const pocos = (n) => num(n) < MINIMO;
  // «Sendai → Olivar»; en la espera y la puerta es un solo sitio. Sin conjunto
  // del lado del aeropuerto se dice «aeropuerto».
  function lugarTxt(d) {
    if (d.kind === 'espera' || d.kind === 'puerta') return d.res_from || d.res_to || '';
    const a = d.res_from || (['aeropuerto_casa', 'vuelta_llegada'].includes(d.kind) ? 'aeropuerto' : '');
    const b = d.res_to || (['casa_aeropuerto', 'vuelta_salida'].includes(d.kind) ? 'aeropuerto' : '');
    return [a, b].filter(Boolean).join(' → ');
  }
  const viajes = (n) => `${n} ${Number(n) === 1 ? 'viaje' : 'viajes'}`;
  const KIND_TXT = {
    espera: 'Espera en la puerta', puerta: 'Llegada a la puerta', casa_casa: 'Entre casas',
    casa_aeropuerto: 'Tramo final', vuelta_salida: 'Vuelta de salida', aeropuerto_casa: 'Aeropuerto → casa', vuelta_llegada: 'Vuelta de llegada',
  };

  // «Cabe en su número» / «Lo real pasa su número»: el mal día contra el número
  // de Julián. Su número es para PROGRAMAR (lleva colchón), así que si un mal
  // día real lo pasa, ahí está el riesgo.
  function chipContra(p90, julian, n) {
    const r = num(p90), j = num(julian);
    if (r == null || j == null) return '';
    // Con pocos viajes no se afirma nada: un solo mal día no es una tendencia.
    if (pocos(n)) return `<span class="rl-chip muted" title="Hacen falta ${MINIMO} viajes para comparar">Pocos viajes</span>`;
    return r > j
      ? `<span class="rl-chip bad" title="Un mal día real (${r} min) pasa el número de Julián (${j} min)">Lo real pasa su número</span>`
      : `<span class="rl-chip ok" title="Un mal día real (${r} min) cabe en el número de Julián (${j} min)">Cabe</span>`;
  }
  // Celda con el valor típico y el de un mal día; tenue si hay pocos viajes.
  const celdaReal = (r) => `<td class="${pocos(r.n) ? 'rl-pocos' : ''}" title="${pocos(r.n) ? `Pocos viajes: todavía no es confiable (mínimo ${MINIMO})` : ''}">`
    + `<b>${min(r.mediana)}</b><small>mal día ${min(r.p90)}</small></td>`;
  const tabla = (cabeza, filas, vacio) => filas.length
    ? `<div class="rl-scroll"><table class="set-matrix rl-tabla"><tr>${cabeza.map((h, i) => `<th${i === 0 ? ' class="franja"' : ''}>${h}</th>`).join('')}</tr>${filas.join('')}</table></div>`
    : `<p class="rl-vacio">${vacio}</p>`;
  const seccion = (titulo, ayuda, cuerpo) => `<section class="rl-sec"><h3>${titulo}</h3>${ayuda ? `<p class="set-hint rl-ayuda">${ayuda}</p>` : ''}${cuerpo}</section>`;
  // Las de detalle van plegadas (el acordeón de Ajustes, .set-sec): cerradas
  // siguen diciendo cuánto hay adentro. Se recuerda cuáles abrió el jefe para
  // que cambiar de período o de tipo de día no se las cierre.
  const plegable = (clave, titulo, valor, ayuda, cuerpo) =>
    `<details class="set-sec rl-pleg" data-rl-sec="${clave}"${st.abiertas.has(clave) ? ' open' : ''}>`
    + `<summary><span class="set-sec-t">${titulo}</span><span class="set-sec-val">${esc(valor || '')}</span><svg class="icon details-chevron"><use href="#i-chev"/></svg></summary>`
    + `<div class="set-sec-body">${ayuda ? `<p class="set-hint rl-ayuda">${ayuda}</p>` : ''}${cuerpo}</div></details>`;
  const suma = (arr) => (arr || []).reduce((s, x) => s + Number(x.n || 0), 0);

  // ── Pintar ───────────────────────────────────────────────────────────────
  function pintar() {
    const root = document.getElementById('rl-root');
    if (!root) return;
    if (st.cargando && !st.datos) { root.innerHTML = '<p class="rl-vacio">Contando los viajes…</p>'; return; }
    if (st.error) {
      root.innerHTML = `<p class="rl-vacio">${/admin_learned_times|function|does not exist|404/i.test(st.error)
        ? 'Esta base de datos todavía no tiene la medición de tiempos (migración 0116).'
        : 'No se pudo leer: ' + esc(st.error)}</p>`;
      return;
    }
    const D = st.datos;
    if (!D) { root.innerHTML = ''; return; }
    const R = D.resumen || {};
    const dia = st.dia;
    const delDia = (arr) => (arr || []).filter((x) => !x.day_type || x.day_type === dia);

    // Barra: cuándo midió, período y «Medir ahora».
    const hace = haceTxt(D.ultima_medicion);
    const horas = D.ultima_medicion ? (Date.now() - new Date(D.ultima_medicion).getTime()) / 3600000 : null;
    const reloj = horas == null
      ? '<span class="rl-dot bad"></span>Todavía no ha corrido ninguna medición'
      : `<span class="rl-dot ${horas > 3 ? 'bad' : 'ok'}"></span>Última medición ${esc(hace)}`;
    const barra = `<div class="rl-bar">
        <div class="rl-reloj">${reloj}</div>
        <select class="rl-sel" id="rl-dias" aria-label="Período">
          ${[30, 60, 120, 365].map((d) => `<option value="${d}"${d === st.dias ? ' selected' : ''}>Últimos ${d} días</option>`).join('')}
        </select>
        <button class="set-btn ghost sm" id="rl-medir" ${st.cargando ? 'disabled' : ''}><svg class="icon"><use href="#i-refresh"/></svg>${st.cargando ? 'Midiendo…' : 'Medir ahora'}</button>
      </div>`
      + (horas != null && horas > 3
        ? `<p class="rl-alerta">La medición automática no corre desde ${esc(hace)}. Debería correr cada hora: hay que revisar el reloj del servidor (collect-trip-legs).</p>`
        : '');

    const hayAlgo = Number(R.vueltas || 0) + Number(R.tramos || 0) + Number(R.dudosos || 0) > 0;
    if (!hayAlgo) {
      root.innerHTML = barra + `<div class="rl-empty">
          <b>Todavía no hay viajes medidos.</b>
          <p>Cuando los conductores marquen <b>«llegué»</b>, <b>«a bordo»</b> y <b>«entregado»</b> en la app, cada viaje entra aquí solo: se mide cada hora, o al tocar «Medir ahora». Las marcas tienen que hacerse en el momento: si se hacen todas juntas al final, el tiempo sale falso y el viaje queda como dudoso.</p>
        </div>`;
      enganchar(root);
      return;
    }

    // Tarjetas de arriba.
    const margen = D.margen || [];
    const vueltasAero = margen.reduce((s, x) => s + Number(x.n || 0), 0);
    const tarde = margen.reduce((s, x) => s + Number(x.tarde || 0), 0);
    const justo = margen.reduce((s, x) => s + Number(x.justo || 0), 0);
    const puertas = D.puerta || [];
    const nPuertas = puertas.reduce((s, x) => s + Number(x.n || 0), 0);
    const puertasTarde = puertas.reduce((s, x) => s + Number(x.tarde || 0), 0);
    const totalMarcas = (D.conductores || []).reduce((s, x) => s + Number(x.total || 0), 0);
    const pctDud = totalMarcas ? Math.round(100 * Number(R.dudosos || 0) / totalMarcas) : 0;
    const kpis = `<div class="rl-kpis">
        <div class="rl-kpi"><em>Vueltas medidas</em><b>${R.vueltas || 0}</b><small>${R.vueltas_ok || 0} confiables${R.desde ? ` · desde ${esc(fechaCorta(R.desde))}` : ''}</small></div>
        <div class="rl-kpi ${tarde ? 'bad' : ''}"><em>Llegaron tarde al aeropuerto</em><b>${tarde}</b><small>de ${vueltasAero} salidas${justo ? ` · ${justo} con menos de 10 min` : ''}</small></div>
        <div class="rl-kpi ${puertasTarde ? 'warn' : ''}"><em>El carro llegó tarde a la puerta</em><b>${puertasTarde}</b><small>más de 5 min tarde, de ${nPuertas}</small></div>
        <div class="rl-kpi ${pctDud > 20 ? 'warn' : ''}"><em>Marcas dudosas</em><b>${R.dudosos || 0}</b><small>${pctDud}% de lo medido · no entran en las cuentas</small></div>
      </div>`;

    const seg = `<div class="rl-segrow"><span class="rl-seglbl">Tramos y vueltas de</span><div class="rl-seg" role="tablist" aria-label="Tipo de día">
        <button type="button" data-rl-dia="normal" class="${dia === 'normal' ? 'on' : ''}">Día normal</button>
        <button type="button" data-rl-dia="festivo" class="${dia === 'festivo' ? 'on' : ''}">Domingo y festivo</button>
      </div></div>`;

    // 1. Margen en el aeropuerto.
    const sMargen = seccion('¿Llegan a tiempo al aeropuerto?',
      'Minutos entre la llegada real al aeropuerto y la hora de presentación. Negativo = llegaron tarde. Solo salidas, todos los días.',
      tabla(['Franja de la presentación', 'Salidas', 'Margen típico', 'El más justo', 'Tarde', 'Menos de 10 min'],
        margen.map((r) => `<tr><td class="franja">${franjaTxt(r.band)}</td><td>${r.n}</td><td><b>${min(r.mediana)}</b></td>`
          + `<td class="${num(r.peor) < 0 ? 'rl-bad' : num(r.peor) < 10 ? 'rl-warn' : ''}">${min(r.peor)}</td>`
          + `<td class="${r.tarde ? 'rl-bad' : ''}">${r.tarde}</td><td class="${r.justo ? 'rl-warn' : ''}">${r.justo}</td></tr>`),
        'Sin salidas medidas de punta a punta.'));

    // 2. Plan vs. real en la puerta.
    const sPuerta = seccion('¿El plan acierta la hora en la puerta?',
      'Diferencia entre la hora que dijo el plan y la hora en que el carro marcó «llegué» en la casa. Positivo = llegó después de lo planeado.',
      tabla(['Franja', 'Puertas', 'Típico', 'Mal día', 'Más de 5 min tarde', 'Más de 5 min antes'],
        puertas.map((r) => `<tr><td class="franja">${franjaTxt(r.band)}</td><td>${r.n}</td><td><b>${conSigno(r.mediana)}</b></td><td>${conSigno(r.p90)}</td>`
          + `<td class="${r.tarde ? 'rl-warn' : ''}">${r.tarde}</td><td>${r.temprano}</td></tr>`),
        'Sin puertas con hora de plan y «llegué» marcado.'));

    // 3. Tramo final contra su regla.
    const tf = delDia(D.tramo_final);
    const tfTodas = tf.filter((r) => r.zona === 'Todas');
    const tfZonas = tf.filter((r) => r.zona !== 'Todas');
    const jul = (r) => r.julian_min == null ? '—' : (r.julian_min === r.julian_max ? `${r.julian_min} min` : `${r.julian_min}–${r.julian_max} min`);
    const sTramo = plegable('tramo', 'Tramo final: de la última recogida al aeropuerto', viajes(suma(tfTodas)),
      'Al lado, la segunda regla de Julián para esa franja. Su número es para programar (lleva colchón); si un mal día real lo pasa, ahí está el riesgo.',
      tabla(['Franja', 'Julián', 'Real', 'Viajes', ''],
        tfTodas.map((r) => `<tr><td class="franja">${franjaTxt(r.band)}</td><td>${jul(r)}</td>${celdaReal(r)}<td>${r.n}</td><td>${chipContra(r.p90, r.julian_max, r.n)}</td></tr>`),
        'Sin tramos finales medidos ' + (dia === 'normal' ? 'en días normales.' : 'en domingos o festivos.'))
      + (tfZonas.length ? `<p class="rl-sub">Por zona</p>` + tabla(['Zona', 'Franja', 'Real', 'Viajes'],
        tfZonas.map((r) => `<tr><td class="franja">${esc(r.zona)}</td><td>${franjaTxt(r.band)}</td>${celdaReal(r)}<td>${r.n}</td></tr>`), '') : ''));

    // 4. Vuelta completa contra su tabla de zona.
    const vu = delDia(D.vuelta);
    const sVuelta = plegable('vuelta', 'Vuelta completa: de la primera recogida al aeropuerto', viajes(suma(vu)),
      'La zona es la de la primera recogida. Al lado, el número de su tabla para esa zona, franja y cantidad de gente (1 → mínimo · 2 → medio · 3 o más → máximo).',
      tabla(['Zona', 'Franja', 'Gente', 'Julián', 'Real', 'Viajes', ''],
        vu.map((r) => `<tr><td class="franja">${esc(r.zona)}</td><td>${franjaTxt(r.band)}</td><td>${esc(r.gente)}</td><td>${min(r.julian)}</td>${celdaReal(r)}<td>${r.n}</td><td>${chipContra(r.p90, r.julian, r.n)}</td></tr>`),
        'Sin vueltas de salida medidas ' + (dia === 'normal' ? 'en días normales.' : 'en domingos o festivos.')));

    // 5. Llegadas.
    const ll = delDia(D.llegadas);
    const sLlegadas = plegable('llegadas', 'Llegadas: del aeropuerto a la primera casa', viajes(suma(ll)),
      'Desde que sube el último al carro hasta la primera entrega. La franja es la de la salida del aeropuerto.',
      tabla(['Zona de la casa', 'Franja', 'Real', 'Viajes'],
        ll.map((r) => `<tr><td class="franja">${esc(r.zona)}</td><td>${franjaTxt(r.band)}</td>${celdaReal(r)}<td>${r.n}</td></tr>`),
        'Sin llegadas medidas ' + (dia === 'normal' ? 'en días normales.' : 'en domingos o festivos.')));

    // 6. Por conjunto.
    const cj = delDia(D.conjuntos).slice(0, 25);
    const sConj = plegable('conjuntos', 'Por conjunto: de la recogida al aeropuerto', `${new Set(cj.map((r) => r.conjunto)).size} conjuntos`,
      'El dato más fino: sirve aunque el conjunto no tenga zona. Cuando la última recogida de una vuelta fue ahí.',
      tabla(['Conjunto', 'Franja', 'Real', 'Viajes'],
        cj.map((r) => `<tr><td class="franja">${esc(r.conjunto)}</td><td>${franjaTxt(r.band)}</td>${celdaReal(r)}<td>${r.n}</td></tr>`),
        'Sin datos por conjunto todavía.'));

    // 7. Espera.
    const es = (D.espera || []).slice(0, 20);
    const sEspera = plegable('espera', '¿Cuánto tardan en bajar?', `${es.length} conjuntos`,
      'De «llegué» a «a bordo», por conjunto. No es tráfico: es lo que el carro espera en la puerta.',
      tabla(['Conjunto', 'Veces', 'Típico', 'Mal día'],
        es.map((r) => `<tr class="${pocos(r.n) ? 'rl-pocos' : ''}"><td class="franja">${esc(r.conjunto)}</td><td>${r.n}</td><td><b>${min(r.mediana)}</b></td><td>${min(r.p90)}</td></tr>`),
        'Sin esperas medidas todavía.'));

    // 8. Marcas a destiempo.
    const cond = (D.conductores || []).filter((x) => Number(x.total) > 0);
    const dud = D.dudosos || [];
    const sDud = plegable('dudosos', 'Marcas a destiempo', `${R.dudosos || 0} dudosos`,
      'Un tramo queda dudoso cuando la marca no cuadra con el GPS del carro (marcó lejos del punto), cuando dos marcas de sitios distintos salieron casi juntas o cuando duró demasiado. No entra en las cuentas. Sirve para enseñarle a cada conductor a marcar en el momento.',
      tabla(['Conductor', 'Medidos', 'Dudosos', ''],
        cond.map((r) => {
          const p = Number(r.total) ? Math.round(100 * Number(r.dudosos) / Number(r.total)) : 0;
          return `<tr><td class="franja">${esc(r.nombre)}</td><td>${r.total}</td><td class="${p > 20 ? 'rl-warn' : ''}">${r.dudosos}</td><td><span class="rl-barra"><i style="width:${p}%"></i></span> ${p}%</td></tr>`;
        }),
        'Ningún conductor con marcas todavía.')
      + (dud.length ? `<p class="rl-sub">Los últimos dudosos</p><ul class="rl-lista">${dud.map((d) => `<li>
          <span class="rl-li-t">${esc(fechaHora(d.cuando))} · ${esc(d.conductor)} · ${esc(KIND_TXT[d.kind] || d.kind)}${lugarTxt(d) ? ` · ${esc(lugarTxt(d))}` : ''}</span>
          <span class="rl-li-m">${esc(d.motivo || '')}</span></li>`).join('')}</ul>` : ''));

    root.innerHTML = barra + kpis
      + `<p class="set-hint rl-nota">Esto <b>todavía no cambia cómo se planea</b>: el optimizador sigue con su cálculo y la tabla de Julián. Aquí se compara. Una celda es confiable desde ${MINIMO} viajes; antes se ve tenue.</p>`
      + sMargen + sPuerta + seg + `<div class="rl-plegables">${sTramo + sVuelta + sLlegadas + sConj + sEspera + sDud}</div>`;
    enganchar(root);
  }
  function fechaCorta(ymd) {
    try {
      return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' }).format(new Date(ymd + 'T12:00:00'));
    } catch (_) { return ymd; }
  }

  function enganchar(root) {
    const sel = root.querySelector('#rl-dias');
    if (sel) sel.addEventListener('change', () => { st.dias = Number(sel.value) || 120; cargar(); });
    const med = root.querySelector('#rl-medir');
    if (med) med.addEventListener('click', medirAhora);
    root.querySelectorAll('details[data-rl-sec]').forEach((d) => d.addEventListener('toggle', () => {
      if (d.open) st.abiertas.add(d.dataset.rlSec); else st.abiertas.delete(d.dataset.rlSec);
    }));
    root.querySelectorAll('[data-rl-dia]').forEach((b) => b.addEventListener('click', () => {
      st.dia = b.dataset.rlDia === 'festivo' ? 'festivo' : 'normal';
      pintar();
    }));
  }

  async function cargar() {
    st.cargando = true; st.error = null; pintar();
    try { st.datos = await learnedTimes(st.dias, MINIMO); st.cargado = true; }
    catch (e) { st.error = (e && e.message) || String(e); }
    st.cargando = false; pintar();
  }
  async function medirAhora() {
    if (st.cargando) return;
    st.cargando = true; pintar();
    try {
      const r = await collectTripLegs();
      if (typeof toast === 'function' && r) toast(`Medidas ${r.vueltas} vueltas · ${r.tramos} tramos${r.dudosos ? ` · ${r.dudosos} dudosos` : ''}`, 'Check');
    } catch (e) {
      if (typeof toast === 'function') toast('No se pudo medir: ' + ((e && e.message) || 'error'), 'AlertTriangle');
    }
    st.cargando = false;
    await cargar();
  }

  // Se carga la primera vez que la tarjeta se abre (también cuando Calibración
  // la abre sola porque quedó abierta la última vez: el evento toggle salta igual).
  function init() {
    const card = document.getElementById('rl-card');
    if (!card || card.dataset.rlListo === '1') return;
    card.dataset.rlListo = '1';
    card.addEventListener('toggle', () => { if (card.open && !st.cargado && !st.cargando) cargar(); });
    if (card.open && !st.cargado) cargar();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.RendioTiemposReales = { cargar, pintar, _st: st };
})();
