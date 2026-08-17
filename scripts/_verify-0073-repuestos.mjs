import pg from 'pg';
const ref=process.env.SUPABASE_PROJECT_REF;
const c=new pg.Client({host:'aws-1-us-east-1.pooler.supabase.com',port:5432,user:'postgres.'+ref,password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}});
await c.connect();
let ok=0,bad=0;
const chk=async(name,sql,test)=>{try{const r=await c.query(sql);const p=test(r.rows);console.log((p?'✓':'✗')+' '+name+(p?'':' → '+JSON.stringify(r.rows).slice(0,200)));p?ok++:bad++;}catch(e){console.log('✗ '+name+' ERROR '+e.message);bad++;}};

await chk('catálogo: 25 repuestos',`select count(*) n from part_catalog`,r=>+r[0].n===25);
await chk('críticos: 6 (frenos+llantas+correa)',`select count(*) n from part_catalog where is_critical`,r=>+r[0].n===6);
await chk('líquido de frenos vence por 18 meses',`select interval_months from part_catalog where code='liq-fre'`,r=>r[0].interval_months===18);
await chk('4 niveles preventivos',`select count(*) n from inspection_tiers`,r=>+r[0].n===4);
await chk('14 ítems de checklist por nivel',`select count(*) n from inspection_checklist_items where tier_every_km is not null`,r=>+r[0].n===14);
await chk('semáforo: 3 carros × 25 = 75 filas',`select count(*) n from v_vehicle_part_status`,r=>+r[0].n===75);
await chk('ningún carro bloqueado',`select count(*) n from vehicles where status='blocked' and deleted_at is null`,r=>+r[0].n===0);
await chk('el trigger de cierre ya no bloquea',`select prosrc from pg_proc where proname='shifts_close_block_vehicle'`,r=>!/blocked/.test(r[0].prosrc));
await chk('RPCs creadas',`select count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('set_vehicle_part_baseline','register_part_change','confirm_part_change','correct_vehicle_odometer','set_part_interval','pending_inspection_tiers','mark_inspection_tiers_done')`,r=>+r[0].n===7);
console.log(`\n${ok} ok · ${bad} fallos`);
await c.end(); process.exit(bad?1:0);
