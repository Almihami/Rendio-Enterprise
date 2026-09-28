-- Revierte 0083: fill_reservation_pickup vuelve a la versión de 0075 (hereda el
-- conjunto del perfil aunque la reserva traiga pin propio).
-- NO se puede devolver: las reservas futuras a las que 0083 les quitó el conjunto
-- (pin a más de 150 m) se quedan sin él; volver a pegárselo reintroduce la falla.

BEGIN;

CREATE OR REPLACE FUNCTION public.fill_reservation_pickup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  r  public.residences%ROWTYPE;
  ap public.auxiliar_profiles%ROWTYPE;
BEGIN
  SELECT * INTO ap FROM public.auxiliar_profiles WHERE id = NEW.auxiliar_profile_id;

  -- Sin residencia explícita, heredar la del perfil del auxiliar.
  IF NEW.residence_id IS NULL THEN
    NEW.residence_id := ap.residence_id;
  END IF;

  IF NEW.residence_id IS NOT NULL THEN
    SELECT * INTO r FROM public.residences WHERE id = NEW.residence_id;
    IF FOUND THEN
      IF NEW.pickup_latitude  IS NULL THEN NEW.pickup_latitude  := r.latitude;  END IF;
      IF NEW.pickup_longitude IS NULL THEN NEW.pickup_longitude := r.longitude; END IF;
      IF btrim(coalesce(NEW.pickup_address, '')) = '' THEN
        NEW.pickup_address := r.name || coalesce(' · ' || nullif(btrim(r.access_note), ''), '');
      END IF;
    END IF;
  END IF;

  -- El apartamento: solo si no vino en el pedido, y solo el de la unidad que
  -- de verdad corresponde al conjunto de esta reserva.
  IF btrim(coalesce(NEW.residence_unit, '')) = '' AND NEW.residence_id IS NOT NULL THEN
    IF ap.residence_id_2 IS NOT NULL AND NEW.residence_id = ap.residence_id_2
       AND (ap.residence_id IS NULL OR ap.residence_id <> ap.residence_id_2) THEN
      NEW.residence_unit := nullif(btrim(coalesce(ap.residence_unit_2, '')), '');
    ELSIF NEW.residence_id = ap.residence_id THEN
      NEW.residence_unit := nullif(btrim(coalesce(ap.residence_unit, '')), '');
    END IF;
  END IF;

  -- Último recurso: el pin propio del perfil (auxiliar fuera del catálogo).
  IF NEW.pickup_latitude IS NULL OR NEW.pickup_longitude IS NULL THEN
    NEW.pickup_latitude  := ap.home_latitude;
    NEW.pickup_longitude := ap.home_longitude;
    NEW.pickup_address   := coalesce(nullif(btrim(coalesce(NEW.pickup_address, '')), ''), ap.home_address);
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
