-- Revierte 0119. La app sigue funcionando sin la columna: getCurrentProfile
-- vuelve a pedir el perfil sin welcome_seen_at y la marca queda solo en el
-- teléfono, como antes.
begin;
drop function if exists public.mark_my_welcome_seen();
alter table public.profiles drop column if exists welcome_seen_at;
commit;
