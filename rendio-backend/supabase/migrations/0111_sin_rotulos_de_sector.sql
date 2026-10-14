-- =============================================================================
-- 0111 · Fuera los rótulos viejos de sector de los conjuntos
-- =============================================================================
-- Pedido de la profa (13-oct-2026): «eso de Oriente, Sur, Sur-oeste… quítalo, o
-- si no nos confundimos». residences.sector traía seis rótulos del catálogo de
-- agosto (Norte, Sur, Sur-oeste, Oriente, Llanogrande, Rosal). Desde 0108/0109
-- los lugares que importan se DIBUJAN: las zonas de tiempos (route_zones) y los
-- sectores de cobro (billing_sector_rates). Con los rótulos al lado había tres
-- listas de «sectores» que no coincidían entre sí.
--
-- Se vacía la columna; no se borra. Todo lo que la lee ya sabía qué hacer con
-- ella vacía (lo revisé pantalla por pantalla el 13-oct):
--   · cobro (billing_rate_of, 0109): el sector sale de lo puesto a mano o del
--     dibujo; el rótulo era el último recurso y ya no está. «Tarifas por sector»
--     deja de listar los seis.
--   · el selector de conjunto del tripulante, su perfil y el mapa de su viaje: el
--     subtítulo del conjunto sale sin rótulo (o con la nota de acceso).
--   · Asignación: muestra la zona de tiempos en vez del rótulo.
--   · Coordinación: «Conjunto» en vez de «Conjunto · Sector».
-- Al aplicarla nadie cambia de mensualidad: ninguna tarifa usa el nombre de un
-- rótulo y nadie tiene sector a mano con uno (comprobado en dev el 13-oct).
--
-- La reversa (down_migrations/0111) devuelve los 42 rótulos por nombre.
--
-- Idempotente.

BEGIN;

UPDATE public.residences SET sector = NULL WHERE sector IS NOT NULL;

COMMENT ON COLUMN public.residences.sector IS
  'Rótulo viejo del catálogo (Norte, Sur…). Vaciado en 0111 (13-oct-2026): los sectores de cobro se dibujan (billing_sector_rates.polygon, 0109) y las zonas de tiempos también (route_zones, 0108). No volver a llenarlo.';

COMMIT;
