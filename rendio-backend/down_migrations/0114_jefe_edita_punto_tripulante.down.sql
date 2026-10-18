-- Reversa de 0114: admin_update_profile vuelve a la de 0081 (sin conjunto,
-- apartamento ni segunda unidad). Lo que el jefe ya cambió se queda como está.
BEGIN;
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
COMMIT;
