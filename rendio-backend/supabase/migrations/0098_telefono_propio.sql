-- 0098 — Cada quien guarda su celular (set_my_phone)
--
-- POR QUÉ: en producción solo 3 de 19 conductores tienen celular en
-- profiles.phone, y el botón «Llamar al conductor» del tripulante marca a nada.
-- El alta de conductores nunca lo pidió y nadie podía corregirlo desde la app
-- sin pasar por el jefe.
--
-- QUÉ HACE:
--   set_my_phone(p_phone) — cualquier usuario con sesión (conductor, tripulante,
--   jefe) guarda SU PROPIO celular. Nada más: no recibe a quién, siempre es
--   auth.uid(). Valida celular colombiano (10 dígitos que empiezan por 3) y lo
--   guarda normalizado: acepta espacios, guiones, puntos, paréntesis y el
--   indicativo (+57, o 57 pegado a los 10 dígitos). Deja rastro en audit_events
--   (mismo patrón que 0081: actor = quien llama) solo si el número cambió.
--
-- POR QUÉ NO BASTABA 0081: 0081 ya deja al usuario cambiar su teléfono por la
-- API (guard_profile_update lo tiene en «libres»), pero sin validar nada: se
-- podía guardar «123» o un fijo, y el tripulante seguiría sin poder llamar.
-- admin_update_profile (0081) sí valida, pero es solo del jefe y acepta
-- cualquier número de 7 a 15 dígitos. Esta función es la puerta del usuario,
-- con la regla de un celular de Colombia. El update directo de 0081 se deja
-- quieto (la foto pasa por ahí, y quitarlo es otro cambio con otras pruebas).
--
-- Corre como su dueño (SECURITY DEFINER): guard_profile_update (0081) deja pasar
-- a quien no es 'authenticated', y aquí la única columna que se toca es phone.
--
-- DOWN: down_migrations/0098_telefono_propio.down.sql (solo borra la función;
-- los celulares guardados se quedan).

begin;

create or replace function public.set_my_phone(p_phone text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_raw text := btrim(coalesce(p_phone, ''));
  v_num text;
  v_old text;
begin
  if v_uid is null then
    raise exception 'Sin sesión' using errcode = '42501';
  end if;
  if v_raw = '' then
    raise exception 'Escribe tu celular' using errcode = '22023';
  end if;
  -- Solo dígitos, el + del indicativo y separadores de escritura.
  if v_raw ~ '[^0-9+[:space:]().-]' then
    raise exception 'El celular solo lleva números' using errcode = '22023';
  end if;
  v_num := regexp_replace(v_raw, '[[:space:]().-]', '', 'g');
  if v_num like '+57%' then
    v_num := substr(v_num, 4);
  elsif v_num ~ '^57[0-9]{10}$' then
    v_num := substr(v_num, 3);
  end if;
  if v_num !~ '^3[0-9]{9}$' then
    raise exception 'El celular debe tener 10 dígitos y empezar por 3' using errcode = '22023';
  end if;

  select phone into v_old
    from public.profiles
   where id = v_uid and deleted_at is null
   for update;
  if not found then
    raise exception 'Tu cuenta no tiene perfil' using errcode = '42501';
  end if;

  if v_old is distinct from v_num then
    update public.profiles set phone = v_num where id = v_uid;
    insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
    values (v_uid, 'phone_changed', 'profile', v_uid, jsonb_build_object('from', v_old, 'to', v_num));
  end if;

  return v_num;
end;
$$;

revoke all on function public.set_my_phone(text) from public, anon;
grant execute on function public.set_my_phone(text) to authenticated;

comment on function public.set_my_phone(text) is
  'El usuario con sesión guarda SU celular (profiles.phone): celular colombiano de 10 dígitos que empieza por 3, normalizado (sin +57 ni separadores). Bitácora phone_changed en audit_events. 0098.';

commit;
