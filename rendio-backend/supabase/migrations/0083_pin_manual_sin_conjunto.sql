-- =============================================================================
-- 0083 · La dirección escrita a mano ya no hereda el conjunto del perfil
-- =============================================================================
-- Falla hallada el 27-sep-2026 al revisar el rediseño del auxiliar.
--
-- fill_reservation_pickup() (0075) le ponía la residencia del perfil a TODA
-- reserva que llegaba sin residence_id, también a la que el tripulante pidió
-- desde otra dirección con su propio pin («Hoy salgo de otro lado»). El tablero
-- agrupa las paradas por residencia (rtStopKey → 'r:' + resId, admin-rutas.js),
-- así que esa reserva quedaba pegada a la parada de su conjunto: si ese día
-- viajaba un vecino, el carro paraba UNA vez, en el conjunto, y no en la
-- dirección que ella escribió.
--
-- Arreglo: la residencia del perfil se hereda solo cuando la reserva no trae
-- punto propio (sin coordenadas). Con pin propio, residence_id queda NULL y la
-- parada se agrupa por coordenada, como cualquier pin manual. Todo lo demás de
-- la función (datos del conjunto, apartamento de la unidad que corresponde y el
-- pin del perfil como último recurso) queda igual que en 0075.
--
-- Además corrige las reservas FUTURAS que ya quedaron mal: pin propio a más de
-- 150 m del conjunto que se les pegó. Las pasadas no se tocan (ya ocurrieron).
-- =============================================================================

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

  -- Sin residencia explícita Y sin punto propio, heredar la del perfil.
  -- (0083) Con pin propio NO: es otra dirección y debe ser otra parada.
  IF NEW.residence_id IS NULL
     AND NEW.pickup_latitude IS NULL AND NEW.pickup_longitude IS NULL THEN
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

-- Reservas futuras con pin propio lejos del conjunto que se les pegó.
-- 150 m: una portería y su parqueadero caben de sobra; otra dirección no.
DO $$
DECLARE n int;
BEGIN
  WITH malas AS (
    SELECT r.id
    FROM public.reservations r
    JOIN public.residences s ON s.id = r.residence_id
    WHERE r.cancelled_at IS NULL
      AND r.required_arrival_at > now()
      AND r.pickup_latitude IS NOT NULL AND r.pickup_longitude IS NOT NULL
      AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      AND 111320 * sqrt(
            power(r.pickup_latitude - s.latitude, 2)
          + power((r.pickup_longitude - s.longitude) * cos(radians(s.latitude)), 2)
          ) > 150
  )
  UPDATE public.reservations r
     SET residence_id = NULL, residence_unit = NULL, updated_at = now()
    FROM malas m
   WHERE r.id = m.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '0083: % reservas futuras con pin propio dejaron de estar pegadas a un conjunto', n;
END $$;

COMMIT;
