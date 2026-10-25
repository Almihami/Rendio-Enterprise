// Configuración del módulo rendio-turnos.
// El ANON_KEY es público por diseño en Supabase; los datos están protegidos por RLS.
// Apuntando a rendio-MAIN (producción).
window.RENDIO_CONFIG = {
  SUPABASE_URL: 'https://wvuurnfdrrdondrbbkhd.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_u9QZT5XbV3vYF7G_Am0Ffg_Ia8q8IFC',
  VAPID_PUBLIC_KEY: 'BBc3nfT77VmmxRKXGkhcER_Ti8ZWch-12S8WjZuYcn6LpRKyAktgN9Yzu6u4J3IFfWDThcncb09O6e-0UdYJ7uE',
  // Contingencia (14-oct-2026; reabierto 25-oct-2026): en true, «Pedir traslado»
  // y «Repetir» muestran «Estamos en mantenimiento» y no abren el pedido.
  // En false (lo normal) los tripulantes piden por la app.
  PEDIDOS_EN_MANTENIMIENTO: false,
};
