-- Down 0149: quita admin_crew_aliases_save. Los apodos guardados se quedan (son de 0125).
BEGIN;
DROP FUNCTION IF EXISTS public.admin_crew_aliases_save(jsonb);
COMMIT;
