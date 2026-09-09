-- =============================================================================
-- Migration 0036 — Recompensas por kilometraje (Fase D)
--
-- El conductor acumula km de por vida (suma de cierre-apertura de sus turnos
-- cerrados) y desbloquea recompensas al pasar umbrales. Niveles plata/oro/diamante.
-- El admin define los premios y atiende las solicitudes de redención.
--
--   - rewards            : catálogo de premios (lo crea/edita el admin).
--   - reward_redemptions : solicitud de redención del conductor (la atiende el admin).
--
-- El km acumulado NO se almacena: se calcula desde shifts (fuente de verdad).
-- Se siembran ejemplos REALES (editables/borrables por el admin), no mock en el
-- front. Idempotente.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- rewards — catálogo de premios
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rewards (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  tier             text        NOT NULL DEFAULT 'plata',
  km_threshold     int         NOT NULL,
  title            text        NOT NULL,
  description      text,
  active           boolean     NOT NULL DEFAULT true,
  sort_order       int         NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rewards_tier_valid       CHECK (tier IN ('plata', 'oro', 'diamante')),
  CONSTRAINT rewards_threshold_pos    CHECK (km_threshold >= 0),
  CONSTRAINT rewards_title_not_blank  CHECK (length(btrim(title)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_rewards_org ON public.rewards(organization_id);

DROP TRIGGER IF EXISTS tr_rewards_set_updated_at ON public.rewards;
CREATE TRIGGER tr_rewards_set_updated_at BEFORE UPDATE ON public.rewards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.rewards ENABLE ROW LEVEL SECURITY;

-- Todos los autenticados de la org pueden VER el catálogo activo.
DROP POLICY IF EXISTS p_rewards_select ON public.rewards;
CREATE POLICY p_rewards_select ON public.rewards FOR SELECT TO authenticated
  USING (organization_id = public.current_user_org());

-- Solo el admin crea/edita/borra.
DROP POLICY IF EXISTS p_rewards_mutate_admin ON public.rewards;
CREATE POLICY p_rewards_mutate_admin ON public.rewards FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  WITH CHECK (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- -----------------------------------------------------------------------------
-- reward_redemptions — solicitudes de redención
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reward_redemptions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  driver_id        uuid        NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  reward_id        uuid        NOT NULL REFERENCES public.rewards(id) ON DELETE RESTRICT,
  km_at_request    int         NOT NULL DEFAULT 0,
  status           text        NOT NULL DEFAULT 'pending',
  notes            text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_by      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reward_redemptions_status_valid CHECK (status IN ('pending', 'approved', 'delivered', 'rejected'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_org    ON public.reward_redemptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_driver ON public.reward_redemptions(driver_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_status ON public.reward_redemptions(status);

DROP TRIGGER IF EXISTS tr_redemptions_set_updated_at ON public.reward_redemptions;
CREATE TRIGGER tr_redemptions_set_updated_at BEFORE UPDATE ON public.reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.reward_redemptions ENABLE ROW LEVEL SECURITY;

-- El conductor ve y crea SUS solicitudes; el admin ve/atiende las de su org.
DROP POLICY IF EXISTS p_redemptions_select_own ON public.reward_redemptions;
CREATE POLICY p_redemptions_select_own ON public.reward_redemptions FOR SELECT TO authenticated
  USING (driver_id = public.current_driver_id());

DROP POLICY IF EXISTS p_redemptions_select_admin ON public.reward_redemptions;
CREATE POLICY p_redemptions_select_admin ON public.reward_redemptions FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_redemptions_insert_own ON public.reward_redemptions;
CREATE POLICY p_redemptions_insert_own ON public.reward_redemptions FOR INSERT TO authenticated
  WITH CHECK (driver_id = public.current_driver_id() AND organization_id = public.current_user_org());

DROP POLICY IF EXISTS p_redemptions_update_admin ON public.reward_redemptions;
CREATE POLICY p_redemptions_update_admin ON public.reward_redemptions FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin' AND organization_id = public.current_user_org())
  WITH CHECK (public.current_user_role() = 'admin' AND organization_id = public.current_user_org());

-- -----------------------------------------------------------------------------
-- Semilla de ejemplos REALES (editables/borrables por el admin). Idempotente:
-- solo siembra si la org no tiene recompensas todavía.
-- -----------------------------------------------------------------------------
INSERT INTO public.rewards (organization_id, tier, km_threshold, title, description, sort_order)
SELECT o.id, x.tier, x.km, x.title, x.descr, x.ord
  FROM public.organizations o
  CROSS JOIN (VALUES
    ('plata',     2000,  'Perro caliente',        'Un perro caliente cortesía',                 1),
    ('plata',     4000,  'Hamburguesa',           'Una hamburguesa para ti',                    2),
    ('oro',       8000,  'Día libre remunerado',  'Un día de descanso pago',                    3),
    ('oro',       12000, 'Bono de gasolina',      'Bono de combustible',                        4),
    ('diamante',  20000, 'Bono de mercado',       'Bono para tu mercado',                       5)
  ) AS x(tier, km, title, descr, ord)
 WHERE NOT EXISTS (SELECT 1 FROM public.rewards r WHERE r.organization_id = o.id);

COMMENT ON TABLE public.rewards            IS 'Catálogo de recompensas por km (lo define el admin). Niveles plata/oro/diamante, desbloqueo por km_threshold.';
COMMENT ON TABLE public.reward_redemptions IS 'Solicitudes de redención del conductor; el admin las aprueba/entrega.';

COMMIT;
