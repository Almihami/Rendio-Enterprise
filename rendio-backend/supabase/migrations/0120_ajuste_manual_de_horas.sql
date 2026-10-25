-- 0120 — Ajuste manual de horas desde el Balance de turnos (25-oct-2026)
--
-- POR QUÉ: pedido de la profa. A los jefes les reportan eventualidades (el
-- teléfono se apagó y el turno lo cerró el sistema, la app se recargó y no dejó
-- iniciar, el conductor cerró tarde) y hoy no hay cómo corregir las horas: el
-- Balance lee los turnos tal cual y lo único que se podía hacer era tocar la base
-- a mano. Ahora el jefe, en Balance › Horas reales por persona › «Ajustar
-- horas», escribe el día, de qué hora a qué hora y una observación.
--
-- DISEÑO: el turno original NO se toca. shifts es la evidencia de lo que pasó en
-- la app (kilometraje, inspecciones, tiempos aprendidos y la Revisión leen de
-- ahí); el ajuste vive al lado, en su propia tabla, y el Balance (BalanceCore en
-- admin-balance.js) lo pone encima al sumar. Así se ve siempre qué decía la app
-- y qué decidió el jefe.
--
--   • Con shift_id: corrige ESE turno. Sus horas pagables pasan a ser las del
--     ajuste, aunque el turno fuera auto-cerrado o arranque falso (que antes
--     sumaban 0). Un turno tiene a lo sumo UN ajuste vigente: guardar otro anula
--     el anterior (queda el rastro).
--   • Sin shift_id: un turno que nunca quedó en la app. Suma aparte.
--   • Nada se borra. Equivocarse = anular (quién, cuándo y por qué) y, si hace
--     falta, hacer uno nuevo.
--
-- QUÉ HACE:
--   1. shift_hour_adjustments + RLS de solo lectura (el jefe ve los de su
--      organización; el conductor, los suyos, para su «Mis horas»).
--   2. adjust_shift_hours(...) — guarda un ajuste. SECURITY DEFINER, solo jefes.
--      Valida: la persona tiene ficha de conductor, el turno es de esa persona,
--      el turno ya cerró, el día del ajuste es el día en que arrancó el turno
--      (la misma regla del Balance: un turno pertenece al día en que ARRANCÓ),
--      la hora ya pasó, dura más de 0 y hasta 24 h, y no se cruza con otras horas
--      de la misma persona (sería pagarlas dos veces).
--   3. void_shift_hour_adjustment(id, motivo) — lo anula. Solo jefes.
--   Las dos escriben en audit_events (log_audit_event).
--
-- LO QUE NO HACE: no cambia shifts, ni el cierre, ni el auto-cierre, ni los
-- strikes. No le avisa al conductor (ve el ajuste en «Mis horas»).
--
-- DOWN: down_migrations/0120_ajuste_manual_de_horas.down.sql.

begin;

-- -----------------------------------------------------------------------------
-- 1. La tabla
-- -----------------------------------------------------------------------------
create table if not exists public.shift_hour_adjustments (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references public.organizations(id) on delete restrict,
  driver_id        uuid        not null references public.driver_profiles(id) on delete restrict,
  shift_id         uuid        references public.shifts(id) on delete set null,
  work_date        date        not null,
  start_at         timestamptz not null,
  end_at           timestamptz not null,
  note             text        not null,
  -- Cómo estaba el turno en el momento del ajuste (si después cambia, el rastro
  -- sigue diciendo qué se corrigió).
  orig_start_at    timestamptz,
  orig_end_at      timestamptz,
  orig_kind        text,
  created_by       uuid        not null references public.profiles(id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        uuid        references public.profiles(id) on delete restrict,
  void_note        text,
  constraint sha_end_after_start check (end_at > start_at),
  constraint sha_max_24h        check (end_at - start_at <= interval '24 hours'),
  constraint sha_note_len       check (char_length(btrim(note)) >= 10),
  constraint sha_orig_kind      check (orig_kind is null or orig_kind in ('ok', 'auto', 'falso', 'curso')),
  constraint sha_void_completo  check ((voided_at is null) = (voided_by is null)
                                       and (voided_at is null or char_length(btrim(coalesce(void_note, ''))) >= 5))
);

comment on table public.shift_hour_adjustments is
  'Ajustes manuales de horas que hace el jefe desde el Balance (0120). El turno original (shifts) no se toca: el Balance pone el ajuste encima al sumar. Nada se borra: se anula.';
comment on column public.shift_hour_adjustments.shift_id is
  'Turno que corrige. Null = turno que nunca quedó registrado en la app (suma aparte).';
comment on column public.shift_hour_adjustments.work_date is
  'Día (hora Bogotá) en que arrancó el turno: el mismo día con que el Balance reparte los turnos en los cortes.';
comment on column public.shift_hour_adjustments.orig_kind is
  'Cómo clasificaba el Balance el turno al ajustarlo: ok (completo), auto (auto-cerrado), falso (arranque falso), curso.';

-- Un turno tiene a lo sumo un ajuste vigente.
create unique index if not exists uq_sha_turno_vigente
  on public.shift_hour_adjustments (shift_id)
  where voided_at is null and shift_id is not null;
create index if not exists idx_sha_org_dia    on public.shift_hour_adjustments (organization_id, work_date);
create index if not exists idx_sha_driver_dia on public.shift_hour_adjustments (driver_id, work_date);

drop trigger if exists tr_sha_set_updated_at on public.shift_hour_adjustments;
create trigger tr_sha_set_updated_at
  before update on public.shift_hour_adjustments
  for each row execute function public.set_updated_at();

alter table public.shift_hour_adjustments enable row level security;

drop policy if exists p_sha_select_admin on public.shift_hour_adjustments;
create policy p_sha_select_admin
  on public.shift_hour_adjustments for select to authenticated
  using (public.current_user_role() = 'admin' and organization_id = public.current_user_org());

drop policy if exists p_sha_select_own on public.shift_hour_adjustments;
create policy p_sha_select_own
  on public.shift_hour_adjustments for select to authenticated
  using (driver_id = public.current_driver_id());

-- Sin políticas de insert/update/delete: solo se escribe por las dos funciones.
revoke insert, update, delete on public.shift_hour_adjustments from anon, authenticated;
grant select on public.shift_hour_adjustments to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Guardar un ajuste
-- -----------------------------------------------------------------------------
create or replace function public.adjust_shift_hours(
  p_profile_id uuid,
  p_shift_id   uuid,
  p_work_date  date,
  p_start_at   timestamptz,
  p_end_at     timestamptz,
  p_note       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_org     uuid := public.current_user_org();
  v_driver  uuid;
  v_shift   public.shifts%rowtype;
  v_kind    text;
  v_prev    uuid;
  v_choque  text;
  v_id      uuid;
  v_note    text := btrim(coalesce(p_note, ''));
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'NOT_ADMIN: solo un jefe puede ajustar horas';
  end if;

  select dp.id into v_driver
    from public.driver_profiles dp
    join public.profiles p on p.id = dp.profile_id
   where dp.profile_id = p_profile_id and p.organization_id = v_org;
  if v_driver is null then
    raise exception 'NO_DRIVER: esa persona no tiene ficha de conductor en tu organización';
  end if;

  if p_work_date is null or p_start_at is null or p_end_at is null then
    raise exception 'FALTAN_DATOS: falta el día o las horas';
  end if;
  if p_end_at <= p_start_at then
    raise exception 'RANGO: la hora final tiene que ser después de la inicial';
  end if;
  if p_end_at - p_start_at > interval '24 hours' then
    raise exception 'RANGO: un ajuste no puede pasar de 24 horas';
  end if;
  if (p_start_at at time zone 'America/Bogota')::date <> p_work_date then
    raise exception 'DIA: la hora inicial tiene que caer en el día elegido';
  end if;
  if p_end_at > now() + interval '5 minutes' then
    raise exception 'FUTURO: esa hora todavía no ha pasado';
  end if;
  if char_length(v_note) < 10 then
    raise exception 'NOTA: escribe qué pasó (mínimo 10 letras)';
  end if;

  if p_shift_id is not null then
    select * into v_shift from public.shifts where id = p_shift_id for update;
    if not found then raise exception 'SHIFT_NOT_FOUND: ese turno ya no existe'; end if;
    if v_shift.organization_id <> v_org then raise exception 'WRONG_ORG'; end if;
    if v_shift.driver_id <> v_driver then
      raise exception 'OTRA_PERSONA: ese turno es de otra persona';
    end if;
    if v_shift.end_at is null then
      raise exception 'ABIERTO: ese turno sigue abierto; ciérralo primero (Turnos activos)';
    end if;
    if (v_shift.start_at at time zone 'America/Bogota')::date <> p_work_date then
      raise exception 'DIA: el turno arrancó otro día; el ajuste va en el día en que arrancó';
    end if;
    v_kind := case
      when v_shift.opening_km is null then 'falso'
      when v_shift.end_at is null then 'curso'
      when v_shift.closing_km is null then 'auto'
      else 'ok' end;
  end if;

  -- ¿Se cruza con otras horas de la misma persona? Cuentan los ajustes vigentes
  -- (menos el que se va a reemplazar) y los turnos que arrancaron de verdad
  -- (menos el que se corrige y los que ya tienen ajuste: su hora vigente es la
  -- del ajuste, y esa ya está en la primera consulta).
  select format('el ajuste del %s de %s a %s',
                to_char(a.start_at at time zone 'America/Bogota', 'DD-MM'),
                to_char(a.start_at at time zone 'America/Bogota', 'HH24:MI'),
                to_char(a.end_at   at time zone 'America/Bogota', 'HH24:MI'))
    into v_choque
    from public.shift_hour_adjustments a
   where a.driver_id = v_driver and a.voided_at is null
     and (p_shift_id is null or a.shift_id is distinct from p_shift_id)
     and tstzrange(a.start_at, a.end_at) && tstzrange(p_start_at, p_end_at)
   limit 1;
  if v_choque is null then
    select format('el turno del %s que arrancó a las %s',
                  to_char(s.start_at at time zone 'America/Bogota', 'DD-MM'),
                  to_char(s.start_at at time zone 'America/Bogota', 'HH24:MI'))
      into v_choque
      from public.shifts s
     where s.driver_id = v_driver
       and s.id is distinct from p_shift_id
       and s.opening_km is not null
       and not exists (select 1 from public.shift_hour_adjustments a
                        where a.shift_id = s.id and a.voided_at is null)
       and tstzrange(s.start_at, coalesce(s.end_at, now())) && tstzrange(p_start_at, p_end_at)
     limit 1;
  end if;
  if v_choque is not null then
    raise exception 'CRUCE: esas horas se cruzan con %. Si es ese turno, corrígelo a él', v_choque;
  end if;

  -- Guardar otro ajuste del mismo turno anula el anterior.
  if p_shift_id is not null then
    update public.shift_hour_adjustments
       set voided_at = now(), voided_by = v_uid, void_note = 'Reemplazado por un ajuste nuevo'
     where shift_id = p_shift_id and voided_at is null
    returning id into v_prev;
  end if;

  insert into public.shift_hour_adjustments
    (organization_id, driver_id, shift_id, work_date, start_at, end_at, note,
     orig_start_at, orig_end_at, orig_kind, created_by)
  values
    (v_org, v_driver, p_shift_id, p_work_date, p_start_at, p_end_at, v_note,
     v_shift.start_at, v_shift.end_at, v_kind, v_uid)
  returning id into v_id;

  perform public.log_audit_event(
    'shift_hours_adjusted', 'shift_hour_adjustment', v_id,
    jsonb_build_object('driver_id', v_driver, 'shift_id', p_shift_id, 'work_date', p_work_date,
                       'start_at', p_start_at, 'end_at', p_end_at, 'note', v_note,
                       'orig_start_at', v_shift.start_at, 'orig_end_at', v_shift.end_at,
                       'orig_kind', v_kind, 'replaces', v_prev, 'by', v_uid));

  return jsonb_build_object('ok', true, 'id', v_id, 'replaced', v_prev);
end;
$fn$;

comment on function public.adjust_shift_hours(uuid, uuid, date, timestamptz, timestamptz, text) is
  'El jefe ajusta a mano las horas de un turno (o agrega uno que no quedó en la app) con una observación (0120). No toca shifts.';

revoke all on function public.adjust_shift_hours(uuid, uuid, date, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.adjust_shift_hours(uuid, uuid, date, timestamptz, timestamptz, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Anular un ajuste
-- -----------------------------------------------------------------------------
create or replace function public.void_shift_hour_adjustment(p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_row  public.shift_hour_adjustments%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'NOT_ADMIN: solo un jefe puede anular un ajuste';
  end if;
  if char_length(v_note) < 5 then
    raise exception 'NOTA: escribe por qué lo anulas';
  end if;
  select * into v_row from public.shift_hour_adjustments where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: ese ajuste no existe'; end if;
  if v_row.organization_id <> public.current_user_org() then raise exception 'WRONG_ORG'; end if;
  if v_row.voided_at is not null then
    return jsonb_build_object('ok', true, 'id', p_id, 'noop', true);
  end if;

  update public.shift_hour_adjustments
     set voided_at = now(), voided_by = v_uid, void_note = v_note
   where id = p_id;

  perform public.log_audit_event(
    'shift_hours_adjustment_voided', 'shift_hour_adjustment', p_id,
    jsonb_build_object('note', v_note, 'by', v_uid, 'shift_id', v_row.shift_id, 'driver_id', v_row.driver_id));

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$fn$;

comment on function public.void_shift_hour_adjustment(uuid, text) is
  'El jefe anula un ajuste de horas con su motivo (0120). La fila queda, marcada como anulada.';

revoke all on function public.void_shift_hour_adjustment(uuid, text) from public, anon;
grant execute on function public.void_shift_hour_adjustment(uuid, text) to authenticated;

commit;
