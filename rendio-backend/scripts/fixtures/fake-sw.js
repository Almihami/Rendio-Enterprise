// fixtures/fake-sw.js — service worker FALSO para pruebas jsdom (P2, rediseño del auxiliar 27-sep-2026).
//
// Se evalúa DENTRO de la ventana (window.eval(texto) en jsdom, o pegado en
// javascript_tool) ANTES de cargar la app. Reemplaza navigator.serviceWorker por
// un EventTarget, así el shell puede escuchar 'message' y la prueba puede
// simular el postMessage que hace sw.js al recibir un push:
//
//   window.__fakeSW.post({ type: 'rendio-push', title: '…', body: '…', url: '/#/viaje?r=ID' });
//
// También trae un registro con pushManager (sin suscripción) para que
// auxSetupPwa y enablePush no revienten. No prueba nada del service worker real:
// ni cache.addAll, ni la llegada de un push, ni showNotification del sistema.
(function () {
  'use strict';
  const target = new EventTarget();
  const shown = [];
  const reg = {
    scope: '/',
    active: { state: 'activated', postMessage() {} },
    pushManager: {
      _sub: null,
      getSubscription() { return Promise.resolve(this._sub); },
      subscribe(opts) { this._sub = { endpoint: 'https://fake.push/1', options: opts || {}, toJSON() { return { endpoint: this.endpoint, keys: {} }; }, unsubscribe() { return Promise.resolve(true); } }; return Promise.resolve(this._sub); },
      permissionState() { return Promise.resolve('prompt'); },
    },
    showNotification(title, opts) { shown.push({ title, opts: opts || {} }); return Promise.resolve(); },
    getNotifications() { return Promise.resolve([]); },
    update() { return Promise.resolve(); },
    unregister() { return Promise.resolve(true); },
  };
  const sw = {
    controller: null,
    ready: Promise.resolve(reg),
    register() { return Promise.resolve(reg); },
    getRegistration() { return Promise.resolve(reg); },
    getRegistrations() { return Promise.resolve([reg]); },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    startMessages() {},
  };
  try { Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true }); }
  catch (_) { navigator.serviceWorker = sw; }
  window.__fakeSW = {
    sw, reg, shown,
    // Lo mismo que hace sw.js: postMessage a las ventanas abiertas.
    post(data) {
      const ev = typeof MessageEvent === 'function' ? new MessageEvent('message', { data }) : Object.assign(new Event('message'), { data });
      target.dispatchEvent(ev);
    },
  };
})();
