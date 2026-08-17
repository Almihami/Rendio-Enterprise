-- 0062_incident_categories_operacion.sql
--
-- Tres categorías nuevas de eventualidad para la operación de rutas.
--
-- POR QUÉ ESTA MIGRACIÓN VA SOLA Y NO PEGADA A LA 0063:
-- Postgres permite `ALTER TYPE ... ADD VALUE` dentro de una transacción (PG>=12,
-- y Supabase corre PG15), pero NO deja USAR el valor recién creado en esa misma
-- transacción. Y el script con que aplicamos a dev (scripts/_apply-sql-dev.mjs)
-- manda el archivo completo en un solo `client.query()`, que Postgres envuelve en
-- una transacción implícita. Es decir: si la 0063 añadiera el valor Y además
-- creara un índice parcial o un seed que lo mencione, el archivo entero
-- reventaría. Por eso el ADD VALUE vive aquí, solo, y todo lo que lo usa vive en
-- la 0063.
--
-- Las demás eventualidades que pidió la operación NO necesitan categoría nueva:
-- el enum de 0001 ya trae `vehicle_problem` (falla mecánica), `traffic` (trancón),
-- `wrong_address` (no encuentro la dirección), `flight_delay` / `flight_advanced`
-- (vuelo movido), `aux_not_ready` (el tripulante no bajó), `driver_late` (el carro
-- va atrasado) y `other`.

-- El tripulante aprieta el botón rojo: emergencia médica a bordo o algo que va a
-- retrasar el desembarque. Severidad alta, despierta a los jefes.
ALTER TYPE public.incident_category ADD VALUE IF NOT EXISTS 'aux_emergency';

-- Un tripulante llenó la reserva cuando el plan del día ya estaba publicado.
-- Se usa a partir del bloque D (reacomodo); aquí solo se declara para no tener
-- que volver a partir una migración en dos más adelante.
ALTER TYPE public.incident_category ADD VALUE IF NOT EXISTS 'late_booking';

-- Ningún carro alcanza: la etiqueta que pidió la operación, en vez de que el
-- sistema asigne solo a los jefes como conductores de refuerzo.
ALTER TYPE public.incident_category ADD VALUE IF NOT EXISTS 'needs_third_vehicle';
