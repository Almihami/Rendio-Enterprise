-- Deshace 0181 (tienda de pines).
-- Ojo: se pierden las reservas, el inventario y los ajustes de la tienda. La app
-- aguanta sin esto: al tripulante no le sale la tarjeta de Pines y al jefe la
-- pantalla le dice que falta la migración.
-- El bucket `pins` NO se borra aquí: si tiene imágenes, se vacía y se quita
-- desde el panel de Storage.

BEGIN;

DROP POLICY IF EXISTS p_pins_insert_admin ON storage.objects;
DROP POLICY IF EXISTS p_pins_delete_admin ON storage.objects;

DROP FUNCTION IF EXISTS public.admin_pins_set_reservation(uuid, text, text);
DROP FUNCTION IF EXISTS public.admin_pins_save_product(jsonb);
DROP FUNCTION IF EXISTS public.admin_pins_save_settings(jsonb);
DROP FUNCTION IF EXISTS public.admin_pins_mark_seen();
DROP FUNCTION IF EXISTS public.admin_pins_counts();
DROP FUNCTION IF EXISTS public.admin_pins_overview();
DROP FUNCTION IF EXISTS public.aux_pins_my_reservations();
DROP FUNCTION IF EXISTS public.aux_pins_reserve(jsonb);
DROP FUNCTION IF EXISTS public.aux_pins_store();
DROP FUNCTION IF EXISTS public.pin_reservation_json(uuid);
DROP FUNCTION IF EXISTS public.pin_product_json(uuid);
DROP FUNCTION IF EXISTS public.pin_counts_json(uuid);
DROP FUNCTION IF EXISTS public.pin_settings_json(uuid);
DROP FUNCTION IF EXISTS public.pin_admin_org();
DROP FUNCTION IF EXISTS public.pin_total(integer, integer, boolean, integer, integer);
DROP FUNCTION IF EXISTS public.pin_money(integer);

DROP TABLE IF EXISTS public.pin_reservation_items;
DROP TABLE IF EXISTS public.pin_reservations;
DROP TABLE IF EXISTS public.pin_products;
DROP TABLE IF EXISTS public.pin_store_settings;

NOTIFY pgrst, 'reload schema';

COMMIT;
