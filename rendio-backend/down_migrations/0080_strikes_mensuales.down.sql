-- Revierte 0080. El conteo de strikes vuelve a ser de toda la vida: sin filtro
-- de fecha, como estaba desde 0018 y como lo dejó 0037 al hacer configurable el
-- límite. OJO con lo que esta reversión NO puede devolver:
--
--   Los strikes que el paso 5 de 0080 anuló (los vivos de meses anteriores al
--   de la migración) se DESANULAN aquí solo si nadie los volvió a tocar: se
--   reconocen porque su reason termina con la nota que 0080 le concatenó. Si un
--   admin editó ese motivo después, ese strike se queda anulado y hay que
--   sacarlo a mano del respaldo driver_strikes_respaldo_0080.
--
-- El respaldo NO se borra a propósito: es la única copia previa que existe.

-- 1 · Desanular los que anuló la migración, y quitarles la nota del motivo.
update public.driver_strikes
   set voided_at = null,
       reason = regexp_replace(reason, ' · \[Anulado el \d{2}/\d{2}/\d{4}: los strikes pasaron a contarse por mes y este quedó de un mes anterior\.\]$', '')
 where voided_by is null
   and voided_at is not null
   and reason ~ ' · \[Anulado el \d{2}/\d{2}/\d{4}: los strikes pasaron a contarse por mes y este quedó de un mes anterior\.\]$';

-- 2 · El trigger vuelve a contar TODO lo vivo (cuerpo idéntico al de 0037).
create or replace function public.apply_strike_suspension()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_count int;
  susp_week    date;
  v_limit      int;
begin
  select coalesce(strike_limit, 3) into v_limit from public.app_settings where id = 'singleton';
  if v_limit is null or v_limit < 1 then v_limit := 3; end if;

  select count(*) into active_count
  from public.driver_strikes
  where profile_id = NEW.profile_id
    and voided_at is null
    and consumed_at is null;

  if active_count >= v_limit then
    susp_week := NEW.week_start_date + 7;

    insert into public.driver_suspensions
      (profile_id, week_start_date, reason, source, created_by)
    values
      (NEW.profile_id, susp_week, 'Acumuló ' || v_limit || ' strikes', 'strikes', NEW.created_by)
    on conflict (profile_id, week_start_date) do nothing;

    update public.driver_strikes
    set consumed_at = now()
    where profile_id = NEW.profile_id
      and voided_at is null
      and consumed_at is null;
  end if;

  return NEW;
end;
$$;

-- 3 · Fuera el índice y la columna.
drop index if exists public.ix_driver_strikes_periodo;
alter table public.driver_strikes drop column if exists period_start;
