-- =============================================================================
-- 0180 · Anuncios que salen UNA sola vez por cuenta
-- =============================================================================
-- 26-nov-2026. Harold: «solo sale una vez por usuario, o sea lo abren hoy y ya
-- mañana no les sale y no pueden volverlo a ver».
--
-- Para qué: el popup de expectativa de Navidad («Esta Navidad Rendio te premia ·
-- Próximamente») le sale a cada tripulante una sola vez. Después vendrá el anuncio
-- del sorteo, que usa lo mismo con otra clave.
--
-- POR QUÉ EN LA CUENTA y no en el teléfono: es la lección de 0119 (la bienvenida).
-- En iPhone, Safari y el ícono del inicio NO comparten almacenamiento; lo mismo al
-- cambiar de teléfono o cuando el navegador borra los datos del sitio. Con la marca
-- solo en el teléfono el anuncio «de una sola vez» les saldría varias.
--
-- QUÉ HACE:
--   1. profiles.announcements_seen (jsonb) — { "<clave del anuncio>": "<cuándo lo vio>" }.
--      Llega con el perfil (Api.getCurrentProfile), sin consultas nuevas al entrar.
--   2. mark_my_announcement_seen(clave) — la llama la app de quien lo vio, en el
--      momento en que el anuncio aparece. SECURITY DEFINER porque el candado de
--      perfiles (guard_profile_update, 0081) solo deja al usuario cambiar su
--      teléfono y su foto. Solo toca ESTA columna, solo de auth.uid(), y nunca
--      mueve la fecha de una clave que ya estaba. Devuelve la lista como quedó.
--      La clave va en minúsculas, números y guiones (3 a 40); tope de 50 claves
--      por cuenta para que nadie la infle a mano.
--
-- Nadie queda marcado de entrada: el anuncio es nuevo para todos.
--
-- LO QUE NO HACE: no cambia permisos de perfiles ni ninguna otra columna.
--
-- Deshacer: down_migrations/0180_anuncios_vistos.down.sql.
-- =============================================================================

begin;

alter table public.profiles
  add column if not exists announcements_seen jsonb not null default '{}'::jsonb;

comment on column public.profiles.announcements_seen is
  'Anuncios de una sola vez que la cuenta ya vio (0180): { clave: fecha }. Lo llena mark_my_announcement_seen().';

create or replace function public.mark_my_announcement_seen(p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if p_key is null or p_key !~ '^[a-z0-9][a-z0-9-]{2,39}$' then
    raise exception 'Clave de anuncio no válida' using errcode = '22023';
  end if;

  update public.profiles
     set announcements_seen =
           case
             when coalesce(announcements_seen, '{}'::jsonb) ? p_key then announcements_seen
             when (select count(*) from jsonb_object_keys(coalesce(announcements_seen, '{}'::jsonb))) >= 50 then announcements_seen
             else coalesce(announcements_seen, '{}'::jsonb) || jsonb_build_object(p_key, to_jsonb(now()))
           end
   where id = auth.uid()
  returning announcements_seen into v;

  return v;
end;
$$;

comment on function public.mark_my_announcement_seen(text) is
  'La app marca que quien llama ya vio un anuncio de una sola vez (0180). Solo toca announcements_seen de auth.uid(); si la clave ya estaba, deja su fecha.';

revoke all on function public.mark_my_announcement_seen(text) from public, anon;
grant execute on function public.mark_my_announcement_seen(text) to authenticated;

commit;
