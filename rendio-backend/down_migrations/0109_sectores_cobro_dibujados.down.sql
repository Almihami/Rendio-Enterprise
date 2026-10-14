-- Revierte 0109: los sectores de cobro vuelven a salir solo del rótulo del
-- conjunto (o del puesto a mano), como en 0094. Pierde los dibujos de los
-- sectores; las tarifas (mensualidad y valor por viaje) se quedan. Las tres
-- funciones vuelven a su texto de 0094, copiado tal cual.
--
-- Ojo: un sector que solo tenía dibujo (sin valores) queda como fila sin
-- valores; el próximo «Guardar» vacío de 0094 lo borra.

BEGIN;

DROP FUNCTION IF EXISTS public.admin_billing_sector_shape(text, jsonb);
DROP FUNCTION IF EXISTS public.admin_billing_sector_rename(text, text);
DROP FUNCTION IF EXISTS public.admin_billing_sector_delete(text);

CREATE OR REPLACE FUNCTION public.billing_rate_of(p_aux uuid,
  OUT sector_name text,        -- el que manda (a mano o de la residencia)
  OUT sector_origin text,      -- 'manual' | 'residence' | NULL (sin sector)
  OUT manual_sector text,
  OUT res_name text,
  OUT res_sector text,
  OUT sector_monthly integer,  -- mensualidad del sector (NULL = sin cargar)
  OUT sector_per_trip integer, -- valor por viaje del sector (NULL = sin cargar)
  OUT own_amount integer,      -- valor propio de la cuenta (auxiliar_billing.amount_cop)
  OUT monthly integer,         -- la efectiva: propio → sector (NULL = sin valor)
  OUT monthly_origin text)     -- 'own' | 'sector' | NULL
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT pr.organization_id, nullif(btrim(ab.sector), ''), r.name, nullif(btrim(r.sector), ''), ab.amount_cop
    INTO v_org, manual_sector, res_name, res_sector, own_amount
    FROM public.auxiliar_profiles ap
    JOIN public.profiles pr ON pr.id = ap.profile_id
    LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
    LEFT JOIN public.residences r ON r.id = ap.residence_id
   WHERE ap.id = p_aux;
  sector_name := coalesce(manual_sector, res_sector);
  sector_origin := CASE WHEN manual_sector IS NOT NULL THEN 'manual' WHEN res_sector IS NOT NULL THEN 'residence' END;
  IF sector_name IS NOT NULL THEN
    SELECT sr.monthly_cop, sr.per_trip_cop INTO sector_monthly, sector_per_trip
      FROM public.billing_sector_rates sr
     WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(sector_name);
  END IF;
  monthly := coalesce(own_amount, sector_monthly);
  monthly_origin := CASE WHEN own_amount IS NOT NULL THEN 'own'
                         WHEN sector_monthly IS NOT NULL THEN 'sector' END;
END;
$$;


CREATE OR REPLACE FUNCTION public.admin_billing_save_sector_rate(p_sector text, p_monthly_cop integer DEFAULT NULL,
                                                                 p_per_trip_cop integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_clean text := nullif(btrim(coalesce(p_sector, '')), '');
  v_canon text;
  v_row   public.billing_sector_rates;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  IF v_clean IS NULL THEN RAISE EXCEPTION 'Falta el nombre del sector' USING ERRCODE = '22023'; END IF;
  IF length(v_clean) > 80 THEN RAISE EXCEPTION 'El nombre del sector es muy largo (máximo 80)' USING ERRCODE = '22023'; END IF;
  IF (p_monthly_cop IS NOT NULL AND (p_monthly_cop <= 0 OR p_monthly_cop > 10000000))
     OR (p_per_trip_cop IS NOT NULL AND (p_per_trip_cop <= 0 OR p_per_trip_cop > 10000000)) THEN
    RAISE EXCEPTION 'Los valores van de $1 a $10.000.000' USING ERRCODE = '22023';
  END IF;
  IF p_monthly_cop IS NULL AND p_per_trip_cop IS NULL THEN
    DELETE FROM public.billing_sector_rates sr
     WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_clean);
    RETURN jsonb_build_object('sector', v_clean, 'monthlyCOP', NULL::integer, 'perTripCOP', NULL::integer, 'deleted', true);
  END IF;
  -- Con la escritura del sector de las residencias, si existe.
  SELECT btrim(r.sector) INTO v_canon FROM public.residences r
   WHERE r.organization_id = v_org AND lower(btrim(r.sector)) = lower(v_clean) LIMIT 1;
  INSERT INTO public.billing_sector_rates (organization_id, sector, monthly_cop, per_trip_cop, updated_by)
  VALUES (v_org, coalesce(v_canon, v_clean), p_monthly_cop, p_per_trip_cop, auth.uid())
  ON CONFLICT (organization_id, (lower(btrim(sector))))
  DO UPDATE SET monthly_cop = EXCLUDED.monthly_cop, per_trip_cop = EXCLUDED.per_trip_cop,
                updated_by = EXCLUDED.updated_by
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'sector', v_row.sector, 'monthlyCOP', v_row.monthly_cop,
                            'perTripCOP', v_row.per_trip_cop, 'updatedAt', v_row.updated_at, 'deleted', false);
END;
$$;


CREATE OR REPLACE FUNCTION public.admin_billing_sector_rates()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_list  jsonb;
  v_none  integer;
  v_total integer;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  WITH crew AS (
    SELECT ap.id AS aux_id, rt.sector_name AS sec, rt.sector_origin AS origin,
           (ab.amount_cop IS NOT NULL OR ab.amount_next_cop IS NOT NULL) AS own
      FROM public.auxiliar_profiles ap
      JOIN public.profiles pr ON pr.id = ap.profile_id
      LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
      LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
     WHERE pr.organization_id = v_org AND pr.deleted_at IS NULL AND pr.role = 'auxiliar'
  ), names AS (
    SELECT btrim(r.sector) AS nm, 'residence'::text AS kind FROM public.residences r
     WHERE r.organization_id = v_org AND nullif(btrim(r.sector), '') IS NOT NULL
    UNION ALL
    SELECT btrim(sr.sector), 'rate'::text FROM public.billing_sector_rates sr WHERE sr.organization_id = v_org
    UNION ALL
    SELECT c.sec, 'manual'::text FROM crew c WHERE c.sec IS NOT NULL
  ), keys AS (
    SELECT lower(n.nm) AS k, min(n.nm) AS nm, bool_or(n.kind = 'residence') AS in_res
      FROM names n GROUP BY lower(n.nm)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'sector',         coalesce(btrim(sr.sector), ky.nm),
           'rateId',         sr.id,
           'monthlyCOP',     sr.monthly_cop,
           'perTripCOP',     sr.per_trip_cop,
           'updatedAt',      sr.updated_at,
           'fromResidences', ky.in_res,
           'residences',     (SELECT count(*) FROM public.residences r2
                               WHERE r2.organization_id = v_org AND lower(btrim(r2.sector)) = ky.k),
           'crew',           (SELECT count(*) FROM crew c WHERE lower(c.sec) = ky.k),
           'crewManual',     (SELECT count(*) FROM crew c WHERE lower(c.sec) = ky.k AND c.origin = 'manual'),
           'crewOwn',        (SELECT count(*) FROM crew c WHERE lower(c.sec) = ky.k AND c.own))
           ORDER BY lower(coalesce(btrim(sr.sector), ky.nm))), '[]'::jsonb)
    INTO v_list
    FROM keys ky
    LEFT JOIN public.billing_sector_rates sr ON sr.organization_id = v_org AND lower(btrim(sr.sector)) = ky.k;

  SELECT count(*) FILTER (WHERE rt.sector_name IS NULL), count(*)
    INTO v_none, v_total
    FROM public.auxiliar_profiles ap
    JOIN public.profiles pr ON pr.id = ap.profile_id
    LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true
   WHERE pr.organization_id = v_org AND pr.deleted_at IS NULL AND pr.role = 'auxiliar';

  RETURN jsonb_build_object('sectors', v_list, 'crewWithoutSector', v_none, 'crewTotal', v_total);
END;
$$;


DROP FUNCTION IF EXISTS public.billing_sector_at(uuid, double precision, double precision);
DROP FUNCTION IF EXISTS public.zona_contiene(jsonb, double precision, double precision);
DROP FUNCTION IF EXISTS public.zona_poligono(jsonb);   -- la de un primer borrador local
ALTER TABLE public.billing_sector_rates DROP CONSTRAINT IF EXISTS billing_sector_rates_polygon_ok;
ALTER TABLE public.billing_sector_rates DROP COLUMN IF EXISTS polygon;

COMMIT;
