// admin-zonas.js — Rutas › Configuración › Calibración › Zonas (0108, 13-oct-2026).
//
// Las zonas de la tabla de tiempos ya no son cuatro nombres fijos en el código:
// aquí se crean, se DIBUJAN en el mapa, se renombran y se quitan. Así describió
// la profa Barro Blanco: una elipse sobre la vía al aeropuerto.
//
// Cada conjunto toma la zona del dibujo que contiene su punto. Las excepciones
// se ponen a mano más abajo («Zona de cada conjunto», admin-calibracion.js) y
// ganan siempre. La regla vive en zonas-dibujo.js.
//
// El mapa y el dibujo son la pieza compartida de mapa-zonas.js (la misma de
// Cuentas de cobro › Tarifas por sector); aquí van los datos y los botones.
//
// Comparte el ámbito global con los demás módulos (sin IIFE): zonasMapa,
// zonasRecargar y renderZonasCard los usa admin-calibracion.js. Antes de
// agregar un nombre, correr rendio-backend/scripts/_nombres-repetidos.mjs.

  const zonasMapa = {
    lista: null,          // route_zones [{ name, polygon, sort_order }] · null = la base no tiene 0108
    residencias: null,    // catálogo activo [{ id, name, sector, zona_jefe, latitude, longitude }]
    ordenFilas: null,     // orden fijo de la lista de excepciones (ver renderResidenceZones)
    mapa: null,           // crearMapaZonas (mapa-zonas.js)
    renombrando: null,    // nombre de la zona que se está renombrando
    bound: false,
  };
  const zonaEditando = () => (zonasMapa.mapa ? zonasMapa.mapa.editando() : null);

  function zonaColor(name) {
    const i = (zonasMapa.lista || []).findIndex(z => z.name === name);
    return i < 0 ? MAPA_ZONAS_SIN_COLOR : MAPA_ZONAS_COLORES[i % MAPA_ZONAS_COLORES.length];
  }

  // Trae la lista de zonas y el catálogo UNA vez y pinta las tres tarjetas que
  // dependen de ellos: el mapa, la tabla de tiempos y las excepciones.
  async function zonasRecargar() {
    const [lista, res] = await Promise.all([
      Api.listRouteZones ? Api.listRouteZones().catch(() => null) : null,
      Api.listResidencesZones ? Api.listResidencesZones().catch(() => null) : null,
    ]);
    zonasMapa.lista = lista;
    zonasMapa.residencias = res;
    zonasMapa.ordenFilas = null;
    const ed = zonaEditando();
    if (ed && !(lista || []).some(z => z.name === ed.name)) zonasMapa.mapa.terminar();
    renderZonasCard();
    renderRouteTables();
    renderResidenceZones();
  }

  function renderZonasCard() {
    const card = $('#zonas-card');
    if (!card) return;
    zonasEnlazar(card);
    const sinTabla = !zonasMapa.lista;
    $('#zonas-map').classList.toggle('hidden', sinTabla);
    $('#zona-agregar-btn').classList.toggle('hidden', sinTabla);
    if (sinTabla) {
      // Sin la migración: se dice, no se finge un editor que no guarda.
      $('#zonas-lista').innerHTML = '<p class="set-hint">Las zonas dibujadas todavía no están en esta base de datos (falta la migración 0108). Mientras tanto, la zona de cada conjunto se pone a mano abajo.</p>';
      $('#zonas-aviso').innerHTML = '';
      return;
    }
    zonasPintarMapa();
    zonasPintarLista();
    zonasPintarBarra();
  }

  // ---- EL MAPA ---------------------------------------------------------------
  function zonasPintarMapa() {
    if (!zonasMapa.mapa) {
      zonasMapa.mapa = crearMapaZonas({ el: $('#zonas-map'), onCambio: zonasPintarBarra, aviso: toast });
    }
    const dib = zonasMapa.lista || [];
    zonasMapa.mapa.pintar({
      zonas: dib.map(z => ({ name: z.name, polygon: z.polygon, color: zonaColor(z.name) })),
      puntos: (zonasMapa.residencias || []).map(r => {
        const e = zonaEfectiva(r.zona_jefe, dib, r.latitude, r.longitude);
        const doble = !e.zona && e.en.length > 1;
        const como = e.origen === 'mano' ? `${e.zona} (a mano)`
          : e.zona ? `${e.zona} (por el dibujo)`
          : doble ? `en dos zonas: ${e.en.join(', ')}` : 'sin zona';
        return { lat: r.latitude, lng: r.longitude, color: e.zona ? zonaColor(e.zona) : MAPA_ZONAS_SIN_COLOR, doble, texto: `${r.name} · ${como}` };
      }),
    });
    zonasMapa.mapa.ajustar();
  }

  // ---- LA LISTA DE ZONAS -----------------------------------------------------
  function zonasPintarLista() {
    const el = $('#zonas-lista'), aviso = $('#zonas-aviso');
    const dib = zonasMapa.lista || [];
    const cuenta = {};
    let dobles = 0;
    (zonasMapa.residencias || []).forEach(r => {
      const e = zonaEfectiva(r.zona_jefe, dib, r.latitude, r.longitude);
      if (e.zona) cuenta[e.zona] = (cuenta[e.zona] || 0) + 1;
      else if (e.en.length > 1) dobles++;
    });
    const editando = !!zonaEditando();
    const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
    el.innerHTML = dib.length ? dib.map(z => {
      const n = cuenta[z.name] || 0;
      const estado = (z.polygon ? '' : 'sin dibujo · ') + plural(n, 'conjunto', 'conjuntos');
      if (zonasMapa.renombrando === z.name) {
        return `
        <div class="zn-row" data-zona="${escapeHtml(z.name)}">
          <span class="zn-sw" style="background:${zonaColor(z.name)}"></span>
          <div class="zn-info zn-renombrar">
            <input class="zn-input" id="zona-renombrar-input" maxlength="60" value="${escapeHtml(z.name)}" aria-label="Nuevo nombre de la zona" />
            <div class="zn-err hidden" id="zona-renombrar-err"></div>
          </div>
          <div class="zn-acc">
            <button class="set-btn dark sm" data-acc="renombrar-ok">Guardar</button>
            <button class="set-btn ghost sm" data-acc="renombrar-no">Cancelar</button>
          </div>
        </div>`;
      }
      return `
        <div class="zn-row" data-zona="${escapeHtml(z.name)}">
          <span class="zn-sw" style="background:${zonaColor(z.name)}"></span>
          <div class="zn-info"><button type="button" class="zn-ver" data-acc="ver" ${editando ? 'disabled' : ''} title="${z.polygon ? 'Ver en el mapa' : 'Todavía sin dibujo'}">${escapeHtml(z.name)}</button><small>${estado}</small></div>
          <div class="zn-acc">
            <button class="set-btn ghost sm" data-acc="dibujar" ${editando ? 'disabled' : ''}>${z.polygon ? 'Editar dibujo' : 'Dibujar'}</button>
            <button class="set-btn ghost sm" data-acc="renombrar" ${editando ? 'disabled' : ''}>Renombrar</button>
            <button class="zn-quitar" data-acc="quitar" ${editando ? 'disabled' : ''} aria-label="Quitar la zona ${escapeHtml(z.name)}" title="Quitar zona"><svg class="icon"><use href="#i-trash"/></svg></button>
          </div>
        </div>`;
    }).join('') : '<p class="set-hint">Todavía no hay zonas. Crea la primera con «Agregar zona».</p>';
    aviso.innerHTML = dobles
      ? `<b>${plural(dobles, 'conjunto queda', 'conjuntos quedan')} dentro de dos zonas a la vez</b> (borde ámbar en el mapa): ahí los dibujos se enciman. ${dobles === 1 ? 'Queda' : 'Quedan'} sin zona hasta que se corrija el dibujo o se ${dobles === 1 ? 'le' : 'les'} ponga a mano.`
      : '';
    $('#zona-agregar-btn').disabled = editando;
    if (zonasMapa.renombrando) {
      const inp = $('#zona-renombrar-input');
      if (inp && document.activeElement !== inp) { inp.focus(); inp.select(); }
    }
  }

  // ---- CREAR, RENOMBRAR, QUITAR ----------------------------------------------
  function zonaNombreInvalido(name, actual) {
    if (!name) return 'Escribe el nombre de la zona.';
    if (name.length > 60) return 'El nombre es muy largo (máximo 60 letras).';
    const igual = (zonasMapa.lista || []).some(z => z.name !== actual && z.name.toLowerCase() === name.toLowerCase());
    return igual ? 'Ya hay una zona con ese nombre.' : '';
  }
  function zonaErrorTexto(e) {
    return e && e.code === '23505' ? 'Ya hay una zona con ese nombre.' : 'No se pudo guardar: ' + ((e && e.message) || e);
  }
  const zonaNombreLimpio = (v) => String(v || '').trim().replace(/\s+/g, ' ');

  function zonaNuevaAbrir() {
    zonasMapa.renombrando = null;
    $('#zona-nueva').classList.remove('hidden');
    $('#zona-nueva-err').classList.add('hidden');
    $('#zona-nueva-nombre').focus();
  }
  function zonaNuevaCerrar() {
    $('#zona-nueva').classList.add('hidden');
    $('#zona-nueva-nombre').value = '';
  }
  async function zonaNuevaCrear() {
    const inp = $('#zona-nueva-nombre'), err = $('#zona-nueva-err'), btn = $('#zona-nueva-crear');
    const name = zonaNombreLimpio(inp.value);
    const msg = zonaNombreInvalido(name);
    if (msg) { err.textContent = msg; err.classList.remove('hidden'); inp.focus(); return; }
    btn.disabled = true;
    try {
      const orden = Math.max(0, ...(zonasMapa.lista || []).map(z => Number(z.sort_order) || 0)) + 1;
      await Api.createRouteZone(name, orden);
      zonaNuevaCerrar();
      await zonasRecargar();
      zonaEdicionEmpezar(name);
      toast(`Zona «${name}» creada. Ahora márcala en el mapa.`);
    } catch (e) {
      err.textContent = zonaErrorTexto(e); err.classList.remove('hidden');
    } finally { btn.disabled = false; }
  }

  async function zonaRenombrarGuardar(name) {
    const inp = $('#zona-renombrar-input'), err = $('#zona-renombrar-err');
    if (!inp) return;
    const nuevo = zonaNombreLimpio(inp.value);
    if (nuevo === name) { zonasMapa.renombrando = null; zonasPintarLista(); return; }
    const msg = zonaNombreInvalido(nuevo, name);
    if (msg) { err.textContent = msg; err.classList.remove('hidden'); inp.focus(); return; }
    try {
      // La BD lo propaga (ON UPDATE CASCADE): la columna de minutos y los
      // conjuntos puestos a mano siguen apuntando a la misma zona.
      await Api.updateRouteZone(name, { name: nuevo });
      zonasMapa.renombrando = null;
      await zonasRecargar();
      toast(`«${name}» ahora se llama «${nuevo}».`);
    } catch (e) {
      err.textContent = zonaErrorTexto(e); err.classList.remove('hidden');
    }
  }

  async function zonaQuitar(name) {
    const aMano = (zonasMapa.residencias || []).filter(r => r.zona_jefe === name).length;
    const msg = `¿Quitar la zona «${name}»?\n\nSe borran su dibujo y su columna de minutos en la tabla de tiempos.`
      + (aMano ? `\n${aMano} ${aMano === 1 ? 'conjunto que la tenía puesta a mano vuelve' : 'conjuntos que la tenían puesta a mano vuelven'} a «Según el mapa».` : '')
      + '\n\nNo se puede deshacer.';
    if (!confirm(msg)) return;
    try {
      await Api.deleteRouteZone(name);
      await zonasRecargar();
      toast(`Zona «${name}» quitada.`);
    } catch (e) { toast('No se pudo quitar la zona: ' + ((e && e.message) || e)); }
  }

  // ---- DIBUJAR ---------------------------------------------------------------
  function zonaEdicionEmpezar(name) {
    const z = (zonasMapa.lista || []).find(x => x.name === name);
    if (!z || !zonasMapa.mapa) return;
    zonasMapa.renombrando = null;
    zonasMapa.mapa.editar(name, zonaColor(name), z.polygon);
    zonasPintarLista();
  }

  // La barra naranja de arriba del mapa: qué se está marcando y los botones.
  function zonasPintarBarra() {
    const ed = zonaEditando();
    $('#zona-editbar').classList.toggle('hidden', !ed);
    if (!ed) return;
    const n = ed.puntos;
    $('#zona-editbar-t').innerHTML = `Marcando <b>${escapeHtml(ed.name)}</b> · ${n} ${n === 1 ? 'punto' : 'puntos'}`
      + `<small>${n < 3
        ? 'Toca el mapa para poner las esquinas de la zona (mínimo 3).'
        : 'Toca el mapa para agregar una esquina. Arrastra un punto para moverlo; tócalo para quitarlo.'}</small>`;
    $('#zona-deshacer-btn').disabled = !ed.puedeDeshacer;
    $('#zona-guardar-dibujo-btn').disabled = !ed.listo;
  }

  function zonaEdicionCancelar() {
    if (zonasMapa.mapa) zonasMapa.mapa.terminar();
    zonasPintarLista();
  }

  async function zonaEdicionGuardar() {
    const ed = zonaEditando();
    if (!ed || !ed.listo) return;
    const btn = $('#zona-guardar-dibujo-btn');
    btn.disabled = true;
    try {
      await Api.updateRouteZone(ed.name, { polygon: zonasMapa.mapa.dibujo() });
      zonasMapa.mapa.terminar();
      await zonasRecargar();
      toast(`Dibujo de «${ed.name}» guardado.`);
    } catch (e) {
      toast('No se pudo guardar el dibujo: ' + ((e && e.message) || e));
      btn.disabled = false;
    }
  }

  // ---- EVENTOS (una sola vez, por delegación) --------------------------------
  function zonasEnlazar(card) {
    if (zonasMapa.bound) return;
    zonasMapa.bound = true;
    card.addEventListener('click', (ev) => {
      const t = ev.target.closest('button');
      if (!t || t.disabled) return;
      if (t.id === 'zona-agregar-btn') return zonaNuevaAbrir();
      if (t.id === 'zona-nueva-crear') return zonaNuevaCrear();
      if (t.id === 'zona-nueva-cancelar') return zonaNuevaCerrar();
      if (t.id === 'zona-deshacer-btn') return zonasMapa.mapa && zonasMapa.mapa.deshacer();
      if (t.id === 'zona-cancelar-dibujo-btn') return zonaEdicionCancelar();
      if (t.id === 'zona-guardar-dibujo-btn') return zonaEdicionGuardar();
      const fila = t.closest('[data-zona]');
      if (!fila) return;
      const name = fila.dataset.zona;
      if (t.dataset.acc === 'ver') return zonasMapa.mapa && zonasMapa.mapa.enfocar(name);
      if (t.dataset.acc === 'dibujar') return zonaEdicionEmpezar(name);
      if (t.dataset.acc === 'renombrar') { zonaNuevaCerrar(); zonasMapa.renombrando = name; return zonasPintarLista(); }
      if (t.dataset.acc === 'renombrar-ok') return zonaRenombrarGuardar(name);
      if (t.dataset.acc === 'renombrar-no') { zonasMapa.renombrando = null; return zonasPintarLista(); }
      if (t.dataset.acc === 'quitar') return zonaQuitar(name);
    });
    card.addEventListener('keydown', (ev) => {
      if (ev.target.id === 'zona-nueva-nombre') {
        if (ev.key === 'Enter') { ev.preventDefault(); zonaNuevaCrear(); }
        if (ev.key === 'Escape') zonaNuevaCerrar();
      }
      if (ev.target.id === 'zona-renombrar-input') {
        const fila = ev.target.closest('[data-zona]');
        if (ev.key === 'Enter') { ev.preventDefault(); zonaRenombrarGuardar(fila.dataset.zona); }
        if (ev.key === 'Escape') { zonasMapa.renombrando = null; zonasPintarLista(); }
      }
    });
    card.addEventListener('input', (ev) => {
      if (ev.target.id === 'zona-nueva-nombre') $('#zona-nueva-err').classList.add('hidden');
      if (ev.target.id === 'zona-renombrar-input') { const e = $('#zona-renombrar-err'); if (e) e.classList.add('hidden'); }
    });
  }
