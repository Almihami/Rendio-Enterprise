(function () {
  const cfg = window.RENDIO_CONFIG;
  if (!cfg?.SUPABASE_URL || !cfg?.SUPABASE_ANON_KEY) {
    alert('Falta config.js con SUPABASE_URL y SUPABASE_ANON_KEY');
    throw new Error('Missing Supabase config');
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    alert('No se cargó la librería de Supabase (¿bloqueada por la red?)');
    throw new Error('supabase-js not loaded');
  }
  window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
})();
