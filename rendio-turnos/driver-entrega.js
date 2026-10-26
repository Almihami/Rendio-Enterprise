// driver-entrega.js — Conductor › Inicio › «Entrega de turno» (0140, 26-oct-2026).
//
// Pedido de los jefes: «que a ellos les aparezca en la app bien visible; cuando
// entreguen el turno que pongan entregado; que eso les aparezca sobre las 12».
//
// Arriba en Inicio, desde 2 h antes de la hora de entrega (12 m. para el de la
// mañana, 12 a. m. para el de la tarde; los minutos van en Calibración):
//   · el que ENTREGA: «Le entregas el carro a Daniel Restrepo · 2:00 p. m.», su
//     teléfono y el botón grande «Entregado» (con «Deshacer» por si se equivocó);
//   · el que RECIBE: «Recibes el carro de Juan Pérez · 2:00 p. m.»; cuando Juan
//     marca, «Juan marcó que te lo entregó». Queda recibido al iniciar su turno.
// Todo sale de la base (driver_my_handovers); sin 0140 la tarjeta no existe.
// Se vuelve a leer cada minuto mientras Inicio esté a la vista.
//
// Módulo cerrado: window.DriverEntrega.render() lo llama driver-tabs.js al pintar
// Inicio. Para las pruebas: DriverEntrega._st.
(function () {
  'use strict';
  const W = window;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm12 = (iso) => {
    try {
      const [h, m] = new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);
      return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
    } catch (_) { return ''; }
  };
  const nombre = (n) => { const p = String(n || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1] : ''); };
  const tel = (p) => String(p || '').replace(/[^\d+]/g, '');
  const st = { rows: [], ocupado: false, timer: null };
  const box = () => document.getElementById('driver-home-entrega');

  function tarjeta(r) {
    const hora = hm12(r.due_at);
    const placa = r.plate || r.car || '';
    if (r.role === 'entrega') {
      const a = r.to ? nombre(r.to.name) : (r.to_text || '');
      // Sin destinatario (el plan siguiente sin publicar): se dice, y se puede marcar igual.
      const quien = r.to ? `Le entregas el carro a <b>${esc(a)}</b>`
        : a ? `Dejas el carro: <b>${esc(a)}</b>`
        : 'Todavía no está definido a quién le entregas el carro: <b>Coordinación te avisa</b>.';
      const llamar = r.to && tel(r.to.phone) ? `<a class="rc-ent-call" href="tel:${esc(tel(r.to.phone))}">Llamar a ${esc(a.split(' ')[0])}</a>` : '';
      const accion = r.delivered_at
        ? `<div class="rc-ent-ok" role="status">✓ Entregado a las ${esc(hm12(r.delivered_at))}</div><button type="button" class="rc-ent-undo" data-ent="undo" data-dia="${esc(r.op_day)}" data-band="${esc(r.band)}">Deshacer</button>`
        : `<button type="button" class="rc-ent-btn" data-ent="ok" data-dia="${esc(r.op_day)}" data-band="${esc(r.band)}">Entregado</button>`;
      return `<div class="rc-card rc-ent rc-in d1${r.delivered_at ? ' is-done' : ''}">`
        + `<div class="rc-ent-h"><span>🔑 Entrega de turno</span><em>${esc(hora)}</em></div>`
        + `<p class="rc-ent-q">${quien}</p>`
        + `<p class="rc-ent-s">${[placa ? 'Carro ' + esc(placa) : '', r.delivered_at ? '' : 'Cuando se lo entregues, toca «Entregado».'].filter(Boolean).join(' · ')}</p>`
        + llamar + accion + '</div>';
    }
    // Recibe
    const de = nombre(r.from && r.from.name);
    const llamar = r.from && tel(r.from.phone) ? `<a class="rc-ent-call" href="tel:${esc(tel(r.from.phone))}">Llamar a ${esc(de.split(' ')[0])}</a>` : '';
    const estado = r.received_at ? `Recibido al iniciar tu turno (${esc(hm12(r.received_at))}).`
      : r.delivered_at ? `${esc(de.split(' ')[0])} marcó que te lo entregó a las ${esc(hm12(r.delivered_at))}. Revísalo al iniciar tu turno.`
      : 'Cuando lo recibas, inicia tu turno con ese carro.';
    return `<div class="rc-card rc-ent rc-in d1 is-recibe">`
      + `<div class="rc-ent-h"><span>🔑 Recibes el carro</span><em>${esc(hora)}</em></div>`
      + `<p class="rc-ent-q">De <b>${esc(de)}</b>${placa ? ' · carro ' + esc(placa) : ''}</p>`
      + `<p class="rc-ent-s">${estado}</p>` + llamar + '</div>';
  }

  function pintar() {
    const b = box(); if (!b) return;
    b.innerHTML = (st.rows || []).map(tarjeta).join('');
  }

  async function render() {
    const b = box(); if (!b) return;
    try { st.rows = W.Api && Api.driverMyHandovers ? await Api.driverMyHandovers() : []; } catch (_) { /* se queda lo último */ }
    pintar();
    atar();
    if (!st.timer && typeof setInterval === 'function') {
      st.timer = setInterval(() => {
        const x = box();
        // Solo mientras Inicio esté a la vista (y la app abierta).
        if (!x || !x.offsetParent || (typeof document !== 'undefined' && document.hidden)) return;
        render().catch(() => {});
      }, 60000);
    }
  }

  let atado = false;
  function atar() {
    const b = box(); if (!b || atado) return;
    atado = true;
    b.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-ent]'); if (!btn || st.ocupado) return;
      const undo = btn.getAttribute('data-ent') === 'undo';
      st.ocupado = true; btn.disabled = true;
      try {
        await Api.driverHandoverDelivered(btn.getAttribute('data-dia'), btn.getAttribute('data-band'), undo);
        if (typeof W.toast === 'function') W.toast(undo ? 'Listo: quedó sin entregar.' : 'Entrega marcada. Le avisamos a quien recibe.');
      } catch (err) {
        if (typeof W.toast === 'function') W.toast('No se pudo: ' + ((err && err.message) || 'sin conexión'));
        btn.disabled = false;
      } finally { st.ocupado = false; }
      await render();
    });
  }

  W.DriverEntrega = { render, _st: st, _tarjeta: tarjeta };
})();
