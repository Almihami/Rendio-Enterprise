-- Deshace 0156: quita «Eliminar mi cuenta». Las cuentas que ya se eliminaron
-- siguen eliminadas (un jefe las restaura desde Personal / Tripulantes).
begin;
drop function if exists public.delete_my_account();
commit;
