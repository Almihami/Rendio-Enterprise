-- 0082 — Doblar turno (decisiones D1–D11 del 27-sep-2026)
--
-- QUÉ HAY HOY:
--   El sistema prohíbe doblar (el generador, el tablero y los cambios de turno lo
--   rechazan), pero en producción ya se dobla por fuera: turnos encadenados de
--   tarde a madrugada, a veces con 4 minutos de diferencia.
--
-- QUÉ HACE ESTA MIGRACIÓN (lo de la base; el resto vive en el front):
--   1. «Puedo doblar»: driver_availability.shift_pref acepta 'both'. La columna
--      existe desde 0015 ('am' | 'pm' | 'any') y ninguna pantalla la llenaba; se
--      usa en vez de crear otra columna.
--   2. app_settings.double_rest_hours: el descanso obligatorio después de una
--      doble (D3: 24 h). Lo leen el tablero, el generador y los cambios de turno.
--
-- LA DOBLE MISMA no necesita tabla: se guarda en weekly_schedules.data._doubles
-- (jsonb), igual que _names. Formato: [{ day, id, tipo: 'dia'|'noche', nota }].
--
-- ORDEN: correr primero en Rendio-dev, verificar, y después en Rendio-Main.

begin;

alter table public.driver_availability
  drop constraint if exists driver_availability_shift_pref_check;
alter table public.driver_availability
  add constraint driver_availability_shift_pref_check
  check (shift_pref in ('am', 'pm', 'any', 'both'));

comment on column public.driver_availability.shift_pref is
  'am | pm | any: preferencia de jornada (0015). both: «Puedo doblar» ese día (0082).';

alter table public.app_settings
  add column if not exists double_rest_hours smallint not null default 24;
alter table public.app_settings
  drop constraint if exists app_settings_double_rest_hours_range;
alter table public.app_settings
  add constraint app_settings_double_rest_hours_range
  check (double_rest_hours between 12 and 72);

comment on column public.app_settings.double_rest_hours is
  'Horas de descanso obligatorio después de un doble turno (D3, 27-sep-2026). 0082.';

commit;
