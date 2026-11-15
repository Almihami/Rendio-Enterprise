-- =============================================================================
-- 0164 · El aviso del apoyo, bien escrito
-- =============================================================================
-- La prueba en vivo en dev (15-nov) mostró «…a 2:00 p. m.. Si los carros…» (dos
-- puntos seguidos) y «Hoy, de 2:00…: Coordinación lo cambió.». apoyo_avisar
-- copiada DESDE 0163; solo cambia el texto.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.apoyo_avisar(p_dp uuid, p_day date, p_band text, p_tiene boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prof uuid;
  v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_dia text; v_ok boolean;
BEGIN
  IF p_dp IS NULL OR p_day IS NULL OR p_day < v_hoy - 1 THEN RETURN false; END IF;
  SELECT dp.profile_id INTO v_prof FROM public.driver_profiles dp WHERE dp.id = p_dp;
  IF v_prof IS NULL THEN RETURN false; END IF;
  v_dia := CASE WHEN p_day = v_hoy THEN 'hoy' WHEN p_day = v_hoy + 1 THEN 'mañana' WHEN p_day = v_hoy - 1 THEN 'ayer'
                ELSE 'el ' || to_char(p_day, 'DD/MM') END;
  v_ok := public.trip_notify(v_prof,
    CASE WHEN p_tiene THEN 'Tienes el carro de apoyo 🚐' ELSE 'Ya no tienes el carro de apoyo' END,
    CASE WHEN p_tiene
         THEN upper(left(v_dia, 1)) || substr(v_dia, 2)
              || CASE WHEN p_band = 'am' THEN ', de 2:00 a. m. a 2:00 p. m.' ELSE ', de 2:00 p. m. a 2:00 a. m.' END
              || ' Si los carros fijos no alcanzan con una llegada, te la mandamos aquí. Deja la app abierta para saber dónde estás.'
         ELSE 'Coordinación cambió el apoyo de ' || v_dia || CASE WHEN p_band = 'am' THEN ' en la mañana.' ELSE ' en la tarde.' END END,
    '/#/', 'apoyo-duty:' || p_day::text || ':' || p_band || ':' || p_dp::text || ':' || p_tiene::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MI'));
  PERFORM public.trip_kick();
  RETURN coalesce(v_ok, false);
END;
$$;

COMMIT;
