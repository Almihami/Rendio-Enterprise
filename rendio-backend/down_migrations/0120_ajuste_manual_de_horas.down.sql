-- DOWN de 0120 — quita el ajuste manual de horas.
-- OJO: borra los ajustes guardados. Respaldar shift_hour_adjustments antes.
begin;
drop function if exists public.void_shift_hour_adjustment(uuid, text);
drop function if exists public.adjust_shift_hours(uuid, uuid, date, timestamptz, timestamptz, text);
drop table if exists public.shift_hour_adjustments;
commit;
