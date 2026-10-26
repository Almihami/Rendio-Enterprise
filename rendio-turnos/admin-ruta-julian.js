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
        reserva: a.reserva || null, hotel: !!a.hotel, pernocta: !!a.pernocta };
    }).filter((c) => c.rid);
  }
  async function cargarCandidatos(dia) {
    const hoy = (typeof rt !== 'undefined' && rt.day === dia && rt.aux) ? candidatosDe(rt.aux, dia)
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
    st.elegido = {}; st.auto = {}; st.opciones = {};
    Object.keys(r).forEach((k) => { st.elegido[k] = r[k].rid || ''; st.auto[k] = r[k].rid || ''; st.opciones[k] = r[k].opciones; });
    pintarPrevia();
  }
  const cand = (rid) => st.cands.find((c) => c.rid === rid) || null;
  const etiqueta = (c) => `${c.n} · ${c.type === 'lle' ? 'llega' : 'sale'} ${c.dl}${c.vuelo ? ' ' + c.vuelo : ''}${c.zona ? ' · ' + c.zona : ''}`;
  function pintarPrevia() {
    const prev = document.getElementById('rj-prev'); const L = st.lectura;
    if (!prev || !L) return;
    const usados = new Map();
    Object.entries(st.elegido).forEach(([k, rid]) => { if (rid) usados.set(rid, (usados.get(rid) || []).concat(k)); });
    let h = '';
    let nOk = 0, nRev = 0, nSin = 0;
    L.bloques.forEach((b, bi) => {
      const lle = b.lineas.every((l) => l.vuelo);
      h += `<div class="rj-b"><div class="rj-bh"><b>${lle ? 'Llegada' : 'Salida'} · ${esc(hmTxt(b.lineas[0].min))}</b>${b.deadline ? (b.deadline.mala ? `<span class="rj-bad">«Deben estar ${esc(hmTxt(b.deadline.min))}» es antes de la última recogida: no se usa</span>` : `<span>Deben estar ${esc(hmTxt(b.deadline.min))}</span>`) : ''}${b.notas.length ? `<span>${esc(b.notas.join(' · '))}</span>` : ''}</div>`;
      b.lineas.forEach((l, li) => l.personas.forEach((nombre, pi) => {
        const k = `${bi}.${li}.${pi}`, rid = st.elegido[k];
        const c = rid ? cand(rid) : null;
        const doble = rid && (usados.get(rid) || []).length > 1;
        const estado = !rid ? 'sin' : (doble ? 'rev' : (st.auto[k] === rid ? 'ok' : 'man'));
        if (estado === 'ok' || estado === 'man') nOk++; else if (estado === 'rev') nRev++; else nSin++;
        const ops = [...new Set([...(st.opciones[k] || []), ...(rid ? [rid] : [])])].map(cand).filter(Boolean);
        const resto = st.cands.filter((x) => !ops.includes(x)).sort((a, z) => a.n.localeCompare(z.n));
        h += `<div class="rj-p" data-st="${estado}"><span class="rj-t">${esc(hmTxt(l.min))}</span><span class="rj-w">${esc(nombre)}${l.lugar ? ` <em>(${esc(l.lugar)})</em>` : ''}</span>`
          + `<select data-rj-pick="${k}" aria-label="${esc('Quién es ' + nombre)}"><option value="">— No pidió por la app (no se avisa) —</option>`
          + (ops.length ? `<optgroup label="Más probables">${ops.map((x) => `<option value="${esc(x.rid)}"${x.rid === rid ? ' selected' : ''}>${esc(etiqueta(x))}</option>`).join('')}</optgroup>` : '')
          + (resto.length ? `<optgroup label="Todos los del día">${resto.map((x) => `<option value="${esc(x.rid)}">${esc(etiqueta(x))}</option>`).join('')}</optgroup>` : '')
          + `</select>${doble ? '<small class="rj-bad">Está dos veces</small>'
            // Una llegada en una vuelta de salidas (o al revés) se publica aparte.
            : (c && c.type !== (lle ? 'lle' : 'sal') ? `<small class="rj-bad">Es ${c.type === 'lle' ? 'una llegada' : 'una salida'}: va en otra vuelta. Revisa que sea ella</small>`
              : (estado === 'sin' ? `<small>${ops.length ? 'Revisa: elige quién es (hay parecidos)' : 'Revisa: no la encontré'}</small>` : (estado === 'man' && c ? '<small>Elegido a mano: se aprende</small>' : '')))}</div>`;
      }));
      h += '</div>';
    });
    const elegidos = new Set(Object.values(st.elegido).filter(Boolean));
    const fuera = st.cands.filter((c) => !elegidos.has(c.rid));
    const resumen = `<div class="rj-sum"><b>${L.bloques.length} vueltas · ${nOk} emparejados</b>`
      + (nRev ? `<span class="rj-bad">${nRev} repetidos: corrígelos antes de publicar</span>` : '')
      + (nSin ? `<span>${nSin} sin pedido en la app (no se les avisa)</span>` : '')
      + (fuera.length ? `<span class="rj-warn">Pidieron por la app y no están en tu ruta: ${esc(fuera.map((c) => `${c.n.split(' ')[0]} (${c.type === 'lle' ? 'llega' : 'sale'} ${c.dl})`).join(', '))}</span>` : '')
      + (L.raras.length ? `<span class="rj-warn">No entendí: ${esc(L.raras.join(' · '))}</span>` : '')
      + '</div>';
    prev.innerHTML = resumen + h;
    const pub = document.querySelector('#rv2-sheet [data-rj="publicar"]');
    if (pub) { pub.disabled = !nOk || nRev > 0 || st.ocupado; pub.textContent = nOk ? `Publicar y avisar a ${nOk}` : 'Publicar y avisar'; }
  }
  // Los bloques para la base: horas resueltas a fecha y hora; un bloque con
  // salidas y llegadas mezcladas se parte en dos (son carros distintos).
  function bloquesParaBase() {
    const out = [];
    st.lectura.bloques.forEach((b, bi) => {
      const grupos = { sal: [], lle: [] };
      b.lineas.forEach((l, li) => l.personas.forEach((_, pi) => {
        const rid = st.elegido[`${bi}.${li}.${pi}`]; const c = rid ? cand(rid) : null;
        if (!c) return;
        grupos[c.type].push({ reservation_id: rid, at: isoDe(l.dia, l.min), vuelo: l.vuelo });
      }));
      ['sal', 'lle'].forEach((t) => {
        if (!grupos[t].length) return;
        out.push({ type: t, stops: grupos[t].map(({ reservation_id, at }) => ({ reservation_id, at })),
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
    if (typeof W.confirm === 'function' && !W.confirm(`¿Publicar la ruta de Julián del ${diaTxt(st.dia)}? ${bloques.length} vueltas, ${n} tripulantes. A cada uno le llega su hora de recogida y los conductores las pueden tomar.`)) return;
    st.ocupado = true; pintarPrevia();
    try {
      const r = await Api.adminManualRoutePublish(st.dia, bloques, apodosNuevos());
      const S = sheet(); if (S) S.close();
      say(`Ruta publicada: ${r.vueltas} vueltas · avisados ${r.notified}${r.removed ? ` · ${r.removed} vueltas viejas quitadas` : ''}${r.skipped ? ` · ${r.skipped} ya iban en una vuelta en curso` : ''}.`);
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
  async function excel() {
    const dia = diaActual();
    if (!dia) { say('Elige primero el día en Rutas del día.'); return null; }
    if (typeof ExcelJS === 'undefined') { say('No se pudo cargar la librería de Excel. Revisa la conexión y reintenta.'); return null; }
    const cands = await cargarCandidatos(dia);
    const filas = filasExcel(cands);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Rendio';
    const ws = wb.addWorksheet('RESPUESTAS', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = COLS.map((h) => ({ header: h, key: h, width: h === 'NOMBRE Y APELLIDO' ? 30 : (h.length < 12 ? 14 : h.length + 4) }));
    ws.getRow(1).font = { bold: true };
    filas.forEach((f) => ws.addRow({
      'NOMBRE Y APELLIDO': f.n, 'FECHA': f.dia.split('-').reverse().join('/'), 'HORA DE PRESENTACIÓN': f.pres, 'HORA DE LLEGADA': f.lleg,
      'VUELO DE LLEGADA': f.vuelo, '¿ES UNA RESERVA?': f.reserva ? 'SI' : 'NO', '¿ES UNA PERNOCTA?': f.pernocta ? 'SI' : 'NO',
      'CONJUNTO': f.zona, 'SECTOR': f.sector, 'TELÉFONO': f.tel }));
    const buf = await wb.xlsx.writeBuffer();
    const nombre = `PROGRAMACIÓN RENDIO ${dia}.xlsx`;
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) { /* */ } }, 1000);
    } catch (e) { say('No se pudo descargar el Excel: ' + ((e && e.message) || 'error')); return null; }
    say(`Excel del ${diaTxt(dia)}: ${filas.length} filas (${cands.length} pedidos).`);
    return { nombre, filas: filas.length, buf };
  }

  // ── 6. El día con la ruta de Julián (Rutas del día, en lugar del tablero) ───
  function diaHTML(vueltas, dia, otras) {
    const vs = (vueltas || []).slice().sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    const libres = vs.filter((v) => !v.driverProfileId && v.status !== 'completed').length;
    let h = `<div class="rj-dia"><div class="rj-dia-h"><div><b>Ruta de Julián · ${esc(diaTxt(dia))}</b><span>${vs.length} vueltas · ${libres ? `${libres} sin tomar` : 'todas tomadas'}</span></div>`
      + '<div class="rj-dia-a"><button class="rv2-btn rv2-btn--sm" data-rj-dia="pegar">Volver a pegar</button><button class="rv2-btn rv2-btn--sm" data-rj-dia="excel">Excel del día</button>'
      + '<button class="rv2-btn rv2-btn--sm" data-rj-dia="quitar">Quitar la ruta</button></div></div>';
    if (otras) h += `<p class="rj-note">Además hay ${otras} ${otras === 1 ? 'vuelta' : 'vueltas'} del tablero publicadas ese día.</p>`;
    vs.forEach((v) => {
      const gente = [...(v.atendidas || []), ...(v.pendientes || [])].sort((a, b) => a.order - b.order);
      const t0 = v.type === 'lle' ? bogHM(v.startAt) : (gente[0] && gente[0].etaAt ? bogHM(gente[0].etaAt) : bogHM(v.startAt));
      const enCurso = v.status === 'in_progress' || (v.atendidas || []).length > 0;
      const estado = v.status === 'completed' ? ['hecha', 'Terminada']
        : enCurso ? ['curso', `En curso · ${esc(v.conductor)}`]
          : v.driverProfileId ? ['tomada', `Tomada por ${esc(v.conductor)}${v.placa ? ' · ' + esc(v.placa) : ''}`]
            : ['libre', 'Disponible'];
      h += `<div class="rj-v" data-st="${estado[0]}"><div class="rj-v-t"><b>${esc(t0)}</b><small>${v.type === 'lle' ? 'Llegada' : 'Salida'}</small></div>`
        + `<div class="rj-v-m"><span>${esc(gente.map((g) => g.name.split(' ')[0]).join(', ') || '—')}</span>`
        + `<small>${esc([v.deadlineAt ? 'Deben estar ' + bogHM(v.deadlineAt) : '', v.nota || '', `${gente.length} ${gente.length === 1 ? 'persona' : 'personas'}`].filter(Boolean).join(' · '))}</small></div>`
        + `<span class="rj-v-st">${estado[1]}</span></div>`;
    });
    return h + '</div>';
  }
  let atadoDia = false;
  function atarDia() {
    if (atadoDia) return;
    const root = document.getElementById('routes-v2'); if (!root) return;
    atadoDia = true;
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-rj-dia]'); if (!b) return;
      const k = b.getAttribute('data-rj-dia');
      if (k === 'pegar') abrir();
      else if (k === 'excel') excel();
      else if (k === 'quitar') {
        const dia = diaActual(); if (!dia) return;
        if (typeof W.confirm === 'function' && !W.confirm(`¿Quitar la ruta de Julián del ${diaTxt(dia)}? Se borran las vueltas que no han arrancado (también las ya tomadas) y el día vuelve al tablero.`)) return;
        try {
          const n = await Api.adminManualRouteClear(dia);
          say(`Se quitaron ${n} vueltas de la ruta de Julián.`);
          if (V2() && typeof V2().cargarDia === 'function') await V2().cargarDia(dia);
        } catch (err) { say('No se pudo quitar: ' + ((err && err.message) || 'error')); }
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', atarDia); else atarDia();

  W.RendioRutaJulian = { abrir, excel, diaHTML, _leer: leer, _emparejar: emparejar, _filasExcel: filasExcel, _st: st, _norm: norm };
})();
