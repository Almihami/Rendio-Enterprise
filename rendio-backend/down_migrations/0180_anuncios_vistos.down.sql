-- Deshace 0180 (anuncios de una sola vez por cuenta).
-- Ojo: al quitar la columna se pierde quién ya vio cada anuncio; si el anuncio
-- sigue encendido en la app, les volvería a salir (la app aguanta sin la columna:
-- se queda con la marca del teléfono).

begin;

drop function if exists public.mark_my_announcement_seen(text);
alter table public.profiles drop column if exists announcements_seen;

commit;
