-- Down de 0048 — quita la calificación de reservas.
BEGIN;
DROP FUNCTION IF EXISTS public.auxiliar_rate_reservation(uuid, smallint, text[]);
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_rating_range;
ALTER TABLE public.reservations
  DROP COLUMN IF EXISTS rating,
  DROP COLUMN IF EXISTS rating_tags,
  DROP COLUMN IF EXISTS rated_at;
COMMIT;
