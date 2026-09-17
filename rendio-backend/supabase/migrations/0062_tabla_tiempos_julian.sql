-- 0062_tabla_tiempos_julian.sql
--
-- LA TABLA DE TIEMPOS DEL JEFE, tal como la dictó por WhatsApp el 2026-08-16.
--
-- CAMBIO DE FONDO: hasta hoy el modelo CALCULABA cuánto tarda un traslado (OSRM
-- corregido con factores). Julián no quiere que se calcule: quiere que se
-- CONSULTE en su tabla, que es lo que él lleva en la cabeza y lo que la
-- operación cumple todos los días.
--
-- Las dos cosas conviven y no se pisan, porque responden preguntas distintas:
--   · Lo que el carro PUEDE hacer  → OSRM + factores. Sirve para saber si una
--     vuelta es viable y para no prometer imposibles.
--   · A qué hora hay que RECOGER   → esta tabla. Trae margen adentro a propósito.
-- Por eso el solver usa el MAYOR de los dos (ver rtDurProgramada en
-- admin-rutas.js): la tabla nunca hace ir más rápido de lo que se puede, y el
-- cálculo nunca recoge más tarde de lo que el jefe recogería.
--
-- DOS TABLAS, porque él dio dos reglas:
--   1. route_zone_times — de recoger al PRIMERO a llegar al aeropuerto, por zona
--      y franja horaria. Verificado con su propio ejemplo: Melina, presentación
--      15:55, entregarla 15:45, recogerla 15:05 = 40 min = el mínimo de Porvenir
--      en la franja 12-19.
--   2. route_leg_times — solo el tramo final, desde la ÚLTIMA persona que
--      recoge. En una vuelta de varias paradas tiene que caber dentro del total.
--
-- EL RANGO min/max es por cuánta gente va: "si van solo pueden ir con el tiempo
-- mínimo, si van con personas dependiendo de la lejanía y qué tantas vayan".
-- 1 persona → mínimo · 2 → el punto medio · 3 o más → máximo.
--
-- LA FRANJA 00:00–02:00 NO LA DIO (su tabla arranca a las 2 a.m.). Se copia la
-- de 19:00–24:00: son las dos bandas de menos tráfico y están pegadas. Queda
-- marcada con `asumida = true` para poder preguntarle y corregirla sin tocar
-- código. Mañana mismo hay llegadas a las 0:53 y 1:30.
--
-- LAS ZONAS SON DE ÉL, no nuestras: Fontibón, Porvenir, Sendai/San Antonio y
-- Marinilla. No coinciden con los sectores del catálogo (Norte/Sur/Sur-oeste/
-- Oriente/Llanogrande/Rosal) y NO se pueden deducir: los 41 conjuntos caben en
-- 2 km a la redonda, así que mover un ancla un kilómetro cambia treinta
-- asignaciones (el intento por geografía clasificó Arándanos de Fontibón como
-- zona Sendai, que es absurdo). Por eso `residences.zona_jefe` nace en NULL y
-- **mientras esté en NULL ese conjunto se comporta como antes**: la tabla no se
-- le aplica. Se llena desde el admin a medida que él responda.
--
-- Idempotente.

BEGIN;

-- ── 1. La zona del jefe, conjunto por conjunto ──────────────────────────────
ALTER TABLE public.residences
  ADD COLUMN IF NOT EXISTS zona_jefe text;

COMMENT ON COLUMN public.residences.zona_jefe IS
  'Zona de la tabla de tiempos de Julián: Fontibón · Porvenir · Sendai/San Antonio · Marinilla. NULL = todavía no la confirmó; ese conjunto se programa con el modelo calculado (OSRM), no con la tabla.';

-- ── 2. Tiempo total: del primero recogido a la llegada al aeropuerto ────────
-- Config de la operación, como app_settings: una sola tabla para toda la
-- organización, sin organization_id. Si algún día hay más de una, se agrega.
CREATE TABLE IF NOT EXISTS public.route_zone_times (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone            text     NOT NULL,
  band_from       smallint NOT NULL CHECK (band_from BETWEEN 0 AND 23),
  band_to         smallint NOT NULL CHECK (band_to   BETWEEN 1 AND 24),
  min_minutes     smallint NOT NULL CHECK (min_minutes BETWEEN 0 AND 240),
  max_minutes     smallint NOT NULL CHECK (max_minutes BETWEEN 0 AND 240),
  asumida         boolean  NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (max_minutes >= min_minutes),
  CHECK (band_to > band_from),
  UNIQUE (zone, band_from)
);

COMMENT ON TABLE public.route_zone_times IS
  'Tabla de tiempos de Julián (2026-08-16): minutos desde que se recoge al PRIMERO hasta llegar al aeropuerto, por zona y franja horaria de la presentación. El rango es por cantidad de gente: 1 → min, 2 → medio, 3+ → max.';
COMMENT ON COLUMN public.route_zone_times.asumida IS
  'true = la franja no la dictó él y la pusimos por analogía (hoy solo 00-02, copiada de 19-24). Sirve para saber qué falta confirmarle.';

-- ── 3. Tramo final: desde la ÚLTIMA persona recogida ────────────────────────
CREATE TABLE IF NOT EXISTS public.route_leg_times (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  band_from       smallint NOT NULL CHECK (band_from BETWEEN 0 AND 23),
  band_to         smallint NOT NULL CHECK (band_to   BETWEEN 1 AND 24),
  min_minutes     smallint NOT NULL CHECK (min_minutes BETWEEN 0 AND 240),
  max_minutes     smallint NOT NULL CHECK (max_minutes BETWEEN 0 AND 240),
  asumida         boolean  NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (max_minutes >= min_minutes),
  CHECK (band_to > band_from),
  UNIQUE (band_from)
);

COMMENT ON TABLE public.route_leg_times IS
  'Segunda regla de Julián: minutos del tramo final, desde la última persona recogida hasta el aeropuerto, por franja. En una vuelta de varias paradas este tramo tiene que caber dentro del total de route_zone_times.';

-- ── 4. Domingos y festivos ──────────────────────────────────────────────────
-- "Domingos y festivos no sacarlos tan temprano". No dio el número, así que
-- nace en 0 = sin corrimiento (comportamiento de hoy). Cuando lo diga, se
-- cambia desde Ajustes y no se toca código.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS route_holiday_shift_min integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.app_settings.route_holiday_shift_min IS
  'Minutos que se RECORTA la anticipación en domingos y festivos ("no sacarlos tan temprano"). Se resta del tiempo de la tabla de zonas. 0 = sin corrimiento, que es el comportamiento anterior. Pendiente de que Julián dé el número.';

-- Los festivos hay que tenerlos: en Colombia se corren al lunes (Ley Emiliani),
-- así que no se pueden calcular con una regla simple de fecha fija.
CREATE TABLE IF NOT EXISTS public.holidays (
  day             date PRIMARY KEY,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.holidays IS
  'Festivos colombianos (ya trasladados al lunes cuando aplica Ley Emiliani). Los domingos NO van aquí: se detectan por fecha.';

-- ── 5. Seed: la tabla tal como la dictó ─────────────────────────────────────
-- Franjas: 0-2 (asumida) · 2-6 · 6-9 · 9-12 · 12-19 · 19-24.
INSERT INTO public.route_zone_times (zone, band_from, band_to, min_minutes, max_minutes, asumida) VALUES
  ('Fontibón',            0,  2, 45, 45, true ),
  ('Fontibón',            2,  6, 40, 50, false),
  ('Fontibón',            6,  9, 60, 60, false),
  ('Fontibón',            9, 12, 50, 50, false),
  ('Fontibón',           12, 19, 50, 60, false),
  ('Fontibón',           19, 24, 45, 45, false),
  ('Porvenir',            0,  2, 40, 40, true ),
  ('Porvenir',            2,  6, 30, 40, false),
  ('Porvenir',            6,  9, 40, 50, false),
  ('Porvenir',            9, 12, 40, 40, false),
  ('Porvenir',           12, 19, 40, 50, false),
  ('Porvenir',           19, 24, 40, 40, false),
  ('Sendai/San Antonio',  0,  2, 40, 40, true ),
  ('Sendai/San Antonio',  2,  6, 40, 50, false),
  ('Sendai/San Antonio',  6,  9, 50, 60, false),
  ('Sendai/San Antonio',  9, 12, 40, 40, false),
  ('Sendai/San Antonio', 12, 19, 45, 55, false),
  ('Sendai/San Antonio', 19, 24, 40, 40, false),
  ('Marinilla',           0,  2, 60, 60, true ),
  ('Marinilla',           2,  6, 60, 60, false),
  ('Marinilla',           6,  9, 70, 70, false),
  ('Marinilla',           9, 12, 60, 60, false),
  ('Marinilla',          12, 19, 60, 70, false),
  ('Marinilla',          19, 24, 60, 60, false)
ON CONFLICT (zone, band_from) DO NOTHING;

INSERT INTO public.route_leg_times (band_from, band_to, min_minutes, max_minutes, asumida) VALUES
  ( 0,  2, 20, 20, true ),
  ( 2,  6, 15, 15, false),
  ( 6,  9, 35, 35, false),
  ( 9, 12, 20, 25, false),
  (12, 19, 25, 30, false),
  (19, 24, 20, 20, false)
ON CONFLICT (band_from) DO NOTHING;

-- Festivos de Colombia 2026-2027, ya trasladados al lunes donde aplica.
INSERT INTO public.holidays (day, name) VALUES
  ('2026-01-01', 'Año Nuevo'),
  ('2026-01-12', 'Reyes Magos'),
  ('2026-03-23', 'San José'),
  ('2026-04-02', 'Jueves Santo'),
  ('2026-04-03', 'Viernes Santo'),
  ('2026-05-01', 'Día del Trabajo'),
  ('2026-05-18', 'Ascensión del Señor'),
  ('2026-06-08', 'Corpus Christi'),
  ('2026-06-15', 'Sagrado Corazón'),
  ('2026-06-29', 'San Pedro y San Pablo'),
  ('2026-07-20', 'Día de la Independencia'),
  ('2026-08-07', 'Batalla de Boyacá'),
  ('2026-08-17', 'Asunción de la Virgen (trasladado)'),
  ('2026-10-12', 'Día de la Raza'),
  ('2026-11-02', 'Todos los Santos'),
  ('2026-11-16', 'Independencia de Cartagena'),
  ('2026-12-08', 'Inmaculada Concepción'),
  ('2026-12-25', 'Navidad'),
  ('2027-01-01', 'Año Nuevo'),
  ('2027-01-11', 'Reyes Magos'),
  ('2027-03-22', 'San José'),
  ('2027-03-25', 'Jueves Santo'),
  ('2027-03-26', 'Viernes Santo'),
  ('2027-05-01', 'Día del Trabajo'),
  ('2027-05-10', 'Ascensión del Señor'),
  ('2027-05-31', 'Corpus Christi'),
  ('2027-06-07', 'Sagrado Corazón'),
  ('2027-07-05', 'San Pedro y San Pablo'),
  ('2027-07-20', 'Día de la Independencia'),
  ('2027-08-07', 'Batalla de Boyacá'),
  ('2027-08-16', 'Asunción de la Virgen (trasladado)'),
  ('2027-10-18', 'Día de la Raza'),
  ('2027-11-01', 'Todos los Santos'),
  ('2027-11-15', 'Independencia de Cartagena'),
  ('2027-12-08', 'Inmaculada Concepción'),
  ('2027-12-25', 'Navidad')
ON CONFLICT (day) DO NOTHING;

-- ── 6. updated_at ───────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS tr_route_zone_times_set_updated_at ON public.route_zone_times;
CREATE TRIGGER tr_route_zone_times_set_updated_at BEFORE UPDATE ON public.route_zone_times
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS tr_route_leg_times_set_updated_at ON public.route_leg_times;
CREATE TRIGGER tr_route_leg_times_set_updated_at BEFORE UPDATE ON public.route_leg_times
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 7. RLS ──────────────────────────────────────────────────────────────────
-- Mismo patrón que app_settings (que es lo que estas tablas son: configuración
-- de la operación): lee cualquiera autenticado —el tablero las necesita para
-- programar—, escribe solo admin. El helper es `current_user_role()`, que es el
-- que usa el resto del esquema; `auth.user_role()` NO existe en esta base.
ALTER TABLE public.route_zone_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_leg_times  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_route_zone_times_select_all ON public.route_zone_times;
CREATE POLICY p_route_zone_times_select_all ON public.route_zone_times
  FOR SELECT USING (true);
DROP POLICY IF EXISTS p_route_zone_times_admin_all ON public.route_zone_times;
CREATE POLICY p_route_zone_times_admin_all ON public.route_zone_times
  FOR ALL USING (current_user_role() = 'admin') WITH CHECK (current_user_role() = 'admin');

DROP POLICY IF EXISTS p_route_leg_times_select_all ON public.route_leg_times;
CREATE POLICY p_route_leg_times_select_all ON public.route_leg_times
  FOR SELECT USING (true);
DROP POLICY IF EXISTS p_route_leg_times_admin_all ON public.route_leg_times;
CREATE POLICY p_route_leg_times_admin_all ON public.route_leg_times
  FOR ALL USING (current_user_role() = 'admin') WITH CHECK (current_user_role() = 'admin');

DROP POLICY IF EXISTS p_holidays_select_all ON public.holidays;
CREATE POLICY p_holidays_select_all ON public.holidays
  FOR SELECT USING (true);
DROP POLICY IF EXISTS p_holidays_admin_all ON public.holidays;
CREATE POLICY p_holidays_admin_all ON public.holidays
  FOR ALL USING (current_user_role() = 'admin') WITH CHECK (current_user_role() = 'admin');

COMMIT;
