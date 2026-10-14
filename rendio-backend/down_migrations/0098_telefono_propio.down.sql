-- DOWN de 0098 — Cada quien guarda su celular
--
-- Solo quita la función. Los celulares que ya se guardaron con ella se quedan en
-- profiles.phone (son datos de la persona, no de la migración), y las filas
-- 'phone_changed' de audit_events también: la bitácora no se reescribe.
-- Sin la función, la app guarda directo en profiles.phone (0081 lo permite) con
-- la misma validación del lado del teléfono (api-jefe.js · setMyPhone).

begin;

drop function if exists public.set_my_phone(text);

commit;
