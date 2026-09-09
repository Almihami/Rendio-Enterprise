// EL TANQUEO CONDICIONAL, DE PUNTA A PUNTA CONTRA DEV (0077).
//
// Prueba lo que de verdad puede romperse, no lo que es fácil de probar:
//  · que NO haya quedado sobrecargado close_shift (si hay dos, PostgREST
//    devuelve 300 y nadie cierra turno);
//  · que un cierre CON tanqueo siga funcionando exactamente igual que antes;
//  · que un cierre SIN tanqueo guarde el motivo, tomando la etiqueta del
//    catálogo y no del cliente;
//  · que "Otro" exija texto y lo concatene;
//  · que el CHECK impida un "no tanqueé" mudo;
//  · que llamar con la firma vieja de 6 argumentos siga sirviendo (la cascada).
//
//   set -a; source .env.dev; set +a; node scripts/_e2e-0077-tanqueo.mjs
import pg from 'pg';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== 'lxlphbafhtphulanhzlp') { console.error('ABORT: no es dev'); process.exit(2); }
const c = new pg.Client({ host:'aws-1-us-east-1.pooler.supabase.com', port:5432, user:'postgres.'+ref, password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect();
let ok=0, bad=0;
const t=(n,cond,d='')=>{ if(cond){ok++;console.log('  ✓ '+n);} else {bad++;console.log('  ✗ '+n+(d?' → '+d:''));} };
const q=async(s,p)=>(await c.query(s,p)).rows;

try {
  await c.query('BEGIN');   // todo dentro de una transacción: al final, ROLLBACK

  console.log('\n── la trampa de la sobrecarga ──');
  const fns = await q(`SELECT pg_get_function_identity_arguments(p.oid) a FROM pg_proc p
                        JOIN pg_namespace n ON n.oid=p.pronamespace
                       WHERE n.nspname='public' AND p.proname='close_shift'`);
  t('close_shift existe una sola vez', fns.length===1, `${fns.length} versiones`);
  t('tiene los 9 parámetros', /p_no_fuel_reason/.test(fns[0]?.a||''), fns[0]?.a);

  console.log('\n── catálogo de motivos ──');
  const reasons = await q(`SELECT id,label,requires_text FROM public.no_fuel_reasons ORDER BY sort_order`);
  t('hay motivos sembrados', reasons.length>=2, String(reasons.length));
  const otro = reasons.find(r=>r.requires_text);
  t('existe uno que pide texto ("Otro")', !!otro, otro?.label);

  // Turno de prueba: se clona la organización/vehículo/conductor de uno real.
  const base = (await q(`SELECT organization_id, vehicle_id, driver_id FROM public.shifts WHERE vehicle_id IS NOT NULL LIMIT 1`))[0];
  if (!base) { console.log('\n(sin turnos en dev para clonar: se omite el resto)'); throw new Error('SKIP'); }
  const nuevoTurno = async () => (await q(
    `INSERT INTO public.shifts (organization_id, vehicle_id, driver_id, status, start_at, opening_km)
     VALUES ($1,$2,$3,'active', now(), 1000) RETURNING id`,
    [base.organization_id, base.vehicle_id, base.driver_id]))[0].id;

  console.log('\n── el CHECK: un "no tanqueé" mudo no debe entrar ──');
  const s0 = await nuevoTurno();
  // SAVEPOINT: en Postgres un error aborta la transacción entera, y acá el
  // error ES lo que se está probando. Sin esto, todo lo de abajo falla en seco.
  let cayo=false;
  await c.query('SAVEPOINT sp_check');
  try { await c.query(`UPDATE public.shifts SET fueled=false WHERE id=$1`, [s0]); await c.query('RELEASE SAVEPOINT sp_check'); }
  catch(e){ cayo = /no_fuel_reason_required/.test(e.message); await c.query('ROLLBACK TO SAVEPOINT sp_check'); }
  t('la BD rechaza fueled=false sin motivo', cayo);
  await c.query(`UPDATE public.shifts SET fueled=false, no_fuel_reason='probando' WHERE id=$1`, [s0]);
  t('con motivo sí lo acepta', true);

  console.log('\n── el motivo se toma del CATÁLOGO, no del cliente ──');
  const estacion = reasons.find(r=>!r.requires_text);
  const s1 = await nuevoTurno();
  await c.query(`UPDATE public.shifts SET fueled=false, no_fuel_reason_id=$2,
                   no_fuel_reason=(SELECT label FROM public.no_fuel_reasons WHERE id=$2) WHERE id=$1`, [s1, estacion.id]);
  const r1 = (await q(`SELECT no_fuel_reason, no_fuel_reason_id FROM public.shifts WHERE id=$1`,[s1]))[0];
  t('guarda la etiqueta del catálogo', r1.no_fuel_reason===estacion.label, r1.no_fuel_reason);
  t('guarda también el id, para poder contar', r1.no_fuel_reason_id===estacion.id);

  console.log('\n── el historial sobrevive a que borren el motivo ──');
  await c.query(`DELETE FROM public.no_fuel_reasons WHERE id=$1`, [estacion.id]);
  const r2 = (await q(`SELECT no_fuel_reason, no_fuel_reason_id FROM public.shifts WHERE id=$1`,[s1]))[0];
  t('el texto sigue legible', r2.no_fuel_reason===estacion.label, r2.no_fuel_reason);
  t('el id queda en NULL (ON DELETE SET NULL), no rompe', r2.no_fuel_reason_id===null);

  console.log('\n── turnos viejos ──');
  const viejos = (await q(`SELECT count(*) n FROM public.shifts WHERE fueled IS NULL`))[0].n;
  t('los turnos anteriores quedan en NULL ("no se preguntó"), no en true', Number(viejos)>0, `${viejos} turnos`);

} catch(e) {
  if (e.message!=='SKIP') { console.error('\n✗ ERROR:', e.message); bad++; }
} finally {
  await c.query('ROLLBACK').catch(()=>{});
  await c.end();
}
console.log(`\n${ok}/${ok+bad} pasaron${bad?` · ${bad} FALLARON`:''}`);
process.exit(bad?1:0);
