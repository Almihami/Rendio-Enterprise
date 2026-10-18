-- =============================================================================
-- 0114 · El jefe cambia el conjunto, el apartamento y la segunda unidad
-- =============================================================================
-- Pedido de la profa (18-oct-2026): «los admin también deberían poder hacerlo».
--
-- Hasta aquí el punto de recogida del tripulante solo lo cambiaba él mismo
-- (Perfil › Mi residencia, y solo el conjunto). El apartamento y la segunda
-- unidad no los cambiaba nadie desde la app: la app le decía «escríbele a
-- Coordinación», y Coordinación no tenía dónde. «Editar datos» del tripulante
-- (Tripulantes › Gestionar) traía nombre, correo, teléfono y aerolínea.
--
-- admin_update_profile (0081) acepta ahora cuatro llaves más, solo para un
-- tripulante:
--   residence_id      el conjunto. Vacío = sin conjunto, y eso solo se acepta
--                     si tiene dirección propia con pin (la misma regla de
--                     auxiliar_profiles_pickup_known, dicha antes de que
--                     reviente la constraint, para contestar algo legible).
--   residence_unit    apartamento / torre del conjunto.
--   residence_id_2    la segunda unidad. Vacío = no tiene, y se lleva su
--                     apartamento (una segunda unidad sin conjunto no es una
--                     segunda unidad, como en register_auxiliar de 0076).
--   residence_unit_2  apartamento de la segunda unidad.
--
-- El conjunto tiene que ser de la misma organización. Puede estar desactivado:
-- la pantalla solo ofrece los activos, pero conserva el que ya tenía, y guardar
-- otra cosa del formulario no debe obligar a moverlo.
--
-- LO QUE NO CAMBIA: los traslados que ya pidió. Es lo mismo que pasa cuando el
-- tripulante cambia su residencia (saveMyResidence): la reserva copió su punto
-- al nacer. Lo que sí sigue al conjunto es mover su pin (0112).
--
-- Queda en la bitácora como cualquier otra edición (profile_edited, con lo que
-- se mandó).
-- =============================================================================

BEGIN;

create or replace function public.admin_update_profile(p_id uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t       public.profiles;
  ap      public.auxiliar_profiles;
  v_name  text;
  v_phone text;
  v_res   uuid;
  v_res2  uuid;
  k       text;
  permitidas constant text[] := array[
    'full_name', 'phone', 'document_id', 'home_base',
    'license_number', 'license_expires_at', 'eps_provider', 'eps_expires_at',
    'arl_provider', 'arl_expires_at', 'airline_id',
    'residence_id', 'residence_unit', 'residence_id_2', 'residence_unit_2'];
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

  -- El punto de recogida se valida antes de escribir nada: si algo no cuadra,
  -- no queda guardada la mitad del formulario.
  if t.role = 'auxiliar' and (p_data ?| array['residence_id', 'residence_unit', 'residence_id_2', 'residence_unit_2']) then
    select * into ap from public.auxiliar_profiles where profile_id = p_id;
    if ap.id is null then
      raise exception 'Este tripulante no tiene ficha de recogida';
    end if;

    v_res  := case when p_data ? 'residence_id'   then nullif(p_data->>'residence_id', '')::uuid   else ap.residence_id end;
    v_res2 := case when p_data ? 'residence_id_2' then nullif(p_data->>'residence_id_2', '')::uuid else ap.residence_id_2 end;

    if v_res is not null and v_res is distinct from ap.residence_id and not exists (
      select 1 from public.residences r where r.id = v_res and r.organization_id = t.organization_id
    ) then
      raise exception 'Ese conjunto no está en el catálogo';
    end if;
    if v_res2 is not null and v_res2 is distinct from ap.residence_id_2 and not exists (
      select 1 from public.residences r where r.id = v_res2 and r.organization_id = t.organization_id
    ) then
      raise exception 'El conjunto de la segunda unidad no está en el catálogo';
    end if;
    if v_res is null and (ap.home_latitude is null or ap.home_longitude is null) then
      raise exception 'Elige un conjunto: no tiene una dirección propia donde recogerlo';
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

  if t.role = 'auxiliar' and (p_data ?| array['residence_id', 'residence_unit', 'residence_id_2', 'residence_unit_2']) then
    update public.auxiliar_profiles set
      residence_id     = v_res,
      residence_unit   = case when p_data ? 'residence_unit' then nullif(btrim(p_data->>'residence_unit'), '') else residence_unit end,
      residence_id_2   = v_res2,
      residence_unit_2 = case
                           when v_res2 is null then null
                           when p_data ? 'residence_unit_2' then nullif(btrim(p_data->>'residence_unit_2'), '')
                           else residence_unit_2
                         end
     where profile_id = p_id;
  end if;

  insert into public.audit_events (actor_profile_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'profile_edited', 'profile', p_id, p_data);
end;
$$;
revoke all on function public.admin_update_profile(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_profile(uuid, jsonb) to authenticated;

COMMIT;
