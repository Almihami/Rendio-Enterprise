// admin-ruta-julian.js — Rutas del día › La ruta de Julián (0125, 25-oct-2026).
//
// LA ESTRATEGIA DEL JEFE (Camilo, 25-oct-2026, 11:04 p. m.), con las respuestas de
// la dueña (vuelta completa, se puede soltar, aviso si nadie la toma, se pega):
//   1. Los tripulantes piden todo por la app.
//   2. Julián descarga el Excel del día («Excel del día»: la hoja RESPUESTAS con las
//      columnas del Formulario + conjunto, sector y teléfono) y arma la ruta a mano.
//   3. La pega aquí: el MISMO mensaje que manda al grupo (scripts/planes-jefe/
//      FORMATO.md). Se lee, se empareja cada nombre con los pedidos del día y se
//      publica: a cada tripulante le llega su hora de recogida.
//   4. El sistema no asigna: los conductores toman cada vuelta (un bloque del
//      WhatsApp = un carro) en su app (driver-rutas.js).
//
// EMPAREJAR. Julián escribe apodos («Karol L», «cano», «Lau idarraga») y a veces
// varios en una línea («Juanita y Pacho»). Cada persona se compara contra los
// pedidos del día (más la madrugada siguiente): el apodo aprendido manda; si no, el
// nombre, el vuelo, la hora y el conjunto. Lo que no queda claro lo elige Julián en
// una lista, y lo que elige se aprende (crew_aliases) para la próxima vez. Quien
// no pidió por la app (un familiar, alguien sin cuenta) no se avisa.
//
// Contrato (todo con guarda): window.RendioRutaJulian = { abrir(), excel(),
//   diaHTML(vueltas, dia), _leer(texto, dia), _emparejar(personas, candidatos, apodos), _st }.
// Lo usa admin-rutas-v2.js (botones «Ruta de Julián» y «Excel del día», y la vista
// del día cuando ya hay una ruta pegada).
(function () {
  'use strict';
  const W = window;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const pad = (n) => String(n).padStart(2, '0');
  const hmTxt = (m) => `${Math.floor(((m % 1440) + 1440) % 1440 / 60)}:${pad(((m % 60) + 60) % 60)}`;
  const toMin = (hm) => { const x = /^(\d{1,2}):(\d{2})/.exec(hm || ''); return x ? (+x[1]) * 60 + (+x[2]) : null; };
  const sumarDia = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const isoDe = (dia, min) => `${dia}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00-05:00`;
  const bogHM = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(/^0/, ''); } catch (_) { return ''; } };
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const diaTxt = (d) => { const x = new Date(d + 'T12:00:00Z'); return `${DIAS[x.getUTCDay()]} ${x.getUTCDate()} ${MES[x.getUTCMonth()]}`; };
  const LS = (dia) => 'rendio.rutaJulian.' + dia;

  // ── 1. Leer el WhatsApp ─────────────────────────────────────────────────────
  // Tolera los mismos dedazos que el lector de los planes del backend
  // (scripts/planes-jefe/lib-plan.mjs), que salieron de mensajes reales: «18;35»,
  // «10/55», «Deben estar 3:40», «Deben 15:30», «Estar hotel y aero 11:20»,
  // «Dstad 12:40», «Eestar 20:40», «Estás 4:50», paréntesis sin cerrar «(Av9717».
  const RE_HORA = /^(\d{1,2})\s*[:.;,\/h]{1,2}\s*(\d{2})(?!\d)\s*(.*)$/i;
  const RE_DEAD = /^(?:deben?\b|d?e{0,2}st[aáe][a-zá]*)/i;
  const RE_ALGUNA = /(\d{1,2})\s*[:.;,\/]{1,2}\s*(\d{2})(?!\d)/;
  function lugarDe(resto) {
    const cerrado = /\(([^)]*)\)/.exec(resto);
    if (cerrado) return { lugar: cerrado[1].trim().replace(/[(!¡]+$/, ''), quien: resto.replace(/\([^)]*\)/g, ' ') };
    const abierto = /\(([^)]*)$/.exec(resto);
    if (abierto) return { lugar: abierto[1].trim().replace(/[(!¡]+$/, ''), quien: resto.replace(/\(.*$/, ' ') };
    return { lugar: '', quien: resto };
  }
  const RE_VUELO = /^(av|ja|jec|p5|p|la|lan|wg|vh)\s*-?\s*(\d{2,5})$/i;
  function vueloDe(lugar) {
    const m = RE_VUELO.exec(String(lugar || '').replace(/\s+/g, ' ').trim());
    if (!m) return null;
    let pre = m[1].toUpperCase();
    if (pre === 'P') pre = 'P5';
    return pre + m[2];
  }
  // «Juanita y Pacho», «Erika, Jolene y Juanita» → una por persona.
  const personas = (quien) => String(quien || '').split(/\s*,\s*|\s+y\s+|\s*&\s*/i).map((x) => x.trim()).filter(Boolean);

  function leer(texto, dia) {
    const bloques = [];
    let cur = null;
    const cerrar = () => { if (cur && (cur.lineas.length || cur.notas.length)) bloques.push(cur); cur = null; };
    const raras = [];
    let vioTarde = false;
    for (const raw of String(texto || '').split(/\r?\n/)) {
      const l = raw.replace(/‎|‏/g, '').trim();
      if (!l) { cerrar(); continue; }
      if (!cur) cur = { lineas: [], deadline: null, notas: [] };
      // Una línea que empieza por hora es una recogida; el «Deben estar» nunca
      // empieza por hora.
      const h = RE_HORA.exec(l);
      if (h && +h[1] <= 23 && +h[2] <= 59) {
        const ld = lugarDe(h[3] || '');
        const lugar = ld.lugar;
        const quien = ld.quien.trim().replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+y$/i, '').trim();
        if (!quien) { raras.push(l); continue; }
        const min = (+h[1]) * 60 + (+h[2]);
        // Madrugada: una hora antes de las 4 a. m. DESPUÉS de una de la tarde es del
        // día siguiente (los turnos van de 2 a 2).
        const dd = (min < 240 && vioTarde) ? sumarDia(dia, 1) : dia;
        if (min >= 720) vioTarde = true;
        cur.lineas.push({ min, dia: dd, quien, lugar, vuelo: vueloDe(lugar), personas: personas(quien), texto: l });
        continue;
      }
      const d = RE_DEAD.test(l) ? RE_ALGUNA.exec(l) : null;
      if (d && +d[1] <= 23 && +d[2] <= 59) {
        cur.deadline = { min: (+d[1]) * 60 + (+d[2]) };
        const resto = l.replace(RE_ALGUNA, ' ').replace(/^\s*(?:deben?\s+)?(?:d?e{0,2}st[aáe][a-zá]*)?\s*/i, '').replace(/\s+/g, ' ').trim();
        if (resto) cur.notas.push(resto);
        continue;
      }
      cur.notas.push(l);
    }
    cerrar();
    bloques.forEach((b) => {
      if (!b.deadline) return;
      const l0 = b.lineas[0], lN = b.lineas[b.lineas.length - 1];
      b.deadline.dia = l0 ? l0.dia : dia;
      if (!l0) return;
      // El «Deben estar» va el día de la primera recogida; al siguiente solo si
      // cruza la medianoche (23:40 → «Deben estar 0:20»). Si queda antes de la
      // última recogida es un dedazo («Deben estar 10:20» con recogidas 10:40–10:55):
      // se avisa y no se usa.
      let dl = b.deadline.min;
      if (dl < l0.min && l0.min - dl > 600) { dl += 1440; b.deadline.dia = sumarDia(l0.dia, 1); }
      const ultima = (lN.dia === l0.dia ? 0 : 1440) + lN.min;
      if (dl < ultima) b.deadline.mala = true;
    });
    return { bloques: bloques.filter((b) => b.lineas.length), raras };
  }

  // ── 2. Emparejar ────────────────────────────────────────────────────────────
  // candidato: { rid, auxId, n, type: 'sal'|'lle', dia, dl: 'HH:MM', vuelo, zona, sector }
  function puntaje(p, c, apodos) {
    const np = norm(p.nombre);
    if (!np) return 0;
    if (apodos[np] && apodos[np] === c.auxId) return 200;
    const tk = np.split(' '), cn = norm(c.n).split(' ');
    let s = 0;
    tk.forEach((t, i) => {
      if (cn.includes(t)) s += (i === 0 ? 35 : 30);
      else if (t.length >= 3 && cn.some((x) => x.startsWith(t))) s += 20;
      else if (t.length >= 4 && cn.some((x) => x.startsWith(t.slice(0, 4)))) s += 10;
      else if (t.length === 1 && cn.slice(1).some((x) => x.startsWith(t))) s += 8;
    });
    if (!s) return 0;
    const dl = toMin(c.dl);
    if (p.vuelo) {
      const dig = (x) => String(x || '').replace(/\D/g, '');
      if (c.type !== 'lle') return 0;
      if (c.vuelo && dig(c.vuelo) === dig(p.vuelo)) s += 40;
      if (dl != null && Math.abs(dl - p.min) <= 10) s += 15;
    } else if (p.deadline != null) {
      s += c.type === 'sal' ? 10 : -10;
      if (c.type === 'sal' && dl != null) {
        const d = dl - p.deadline;
        if (d >= -5 && d <= 40) s += 25; else if (d >= -15 && d <= 75) s += 12; else if (Math.abs(d) > 150) s -= 25;
      }
    } else if (dl != null) {
      const ref = c.type === 'sal' ? dl - 40 : dl;
      if (Math.abs(ref - p.min) <= 30) s += 12; else if (Math.abs(ref - p.min) > 180) s -= 20;
    }
    if (p.dia && c.dia && p.dia !== c.dia) s -= 30;
    const lz = norm(p.lugar), cz = norm(c.zona + ' ' + (c.sector || ''));
    if (lz && !p.vuelo && cz && lz.split(' ').some((t) => t.length >= 3 && cz.includes(t))) s += 15;
    return s;
  }
  // personas: [{ key, nombre, min, dia, vuelo, deadline, lugar }] → { [key]: { auto, rid, opciones } }
  function emparejar(pers, cands, apodos) {
    apodos = apodos || {};
    const pares = [];
    const porPersona = {};
    pers.forEach((p) => {
      const ops = cands.map((c) => ({ c, s: puntaje(p, c, apodos) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      porPersona[p.key] = ops;
      ops.forEach((o) => pares.push({ k: p.key, rid: o.c.rid, s: o.s }));
    });
    // Asignación codiciosa: el par más seguro primero; cada pedido y cada persona, una vez.
    pares.sort((a, b) => b.s - a.s);
    const usadoR = new Set(), hecho = {};
    pares.forEach((x) => {
      if (hecho[x.k] || usadoR.has(x.rid)) return;
      const ops = porPersona[x.k];
      const segundo = ops.find((o) => o.c.rid !== x.rid && !usadoR.has(o.c.rid));
      const seguro = x.s >= 200 || (x.s >= 50 && (!segundo || x.s - segundo.s >= 15));
      if (!seguro) return;
      hecho[x.k] = x.rid; usadoR.add(x.rid);
    });
    const out = {};
    pers.forEach((p) => {
      out[p.key] = { auto: !!hecho[p.key], rid: hecho[p.key] || null, opciones: porPersona[p.key].slice(0, 8).map((o) => o.c.rid) };
    });
    return out;
  }

  // ── 3. Los pedidos del día (y la madrugada siguiente) ───────────────────────
  function candidatosDe(aux, dia) {
    return Object.keys(aux || {}).map((k) => {
      const a = aux[k];
      return { rid: a.reservationId, auxId: a.auxId || null, n: a.n || 'Tripulante', type: a.type === 'lle' ? 'lle' : 'sal', dia,
        dl: a.dl || '', vuelo: a.vuelo || '', zona: a.zona || '', sector: a.sector || '', tel: a.tel || '',
        reserva: a.reserva || null, hotel: !!a.hotel, pernocta: !!a.pernocta,
        creada: a.createdAt || null, at: a.at || null };   // 0130: para el corte de las 7:40 p. m.
    }).filter((c) => c.rid);
  }
  async function cargarCandidatos(dia) {
    // Día mezclado (26-oct-2026): el tablero saca de rt.aux a quien va en una vuelta
    // pegada (rt.rv2AuxPegadas, admin-rutas-v2.js); para volver a pegar y para el
    // Excel del día siguen siendo pedidos del día.
    const hoy = (typeof rt !== 'undefined' && rt.day === dia && rt.aux) ? candidatosDe(Object.assign({}, rt.aux, rt.rv2AuxPegadas || {}), dia)
      : (W.Api && Api.listRoutePlanning ? candidatosDe(((await Api.listRoutePlanning('all', dia).catch(() => null)) || {}).aux, dia) : []);
    let mad = [];
    try {
      const sig = W.Api && Api.listRoutePlanning ? await Api.listRoutePlanning('all', sumarDia(dia, 1)) : null;
      if (sig && sig.day === sumarDia(dia, 1)) mad = candidatosDe(sig.aux, sumarDia(dia, 1)).filter((c) => (toMin(c.dl) ?? 9999) < 240);
    } catch (_) { mad = []; }
    return hoy.concat(mad);
  }

  // ── 4. La hoja: pegar → revisar → publicar ──────────────────────────────────
  const st = { dia: null, texto: '', lectura: null, cands: [], apodos: {}, elegido: {}, auto: {}, opciones: {}, ocupado: false };
  const V2 = () => W.RendioRutasV2 || null;
  const sheet = () => (V2() && V2()._sheet) || null;
  const say = (m) => { const v = V2(); if (v && v.toast) v.toast(m); else if (W.toast) W.toast(m); };
  const diaActual = () => (V2() && typeof V2().diaActual === 'function' ? V2().diaActual() : null) || (typeof rt !== 'undefined' ? rt.day : null);

  function abrir() {
    const S = sheet(); if (!S) return;
    st.dia = diaActual();
    if (!st.dia) { say('Elige primero el día en Rutas del día.'); return; }
    try { st.texto = localStorage.getItem(LS(st.dia)) || ''; } catch (_) { st.texto = ''; }
    st.lectura = null;
    S.open(S.head(`Ruta de Julián · ${esc(diaTxt(st.dia))}`, 'Pega el mismo mensaje que mandas al grupo. Se emparejan los nombres con los pedidos del día y, al publicar, a cada tripulante le llega su hora.')
      + `<div class="rv2-sh-body rj-body"><textarea class="rj-ta" id="rj-ta" rows="12" spellcheck="false" placeholder="3:10 Isa rivera (Mota)&#10;3:15 Karol L (Viverdi)&#10;Deben estar 3:40&#10;&#10;12:00 Jessica y Erika (av9563)">${esc(st.texto)}</textarea>`
      + '<div class="rj-prev" id="rj-prev"></div></div>'
      + '<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cancelar</button><button class="rv2-btn" data-rj="leer">Leer la ruta</button>'
      + '<button class="rv2-btn rv2-btn--cta" data-rj="publicar" disabled>Publicar y avisar</button></div>');
    atar();
  }
  let atado = false;
  function atar() {
    if (atado) return;
    const sh = document.getElementById('rv2-sheet'); if (!sh) return;
    atado = true;
    sh.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rj]'); if (!b || b.disabled) return;
      const k = b.getAttribute('data-rj');
      if (k === 'leer') leerYMostrar();
      else if (k === 'publicar') publicar();
      else if (k === 'xl') descargarDelAviso(b.getAttribute('data-dia'));
    });
    sh.addEventListener('change', (e) => {
      const s = e.target.closest('[data-rj-pick]'); if (!s) return;
      st.elegido[s.getAttribute('data-rj-pick')] = s.value || '';
      pintarPrevia();
    });
    sh.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'rj-ta') { st.texto = e.target.value; try { localStorage.setItem(LS(st.dia), st.texto); } catch (_) { /* */ } }
    });
  }
  async function leerYMostrar() {
    const ta = document.getElementById('rj-ta'); if (ta) st.texto = ta.value;
    const L = leer(st.texto, st.dia);
    st.lectura = L;
    const prev = document.getElementById('rj-prev');
    if (!L.bloques.length) { if (prev) prev.innerHTML = '<p class="rj-warn">No encontré vueltas en el texto. Cada línea va como «3:10 Isa rivera (Mota)» y las vueltas separadas por una línea en blanco.</p>'; return; }
    if (prev) prev.innerHTML = '<p class="rj-note">Buscando a cada uno en los pedidos del día…</p>';
    st.cands = await cargarCandidatos(st.dia);
    st.apodos = {};
    try { ((W.Api && Api.listCrewAliases) ? await Api.listCrewAliases() : []).forEach((a) => { st.apodos[norm(a.alias)] = a.auxId; }); } catch (_) { /* */ }
    const pers = [];
    L.bloques.forEach((b, bi) => b.lineas.forEach((l, li) => l.personas.forEach((nombre, pi) => pers.push({
      key: `${bi}.${li}.${pi}`, nombre, min: l.min, dia: l.dia, vuelo: l.vuelo, lugar: l.lugar, deadline: b.deadline && !b.deadline.mala ? b.deadline.min : null }))));
    const r = emparejar(pers, st.cands, st.apodos);
    // 0133: los conjuntos, para ubicar al que no tiene cuenta por lo que dice el paréntesis.
    st.residencias = [];
    try { st.residencias = (W.Api && Api.listResidencesAdmin) ? ((await Api.listResidencesAdmin()) || []).filter((x) => x.is_active !== false) : []; } catch (_) { st.residencias = []; }
    st.elegido = {}; st.auto = {}; st.opciones = {};
    Object.keys(r).forEach((k) => { st.elegido[k] = r[k].rid || ''; st.auto[k] = r[k].rid || ''; st.opciones[k] = r[k].opciones; });
    // 0133 (lista de los jefes, 26-oct): quien no pidió por la app pero Julián lo
    // puso con lugar (o vuelo) VA en la ruta, sin cuenta (Kriss). Solo si no se
    // parece a nadie del día: si hay parecidos («Revisa: elige quién es»), decide
    // el jefe. Siempre se puede cambiar a «No va».
    pers.forEach((p) => { if (!st.elegido[p.key] && !(st.opciones[p.key] || []).length && (p.lugar || p.vuelo)) { st.elegido[p.key] = GUEST; st.auto[p.key] = GUEST; } });
    pintarPrevia();
  }
  // 0133: el pasajero sin cuenta («Va sin cuenta»).
  const GUEST = '__guest';
  // El conjunto que dice el paréntesis («Campus Reservado»), si está en el catálogo.
  function conjuntoDe(lugar) {
    const n = norm(lugar || ''); if (n.length < 3) return null;
    const rs = st.residencias || [];
    return rs.find((x) => norm(x.name) === n)
      || rs.find((x) => { const m = norm(x.name); return m.length >= 4 && (m.includes(n) || n.includes(m)); }) || null;
  }
  const cand = (rid) => st.cands.find((c) => c.rid === rid) || null;
  const etiqueta = (c) => `${c.n} · ${c.type === 'lle' ? 'llega' : 'sale'} ${c.dl}${c.vuelo ? ' ' + c.vuelo : ''}${c.zona ? ' · ' + c.zona : ''}`;
  function pintarPrevia() {
    const prev = document.getElementById('rj-prev'); const L = st.lectura;
    if (!prev || !L) return;
    const usados = new Map();
    Object.entries(st.elegido).forEach(([k, rid]) => { if (rid && rid !== GUEST) usados.set(rid, (usados.get(rid) || []).concat(k)); });
    let h = '';
    let nOk = 0, nRev = 0, nSin = 0, nGuest = 0;
    L.bloques.forEach((b, bi) => {
      const lle = b.lineas.every((l) => l.vuelo);
      h += `<div class="rj-b"><div class="rj-bh"><b>${lle ? 'Llegada' : 'Salida'} · ${esc(hmTxt(b.lineas[0].min))}</b>${b.deadline ? (b.deadline.mala ? `<span class="rj-bad">«Deben estar ${esc(hmTxt(b.deadline.min))}» es antes de la última recogida: no se usa</span>` : `<span>Deben estar ${esc(hmTxt(b.deadline.min))}</span>`) : ''}${b.notas.length ? `<span>${esc(b.notas.join(' · '))}</span>` : ''}</div>`;
      b.lineas.forEach((l, li) => l.personas.forEach((nombre, pi) => {
        const k = `${bi}.${li}.${pi}`, rid = st.elegido[k];
        const esG = rid === GUEST;
        const c = rid && !esG ? cand(rid) : null;
        const doble = rid && !esG && (usados.get(rid) || []).length > 1;
        const estado = esG ? 'guest' : !rid ? 'sin' : (doble ? 'rev' : (st.auto[k] === rid ? 'ok' : 'man'));
        if (estado === 'ok' || estado === 'man') nOk++; else if (estado === 'rev') nRev++; else if (estado === 'guest') nGuest++; else nSin++;
        const cj = esG ? conjuntoDe(l.lugar) : null;
        const ops = [...new Set([...(st.opciones[k] || []), ...(rid ? [rid] : [])])].map(cand).filter(Boolean);
        const resto = st.cands.filter((x) => !ops.includes(x)).sort((a, z) => a.n.localeCompare(z.n));
        h += `<div class="rj-p" data-st="${estado}"><span class="rj-t">${esc(hmTxt(l.min))}</span><span class="rj-w">${esc(nombre)}${l.lugar ? ` <em>(${esc(l.lugar)})</em>` : ''}</span>`
          + `<select data-rj-pick="${k}" aria-label="${esc('Quién es ' + nombre)}"><option value="">— No pidió por la app (no se avisa) —</option>`
          + `<option value="${GUEST}"${esG ? ' selected' : ''}>— Va sin cuenta: en la ruta, sin aviso —</option>`
          + (ops.length ? `<optgroup label="Más probables">${ops.map((x) => `<option value="${esc(x.rid)}"${x.rid === rid ? ' selected' : ''}>${esc(etiqueta(x))}</option>`).join('')}</optgroup>` : '')
          + (resto.length ? `<optgroup label="Todos los del día">${resto.map((x) => `<option value="${esc(x.rid)}">${esc(etiqueta(x))}</option>`).join('')}</optgroup>` : '')
          + `</select>${doble ? '<small class="rj-bad">Está dos veces</small>'
            // Una llegada en una vuelta de salidas (o al revés) se publica aparte.
            : (c && c.type !== (lle ? 'lle' : 'sal') ? `<small class="rj-bad">Es ${c.type === 'lle' ? 'una llegada' : 'una salida'}: va en otra vuelta. Revisa que sea ella</small>`
              : esG ? `<small>Sin cuenta: va en la ruta${cj ? ' · ' + esc(cj.name) : (l.lugar ? ' · «' + esc(l.lugar) + '» (sin ubicar en el mapa)' : '')}. No le llegan avisos.</small>`
              : (estado === 'sin' ? `<small>${ops.length ? 'Revisa: elige quién es (hay parecidos)' : 'Revisa: no la encontré'}</small>` : (estado === 'man' && c ? '<small>Elegido a mano: se aprende</small>' : '')))}</div>`;
      }));
      h += '</div>';
    });
    const elegidos = new Set(Object.values(st.elegido).filter((x) => x && x !== GUEST));
    const fuera = st.cands.filter((c) => !elegidos.has(c.rid));
    const resumen = `<div class="rj-sum"><b>${L.bloques.length} vueltas · ${nOk} emparejados</b>`
      + (nRev ? `<span class="rj-bad">${nRev} repetidos: corrígelos antes de publicar</span>` : '')
      + (nGuest ? `<span>${nGuest} sin cuenta: van en la ruta, sin aviso</span>` : '')
      + (nSin ? `<span>${nSin} sin pedido en la app (no van)</span>` : '')
      + (fuera.length ? `<span class="rj-warn">Pidieron por la app y no están en tu ruta: ${esc(fuera.map((c) => `${c.n.split(' ')[0]} (${c.type === 'lle' ? 'llega' : 'sale'} ${c.dl})`).join(', '))}</span>` : '')
      + (L.raras.length ? `<span class="rj-warn">No entendí: ${esc(L.raras.join(' · '))}</span>` : '')
      + '</div>';
    prev.innerHTML = resumen + h;
    const pub = document.querySelector('#rv2-sheet [data-rj="publicar"]');
    if (pub) { pub.disabled = !(nOk + nGuest) || nRev > 0 || st.ocupado; pub.textContent = nOk ? `Publicar y avisar a ${nOk}${nGuest ? ` · ${nGuest} sin cuenta` : ''}` : (nGuest ? `Publicar (${nGuest} sin cuenta)` : 'Publicar y avisar'); }
  }
  // Los bloques para la base: horas resueltas a fecha y hora; un bloque con
  // salidas y llegadas mezcladas se parte en dos (son carros distintos).
  function bloquesParaBase() {
    const out = [];
    st.lectura.bloques.forEach((b, bi) => {
      const grupos = { sal: [], lle: [] };
      // 0133: el sin cuenta va con el tipo de su bloque (el de los que tienen pedido;
      // si no hay ninguno, llegada si la línea trae vuelo).
      const tipos = [];
      b.lineas.forEach((l, li) => l.personas.forEach((_, pi) => { const c = cand(st.elegido[`${bi}.${li}.${pi}`]); if (c) tipos.push(c.type); }));
      const tipoBloque = (l) => (tipos.length ? (tipos.filter((x) => x === 'lle').length > tipos.length / 2 ? 'lle' : 'sal') : (l.vuelo ? 'lle' : 'sal'));
      b.lineas.forEach((l, li) => l.personas.forEach((nombre, pi) => {
        const rid = st.elegido[`${bi}.${li}.${pi}`];
        if (rid === GUEST) {
          const cj = conjuntoDe(l.lugar);
          grupos[tipoBloque(l)].push({ guest: { name: nombre, place: l.lugar || (cj ? cj.name : null), residence_id: cj ? cj.id : null }, at: isoDe(l.dia, l.min), vuelo: l.vuelo });
          return;
        }
        const c = rid ? cand(rid) : null;
        if (!c) return;
        grupos[c.type].push({ reservation_id: rid, at: isoDe(l.dia, l.min), vuelo: l.vuelo });
      }));
      ['sal', 'lle'].forEach((t) => {
        if (!grupos[t].length) return;
        out.push({ type: t, stops: grupos[t].map(({ reservation_id, guest, at }) => (guest ? { guest, at } : { reservation_id, at })),
          deadline_at: t === 'sal' && b.deadline && !b.deadline.mala ? isoDe(b.deadline.dia, b.deadline.min) : null,
          note: b.notas.join(' · ') || null, flight: t === 'lle' ? (grupos[t].find((x) => x.vuelo) || {}).vuelo || null : null });
      });
    });
    return out;
  }
  function apodosNuevos() {
    const out = [];
    st.lectura.bloques.forEach((b, bi) => b.lineas.forEach((l, li) => l.personas.forEach((nombre, pi) => {
      const k = `${bi}.${li}.${pi}`, rid = st.elegido[k];
      if (!rid || st.auto[k] === rid) return;
      const c = cand(rid); if (!c || !c.auxId) return;
      if (norm(nombre) === norm(c.n)) return;
      out.push({ alias: norm(nombre), auxiliar_profile_id: c.auxId });
    })));
    return out;
  }
  async function publicar() {
    if (st.ocupado || !st.lectura) return;
    const bloques = bloquesParaBase();
    const n = bloques.reduce((a, b) => a + b.stops.length, 0);
    if (!n) return;
    const nG = bloques.reduce((a, b) => a + b.stops.filter((x) => x.guest).length, 0);
    if (typeof W.confirm === 'function' && !W.confirm(`¿Publicar la ruta de Julián del ${diaTxt(st.dia)}? ${bloques.length} vueltas, ${n - nG} tripulantes${nG ? ` y ${nG} sin cuenta` : ''}. A cada tripulante le llega su hora de recogida y los conductores las pueden tomar.${nG ? ' A los sin cuenta no les llega nada: van en la ruta del conductor.' : ''}`)) return;
    st.ocupado = true; pintarPrevia();
    try {
      const r = await Api.adminManualRoutePublish(st.dia, bloques, apodosNuevos());
      const S = sheet(); if (S) S.close();
      // Lista de los jefes (26-oct): sus llegadas con vuelo pasan solas a Vuelos.
      let vuelos = 0;
      try { vuelos = W.renderVuelos && typeof W.renderVuelos.seguirDesdeTexto === 'function' ? await W.renderVuelos.seguirDesdeTexto(st.texto, st.dia) : 0; } catch (_) { vuelos = 0; }
      say(`Ruta publicada: ${r.vueltas} vueltas · avisados ${r.notified}${r.removed ? ` · ${r.removed} vueltas viejas quitadas` : ''}${r.skipped ? ` · ${r.skipped} ya iban en una vuelta en curso` : ''}${vuelos ? ` · ${vuelos} ${vuelos === 1 ? 'vuelo' : 'vuelos'} a Vuelos` : ''}.`);
      if (V2() && typeof V2().cargarDia === 'function') await V2().cargarDia(st.dia);
    } catch (e) {
      say('No se pudo publicar: ' + ((e && e.message) || 'error'));
    } finally { st.ocupado = false; pintarPrevia(); }
  }

  // ── 5. El Excel del día (la estructura del Formulario) ──────────────────────
  const COLS = ['NOMBRE Y APELLIDO', 'FECHA', 'HORA DE PRESENTACIÓN', 'HORA DE LLEGADA', 'VUELO DE LLEGADA', '¿ES UNA RESERVA?', '¿ES UNA PERNOCTA?', 'CONJUNTO', 'SECTOR', 'TELÉFONO'];
  // Una fila por persona y día, como el Formulario: la salida en «presentación» y
  // la llegada en «llegada» (si alguien tiene dos del mismo tipo, va otra fila).
  function filasExcel(cands) {
    const por = new Map();
    cands.slice().sort((a, b) => (a.dia + a.dl).localeCompare(b.dia + b.dl)).forEach((c) => {
      const k = c.n + '|' + c.dia;
      let filas = por.get(k); if (!filas) { filas = []; por.set(k, filas); }
      let f = filas.find((x) => (c.type === 'sal' ? !x.pres : !x.lleg));
      if (!f) { f = { n: c.n, dia: c.dia, pres: '', lleg: '', vuelo: '', reserva: false, pernocta: false, zona: c.zona, sector: c.sector, tel: c.tel }; filas.push(f); }
      if (c.type === 'sal') f.pres = c.dl; else { f.lleg = c.dl; f.vuelo = c.vuelo || ''; }
      f.reserva = f.reserva || !!c.reserva; f.pernocta = f.pernocta || c.pernocta;
    });
    return [...por.values()].flat().sort((a, b) => (a.dia + (a.pres || a.lleg)).localeCompare(b.dia + (b.pres || b.lleg)));
  }
  // `diaPedido` (0130): el día que pide el aviso de las 7:40 p. m.; sin él, el de
  // la pantalla. El Excel no depende del tablero: lee los pedidos de ese día.
  async function excel(diaPedido) {
    const dia = (typeof diaPedido === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(diaPedido)) ? diaPedido : diaActual();
    if (!dia) { say('Elige primero el día en Rutas del día.'); return null; }
    if (typeof ExcelJS === 'undefined') { say('No se pudo cargar la librería de Excel. Revisa la conexión y reintenta.'); return null; }
    const cands = await cargarCandidatos(dia);
    // 0130 (lista de los jefes, 26-oct): la hoja RESPUESTAS es el consolidado del
    // corte (7:40 p. m. del día anterior, Ajustes), tal cual el Formulario. Lo que
    // se pidió después del corte («Late», Reservas) va aparte, en la hoja LATE, con
    // la hora en que se pidió: Julián lo programa con lo que vaya faltando.
    let cfg = null;
    try { cfg = W.Api && Api.getRequestCutoff ? await Api.getRequestCutoff() : null; } catch (_) { cfg = null; }
    const esLate = (c) => !!(cfg && W.Api && Api.isLateRequest && Api.isLateRequest(c.at, c.creada, cfg) === true);
    const late = cands.filter(esLate);
    const filas = filasExcel(cands.filter((c) => !esLate(c)));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Rendio';
    const fila = (f) => ({
      'NOMBRE Y APELLIDO': f.n, 'FECHA': f.dia.split('-').reverse().join('/'), 'HORA DE PRESENTACIÓN': f.pres, 'HORA DE LLEGADA': f.lleg,
      'VUELO DE LLEGADA': f.vuelo, '¿ES UNA RESERVA?': f.reserva ? 'SI' : 'NO', '¿ES UNA PERNOCTA?': f.pernocta ? 'SI' : 'NO',
      'CONJUNTO': f.zona, 'SECTOR': f.sector, 'TELÉFONO': f.tel });
    const hoja = (nombre, cols) => {
      const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map((h) => ({ header: h, key: h, width: h === 'NOMBRE Y APELLIDO' ? 30 : (h.length < 12 ? 14 : h.length + 4) }));
      ws.getRow(1).font = { bold: true };
      return ws;
    };
    const ws = hoja('RESPUESTAS', COLS);
    filas.forEach((f) => ws.addRow(fila(f)));
    if (late.length) {
      const wl = hoja('LATE', COLS.concat(['PIDIÓ']));
      const pidio = new Map(late.map((c) => [c.n + '|' + c.dia, c.creada]));
      filasExcel(late).forEach((f) => {
        const t = pidio.get(f.n + '|' + f.dia);
        wl.addRow(Object.assign(fila(f), { 'PIDIÓ': t ? new Date(t).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '' }));
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    const nombre = `PROGRAMACIÓN RENDIO ${dia}.xlsx`;
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) { /* */ } }, 1000);
    } catch (e) { say('No se pudo descargar el Excel: ' + ((e && e.message) || 'error')); return null; }
    const corteTxt = cfg && W.Api && Api.hm12 ? Api.hm12(cfg.corte) : '7:40 p. m.';
    say(`Excel del ${diaTxt(dia)}: ${filas.length} filas (${cands.length - late.length} pedidos hasta las ${corteTxt})${late.length ? ` · ${late.length} Late en su hoja` : ''}.`);
    return { nombre, filas: filas.length, late: late.length, buf };
  }

  // 0130 · El aviso de las 7:40 p. m. («📋 El Excel de mañana está listo») abre
  // #/rutas?excel=AAAA-MM-DD: se abre esta hoja, se arma el Excel de ESE día y se
  // descarga solo. Si el teléfono no deja bajarlo sin un toque, queda el botón.
  async function ofrecer(dia) {
    if (!(typeof dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dia))) return null;
    let cfg = null;
    try { cfg = W.Api && Api.getRequestCutoff ? await Api.getRequestCutoff() : null; } catch (_) { cfg = null; }
    const corte = W.Api && Api.hm12 ? Api.hm12(cfg && cfg.corte != null ? cfg.corte : 1180) : '7:40 p. m.';
    const S = sheet();
    if (S) {
      S.open(S.head(`Excel del ${esc(diaTxt(dia))}`, `Lo pedido hasta las ${esc(corte)} de la víspera, como el Formulario. Lo que llegue después sale como «Late» en Reservas y en la hoja LATE.`)
        + '<div class="rv2-sh-body"><p class="rv2-impact" id="rj-xl-msg">Armando el Excel…</p></div>'
        + `<div class="rv2-sh-foot"><button class="rv2-btn" data-act="sclose">Cerrar</button><button class="rv2-btn rv2-btn--cta" data-rj="xl" data-dia="${esc(dia)}">Descargar</button></div>`);
      atar();
    }
    return descargarDelAviso(dia);
  }
  async function descargarDelAviso(dia) {
    const r = await excel(dia);
    const m = document.getElementById('rj-xl-msg');
    if (m) m.textContent = r
      ? `Listo: ${r.filas} ${r.filas === 1 ? 'fila' : 'filas'}${r.late ? ` · ${r.late} Late en su hoja` : ''}. Si no se descargó solo, toca «Descargar».`
      : 'No se pudo armar el Excel. Toca «Descargar» para intentar otra vez.';
    return r;
  }

  // ── 6. El día con la ruta de Julián (Rutas del día, en lugar del tablero) ───
  // o.mixto (26-oct-2026): el día también tiene vueltas del tablero. El bloque va
  // ARRIBA de la lista del tablero (admin-rutas-v2.js · pegadasHTML), no en su lugar.
  function diaHTML(vueltas, dia, otras, o) {
    const mixto = !!(o && o.mixto);
    const vs = (vueltas || []).slice().sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    const libres = vs.filter((v) => !v.driverProfileId && !v.delegated && v.status !== 'completed').length;
    const delegadas = vs.filter((v) => v.delegated).length;
    const n = mixto ? `${vs.length} ${vs.length === 1 ? 'vuelta pegada' : 'vueltas pegadas'}` : `${vs.length} vueltas`;
    let h = `<div class="rj-dia${mixto ? ' is-mixto' : ''}" data-k="julian"><div class="rj-dia-h"><div><b>Ruta de Julián · ${esc(diaTxt(dia))}</b><span>${n} · ${libres ? `${libres} sin tomar` : 'todas tomadas'}${delegadas ? ` · ${delegadas} ${delegadas === 1 ? 'delegada' : 'delegadas'}` : ''}</span></div>`
      + '<div class="rj-dia-a"><button class="rv2-btn rv2-btn--sm" data-rj-dia="pegar">Volver a pegar</button><button class="rv2-btn rv2-btn--sm" data-rj-dia="excel">Excel del día</button>'
      + `<button class="rv2-btn rv2-btn--sm" data-rj-dia="quitar"${mixto ? ' data-mixto="1"' : ''}>Quitar la ruta</button></div></div>`;
    if (mixto) h += '<p class="rj-note">Van aparte del tablero: los conductores las toman en su app. Publicar el tablero no las toca.</p>';
    else if (otras) h += `<p class="rj-note">Además hay ${otras} ${otras === 1 ? 'vuelta' : 'vueltas'} del tablero publicadas ese día.</p>`;
    vs.forEach((v) => {
      const gente = [...(v.atendidas || []), ...(v.pendientes || [])].sort((a, b) => a.order - b.order);
      const t0 = v.type === 'lle' ? bogHM(v.startAt) : (gente[0] && gente[0].etaAt ? bogHM(gente[0].etaAt) : bogHM(v.startAt));
      const enCurso = v.status === 'in_progress' || (v.atendidas || []).length > 0;
      const estado = v.status === 'completed' ? ['hecha', 'Terminada']
        : enCurso ? ['curso', v.delegated ? 'En curso · delegada' : `En curso · ${esc(v.conductor)}`]
          : v.delegated ? ['delegada', v.delegateName ? `Delegada · ${esc(v.delegateName)}${v.delegatePhone ? ' · ' + esc(v.delegatePhone) : ''}` : 'Delegada · la hace alguien de afuera']
            : v.driverProfileId ? ['tomada', `Tomada por ${esc(v.conductor)}${v.placa ? ' · ' + esc(v.placa) : ''}`]
              : ['libre', 'Disponible'];
      // 0126: delegar (o devolver) mientras no haya arrancado. Aplica al momento.
      const quienes = gente.map((g) => g.name.split(' ')[0] + (g.guest ? ' (sin cuenta)' : '')).join(', ');
      // 0129: el jefe le da la vuelta a un conductor (o se la quita) sin que la tome.
      const asignar = W.Api && W.Api.setVueltaDriver
        ? `<button class="rv2-btn rv2-btn--sm" data-rj-drv="${esc(v.id)}" data-hora="${esc(t0)}" data-actual="${esc(v.driverProfileId || '')}">${v.driverProfileId ? 'Cambiar conductor' : 'Asignar conductor'}</button>`
        : '';
      const btn = v.status === 'completed' || enCurso ? ''
        : asignar
          // 0131: a quién se delegó (de la libreta o a mano); una delegada lo puede cambiar.
          + (v.delegated && W.Api && W.Api.delegateRoute ? `<button class="rv2-btn rv2-btn--sm" data-rj-deleg="${esc(v.id)}" data-on="1" data-hora="${esc(t0)}" data-quienes="${esc(quienes)}" data-tomada="" data-dn="${esc(v.delegateName || '')}" data-dp="${esc(v.delegatePhone || '')}">${v.delegateName ? 'Cambiar a quién' : 'A quién'}</button>` : '')
          + `<button class="rv2-btn rv2-btn--sm" data-rj-deleg="${esc(v.id)}" data-on="${v.delegated ? 0 : 1}" data-hora="${esc(t0)}" data-quienes="${esc(quienes)}" data-tomada="${!v.delegated && v.driverProfileId ? esc(v.conductor) : ''}">${v.delegated ? 'Devolver' : 'Delegar'}</button>`;
      h += `<div class="rj-v" data-st="${estado[0]}"><div class="rj-v-t"><b>${esc(t0)}</b><small>${v.type === 'lle' ? 'Llegada' : 'Salida'}</small></div>`
        + `<div class="rj-v-m"><span>${esc(gente.map((g) => g.name.split(' ')[0]).join(', ') || '—')}</span>`
        + `<small>${esc([v.deadlineAt ? 'Deben estar ' + bogHM(v.deadlineAt) : '', v.nota || '', `${gente.length} ${gente.length === 1 ? 'persona' : 'personas'}`].filter(Boolean).join(' · '))}</small></div>`
        + `<div class="rj-v-r"><span class="rj-v-st">${estado[1]}</span>${btn}</div></div>`;
    });
    return h + '</div>';
  }
  let atadoDia = false;
  function atarDia() {
    if (atadoDia) return;
    const root = document.getElementById('routes-v2'); if (!root) return;
    atadoDia = true;
    root.addEventListener('click', async (e) => {
      // 0129: «Asignar conductor» → una lista ahí mismo; «Asignar» publica al momento.
      const dv = e.target.closest('[data-rj-drv]');
      if (dv) {
        const actual = dv.getAttribute('data-actual') || '';
        const lista = ((W.rt && W.rt.drivers) || (typeof rt !== 'undefined' && rt.drivers) || []).slice()
          .filter((d) => d && d.id && d.id !== actual)
          .sort((a, b) => String(a.n || '').localeCompare(String(b.n || ''), 'es'));
        const box = document.createElement('span');
        box.className = 'rj-pick';
        box.innerHTML = `<select aria-label="Conductor para la vuelta de las ${esc(dv.getAttribute('data-hora'))}">`
          + '<option value="">Elige un conductor…</option>'
          + lista.map((d) => `<option value="${esc(d.id)}">${esc(d.n || 'Conductor')}</option>`).join('')
          + (actual ? '<option value="__none">Sin conductor (vuelve a la lista para tomar)</option>' : '')
          + `</select><button class="rv2-btn rv2-btn--sm rv2-btn--cta" data-rj-drv-ok="${esc(dv.getAttribute('data-rj-drv'))}" data-hora="${esc(dv.getAttribute('data-hora'))}" disabled>Asignar</button>`
          + '<button class="rv2-btn rv2-btn--sm" data-rj-drv-x aria-label="Cancelar">Cancelar</button>';
        dv.replaceWith(box);
        const sel = box.querySelector('select'), okb = box.querySelector('[data-rj-drv-ok]');
        sel.addEventListener('change', () => { okb.disabled = !sel.value; });
        sel.focus();
        return;
      }
      if (e.target.closest('[data-rj-drv-x]')) { const v = V2(); if (v && typeof v.render === 'function') v.render(); else { const dia = diaActual(); if (dia && V2()) await V2().cargarDia(dia); } return; }
      const okb = e.target.closest('[data-rj-drv-ok]');
      if (okb) {
        const box = okb.closest('.rj-pick'), sel = box && box.querySelector('select');
        const val = sel ? sel.value : ''; if (!val) return;
        const hora = okb.getAttribute('data-hora');
        okb.disabled = true; if (sel) sel.disabled = true;
        try {
          const r = await Api.setVueltaDriver(okb.getAttribute('data-rj-drv-ok'), val === '__none' ? null : val);
          const nombre = val === '__none' ? '' : (sel.options[sel.selectedIndex] || {}).text || 'el conductor';
          say(val === '__none'
            ? `La vuelta de las ${hora} quedó sin conductor: vuelve a la lista para que la tomen.`
            : `${nombre} hace la vuelta de las ${hora}${r && r.notified ? ` · avisamos a ${r.notified} ${r.notified === 1 ? 'tripulante' : 'tripulantes'}` : ''}.`);
          const dia = diaActual();
          if (dia && V2() && typeof V2().cargarDia === 'function') await V2().cargarDia(dia);
        } catch (err) { okb.disabled = false; if (sel) sel.disabled = false; say('No se pudo: ' + ((err && err.message) || 'error')); }
        return;
      }
      const dl = e.target.closest('[data-rj-deleg]');
      if (dl) {
        const on = dl.getAttribute('data-on') === '1';
        const hora = dl.getAttribute('data-hora'), quienes = dl.getAttribute('data-quienes'), tomada = dl.getAttribute('data-tomada');
        // 0131: delegar A ALGUIEN (libreta o a mano) en la hoja «Delegar a…» de Asignación.
        if (on && V2() && typeof V2().delegar === 'function' && W.Api && Api.delegateRoute) {
          const id = dl.getAttribute('data-rj-deleg');
          const dn = dl.getAttribute('data-dn') || '', dp = dl.getAttribute('data-dp') || '';
          V2().delegar({
            titulo: 'Delegar a…',
            sub: `Vuelta de las ${esc(hora)}${quienes ? ' · ' + esc(quienes) : ''}${tomada ? ` · ${esc(tomada)} la había tomado: se le avisa que ya no la hace` : ''} · se le avisa a cada tripulante quién lo recoge y su número`,
            actual: dn ? { name: dn, phone: dp } : null,
            publicar: async (name, phone) => {
              const r = await Api.delegateRoute(id, name, phone);
              say(r && r.unchanged ? `La vuelta de las ${hora} ya estaba con ${name}.` : `Vuelta de las ${hora} delegada a ${name}${r && r.notified ? ` · avisamos a ${r.notified} ${r.notified === 1 ? 'tripulante' : 'tripulantes'}` : ''}.`);
              const dia = diaActual();
              if (dia && V2() && typeof V2().cargarDia === 'function') await V2().cargarDia(dia);
            },
          });
          return;
        }
        const pregunta = on
          ? `¿Delegar la vuelta de las ${hora}${quienes ? ' (' + quienes + ')' : ''}? La hace alguien de afuera: ningún conductor la verá y a cada tripulante le llega «Tu servicio fue delegado, te contactaremos por WhatsApp».${tomada ? ` ${tomada} la había tomado: se le avisa que ya no la hace.` : ''}`
          : `¿Devolver la vuelta de las ${hora}? Vuelve a la lista para que un conductor la tome, y se le avisa al tripulante.`;
        if (typeof W.confirm === 'function' && !W.confirm(pregunta)) return;
        dl.disabled = true;
        try {
          const r = await Api.setRouteDelegated(dl.getAttribute('data-rj-deleg'), on);
          say(on ? `Vuelta de las ${hora} delegada${r && r.notified ? ` · avisamos a ${r.notified} ${r.notified === 1 ? 'tripulante' : 'tripulantes'}` : ''}.` : `Vuelta de las ${hora} devuelta: ya la pueden tomar.`);
          const dia = diaActual();
          if (dia && V2() && typeof V2().cargarDia === 'function') await V2().cargarDia(dia);
        } catch (err) { dl.disabled = false; say('No se pudo: ' + ((err && err.message) || 'error')); }
        return;
      }
      const b = e.target.closest('[data-rj-dia]'); if (!b) return;
      const k = b.getAttribute('data-rj-dia');
      if (k === 'pegar') abrir();
      else if (k === 'excel') excel();
      else if (k === 'quitar') {
        const dia = diaActual(); if (!dia) return;
        const pregunta = b.getAttribute('data-mixto') === '1'
          ? `¿Quitar la ruta de Julián del ${diaTxt(dia)}? Se borran sus vueltas que no han arrancado (también las ya tomadas) y esos tripulantes quedan sin carro en el tablero: ubícalos y publica. Las vueltas del tablero no cambian.`
          : `¿Quitar la ruta de Julián del ${diaTxt(dia)}? Se borran las vueltas que no han arrancado (también las ya tomadas) y el día vuelve al tablero.`;
        if (typeof W.confirm === 'function' && !W.confirm(pregunta)) return;
        try {
          const n = await Api.adminManualRouteClear(dia);
          say(`Se quitaron ${n} vueltas de la ruta de Julián.`);
          if (V2() && typeof V2().cargarDia === 'function') await V2().cargarDia(dia);
        } catch (err) { say('No se pudo quitar: ' + ((err && err.message) || 'error')); }
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', atarDia); else atarDia();

  W.RendioRutaJulian = { abrir, excel, ofrecer, diaHTML, _leer: leer, _emparejar: emparejar, _filasExcel: filasExcel, _st: st, _norm: norm };
})();
