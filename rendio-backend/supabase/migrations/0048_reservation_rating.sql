-- =============================================================================
-- Migration 0048 — la calificación del auxiliar se GUARDA.
--
-- EL HUECO: la pantalla P5 (estrellas + etiquetas, sin propina) solo marcaba
-- t.rated en memoria; al recargar se perdía. Ahora se persiste en la reserva.
--
-- Patrón: columnas en reservations + RPC SECURITY DEFINER validado por
-- current_auxiliar_id (igual que 0047). El auxiliar solo puede calificar SU
-- reserva. Idempotente.
-- =============================================================================
BEGIN;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS rating      smallint,
  ADD COLUMN IF NOT EXISTS rating_tags text[],
  ADD COLUMN IF NOT EXISTS rated_at    timestamptz;

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_rating_range;
ALTER TABLE public.reservations ADD CONSTRAINT reservations_rating_range
  CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);

COMMENT ON COLUMN public.reservations.rating      IS 'Calificación 1-5 que deja el auxiliar tras el viaje (opcional).';
COMMENT ON COLUMN public.reservations.rating_tags IS 'Etiquetas de la calificación (puntual, carro limpio, etc.).';
COMMENT ON COLUMN public.reservations.rated_at    IS 'Cuándo calificó el auxiliar.';

CREATE OR REPLACE FUNCTION public.auxiliar_rate_reservation(
  p_reservation_id uuid,
  p_rating         smallint,
  p_tags           text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_aux uuid := public.current_auxiliar_id();
BEGIN
  IF v_aux IS NULL THEN
    RAISE EXCEPTION 'solo un auxiliar puede calificar';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'calificación fuera de rango (1-5)';
  END IF;

  UPDATE public.reservations
     SET rating = p_rating, rating_tags = p_tags, rated_at = now(), updated_at = now()
   WHERE id = p_reservation_id
     AND auxiliar_profile_id = v_aux;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'la reserva % no es tuya o no existe', p_reservation_id;
  END IF;
END;
$$;

REVOKE ALL    ON FUNCTION public.auxiliar_rate_reservation(uuid, smallint, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auxiliar_rate_reservation(uuid, smallint, text[]) TO authenticated;

COMMENT ON FUNCTION public.auxiliar_rate_reservation(uuid, smallint, text[])
  IS 'El auxiliar dueño califica su reserva (1-5 + etiquetas). SECURITY DEFINER validado por current_auxiliar_id.';

COMMIT;
