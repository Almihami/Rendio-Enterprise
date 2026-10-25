-- 0119 — La bienvenida del tripulante se marca en la CUENTA, no en el teléfono (25-oct-2026)
--
-- POR QUÉ: la marca de «ya vio la bienvenida» vivía solo en el almacenamiento
-- del navegador (rendio.aux.onboarded.<id>). La profa reportó que a los
-- tripulantes les salía varias veces. Causa principal: en iPhone, Safari y la
-- app agregada al inicio NO comparten almacenamiento, y la propia bienvenida
-- le pide al de iPhone «Agregar a inicio… Abre Rendio desde el ícono»: la marca
-- quedaba en Safari y en el ícono la veía otra vez. Lo mismo al cambiar de
-- teléfono o de navegador, o cuando Safari borra los datos del sitio.
--
-- QUÉ HACE:
--   1. profiles.welcome_seen_at — cuándo la vio. Llega con el perfil
--      (Api.getCurrentProfile), sin consultas nuevas al entrar.
--   2. mark_my_welcome_seen() — la llama la app de quien la vio. SECURITY
--      DEFINER porque guard_profile_update (0081) solo deja al usuario cambiar
--      su teléfono y su foto; esta función solo toca ESTA columna, solo de
--      auth.uid(), y nunca la mueve si ya tenía fecha.
--   3. Los tripulantes que ya entraron alguna vez quedan marcados: la
--      bienvenida sale al primer ingreso (después del registro), así que ya la
--      vieron. Se les pone la fecha en que se crearon. Así a ellos tampoco les
--      vuelve a salir al instalar la app en el iPhone. Quien quiera verla otra
--      vez la tiene en Perfil › «Ver la bienvenida».
--
-- LO QUE NO HACE: no cambia nada del registro ni de los permisos de perfiles.
--
-- DOWN: down_migrations/0119_bienvenida_por_cuenta.down.sql.

begin;

alter table public.profiles add column if not exists welcome_seen_at timestamptz;

comment on column public.profiles.welcome_seen_at is
  'Cuándo vio la bienvenida del tripulante (0119). Null = todavía no. Lo pone mark_my_welcome_seen().';

create or replace function public.mark_my_welcome_seen()
returns timestamptz
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.profiles
     set welcome_seen_at = coalesce(welcome_seen_at, now())
   where id = auth.uid()
  returning welcome_seen_at;
$$;

comment on function public.mark_my_welcome_seen() is
  'La app marca que quien llama ya vio la bienvenida (0119). Solo toca welcome_seen_at de auth.uid(); si ya tenía fecha, la deja.';

revoke all on function public.mark_my_welcome_seen() from public, anon;
grant execute on function public.mark_my_welcome_seen() to authenticated;

-- Los que ya entraron alguna vez: ya la vieron.
update public.profiles p
   set welcome_seen_at = p.created_at
  from auth.users u
 where u.id = p.id
   and p.role = 'auxiliar'
   and p.welcome_seen_at is null
   and u.last_sign_in_at is not null;

commit;
