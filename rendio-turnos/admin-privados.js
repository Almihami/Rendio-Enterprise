// admin-privados.js — La cola de traslados privados (0069).
//
// POR QUÉ ES UNA PANTALLA Y NO UNA COLUMNA EN RESERVAS
// Un privado no es un traslado más: compromete la camioneta, tiene tarifa y
// alguien lo está ESPERANDO. Mientras el jefe no responda, el auxiliar no sabe
// si va a tener carro. Eso es una bandeja de decisiones — el mismo caso que
// Solicitudes —, no una fila más de una tabla de consulta.
//
// LA REGLA QUE SOSTIENE ESTA PANTALLA
// Hay UNA camioneta. Aprobar dos privados que se pisan en el tiempo es prometer
// dos veces el mismo carro. El servidor lo impide (admin_decide_private vuelve a
// mirar el cupo al aprobar, no solo al pedir), pero acá se avisa ANTES de que el
// jefe apriete, porque enterarse por un error es peor que verlo venir.

(function () {
  'use strict';

  const st = { items: null, loading: false, busy: null, rejecting: null };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money = (v) => v == null ? '—'
    : '$ ' + Number(v).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  const fecha = (iso) => {
    try {
      return new Date(iso).toLocaleString('es-CO', {
        timeZone: 'America/Bogota', weekday: 'short', day: 'numeric',
        month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch (_) { return iso || ''; }
  };

  // Punto de entrada de la pantalla. Se llama cada vez que el jefe entra a la
  // pestaña, no solo la primera: si dejó una solicitud a medias, la ve fresca.
  function abrir() {
    const root = document.getElementById('pv-list'); if (!root) return;
    if (!st.items && !st.loading) { load(); }
    paint();
  }

  async function load() {
    st.loading = true; paint();
    try { st.items = await Api.listPrivateRequests(); }
    catch (_) { st.items = null; }
    finally { st.loading = false; paint(); }
  }

  // ¿Este privado se pisa con otro ya aprobado? Se calcula en el cliente sobre
  // la lista que el jefe ya tiene a la vista — es un AVISO, no la validación:
  // la de verdad la hace el servidor al aprobar.
  const VENTANA_MIN = 90;
  function choca(item) {
    if (!Array.isArray(st.items)) return null;
    const t = new Date(item.whenISO).getTime();
    return st.items.find(o => o.id !== item.id
      && o.status === 'approved' && !o.cancelled
      && Math.abs(new Date(o.whenISO).getTime() - t) <= VENTANA_MIN * 60000) || null;
  }

  function paint() {
    const root = document.getElementById('pv-list'); if (!root) return;
    const cont = document.getElementById('pv-count');

    if (st.loading && !st.items) {
      root.innerHTML = '<div class="pv-empty">Cargando solicitudes…</div>';
      return;
    }
    if (st.items === null) {
      root.innerHTML = '<div class="pv-empty"><b>No se pudieron cargar</b>'
        + '<span>Revisa la conexión y vuelve a intentar.</span>'
        + '<button class="set-btn ghost" data-pv="reload">Reintentar</button></div>';
      return;
    }
    const vivos = st.items.filter(x => !x.cancelled);
    const pend = vivos.filter(x => x.status === 'requested');
    const resto = vivos.filter(x => x.status !== 'requested');
    if (cont) cont.textContent = pend.length;

    if (!vivos.length) {
      root.innerHTML = '<div class="pv-empty">'
        + '<b>Ninguna solicitud de privado</b>'
        + '<span>Cuando un auxiliar pida la camioneta, aparece aquí para que la apruebes o la niegues.</span>'
        + '</div>';
      return;
    }
    root.innerHTML =
      (pend.length ? '<div class="pv-sec">Esperando tu respuesta</div>' + pend.map(card).join('') : '')
      + (resto.length ? '<div class="pv-sec">Ya resueltas</div>' + resto.map(card).join('') : '');
  }

  function card(x) {
    const pend = x.status === 'requested';
    const cl = x.status === 'approved' ? 'ok' : x.status === 'rejected' ? 'no' : 'wait';
    const et = x.status === 'approved' ? 'Aprobado' : x.status === 'rejected' ? 'Negado' : 'Pendiente';
    const conflicto = pend ? choca(x) : null;
    const rechazando = st.rejecting === x.id;
    const ocupado = st.busy === x.id;

    return `<div class="pv-card ${cl}">
      <div class="pv-top">
        <div>
          <b>${esc(x.who)}</b>
          <span>${x.type === 'lle' ? 'Llegada · lo dejamos en' : 'Salida · lo recogemos en'} ${esc(x.addr || '—')}</span>
        </div>
        <span class="pv-tag ${cl}">${et}</span>
      </div>
      <div class="pv-meta">
        <span><b>Cuándo</b>${esc(fecha(x.whenISO))}</span>
        <span><b>Tarifa</b>${money(x.price)}</span>
        ${x.phone ? `<span><b>Teléfono</b>${esc(x.phone)}</span>` : ''}
        ${x.plate ? `<span><b>Vehículo</b>${esc(x.plate)}${x.vehicle ? ' · ' + esc(x.vehicle) : ''}</span>` : ''}
      </div>
      ${x.notes ? `<div class="pv-notes">${esc(x.notes)}</div>` : ''}
      ${conflicto ? `<div class="pv-warn">
        <svg class="icon"><use href="#i-warn"/></svg>
        Se cruza con el privado de <b>${esc(conflicto.who)}</b> (${esc(fecha(conflicto.whenISO))}). Hay una sola camioneta: si apruebas este, el servidor lo va a rechazar.
      </div>` : ''}
      ${x.status === 'rejected' && x.reason ? `<div class="pv-reason"><b>Motivo:</b> ${esc(x.reason)}</div>` : ''}
      ${rechazando ? `<div class="pv-rej">
        <input class="set-input" id="pv-reason-${x.id}" type="text" maxlength="200"
               placeholder="¿Por qué? Lo va a leer quien pidió (opcional)" />
        <div class="pv-rej-acts">
          <button class="set-btn ghost" data-pv="rej-cancel">Volver</button>
          <button class="set-btn danger" data-pv="rej-do" data-id="${x.id}">Negar el privado</button>
        </div>
      </div>` : pend ? `<div class="pv-acts">
        <button class="set-btn ghost" data-pv="rej" data-id="${x.id}"${ocupado ? ' disabled' : ''}>Negar</button>
        <button class="set-btn" data-pv="ok" data-id="${x.id}"${ocupado ? ' disabled' : ''}>${ocupado ? 'Aprobando…' : 'Aprobar y apartar la camioneta'}</button>
      </div>` : ''}
    </div>`;
  }

  async function decidir(id, aprueba, motivo) {
    st.busy = id; paint();
    try {
      const r = await Api.decidePrivate(id, aprueba, motivo);
      // Avisarle a quien pidió: está esperando esta respuesta y no tiene forma
      // de saberla si no abre la app.
      if (r && r.requester_profile_id && typeof notify === 'function') {
        notify([r.requester_profile_id],
          aprueba ? 'Tu traslado privado quedó confirmado' : 'No alcanzó la camioneta',
          aprueba
            ? 'La camioneta es tuya para ese trayecto.'
            : ((motivo ? motivo + ' ' : '') + 'Tu traslado sigue en pie en compartido, sin costo.'),
          '/');
      }
      st.rejecting = null;
      await load();
      if (typeof toast === 'function') toast(aprueba ? 'Privado aprobado.' : 'Privado negado.');
    } catch (e) {
      const m = (e && e.message) || '';
      if (typeof toast === 'function') {
        toast(m.includes('comprometida') ? 'La camioneta ya está apartada en esa franja.'
          : m.includes('camioneta configurada') ? 'Falta elegir la camioneta en Ajustes.'
          : 'No se pudo guardar la decisión.');
      }
    } finally { st.busy = null; paint(); }
  }

  function bind() {
    const root = document.getElementById('privados-ui'); if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-pv]'); if (!el) return;
      const a = el.dataset.pv;
      if (a === 'reload') { st.items = null; load(); }
      else if (a === 'refresh') { load(); }
      else if (a === 'ok') { decidir(el.dataset.id, true, null); }
      else if (a === 'rej') { st.rejecting = el.dataset.id; paint(); }
      else if (a === 'rej-cancel') { st.rejecting = null; paint(); }
      else if (a === 'rej-do') {
        const inp = document.getElementById('pv-reason-' + el.dataset.id);
        decidir(el.dataset.id, false, inp && inp.value.trim() ? inp.value.trim() : null);
      }
    });
  }

  window.renderPrivados = function () { bind(); abrir(); };
})();
