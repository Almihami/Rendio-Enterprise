-- Down de 0011_profiles_is_coordinator
ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_coordinator;
