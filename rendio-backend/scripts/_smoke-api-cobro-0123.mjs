// _smoke-api-cobro-0123.mjs — api-cobro.js › adminSettings / adminSaveSettings con el
// día de apertura (0123), contra un cliente de PRUEBA (nada sale a la red).
//   · Base con 0123: lee early_open_day y hasEarly = true.
//   · Base sin 0123 (columna inexistente, 42703): vuelve a leer sin ella, hasEarly
//     = false y la pantalla no muestra el campo.
//   · Guardar: manda early_open_day solo si la pantalla lo pasa (vacío = null).
//   cd rendio-backend && node scripts/_smoke-api-cobro-0123.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null ? ' → ' + d : '')); } };

function boot(conColumna) {
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }).window;
  const log = [];
  const tabla = (name) => {
    const qy = { cols: null, row: null };
    const api = {
      select(cols) { qy.cols = cols; return api; },
      upsert(row) { qy.row = row; log.push(['upsert', name, JSON.parse(JSON.stringify(row))]); return api; },
      async maybeSingle() {
        log.push(['select', name, qy.cols]);
        if (!conColumna && /early_open_day/.test(qy.cols)) return { data: null, error: { code: '42703', message: 'column billing_settings.early_open_day does not exist' } };
        return { data: { organization_id: 'org', due_days: 3, notice_days: 1, grace_days: 2, holder_name: null, holder_nit: null, updated_at: 'x', ...(conColumna ? { early_open_day: 21 } : {}) }, error: null };
      },
      async single() { return { data: qy.row, error: null }; },
    };
    return api;
  };
  w.sb = { from: tabla, rpc: async (fn) => ({ data: fn === 'current_user_org' ? 'org' : null, error: null }) };
  w.eval(readFileSync(APP + 'api-cobro.js', 'utf8'));
  return { A: w.ApiCobro, log };
}

{
  const { A, log } = boot(true);
  const s = await A.adminSettings();
  t('con 0123: earlyOpenDay 21 y hasEarly', s.earlyOpenDay === 21 && s.hasEarly === true && s.dueDays === 3, JSON.stringify(s));
  t('con 0123: una sola lectura', log.filter(x => x[0] === 'select').length === 1);
  await A.adminSaveSettings({ dueDays: 3, noticeDays: 1, graceDays: 2, earlyOpenDay: '' });
  const up = log.find(x => x[0] === 'upsert');
  t('guardar con earlyOpenDay vacío → early_open_day null (apagado)', up && 'early_open_day' in up[2] && up[2].early_open_day === null, JSON.stringify(up));
  await A.adminSaveSettings({ dueDays: 3, noticeDays: 1, graceDays: 2, earlyOpenDay: 21 });
  t('guardar con 21 → early_open_day 21', log.filter(x => x[0] === 'upsert').at(-1)[2].early_open_day === 21);
}
{
  const { A, log } = boot(false);
  const s = await A.adminSettings();
  t('sin 0123: no se rompe, hasEarly = false', s && s.hasEarly === false && s.earlyOpenDay === null && s.dueDays === 3, JSON.stringify(s));
  t('sin 0123: la segunda lectura va sin la columna', log.filter(x => x[0] === 'select').length === 2 && !/early_open_day/.test(log.filter(x => x[0] === 'select')[1][2]));
  await A.adminSaveSettings({ dueDays: 3, noticeDays: 1, graceDays: 2 });
  const up = log.find(x => x[0] === 'upsert');
  t('sin 0123: el guardado no manda early_open_day', up && !('early_open_day' in up[2]), JSON.stringify(up));
}
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubre: la base real (eso es _verify-0123.mjs) ni la pantalla (_smoke-admin-cobro-dom.mjs).');
process.exit(bad ? 1 : 0);
