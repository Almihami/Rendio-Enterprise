-- DOWN de 0082 — Doblar turno.
-- «Puedo doblar» vuelve a 'any' (si no, el CHECK viejo no entra) y se quita el
-- parámetro de descanso. Las dobles guardadas en weekly_schedules.data._doubles
-- no se tocan: el front viejo las ignora.
begin;
update public.driver_availability set shift_pref = 'any' where shift_pref = 'both';
alter table public.driver_availability
  drop constraint if exists driver_availability_shift_pref_check;
alter table public.driver_availability
  add constraint driver_availability_shift_pref_check
  check (shift_pref in ('am', 'pm', 'any'));
alter table public.app_settings
  drop constraint if exists app_settings_double_rest_hours_range;
alter table public.app_settings
  drop column if exists double_rest_hours;
commit;
