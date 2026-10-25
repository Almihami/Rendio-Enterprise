-- 0116 · Tiempos aprendidos de los viajes reales (24-oct-2026).
--
-- La tabla de tiempos de Julián (0062) la dictó él. Esta se llena SOLA con las
-- marcas de los conductores: cada «llegué», «a bordo» y «entregado» ya queda con
-- su hora en route_stops (0045). Aquí se convierten en TRAMOS MEDIDOS:
--
--   · espera            — de «llegué» a «a bordo» en la puerta (lo que tarda en bajar)
--   · puerta            — hora del plan vs. hora en que el carro llegó a la puerta
--   · casa_casa         — de una recogida (o entrega) a la siguiente
--   · casa_aeropuerto   — de la ÚLTIMA recogida al aeropuerto (su «tramo final»)
--   · vuelta_salida     — de la PRIMERA recogida al aeropuerto (su tabla de zona)
--   · aeropuerto_casa   — de salir del aeropuerto a la primera entrega (llegadas)
--   · vuelta_llegada    — de salir del aeropuerto a la última entrega
--
-- No es inteligencia artificial: es guardar lo que pasó y sacar cuentas (el valor
-- del medio y el de un mal día). Se puede explicar: «dice 31 porque los últimos
-- 12 viajes dieron eso».
--
-- MARCAS A DESTIEMPO. El dato sirve solo si el conductor marca en el momento. Si
-- marca todo junto al llegar al aeropuerto, o el teléfono estaba sin señal y la
-- marca salió después (la cola de driver-rutas.js la manda con la hora del
-- servidor), el tiempo sale falso. Por eso cada marca se compara con el GPS real
-- del carro en ese minuto: si estaba lejos del punto, el tramo queda «dudoso» y
-- NO entra en las cuentas (pero se ve, con el motivo). Lo mismo si dos marcas de
-- sitios distintos salen casi juntas (imposible manejando) o si un tramo dura
-- demasiado (se le olvidó marcar).
--
-- QUIÉN LA LLENA. collect_trip_legs() cada hora por pg_cron (y el botón «Medir
-- ahora» del jefe). Rehace las vueltas con marcas de los últimos 3 días. El GPS
-- se borra a los 7 días (0046), así que una vuelta ya medida no se vuelve a
-- medir pasados 6: se perdería la comprobación.
--
-- ESTO NO CAMBIA CÓMO SE PLANEA. El optimizador sigue con OSRM/TomTom + la tabla
-- de Julián. Esta tabla primero se compara (Calibración › Tiempos reales); se
-- conecta al optimizador cuando haya viajes suficientes para confiar en ella.

BEGIN;

-- ── 1. Geometría ────────────────────────────────────────────────────────────
-- Distancia en línea recta, en km.
CREATE OR REPLACE FUNCTION public.tramo_km(a_lat double precision, a_lng double precision,
                                           b_lat double precision, b_lng double precision)
RETURNS double precision
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN a_lat IS NULL OR a_lng IS NULL OR b_lat IS NULL OR b_lng IS NULL THEN NULL
    ELSE 6371 * acos(LEAST(1, GREATEST(-1,
           cos(radians(a_lat)) * cos(radians(b_lat)) * cos(radians(b_lng) - radians(a_lng))
         + sin(radians(a_lat)) * sin(radians(b_lat))))) END
$$;

-- ¿El punto cae dentro del dibujo? MISMA REGLA que zonaContienePunto en
-- zonas-dibujo.js (rayo hacia el este, lat/lng como plano). `p_poly` es
-- [[lat, lng], …]. Los IF van anidados para no dividir por cero en un lado
-- horizontal (SQL no garantiza el orden de un AND).
CREATE OR REPLACE FUNCTION public.zona_contiene_punto(p_poly jsonb, p_lat double precision, p_lng double precision)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  n int; i int; j int;
  yi double precision; xi double precision; yj double precision; xj double precision;
  dentro boolean := false;
BEGIN
  IF p_poly IS NULL OR jsonb_typeof(p_poly) <> 'array' OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN false;
  END IF;
  n := jsonb_array_length(p_poly);
  IF n < 3 THEN RETURN false; END IF;
  j := n - 1;
  FOR i IN 0 .. n - 1 LOOP
    yi := (p_poly -> i ->> 0)::double precision; xi := (p_poly -> i ->> 1)::double precision;
    yj := (p_poly -> j ->> 0)::double precision; xj := (p_poly -> j ->> 1)::double precision;
    IF (yi > p_lat) <> (yj > p_lat) THEN
      IF p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi THEN
        dentro := NOT dentro;
      END IF;
    END IF;
    j := i;
  END LOOP;
  RETURN dentro;
END;
$$;

-- LA ZONA CON LA QUE SE PROGRAMA, igual que zonaEfectiva (zonas-dibujo.js): la
-- puesta a mano gana; si no, el ÚNICO dibujo que contiene el punto; dos dibujos
-- encimados o ninguno → NULL (que decida una persona).
CREATE OR REPLACE FUNCTION public.zona_efectiva(p_manual text, p_lat double precision, p_lng double precision)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(NULLIF(btrim(p_manual), ''), (
    SELECT CASE WHEN count(*) = 1 THEN min(z.name) END
      FROM public.route_zones z
     WHERE z.polygon IS NOT NULL
       AND public.zona_contiene_punto(z.polygon, p_lat, p_lng)))
$$;

-- ── 2. Los tramos medidos ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.route_trip_legs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  route_assignment_id  uuid REFERENCES public.route_assignments(id) ON DELETE SET NULL,
  driver_profile_id    uuid REFERENCES public.driver_profiles(id) ON DELETE SET NULL,
  direction            public.trip_direction NOT NULL,
  kind                 text NOT NULL,
  -- Sin llave foránea a propósito: la medición es historia y sobrevive a la reserva.
  from_reservation_id  uuid,
  to_reservation_id    uuid,
  from_residence_id    uuid REFERENCES public.residences(id) ON DELETE SET NULL,
  to_residence_id      uuid REFERENCES public.residences(id) ON DELETE SET NULL,
  from_lat             double precision,
  from_lng             double precision,
  to_lat               double precision,
  to_lng               double precision,
  started_at           timestamptz NOT NULL,
  ended_at             timestamptz NOT NULL,
  minutes              numeric(7,1) NOT NULL,
  km                   numeric(7,2),
  pax                  smallint,
  planned_at           timestamptz,
  deadline_at          timestamptz,
  service_day          date NOT NULL,
  hour_local           smallint NOT NULL CHECK (hour_local BETWEEN 0 AND 23),
  ref_hour             smallint NOT NULL CHECK (ref_hour BETWEEN 0 AND 23),
  day_type             text NOT NULL,
  start_gps_m          integer,
  end_gps_m            integer,
  quality              text NOT NULL DEFAULT 'ok',
  quality_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_trip_legs_kind_valid CHECK (kind IN
    ('espera', 'puerta', 'casa_casa', 'casa_aeropuerto', 'vuelta_salida', 'aeropuerto_casa', 'vuelta_llegada')),
  CONSTRAINT route_trip_legs_day_type_valid CHECK (day_type IN ('normal', 'festivo')),
  CONSTRAINT route_trip_legs_quality_valid CHECK (quality IN ('ok', 'dudosa'))
);

COMMENT ON TABLE public.route_trip_legs IS
  '0116 · Tramos medidos de los viajes reales, armados por collect_trip_legs() con las marcas del conductor (route_stops.actual_*). Solo los «ok» entran en las cuentas.';
COMMENT ON COLUMN public.route_trip_legs.kind IS
  'espera (llegué→a bordo) · puerta (plan→llegada real; minutes = atraso, negativo = antes) · casa_casa · casa_aeropuerto (última recogida→aeropuerto) · vuelta_salida (primera recogida→aeropuerto) · aeropuerto_casa (salir del aeropuerto→primera entrega) · vuelta_llegada (salir del aeropuerto→última entrega).';
COMMENT ON COLUMN public.route_trip_legs.started_at IS
  'Marca con la que empieza el tramo. En «puerta» es la hora del PLAN (estimated_arrival_at).';
COMMENT ON COLUMN public.route_trip_legs.deadline_at IS
  'Salidas: la presentación más temprana de la vuelta (required_arrival_at). Margen real = deadline_at − ended_at.';
COMMENT ON COLUMN public.route_trip_legs.ref_hour IS
  'Hora (Bogotá) con la que se ubica en la franja de Julián: la presentación en salidas (como el optimizador), la salida del aeropuerto en llegadas.';
COMMENT ON COLUMN public.route_trip_legs.day_type IS
  'festivo = domingo o día de public.holidays (la fecha del tramo, en Bogotá). Su tabla es de día normal.';
COMMENT ON COLUMN public.route_trip_legs.start_gps_m IS
  'Metros entre el GPS real del carro y el punto, en el minuto de la marca (±2 min). NULL = no había GPS a esa hora: no se pudo comprobar.';

CREATE INDEX IF NOT EXISTS idx_route_trip_legs_org_kind_day ON public.route_trip_legs(organization_id, kind, service_day);
CREATE INDEX IF NOT EXISTS idx_route_trip_legs_route ON public.route_trip_legs(route_assignment_id);

DROP TRIGGER IF EXISTS tr_route_trip_legs_set_updated_at ON public.route_trip_legs;
CREATE TRIGGER tr_route_trip_legs_set_updated_at BEFORE UPDATE ON public.route_trip_legs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.route_trip_legs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_route_trip_legs_select_admin ON public.route_trip_legs;
CREATE POLICY p_route_trip_legs_select_admin ON public.route_trip_legs
  FOR SELECT USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());
-- Sin políticas de escritura: solo la escribe collect_trip_legs (SECURITY DEFINER).

-- Bitácora de cada medición: sirve para saber si el reloj está corriendo (en
-- producción ya pasó que unos pg_cron nuevos nunca arrancaron, ver 13-oct).
CREATE TABLE IF NOT EXISTS public.route_trip_legs_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at      timestamptz NOT NULL DEFAULT now(),
  routes      integer NOT NULL DEFAULT 0,
  legs        integer NOT NULL DEFAULT 0,
  dudosos     integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.route_trip_legs_runs IS
  '0116 · Una fila por cada vez que corrió collect_trip_legs (se guardan las últimas 500).';
DROP TRIGGER IF EXISTS tr_route_trip_legs_runs_set_updated_at ON public.route_trip_legs_runs;
CREATE TRIGGER tr_route_trip_legs_runs_set_updated_at BEFORE UPDATE ON public.route_trip_legs_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.route_trip_legs_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_route_trip_legs_runs_select_admin ON public.route_trip_legs_runs;
CREATE POLICY p_route_trip_legs_runs_select_admin ON public.route_trip_legs_runs
  FOR SELECT USING (public.current_user_role() = 'admin');

-- ── 3. Comprobar una marca contra el GPS ────────────────────────────────────
-- Metros entre el punto y el ping GPS REAL (no las anclas: esas las pone la
-- misma marca en el punto, compararlas consigo mismas no prueba nada) más
-- cercano en el tiempo, dentro de ±2 minutos. NULL = no había GPS.
CREATE OR REPLACE FUNCTION public.marca_gps_m(p_driver uuid, p_at timestamptz,
                                              p_lat double precision, p_lng double precision)
RETURNS integer
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT round(public.tramo_km(dl.latitude, dl.longitude, p_lat, p_lng) * 1000)::integer
    FROM public.driver_locations dl
   WHERE p_driver IS NOT NULL AND p_at IS NOT NULL AND p_lat IS NOT NULL
     AND dl.driver_profile_id = p_driver
     AND dl.source = 'gps'
     AND dl.recorded_at BETWEEN p_at - interval '2 minutes' AND p_at + interval '2 minutes'
   ORDER BY abs(extract(epoch FROM dl.recorded_at - p_at))
   LIMIT 1
$$;

-- «850 m» · «2,3 km»
CREATE OR REPLACE FUNCTION public.tramo_distancia_txt(p_m integer)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN p_m IS NULL THEN NULL
              WHEN p_m >= 1000 THEN replace(to_char(p_m / 1000.0, 'FM9990.0'), '.', ',') || ' km'
              ELSE p_m || ' m' END
$$;

-- ── 4. Guardar UN tramo (con su calidad) ────────────────────────────────────
-- Interna: solo la llama collect_trip_legs.
CREATE OR REPLACE FUNCTION public.trip_leg_add(
  p_org uuid, p_ra uuid, p_driver uuid, p_dir public.trip_direction, p_kind text,
  p_from_rid uuid, p_to_rid uuid, p_from_res uuid, p_to_res uuid,
  p_from_lat double precision, p_from_lng double precision,
  p_to_lat double precision, p_to_lng double precision,
  p_start timestamptz, p_end timestamptz,
  p_pax integer, p_planned timestamptz, p_deadline timestamptz, p_ref_hour integer,
  p_start_gps integer, p_end_gps integer, p_start_tol integer, p_end_tol integer, p_max_min integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_min     numeric := round((extract(epoch FROM p_end - p_start) / 60.0)::numeric, 1);
  v_km      double precision := public.tramo_km(p_from_lat, p_from_lng, p_to_lat, p_to_lng);
  v_local   timestamp := p_start AT TIME ZONE 'America/Bogota';
  v_day     date := (p_start AT TIME ZONE 'America/Bogota')::date;
  v_why     text[] := '{}';
  v_viaje   boolean := p_kind IN ('casa_casa', 'casa_aeropuerto', 'vuelta_salida', 'aeropuerto_casa', 'vuelta_llegada');
BEGIN
  IF p_start IS NULL OR p_end IS NULL THEN RETURN; END IF;

  IF p_kind <> 'puerta' AND v_min < 0 THEN
    v_why := v_why || 'las marcas quedaron al revés'::text;
  ELSIF p_kind = 'puerta' AND abs(v_min) > p_max_min THEN
    v_why := v_why || ('el plan y la llegada se separan ' || round(abs(v_min)) || ' min (¿otro día u otra vuelta?)');
  ELSIF p_kind <> 'puerta' AND v_min > p_max_min THEN
    v_why := v_why || ('duró ' || round(v_min) || ' min (¿se le olvidó marcar a tiempo?)');
  END IF;
  IF p_start_gps IS NOT NULL AND p_start_gps > p_start_tol THEN
    v_why := v_why || ('marcó a ' || public.tramo_distancia_txt(p_start_gps) || ' del punto de salida');
  END IF;
  IF p_end_gps IS NOT NULL AND p_end_gps > p_end_tol THEN
    v_why := v_why || ('marcó a ' || public.tramo_distancia_txt(p_end_gps) || ' del punto de llegada');
  END IF;
  -- Más de 110 km/h en línea recta entre dos puertas = las marcó casi juntas.
  IF v_viaje AND v_km IS NOT NULL AND v_km > 0.3 AND v_min >= 0
     AND v_km / greatest(v_min, 0.1) * 60 > 110 THEN
    v_why := v_why || 'marcas casi juntas: imposible manejando'::text;
  END IF;

  INSERT INTO public.route_trip_legs (
    organization_id, route_assignment_id, driver_profile_id, direction, kind,
    from_reservation_id, to_reservation_id, from_residence_id, to_residence_id,
    from_lat, from_lng, to_lat, to_lng, started_at, ended_at, minutes, km, pax,
    planned_at, deadline_at, service_day, hour_local, ref_hour, day_type,
    start_gps_m, end_gps_m, quality, quality_reason)
  VALUES (
    p_org, p_ra, p_driver, p_dir, p_kind,
    p_from_rid, p_to_rid, p_from_res, p_to_res,
    p_from_lat, p_from_lng, p_to_lat, p_to_lng, p_start, p_end, v_min,
    CASE WHEN v_km IS NULL THEN NULL ELSE round(v_km::numeric, 2) END, p_pax,
    p_planned, p_deadline, v_day, extract(hour FROM v_local)::smallint,
    COALESCE(p_ref_hour, extract(hour FROM v_local)::int)::smallint,
    CASE WHEN extract(dow FROM v_day) = 0 OR EXISTS (SELECT 1 FROM public.holidays h WHERE h.day = v_day)
         THEN 'festivo' ELSE 'normal' END,
    p_start_gps, p_end_gps,
    CASE WHEN cardinality(v_why) > 0 THEN 'dudosa' ELSE 'ok' END,
    NULLIF(array_to_string(v_why, ' · '), ''));
END;
$$;

-- ── 5. La medición ──────────────────────────────────────────────────────────
-- Rehace los tramos de las vueltas con alguna marca desde p_desde. Idempotente:
-- borra los tramos de esas vueltas y los vuelve a armar (así un «deshacer» del
-- conductor también se refleja). Devuelve cuántas vueltas y tramos midió.
--
-- Tolerancias: 500 m en una puerta (el pin es la portería y el carro puede
-- esperar en otra entrada), 1,5 km en el aeropuerto (es grande).
CREATE OR REPLACE FUNCTION public.collect_trip_legs(p_desde timestamptz DEFAULT now() - interval '3 days')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_casa   constant integer := 500;
  c_aero   constant integer := 1500;
  v_routes uuid[];
  v_ra     uuid;
  v_dir    public.trip_direction;
  v_drv    uuid;
  v_org    uuid;
  a_lat    double precision;
  a_lng    double precision;
  v_apt_at timestamptz;
  v_dl     timestamptz;
  v_pax    integer;
  v_ref    integer;
  v_dep    timestamptz;
  g_in     integer;
  g_out    integer;
  g_apt    integer;
  s        record;
  f        record;
  -- la puerta anterior
  p_rid    uuid;
  p_res    uuid;
  p_lat    double precision;
  p_lng    double precision;
  p_out    timestamptz;
  p_gout   integer;
  v_first  boolean;
  v_hotel  boolean;
  v_legs   integer;
  v_dud    integer;
BEGIN
  -- Vueltas a medir. Una ya medida solo se rehace si su última marca tiene
  -- menos de 6 días: el GPS se borra a los 7 (0046) y rehacerla después
  -- volvería «ok» un tramo que el GPS había marcado como dudoso.
  WITH marcas AS (
    SELECT rs.route_assignment_id AS ra,
           max(GREATEST(rs.actual_arrival_at, rs.actual_pickup_at, rs.actual_dropoff_at)) AS ultima
      FROM public.route_stops rs
     WHERE COALESCE(rs.actual_arrival_at, rs.actual_pickup_at, rs.actual_dropoff_at) IS NOT NULL
     GROUP BY rs.route_assignment_id
  )
  SELECT COALESCE(array_agg(m.ra), '{}') INTO v_routes
    FROM marcas m
   WHERE m.ultima >= p_desde
     AND (m.ultima >= now() - interval '6 days'
          OR NOT EXISTS (SELECT 1 FROM public.route_trip_legs l WHERE l.route_assignment_id = m.ra));

  DELETE FROM public.route_trip_legs WHERE route_assignment_id = ANY (v_routes);

  FOREACH v_ra IN ARRAY v_routes LOOP
    SELECT ra.direction, ra.driver_profile_id INTO v_dir, v_drv
      FROM public.route_assignments ra WHERE ra.id = v_ra;
    SELECT pr.organization_id INTO v_org
      FROM public.route_stops rs
      JOIN public.reservations r       ON r.id = rs.reservation_id
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
      JOIN public.profiles pr          ON pr.id = ap.profile_id
     WHERE rs.route_assignment_id = v_ra
     LIMIT 1;
    a_lat := NULL; a_lng := NULL;
    SELECT ap.latitude, ap.longitude INTO a_lat, a_lng
      FROM public.airports ap WHERE ap.organization_id = v_org
     ORDER BY (ap.iata_code = 'MDE') DESC, ap.created_at LIMIT 1;

    p_rid := NULL; p_res := NULL; p_lat := NULL; p_lng := NULL; p_out := NULL; p_gout := NULL;

    IF v_dir = 'home_to_airport' THEN
      -- ── SALIDA: casas → aeropuerto ──
      SELECT min(rs.actual_dropoff_at) FILTER (WHERE rs.actual_pickup_at IS NOT NULL),
             min(r.required_arrival_at) FILTER (WHERE rs.actual_pickup_at IS NOT NULL),
             count(*) FILTER (WHERE rs.actual_pickup_at IS NOT NULL)
        INTO v_apt_at, v_dl, v_pax
        FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
       WHERE rs.route_assignment_id = v_ra;
      -- Franja de Julián = la de la presentación, como en el optimizador (rtFranja).
      v_ref := extract(hour FROM (COALESCE(v_dl, (SELECT min(COALESCE(rs.actual_arrival_at, rs.actual_pickup_at))
                                                    FROM public.route_stops rs WHERE rs.route_assignment_id = v_ra))
                                  AT TIME ZONE 'America/Bogota'))::int;

      -- Las puertas en el orden en que de verdad se visitaron (no el del plan).
      FOR s IN
        SELECT rs.reservation_id AS rid, r.residence_id AS res,
               r.pickup_latitude AS lat, r.pickup_longitude AS lng, r.is_overnight AS hotel,
               rs.estimated_arrival_at AS eta, rs.actual_arrival_at AS arr, rs.actual_pickup_at AS pick,
               COALESCE(rs.actual_arrival_at, rs.actual_pickup_at) AS door_in
          FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
         WHERE rs.route_assignment_id = v_ra
           AND COALESCE(rs.actual_arrival_at, rs.actual_pickup_at) IS NOT NULL
         ORDER BY COALESCE(rs.actual_arrival_at, rs.actual_pickup_at), rs.stop_order
      LOOP
        -- Pernocta (is_overnight): el plan usa la casa pero el carro puede ir al
        -- hotel. El punto real no se sabe: no se mide nada que toque esa puerta
        -- (ni se culpa al conductor de «marcar lejos»).
        IF s.hotel THEN
          p_rid := NULL; p_res := NULL; p_lat := NULL; p_lng := NULL; p_out := NULL; p_gout := NULL;
          CONTINUE;
        END IF;
        g_in  := public.marca_gps_m(v_drv, s.door_in, s.lat, s.lng);
        g_out := CASE WHEN s.pick IS NULL THEN NULL
                      WHEN s.pick = s.door_in THEN g_in
                      ELSE public.marca_gps_m(v_drv, s.pick, s.lat, s.lng) END;

        IF s.arr IS NOT NULL AND s.pick IS NOT NULL THEN
          PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'espera',
            s.rid, s.rid, s.res, s.res, s.lat, s.lng, s.lat, s.lng, s.arr, s.pick,
            NULL, NULL, NULL, v_ref, g_in, g_out, c_casa, c_casa, 60);
        END IF;
        IF s.eta IS NOT NULL AND s.arr IS NOT NULL THEN
          PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'puerta',
            s.rid, s.rid, s.res, s.res, s.lat, s.lng, s.lat, s.lng, s.eta, s.arr,
            NULL, s.eta, NULL, v_ref, NULL, g_in, c_casa, c_casa, 180);
        END IF;
        -- De la puerta anterior a esta. Misma portería (dos del mismo conjunto o
        -- a menos de 150 m) no es un viaje: es caminar.
        IF p_out IS NOT NULL
           AND NOT (p_res IS NOT NULL AND p_res = s.res)
           AND COALESCE(public.tramo_km(p_lat, p_lng, s.lat, s.lng), 1) >= 0.15 THEN
          PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'casa_casa',
            p_rid, s.rid, p_res, s.res, p_lat, p_lng, s.lat, s.lng, p_out, s.door_in,
            NULL, NULL, NULL, v_ref, p_gout, g_in, c_casa, c_casa, 90);
        END IF;
        -- Después de un «no se presentó» no se sabe a qué hora arrancó: el
        -- siguiente tramo no se mide.
        p_rid := s.rid; p_res := s.res; p_lat := s.lat; p_lng := s.lng; p_out := s.pick; p_gout := g_out;
      END LOOP;

      IF v_apt_at IS NOT NULL THEN
        g_apt := public.marca_gps_m(v_drv, v_apt_at, a_lat, a_lng);
        -- Tramo final: solo si la última puerta fue una recogida (si después hubo
        -- un «no se presentó», el tramo pasó por ahí y ya no es directo).
        IF p_out IS NOT NULL THEN
          PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'casa_aeropuerto',
            p_rid, NULL, p_res, NULL, p_lat, p_lng, a_lat, a_lng, p_out, v_apt_at,
            v_pax, NULL, v_dl, v_ref, p_gout, g_apt, c_casa, c_aero, 120);
        END IF;
        -- La vuelta completa: de la PRIMERA recogida al aeropuerto (su tabla de zona).
        SELECT rs.reservation_id AS rid, r.residence_id AS res, r.pickup_latitude AS lat,
               r.pickup_longitude AS lng, rs.actual_pickup_at AS pick
          INTO f
          FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
         WHERE rs.route_assignment_id = v_ra AND rs.actual_pickup_at IS NOT NULL
         ORDER BY rs.actual_pickup_at, rs.stop_order LIMIT 1;
        IF f.pick IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
              WHERE rs.route_assignment_id = v_ra AND rs.actual_pickup_at IS NOT NULL AND r.is_overnight) THEN
          PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'vuelta_salida',
            f.rid, NULL, f.res, NULL, f.lat, f.lng, a_lat, a_lng, f.pick, v_apt_at,
            v_pax, NULL, v_dl, v_ref, public.marca_gps_m(v_drv, f.pick, f.lat, f.lng), g_apt,
            c_casa, c_aero, 240);
        END IF;
      END IF;

    ELSE
      -- ── LLEGADA: aeropuerto → casas ──
      -- Del aeropuerto se sale cuando sube el último (no hay marca de «salí»).
      SELECT max(rs.actual_pickup_at), count(*) FILTER (WHERE rs.actual_pickup_at IS NOT NULL)
        INTO v_dep, v_pax
        FROM public.route_stops rs WHERE rs.route_assignment_id = v_ra;
      CONTINUE WHEN v_dep IS NULL;
      v_ref := extract(hour FROM v_dep AT TIME ZONE 'America/Bogota')::int;
      g_apt := public.marca_gps_m(v_drv, v_dep, a_lat, a_lng);
      v_first := true; v_hotel := false;
      FOR s IN
        SELECT rs.reservation_id AS rid, r.residence_id AS res,
               r.pickup_latitude AS lat, r.pickup_longitude AS lng, r.is_overnight AS hotel,
               rs.actual_dropoff_at AS drp
          FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
         WHERE rs.route_assignment_id = v_ra AND rs.actual_dropoff_at IS NOT NULL
         ORDER BY rs.actual_dropoff_at, rs.stop_order
      LOOP
        IF s.hotel THEN   -- pernocta: ver la salida
          v_first := false; v_hotel := true;
          p_rid := NULL; p_res := NULL; p_lat := NULL; p_lng := NULL; p_out := NULL; p_gout := NULL;
          CONTINUE;
        END IF;
        g_in := public.marca_gps_m(v_drv, s.drp, s.lat, s.lng);
        IF v_first THEN
          PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'aeropuerto_casa',
            NULL, s.rid, NULL, s.res, a_lat, a_lng, s.lat, s.lng, v_dep, s.drp,
            v_pax, NULL, NULL, v_ref, g_apt, g_in, c_aero, c_casa, 150);
        ELSIF p_out IS NOT NULL
              AND NOT (p_res IS NOT NULL AND p_res = s.res)
              AND COALESCE(public.tramo_km(p_lat, p_lng, s.lat, s.lng), 1) >= 0.15 THEN
          PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'casa_casa',
            p_rid, s.rid, p_res, s.res, p_lat, p_lng, s.lat, s.lng, p_out, s.drp,
            NULL, NULL, NULL, v_ref, p_gout, g_in, c_casa, c_casa, 90);
        END IF;
        v_first := false;
        p_rid := s.rid; p_res := s.res; p_lat := s.lat; p_lng := s.lng; p_out := s.drp; p_gout := g_in;
      END LOOP;
      IF NOT v_first AND NOT v_hotel AND p_out IS NOT NULL THEN
        PERFORM public.trip_leg_add(v_org, v_ra, v_drv, v_dir, 'vuelta_llegada',
          NULL, p_rid, NULL, p_res, a_lat, a_lng, p_lat, p_lng, v_dep, p_out,
          v_pax, NULL, NULL, v_ref, g_apt, p_gout, c_aero, c_casa, 240);
      END IF;
    END IF;
  END LOOP;

  SELECT count(*), count(*) FILTER (WHERE quality = 'dudosa') INTO v_legs, v_dud
    FROM public.route_trip_legs WHERE route_assignment_id = ANY (v_routes);
  INSERT INTO public.route_trip_legs_runs (routes, legs, dudosos)
  VALUES (cardinality(v_routes), v_legs, v_dud);
  DELETE FROM public.route_trip_legs_runs
   WHERE id IN (SELECT id FROM public.route_trip_legs_runs ORDER BY ran_at DESC OFFSET 500);

  RETURN jsonb_build_object('vueltas', cardinality(v_routes), 'tramos', v_legs, 'dudosos', v_dud);
END;
$$;

COMMENT ON FUNCTION public.collect_trip_legs(timestamptz) IS
  '0116 · Convierte las marcas del conductor en tramos medidos (route_trip_legs) y comprueba cada marca contra el GPS. La llama pg_cron cada hora; el jefe, con «Medir ahora».';

-- El jefe no espera la hora: «Medir ahora» en Calibración › Tiempos reales.
-- Mide todo (como el reloj) pero cuenta solo lo de SU organización: lo que
-- se acaba de rehacer queda con created_at = now() de esta misma transacción.
CREATE OR REPLACE FUNCTION public.admin_collect_trip_legs()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid := public.current_user_org();
  v_out jsonb;
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe puede medir los tiempos' USING ERRCODE = '42501';
  END IF;
  PERFORM public.collect_trip_legs(now() - interval '3 days');
  SELECT jsonb_build_object(
           'vueltas', count(DISTINCT l.route_assignment_id),
           'tramos',  count(*),
           'dudosos', count(*) FILTER (WHERE l.quality = 'dudosa'))
    INTO v_out
    FROM public.route_trip_legs l
   WHERE l.organization_id = v_org AND l.created_at >= now();
  RETURN v_out;
END;
$$;

-- ── 6. Lo que ve el jefe ────────────────────────────────────────────────────
-- Todo en una sola llamada, ya contado. Las franjas son las de Julián
-- (route_leg_times); si esa tabla está vacía, las mismas a mano.
--   p_days — cuántos días hacia atrás (7 a 730)
--   p_min  — viajes mínimos para que una celda se considere confiable
CREATE OR REPLACE FUNCTION public.admin_learned_times(p_days integer DEFAULT 120, p_min integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org  uuid := public.current_user_org();
  v_out  jsonb;
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un jefe puede ver los tiempos aprendidos' USING ERRCODE = '42501';
  END IF;
  p_days := LEAST(GREATEST(COALESCE(p_days, 120), 7), 730);
  p_min  := LEAST(GREATEST(COALESCE(p_min, 10), 1), 100);

  WITH bands AS (
    SELECT band_from, band_to FROM public.route_leg_times
    UNION ALL
    SELECT * FROM (VALUES (0, 2), (2, 6), (6, 9), (9, 12), (12, 19), (19, 24)) v(band_from, band_to)
     WHERE NOT EXISTS (SELECT 1 FROM public.route_leg_times)
  ),
  base AS (
    SELECT l.*,
           (SELECT b.band_from FROM bands b WHERE l.ref_hour >= b.band_from AND l.ref_hour < b.band_to
             ORDER BY b.band_from LIMIT 1) AS band,
           public.zona_efectiva(rf.zona_jefe, l.from_lat, l.from_lng) AS zona_from,
           public.zona_efectiva(rt.zona_jefe, l.to_lat, l.to_lng)     AS zona_to,
           rf.name AS res_from, rt.name AS res_to
      FROM public.route_trip_legs l
      LEFT JOIN public.residences rf ON rf.id = l.from_residence_id
      LEFT JOIN public.residences rt ON rt.id = l.to_residence_id
     WHERE l.organization_id = v_org
       AND l.service_day >= (now() AT TIME ZONE 'America/Bogota')::date - p_days
  ),
  ok AS (SELECT * FROM base WHERE quality = 'ok')
  SELECT jsonb_build_object(
    'dias', p_days,
    'minimo', p_min,
    'franjas', (SELECT jsonb_agg(jsonb_build_object('desde', band_from, 'hasta', band_to) ORDER BY band_from) FROM bands),
    'ultima_medicion', (SELECT max(ran_at) FROM public.route_trip_legs_runs),
    'resumen', (SELECT jsonb_build_object(
        'desde', min(service_day), 'hasta', max(service_day),
        'vueltas', count(*) FILTER (WHERE kind IN ('vuelta_salida', 'vuelta_llegada')),
        'vueltas_ok', count(*) FILTER (WHERE kind IN ('vuelta_salida', 'vuelta_llegada') AND quality = 'ok'),
        'tramos', count(*) FILTER (WHERE kind IN ('casa_casa', 'casa_aeropuerto', 'aeropuerto_casa')),
        'tramos_ok', count(*) FILTER (WHERE kind IN ('casa_casa', 'casa_aeropuerto', 'aeropuerto_casa') AND quality = 'ok'),
        'dudosos', count(*) FILTER (WHERE quality = 'dudosa'),
        'sin_gps', count(*) FILTER (WHERE kind IN ('casa_casa', 'casa_aeropuerto', 'aeropuerto_casa')
                                      AND start_gps_m IS NULL AND end_gps_m IS NULL),
        'ultimo_viaje', max(ended_at)) FROM base),
    -- Con cuánto margen llegaron al aeropuerto (presentación − llegada). Negativo = tarde.
    'margen', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.band), '[]'::jsonb) FROM (
        SELECT band, count(*) AS n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM deadline_at - ended_at) / 60)::numeric) AS mediana,
               round(min(extract(epoch FROM deadline_at - ended_at) / 60)::numeric) AS peor,
               count(*) FILTER (WHERE deadline_at < ended_at) AS tarde,
               count(*) FILTER (WHERE deadline_at >= ended_at AND deadline_at < ended_at + interval '10 minutes') AS justo
          FROM ok WHERE kind = 'vuelta_salida' AND deadline_at IS NOT NULL
         GROUP BY band) x),
    -- ¿El plan acierta? Atraso del carro en la puerta contra la hora del plan.
    'puerta', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.band), '[]'::jsonb) FROM (
        SELECT band, count(*) AS n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::numeric) AS mediana,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes)::numeric) AS p90,
               count(*) FILTER (WHERE minutes > 5) AS tarde,
               count(*) FILTER (WHERE minutes < -5) AS temprano
          FROM ok WHERE kind = 'puerta'
         GROUP BY band) x),
    -- Tramo final (última recogida → aeropuerto), por zona y en total, contra su regla.
    'tramo_final', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.band, x.day_type, x.total DESC, x.zona), '[]'::jsonb) FROM (
        SELECT o.band, o.day_type,
               CASE WHEN GROUPING(o.zona) = 1 THEN 'Todas' ELSE o.zona END AS zona,
               GROUPING(o.zona) AS total,
               count(*) AS n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY o.minutes)::numeric) AS mediana,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY o.minutes)::numeric) AS p90,
               round(max(o.minutes)) AS max,
               (SELECT lt.min_minutes FROM public.route_leg_times lt WHERE lt.band_from = o.band) AS julian_min,
               (SELECT lt.max_minutes FROM public.route_leg_times lt WHERE lt.band_from = o.band) AS julian_max
          FROM (SELECT band, day_type, minutes, COALESCE(zona_from, 'Sin zona') AS zona
                  FROM ok WHERE kind = 'casa_aeropuerto') o
         GROUP BY GROUPING SETS ((o.band, o.day_type, o.zona), (o.band, o.day_type))) x),
    -- Vuelta completa (primera recogida → aeropuerto) por zona, franja y gente,
    -- al lado del número de su tabla (1 → mínimo · 2 → medio · 3+ → máximo).
    'vuelta', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.zona, x.band, x.gente, x.day_type), '[]'::jsonb) FROM (
        SELECT o.zona, o.band, o.gente, o.day_type, count(*) AS n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY o.minutes)::numeric) AS mediana,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY o.minutes)::numeric) AS p90,
               (SELECT CASE o.gente WHEN '1' THEN zt.min_minutes WHEN '3+' THEN zt.max_minutes
                                    ELSE round((zt.min_minutes + zt.max_minutes) / 2.0) END
                  FROM public.route_zone_times zt WHERE zt.zone = o.zona AND zt.band_from = o.band) AS julian
          FROM (SELECT band, day_type, minutes, COALESCE(zona_from, 'Sin zona') AS zona,
                       CASE WHEN COALESCE(pax, 1) <= 1 THEN '1' WHEN pax = 2 THEN '2' ELSE '3+' END AS gente
                  FROM ok WHERE kind = 'vuelta_salida') o
         GROUP BY o.zona, o.band, o.gente, o.day_type) x),
    -- Llegadas: del aeropuerto a la primera casa, por zona de esa casa.
    'llegadas', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.zona, x.band, x.day_type), '[]'::jsonb) FROM (
        SELECT COALESCE(zona_to, 'Sin zona') AS zona, band, day_type, count(*) AS n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::numeric) AS mediana,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes)::numeric) AS p90
          FROM ok WHERE kind = 'aeropuerto_casa'
         GROUP BY COALESCE(zona_to, 'Sin zona'), band, day_type) x),
    -- Conjunto → aeropuerto: el dato más fino (sirve aunque no haya zonas dibujadas).
    'conjuntos', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.n DESC, x.conjunto), '[]'::jsonb) FROM (
        SELECT COALESCE(res_from, 'Dirección propia') AS conjunto, band, day_type, count(*) AS n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::numeric) AS mediana,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes)::numeric) AS p90
          FROM ok WHERE kind = 'casa_aeropuerto'
         GROUP BY COALESCE(res_from, 'Dirección propia'), band, day_type
         ORDER BY count(*) DESC LIMIT 80) x),
    -- Cuánto tarda la gente en bajar, por conjunto.
    'espera', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.n DESC, x.conjunto), '[]'::jsonb) FROM (
        SELECT COALESCE(res_from, 'Dirección propia') AS conjunto, count(*) AS n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::numeric) AS mediana,
               round(percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes)::numeric) AS p90
          FROM ok WHERE kind = 'espera'
         GROUP BY COALESCE(res_from, 'Dirección propia')
         ORDER BY count(*) DESC LIMIT 40) x),
    -- Quién marca a destiempo (para enseñarle, no para castigarlo).
    'conductores', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.dudosos DESC, x.nombre), '[]'::jsonb) FROM (
        SELECT COALESCE(pr.full_name, 'Sin conductor') AS nombre,
               count(*) AS total,
               count(*) FILTER (WHERE b.quality = 'dudosa') AS dudosos
          FROM base b
          LEFT JOIN public.driver_profiles dp ON dp.id = b.driver_profile_id
          LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
         GROUP BY COALESCE(pr.full_name, 'Sin conductor')) x),
    'dudosos', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.cuando DESC), '[]'::jsonb) FROM (
        SELECT b.kind, b.ended_at AS cuando, b.minutes, b.quality_reason AS motivo,
               COALESCE(pr.full_name, 'Sin conductor') AS conductor,
               b.res_from, b.res_to
          FROM base b
          LEFT JOIN public.driver_profiles dp ON dp.id = b.driver_profile_id
          LEFT JOIN public.profiles pr        ON pr.id = dp.profile_id
         WHERE b.quality = 'dudosa'
         ORDER BY b.ended_at DESC LIMIT 25) x)
  ) INTO v_out;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.admin_learned_times(integer, integer) IS
  '0116 · Calibración › Tiempos reales: margen en el aeropuerto, plan vs. real en la puerta, tramo final y vuelta completa contra la tabla de Julián, llegadas, conjuntos, espera y marcas dudosas.';

-- ── 7. Permisos ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.trip_leg_add(uuid, uuid, uuid, public.trip_direction, text, uuid, uuid, uuid, uuid,
  double precision, double precision, double precision, double precision, timestamptz, timestamptz,
  integer, timestamptz, timestamptz, integer, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collect_trip_legs(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.marca_gps_m(uuid, timestamptz, double precision, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_collect_trip_legs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_collect_trip_legs() TO authenticated;
REVOKE ALL ON FUNCTION public.admin_learned_times(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_learned_times(integer, integer) TO authenticated;

-- ── 8. El reloj: cada hora, al minuto 7 ─────────────────────────────────────
DO $do$
BEGIN
  PERFORM cron.schedule('collect-trip-legs', '7 * * * *', $job$SELECT public.collect_trip_legs();$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron no disponible (%): la medición queda creada pero nadie la llama.', SQLERRM;
END
$do$;

-- ── 9. Lo que ya hay: se mide todo lo que exista desde el principio ─────────
-- Las vueltas viejas no tienen GPS (se borró a los 7 días): quedan sin
-- comprobar, pero las reglas de orden, velocidad y duración sí se aplican.
SELECT public.collect_trip_legs('2000-01-01'::timestamptz);

COMMIT;
