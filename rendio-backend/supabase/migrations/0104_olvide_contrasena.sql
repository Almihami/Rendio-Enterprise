-- 0104 — «Olvidé mi contraseña»: un pedido a Coordinación (12-oct-2026)
--
-- POR QUÉ: el login solo tenía «¿Problemas para entrar?» con un texto que decía
-- «escríbele a tu coordinador». Restablecer ya existe del lado del jefe
-- (admin_set_password, 0081: pone una temporal y la app obliga a cambiarla al
-- entrar), pero el jefe se enteraba solo si la persona tenía a quién escribirle.
-- No hay correo: el plan gratuito de Supabase no manda correos de verdad, así
-- que el enlace mágico de «recuperar contraseña» no es opción. La dueña eligió
-- que el pedido le llegue a Coordinación y que ellos manden la temporal por
-- WhatsApp o llamada.
--
-- QUÉ HACE:
--   1. password_reset_requests — los pedidos (pendiente / hecho / descartado).
--      Solo los jefes de la organización los ven y los cambian, y de la fila
--      solo pueden tocar el estado: quién lo resolvió y cuándo lo sella la base.
--   2. request_password_reset(p_contact) — la llama el login SIN sesión (anon).
--      Recibe un correo o un celular, busca la cuenta (correo de acceso, el del
--      perfil, o profiles.phone) y, si existe y no hay un pedido pendiente suyo
--      de los últimos 30 minutos, guarda el pedido y les avisa a los jefes por
--      la bandeja de salida (notification_outbox, 0063/0066) con los mismos
--      destinatarios de siempre (ops_alert_recipients, de su organización).
--      SIEMPRE devuelve lo mismo, exista o no la cuenta: el login no puede
--      servir para averiguar qué correos o celulares están registrados.
--      Tope: 5 pedidos al día por contacto y 5 por persona (correo y celular
--      son dos contactos de la misma cuenta).
--   3. Cuando un jefe restablece la contraseña de alguien por cualquier camino
--      (Usuarios, Personal o Tripulantes), sus pedidos pendientes quedan hechos:
--      admin_set_password ya deja 'password_reset' en audit_events (0081) y un
--      trigger sobre esa bitácora los cierra. Así el aviso no se queda
--      molestando en Usuarios cuando ya se resolvió desde otra pantalla.
--
-- LO QUE NO HACE: no cambia ninguna contraseña ni manda nada a la persona. La
-- temporal la pone el jefe con admin_set_password, como siempre.
--
-- DOWN: down_migrations/0104_olvide_contrasena.down.sql.

begin;

-- ---------------------------------------------------------------------------
-- 1 · Los pedidos
-- ---------------------------------------------------------------------------
create table if not exists public.password_reset_requests (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  profile_id      uuid        references public.profiles(id) on delete set null,
  contact         text        not null,
  status          text        not null default 'pending',
  resolved_at     timestamptz,
  resolved_by     uuid        references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint password_reset_requests_status_chk check (status in ('pending', 'done', 'dismissed')),
  constraint password_reset_requests_contact_not_blank check (length(btrim(contact)) > 0)
);

comment on table public.password_reset_requests is
  'Pedidos de «Olvidé mi contraseña» desde el login (0104). Los resuelve un jefe con admin_set_password.';
comment on column public.password_reset_requests.contact is
  'Lo que escribió la persona, normalizado: correo en minúsculas o celular de 10 dígitos.';
comment on column public.password_reset_requests.organization_id is
  'La organización de la cuenta encontrada: solo sus jefes ven el pedido.';

create index if not exists idx_password_reset_requests_pending
  on public.password_reset_requests (organization_id, created_at desc) where status = 'pending';
create index if not exists idx_password_reset_requests_contact
  on public.password_reset_requests (contact, created_at);
create index if not exists idx_password_reset_requests_profile
  on public.password_reset_requests (profile_id, created_at);

drop trigger if exists tr_password_reset_requests_set_updated_at on public.password_reset_requests;
create trigger tr_password_reset_requests_set_updated_at
  before update on public.password_reset_requests
  for each row execute function public.set_updated_at();

-- Quién lo resolvió y cuándo lo pone la base, no el cliente: al salir de
-- 'pending' se sella con quien llama; al volver a 'pending' se limpia.
create or replace function public.password_reset_requests_stamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'pending' then
      new.resolved_at := null;
      new.resolved_by := null;
    else
      new.resolved_at := now();
      new.resolved_by := coalesce(auth.uid(), new.resolved_by);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tr_password_reset_requests_stamp on public.password_reset_requests;
create trigger tr_password_reset_requests_stamp
  before update on public.password_reset_requests
  for each row execute function public.password_reset_requests_stamp();

-- RLS: los jefes de la organización leen y cambian el ESTADO (permiso de
-- columna). Nadie inserta desde el cliente: entra solo por la función de abajo.
alter table public.password_reset_requests enable row level security;

revoke all on public.password_reset_requests from public, anon, authenticated;
grant select on public.password_reset_requests to authenticated;
grant update (status) on public.password_reset_requests to authenticated;

drop policy if exists p_password_reset_requests_select_admin on public.password_reset_requests;
create policy p_password_reset_requests_select_admin on public.password_reset_requests
  for select to authenticated
  using (public.current_user_role() = 'admin' and organization_id = public.current_user_org());

drop policy if exists p_password_reset_requests_update_admin on public.password_reset_requests;
create policy p_password_reset_requests_update_admin on public.password_reset_requests
  for update to authenticated
  using (public.current_user_role() = 'admin' and organization_id = public.current_user_org())
  with check (public.current_user_role() = 'admin' and organization_id = public.current_user_org());

-- ---------------------------------------------------------------------------
-- 2 · El pedido desde el login (sin sesión)
--
--   Correo: se compara en minúsculas contra el de la cuenta de acceso
--   (auth.users) y el del perfil. Celular: la misma regla de set_my_phone
--   (0098) — 10 dígitos que empiezan por 3, con o sin +57 — contra los últimos
--   10 dígitos de profiles.phone. Si un celular está en dos cuentas (pasa: hay
--   quien tiene dos), gana la activa y, entre iguales, la más nueva: el jefe ve
--   el nombre y el contacto y decide.
--   Las cuentas eliminadas no cuentan: restablecerles la clave no las deja
--   entrar (para eso se restauran).
-- ---------------------------------------------------------------------------
create or replace function public.request_password_reset(p_contact text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_neutral constant jsonb := jsonb_build_object('ok', true);
  v_raw   text := btrim(coalesce(p_contact, ''));
  v_norm  text;
  v_prof  public.profiles;
  v_id    uuid;
  v_first text;
begin
  if v_raw = '' or length(v_raw) > 254 then
    return v_neutral;
  end if;

  if position('@' in v_raw) > 0 then
    v_norm := lower(v_raw);
    if v_norm !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      return v_neutral;
    end if;
    select p.* into v_prof
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.deleted_at is null
       and (lower(u.email) = v_norm or lower(p.email) = v_norm)
     order by (lower(u.email) = v_norm) desc nulls last, (p.is_active is not false) desc, p.created_at desc
     limit 1;
  else
    if v_raw ~ '[^0-9+[:space:]().-]' then
      return v_neutral;
    end if;
    v_norm := regexp_replace(v_raw, '[^0-9]', '', 'g');
    if length(v_norm) = 12 and left(v_norm, 2) = '57' then
      v_norm := substr(v_norm, 3);
    end if;
    if v_norm !~ '^3[0-9]{9}$' then
      return v_neutral;
    end if;
    select p.* into v_prof
      from public.profiles p
     where p.deleted_at is null
       and right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_norm
     order by (p.is_active is not false) desc, p.created_at desc
     limit 1;
  end if;

  if v_prof.id is null then
    return v_neutral;
  end if;

  -- Dos toques seguidos (o dos teléfonos a la vez) no hacen dos pedidos.
  perform pg_advisory_xact_lock(hashtextextended('pwreset:' || v_prof.id::text, 0));

  if exists (select 1 from public.password_reset_requests
              where profile_id = v_prof.id and status = 'pending'
                and created_at > now() - interval '30 minutes') then
    return v_neutral;
  end if;
  if (select count(*) from public.password_reset_requests
       where contact = v_norm and created_at > now() - interval '1 day') >= 5
     or (select count(*) from public.password_reset_requests
          where profile_id = v_prof.id and created_at > now() - interval '1 day') >= 5 then
    return v_neutral;
  end if;

  insert into public.password_reset_requests (organization_id, profile_id, contact)
  values (v_prof.organization_id, v_prof.id, v_norm)
  returning id into v_id;

  -- El aviso a los jefes de SU organización. Un jefe que olvidó la suya no se
  -- avisa a sí mismo.
  v_first := nullif(split_part(btrim(coalesce(v_prof.full_name, '')), ' ', 1), '');
  insert into public.notification_outbox (profile_id, title, body, url, dedupe_key)
  select r.profile_id,
         'Pidieron restablecer una contraseña',
         coalesce(v_first, 'Alguien') || ' no puede entrar. Restablécela desde Usuarios.',
         '/#/usuarios',
         'pwreset:' || v_id::text || ':' || r.profile_id::text
    from public.ops_alert_recipients() r
    join public.profiles a on a.id = r.profile_id
   where a.organization_id = v_prof.organization_id
     and r.profile_id <> v_prof.id
  on conflict do nothing;

  return v_neutral;
end;
$$;

comment on function public.request_password_reset(text) is
  '«Olvidé mi contraseña» desde el login (0104): guarda el pedido y avisa a los jefes. Siempre devuelve {ok:true}.';

revoke all on function public.request_password_reset(text) from public;
grant execute on function public.request_password_reset(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3 · Restablecer por cualquier camino cierra los pedidos pendientes
-- ---------------------------------------------------------------------------
create or replace function public.resolve_password_reset_on_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.password_reset_requests
     set status = 'done', resolved_by = new.actor_profile_id
   where profile_id = new.entity_id and status = 'pending';
  return null;
end;
$$;

revoke all on function public.resolve_password_reset_on_audit() from public, anon, authenticated;

drop trigger if exists tr_audit_events_resolve_password_reset on public.audit_events;
create trigger tr_audit_events_resolve_password_reset
  after insert on public.audit_events
  for each row
  when (new.event_type = 'password_reset' and new.entity_type = 'profile')
  execute function public.resolve_password_reset_on_audit();

commit;
