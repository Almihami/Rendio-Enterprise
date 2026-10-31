-- 0156 — «Eliminar mi cuenta» desde la app (31-oct-2026)
--
-- POR QUÉ: Apple (regla 5.1.1(v)) y Google Play exigen que una app que deja
-- crear cuentas deje también ELIMINARLAS desde la misma app, sin tener que
-- escribirle a nadie. Los tripulantes crean su cuenta solos (aux-registro.js),
-- así que la app de las tiendas no pasa la revisión sin esto. Lo usa también la
-- web: el botón sale en el Perfil de todos.
--
-- QUÉ HACE delete_my_account(): lo mismo que «Eliminar» de un jefe en Personal
-- (admin_set_status 'deleted', 0081), pero sobre uno mismo:
--   · profiles: is_active false, deleted_at now(), motivo «La persona eliminó
--     su cuenta desde la app».
--   · auth.users bloqueado 100 años y sesiones cerradas: no vuelve a entrar.
--   · Sus dispositivos de avisos se borran (no le vuelve a sonar nada).
--   · Queda en audit_events (status_deleted, from = self).
--   · Avisa a los jefes de su organización (notification_outbox, como el
--     «olvidé mi contraseña» de 0104/0110): si tenía traslados o vueltas
--     pendientes, siguen en el tablero y alguien tiene que reacomodarlos.
-- Lo de la operación (traslados, turnos, cobros) se conserva: los jefes lo
-- necesitan para las cuentas y la ley contable obliga a guardar los pagos. Los
-- datos personales que sobran (teléfono, foto, dirección) los borra la empresa
-- dentro del plazo que diga la política de privacidad (rendio.co/privacidad).
--
-- CANDADO: el último jefe activo de una organización no puede eliminarse (se
-- quedaría la operación sin nadie), igual que en admin_set_status.
--
-- Restaurar: un jefe la restaura desde Personal / Tripulantes como cualquier
-- eliminada (admin_set_status 'active').
--
-- ORDEN: correr primero en Rendio-dev, verificar, y después en Rendio-Main.

begin;

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       public.profiles;
  v_admins int;
  v_first  text;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión' using errcode = '42501';
  end if;
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then
    raise exception 'No encontramos tu cuenta' using errcode = 'P0002';
  end if;

  -- Candados en el mismo orden que admin_set_status: primero los jefes de la
  -- organización (si es jefe), después la propia fila. Dos jefes que se
  -- eliminan a la vez no se traban: el segundo espera y cuenta bien.
  if me.role = 'admin' then
    perform 1 from public.profiles
     where organization_id = me.organization_id and role = 'admin'
     order by id for update;
  end if;
  select * into me from public.profiles where id = auth.uid() for update;
  if me.deleted_at is not null then
    return;   -- ya estaba eliminada: no es un error volver a pedirlo
  end if;

  if me.role = 'admin' then
    select count(*) into v_admins from public.profiles
     where organization_id = me.organization_id and role = 'admin'
       and is_active is not false and deleted_at is null and id <> me.id;
    if v_admins = 0 then
      raise exception 'Eres el único administrador activo: antes de eliminar tu cuenta, nombra a otro desde Personal'
        using errcode = 'P0001';
    end if;
  end if;

  update public.profiles
     set is_active = false, deleted_at = now(),
         suspended_reason = 'La persona eliminó su cuenta desde la app',
         suspended_at = coalesce(suspended_at, now())
   where id = me.id;

  delete from public.push_subscriptions where profile_id = me.id;

  -- 100 años y no 'infinity': el servidor de autenticación no sabe leer infinity (0081).
  update auth.users set banned_until = now() + interval '100 years', updated_at = now() where id = me.id;
  perform public._revoke_sessions(me.id);

  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (me.id, 'status_deleted', 'profile', me.id,
          jsonb_build_object('from', case when me.is_active is false then 'suspended' else 'active' end,
                             'reason', 'self', 'via', 'delete_my_account'));

  -- El aviso a los jefes de SU organización (los que reciben alertas).
  v_first := nullif(split_part(btrim(coalesce(me.full_name, '')), ' ', 1), '');
  insert into public.notification_outbox (profile_id, title, body, url, dedupe_key)
  select r.profile_id,
         'Alguien eliminó su cuenta',
         coalesce(v_first, 'Una persona') || ' eliminó su cuenta desde la app. Revisa si tenía '
           || case when me.role = 'auxiliar' then 'traslados pendientes' else 'vueltas o turnos pendientes' end
           || '. Se puede restaurar desde '
           || case when me.role = 'auxiliar' then 'Rutas › Tripulantes.' else 'Turnos › Personal.' end,
         case when me.role = 'auxiliar' then '/#/tripulantes' else '/#/workers' end,
         'cuenta-eliminada:' || me.id::text || ':' || r.profile_id::text
    from public.ops_alert_recipients() r
    join public.profiles a on a.id = r.profile_id
   where a.organization_id = me.organization_id
     and r.profile_id <> me.id
  on conflict do nothing;
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

commit;
