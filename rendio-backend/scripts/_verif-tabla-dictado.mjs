import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// Lo que dictó el 17-ago por WhatsApp (bloque "Día normal"), transcrito a mano.
const DICTADO = {
  'Fontibón':          {2:[40,50], 6:[60,60], 9:[50,50], 12:[50,60], 19:[45,45]},
  'Porvenir':          {2:[30,40], 6:[40,50], 9:[40,40], 12:[40,50], 19:[40,40]},
  'Sendai/San Antonio':{2:[40,50], 6:[50,60], 9:[40,40], 12:[45,55], 19:[40,40]},
  'Marinilla':         {2:[60,60], 6:[70,70], 9:[60,60], 12:[60,70], 19:[60,60]},
};
const LEG = {2:[15,15], 6:[35,35], 9:[20,25], 12:[25,30], 19:[20,20]};
const { data: z } = await sb.from('route_zone_times').select('*');
const { data: l } = await sb.from('route_leg_times').select('*');
let mal = 0;
for (const [zona, bandas] of Object.entries(DICTADO))
  for (const [bf, [mn, mx]] of Object.entries(bandas)) {
    const r = z.find(x => x.zone === zona && x.band_from === +bf);
    if (!r) { console.log(`FALTA  ${zona} ${bf}h`); mal++; continue; }
    if (r.min_minutes !== mn || r.max_minutes !== mx) {
      console.log(`DIFIERE ${zona} ${bf}h: BD ${r.min_minutes}/${r.max_minutes} vs dictado ${mn}/${mx}`); mal++;
    }
  }
for (const [bf, [mn, mx]] of Object.entries(LEG)) {
  const r = l.find(x => x.band_from === +bf);
  if (!r || r.min_minutes !== mn || r.max_minutes !== mx) {
    console.log(`DIFIERE tramo ${bf}h: BD ${r?.min_minutes}/${r?.max_minutes} vs dictado ${mn}/${mx}`); mal++;
  }
}
console.log(mal === 0 ? '✓ La tabla en dev coincide EXACTAMENTE con lo que dictó (20 celdas + 5 tramos).' : `✗ ${mal} diferencias`);
const asum = z.filter(x => x.asumida).concat(l.filter(x => x.asumida).map(x => ({zone:'(tramo)', band_from:x.band_from})));
console.log('\nSiguen marcadas como ASUMIDAS (no las dictó):');
for (const a of asum) console.log(`   ${a.zone} ${a.band_from}h`);
