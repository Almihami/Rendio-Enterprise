-- Down de 0030. (No se quita 'admin' del enum: Postgres no permite DROP de valor.)
DROP POLICY IF EXISTS p_inspection_photos_insert_admin ON public.inspection_photos;
