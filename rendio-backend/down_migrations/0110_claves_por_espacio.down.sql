-- Revierte 0110: el aviso de «Olvidé mi contraseña» vuelve al texto de 0104
-- («Restablécela desde Usuarios», enlace #/usuarios). OJO: la app desde SW v175
-- ya no tiene la sección Usuarios; core.js manda #/usuarios a Tripulantes.

BEGIN;

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

COMMIT;
