CREATE OR REPLACE FUNCTION public.acomodo_frenado(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT count(*) >= coalesce((SELECT s.acomodo_max_nuevas FROM public.app_settings s WHERE s.id = 'singleton'), 4)
    FROM public.acomodo_creadas x
   WHERE x.organization_id = p_org AND x.created_at > now() - interval '30 minutes';
$function$
