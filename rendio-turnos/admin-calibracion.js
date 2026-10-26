// admin-calibracion.js — Rutas › Configuración › Calibración: los 26 tornillos del
// optimizador y la tabla de tiempos de Julián (la zona de cada conjunto se pone
// en Conjuntos, admin-conjuntos.js).
// Salió de admin-personal.js (mudanza 2026-09-12, sin cambios de lógica): la pantalla
// ya se había partido en tres en septiembre, pero el código seguía todo junto y
// Calibración era la mitad de un archivo que se llama "personal" y no habla de gente.
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
//
// OJO con lo que NO se vino: los helpers set* (setTarjetaDe, setPrepararBloque,
// setGuardarBloque y compañía) se quedaron en admin-personal.js porque los usan los
// TRES módulos de Ajustes. Duplicarlos acá sería un SyntaxError, no una copia: todos
// estos archivos comparten un único scope global y el mismo nombre no se puede
// declarar dos veces. Desde acá se llaman igual que siempre, sin importar el archivo.
  // Rutas › Configuración › Calibración — los 26 del optimizador, más la tabla de
  // tiempos y las zonas, que son la otra mitad del mismo cálculo.
  function renderCalibracion() {
    const S = state.settings;
    if ($('#setting-aux-wait')) $('#setting-aux-wait').value = S.aux_wait_minutes != null ? S.aux_wait_minutes : 5;
    if ($('#setting-aux-lead')) $('#setting-aux-lead').value = S.aux_min_lead_hours != null ? S.aux_min_lead_hours : 6;
    // 0130: corte de pedidos. Lectura propia como el de la madrugada; sin la
    // columna el campo se apaga y se explica (el corte sigue siendo 7:40 p. m.).
    const cc = $('#setting-aux-cutoff');
    if (cc) {
      const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      cc.disabled = true; cc.value = hhmm(1180);
      const nota = $('#setting-aux-cutoff-off'); if (nota) nota.hidden = true;
      const pinta = (c) => {
        const hay = !!(c && c.enBase);
        cc.disabled = !hay; cc.value = hhmm(c && c.corte != null ? c.corte : 1180);
        if (nota) nota.hidden = hay;
        if (typeof setRepintarValores === 'function') setRepintarValores('calib');
      };
      if (window.Api && typeof Api.getRequestCutoff === 'function') Api.getRequestCutoff().then(pinta).catch(() => pinta(null));
      else pinta(null);
    }
    // 0069 · traslado privado. El desplegable de vehículos se llena aparte
    // (es una consulta), pero el valor se deja puesto para que al llegar la
    // lista quede seleccionado el que ya estaba.
    if ($('#setting-priv-enabled')) $('#setting-priv-enabled').checked = S.aux_private_enabled === true;
    if ($('#setting-priv-price')) $('#setting-priv-price').value = S.aux_private_price_cop != null ? S.aux_private_price_cop : 50000;   // 0103: default $50.000
    if ($('#setting-priv-block')) $('#setting-priv-block').value = S.aux_private_block_min != null ? S.aux_private_block_min : 90;
    if ($('#setting-route-merge')) $('#setting-route-merge').value = S.route_merge_window_min != null ? S.route_merge_window_min : 30;
    if ($('#setting-route-service')) $('#setting-route-service').value = S.route_service_min != null ? S.route_service_min : 3;
    if ($('#setting-route-traffic')) $('#setting-route-traffic').value = S.route_traffic_factor != null ? S.route_traffic_factor : 1.05;
    if ($('#setting-route-buffer')) $('#setting-route-buffer').value = S.route_airport_buffer_min != null ? S.route_airport_buffer_min : 10;
    if ($('#setting-route-aero')) $('#setting-route-aero').value = S.route_airport_factor != null ? S.route_airport_factor : 0.8;
    if ($('#setting-route-wait')) $('#setting-route-wait').value = S.route_max_wait_min != null ? S.route_max_wait_min : 0;
    if ($('#setting-route-wait-peak')) $('#setting-route-wait-peak').value = S.route_max_wait_peak_min != null ? S.route_max_wait_peak_min : 0;
    // Desembarque por aerolínea (0058).
    if ($('#setting-deplane-av-nac')) $('#setting-deplane-av-nac').value = S.route_deplane_av_nac_min != null ? S.route_deplane_av_nac_min : 15;
    if ($('#setting-deplane-av-int')) $('#setting-deplane-av-int').value = S.route_deplane_av_int_min != null ? S.route_deplane_av_int_min : 20;
    if ($('#setting-deplane-js-nac')) $('#setting-deplane-js-nac').value = S.route_deplane_js_nac_min != null ? S.route_deplane_js_nac_min : 25;
    if ($('#setting-deplane-js-int')) $('#setting-deplane-js-int').value = S.route_deplane_js_int_min != null ? S.route_deplane_js_int_min : 30;
    if ($('#setting-deplane-wingo')) $('#setting-deplane-wingo').value = S.route_deplane_wingo_min != null ? S.route_deplane_wingo_min : 20;
    if ($('#setting-deplane-fallback')) $('#setting-deplane-fallback').value = S.route_deplane_min != null ? S.route_deplane_min : 20;
    // 0062: corrimiento de domingos y festivos. 0 es válido, así que no se usa `||`.
    if ($('#setting-holiday-shift')) $('#setting-holiday-shift').value = S.route_holiday_shift_min != null ? S.route_holiday_shift_min : 0;
    // 0107: corte de la madrugada (vueltas del turno PM del día anterior). Sin la
    // columna el campo se apaga: guardar no lo manda y el tablero usa 02:00.
    const nc = $('#setting-night-cutoff');
    if (nc) {
      // Lectura propia (Api.getRouteNightCutoff): getSettings es una sola consulta.
      // Mientras llega, el campo queda apagado con el valor de siempre.
      nc.disabled = true; nc.value = '120';
      const nota = $('#setting-night-cutoff-off'); if (nota) nota.hidden = true;
      const pinta = (v) => {
        const hay = v != null;
        nc.disabled = !hay;
        nc.value = String(hay ? v : 120);
        if (nota) nota.hidden = hay;
        if (typeof setRepintarValores === 'function') setRepintarValores('calib');
      };
      if (window.Api && typeof Api.getRouteNightCutoff === 'function') Api.getRouteNightCutoff().then(pinta).catch(() => pinta(null));
      else pinta(null);
    }
    // 0071: colchón de la tabla de zona. 0 = usar su tabla completa.
    if ($('#setting-zone-cushion')) $('#setting-zone-cushion').value = S.route_zone_cushion_min != null ? S.route_zone_cushion_min : 25;
    // 0074: cómo despacha él. Sin la migración los campos quedan con el default
    // y guardar sigue funcionando (la cascada de saveSettings baja un escalón).
    if ($('#setting-cars-count')) $('#setting-cars-count').value = S.route_cars_count != null ? S.route_cars_count : 2;
    if ($('#setting-rescue-early')) $('#setting-rescue-early').value = S.route_rescue_early === false ? 0 : (S.route_rescue_max_early_min != null ? S.route_rescue_max_early_min : 45);
    if ($('#setting-car-priority')) $('#setting-car-priority').value = S.route_car_priority === false ? '0' : '1';
    if ($('#setting-max-early')) $('#setting-max-early').value = S.route_max_early_min != null ? S.route_max_early_min : 60;
    if ($('#setting-sweep-tol')) $('#setting-sweep-tol').value = S.route_sweep_tol_min != null ? S.route_sweep_tol_min : 2;
    // Estas tres sí son consultas, y por eso viven acá y no en Ajustes: solo las
    // paga quien viene a calibrar. La de la camioneta NO se aplaza hasta que el
    // jefe despliegue "Traslados de auxiliares": el botón Guardar de esta misma
    // pantalla manda el vehículo, y si el desplegable llegara tarde se guardaría
    // el valor viejo. Ver privVehiculoAGuardar(), que existe por eso mismo.
    fillPrivateVehicles();
    // Zonas (0108): carga la lista y el catálogo una vez y pinta las tres
    // tarjetas que dependen de ellos — el mapa, la tabla y las excepciones.
    zonasRecargar();
    calibAcordeones();
    setPrepararBloque('calib');
  }

  // ---- TARJETAS PLEGABLES (13-oct) -------------------------------------------
  // La pantalla pesaba mucho: Zona de cada conjunto, Tabla de tiempos y
  // Parámetros del optimizador son <details> que nacen cerrados. Se recuerda en
  // ESTE equipo cuáles dejó abiertas el jefe (localStorage; si el navegador no
  // deja guardar, simplemente nacen cerradas).
  const CALIB_ABIERTAS = 'rendio.calib.abiertas';
  function calibAcordeones() {
    let abiertas = [];
    try { abiertas = JSON.parse(localStorage.getItem(CALIB_ABIERTAS) || '[]'); } catch (_) { abiertas = []; }
    document.querySelectorAll('#calib-ui details.set-card-acc[data-acc]').forEach(d => {
      if (d.dataset.accLista === '1') return;   // una sola vez por carga de la app
      d.dataset.accLista = '1';
      d.open = Array.isArray(abiertas) && abiertas.includes(d.dataset.acc);
      d.addEventListener('toggle', () => {
        const ahora = [...document.querySelectorAll('#calib-ui details.set-card-acc[data-acc][open]')].map(x => x.dataset.acc);
        try { localStorage.setItem(CALIB_ABIERTAS, JSON.stringify(ahora)); } catch (_) { /* sin almacenamiento: no se recuerda */ }
      });
    });
  }

  // ---- LA TABLA DE TIEMPOS DE JULIÁN (0062) --------------------------------
  // Desde 0108 las zonas no son fijas: se crean, renombran, dibujan y quitan en
  // la tarjeta «Zonas» (admin-zonas.js) y las columnas salen de route_zones, en
  // su orden. Sin esa migración, de las zonas que tenga la tabla, en el orden en
  // que él las dictó.
  const RT_ZONAS_DICTADAS = ['Fontibón', 'Porvenir', 'Sendai/San Antonio', 'Marinilla'];
  function rtZonasColumnas(t) {
    if (zonasMapa.lista) return zonasMapa.lista.map(z => z.name);
    const pos = (z) => { const i = RT_ZONAS_DICTADAS.indexOf(z); return i < 0 ? 99 : i; };
    return Object.keys((t && t.zonas) || {}).sort((a, b) => pos(a) - pos(b) || a.localeCompare(b, 'es'));
  }
  const RT_FRANJA_LABEL = (f, t) => {
    const h = (n) => n === 0 ? '12 a.m.' : n === 12 ? '12 m.' : n < 12 ? `${n} a.m.` : n === 24 ? '12 a.m.' : `${n - 12} p.m.`;
    return `${h(f)} – ${h(t)}`;
  };
  let rtTablas = null;   // {zonas, tramos} tal como vinieron de la BD

  async function renderRouteTables() {
    const tz = $('#zone-times-table'), tl = $('#leg-times-table'), warn = $('#zone-times-warn');
    if (!tz || !tl) return;
    if (!Api.getRouteTables) { tz.innerHTML = ''; return; }
    let t = null;
    try { t = await Api.getRouteTables(null); } catch (e) { t = null; }
    // Las franjas salen del tramo final, que siempre trae las seis: una zona
    // recién creada todavía no tiene filas de donde sacarlas.
    const base = t ? ((t.tramos || []).length ? t.tramos : (Object.values(t.zonas || {})[0] || [])) : [];
    const franjas = base.map(r => ({ f: r.band_from, to: r.band_to }));
    if (!t || !franjas.length) {
      // Sin la migración: se dice, no se finge una tabla vacía editable.
      tz.innerHTML = '<tr><td class="franja">La tabla todavía no está en esta base de datos.</td></tr>';
      tl.innerHTML = ''; if (warn) warn.textContent = '';
      return;
    }
    rtTablas = t;
    const cols = rtZonasColumnas(t);
    // Una zona sin minutos se ve con las casillas vacías: se llenan aquí mismo.
    const sinMinutos = cols.filter(z => !(t.zonas[z] || []).length);
    const celda = (val, asum, ds) =>
      `<input type="number" min="0" max="240" value="${val == null ? '' : val}" placeholder="—" class="${asum ? 'asumida' : ''}" ${ds} />`;

    tz.innerHTML =
      `<tr><th class="franja">Franja</th>${cols.map(z => `<th>${escapeHtml(z)}${sinMinutos.includes(z) ? '<small class="rz-sinmin">sin minutos</small>' : ''}</th>`).join('')}</tr>` +
      franjas.map(fr => {
        const tds = cols.map(z => {
          const r = (t.zonas[z] || []).find(x => x.band_from === fr.f);
          const d = `data-kind="zona" data-zone="${escapeHtml(z)}" data-band="${fr.f}" data-band-to="${fr.to}"`;
          return `<td>${celda(r ? r.min_minutes : null, r && r.asumida, d + ' data-lim="min"')}<span class="sep">/</span>${celda(r ? r.max_minutes : null, r && r.asumida, d + ' data-lim="max"')}</td>`;
        }).join('');
        return `<tr><td class="franja">${RT_FRANJA_LABEL(fr.f, fr.to)}</td>${tds}</tr>`;
      }).join('');

    tl.innerHTML =
      '<tr><th class="franja">Franja</th><th>Desde la última persona recogida</th></tr>' +
      (t.tramos || []).map(r => {
        const d = `data-kind="tramo" data-band="${r.band_from}"`;
        return `<tr><td class="franja">${RT_FRANJA_LABEL(r.band_from, r.band_to)}</td>`
          + `<td>${celda(r.min_minutes, r.asumida, d + ' data-lim="min"')}<span class="sep">/</span>${celda(r.max_minutes, r.asumida, d + ' data-lim="max"')}</td></tr>`;
      }).join('');

    // Lo que falta confirmarle, dicho sin adornos.
    if (warn) {
      const asum = [...(t.tramos || []), ...Object.values(t.zonas).flat()].filter(r => r.asumida).length;
      const sin = (t.sinConfirmar || []).length;
      const sm = sinMinutos.length;
      warn.innerHTML = [
        asum ? `<b>${asum} casilla${asum > 1 ? 's' : ''} con borde punteado</b>: la franja de 12 a 2 de la mañana no la dictó él, se copió de la de 7 p.m. a 12. Al guardar dejan de estar marcadas.` : '',
        sm ? `<b>${sinMinutos.map(escapeHtml).join(', ')}</b> ${sm > 1 ? 'no tienen' : 'no tiene'} minutos: mientras la columna no esté completa, sus conjuntos se programan con el cálculo por carretera.` : '',
        sin ? `<b>${sin} conjunto${sin > 1 ? 's' : ''} sin zona</b> (ni a mano ni dentro de un dibujo): sus traslados se programan con el cálculo por carretera, no con esta tabla.` : '',
      ].filter(Boolean).join('<br>');
    }
  }

  async function saveRouteTables() {
    if (!rtTablas || !Api.saveRouteTables) return;
    // Zonas: casilla vacía = null, para distinguir «no la ha dado» de un 0.
    const valor = (inp) => {
      const v = String(inp.value).trim();
      return v === '' ? null : Math.min(240, Math.max(0, parseInt(v, 10) || 0));
    };
    const porZona = {}, tramos = [];
    document.querySelectorAll('#zone-times-table input').forEach(inp => {
      const z = inp.dataset.zone, band = Number(inp.dataset.band);
      const filas = porZona[z] = porZona[z] || {};
      const row = filas[band] = filas[band] || { zone: z, band_from: band, band_to: Number(inp.dataset.bandTo) };
      row[inp.dataset.lim === 'min' ? 'min_minutes' : 'max_minutes'] = valor(inp);
    });
    document.querySelectorAll('#leg-times-table input').forEach(inp => {
      const n = Math.min(240, Math.max(0, parseInt(inp.value, 10) || 0));
      const band = Number(inp.dataset.band);
      let row = tramos.find(r => r.band_from === band);
      if (!row) { row = { band_from: band }; tramos.push(row); }
      row[inp.dataset.lim === 'min' ? 'min_minutes' : 'max_minutes'] = n;
    });
    // TODO O NADA POR ZONA. Media columna no se puede aplicar: el tablero no
    // sabría qué hacer en las franjas vacías. Una zona nueva puede quedarse
    // toda en blanco (todavía no tiene minutos); una que ya los tenía, no.
    const zonas = [], incompletas = [], vaciadas = [];
    Object.entries(porZona).forEach(([z, filas]) => {
      const rows = Object.values(filas);
      const llenas = rows.reduce((n, r) => n + (r.min_minutes != null) + (r.max_minutes != null), 0);
      if (llenas === 0) { if ((rtTablas.zonas[z] || []).length) vaciadas.push(z); return; }
      if (llenas < rows.length * 2) { incompletas.push(z); return; }
      zonas.push(...rows);
    });
    if (incompletas.length || vaciadas.length) {
      toast([
        incompletas.length ? `Faltan minutos en ${incompletas.join(', ')}: llena todas sus franjas, o déjala toda en blanco si todavía no los tiene.` : '',
        vaciadas.length ? `${vaciadas.join(', ')} ya tenía minutos y no puede quedar en blanco.` : '',
      ].filter(Boolean).join(' ') + ' No se guardó nada.');
      return;
    }
    // El máximo nunca por debajo del mínimo: la BD lo rechazaría y el admin se
    // quedaría sin saber por qué. Se corrige aquí y se avisa.
    let ajustadas = 0;
    [...zonas, ...tramos].forEach(r => {
      if (r.max_minutes < r.min_minutes) { r.max_minutes = r.min_minutes; ajustadas++; }
    });
    const btn = $('#save-route-tables-btn'); if (btn) btn.disabled = true;
    try {
      await Api.saveRouteTables(zonas, tramos);
      await renderRouteTables();
      toast(ajustadas ? `Tabla guardada (${ajustadas} máximo${ajustadas > 1 ? 's' : ''} subido${ajustadas > 1 ? 's' : ''} al mínimo).` : 'Tabla de tiempos guardada.');
    } catch (e) {
      toast('No se pudo guardar la tabla: ' + (e.message || e));
    } finally { if (btn) btn.disabled = false; }
  }

  // ---- ZONA DE CADA CONJUNTO ---------------------------------------------------
  // La tarjeta de excepciones que vivía aquí se mudó a Rutas › Configuración ›
  // Conjuntos (admin-conjuntos.js, 14-oct-2026): la zona a mano va en el mismo
  // editor que el nombre y el pin del conjunto, para no tener dos listas.

  // Rutas › Configuración › Calibración — los 26 del optimizador (27 columnas:
  // route_rescue_early sale de que la madrugada sea mayor que 0, no de un campo).
  async function onSaveCalibracion() {
    const next = {
      aux_wait_minutes: Math.min(60, Math.max(1, parseInt($('#setting-aux-wait') && $('#setting-aux-wait').value, 10) || 5)),
      // 0 = sin anticipación mínima. `|| 6` lo pisaría, así que se valida aparte.
      aux_min_lead_hours: (() => {
        const n = parseInt($('#setting-aux-lead') && $('#setting-aux-lead').value, 10);
        return isNaN(n) ? 6 : Math.min(72, Math.max(0, n));
      })(),
      // 0069. El vacío del desplegable es null a propósito: "sin camioneta
      // elegida" es un estado válido, y con él la app no ofrece el privado.
      aux_private_enabled: !!($('#setting-priv-enabled') && $('#setting-priv-enabled').checked),
      aux_private_vehicle_id: privVehiculoAGuardar(),
      aux_private_price_cop: Math.max(1, parseInt($('#setting-priv-price') && $('#setting-priv-price').value, 10) || 50000),
      aux_private_block_min: Math.min(480, Math.max(10, parseInt($('#setting-priv-block') && $('#setting-priv-block').value, 10) || 90)),
      // Optimizador. Igual que aux_min_lead_hours, 0 es un valor VÁLIDO
      // (0 = no juntar oleadas), así que `|| default` lo pisaría.
      route_merge_window_min: (() => {
        const n = parseInt($('#setting-route-merge') && $('#setting-route-merge').value, 10);
        return isNaN(n) ? 30 : Math.min(120, Math.max(0, n));
      })(),
      route_service_min: (() => {
        const n = parseInt($('#setting-route-service') && $('#setting-route-service').value, 10);
        return isNaN(n) ? 3 : Math.min(20, Math.max(0, n));
      })(),
      route_traffic_factor: (() => {
        const n = parseFloat($('#setting-route-traffic') && $('#setting-route-traffic').value);
        return isNaN(n) ? 1.05 : Math.min(2, Math.max(1, n));
      })(),
      // 0060: corrige SOLO el tramo a/desde MDE. Va por debajo de 1 a propósito
      // (OSRM sobreestima ese corredor), así que el mínimo no puede ser 1.
      route_airport_factor: (() => {
        const n = parseFloat($('#setting-route-aero') && $('#setting-route-aero').value);
        return isNaN(n) ? 0.8 : Math.min(1.5, Math.max(0.5, n));
      })(),
      // 0061: techo de espera. 0 = sin techo, así que no se usa `|| default`.
      // 0062: corrimiento de domingo/festivo. 0 = tratarlo como día normal.
      ...Object.fromEntries([
        ['route_max_wait_min', '#setting-route-wait'],
        ['route_max_wait_peak_min', '#setting-route-wait-peak'],
        ['route_holiday_shift_min', '#setting-holiday-shift'],
        ['route_zone_cushion_min', '#setting-zone-cushion'],
        ['route_rescue_max_early_min', '#setting-rescue-early'],
        ['route_max_early_min', '#setting-max-early'],
        ['route_sweep_tol_min', '#setting-sweep-tol'],
      ].map(([col, sel]) => {
        const n = parseInt($(sel) && $(sel).value, 10);
        return [col, isNaN(n) ? 0 : Math.min(180, Math.max(0, n))];
      })),
      // 0074: cuántos carros planea el tablero y si se llena un carro antes de
      // sacar el siguiente. El rescate se apaga poniendo la madrugada en 0, que
      // es lo que significa "no adelantar a nadie".
      route_cars_count: (() => {
        const n = parseInt($('#setting-cars-count') && $('#setting-cars-count').value, 10);
        return isNaN(n) ? 2 : Math.min(6, Math.max(1, n));
      })(),
      route_rescue_early: (parseInt($('#setting-rescue-early') && $('#setting-rescue-early').value, 10) || 0) > 0,
      route_car_priority: ($('#setting-car-priority') && $('#setting-car-priority').value) !== '0',
      // Desembarque por aerolínea (0058). Mismo patrón: 0 es válido (un vuelo
      // que suelta a la gente de inmediato), así que no se usa `|| default`.
      ...Object.fromEntries([
        ['route_deplane_av_nac_min', '#setting-deplane-av-nac', 15],
        ['route_deplane_av_int_min', '#setting-deplane-av-int', 20],
        ['route_deplane_js_nac_min', '#setting-deplane-js-nac', 25],
        ['route_deplane_js_int_min', '#setting-deplane-js-int', 30],
        ['route_deplane_wingo_min', '#setting-deplane-wingo', 20],
        ['route_deplane_min', '#setting-deplane-fallback', 20],
      ].map(([col, sel, def]) => {
        const n = parseInt($(sel) && $(sel).value, 10);
        return [col, isNaN(n) ? def : Math.min(90, Math.max(0, n))];
      })),
      route_airport_buffer_min: (() => {
        const n = parseInt($('#setting-route-buffer') && $('#setting-route-buffer').value, 10);
        return isNaN(n) ? 10 : Math.min(45, Math.max(0, n));
      })(),
      // 0130: el corte de pedidos, solo si la base tiene la columna.
      ...(() => {
        const el = $('#setting-aux-cutoff');
        if (!el || el.disabled) return {};
        const m = /^(\d{1,2}):(\d{2})/.exec(el.value || '');
        return m ? { crew_request_cutoff_min: Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2]))) } : {};
      })(),
      // 0107: solo si la base tiene la columna (el campo queda apagado si no).
      ...(() => {
        const el = $('#setting-night-cutoff');
        if (!el || el.disabled) return {};
        const n = parseInt(el.value, 10);
        return { route_night_cutoff_min: isNaN(n) ? 120 : Math.min(240, Math.max(0, n)) };
      })(),
    };
    // ENCENDIDO SIN CAMIONETA NO ES ENCENDIDO. La app ofrece el privado solo si
    // se cumplen las tres: interruptor + camioneta + tarifa (aux-privado.js).
    // Marcar la casilla y dejar el desplegable en «— Sin definir —» se guardaba
    // sin decir nada, y el jefe quedaba viendo el privado «encendido» mientras
    // al tripulante no le salía el paso. Se guarda todo lo demás, esto no, y se
    // dice por qué.
    let avisoPrivado = '';
    if (next.aux_private_enabled && !next.aux_private_vehicle_id) {
      next.aux_private_enabled = false;
      if ($('#setting-priv-enabled')) $('#setting-priv-enabled').checked = false;
      avisoPrivado = 'El traslado privado NO quedó encendido: falta elegir cuál carro es la camioneta. '
        + 'Lo demás sí se guardó.';
    }
    await setGuardarBloque('calib', next, avisoPrivado);
  }
  // Llena el desplegable de "cuál carro es la camioneta" (0069). Se consulta
  // aparte porque es una lectura de la flota, no del objeto de ajustes.
  // Se marca el bloqueado, para que no se elija por error un carro fuera de
  // servicio como vehículo de un servicio que se cobra.
  async function fillPrivateVehicles() {
    const sel = $('#setting-priv-vehicle'); if (!sel) return;
    const actual = state.settings && state.settings.aux_private_vehicle_id;
    // `data-flota` dice si lo que se ve en el desplegable es la flota de verdad.
    // Mientras carga —o si la consulta falló— lo que muestre NO es una elección
    // del jefe, y guardar no puede tomarlo como tal. Ver privVehiculoAGuardar().
    sel.dataset.flota = 'cargando';
    let lista = null;
    try { if (window.Api && Api.listVehiclesBasic) lista = await Api.listVehiclesBasic(); } catch (_) {}
    if (!Array.isArray(lista)) {
      sel.innerHTML = '<option value="">No se pudo cargar la flota</option>';
      sel.dataset.flota = 'fallo';
      setRepintarValores('calib');
      return;
    }
    sel.innerHTML = '<option value="">— Sin definir —</option>' + lista.map(v =>
      '<option value="' + v.id + '"' + (v.id === actual ? ' selected' : '') + '>'
      + (v.plate || '?') + ' · ' + (v.label || '') + ' (' + (v.capacity || '?') + ' puestos)'
      + (v.status === 'blocked' ? ' — BLOQUEADO' : '') + '</option>').join('');
    sel.dataset.flota = 'ok';
    // La pastilla de "Traslados de auxiliares" ya se pintó con el desplegable
    // vacío (esto es una consulta, llega después del render). Sin este repintado,
    // la sección cerrada mentiría: diría «— Sin definir —» con la camioneta puesta.
    setRepintarValores('calib');
  }

  // QUÉ CAMIONETA SE MANDA A GUARDAR.
  //
  // Antes era `select.value || null`, y ahí había un fallo silencioso feo: el
  // desplegable nace VACÍO en index.html y se llena con una consulta aparte
  // (fillPrivateVehicles), sin bloquear el botón de Guardar. Si esa consulta
  // fallaba —o si el jefe alcanzaba a guardar antes de que llegara—, se
  // escribía `aux_private_vehicle_id = NULL` aunque el jefe estuviera cambiando
  // los strikes y no hubiera tocado el privado. Y sin camioneta el privado no
  // se ofrece: quedaba apagado sin que nadie lo apagara, con el interruptor
  // todavía marcado en la pantalla.
  //
  // Ahora: si lo que hay en pantalla no es la flota de verdad, se manda la
  // camioneta que YA estaba guardada. Vaciarla a mano sí vale — eso es una
  // decisión, no un accidente.
  function privVehiculoAGuardar() {
    const sel = $('#setting-priv-vehicle');
    const guardada = (state.settings && state.settings.aux_private_vehicle_id) || null;
    if (!sel || sel.dataset.flota !== 'ok') return guardada;
    return sel.value || null;
  }
