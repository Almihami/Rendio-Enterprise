-- Down de 0013_profiles_can_coordinate
ALTER TABLE public.profiles DROP COLUMN IF EXISTS can_coordinate;
