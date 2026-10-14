-- DOWN de 0104 — «Olvidé mi contraseña»: un pedido a Coordinación
--
-- Quita la función del login, el trigger sobre la bitácora y la tabla de
-- pedidos (con sus políticas y triggers). Los avisos ya encolados en
-- notification_outbox se quedan: son de la bandeja, no de esta migración, y
-- apuntan a Usuarios, que sigue existiendo. Sin la función, el login muestra el
-- error de siempre al pedir y la persona sigue con «escríbele a tu coordinador».

begin;

drop trigger if exists tr_audit_events_resolve_password_reset on public.audit_events;
drop function if exists public.resolve_password_reset_on_audit();
drop function if exists public.request_password_reset(text);
drop table if exists public.password_reset_requests;
drop function if exists public.password_reset_requests_stamp();

commit;
