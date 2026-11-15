-- Down de 0164: el texto de 0163.
BEGIN;

CREATE OR REPLACE FUNCTION public.apoyo_avisar(p_dp uuid, p_day date, p_band text, p_tiene boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prof uuid;
  v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_cuando text; v_ok boolean;
BEGIN
  IF p_dp IS NULL OR p_day IS NULL OR p_day < v_hoy - 1 THEN RETURN false; END IF;
  SELECT dp.profile_id INTO v_prof FROM public.driver_profiles dp WHERE dp.id = p_dp;
  IF v_prof IS NULL THEN RETURN false; END IF;
  v_cuando := CASE WHEN p_day = v_hoy THEN 'Hoy' WHEN p_day = v_hoy + 1 THEN 'Mañana' WHEN p_day = v_hoy - 1 THEN 'Esta madrugada'
                   ELSE 'El ' || to_char(p_day, 'DD/MM') END
           || CASE WHEN p_band = 'am' THEN ', de 2:00 a. m. a 2:00 p. m.' ELSE ', de 2:00 p. m. a 2:00 a. m.' END;
  v_ok := public.trip_notify(v_prof,
    CASE WHEN p_tiene THEN 'Tienes el carro de apoyo 🚐' ELSE 'Ya no tienes el carro de apoyo' END,
    CASE WHEN p_tiene
         THEN v_cuando || '. Si los carros fijos no alcanzan con una llegada, te la mandamos aquí. Deja la app abierta para saber dónde estás.'
         ELSE v_cuando || ': Coordinación lo cambió.' END,
    '/#/', 'apoyo-duty:' || p_day::text || ':' || p_band || ':' || p_dp::text || ':' || p_tiene::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MI'));
  PERFORM public.trip_kick();
  RETURN coalesce(v_ok, false);
END;
$$;

COMMIT;
