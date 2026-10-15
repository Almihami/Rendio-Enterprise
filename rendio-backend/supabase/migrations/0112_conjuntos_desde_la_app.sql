-- =============================================================================
-- Migration 0112 — Conjuntos desde la app (14-oct-2026)
--
-- Hasta hoy el catálogo de conjuntos (0055) solo se tocaba por script: no había
-- pantalla para agregar uno, mover su pin ni sacarlo de la lista. Desde ahora
-- el jefe lo hace en Rutas › Configuración › Conjuntos. Los permisos ya estaban
-- (p_residences_admin_all: solo admin escribe); lo que faltaba es esto:
--
-- Una reserva COPIA la coordenada y el nombre del conjunto al nacer
-- (fill_reservation_pickup, 0055/0083), y el tablero rutea con esa copia. Sin
-- este trigger, corregir el pin de un conjunto no le servía a los viajes que ya
-- estaban pedidos: el carro de mañana seguía yendo al punto viejo. Ahora, al
-- mover el pin o cambiar el nombre o la nota de acceso, se ponen al día las
-- reservas de ese conjunto que:
--   · no están canceladas y todavía no pasaron (required_arrival_at >= now()), y
--   · tienen la coordenada (o la dirección) que heredaron del conjunto. Un pin
--     propio puesto en el pedido no se toca.
--
-- Desactivar (is_active = false) no toca reservas: el conjunto sale de la lista
-- para elegir (listResidences, signup_catalogs) y quien ya vive ahí lo conserva.
--
-- Corre con los permisos de quien edita (sin SECURITY DEFINER): solo un admin
-- puede cambiar un conjunto, y un admin puede actualizar reservas
-- (p_reservations_update_admin). Idempotente.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.residence_point_to_trips()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Igual que arma la dirección fill_reservation_pickup.
  old_addr text := OLD.name || coalesce(' · ' || nullif(btrim(OLD.access_note), ''), '');
  new_addr text := NEW.name || coalesce(' · ' || nullif(btrim(NEW.access_note), ''), '');
BEGIN
  UPDATE public.reservations rv SET
    pickup_latitude  = CASE WHEN rv.pickup_latitude = OLD.latitude AND rv.pickup_longitude = OLD.longitude
                            THEN NEW.latitude  ELSE rv.pickup_latitude  END,
    pickup_longitude = CASE WHEN rv.pickup_latitude = OLD.latitude AND rv.pickup_longitude = OLD.longitude
                            THEN NEW.longitude ELSE rv.pickup_longitude END,
    pickup_address   = CASE WHEN rv.pickup_address = old_addr THEN new_addr ELSE rv.pickup_address END
  WHERE rv.residence_id = NEW.id
    AND rv.cancelled_at IS NULL
    AND rv.required_arrival_at >= now()
    AND ((rv.pickup_latitude = OLD.latitude AND rv.pickup_longitude = OLD.longitude)
         OR rv.pickup_address = old_addr);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.residence_point_to_trips() IS
  'Al mover el pin o renombrar un conjunto, pone al día las reservas futuras que heredaron su punto (0112).';

DROP TRIGGER IF EXISTS tr_residences_point_to_trips ON public.residences;
CREATE TRIGGER tr_residences_point_to_trips
  AFTER UPDATE OF latitude, longitude, name, access_note ON public.residences
  FOR EACH ROW
  WHEN (OLD.latitude    IS DISTINCT FROM NEW.latitude
     OR OLD.longitude   IS DISTINCT FROM NEW.longitude
     OR OLD.name        IS DISTINCT FROM NEW.name
     OR OLD.access_note IS DISTINCT FROM NEW.access_note)
  EXECUTE FUNCTION public.residence_point_to_trips();

COMMIT;
