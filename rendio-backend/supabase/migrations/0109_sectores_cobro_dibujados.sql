-- =============================================================================
-- 0109 · Sectores de cobro dibujados en el mapa
-- =============================================================================
-- Pedido del 13-oct-2026: «según la zona es un valor diferente de pago». La
-- profa pasó 17 zonas con su mensualidad (Somer, UCO, Porvenir, Fontibón,
-- Colegios, Alto Bonito, Campo Santander INTER, Barro Blanco, Cuatro Esquinas,
-- Marinilla Sector 1 y 2, Vía Marinilla, San Antonio, Carmen de Viboral,
-- Llanogrande Sector 1, 2 y 3). Decisiones suyas:
--   · los sectores de cobro los define el admin y NO son las zonas de tiempos de
--     Julián (route_zones, 0108): «el admin parametriza los sectores, con eso no
--     hay margen de equivocación»;
--   · cada sector lleva mensualidad y valor por viaje (vacaciones), editables.
--
-- 0094 ya cobra por sector (billing_sector_rates + billing_rate_of), pero el
-- sector salía del rótulo del conjunto (residences.sector: Norte, Sur, Sur-oeste,
-- Oriente, Llanogrande, Rosal), que no son estas zonas. Aquí cada sector de cobro
-- puede llevar su DIBUJO, y el sector de un tripulante sale, en este orden:
--   1. el puesto a mano en su cuenta (auxiliar_billing.sector) — gana siempre;
--   2. el dibujo que contiene su conjunto (o su casa, si vive fuera del
--      catálogo) — si lo contiene UNO solo; dos encimados no se desempatan;
--   3. el rótulo de su conjunto, como antes de 0109.
-- El 2 sale por el mismo campo que el 3 (billing_rate_of.res_sector, «el de su
-- residencia»): la cuenta del tripulante, el balance y la pantalla de tarifas
-- no cambian de forma, solo de dónde sale ese nombre.
--
-- QUÉ NO CAMBIA: el valor propio sigue ganando sobre la tarifa del sector; las
-- cuentas de cobro ya abiertas no se tocan (rige desde el próximo corte, como
-- toda tarifa); las vacaciones guardan el sector con que se marcaron. Al
-- aplicarla no cambia el cobro de nadie: en dev y en producción no hay ni una
-- tarifa cargada (13-oct) y ningún sector tiene dibujo todavía.
--
-- Idempotente.

BEGIN;

-- ── 1. El dibujo ─────────────────────────────────────────────────────────────
ALTER TABLE public.billing_sector_rates ADD COLUMN IF NOT EXISTS polygon jsonb;
ALTER TABLE public.billing_sector_rates DROP CONSTRAINT IF EXISTS billing_sector_rates_polygon_ok;
ALTER TABLE public.billing_sector_rates ADD CONSTRAINT billing_sector_rates_polygon_ok
  CHECK (polygon IS NULL OR (jsonb_typeof(polygon) = 'array' AND jsonb_array_length(polygon) >= 3));
COMMENT ON COLUMN public.billing_sector_rates.polygon IS
  'Sectores de cobro (0109): [[lat, lng], …] con 3 puntos o más. Quien vive dentro (conjunto o casa) paga este sector, salvo sector a mano. NULL = sin dibujo.';

-- ¿El punto cae dentro del dibujo [[lat, lng], …]? Rayo hacia el este: el MISMO
-- cálculo de zonaContienePunto (zonas-dibujo.js), para que la base y la pantalla
-- digan siempre lo mismo. NO se usa el tipo polygon de Postgres: sus
-- comparaciones tienen una tolerancia fija de 1e-6 y, con coordenadas en grados,
-- los productos entre puntos cercanos quedan por debajo de eso — probado: metía
-- adentro a Guayacán, que está 13 m afuera del borde de Barro Blanco.
CREATE OR REPLACE FUNCTION public.zona_contiene(p jsonb, p_lat double precision, p_lng double precision)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) < 3
                   OR p_lat IS NULL OR p_lng IS NULL THEN false
    ELSE (
      SELECT coalesce(sum(
               -- CASE anidado y no AND: así la división solo corre cuando el lado
               -- cruza la latitud del punto (y entonces yj <> yi).
               CASE WHEN (s.yi > p_lat) <> (s.yj > p_lat)
                    THEN CASE WHEN p_lng < (s.xj - s.xi) * (p_lat - s.yi) / (s.yj - s.yi) + s.xi THEN 1 ELSE 0 END
                    ELSE 0 END) % 2 = 1, false)
        FROM (SELECT (t.e->>0)::float8 AS yi, (t.e->>1)::float8 AS xi,
                     (p->((t.i::int - 2 + m.n) % m.n)->>0)::float8 AS yj,
                     (p->((t.i::int - 2 + m.n) % m.n)->>1)::float8 AS xj
                FROM jsonb_array_elements(p) WITH ORDINALITY AS t(e, i),
                     (SELECT jsonb_array_length(p) AS n) m) s)
  END
$$;

-- El sector de cobro DIBUJADO que contiene el punto: su nombre si es uno solo;
-- NULL si ninguno o si dos dibujos se enciman ahí (que decida una persona).
-- La misma regla que zonas-dibujo.js en la app.
CREATE OR REPLACE FUNCTION public.billing_sector_at(p_org uuid, p_lat double precision, p_lng double precision)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(btrim(sr.sector)) END
    FROM public.billing_sector_rates sr
   WHERE sr.organization_id = p_org AND sr.polygon IS NOT NULL
     AND p_lat IS NOT NULL AND p_lng IS NOT NULL
     AND public.zona_contiene(sr.polygon, p_lat, p_lng)
$$;

-- ── 2. El sector del tripulante (misma firma que 0094) ──────────────────────
-- res_sector = «el de su residencia» = el dibujo que contiene donde vive; si no
-- cae en ninguno, el rótulo de su conjunto. Todo lo demás, igual que 0094.
CREATE OR REPLACE FUNCTION public.billing_rate_of(p_aux uuid,
  OUT sector_name text,        -- el que manda (a mano o de donde vive)
  OUT sector_origin text,      -- 'manual' | 'residence' | NULL (sin sector)
  OUT manual_sector text,
  OUT res_name text,
  OUT res_sector text,         -- 0109: el dibujo que lo contiene → el rótulo del conjunto
  OUT sector_monthly integer,  -- mensualidad del sector (NULL = sin cargar)
  OUT sector_per_trip integer, -- valor por viaje del sector (NULL = sin cargar)
  OUT own_amount integer,      -- valor propio de la cuenta (auxiliar_billing.amount_cop)
  OUT monthly integer,         -- la efectiva: propio → sector (NULL = sin valor)
  OUT monthly_origin text)     -- 'own' | 'sector' | NULL
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_org uuid; v_lat double precision; v_lng double precision; v_label text;
BEGIN
  SELECT pr.organization_id, nullif(btrim(ab.sector), ''), r.name, nullif(btrim(r.sector), ''), ab.amount_cop,
         CASE WHEN r.id IS NOT NULL THEN r.latitude  ELSE ap.home_latitude  END,
         CASE WHEN r.id IS NOT NULL THEN r.longitude ELSE ap.home_longitude END
    INTO v_org, manual_sector, res_name, v_label, own_amount, v_lat, v_lng
    FROM public.auxiliar_profiles ap
    JOIN public.profiles pr ON pr.id = ap.profile_id
    LEFT JOIN public.auxiliar_billing ab ON ab.auxiliar_profile_id = ap.id
    LEFT JOIN public.residences r ON r.id = ap.residence_id
   WHERE ap.id = p_aux;
  res_sector := coalesce(public.billing_sector_at(v_org, v_lat, v_lng), v_label);
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

COMMENT ON FUNCTION public.billing_rate_of(uuid) IS
  'Tarifas (0094, 0109): sector del tripulante (a mano → el dibujo que contiene donde vive → el rótulo de su conjunto), tarifa de su sector y mensualidad efectiva (propia → sector; sin ninguna, sin valor).';

-- ── 3. Guardar la tarifa: borrar los dos valores ya no borra un sector dibujado
-- Igual que 0094, salvo que si el sector tiene dibujo la fila se queda (sin
-- valores): borrar la tarifa no puede llevarse el dibujo.
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
    UPDATE public.billing_sector_rates sr SET monthly_cop = NULL, per_trip_cop = NULL, updated_by = auth.uid()
     WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_clean) AND sr.polygon IS NOT NULL;
    IF FOUND THEN
      RETURN jsonb_build_object('sector', v_clean, 'monthlyCOP', NULL::integer, 'perTripCOP', NULL::integer, 'deleted', false);
    END IF;
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

-- ── 4. «Tarifas por sector»: + el dibujo, y los conjuntos según el dibujo ────
-- Igual que 0094, con dos cambios:
--   · cada sector trae su dibujo (polygon);
--   · el sector de cada conjunto es el del dibujo que lo contiene (o su rótulo
--     si no cae en ninguno). Así un rótulo viejo («Norte») deja de salir en la
--     lista en cuanto sus conjuntos quedan dentro de sectores dibujados, y
--     «N conjuntos» cuenta los que de verdad caen en cada sector.
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
  ), res AS (
    SELECT coalesce(public.billing_sector_at(v_org, r.latitude, r.longitude), nullif(btrim(r.sector), '')) AS sec
      FROM public.residences r
     WHERE r.organization_id = v_org
  ), names AS (
    SELECT res.sec AS nm, 'residence'::text AS kind FROM res WHERE res.sec IS NOT NULL
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
           'polygon',        sr.polygon,
           'updatedAt',      sr.updated_at,
           'fromResidences', ky.in_res,
           'residences',     (SELECT count(*) FROM res WHERE lower(res.sec) = ky.k),
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

-- ── 5. Dibujar, renombrar y quitar un sector ─────────────────────────────────
-- Dibujar crea el sector si no existe (todavía sin valores). p_polygon NULL
-- borra el dibujo; si además no tiene valores, el sector se va.
CREATE OR REPLACE FUNCTION public.admin_billing_sector_shape(p_sector text, p_polygon jsonb)
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
  IF p_polygon IS NOT NULL AND (jsonb_typeof(p_polygon) <> 'array' OR jsonb_array_length(p_polygon) < 3) THEN
    RAISE EXCEPTION 'El dibujo necesita al menos 3 puntos' USING ERRCODE = '22023';
  END IF;
  IF p_polygon IS NULL THEN
    UPDATE public.billing_sector_rates sr SET polygon = NULL, updated_by = auth.uid()
     WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_clean);
    DELETE FROM public.billing_sector_rates sr
     WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_clean)
       AND sr.monthly_cop IS NULL AND sr.per_trip_cop IS NULL;
    RETURN jsonb_build_object('sector', v_clean, 'polygon', NULL);
  END IF;
  SELECT btrim(r.sector) INTO v_canon FROM public.residences r
   WHERE r.organization_id = v_org AND lower(btrim(r.sector)) = lower(v_clean) LIMIT 1;
  INSERT INTO public.billing_sector_rates (organization_id, sector, polygon, updated_by)
  VALUES (v_org, coalesce(v_canon, v_clean), p_polygon, auth.uid())
  ON CONFLICT (organization_id, (lower(btrim(sector))))
  DO UPDATE SET polygon = EXCLUDED.polygon, updated_by = EXCLUDED.updated_by
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'sector', v_row.sector, 'polygon', v_row.polygon);
END;
$$;

-- Renombrar: la tarifa, el dibujo y los tripulantes que lo tienen a mano se van
-- con el nombre nuevo. Lo ya cobrado (vacaciones marcadas) conserva el nombre
-- con que se cobró.
CREATE OR REPLACE FUNCTION public.admin_billing_sector_rename(p_old text, p_new text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org  uuid := public.current_user_org();
  v_old  text := nullif(btrim(coalesce(p_old, '')), '');
  v_new  text := nullif(btrim(coalesce(p_new, '')), '');
  v_n    integer;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  IF v_old IS NULL OR v_new IS NULL THEN RAISE EXCEPTION 'Falta el nombre del sector' USING ERRCODE = '22023'; END IF;
  IF length(v_new) > 80 THEN RAISE EXCEPTION 'El nombre del sector es muy largo (máximo 80)' USING ERRCODE = '22023'; END IF;
  IF lower(v_old) <> lower(v_new) AND EXISTS (SELECT 1 FROM public.billing_sector_rates sr
       WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_new)) THEN
    RAISE EXCEPTION 'Ya hay un sector con ese nombre' USING ERRCODE = '23505';
  END IF;
  UPDATE public.billing_sector_rates sr SET sector = v_new, updated_by = auth.uid()
   WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_old);
  IF NOT FOUND THEN RAISE EXCEPTION 'Ese sector no tiene tarifa ni dibujo' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.auxiliar_billing ab SET sector = v_new, updated_by = auth.uid()
   WHERE ab.organization_id = v_org AND lower(btrim(ab.sector)) = lower(v_old);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('sector', v_new, 'manualMoved', v_n);
END;
$$;

-- Quitar: se van la tarifa y el dibujo. Quien lo tenía a mano vuelve a «el de
-- donde vive» (sin sector a mano). Rige desde el próximo corte, como toda
-- tarifa: las cuentas de cobro ya abiertas no cambian.
CREATE OR REPLACE FUNCTION public.admin_billing_sector_delete(p_sector text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   uuid := public.current_user_org();
  v_clean text := nullif(btrim(coalesce(p_sector, '')), '');
  v_n     integer;
BEGIN
  PERFORM public.billing_assert_admin_of(v_org);
  IF v_clean IS NULL THEN RAISE EXCEPTION 'Falta el nombre del sector' USING ERRCODE = '22023'; END IF;
  DELETE FROM public.billing_sector_rates sr
   WHERE sr.organization_id = v_org AND lower(btrim(sr.sector)) = lower(v_clean);
  UPDATE public.auxiliar_billing ab SET sector = NULL, updated_by = auth.uid()
   WHERE ab.organization_id = v_org AND lower(btrim(ab.sector)) = lower(v_clean);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('sector', v_clean, 'manualCleared', v_n);
END;
$$;

-- ── 6. Permisos (el patrón de 0094) ──────────────────────────────────────────
DO $do$
DECLARE f text;
BEGIN
  -- Internas: solo las llaman las funciones de arriba.
  FOREACH f IN ARRAY ARRAY[
    'public.zona_contiene(jsonb, double precision, double precision)',
    'public.billing_sector_at(uuid, double precision, double precision)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- De la app (cada una valida que quien llama es admin de la organización).
  FOREACH f IN ARRAY ARRAY[
    'public.admin_billing_sector_shape(text, jsonb)',
    'public.admin_billing_sector_rename(text, text)',
    'public.admin_billing_sector_delete(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$do$;

COMMIT;
