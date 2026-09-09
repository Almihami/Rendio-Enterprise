-- 0069_traslado_privado.sql — El traslado privado: la camioneta, no un carro más.
--
-- QUÉ ES
-- Hoy todos los traslados son el mismo servicio: el auxiliar pide, el asignador
-- lo agrupa por sector con sus compañeros y sale en uno de los carros de la
-- flota. Esta migración añade un segundo nivel — el PRIVADO — que se presta con
-- un vehículo dedicado (la camioneta), no se agrupa con nadie, tiene precio y lo
-- aprueba un jefe antes de comprometerse.
--
-- TRES DECISIONES DE PRODUCTO QUE ESTA MIGRACIÓN SOSTIENE (2026-08-17)
--
--  1. NO se cobra dentro de la app. Se guarda el precio que se le mostró al
--     auxiliar, y el cobro se liquida por fuera. Por eso acá no hay pasarela, ni
--     estado de pago, ni recibo: Rendio no tiene ninguna tabla de cobros y
--     fabricar media no ayuda a nadie. `price_cop` es un dato informativo
--     congelado, no una cuenta por cobrar.
--
--  2. El cupo NO es un número configurado: es un hecho físico. Hay UNA
--     camioneta, luego hay como máximo un privado a la vez. La disponibilidad se
--     calcula preguntando si ese vehículo está libre en la franja, no leyendo un
--     parámetro que alguien tendría que mantener a mano. Ver
--     `private_vehicle_busy_at()`.
--
--  3. Lo aprueba un jefe. Es un servicio excepcional y de pago sobre el carro
--     del jefe: que un humano lo confirme antes de prometerlo. El auxiliar
--     SOLICITA; no se auto-aprueba (la RLS lo impide, no solo la interfaz).
--
-- EL NIVEL "DIRECTO" NO EXISTE AQUÍ, a propósito: la operación no lo ha
-- definido (2026-08-17). El enum se deja abierto para agregarlo sin migrar de
-- nuevo el resto.
--
-- Idempotente.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. El nivel de servicio de la reserva
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'service_level') THEN
    CREATE TYPE public.service_level AS ENUM ('shared', 'private');
  END IF;
END $$;

-- Estado de la solicitud de privado. Va aparte del nivel: una reserva puede ser
-- 'private' y estar rechazada, y en ese caso se presta como compartida — pero
-- queremos poder contar cuántas se pidieron y cuántas se negaron.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'private_status') THEN
    CREATE TYPE public.private_status AS ENUM ('requested', 'approved', 'rejected');
  END IF;
END $$;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS service_level   public.service_level NOT NULL DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS private_status  public.private_status,
  -- Precio que se le MOSTRÓ al auxiliar cuando pidió. Congelado a propósito: si
  -- el jefe sube la tarifa mañana, lo que se acordó ayer no se puede reescribir.
  ADD COLUMN IF NOT EXISTS price_cop       integer,
  ADD COLUMN IF NOT EXISTS private_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS private_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS private_decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS private_reject_reason text;

COMMENT ON COLUMN public.reservations.service_level IS
  'shared = servicio incluido, se agrupa por sector. private = vehículo dedicado, con precio y aprobación del jefe.';
COMMENT ON COLUMN public.reservations.price_cop IS
  'Precio en pesos que se le mostró al auxiliar al pedir. Congelado: NO se recalcula si cambia la tarifa. Informativo — no hay cobro en la app.';

-- Coherencia: si es privado tiene estado de solicitud; si es compartido, no.
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_private_coherente;
ALTER TABLE public.reservations
  ADD CONSTRAINT reservations_private_coherente CHECK (
    (service_level = 'private' AND private_status IS NOT NULL)
    OR (service_level = 'shared' AND private_status IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_reservations_private
  ON public.reservations(private_status, required_arrival_at)
  WHERE service_level = 'private';

-- ---------------------------------------------------------------------------
-- 2. Ajustes: la tarifa y CUÁL vehículo es la camioneta
-- ---------------------------------------------------------------------------
-- El vehículo se guarda como referencia, NO como placa escrita a mano: si mañana
-- la camioneta es otra, se cambia en un desplegable y no hay que tocar código.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS aux_private_price_cop integer NOT NULL DEFAULT 150000,
  ADD COLUMN IF NOT EXISTS aux_private_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS aux_private_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.app_settings.aux_private_price_cop IS
  'Tarifa del traslado privado, en pesos. El 150000 del default es un VALOR PROVISIONAL puesto por quien implementó la pantalla, no una tarifa acordada por la operación: hay que reemplazarlo.';
COMMENT ON COLUMN public.app_settings.aux_private_enabled IS
  'Apaga el privado sin desplegar. Arranca en false: mientras no haya camioneta elegida y tarifa confirmada, el auxiliar no ve la opción.';

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_private_price_pos;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_private_price_pos CHECK (aux_private_price_cop > 0);

-- ---------------------------------------------------------------------------
-- 3. ¿Está ocupada la camioneta en esa franja?
-- ---------------------------------------------------------------------------
-- El cupo del privado sale de aquí y de ningún parámetro. Una camioneta = un
-- privado a la vez.
--
-- La "franja" se mide alrededor de la hora comprometida (required_arrival_at)
-- con una ventana a lado y lado, porque un traslado no es un instante: el carro
-- sale antes y vuelve después. La ventana se toma de route_turnaround_min si
-- está, y si no cae a 90 minutos.
-- (CORREGIDO EN 0070: este parámetro era el equivocado.)
CREATE OR REPLACE FUNCTION public.private_vehicle_busy_at(
  p_when      timestamptz,
  p_exclude   uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.reservations r
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT route_turnaround_min FROM public.app_settings LIMIT 1), 90) AS win
    ) s
    WHERE r.service_level = 'private'
      AND r.private_status IN ('requested', 'approved')
      AND r.cancelled_at IS NULL
      AND (p_exclude IS NULL OR r.id <> p_exclude)
      AND r.required_arrival_at BETWEEN p_when - (s.win || ' minutes')::interval
                                    AND p_when + (s.win || ' minutes')::interval
  );
$$;

COMMENT ON FUNCTION public.private_vehicle_busy_at IS
  'true si ya hay un privado pedido o aprobado en la franja. Es el cupo: hay una sola camioneta. SECURITY DEFINER para que el auxiliar pueda preguntar sin poder leer las reservas de los demás.';

REVOKE ALL ON FUNCTION public.private_vehicle_busy_at(timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.private_vehicle_busy_at(timestamptz, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. El jefe decide
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_decide_private(
  p_reservation_id uuid,
  p_approve        boolean,
  p_reason         text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me      uuid := auth.uid();
  v_res     public.reservations%ROWTYPE;
  v_vehicle uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede decidir un traslado privado';
  END IF;

  SELECT * INTO v_res FROM public.reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'La reserva no existe'; END IF;
  IF v_res.service_level <> 'private' THEN
    RAISE EXCEPTION 'Esa reserva no es un traslado privado';
  END IF;

  IF p_approve THEN
    SELECT aux_private_vehicle_id INTO v_vehicle FROM public.app_settings LIMIT 1;
    IF v_vehicle IS NULL THEN
      RAISE EXCEPTION 'No hay camioneta configurada en Ajustes: no se puede aprobar un privado sin vehículo';
    END IF;
    -- Se vuelve a mirar el cupo en el momento de aprobar, no solo al pedir:
    -- entre una cosa y la otra pudo entrar otra solicitud.
    IF public.private_vehicle_busy_at(v_res.required_arrival_at, p_reservation_id) THEN
      RAISE EXCEPTION 'La camioneta ya está comprometida en esa franja';
    END IF;
    UPDATE public.reservations
       SET private_status = 'approved',
           private_vehicle_id = v_vehicle,
           private_decided_at = now(),
           private_decided_by = v_me,
           private_reject_reason = NULL
     WHERE id = p_reservation_id;
  ELSE
    UPDATE public.reservations
       SET private_status = 'rejected',
           private_vehicle_id = NULL,
           private_decided_at = now(),
           private_decided_by = v_me,
           private_reject_reason = NULLIF(btrim(COALESCE(p_reason, '')), '')
     WHERE id = p_reservation_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'approved', p_approve,
    'auxiliar_profile_id', v_res.auxiliar_profile_id,
    -- Para avisarle por push a quien pidió.
    'requester_profile_id', (SELECT profile_id FROM public.auxiliar_profiles WHERE id = v_res.auxiliar_profile_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_decide_private(uuid, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_decide_private(uuid, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Que el auxiliar no se apruebe a sí mismo
-- ---------------------------------------------------------------------------
-- La política de update del auxiliar (0050) le deja tocar SU reserva. Sin esto,
-- podría marcarse `private_status='approved'` desde la consola del navegador y
-- aparecer aprobado en la bandeja del jefe. Un trigger, no una regla de
-- interfaz: la interfaz no es una frontera de seguridad.
CREATE OR REPLACE FUNCTION public.guard_private_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.current_user_role() = 'admin' THEN
    RETURN NEW;
  END IF;
  -- Un no-admin puede pedir (NULL → 'requested') y nada más.
  IF NEW.private_status IS DISTINCT FROM OLD.private_status
     AND NOT (OLD.private_status IS NULL AND NEW.private_status = 'requested') THEN
    RAISE EXCEPTION 'Solo un administrador puede aprobar o rechazar un traslado privado';
  END IF;
  IF NEW.private_vehicle_id IS DISTINCT FROM OLD.private_vehicle_id
     OR NEW.private_decided_by IS DISTINCT FROM OLD.private_decided_by THEN
    RAISE EXCEPTION 'Solo un administrador asigna el vehículo de un privado';
  END IF;
  -- Y que no se cambie el precio pactado.
  IF NEW.price_cop IS DISTINCT FROM OLD.price_cop THEN
    RAISE EXCEPTION 'El precio de un traslado ya pedido no se modifica';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_guard_private_decision ON public.reservations;
CREATE TRIGGER tr_guard_private_decision
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_private_decision();

-- Al INSERTAR, el auxiliar solo puede crear un privado en estado 'requested' y
-- con el precio vigente: ni aprobado, ni con una tarifa inventada.
CREATE OR REPLACE FUNCTION public.guard_private_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_price integer;
BEGIN
  IF NEW.service_level = 'private' THEN
    IF public.current_user_role() <> 'admin' THEN
      NEW.private_status := 'requested';
      NEW.private_vehicle_id := NULL;
      NEW.private_decided_at := NULL;
      NEW.private_decided_by := NULL;
      SELECT aux_private_price_cop INTO v_price FROM public.app_settings LIMIT 1;
      NEW.price_cop := v_price;   -- el precio lo pone el servidor, no el teléfono
    END IF;
  ELSE
    NEW.private_status := NULL;
    NEW.price_cop := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_guard_private_insert ON public.reservations;
CREATE TRIGGER tr_guard_private_insert
  BEFORE INSERT ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_private_insert();

COMMIT;
