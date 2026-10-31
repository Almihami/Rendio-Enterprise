// cuenta-eliminar.js — «Eliminar mi cuenta» (0156, 31-oct-2026).
//
// Apple y Google exigen que quien puede crear su cuenta en la app la pueda
// eliminar desde la misma app. Cualquier elemento con data-cuenta="eliminar"
// abre esta ventana: Perfil del conductor, menú del jefe, Perfil del tripulante
// y la pantalla de la app en pausa.
//
// Para que no se haga por un toque sin querer, hay que escribir ELIMINAR.
// La base (delete_my_account) bloquea la cuenta, cierra las sesiones y borra
// los dispositivos de avisos; lo de la operación se conserva para los jefes.
(function () {
  const PALABRA = 'ELIMINAR';

  function estilos() {
    if (document.getElementById('ce-css')) return;
    const css = document.createElement('style');
    css.id = 'ce-css';
    css.textContent = '.ce-velo{position:fixed;inset:0;z-index:2147483100;background:rgba(10,10,10,.55);display:flex;align-items:flex-end;justify-content:center;'
      + 'padding:16px 16px calc(16px + env(safe-area-inset-bottom));font-family:Inter,system-ui,-apple-system,sans-serif}'
      + '@media (min-width:700px){.ce-velo{align-items:center}}'
      + '.ce-card{background:#fff;color:#0A0A0A;border-radius:20px;padding:22px 20px 18px;max-width:440px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.3)}'
      + '.ce-card h2{font-size:19px;font-weight:700;margin:0 0 10px}.ce-card p,.ce-card li{font-size:14.5px;line-height:1.45;color:#1F1F1F}'
      + '.ce-card p{margin:0 0 10px}.ce-card ul{margin:0 0 10px;padding-left:18px;list-style:disc}.ce-card li{margin:0 0 4px}'
      + '.ce-card label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}'
      + '.ce-card input{width:100%;box-sizing:border-box;border:1.5px solid #d4d4d4;border-radius:12px;padding:11px 12px;font-size:16px;text-transform:uppercase}'
      + '.ce-err{color:#B42318;font-size:13.5px;margin:10px 0 0}'
      + '.ce-acts{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}'
      + '.ce-btn{border:0;border-radius:999px;padding:11px 18px;font-weight:600;font-size:15px;background:transparent;color:#1F1F1F;cursor:pointer}'
      + '.ce-btn.rojo{background:#B42318;color:#fff}.ce-btn[disabled]{opacity:.45;cursor:default}';
    document.head.appendChild(css);
  }

  function abrir() {
    estilos();
    const v = document.createElement('div');
    v.className = 'ce-velo';
    v.innerHTML = '<div class="ce-card" role="dialog" aria-modal="true" aria-labelledby="ce-t">'
      + '<h2 id="ce-t">Eliminar mi cuenta</h2>'
      + '<p>Si la eliminas:</p><ul>'
      + '<li>No vas a poder volver a entrar con este correo.</li>'
      + '<li>Se cierra tu sesión en todos tus dispositivos y no te llegan más avisos.</li>'
      + '<li>Rendio borra tus datos personales en los plazos de su política de privacidad. Los registros de viajes y pagos se guardan lo que exige la ley.</li>'
      + '</ul>'
      + '<label for="ce-in">Para confirmar, escribe ' + PALABRA + '</label>'
      + '<input id="ce-in" autocomplete="off" autocapitalize="characters" spellcheck="false" />'
      + '<p class="ce-err" hidden></p>'
      + '<div class="ce-acts"><button type="button" class="ce-btn" data-ce="no">Cancelar</button>'
      + '<button type="button" class="ce-btn rojo" data-ce="si" disabled>Eliminar mi cuenta</button></div></div>';
    document.body.appendChild(v);
    const inp = v.querySelector('#ce-in'), si = v.querySelector('[data-ce="si"]'), err = v.querySelector('.ce-err');
    let hecha = false;   // ya eliminada: cerrar = salir (la sesión ya no sirve)
    const cerrar = () => { if (hecha) salir(); else v.remove(); };
    inp.addEventListener('input', () => { si.disabled = inp.value.trim().toUpperCase() !== PALABRA; });
    v.addEventListener('click', async (e) => {
      if (e.target === v) { cerrar(); return; }
      const b = e.target.closest && e.target.closest('[data-ce]');
      if (!b) return;
      if (b.dataset.ce === 'no') { cerrar(); return; }
      if (si.disabled) return;
      si.disabled = true; si.textContent = 'Eliminando…'; err.hidden = true;
      try {
        const { error } = await window.sb.rpc('delete_my_account');
        if (error) throw error;
        hecha = true;
        v.querySelector('.ce-card').innerHTML = '<h2>Tu cuenta fue eliminada</h2>'
          + '<p>Gracias por haber usado Rendio.</p>'
          + '<div class="ce-acts"><button type="button" class="ce-btn rojo" data-ce="fin">Listo</button></div>';
        v.querySelector('[data-ce="fin"]').addEventListener('click', salir);
      } catch (e2) {
        const m = (e2 && e2.message) || '';
        err.textContent = /único administrador/i.test(m) ? m
          : navigator.onLine === false ? 'Sin conexión: no se pudo eliminar. Intenta de nuevo con internet.'
          : 'No se pudo eliminar tu cuenta. Intenta de nuevo en un rato.';
        err.hidden = false;
        si.disabled = false; si.textContent = 'Eliminar mi cuenta';
      }
    });
    setTimeout(() => inp.focus(), 50);
  }

  async function salir() {
    // La base ya cerró las sesiones; esto limpia la que quedó en este teléfono.
    try { if (window.Api && typeof Api.signOut === 'function') await Api.signOut(); } catch (_) { /* */ }
    try { localStorage.removeItem('rn-push-token'); } catch (_) { /* */ }
    location.reload();
  }

  const onClick = (e) => {
    const el = e.target.closest && e.target.closest('[data-cuenta="eliminar"]');
    if (!el) return;
    // Teclado solo para los <div role="button"> (menú del jefe): un <button>
    // ya convierte Enter en clic y se abrirían dos ventanas.
    if (e.type === 'keydown') {
      if (/^(BUTTON|A)$/.test(el.tagName) || (e.key !== 'Enter' && e.key !== ' ')) return;
    }
    e.preventDefault();
    abrir();
  };
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onClick);

  window.RendioCuenta = { abrir };
})();
