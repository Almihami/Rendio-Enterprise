-- Down de 0012_profiles_priority
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_priority_range;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS priority;
