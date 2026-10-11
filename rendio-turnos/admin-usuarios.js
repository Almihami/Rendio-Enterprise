// admin-usuarios.js — Usuarios: todas las cuentas en un solo lugar (11-oct-2026).
//
// POR QUÉ EXISTE
// La profa pidió «un apartado adicional para administración de usuarios, para
// poder resetear claves y ese tipo de cosas». Las acciones ya existían (0081),
// pero repartidas: las de conductores y jefes en Personal (Turnos), las de los
// tripulantes en Tripulantes (Rutas). Para restablecerle la clave a alguien,
// el jefe tenía que saber primero en qué espacio de trabajo vive esa persona.
// Aquí están todos —conductores, jefes y tripulantes; activos, suspendidos y
// eliminados— con un buscador y las acciones que le tocan a cada uno.
//
// LO QUE NO HACE
// No duplica lógica: los modales (editar datos, restablecer contraseña, crear
// cuenta, cambiar la mía) y el cambio de estado son los de usuarios.js, y las
// reglas las vuelve a validar la base (admin_set_status / admin_set_role). Las
// acciones se QUEDAN donde estaban (Personal, Tripulantes): esto es un acceso
// más, no un traslado. Tampoco crea tripulantes: se registran solos (0075).
//
// Módulo IIFE: solo exporta window.renderUsuarios y window.AdminUsuarios.
(function () {
  'use strict';

  const st = {
    items: null, loading: false, error: null,
    q: '', rol: 'todos', estado: 'todos',      // rol: todos|driver|admin|auxiliar · estado: todos|activo|suspendido|eliminado
    open: null,                                // id con el panel de acciones abierto
    busy: null,                                // id con una acción en curso
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Buscar «jose» encuentra «José»: sin tildes y sin mayúsculas.
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const soloDigitos = (s) => String(s || '').replace(/\D/g, '');

  const ROL = {
    driver:   { label: 'Conductor',  plural: 'Conductores' },
    admin:    { label: 'Jefe',       plural: 'Jefes' },
    auxiliar: { label: 'Tripulante', plural: 'Tripulantes' },
  };
  const ESTADOS = [['todos', 'Todos'], ['activo', 'Activos'], ['suspendido', 'Suspendidos'], ['eliminado', 'Eliminados']];
  const estadoDe = (u) => (u.deleted ? 'eliminado' : !u.active ? 'suspendido' : 'activo');
  // Un jefe «suspendido» no existe (la base no lo deja): es un jefe sin acceso.
  const estadoLabel = (u) => ({ activo: 'Activo', eliminado: 'Eliminado',
    suspendido: u.role === 'admin' ? 'Sin acceso' : 'Suspendido' })[estadoDe(u)];
  const soyYo = (u) => typeof state !== 'undefined' && state.profile && state.profile.id === u.id;

  const PAL = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#9A8D7A'];
  const colorDe = (u) => {
    if (u.role === 'admin') return '#F26522';
    let h = 0; for (let i = 0; i < u.id.length; i++) h = (h * 31 + u.id.charCodeAt(i)) >>> 0;
    return PAL[h % PAL.length];
  };
  const iniciales = (n) => { const a = String(n || '').trim().split(/\s+/); return (((a[0] || '')[0] || '') + ((a[1] || '')[0] || '')).toUpperCase() || '·'; };

  // ---- datos ----
  async function load() {
    st.loading = true; st.error = null; paint();
    try { st.items = await Api.listAllUsersForAdmin(); }
    catch (e) { st.items = null; st.error = (e && e.message) || 'error'; console.error(e); }
    finally { st.loading = false; paint(); }
  }

  // Después de cambiar a alguien: la lista de aquí y lo que el resto de la app
  // tiene en memoria (el generador de turnos y los avisos leen state.drivers /
  // state.admins), igual que hace refreshPeople en Personal.
  async function recargar() {
    try { st.items = await Api.listAllUsersForAdmin(); } catch (e) { console.error(e); }
    try {
      if (typeof state !== 'undefined') {
        state.drivers = await Api.listDrivers();
        state.admins = (await Api.listAdmins()).map(a => ({ id: a.id, name: a.full_name, email: a.email, is_coordinator: a.is_coordinator !== false, receives_ops_alerts: a.receives_ops_alerts === true }));
      }
    } catch (e) { console.error(e); }
    paint();
  }

  function visibles() {
    let l = st.items || [];
    if (st.rol !== 'todos') l = l.filter(u => u.role === st.rol);
    if (st.estado !== 'todos') l = l.filter(u => estadoDe(u) === st.estado);
    const q = norm(st.q).trim();
    if (q) {
      const qd = soloDigitos(q);
      l = l.filter(u => norm([u.name, u.email, ROL[u.role] ? ROL[u.role].label : ''].join(' ')).includes(q)
        || (qd.length >= 3 && soloDigitos(u.phone).includes(qd)));
    }
    // Eliminados al final; dentro de cada grupo, por nombre.
    const peso = (u) => (u.deleted ? 2 : !u.active ? 1 : 0);
    return [...l].sort((a, b) => peso(a) - peso(b) || a.name.localeCompare(b.name, 'es'));
  }

  // ---- qué puede hacer el jefe con cada cuenta (lo mismo que deja la base) ----
  function accionesDe(u) {
    const yo = soyYo(u), e = estadoDe(u), a = [];
    a.push({ act: 'datos', label: 'Editar datos y correo' });
    if (yo) { a.push({ act: 'mi-clave', label: 'Cambiar mi contraseña', main: true }); return a; }
    if (e !== 'eliminado') a.push({ act: 'clave', label: 'Restablecer contraseña', main: true });
    if (e === 'activo' && u.role !== 'admin') a.push({ act: 'suspender', label: 'Suspender' });
    if (e === 'suspendido') a.push({ act: 'reactivar', label: 'Reactivar', tone: 'primary' });
    if (e === 'activo' && u.role === 'driver') a.push({ act: 'hacer-admin', label: 'Hacer administrador' });
    if (e === 'activo' && u.role === 'admin') a.push({ act: 'hacer-conductor', label: 'Pasar a conductor' });
    if (e !== 'eliminado' && u.role !== 'auxiliar') a.push({ act: 'eliminar', label: 'Eliminar', tone: 'danger' });
    if (e === 'eliminado') a.push({ act: 'restaurar', label: 'Restaurar', tone: 'primary', main: true });
    return a;
  }

  // ---- pintar ----
  function paint() {
    const root = document.getElementById('us-body'); if (!root) return;
    const cnt = document.getElementById('us-count');
    const todos = st.items || [];
    if (cnt) cnt.textContent = todos.filter(u => !u.deleted).length;
    paintFiltros();

    if (st.loading && !st.items) { root.innerHTML = '<div class="us-empty">Cargando las cuentas…</div>'; return; }
    if (!st.items) {
      root.innerHTML = `<div class="us-empty"><b>No pudimos cargar los usuarios.</b>
        <span>${esc(st.error || 'Revisa la conexión.')}</span>
        <button class="us-btn ghost" data-us="reload">Reintentar</button></div>`;
      return;
    }
    const l = visibles();
    if (!l.length) {
      root.innerHTML = `<div class="us-empty"><b>${todos.length ? 'Nadie coincide con la búsqueda.' : 'Todavía no hay cuentas.'}</b>
        ${todos.length ? '<span>Prueba con otro nombre, correo o teléfono, o quita los filtros.</span>' : ''}</div>`;
      return;
    }
    root.innerHTML = `<div class="us-list" role="list">
      <div class="us-head" aria-hidden="true"><span>Persona</span><span>Contacto</span><span>Rol</span><span>Estado</span><span></span></div>
      ${l.map(fila).join('')}</div>`;
  }

  function paintFiltros() {
    const box = document.getElementById('us-filters'); if (!box) return;
    const todos = st.items || [];
    const nRol = (r) => todos.filter(u => r === 'todos' || u.role === r).length;
    const nEst = (e) => todos.filter(u => (st.rol === 'todos' || u.role === st.rol) && (e === 'todos' || estadoDe(u) === e)).length;
    box.innerHTML = `
      <div class="us-seg" role="group" aria-label="Rol">
        ${[['todos', 'Todos'], ['driver', 'Conductores'], ['admin', 'Jefes'], ['auxiliar', 'Tripulantes']].map(([k, t]) =>
          `<button class="${st.rol === k ? 'on' : ''}" data-us="rol" data-v="${k}" aria-pressed="${st.rol === k}">${t} <span class="n">${nRol(k)}</span></button>`).join('')}
      </div>
      <div class="us-seg" role="group" aria-label="Estado">
        ${ESTADOS.map(([k, t]) =>
          `<button class="${st.estado === k ? 'on' : ''}" data-us="estado" data-v="${k}" aria-pressed="${st.estado === k}">${t} <span class="n">${nEst(k)}</span></button>`).join('')}
      </div>`;
  }

  function fila(u) {
    const e = estadoDe(u), yo = soyYo(u), abierto = st.open === u.id, ocupado = st.busy === u.id;
    const acc = accionesDe(u);
    // La acción principal (restablecer / restaurar / mi contraseña) va a la vista
    // en la fila; el panel de «Gestionar» trae las demás.
    const main = acc.find(x => x.main);
    const tel = u.phone
      ? `<a class="us-tel" href="tel:${esc(u.phone.replace(/[^\d+]/g, ''))}">${esc(u.phone)}</a>`
      : '<i class="us-falta">sin teléfono</i>';
    const motivo = (e !== 'activo' && u.suspendedReason)
      ? `<p class="us-motivo"><b>${e === 'eliminado' ? 'Motivo de la eliminación' : 'Motivo de la suspensión'}:</b> ${esc(u.suspendedReason)}</p>` : '';
    const queEs = {
      activo: '',
      suspendido: u.role === 'admin' ? 'No puede entrar a la consola. Reactivarlo le devuelve el acceso.'
        : u.role === 'auxiliar' ? 'Entra a la app y ve sus viajes, pero no puede pedir traslados nuevos.'
        : 'Entra a la app, pero no inicia turno ni sale en la generación de horarios.',
      eliminado: 'No puede entrar a la app. Al restaurarlo vuelve activo, con su mismo correo y contraseña.',
    }[e];
    return `
      <div class="us-row us-${e}${abierto ? ' open' : ''}" role="listitem" data-id="${esc(u.id)}">
        <div class="us-main">
          <div class="us-who">
            <span class="us-av" style="background:${colorDe(u)}">${esc(iniciales(u.name))}</span>
            <div class="us-nm">
              <b>${esc(u.name)}${yo ? ' <span class="us-tag yo">Tú</span>' : ''}</b>
              ${u.mustChange ? '<span class="us-chips"><span class="us-tag temp" title="Entró o va a entrar con una contraseña temporal">Clave temporal</span></span>' : ''}
            </div>
          </div>
          <div class="us-contact"><span class="us-mail">${esc(u.email || '—')}</span>${tel}</div>
          <div class="us-rol"><span class="us-role r-${esc(u.role)}">${esc(ROL[u.role] ? ROL[u.role].label : u.role)}</span></div>
          <div class="us-est"><span class="us-state s-${e}"><span class="dot"></span>${esc(estadoLabel(u))}</span></div>
          <div class="us-go">
            ${main ? `<button class="us-btn ${main.tone === 'primary' ? 'primary' : 'ghost'} sm" data-us="act" data-act="${main.act}" data-id="${esc(u.id)}" ${ocupado ? 'disabled' : ''}>${esc(main.label)}</button>` : ''}
            <button class="us-btn ghost sm" data-us="toggle" data-id="${esc(u.id)}" aria-expanded="${abierto}">${abierto ? 'Cerrar' : 'Gestionar'}</button>
          </div>
        </div>
        ${abierto ? `
          <div class="us-panel">
            ${queEs ? `<p class="us-que">${esc(queEs)}</p>` : ''}
            ${motivo}
            <div class="us-acts">
              ${acc.filter(x => !x.main).map(x => `<button class="us-btn ${x.tone || 'ghost'} sm" data-us="act" data-act="${x.act}" data-id="${esc(u.id)}" ${ocupado ? 'disabled' : ''}>${esc(x.label)}</button>`).join('')}
            </div>
          </div>` : ''}
      </div>`;
  }

  // ---- acciones ----
  async function accion(act, id) {
    const u = (st.items || []).find(x => x.id === id); if (!u) return;
    const name = u.name;
    if (act === 'datos') return openEditarDatos(id, recargar);
    if (act === 'clave') return openRestablecerClave(id, name);
    if (act === 'mi-clave') return openCambiarMiClave();

    let reason = null;
    if (act === 'suspender') {
      reason = prompt(u.role === 'auxiliar'
        ? `¿Suspender a ${name}? Sigue entrando a la app y ve sus viajes, pero no puede pedir traslados nuevos. Los que ya pidió se respetan.\n\nMotivo (lo verá en su app):`
        : `¿Suspender a ${name}? Puede entrar a la app y ve este motivo, pero no inicia turno ni entra a la generación de horarios.\n\nMotivo:`, '');
      if (reason === null) return;
    }
    if (act === 'eliminar') {
      if (!confirm(`¿Eliminar a ${name}? No podrá entrar a la app${u.role === 'driver' ? ' y sale de la generación de horarios. Los horarios pasados NO se borran' : ''}. Se puede restaurar.`)) return;
      reason = prompt('Motivo (opcional, queda en la bitácora):', '');
      if (reason === null) return;
    }
    if (act === 'reactivar' && !confirm(u.role === 'auxiliar' ? `¿Reactivar a ${name}? Vuelve a poder pedir traslados.`
      : u.role === 'admin' ? `¿Reactivar a ${name}? Vuelve a entrar a la consola de jefe.` : `¿Reactivar a ${name}? Vuelve a poder iniciar turno y a salir en los horarios.`)) return;
    if (act === 'restaurar' && !confirm(`¿Restaurar a ${name}? Vuelve activo, con su mismo correo y contraseña.`)) return;
    if (act === 'hacer-admin' && !confirm(`¿Hacer administrador a ${name}? Deja de ser conductor: sale de la generación de horarios y al volver a entrar verá la consola del jefe.`)) return;
    if (act === 'hacer-conductor' && !confirm(`¿Pasar a ${name} a conductor? Deja de ver la consola del jefe; al volver a entrar ve la app del conductor.`)) return;

    st.busy = id; paint();
    try {
      if (act === 'suspender') await usrSetStatus(id, 'suspended', reason);
      else if (act === 'reactivar') await usrSetStatus(id, 'active');
      else if (act === 'restaurar') await usrSetStatus(id, 'active', null, { wasDeleted: true });
      else if (act === 'eliminar') await usrSetStatus(id, 'deleted', reason);
      else if (act === 'hacer-admin') await Api.adminSetRole(id, 'admin');
      else if (act === 'hacer-conductor') await Api.adminSetRole(id, 'driver');
      else return;
      toast({
        suspender: `${name} quedó suspendido.`, reactivar: `${name} quedó activo.`, restaurar: `${name} fue restaurado.`,
        eliminar: `${name} quedó eliminado.`, 'hacer-admin': `${name} ahora es administrador.`, 'hacer-conductor': `${name} ahora es conductor.`,
      }[act]);
      st.busy = null;
      await recargar();
    } catch (e) {
      alert('Error: ' + ((e && e.message) || 'no se pudo'));
    } finally {
      st.busy = null; paint();
    }
  }

  // ---- eventos (una sola vez, delegados) ----
  let bound = false;
  function bind() {
    if (bound) return;
    const ui = document.getElementById('usuarios-ui'); if (!ui) return;
    bound = true;
    ui.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-us]'); if (!b || b.disabled) return;
      const k = b.dataset.us;
      if (k === 'reload') { st.items = null; return load(); }
      if (k === 'crear') return openCrearUsuario(recargar);
      if (k === 'rol') { st.rol = b.dataset.v; return paint(); }
      if (k === 'estado') { st.estado = b.dataset.v; return paint(); }
      if (k === 'toggle') { st.open = st.open === b.dataset.id ? null : b.dataset.id; return paint(); }
      if (k === 'act') return accion(b.dataset.act, b.dataset.id);
    });
    ui.addEventListener('input', (ev) => {
      if (ev.target.id === 'us-search') { st.q = ev.target.value; paint(); }
    });
  }

  function renderUsuarios() {
    bind();
    // Cada vez que se entra se pide de nuevo: lo pudieron cambiar desde Personal
    // o Tripulantes, y esta pantalla no puede mostrar un estado viejo.
    load();
  }

  window.AdminUsuarios = { render: renderUsuarios, state: st, accionesDe };
  window.renderUsuarios = renderUsuarios;
})();
