-- =============================================================================
-- 0149 · Los apodos del jefe se aprenden aunque la ruta pegada vaya al tablero
--        (27-oct-2026)
-- =============================================================================
-- La profa (26-oct, noche): «lo único que debería cambiar es cuando alguien
-- suba». La ruta que pega el jefe ya no se publica por su lado
-- (admin_manual_route_publish, 0125): cada bloque entra al tablero como una
-- vuelta más y se publica con «Publicar», como siempre (admin-ruta-julian.js +
-- RendioRutasV2.meterPegado). Lo único que hacía esa función y el tablero no,
-- era aprender cómo escribe el jefe a cada tripulante («Karol L» → su cuenta):
-- crew_aliases solo se escribía desde ahí.
--
-- QUÉ HACE
--   admin_crew_aliases_save(apodos): el mismo INSERT … ON CONFLICT de 0125/0143,
--   solo para jefes de la organización y solo con tripulantes de ella.
-- No toca ninguna función existente. Idempotente.
-- Down: down_migrations/0149_apodos_al_pegar.down.sql.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_crew_aliases_save(p_aliases jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
  n     integer;
BEGIN
  IF v_org IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe guarda apodos' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.crew_aliases (organization_id, alias_norm, auxiliar_profile_id, created_by)
  SELECT v_org, lower(btrim(a->>'alias')), (a->>'auxiliar_profile_id')::uuid, auth.uid()
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_aliases) = 'array' THEN p_aliases ELSE '[]'::jsonb END) a
    JOIN public.auxiliar_profiles ap ON ap.id::text = a->>'auxiliar_profile_id'
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = v_org
   WHERE length(btrim(coalesce(a->>'alias', ''))) > 0
  ON CONFLICT (organization_id, alias_norm) DO UPDATE SET auxiliar_profile_id = EXCLUDED.auxiliar_profile_id, updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_crew_aliases_save(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_crew_aliases_save(jsonb) TO authenticated;
COMMENT ON FUNCTION public.admin_crew_aliases_save(jsonb) IS
  '0149: guarda cómo escribe el jefe a un tripulante ([{alias, auxiliar_profile_id}]). Lo usa «Ruta de Julián» al pasar lo pegado al tablero.';

COMMIT;
