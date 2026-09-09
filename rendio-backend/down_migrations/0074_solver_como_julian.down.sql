-- Revierte 0074. La ventana de fusión vuelve a 30 (el valor con el que estaba
-- antes de medir sus correcciones del 20 y 21 de agosto).
update public.app_settings set route_merge_window_min = 30 where id = 'singleton' and route_merge_window_min = 20;
alter table public.app_settings drop column if exists route_car_priority;
alter table public.app_settings drop column if exists route_rescue_max_early_min;
alter table public.app_settings drop column if exists route_rescue_early;
alter table public.app_settings drop column if exists route_cars_count;
alter table public.app_settings drop column if exists route_max_early_min;
alter table public.app_settings drop column if exists route_sweep_slack_pct;
alter table public.app_settings drop column if exists route_sweep_tol_min;
