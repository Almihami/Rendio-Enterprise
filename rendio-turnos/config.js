// Configuración del módulo rendio-turnos.
// El ANON_KEY es público por diseño en Supabase; los datos están protegidos por RLS.
// Apuntando a rendio-DEV.
window.RENDIO_CONFIG = {
  SUPABASE_URL: 'https://lxlphbafhtphulanhzlp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Jj4JIZ870ZY1wJMWpY8U6A_6Jz7icoo',
  // Stack LOCAL (para probar Etapa 1 del módulo conductor):
  // SUPABASE_URL: 'http://127.0.0.1:54321',
  // SUPABASE_ANON_KEY: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
  VAPID_PUBLIC_KEY: 'BDbSeYdp1m3324kEA_t4naZMFm_T-iPMmjsSaMkrIcsnZ2jvXEhOarlP6sztOGTySex8gP1FQ0zMFwv96bpvUTE',
  // Contingencia (14-oct-2026; reabierto 25-oct-2026): en true, «Pedir traslado»
  // y «Repetir» muestran «Estamos en mantenimiento» y no abren el pedido.
  // En false (lo normal) los tripulantes piden por la app.
  PEDIDOS_EN_MANTENIMIENTO: false,
};
