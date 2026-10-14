-- =============================================================================
-- 0108 · Zonas dibujadas en el mapa
-- =============================================================================
-- Pedido del 13-oct-2026: las zonas de la tabla de tiempos dejan de ser cuatro
-- nombres fijos en el código. El admin las crea, las renombra, las quita y las
-- DIBUJA en el mapa (así describió la profa Barro Blanco: una elipse sobre la
-- vía al aeropuerto).
--
-- LA ZONA DE UN CONJUNTO SALE ASÍ, en este orden:
--   1. residences.zona_jefe — puesta A MANO. Es la excepción y gana siempre.
--      Existe porque las zonas de Julián son operativas, no geográficas: Los
--      Cerezos queda a menos de 200 m de Olivar (Fontibón) y él lo puso en
--      Porvenir. Ningún dibujo razonable da eso.
--   2. El dibujo: si el punto cae dentro de UNA sola zona, esa. En dos o más a la
--      vez, ninguna (que decida una persona). Fuera de todas, ninguna.
-- El cálculo se hace en la app (zonas-dibujo.js), no aquí: el tablero, la
-- pantalla de calibración y el plan por WhatsApp leen el mismo archivo.
--
-- public.route_zones
--   name        text UNIQUE — el nombre ES la llave que ya usan route_zone_times.zone
--                          y residences.zona_jefe. Renombrar se propaga solo
--                          (ON UPDATE CASCADE) y nadie queda apuntando a un nombre
--                          viejo.
--   polygon     jsonb    — [[lat, lng], …], 3 puntos o más. NULL = todavía sin
--                          dibujo: la zona existe y se puede asignar a mano.
--   sort_order  smallint — orden de las columnas y del color en pantalla.
--
-- Una zona SIN filas en route_zone_times no se aplica: sus conjuntos se programan
-- con el cálculo por carretera, igual que los que no tienen zona. Así se puede
-- crear y dibujar antes de que Julián dé los minutos.
--
-- Quitar una zona: se van sus tiempos (CASCADE) y sus conjuntos puestos a mano
-- vuelven a «según el mapa» (SET NULL).
--
-- Idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS public.route_zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  polygon     jsonb CHECK (polygon IS NULL OR (jsonb_typeof(polygon) = 'array' AND jsonb_array_length(polygon) >= 3)),
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.route_zones IS
  'Zonas de la tabla de tiempos (0108). La zona de un conjunto: residences.zona_jefe (a mano) y, si está vacía, el dibujo que contiene su punto (solo si es uno). Ver zonas-dibujo.js.';
COMMENT ON COLUMN public.route_zones.polygon IS
  '[[lat, lng], …] con 3 puntos o más, en el orden en que se marcaron. NULL = la zona todavía no está dibujada.';

DROP TRIGGER IF EXISTS tr_route_zones_set_updated_at ON public.route_zones;
CREATE TRIGGER tr_route_zones_set_updated_at BEFORE UPDATE ON public.route_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Las que ya existen, en el orden en que Julián las dictó. Sin dibujo: se
-- dibujan desde el admin. Cualquier nombre suelto que ya estuviera en uso entra
-- también, para que las llaves foráneas de abajo no fallen.
INSERT INTO public.route_zones (name, sort_order) VALUES
  ('Fontibón', 1), ('Porvenir', 2), ('Sendai/San Antonio', 3), ('Marinilla', 4)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.route_zones (name, sort_order)
  SELECT DISTINCT z, 50 FROM (
    SELECT zone AS z FROM public.route_zone_times
    UNION SELECT zona_jefe FROM public.residences WHERE zona_jefe IS NOT NULL
  ) s
ON CONFLICT (name) DO NOTHING;

-- El nombre como llave de verdad.
ALTER TABLE public.route_zone_times DROP CONSTRAINT IF EXISTS route_zone_times_zone_fkey;
ALTER TABLE public.route_zone_times ADD CONSTRAINT route_zone_times_zone_fkey
  FOREIGN KEY (zone) REFERENCES public.route_zones(name) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.residences DROP CONSTRAINT IF EXISTS residences_zona_jefe_fkey;
ALTER TABLE public.residences ADD CONSTRAINT residences_zona_jefe_fkey
  FOREIGN KEY (zona_jefe) REFERENCES public.route_zones(name) ON UPDATE CASCADE ON DELETE SET NULL;

COMMENT ON COLUMN public.residences.zona_jefe IS
  'Zona puesta A MANO (excepción). NULL = según el dibujo de route_zones (0108). Antes de 0108, NULL significaba «sin zona».';

-- RLS: el mismo patrón de route_zone_times (configuración de la operación):
-- lee cualquiera, escribe solo admin.
ALTER TABLE public.route_zones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_route_zones_select_all ON public.route_zones;
CREATE POLICY p_route_zones_select_all ON public.route_zones
  FOR SELECT USING (true);
DROP POLICY IF EXISTS p_route_zones_admin_all ON public.route_zones;
CREATE POLICY p_route_zones_admin_all ON public.route_zones
  FOR ALL USING (current_user_role() = 'admin') WITH CHECK (current_user_role() = 'admin');

COMMIT;
