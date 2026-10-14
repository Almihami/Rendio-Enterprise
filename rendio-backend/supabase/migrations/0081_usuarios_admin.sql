-- 0081 — Usuarios: el jefe edita, restablece contraseñas, suspende y elimina
--
-- QUÉ HAY HOY:
--   Las cuentas solo se crean. Nadie edita datos ni cambia contraseñas desde la
--   app (solo con scripts locales), "Suspender" y "Eliminar" solo los frena la
--   pantalla, y un eliminado sigue entrando.
--
-- QUÉ HACE ESTA MIGRACIÓN:
--   1. Columnas nuevas en profiles: contraseña temporal y motivo de suspensión.
--   2. Qué puede cambiar cada quien de su propio perfil. El usuario: teléfono y
--      foto. El jefe: lo demás, menos rol, correo y organización, que van por
--      las funciones de abajo (tocan también la cuenta de acceso y dejan
--      bitácora). Nadie se suspende ni se elimina a sí mismo.
--   3. Funciones del jefe: editar datos, cambiar correo, poner contraseña,
--      suspender / eliminar / restaurar y cambiar rol. Todas dejan rastro en
--      audit_events con el actor = quien llama.
--   4. Funciones del usuario: cambiar su contraseña (pide la actual).
--   5. La suspensión se cumple en la base: un suspendido no pide traslados
--      nuevos ni arranca turno. Los traslados ya pedidos se respetan (C8).
--   6. Un jefe eliminado o inactivo deja de ser jefe AL INSTANTE (no cuando le
--      venza el token), y nunca pueden quedar 0 jefes activos (U5).
--
-- LOS DOS NIVELES (decisión U3, 27-sep-2026):
--   Suspendido = is_active false. Entra, ve el motivo, no opera.
--   Eliminado  = deleted_at. No entra: la cuenta de acceso queda bloqueada y se
--                cierran sus sesiones. Se puede restaurar.
--   A un jefe no se le suspende: se le elimina. A un tripulante no se le
--   elimina: se le suspende (U4).
--
-- COMPATIBLE CON EL FRONT VIEJO: lo que hoy hace producción (el jefe cambia
-- is_active, deleted_at, prioridad, líder, alertas; el usuario cambia su foto)
-- sigue pasando. Se puede aplicar antes de desplegar el código nuevo.
--
-- ORDEN: correr primero en Rendio-dev, verificar, y después en Rendio-Main.

begin;

-- ---------------------------------------------------------------------------
-- 1 · Columnas
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists must_change_password boolean not null default false,
  add column if not exists suspended_reason     text,
  add column if not exists suspended_at         timestamptz;

comment on column public.profiles.must_change_password is
  'La contraseña la puso el jefe (temporal): al entrar se le pide cambiarla. 0081.';
comment on column public.profiles.suspended_reason is
  'Motivo que ve la persona suspendida o eliminada. Lo escribe el jefe. 0081.';

-- ---------------------------------------------------------------------------
-- 2 · Qué columnas del perfil puede tocar cada quien por la API
--
--   Solo se vigila a quien llega con su propia sesión (authenticated). Los
--   scripts con service_role y las funciones SECURITY DEFINER de abajo (que
--   corren como su dueño) validan por su cuenta.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  libres constant text[] := array['phone', 'avatar_url', 'updated_at'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if public.current_user_role() = 'admin' then
    if new.id is distinct from old.id
       or new.organization_id is distinct from old.organization_id
       or new.role is distinct from old.role
       or new.email is distinct from old.email
       or new.must_change_password is distinct from old.must_change_password then
      raise exception 'El rol, el correo y la contraseña se cambian desde Personal'
        using errcode = '42501';
    end if;
    if old.id = auth.uid()
       and (new.is_active is distinct from old.is_active
            or new.deleted_at is distinct from old.deleted_at) then
      raise exception 'No puedes suspenderte ni eliminarte a ti mismo'
        using errcode = '42501';
    end if;
    -- El estado de OTRO jefe solo por admin_set_status: ahí se cuida que no
    -- queden 0 jefes, se bloquea la cuenta y queda en la bitácora.
    if old.role = 'admin'
       and (new.is_active is distinct from old.is_active
            or new.deleted_at is distinct from old.deleted_at) then
      raise exception 'El estado de un administrador se cambia desde Personal'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - libres) is distinct from (to_jsonb(old) - libres) then
    raise exception 'Solo puedes cambiar tu teléfono y tu foto'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_profiles_guard on public.profiles;
create trigger tr_profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ---------------------------------------------------------------------------
-- 2b · El rol que ven las políticas (misma función de 0010, con un cambio):
--      un eliminado no tiene rol, y un jefe inactivo tampoco. Así eliminar a un
--      jefe le quita el poder de inmediato, no cuando le venza el token (hasta
--      una hora). Un conductor o tripulante SUSPENDIDO conserva su rol: entra y
--      ve sus cosas; lo que no puede hacer lo frenan los triggers del paso 5.
-- ---------------------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  claim_role    text;
  fallback_role text;
begin
  claim_role := nullif((auth.jwt() ->> 'role'), '');
  if claim_role is not null and claim_role in ('admin', 'driver', 'auxiliar') then
    return claim_role;
  end if;

  if auth.uid() is null then
    return null;
  end if;

  select role::text into fallback_role
    from public.profiles
   where id = auth.uid()
     and deleted_at is null
     and not (role = 'admin' and is_active is false);

  return fallback_role;
end;
$$;

-- Ningún jefe borra filas de perfiles: se eliminan con admin_set_status
-- (borrado blando). El borrado duro arrastraba en cascada y saltaba todas las
-- reglas de arriba. La app nunca lo usó.
drop policy if exists p_profiles_delete_admin on public.profiles;

-- ---------------------------------------------------------------------------
-- 3 · Funciones del jefe
-- ---------------------------------------------------------------------------

-- Valida que quien llama sea jefe activo y que el usuario sea de su misma
-- organización. Devuelve la fila del usuario. Solo la usan las de abajo.
create or replace function public._admin_target(p_target uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me public.profiles;
  t  public.profiles;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or me.role <> 'admin' or me.is_active is false or me.deleted_at is not null then
    raise exception 'Solo un administrador activo puede hacer esto' using errcode = '42501';
  end if;
  select * into t from public.profiles where id = p_target;
  if t.id is null or t.organization_id is distinct from me.organization_id then
    raise exception 'Usuario no encontrado' using errcode = 'P0002';
  end if;
  return t;
end;
$$;
revoke all on function public._admin_target(uuid) from public, anon, authenticated;

-- Cierra todas las sesiones abiertas de un usuario (U11). El token que ya
-- tiene en la mano vence solo, en menos de una hora; lo que se corta es la
-- renovación.
create or replace function public._revoke_sessions(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from auth.refresh_tokens where user_id = p_user::text;
  delete from auth.sessions where user_id = p_user;
end;
$$;
revoke all on function public._revoke_sessions(uuid) from public, anon, authenticated;

-- Una sola regla de contraseña para todos (U7).
create or replace function public._password_ok(p text)
returns boolean
language sql
immutable
as $$
  select coalesce(length(p) >= 10 and p ~ '[A-Za-zÁÉÍÓÚÑáéíóúñ]' and p ~ '[0-9]', false);
$$;

-- 3a · Editar datos (U1, U4). p_data trae SOLO las llaves que se cambian.
--   profiles:           full_name, phone, document_id, home_base
--   driver_profiles:    license_number, license_expires_at, eps_provider,
--                       eps_expires_at, arl_provider, arl_expires_at
--   auxiliar_profiles:  airline_id
create or replace function public.admin_update_profile(p_id uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t       public.profiles;
  v_name  text;
  v_phone text;
  k       text;
  permitidas constant text[] := array[
    'full_name', 'phone', 'document_id', 'home_base',
    'license_number', 'license_expires_at', 'eps_provider', 'eps_expires_at',
    'arl_provider', 'arl_expires_at', 'airline_id'];
begin
  t := public._admin_target(p_id);
  p_data := coalesce(p_data, '{}'::jsonb);

  for k in select jsonb_object_keys(p_data) loop
    if not (k = any (permitidas)) then
      raise exception 'Campo no editable: %', k;
    end if;
  end loop;

  if p_data ? 'full_name' then
    v_name := regexp_replace(trim(coalesce(p_data->>'full_name', '')), '\s+', ' ', 'g');
    if length(v_name) < 3 then
      raise exception 'Escribe el nombre completo';
    end if;
  end if;
  if p_data ? 'phone' then
    v_phone := nullif(regexp_replace(coalesce(p_data->>'phone', ''), '[\s().-]', '', 'g'), '');
    if v_phone is not null and v_phone !~ '^\+?\d{7,15}$' then
      raise exception 'El teléfono no parece válido';
    end if;
  end if;

  update public.profiles set
    full_name   = case when p_data ? 'full_name'   then v_name else full_name end,
    phone       = case when p_data ? 'phone'       then v_phone else phone end,
    document_id = case when p_data ? 'document_id' then nullif(trim(p_data->>'document_id'), '') else document_id end,
    home_base   = case when p_data ? 'home_base'   then nullif(trim(p_data->>'home_base'), '') else home_base end
  where id = p_id;

  if t.role = 'driver' and (p_data ?| array['license_number', 'license_expires_at', 'eps_provider',
                                            'eps_expires_at', 'arl_provider', 'arl_expires_at']) then
    insert into public.driver_profiles (profile_id) values (p_id)
      on conflict (profile_id) do nothing;
    update public.driver_profiles set
      license_number     = case when p_data ? 'license_number'     then nullif(trim(p_data->>'license_number'), '') else license_number end,
      license_expires_at = case when p_data ? 'license_expires_at' then nullif(p_data->>'license_expires_at', '')::date else license_expires_at end,
      eps_provider       = case when p_data ? 'eps_provider'       then nullif(trim(p_data->>'eps_provider'), '') else eps_provider end,
      eps_expires_at     = case when p_data ? 'eps_expires_at'     then nullif(p_data->>'eps_expires_at', '')::date else eps_expires_at end,
      arl_provider       = case when p_data ? 'arl_provider'       then nullif(trim(p_data->>'arl_provider'), '') else arl_provider end,
      arl_expires_at     = case when p_data ? 'arl_expires_at'     then nullif(p_data->>'arl_expires_at', '')::date else arl_expires_at end
    where profile_id = p_id;
  end if;

  if t.role = 'auxiliar' and p_data ? 'airline_id' then
    update public.auxiliar_profiles
       set airline_id = nullif(p_data->>'airline_id', '')::uuid
     where profile_id = p_id;
  end if;

  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'profile_edited', 'profile', p_id, p_data);
end;
$$;
revoke all on function public.admin_update_profile(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_profile(uuid, jsonb) to authenticated;

-- 3b · Cambiar el correo, que es el usuario con el que se entra (U9). Sin
--      confirmación de la persona; queda en la bitácora. Si el correo lo tiene
--      una cuenta ELIMINADA, esa se aparca (como hace rename-turnos-emails.mjs)
--      para liberarlo. Si lo tiene una cuenta viva, no se toca nada.
create or replace function public.admin_set_email(p_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t        public.profiles;
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_owner  uuid;
  v_ownerp public.profiles;
  v_parked text;
begin
  t := public._admin_target(p_id);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'El correo no parece válido';
  end if;
  if v_email = lower(t.email) then
    return;
  end if;

  select id into v_owner from auth.users where lower(email) = v_email and id <> p_id limit 1;
  if v_owner is not null then
    select * into v_ownerp from public.profiles where id = v_owner;
    -- De otra organización (o sin perfil): no se dice de quién es ni se toca.
    if v_ownerp.id is null or v_ownerp.organization_id is distinct from t.organization_id then
      raise exception 'Ese correo ya está en uso por otra cuenta' using errcode = '23505';
    end if;
    if v_ownerp.deleted_at is null then
      raise exception 'Ese correo ya lo usa %', coalesce(v_ownerp.full_name, 'otra cuenta')
        using errcode = '23505';
    end if;
    v_parked := 'eliminado.' || split_part(v_owner::text, '-', 1) || '@rendio.invalid';
    update auth.users set email = v_parked, updated_at = now() where id = v_owner;
    update auth.identities
       set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_parked)), updated_at = now()
     where user_id = v_owner and provider = 'email';
    update public.profiles set email = v_parked where id = v_owner;
    insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
    values (auth.uid(), 'email_parked', 'profile', v_owner,
            jsonb_build_object('from', v_email, 'to', v_parked, 'freed_for', p_id));
  end if;

  update auth.users set email = v_email, updated_at = now() where id = p_id;
  update auth.identities
     set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_email)), updated_at = now()
   where user_id = p_id and provider = 'email';
  update public.profiles set email = v_email where id = p_id;

  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'email_changed', 'profile', p_id, jsonb_build_object('from', t.email, 'to', v_email));
end;
$$;
revoke all on function public.admin_set_email(uuid, text) from public, anon;
grant execute on function public.admin_set_email(uuid, text) to authenticated;

-- 3c · Poner una contraseña (U2). La temporal la genera la pantalla y se la
--      muestra al jefe una sola vez; aquí no se guarda en ningún otro lado.
--      p_force_change: al entrar se le pide cambiarla. Cierra sus sesiones.
create or replace function public.admin_set_password(p_id uuid, p_password text, p_force_change boolean default true)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  t public.profiles;
begin
  t := public._admin_target(p_id);
  if p_id = auth.uid() then
    raise exception 'Para tu propia contraseña usa «Cambiar mi contraseña»';
  end if;
  if not public._password_ok(p_password) then
    raise exception 'La contraseña debe tener al menos 10 caracteres, con letras y números';
  end if;

  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf', 10)), updated_at = now()
   where id = p_id;
  if not found then
    raise exception 'Esta persona no tiene cuenta de acceso';
  end if;
  update public.profiles set must_change_password = coalesce(p_force_change, true) where id = p_id;
  perform public._revoke_sessions(p_id);

  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'password_reset', 'profile', p_id,
          jsonb_build_object('temporal', coalesce(p_force_change, true)));
end;
$$;
revoke all on function public.admin_set_password(uuid, text, boolean) from public, anon;
grant execute on function public.admin_set_password(uuid, text, boolean) to authenticated;

-- 3d · Suspender, eliminar o reactivar/restaurar (U3, U4, U5, U10, U11).
--      p_status: 'active' | 'suspended' | 'deleted'
create or replace function public.admin_set_status(p_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t        public.profiles;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_admins int;
begin
  t := public._admin_target(p_id);
  if p_id = auth.uid() then
    raise exception 'No puedes cambiar tu propio estado';
  end if;
  if p_status not in ('active', 'suspended', 'deleted') then
    raise exception 'Estado desconocido: %', p_status;
  end if;
  if t.role = 'admin' and p_status = 'suspended' then
    raise exception 'A un administrador no se le suspende: se le elimina (no entra) y se puede restaurar';
  end if;
  if t.role = 'auxiliar' and p_status = 'deleted' then
    raise exception 'A un tripulante no se le elimina: se le suspende';
  end if;

  if t.role = 'admin' and p_status = 'deleted' then
    -- Candado sobre los jefes de la organización: si dos jefes se eliminan el
    -- uno al otro en el mismo instante, el segundo espera y cuenta bien.
    perform 1 from public.profiles
     where organization_id = t.organization_id and role = 'admin' for update;
    select count(*) into v_admins from public.profiles
     where organization_id = t.organization_id and role = 'admin'
       and is_active is not false and deleted_at is null and id <> p_id;
    if v_admins = 0 then
      raise exception 'Tiene que quedar al menos un administrador activo';
    end if;
  end if;

  if p_status = 'active' then
    if t.deleted_at is not null and exists (
         select 1 from public.profiles
          where organization_id = t.organization_id and deleted_at is null
            and lower(email) = lower(t.email) and id <> p_id) then
      raise exception 'Su correo ya lo usa otra cuenta activa: cámbiale el correo antes de restaurarla';
    end if;
    update public.profiles
       set is_active = true, deleted_at = null, suspended_reason = null, suspended_at = null
     where id = p_id;
    update auth.users set banned_until = null, updated_at = now() where id = p_id;

  elsif p_status = 'suspended' then
    update public.profiles
       set is_active = false, deleted_at = null, suspended_reason = v_reason, suspended_at = now()
     where id = p_id;
    update auth.users set banned_until = null, updated_at = now() where id = p_id;

  else -- deleted
    update public.profiles
       set is_active = false, deleted_at = now(), suspended_reason = v_reason,
           suspended_at = coalesce(suspended_at, now())
     where id = p_id;
    -- 100 años y no 'infinity': el servidor de autenticación no sabe leer infinity.
    update auth.users set banned_until = now() + interval '100 years', updated_at = now() where id = p_id;
    perform public._revoke_sessions(p_id);
  end if;

  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'status_' || p_status, 'profile', p_id,
          jsonb_build_object('from', case when t.deleted_at is not null then 'deleted'
                                          when t.is_active is false then 'suspended'
                                          else 'active' end,
                             'reason', v_reason));
end;
$$;
revoke all on function public.admin_set_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_status(uuid, text, text) to authenticated;

-- 3e · Cambiar rol entre conductor y administrador (U5, U6). Un tripulante no
--      cambia de rol. Cierra sus sesiones para que entre con el rol nuevo.
create or replace function public.admin_set_role(p_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t        public.profiles;
  v_admins int;
begin
  t := public._admin_target(p_id);
  if p_id = auth.uid() then
    raise exception 'No puedes cambiar tu propio rol';
  end if;
  if p_role not in ('admin', 'driver') or t.role = 'auxiliar' then
    raise exception 'Solo se cambia entre conductor y administrador';
  end if;
  if t.role::text = p_role then
    return;
  end if;
  if t.is_active is false or t.deleted_at is not null then
    raise exception 'Reactívalo antes de cambiarle el rol';
  end if;
  if t.role = 'admin' then
    -- Candado sobre los jefes de la organización: si dos jefes se eliminan el
    -- uno al otro en el mismo instante, el segundo espera y cuenta bien.
    perform 1 from public.profiles
     where organization_id = t.organization_id and role = 'admin' for update;
    select count(*) into v_admins from public.profiles
     where organization_id = t.organization_id and role = 'admin'
       and is_active is not false and deleted_at is null and id <> p_id;
    if v_admins = 0 then
      raise exception 'Tiene que quedar al menos un administrador activo';
    end if;
  end if;

  update public.profiles set role = p_role::public.user_role where id = p_id;
  if p_role = 'driver' then
    insert into public.driver_profiles (profile_id) values (p_id)
      on conflict (profile_id) do nothing;
  end if;
  perform public._revoke_sessions(p_id);

  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'role_changed', 'profile', p_id, jsonb_build_object('from', t.role, 'to', p_role));
end;
$$;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4 · El usuario cambia su propia contraseña (U8: pide la actual)
-- ---------------------------------------------------------------------------
create or replace function public.change_my_password(p_current text, p_new text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión' using errcode = '42501';
  end if;
  select encrypted_password into v_hash from auth.users where id = auth.uid();
  if v_hash is null or crypt(coalesce(p_current, ''), v_hash) <> v_hash then
    raise exception 'La contraseña actual no coincide' using errcode = '28P01';
  end if;
  if not public._password_ok(p_new) then
    raise exception 'La contraseña nueva debe tener al menos 10 caracteres, con letras y números';
  end if;
  if p_new = p_current then
    raise exception 'La contraseña nueva tiene que ser distinta de la actual';
  end if;
  update auth.users
     set encrypted_password = crypt(p_new, gen_salt('bf', 10)), updated_at = now()
   where id = auth.uid();
  update public.profiles set must_change_password = false where id = auth.uid();
  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'password_changed', 'profile', auth.uid(), null);
end;
$$;
revoke all on function public.change_my_password(text, text) from public, anon;
grant execute on function public.change_my_password(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5 · La suspensión se cumple en la base (C8)
--     Solo frena a la propia persona. El jefe sí puede crearle un traslado.
-- ---------------------------------------------------------------------------
create or replace function public.guard_suspended_reservation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
      from public.auxiliar_profiles ap
      join public.profiles p on p.id = ap.profile_id
     where ap.id = new.auxiliar_profile_id
       and p.id = auth.uid()
       and (p.is_active is false or p.deleted_at is not null)
  ) then
    raise exception 'Tu cuenta está suspendida: no puedes pedir traslados nuevos. Habla con tu jefe.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_reservations_guard_suspended on public.reservations;
create trigger tr_reservations_guard_suspended
  before insert on public.reservations
  for each row execute function public.guard_suspended_reservation();

create or replace function public.guard_suspended_shift()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
      from public.driver_profiles dp
      join public.profiles p on p.id = dp.profile_id
     where dp.id = new.driver_id
       and p.id = auth.uid()
       and (p.is_active is false or p.deleted_at is not null)
  ) then
    raise exception 'Tu cuenta está suspendida: no puedes iniciar turno. Habla con tu jefe.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_shifts_guard_suspended on public.shifts;
create trigger tr_shifts_guard_suspended
  before insert on public.shifts
  for each row execute function public.guard_suspended_shift();

-- Y si ya tenía el carro reservado (borrador) cuando lo suspendieron, tampoco
-- lo arranca: se frena el paso a 'active'.
drop trigger if exists tr_shifts_guard_suspended_start on public.shifts;
create trigger tr_shifts_guard_suspended_start
  before update of status on public.shifts
  for each row
  when (new.status = 'active' and old.status is distinct from 'active')
  execute function public.guard_suspended_shift();

-- ---------------------------------------------------------------------------
-- 6 · Los eliminados de antes quedan como los de ahora: sin acceso.
--     (Hasta hoy "Eliminar" solo los sacaba de las listas; seguían entrando.)
-- ---------------------------------------------------------------------------
update auth.users u
   set banned_until = now() + interval '100 years', updated_at = now()
  from public.profiles p
 where p.id = u.id and p.deleted_at is not null
   and (u.banned_until is null or u.banned_until < now());

delete from auth.refresh_tokens rt
 using public.profiles p
 where p.deleted_at is not null and rt.user_id = p.id::text;
delete from auth.sessions s
 using public.profiles p
 where p.deleted_at is not null and s.user_id = p.id;

commit;
