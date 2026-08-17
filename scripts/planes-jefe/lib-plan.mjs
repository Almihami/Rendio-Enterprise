// Lector de los mensajes de WhatsApp del jefe. UNA sola implementación, usada por
// analizar-plan-jefe.mjs (una vuelta a la vez) y reglas-jefe.mjs (estadística de
// varios mensajes). Si el jefe escribe algo nuevo, se tolera ACÁ, no en cada script.
//
// La spec del formato está en FORMATO.md, al lado de este archivo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ── texto ───────────────────────────────────────────────────────────────────
export const norm = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// "amarillas" y "amarillo" tienen que caer en el mismo cubo: el jefe escribe el
// género y el número que le salen. Corta plural y vocal final.
const raiz = (p) => p.replace(/s$/, '').replace(/[aoe]$/, '');

const lev = (a, b) => {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
};

// ── catálogo ────────────────────────────────────────────────────────────────
// Devuelve { buscar } donde buscar(txt) = { nombre, lat, lon, via } | null,
// y marca `ambiguo` cuando dos conjuntos empatan (ej. "Campo" = Torres del Campo
// o Campo Santander) en vez de elegir uno en silencio y mentir con la coordenada.
export function catalogo(filas) {
  const K = Object.keys(filas[0] || {});
  const nameK = K.find((c) => /^name$|nombre/.test(c)) || K.find((c) => /name/.test(c));
  const latK = K.find((c) => /lat/.test(c));
  const lonK = K.find((c) => /lon|lng/.test(c));
  const CAT = filas.map((r) => {
    const n = norm(r[nameK]);
    return {
      nombre: r[nameK], n, compacto: n.replace(/ /g, ''),
      raices: new Set(n.split(' ').filter((p) => p.length >= 4).map(raiz)),
      lat: r[latK], lon: r[lonK], sector: r.sector, id: r.id,
    };
  });

  const cache = new Map();
  function buscar(txt) {
    const t = norm(txt);
    if (!t) return null;
    if (cache.has(t)) return cache.get(t);
    const r = _buscar(t);
    cache.set(t, r);
    return r;
  }

  function _buscar(t) {
    const exacto = CAT.find((c) => c.n === t);
    if (exacto) return exacto;

    const raices = new Set(t.split(' ').filter((p) => p.length >= 4).map(raiz));
    const compacto = t.replace(/ /g, '');

    const puntuado = CAT.map((c) => {
      let s = 0;
      for (const r of raices) if (c.raices.has(r)) s += 2;         // palabra fuerte compartida
      if (s === 0 && (c.compacto.includes(compacto) || compacto.includes(c.compacto))) s = 1;
      // Desempate: "Bosques" es Bosques del Norte, no Urb. Bosque Robledal.
      if (s > 0 && c.n.startsWith(t)) s += 1;
      // dedazo pegado: "Rionvivo" por "Río vivo"
      if (s === 0 && compacto.length >= 5 && lev(compacto, c.compacto) <= 2) s = 1;
      return { c, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);

    if (!puntuado.length) return null;
    const mejor = puntuado[0];
    const empate = puntuado.filter((x) => x.s === mejor.s);
    if (empate.length > 1) return { ...mejor.c, ambiguo: empate.map((x) => x.c.nombre) };
    return mejor.c;
  }

  return { CAT, buscar };
}

// ── parser ──────────────────────────────────────────────────────────────────
// El mensaje está escrito a mano en el teléfono. Todo lo que se tolera acá salió
// de un dedazo real, no de imaginar casos.
const HORA = /^(\d{1,2})\s*[:.;\/]{1,2}\s*(\d{2})\s*(.*)$/;
// "Deben estar 3:40" · "Estar 10:40" · "Estar 11:20 y hotel" · "Estar hotel y aero
// 11:20" · dedazos "Dstad 12:40" y "Eestar 20:40".
const DEADLINE = /(?:d?e{0,2}sta[rd]|deben?\s+estar)\b/i;
const ALGUNA_HORA = /(\d{1,2})\s*[:.;\/]{1,2}\s*(\d{2})/;

export const min = (h, m) => h * 60 + m;
export const hm = (t) => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(((t % 60) + 60) % 60).padStart(2, '0')}`;

function lugarDe(resto) {
  // Cierra los paréntesis que el jefe deja abiertos: "(Sann(", "(Río vivo!",
  // "(Av9717", "(Aero(".
  const cerrado = resto.match(/\(([^)]*)\)/);
  if (cerrado) return { lugar: cerrado[1].trim().replace(/[(!¡]+$/, ''), sinParentesis: resto.replace(/\([^)]*\)/g, '') };
  const abierto = resto.match(/\(([^)]*)$/);
  if (abierto) return { lugar: abierto[1].trim().replace(/[(!¡]+$/, ''), sinParentesis: resto.replace(/\(.*$/, '') };
  return { lugar: '', sinParentesis: resto };
}

export function parsePlan(txt) {
  const vueltas = [];
  let cur = { paradas: [], notas: [] };
  const cerrar = () => {
    if (cur.paradas.length || cur.notas.length) vueltas.push(cur);
    cur = { paradas: [], notas: [] };
  };

  for (const raw of txt.split('\n')) {
    const l = raw.trim();
    if (!l) { cerrar(); continue; }

    const h = l.match(HORA);
    // Una línea que empieza por hora es una parada; el deadline nunca empieza por hora.
    if (h) {
      const { lugar, sinParentesis } = lugarDe(h[3]);
      // Ojo: recortar la "y" suelta que queda al quitar el paréntesis ("pacho y León (…)"),
      // sin comerse la última letra de un nombre ("margy").
      const quien = sinParentesis.trim().replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+y$/i, '').trim();
      const vuelo = /^(av|ja|jec|p5|p)\s*\d/i.test(lugar) ? lugar.replace(/\s+/g, '').toUpperCase() : null;
      cur.paradas.push({
        t: min(+h[1], +h[2]), quien, lugar, vuelo,
        hotel: /hotel/i.test(lugar),
        aero: /^aero/i.test(lugar),
        personas: (quien.match(/\s+y\s+|,/g) || []).length + 1,
      });
      continue;
    }

    if (DEADLINE.test(l)) {
      const d = l.match(ALGUNA_HORA);
      if (d) cur.deadline = min(+d[1], +d[2]);
      if (/hotel/i.test(l)) cur.hotel = true;
      if (/aero/i.test(l)) cur.aero = true;
      cur.notas.push(l);
      continue;
    }

    if (/^va[n]?\s+a\s+hotel/i.test(l)) { cur.soloHotel = true; cur.hotel = true; }
    cur.notas.push(l);
  }
  cerrar();

  for (const v of vueltas) {
    v.paradas.sort((a, b) => a.t - b.t);
    v.pax = v.paradas.reduce((s, p) => s + p.personas, 0);
    v.esLlegada = v.paradas.some((p) => p.vuelo);
    v.tipo = v.esLlegada ? 'llegada' : v.soloHotel ? 'hotel' : v.deadline != null ? 'salida' : 'sin-deadline';
  }
  return vueltas;
}

export const leerPlan = (dir, archivo) => parsePlan(readFileSync(`${dir}/${archivo}`, 'utf8'));

// ── OSRM con caché en disco ─────────────────────────────────────────────────
// El router público es lento y siempre le preguntamos por los mismos 41 puntos.
const CACHE = new URL('./.osrm-cache.json', import.meta.url).pathname;
const _mem = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let _sucio = false;

export async function osrmMin(a, b) {
  if (!a?.lat || !b?.lat) return null;
  const k = `${a.lat},${a.lon}|${b.lat},${b.lon}`;
  if (k in _mem) return _mem[k];
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  let v = null;
  try {
    const j = await (await fetch(url)).json();
    if (j.code === 'Ok') v = j.routes[0].duration / 60;
  } catch { v = null; }
  if (v != null) { _mem[k] = v; _sucio = true; }
  return v;
}

export const guardarCache = () => { if (_sucio) writeFileSync(CACHE, JSON.stringify(_mem)); };
