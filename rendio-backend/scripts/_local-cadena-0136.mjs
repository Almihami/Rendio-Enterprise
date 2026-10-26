// Pone la base LOCAL al día hasta 0136 DENTRO de la transacción abierta (no queda
// nada: quien llama hace ROLLBACK). Las verificaciones 0137–0140 lo usan para
// arrancar desde lo que hoy tienen dev y producción.
//
//   import { cadenaHasta0136 } from './_local-cadena-0136.mjs';
//   await c.query('BEGIN'); await cadenaHasta0136(c); …; await c.query('ROLLBACK');
import fs from 'node:fs';

const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
export const migracion = (n) => strip(`../supabase/migrations/${n}.sql`);
export const reversa = (n) => strip(`../down_migrations/${n}.down.sql`);

export async function cadenaHasta0136(c) {
  const ok = async (sql) => (await c.query(`SELECT (${sql}) IS NOT NULL AS ok`)).rows[0].ok;
  if (!(await ok(`to_regprocedure('public.ops_alert_recipients_of(uuid)')`))) await c.query(migracion('0117_avisos_desde_el_servidor'));
  if (!(await ok(`to_regprocedure('public.hm12_bog(integer)')`))) {
    for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0127_aviso_sin_carro_espera',
      '0128_aviso_vuelta_terminada', '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre',
      '0132_carro_del_plan', '0133_pasajero_sin_cuenta', '0134_reubicar_al_cambiar', '0135_acomodar_eventualidades',
      '0136_aviso_vuelta_iniciada']) await c.query(migracion(m));
  }
}
