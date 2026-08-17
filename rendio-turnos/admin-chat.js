// admin-chat.js — Admin: el jefe escribe en el hilo de un traslado (0067).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // EL HILO DEL TRASLADO, DESDE EL LADO DEL JEFE
  //
  // Hasta 0067 el chat era una cuerda de dos puntas —tripulante ↔ conductor— y
  // el admin solo miraba. Ahora entra como tercera punta.
  //
  // Por qué el chat y no la llamada: llamar es lo primero que uno quiere hacer y
  // a las 4 de la mañana es lo que menos funciona (el tripulante tiene el
  // celular en silencio, el conductor va manejando). El mensaje le suena a los
  // dos, queda escrito, y se puede revisar después si hay un reclamo. El botón
  // de llamar NO se quita: viven al lado.
  //
  // Es una hoja compartida, no una vista: se abre desde Eventualidades y desde
  // Reservas sin perder el filtro ni el polling de la pantalla de abajo. Por eso
  // vive suelta en el DOM (#jefe-chat) y no dentro de un panel.
  // ====================================================================
  const jcState = { rid: null, msgs: [], sending: false, poll: null, bound: false };

  const JC_POLL_MS = 5000;  // igual que el chat del conductor: no hay Realtime
  const JC_WHO = { auxiliar: 'Tripulante', driver: 'Conductor', admin: '' };

  // rid = reservation_id. `name` y `sub` son solo el encabezado: quién es y de
  // qué traslado se trata, para no escribirle al pasajero equivocado.
  function jcOpen(rid, name, sub) {
    if (!rid) return;
    const panel = document.getElementById('jefe-chat'); if (!panel) return;
    jcBind();
    jcStopPoll();
    jcState.rid = rid; jcState.msgs = []; jcState.sending = false;

    document.getElementById('jc-name').textContent = name || 'Traslado';
    document.getElementById('jc-sub').textContent = sub || '';
    document.getElementById('jc-body').innerHTML = '<p class="jc-load">Cargando…</p>';
    panel.classList.remove('hidden');

    jcSync();
    jcState.poll = setInterval(jcSync, JC_POLL_MS);
    const i = document.getElementById('jc-input'); if (i) { i.value = ''; i.focus(); }
  }

  function jcClose() {
    jcStopPoll();
    jcState.rid = null; jcState.msgs = [];
    const panel = document.getElementById('jefe-chat'); if (panel) panel.classList.add('hidden');
  }
  function jcStopPoll() {
    if (jcState.poll) { clearInterval(jcState.poll); jcState.poll = null; }
  }

  async function jcSync() {
    const rid = jcState.rid;
    if (!rid || !window.Api?.listReservationMessages) return;
    let msgs = [];
    try { msgs = await Api.listReservationMessages(rid); } catch (e) { return; }
    if (jcState.rid !== rid) return;   // cerró la hoja o cambió de traslado
    jcState.msgs = msgs;
    jcBubbles();
    // El jefe LEE sin marcar leído, a propósito: si marcara, le apagaría el
    // badge al conductor de un mensaje que el conductor no ha abierto. Por eso
    // mark_reservation_messages_read (0067) devuelve 0 para un admin.
  }

  function jcBubbles() {
    const el = document.getElementById('jc-body'); if (!el) return;
    const msgs = jcState.msgs || [];
    if (!msgs.length) {
      el.innerHTML = `<div class="jc-empty">
        <b>Todavía nadie ha escrito en este traslado.</b>
        <span>Lo que escribas le suena al tripulante y a su conductor, y queda registrado. Si el traslado aún no tiene carro asignado, le llega solo al tripulante.</span>
      </div>`;
      return;
    }
    const hora = (iso) => {
      try { return new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }); }
      catch (_) { return ''; }
    };
    el.innerHTML = msgs.map(m => {
      const mio = m.sender_role === 'admin';
      const who = JC_WHO[m.sender_role] || m.sender_role;
      return `<div class="jc-msg ${mio ? 'mine' : 'their'}">
        ${who ? `<em>${escapeHtml(who)}</em>` : ''}
        <p>${escapeHtml(m.body)}</p><span>${hora(m.created_at)}</span>
      </div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  async function jcSend() {
    const rid = jcState.rid;
    if (!rid || jcState.sending) return;
    const i = document.getElementById('jc-input'); if (!i) return;
    const body = i.value.trim(); if (!body) return;
    jcState.sending = true;
    i.value = '';
    // Optimista: la burbuja aparece de una. Si falla se quita y se le devuelve el
    // texto al campo, para que no pierda lo que escribió.
    const temp = { id: 'tmp' + Date.now(), sender_role: 'admin', body, created_at: new Date().toISOString() };
    jcState.msgs = (jcState.msgs || []).concat([temp]);
    jcBubbles();
    try {
      const r = await Api.sendReservationMessage(rid, body, { title: 'Mensaje de Rendio' });
      // Decir "enviado" a secas sería engañarlo: si al otro no le suena, el
      // mensaje se queda ahí hasta que abra la app, y eso hay que saberlo.
      const n = (r && r.recipients) ? r.recipients.length : 0;
      if (!n) toast('Guardado, pero todavía no había a quién avisarle.');
      else if (r.notified === false) {
        toast(`Enviado a ${n === 1 ? '1 persona' : n + ' personas'}, pero no tienen notificaciones activadas: lo verán al abrir la app.`);
      } else {
        toast(n === 1 ? 'Mensaje enviado.' : `Mensaje enviado a ${n} personas.`);
      }
      await jcSync();
    } catch (e) {
      jcState.msgs = jcState.msgs.filter(m => m.id !== temp.id);
      jcBubbles();
      i.value = body;
      toast((e && e.message) ? e.message : 'No se pudo enviar el mensaje.');
    } finally { jcState.sending = false; }
  }

  function jcBind() {
    if (jcState.bound) return;
    const panel = document.getElementById('jefe-chat'); if (!panel) return;
    jcState.bound = true;
    panel.addEventListener('click', (e) => {
      // Tocar el fondo oscuro cierra: es el gesto que uno hace con una mano.
      if (e.target === panel) { jcClose(); return; }
      if (e.target.closest('#jc-close')) { jcClose(); return; }
      if (e.target.closest('#jc-send'))  { jcSend();  return; }
    });
    // Enter manda el mensaje: en un teclado de celular el botón queda tapado.
    panel.addEventListener('keydown', (e) => {
      if (e.target.id === 'jc-input' && e.key === 'Enter') { e.preventDefault(); jcSend(); }
    });
  }
