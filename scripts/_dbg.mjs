import { createClient } from '@supabase/supabase-js';
import { catalogo } from './planes-jefe/lib-plan.mjs';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const { data: resid } = await sb.from('residences').select('*');
const { buscar } = catalogo(resid||[]);
for (const q of ['Edificio Ébano','El Llanito','Ébano Apartamentos','Llanito','Quintas','Riovivo','Cambulo','Origen','Boral','Planté','Senderos San Sebastián','Primera','Alto Vallejo','Viverdi','Manzanillos','Torres del campo','Bosques del norte','Olivar','Cerezos','Piedemonte','Solare','Arándanos de fontibon','Quintas amarillas','Quintas Blancas']) {
  const r = buscar(q);
  console.log(String(q).padEnd(26), r ? (r.ambiguo ? '⚠ AMBIGUO → ' + r.ambiguo.join(' | ') : r.nombre) : '✗ no está');
}
