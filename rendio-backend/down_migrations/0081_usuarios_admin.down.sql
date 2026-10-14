-- DOWN de 0081 — Usuarios.
-- Quita las funciones, los triggers y las columnas. OJO: no devuelve el acceso
-- a los eliminados (el bloqueo en auth.users se queda: restaurarlos es cosa de
-- una decisión, no de un revert) y se pierden los motivos de suspensión y las
-- marcas de contraseña temporal.
begin;
drop trigger if exists tr_shifts_guard_suspended_start on public.shifts;
drop trigger if exists tr_shifts_guard_suspended on public.shifts;
drop function if exists public.guard_suspended_shift();
drop trigger if exists tr_reservations_guard_suspended on public.reservations;
drop function if exists public.guard_suspended_reservation();
drop function if exists public.change_my_password(text, text);
drop function if exists public.admin_set_role(uuid, text);
drop function if exists public.admin_set_status(uuid, text, text);
drop function if exists public.admin_set_password(uuid, text, boolean);
drop function if exists public.admin_set_email(uuid, text);
drop function if exists public.admin_update_profile(uuid, jsonb);
drop function if exists public._password_ok(text);
drop function if exists public._revoke_sessions(uuid);
drop function if exists public._admin_target(uuid);
drop trigger if exists tr_profiles_guard on public.profiles;
drop function if exists public.guard_profile_update();
-- current_user_role() vuelve a la versión de 0010 (sin mirar activo/eliminado).
create or replace function public.current_user_role()
returns text language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare claim_role text; fallback_role text;
begin
  claim_role := nullif((auth.jwt() ->> 'role'), '');
  if claim_role is not null and claim_role in ('admin', 'driver', 'auxiliar') then return claim_role; end if;
  if auth.uid() is null then return null; end if;
  select role::text into fallback_role from public.profiles where id = auth.uid();
  return fallback_role;
end;
$$;
drop policy if exists p_profiles_delete_admin on public.profiles;
create policy p_profiles_delete_admin on public.profiles for delete to authenticated
  using (public.current_user_role() = 'admin' and organization_id = public.current_user_org());
alter table public.profiles
  drop column if exists suspended_at,
  drop column if exists suspended_reason,
  drop column if exists must_change_password;
commit;
