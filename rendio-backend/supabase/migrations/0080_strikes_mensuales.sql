-- 0080 — Los strikes se cuentan por MES
--
-- QUÉ PASA HOY (y no es lo que la gente cree):
--   El contador de strikes NUNCA se reinicia. getActiveStrikeCounts (api.js:486)
--   y apply_strike_suspension() cuentan todo lo que esté vivo, sin filtro de
--   fecha. week_start_date es solo una etiqueta y la semilla para calcular en
--   qué semana cae la suspensión. O sea: un conductor arrastra sus strikes de
--   junio para siempre.
--
-- QUÉ HACE ESTA MIGRACIÓN:
--   Le pone a cada strike el mes al que pertenece, y hace que solo cuenten los
--   del mes en curso. El reinicio no lo hace ningún proceso automático: un
--   strike de agosto deja de contar solo, el 1 de septiembre, porque ya no cae
--   en el filtro.
--
-- QUÉ NO CAMBIA:
--   La suspensión sigue durando UNA SEMANA (la siguiente). Toda la operación es
--   semanal — el horario, la disponibilidad, las solicitudes — y driver_suspensions
--   no tiene columna de duración: la duración está implícita en que las consultas
--   la buscan por lunes exacto.
--
-- ORDEN: correr primero en Rendio-dev, verificar, y después en Rendio-Main.
-- ANTES DE CORRERLA EN MAIN: guardar el respaldo del paso 0.

begin;

-- ---------------------------------------------------------------------------
-- 0 · RESPALDO. No hay carpeta de migraciones previa ni rollback automático:
--     esta copia es la única red que va a existir. Se queda en la base.
-- ---------------------------------------------------------------------------
create table if not exists public.driver_strikes_respaldo_0080 as
  select * from public.driver_strikes;

-- ---------------------------------------------------------------------------
-- 1 · La columna del mes. Entra vacía para que el relleno del paso 2 le ponga
--     a cada strike SU mes, y no el mes de hoy a todos.
-- ---------------------------------------------------------------------------
alter table public.driver_strikes
  add column if not exists period_start date;

-- ---------------------------------------------------------------------------
-- 2 · Cada strike viejo se etiqueta con el mes en que REALMENTE se puso.
--     Se usa created_at, no week_start_date: created_at es cuándo ocurrió de
--     verdad; week_start_date es la semana que el admin tenía abierta en pantalla,
--     que puede ser la siguiente (hay uno fechado 2026-09-14, un lunes futuro).
--     Hora de Bogotá: sin eso, un strike puesto después de las 7 p.m. del último
--     día del mes se iría al mes siguiente.
-- ---------------------------------------------------------------------------
update public.driver_strikes
   set period_start = (date_trunc('month', (created_at at time zone 'America/Bogota')))::date
 where period_start is null;

-- ---------------------------------------------------------------------------
-- 3 · De aquí en adelante, todo strike nuevo nace con el mes en curso.
--     process_pending_inspections() inserta sin nombrar la columna, así que
--     hereda este default sin tocarle una línea.
-- ---------------------------------------------------------------------------
alter table public.driver_strikes
  alter column period_start set default (date_trunc('month', (now() at time zone 'America/Bogota')))::date;

alter table public.driver_strikes
  alter column period_start set not null;

-- ---------------------------------------------------------------------------
-- 4 · El índice de la única consulta que cuenta.
-- ---------------------------------------------------------------------------
create index if not exists ix_driver_strikes_periodo
  on public.driver_strikes (profile_id, period_start)
  where voided_at is null and consumed_at is null;

-- ---------------------------------------------------------------------------
-- 5 · LOS VIEJOS. Los strikes vivos de meses anteriores se anulan dejando rastro.
--     Se CONCATENA al motivo, nunca se pisa: reason guarda la razón disciplinaria
--     original y es lo único que el conductor ve en su historial.
--     voided_by queda en null a propósito: no lo anuló una persona, lo anuló el
--     cambio de regla.
--     Sin este paso, alguien quedaría suspendido en septiembre por faltas de junio.
-- ---------------------------------------------------------------------------
update public.driver_strikes
   set voided_at = now(),
       reason = reason || ' · [Anulado el '
                || to_char((now() at time zone 'America/Bogota'), 'DD/MM/YYYY')
                || ': los strikes pasaron a contarse por mes y este quedó de un mes anterior.]'
 where voided_at is null
   and consumed_at is null
   and period_start < (date_trunc('month', (now() at time zone 'America/Bogota')))::date;

-- ---------------------------------------------------------------------------
-- 6 · El disparador. Cuerpo original volcado antes de tocarlo; lo único que
--     cambia son las dos condiciones de mes y el cálculo del lunes.
--     Sigue siendo AFTER INSERT, así que el strike que acaba de entrar ya se
--     cuenta a sí mismo y el >= sigue siendo correcto.
-- ---------------------------------------------------------------------------
create or replace function public.apply_strike_suspension()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  active_count int;
  susp_week    date;
  v_limit      int;
begin
  select coalesce(strike_limit, 3) into v_limit from public.app_settings where id = 'singleton';
  if v_limit is null or v_limit < 1 then v_limit := 3; end if;

  -- CAMBIO: solo cuentan los strikes del MISMO MES que el que acaba de entrar.
  select count(*) into active_count
  from public.driver_strikes
  where profile_id = NEW.profile_id
    and period_start = NEW.period_start          -- <-- lo nuevo
    and voided_at is null
    and consumed_at is null;

  if active_count >= v_limit then
    -- La suspensión sigue siendo semanal. date_trunc normaliza a lunes aunque
    -- week_start_date venga corrido, que es lo que evita suspensiones invisibles:
    -- las consultas la buscan por lunes exacto y una fecha corrida no aparece nunca.
    susp_week := (date_trunc('week', NEW.week_start_date::timestamp))::date + 7;

    insert into public.driver_suspensions
      (profile_id, week_start_date, reason, source, created_by)
    values
      (NEW.profile_id, susp_week, 'Acumuló ' || v_limit || ' strikes en el mes', 'strikes', NEW.created_by)
    on conflict (profile_id, week_start_date) do nothing;

    -- Consume solo los del mes en curso: los de otros meses ya no contaban.
    update public.driver_strikes
    set consumed_at = now()
    where profile_id = NEW.profile_id
      and period_start = NEW.period_start        -- <-- lo nuevo
      and voided_at is null
      and consumed_at is null;
  end if;

  return NEW;
end;
$function$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICACIÓN. Correr después del commit y comparar con lo esperado.
-- ---------------------------------------------------------------------------
-- select p.full_name,
--        count(*) filter (where s.voided_at is null and s.consumed_at is null
--                           and s.period_start = (date_trunc('month',(now() at time zone 'America/Bogota')))::date) as cuenta_este_mes,
--        count(*) filter (where s.voided_at is not null) as anulados
--   from public.driver_strikes s
--   join public.profiles p on p.id = s.profile_id
--  group by p.full_name order by cuenta_este_mes desc;
