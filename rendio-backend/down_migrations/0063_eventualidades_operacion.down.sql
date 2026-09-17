-- Down de 0063 — quita las eventualidades de operación.
--
-- OJO ANTES DE CORRERLO: si ya hay eventualidades con scope='operacion' en la
-- tabla, este down las deja huérfanas de contexto (pierden ruta, parada, punto y
-- detalles) pero NO las borra: siguen visibles en la cola de Inspecciones porque
-- `scope` desaparece. Si eso estorba, hay que borrarlas a mano ANTES:
--   DELETE FROM public.incidents WHERE scope = 'operacion';
--
-- Las categorías nuevas del enum (0062) NO se pueden quitar: Postgres no permite
-- eliminar valores de un enum. Quedan declaradas y sin usar, que es inofensivo.

BEGIN;

DROP TABLE IF EXISTS public.notification_outbox;

DROP FUNCTION IF EXISTS public.report_incident(
  public.incident_category, text, public.incident_severity, uuid, jsonb,
  double precision, double precision, jsonb
);

-- Se devuelve la policy de INSERT a como estaba en 0016.
DROP POLICY IF EXISTS p_incidents_insert_own ON public.incidents;
CREATE POLICY p_incidents_insert_own
  ON public.incidents FOR INSERT TO authenticated
  WITH CHECK (
    reporter_id = auth.uid()
    AND organization_id = public.current_user_org()
  );

DROP INDEX IF EXISTS public.idx_incidents_scope_status;
DROP INDEX IF EXISTS public.idx_incidents_dedupe_open;
DROP INDEX IF EXISTS public.idx_incidents_reservation;

ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_scope_valid;
ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_source_valid;

ALTER TABLE public.incidents
  DROP COLUMN IF EXISTS scope,
  DROP COLUMN IF EXISTS route_assignment_id,
  DROP COLUMN IF EXISTS route_stop_id,
  DROP COLUMN IF EXISTS occurred_at,
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS details,
  DROP COLUMN IF EXISTS dedupe_key,
  DROP COLUMN IF EXISTS acknowledged_at,
  DROP COLUMN IF EXISTS acknowledged_by;

-- Volver a NOT NULL solo es posible si no quedan filas del sistema.
-- Si falla, es porque hay eventualidades sin reportero: bórralas primero.
ALTER TABLE public.incidents ALTER COLUMN reporter_id SET NOT NULL;

ALTER TABLE public.profiles DROP COLUMN IF EXISTS receives_ops_alerts;

COMMIT;
