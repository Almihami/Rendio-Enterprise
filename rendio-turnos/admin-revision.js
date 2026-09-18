// admin-revision.js — Admin: Revisión del corte (el vigía del informe de nómina).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
//
// POR QUÉ EXISTE ESTA PANTALLA. El 10-sep-2026 se pagó la quincena
// 25-ago→9-sep y el mismo corte dio CUATRO cifras: 582,3 en pantalla, 582,3 en
// la Hoja 3, 582,4 en la Hoja 1 y 607,7 si uno sumaba a mano la columna "Horas"
// de la Hoja 2. La verdad eran 582,3921 h. Ninguna de las cuatro estaba "mal
// programada": cada superficie redondeaba en un momento distinto de la cadena y
// nadie comparaba una suma contra otra.
//
// Así que esta pantalla NO CALCULA HORAS. Ni una. Todo lo que huela a total sale
// de BalanceCore (admin-balance.js), que es la única cabeza que suma: minutos
// enteros acumulados y un solo redondeo al pintar. Si esta pantalla hiciera su
// propia cuenta, sería el quinto número — exactamente el problema que vino a
// resolver. Lo que sí hace es mirar los turnos del corte y levantar la mano
// cuando un dato no se sostiene solo.
//
// Y el tono importa tanto como el dato: los jefes leen esto. No hay "errores" ni
// culpables; hay UN HECHO Y UNA PREGUNTA. "Turno del jueves sin inspección de
// inicio · 12,0 h · ¿se aprueban las horas?" — nunca "Camilo no hizo la
// inspección". El que revisa decide; la pantalla solo pone el hecho enfrente.
//
// PRIMERA VERSIÓN: SOLO LECTURA. No escribe una sola fila en la base. Las
// decisiones viven en localStorage (ver rvGuardarDecision) mientras nace la
// tabla incidents.

  // ====================================================================
  // Estado del módulo
  // ====================================================================
  const revState = {
    cual: 'curso',      // 'curso' | 'anterior' — cuál corte se está mirando
    corte: null,        // { from, to, label, pagaEl }
    shifts: [],
    inspPorTurno: {},
    fuelPorTurno: {},
    autoCloseHours: null,
    puntos: [],
    selloISO: null,     // el instante exacto en que se leyeron los datos
    cargando: false,
  };

  // Umbrales de las reglas, todos juntos y con nombre. Estaban a punto de quedar
  // regados como números sueltos adentro de cada regla, que es como se pierde el
  // rastro de por qué algo alerta.
  const RV_KM_HUECO = 5;        // km de diferencia entre cierre y apertura que ya no es redondeo
  const RV_KM_ODOMETRO = 5;     // km entre el odómetro de la inspección y el del turno
  const RV_EDITADO_MIN = 2;     // minutos de updated_at por encima de end_at que delatan una edición
  const RV_ABIERTO_VIEJO_H = 18;// horas de turno abierto a partir de las cuales urge
  const RV_KM_CERO_H = 4;       // horas trabajadas con el mismo km que piden explicación
  const RV_LARGO_H = 15;        // turno sospechosamente largo
  const RV_CORTO_H = 3;         // turno sospechosamente corto
  const RV_TANQUEO_MIN = 20000; // COP
  const RV_TANQUEO_MAX = 400000;// COP
  const RV_AUTO_CLOSE_H = 23;   // lo que dice app_settings.auto_close_hours cuando no se puede leer

  const RV_MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const RV_WD = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  // Estilos en línea. El resto del admin pinta con clases scopeadas bajo el id de
  // su panel (#balance-ui .bal-scard, #solic-ui .sol-req); esta pantalla nació en
  // su propio archivo y styles.css es de otra mano, así que los tokens se aplican
  // acá. Son los MISMOS tokens del tema, no colores nuevos: si mañana alguien
  // mueve esto a styles.css bajo #revision-ui, no cambia ni un pixel.
  const RV_CARD = 'background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)';
  const RV_BTN = 'height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--line2);background:var(--panel);font-family:var(--font);font-size:12.5px;font-weight:700;cursor:pointer;color:var(--ink2)';

  // ====================================================================
  // Puente con BalanceCore — la única cabeza que suma
  // ====================================================================
  // Se lee en cada llamada, no se guarda en una constante de módulo: los <script>
  // se leen todos antes de que alguien entre a la pestaña, pero el orden de carga
  // es de index.html y no de este archivo. Congelarlo acá arriba sería apostar.
  const rvBC = () => window.BalanceCore || null;

  // Las tres puertas al cálculo. Todas devuelven null si BalanceCore no está, y
  // null lo entiende el pintado como "este dato hoy no se puede decir". Ninguna
  // tiene plan B: un plan B sería una segunda forma de contar las mismas horas.
  function rvClase(t) { const bc = rvBC(); return bc ? bc.clasificar(t) : null; }
  function rvMin(t) { const bc = rvBC(); return bc ? bc.minutosDe(t) : null; }
  function rvHoras(min) {
    const bc = rvBC();
    if (!bc || min == null) return null;
    return bc.horas(min);
  }
  // Horas ya escritas para meter en una frase ("12,0 h"). Si no hay cálculo
  // disponible el punto se queda sin la cifra, no con una cifra inventada.
  function rvHTxt(min) { const h = rvHoras(min); return h == null ? '' : `${h} h`; }

  // ====================================================================
  // Fechas — Bogotá es UTC-5 y no tiene horario de verano
  // ====================================================================
  const rvP2 = n => String(n).padStart(2, '0');
  const rvBog = s => new Date(new Date(s).getTime() - 5 * 3600000); // leer con getUTC* = leer hora local
  const rvYmd = d => `${d.getUTCFullYear()}-${rvP2(d.getUTCMonth() + 1)}-${rvP2(d.getUTCDate())}`;
  const rvMs = ymd => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const rvDiaSiguiente = ymd => rvYmd(new Date(rvMs(ymd) + 86400000));
  const rvFechaCorta = ymd => { const [, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return `${d} ${RV_MON[m - 1]}`; };
  // "jueves 11-sep 14:02" — el día de la semana es lo que el jefe reconoce; la
  // fecha es lo que le permite ir a buscarlo.
  function rvCuando(iso) {
    if (!iso) return '—';
    const b = rvBog(iso);
    return `${RV_WD[b.getUTCDay()]} ${b.getUTCDate()}-${RV_MON[b.getUTCMonth()]} ${rvP2(b.getUTCHours())}:${rvP2(b.getUTCMinutes())}`;
  }
  function rvHora(iso) {
    if (!iso) return '—';
    const b = rvBog(iso);
    return `${rvP2(b.getUTCHours())}:${rvP2(b.getUTCMinutes())}`;
  }
  const rvNum = n => Number(n || 0).toLocaleString('es-CO');
  const rvCop = n => '$' + Math.round(Number(n || 0)).toLocaleString('es-CO');

  // Antigüedad de un turno abierto, EN MINUTOS ENTEROS. Ojo con confundirla con
  // horas pagables: un turno en curso paga 0 h hasta que cierre, y esta cuenta
  // jamás entra a un total — es la edad del turno, para decir "lleva 19 h abierto"
  // y para medir cuánto le falta al cron. Se pinta con BalanceCore.horas(), que es
  // la misma función que redondea todo lo demás.
  function rvEdadMin(t, ahora) {
    if (!t.start_at) return 0;
    return Math.max(0, Math.round((ahora - new Date(t.start_at).getTime()) / 60000));
  }

  // ── Los cortes ────────────────────────────────────────────────────────────
  // Los pide BalanceCore. El cálculo local de abajo es el paracaídas para que la
  // pestaña no quede en blanco si admin-balance.js todavía no cargó, y hace UNA
  // sola cosa: fechas de calendario (25→9 y 10→24, que son fijas y las decidió el
  // dueño). Nunca horas. Esa asimetría es a propósito: dos pantallas que difieran
  // en la fecha del corte se nota al instante; dos que difieran en las horas es lo
  // que pasó el 10-sep y nadie lo vio hasta que ya estaba pagado.
  // Recibe un DÍA DE CALENDARIO ('YYYY-MM-DD'), no un instante: un instante hay
  // que pasarlo a día de Bogotá antes de entrar acá (rvHoyYmd), y mezclar las dos
  // cosas es como se corren los cortes un día en las noches.
  function rvCorteFechas(ymd) {
    const b = new Date(rvMs(ymd));
    const y = b.getUTCFullYear(), m = b.getUTCMonth(), d = b.getUTCDate();
    let ini, fin;
    if (d >= 25) { ini = Date.UTC(y, m, 25); fin = Date.UTC(y, m + 1, 9); }
    else if (d <= 9) { ini = Date.UTC(y, m - 1, 25); fin = Date.UTC(y, m, 9); }
    else { ini = Date.UTC(y, m, 10); fin = Date.UTC(y, m, 24); }
    const from = rvYmd(new Date(ini)), to = rvYmd(new Date(fin));
    return { from, to, label: `${rvFechaCorta(from)} – ${rvFechaCorta(to)}`, pagaEl: rvDiaSiguiente(to) };
  }
  const rvHoyYmd = () => rvYmd(rvBog(new Date().toISOString()));
  function rvCorteEnCurso() {
    const bc = rvBC();
    if (bc && typeof bc.corteEnCurso === 'function') return bc.corteEnCurso();
    return rvCorteFechas(rvHoyYmd());
  }
  function rvCorteAnterior() {
    const bc = rvBC();
    if (bc && typeof bc.corteAnterior === 'function') return bc.corteAnterior();
    // El día anterior al arranque del corte en curso cae, por definición, dentro
    // del corte anterior.
    return rvCorteFechas(rvYmd(new Date(rvMs(rvCorteEnCurso().from) - 86400000)));
  }

  // "día 3 de 15". Un corte terminado se queda en su último día en vez de seguir
  // contando hacia arriba, que es lo que confundía al mirar el corte anterior.
  function rvDiaDelCorte(corte) {
    const total = Math.round((rvMs(corte.to) - rvMs(corte.from)) / 86400000) + 1;
    const hoy = rvMs(rvHoyYmd());
    const n = Math.round((hoy - rvMs(corte.from)) / 86400000) + 1;
    return { n: Math.min(total, Math.max(1, n)), total, terminado: hoy > rvMs(corte.to) };
  }

  // ====================================================================
  // Las reglas — funciones puras, cada una devuelve un punto o null
  // ====================================================================
  // Un punto es { clave, severidad, titulo, detalle }. Viajan además `ancla`
  // (a qué turno se le pega la decisión), `pid` (profile_id de la persona, NUNCA
  // driver_id) y `quien` (el nombre para pintar). La severidad manda a qué bloque
  // cae: 'resolver' bloquea cerrar el corte, 'confirmar' no, 'curso' es informe.
  //
  // Nadie de acá pregunta por el tanqueo faltante: el tanqueo es OPCIONAL y esta
  // pantalla no lo va a volver obligatorio por la puerta de atrás.

  function rvQuien(t) {
    const dp = t.driver_profiles || {};
    return {
      pid: dp.profile_id || null,
      nombre: (dp.profiles && dp.profiles.full_name) || 'Conductor',
    };
  }
  // CONVENIO DE ESCAPES, que si se mezcla se nota tarde y feo: `titulo` viaja en
  // TEXTO PLANO y lo escapa el pintado; `detalle` viaja ya en HTML, así que todo
  // lo que venga de la base se escapa acá adentro, al escribir la frase.
  function rvCarro(t) {
    const v = t.vehicles || {};
    return v.internal_code || v.license_plate || 'Carro sin identificar';
  }
  function rvPunto(t, clave, severidad, titulo, detalle, ancla) {
    const q = rvQuien(t);
    return { clave, severidad, titulo, detalle, ancla: ancla || t.id, pid: q.pid, quien: q.nombre, cuando: t.start_at };
  }

  // ── Por resolver ──────────────────────────────────────────────────────────

  // Hueco POSITIVO entre el cierre de un turno y la apertura del siguiente del
  // MISMO carro. Se redacta como "¿quién movió el carro?" y no como algo para
  // descontarle a nadie: esos kilómetros son horas que alguien manejó y que hoy
  // nadie está cobrando. Es el caso de los 167 km del 10-sep.
  function reglaKmSinTurno(par) {
    const { prev, next } = par;
    if (prev.closing_km == null || next.opening_km == null) return null;
    const hueco = Number(next.opening_km) - Number(prev.closing_km);
    if (!(hueco > RV_KM_HUECO)) return null;
    const qp = rvQuien(prev);
    return rvPunto(next, 'km_sin_turno', 'resolver',
      `${rvCarro(next)} · ${rvNum(hueco)} km entre dos turnos`,
      `Cerró el ${rvCuando(prev.end_at)} en ${rvNum(prev.closing_km)} km con ${escapeHtml(qp.nombre)} y volvió a abrir el ${rvCuando(next.start_at)} en ${rvNum(next.opening_km)} km. Son ${rvNum(hueco)} km que alguien manejó y que nadie está cobrando · ¿de quién fue ese recorrido?`,
      `${prev.id}~${next.id}`);
  }

  // El siguiente turno abre por debajo del cierre anterior. Un odómetro no
  // retrocede, así que uno de los dos números está tecleado de memoria.
  function reglaKmRetroceso(par) {
    const { prev, next } = par;
    if (prev.closing_km == null || next.opening_km == null) return null;
    const baja = Number(prev.closing_km) - Number(next.opening_km);
    if (!(baja > 0)) return null;
    return rvPunto(next, 'km_retroceso', 'resolver',
      `${rvCarro(next)} · el odómetro bajó ${rvNum(baja)} km`,
      `El turno anterior cerró en ${rvNum(prev.closing_km)} km (${rvCuando(prev.end_at)}) y este abrió en ${rvNum(next.opening_km)} km. Un odómetro no retrocede · ¿cuál de los dos números se tecleó mal?`,
      `${prev.id}~${next.id}`);
  }

  // El mismo par (apertura, cierre) en dos turnos distintos, o una apertura
  // idéntica a la de otra placa. Ahí no hay una lectura del tablero: hay una copia.
  function reglaKmRepetido(t, ctx) {
    if (t.opening_km == null) return null;
    const gemelo = (ctx.parRepetido[`${t.opening_km}|${t.closing_km}`] || []).find(o => o.id !== t.id);
    if (gemelo && t.closing_km != null) {
      const qg = rvQuien(gemelo);
      return rvPunto(t, 'km_repetido', 'resolver',
        `${rvCarro(t)} · kilometraje calcado de otro turno`,
        `Abre en ${rvNum(t.opening_km)} km y cierra en ${rvNum(t.closing_km)} km, los mismos dos números del turno de ${escapeHtml(qg.nombre)} del ${rvCuando(gemelo.start_at)} · ¿cuál fue el kilometraje real de este turno?`);
    }
    const otraPlaca = (ctx.aperturaRepetida[String(t.opening_km)] || [])
      .find(o => o.id !== t.id && o.vehicle_id && t.vehicle_id && o.vehicle_id !== t.vehicle_id);
    if (otraPlaca) {
      return rvPunto(t, 'km_repetido', 'resolver',
        `Dos carros abriendo en el mismo kilometraje`,
        `${escapeHtml(rvCarro(t))} abrió en ${rvNum(t.opening_km)} km el ${rvCuando(t.start_at)} y ${escapeHtml(rvCarro(otraPlaca))} abrió exactamente en el mismo número · ¿de cuál de los dos tableros salió esa lectura?`);
    }
    return null;
  }

  // Turno pagable sin la inspección que abre el turno. No se pregunta por qué no
  // la hizo: se pregunta si las horas se aprueban igual, que es lo que hay que
  // decidir hoy.
  function reglaSinInspeccionInicial(t, ctx) {
    if (rvClase(t) !== 'ok') return null;
    const ins = ctx.inspPorTurno[t.id] || [];
    if (ins.some(i => i.kind === 'initial')) return null;
    const h = rvHTxt(rvMin(t));
    return rvPunto(t, 'sin_inspeccion_inicial', 'resolver',
      `Turno del ${RV_WD[rvBog(t.start_at).getUTCDay()]} sin inspección de inicio`,
      `${escapeHtml(rvQuien(t).nombre)} · ${rvCuando(t.start_at)}${h ? ' · ' + h : ''} · el turno se abrió y se cerró, pero no quedó la inspección de inicio · ¿se aprueban las horas?`);
  }

  // Clase 'auto': lo cerró el cron (auto_close_stale_shifts) o un admin
  // (force_close_shift). OJO, porque el comentario viejo del balance decía que
  // esas horas "quedan topeadas" y es falso: las dos funciones ponen
  // end_at = now(), o sea el instante del cron o del clic. Por eso acá se muestra
  // la hora de cierre que quedó escrita, para que el que decide vea de dónde sale
  // la cifra. Hoy esas horas NO se pagan.
  function reglaAutoCerrado(t) {
    if (rvClase(t) !== 'auto') return null;
    const h = rvHTxt(rvMin(t));
    return rvPunto(t, 'auto_cerrado', 'resolver',
      `Turno que cerró el sistema, no el conductor`,
      `${escapeHtml(rvQuien(t).nombre)} · abrió el ${rvCuando(t.start_at)} y el cierre se lo puso el sistema a las ${rvHora(t.end_at)} (sin kilometraje de cierre)${h ? `, o sea ${h}` : ''}. Hoy esas horas no entran al pago · ¿se le reconocen?`);
  }

  // Turno abierto con más de 18 h. Lo importante no es que esté abierto: es que
  // el cron viene en camino, y cuando pase lo cierra con la hora del momento y el
  // turno se vuelve 'auto', que hoy no se paga. Eso es lo que hay que alcanzar a
  // decidir antes.
  function reglaTurnoAbiertoViejo(t, ctx) {
    if (rvClase(t) !== 'curso') return null;
    const edad = rvEdadMin(t, ctx.ahora);
    if (edad <= RV_ABIERTO_VIEJO_H * 60) return null;
    const faltan = ctx.autoCloseHours * 60 - edad;
    const hEdad = rvHTxt(edad), hFaltan = rvHTxt(Math.max(0, faltan));
    // Cuando ya pasó de las horas del cron, el turno no está "por barrer": está en
    // la cola, y el próximo paso se lo lleva. Decirlo como "dentro de 0 h" es
    // decirlo mal.
    const reloj = faltan <= 0
      ? `El cierre automático (${ctx.autoCloseHours} h) ya lo tiene en la cola: en la próxima pasada`
      : `El cierre automático entra a las ${ctx.autoCloseHours} h${hFaltan ? `, o sea dentro de ${hFaltan}` : ''}: cuando pase,`;
    return rvPunto(t, 'turno_abierto_viejo', 'resolver',
      `Turno abierto desde hace ${hEdad || 'más de ' + RV_ABIERTO_VIEJO_H + ' h'}`,
      `${escapeHtml(rvQuien(t).nombre)} abrió el ${rvCuando(t.start_at)} y el turno sigue abierto. ${reloj} le pone la hora de cierre del momento y el turno deja de contar como pagable · ¿se cierra a mano antes?`);
  }

  // updated_at por encima de end_at: el registro se tocó después de cerrado. Dos
  // minutos de margen porque el propio cierre escribe las dos marcas casi juntas.
  function reglaEditadoDespuesDeCerrar(t) {
    if (!t.end_at || !t.updated_at) return null;
    const dif = Math.round((new Date(t.updated_at).getTime() - new Date(t.end_at).getTime()) / 60000);
    if (dif <= RV_EDITADO_MIN) return null;
    const cuanto = dif < 60 ? `${dif} min` : rvHTxt(dif) || `${dif} min`;
    return rvPunto(t, 'editado_despues_de_cerrar', 'resolver',
      `Turno editado después de cerrado`,
      `${escapeHtml(rvQuien(t).nombre)} · cerró el ${rvCuando(t.end_at)} y el registro se volvió a tocar ${cuanto} más tarde · ¿qué se ajustó y con qué respaldo?`);
  }

  // ── Por confirmar ─────────────────────────────────────────────────────────

  // Trabajó horas y el carro marcó los mismos kilómetros al abrir y al cerrar.
  function reglaKmCero(t) {
    if (rvClase(t) !== 'ok') return null;
    if (t.opening_km == null || t.closing_km == null) return null;
    if (Number(t.opening_km) !== Number(t.closing_km)) return null;
    const min = rvMin(t);
    if (min == null || min <= RV_KM_CERO_H * 60) return null;
    return rvPunto(t, 'km_cero', 'confirmar',
      `${rvHTxt(min)} con el carro en el mismo kilometraje`,
      `${escapeHtml(rvQuien(t).nombre)} · ${escapeHtml(rvCarro(t))} · abrió y cerró en ${rvNum(t.opening_km)} km el ${rvCuando(t.start_at)} · ¿el carro de verdad no se movió, o el cierre se copió de la apertura?`);
  }

  // Duración fuera de lo que dura un turno normal, por arriba o por abajo.
  function reglaDuracionRara(t) {
    if (rvClase(t) !== 'ok') return null;
    const min = rvMin(t);
    if (min == null) return null;
    const largo = min > RV_LARGO_H * 60, corto = min < RV_CORTO_H * 60;
    if (!largo && !corto) return null;
    return rvPunto(t, 'duracion_rara', 'confirmar',
      `Turno de ${rvHTxt(min)}`,
      largo
        ? `${escapeHtml(rvQuien(t).nombre)} · ${rvCuando(t.start_at)} → ${rvCuando(t.end_at)}. Es más de lo que dura una jornada · ¿alcanzó a cerrar tarde o de verdad manejó todo eso?`
        : `${escapeHtml(rvQuien(t).nombre)} · ${rvCuando(t.start_at)} → ${rvCuando(t.end_at)}. Es menos de lo que dura una jornada · ¿fue un relevo corto o el turno se cerró antes de tiempo?`);
  }

  // El odómetro de la inspección inicial contra el kilometraje del turno. Es la
  // ÚNICA lectura del tablero capturada en otra pantalla, en otro momento y con
  // foto al lado: cuando estos dos números no coinciden, hay uno que sí se puede
  // verificar mirando la foto.
  function reglaOdometroNoCoincide(t, ctx) {
    const ini = (ctx.inspPorTurno[t.id] || []).find(i => i.kind === 'initial' && i.odometer_km != null);
    if (!ini || t.opening_km == null) return null;
    const dif = Math.abs(Number(ini.odometer_km) - Number(t.opening_km));
    if (!(dif > RV_KM_ODOMETRO)) return null;
    return rvPunto(t, 'odometro_no_coincide', 'confirmar',
      `La inspección y el turno no leen el mismo odómetro (${rvNum(dif)} km)`,
      `${escapeHtml(rvQuien(t).nombre)} · ${escapeHtml(rvCarro(t))} · la inspección de inicio (con foto) anotó ${rvNum(ini.odometer_km)} km y el turno abrió con ${rvNum(t.opening_km)} km · ¿cuál de los dos se queda?`);
  }

  // Inspección inicial sin una sola foto. El umbral NO está quemado: el número de
  // fotos por inspección cambió tres veces en la historia de la app, así que se
  // mira qué es lo normal EN ESTE CORTE y se compara contra eso. Si en el corte
  // ninguna inspección trajo fotos, no hay contra qué comparar y la regla se
  // calla: acusar sin patrón es inventarse el patrón.
  function reglaInspeccionSinFotos(t, ctx) {
    if (!ctx.tipicoFotos) return null;
    const ini = (ctx.inspPorTurno[t.id] || []).find(i => i.kind === 'initial');
    if (!ini || Number(ini.photoCount || 0) > 0) return null;
    return rvPunto(t, 'inspeccion_sin_fotos', 'confirmar',
      `Inspección de inicio sin fotos`,
      `${escapeHtml(rvQuien(t).nombre)} · ${rvCuando(t.start_at)} · en este corte lo normal son ${ctx.tipicoFotos} foto(s) por inspección y esta llegó sin ninguna · ¿se pide de nuevo o se da por buena?`);
  }

  // Tanqueo por un monto que se sale de lo que se tanquea acá. NO es un reclamo
  // por no tanquear: el tanqueo es opcional y así se queda.
  function reglaTanqueoRaro(t, ctx) {
    const recibos = ctx.fuelPorTurno[t.id] || [];
    // Se buscan TODOS los que se salen, no el primero. Un turno puede traer dos
    // recibos raros y con un solo `find` el segundo no aparecía en ninguna parte
    // de la pantalla: la decisión se guardaba contra el primero y el otro quedaba
    // pagado sin que nadie lo hubiera visto. La regla sigue devolviendo UN punto
    // por turno (el contrato es un punto o null), pero dice cuántos hay.
    const raros = recibos.filter(r => Number(r.amount_cop) < RV_TANQUEO_MIN || Number(r.amount_cop) > RV_TANQUEO_MAX);
    if (!raros.length) return null;
    const raro = raros[0];
    const bajo = Number(raro.amount_cop) < RV_TANQUEO_MIN;
    const otros = raros.length - 1;
    const montos = raros.slice(1).map(r => rvCop(r.amount_cop)).join(', ');
    return rvPunto(t, 'tanqueo_raro', 'confirmar',
      `Tanqueo de ${rvCop(raro.amount_cop)}${otros ? ` (y ${otros} más en el mismo turno)` : ''}`,
      `${escapeHtml(rvQuien(t).nombre)} · ${escapeHtml(rvCarro(t))} · turno del ${rvCuando(t.start_at)}. ${bajo
        ? `Es menos de ${rvCop(RV_TANQUEO_MIN)} · ¿fue un tanqueo parcial o el recibo quedó digitado incompleto?`
        : `Es más de ${rvCop(RV_TANQUEO_MAX)} · ¿el recibo es de este carro o entraron varios en uno?`}${otros
        ? ` En el mismo turno hay ${otros} recibo(s) más fuera de rango (${montos}): la respuesta los cubre a todos.`
        : ''}`,
      `${t.id}~${raro.id}`);
  }

  // ── En curso ──────────────────────────────────────────────────────────────

  // No es una falla: es el aviso de por qué la cifra de arriba se mueve. Un turno
  // sin cierre cuenta 0 h, y por eso el informe generado la noche del 9 mostraba
  // 22,7 h menos que el mismo informe generado a la mañana siguiente.
  function reglaTurnoAbierto(t, ctx) {
    if (rvClase(t) !== 'curso') return null;
    const edad = rvEdadMin(t, ctx.ahora);
    const h = rvHTxt(edad);
    return rvPunto(t, 'turno_abierto', 'curso',
      `${rvQuien(t).nombre} lleva ${h || 'el turno'} abierto`,
      `Abrió el ${rvCuando(t.start_at)} con ${escapeHtml(rvCarro(t))}. Mientras no cierre, este turno suma 0 h al corte: la cifra de arriba va a subir cuando cierre.`);
  }

  // ====================================================================
  // Armado de los puntos
  // ====================================================================
  // Una sola pasada, un solo lugar donde se decide el orden. Los puntos salen
  // ordenados por severidad y, dentro de cada bloque, por fecha del turno: el
  // que revisa baja por la lista como bajaría por el calendario.
  function rvArmarPuntos() {
    const shifts = revState.shifts || [];
    const ahora = Date.now();

    // Índices para las reglas de kilometraje. Se arman una vez acá y no adentro
    // de cada regla: una regla pura no debería recorrer 300 turnos por turno.
    const parRepetido = {}, aperturaRepetida = {};
    shifts.forEach(t => {
      if (t.opening_km == null) return;
      (parRepetido[`${t.opening_km}|${t.closing_km}`] = parRepetido[`${t.opening_km}|${t.closing_km}`] || []).push(t);
      (aperturaRepetida[String(t.opening_km)] = aperturaRepetida[String(t.opening_km)] || []).push(t);
    });

    // Lo normal de fotos EN ESTE CORTE = la mediana de las inspecciones iniciales
    // que sí trajeron fotos. Mediana y no promedio: una sola inspección con doce
    // fotos no puede mover la vara para todas las demás.
    const conteos = [];
    Object.keys(revState.inspPorTurno).forEach(id => {
      (revState.inspPorTurno[id] || []).forEach(i => {
        if (i.kind === 'initial' && Number(i.photoCount || 0) > 0) conteos.push(Number(i.photoCount));
      });
    });
    conteos.sort((a, b) => a - b);
    const tipicoFotos = conteos.length ? conteos[Math.floor(conteos.length / 2)] : 0;

    const ctx = {
      inspPorTurno: revState.inspPorTurno,
      fuelPorTurno: revState.fuelPorTurno,
      parRepetido, aperturaRepetida, tipicoFotos, ahora,
      autoCloseHours: revState.autoCloseHours || RV_AUTO_CLOSE_H,
    };

    const puntos = [];
    const empujar = p => { if (p) puntos.push(p); };

    // Reglas de turno.
    shifts.forEach(t => {
      empujar(reglaKmRepetido(t, ctx));
      empujar(reglaSinInspeccionInicial(t, ctx));
      empujar(reglaAutoCerrado(t));
      empujar(reglaTurnoAbiertoViejo(t, ctx));
      empujar(reglaEditadoDespuesDeCerrar(t));
      empujar(reglaKmCero(t));
      empujar(reglaDuracionRara(t));
      empujar(reglaOdometroNoCoincide(t, ctx));
      empujar(reglaInspeccionSinFotos(t, ctx));
      empujar(reglaTanqueoRaro(t, ctx));
      empujar(reglaTurnoAbierto(t, ctx));
    });

    // Reglas de encadenado por vehículo: se comparan turnos consecutivos del
    // MISMO carro, en orden de arranque. Los turnos sin kilometraje de apertura
    // (arranques falsos) no encadenan nada y se saltan, o cada reserva expirada
    // abriría un hueco falso.
    const porVehiculo = {};
    shifts.forEach(t => {
      if (!t.vehicle_id || t.opening_km == null) return;
      (porVehiculo[t.vehicle_id] = porVehiculo[t.vehicle_id] || []).push(t);
    });
    Object.keys(porVehiculo).forEach(vid => {
      const lista = porVehiculo[vid].slice().sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
      for (let i = 1; i < lista.length; i++) {
        const par = { prev: lista[i - 1], next: lista[i] };
        empujar(reglaKmSinTurno(par));
        empujar(reglaKmRetroceso(par));
      }
    });

    const orden = { resolver: 0, confirmar: 1, curso: 2 };
    puntos.sort((a, b) => orden[a.severidad] - orden[b.severidad]
      || new Date(a.cuando || 0) - new Date(b.cuando || 0));
    revState.puntos = puntos;
  }

  // ====================================================================
  // Decisiones — hoy en localStorage
  // ====================================================================
  // TODO (versión definitiva): esto va a la tabla `incidents`, con quién decidió,
  // cuándo y sobre qué turno, para que la decisión sobreviva al navegador y para
  // que el cierre del corte pueda exigirla. Mientras tanto vive en el equipo del
  // que revisa: si abre la pantalla en otro computador, la lista le aparece
  // completa otra vez. Es a propósito — antes que una decisión a medio guardar en
  // la base, una decisión que claramente todavía no está guardada.
  const RV_LS = 'rendio.revision.';
  function rvClaveDecision(punto) {
    const c = revState.corte || { from: '?', to: '?' };
    return `${RV_LS}${c.from}_${c.to}.${punto.clave}.${punto.ancla}`;
  }
  function rvLeerDecision(punto) {
    try {
      const raw = localStorage.getItem(rvClaveDecision(punto));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function rvGuardarDecision(punto, valor) {
    try {
      localStorage.setItem(rvClaveDecision(punto), JSON.stringify({ v: valor, at: new Date().toISOString() }));
    } catch (e) { /* navegador sin almacenamiento: la decisión dura lo que la pantalla */ }
  }
  function rvBorrarDecision(punto) {
    try { localStorage.removeItem(rvClaveDecision(punto)); } catch (e) { /* ídem */ }
  }

  // Las dos respuestas posibles de cada punto. Son respuestas a LA pregunta del
  // punto, no un "aprobar/rechazar" genérico: el que revisa está contestando algo
  // concreto y el botón tiene que decirlo.
  const RV_OPCIONES = {
    km_sin_turno: ['Ya sé quién fue', 'Queda en investigación'],
    km_retroceso: ['Corrijo el kilometraje', 'Queda en investigación'],
    km_repetido: ['Corrijo el kilometraje', 'Queda en investigación'],
    sin_inspeccion_inicial: ['Sí, se aprueban las horas', 'No, se revisa con él'],
    auto_cerrado: ['Sí, se le reconocen', 'No se pagan'],
    turno_abierto_viejo: ['Lo cierro a mano', 'Que lo cierre el sistema'],
    editado_despues_de_cerrar: ['El ajuste está sustentado', 'Queda en investigación'],
    km_cero: ['El carro no se movió', 'Se corrige el cierre'],
    duracion_rara: ['Así fue la jornada', 'Se revisa con él'],
    odometro_no_coincide: ['Vale el de la inspección', 'Vale el del turno'],
    inspeccion_sin_fotos: ['Se da por buena', 'Se pide de nuevo'],
    tanqueo_raro: ['El recibo está bien', 'Se pide el soporte'],
    turno_abierto: ['Ya lo vi'],
  };

  // ====================================================================
  // Pintado
  // ====================================================================
  const RV_BLOQUES = [
    { sev: 'resolver', titulo: 'Por resolver', nota: 'Mientras haya algo acá, el corte no se cierra.' },
    { sev: 'confirmar', titulo: 'Por confirmar', nota: 'No bloquean el cierre, pero alguien tiene que decir que sí.' },
    { sev: 'curso', titulo: 'En curso', nota: 'Turnos todavía abiertos: hoy suman 0 h y la cifra de arriba va a cambiar cuando cierren.' },
  ];

  function rvPuntoHtml(p) {
    const dec = rvLeerDecision(p);
    const opciones = RV_OPCIONES[p.clave] || ['Ya lo vi'];
    const avt = p.pid
      ? `<span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;font-size:10.5px;font-weight:800;color:#fff;flex:0 0 auto;text-transform:uppercase;background:${colorOfId(p.pid)}">${escapeHtml(initialsOf(p.quien))}</span>`
      : '';
    const acciones = dec
      ? `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--green)"><svg class="icon" style="width:14px;height:14px"><use href="#i-check"/></svg>${escapeHtml(dec.v)}</span>
         <button style="${RV_BTN};height:30px;padding:0 10px;font-size:11.5px" data-rv-undo="${escapeHtml(p.clave + '|' + p.ancla)}">Deshacer</button>`
      : opciones.map((o, i) => `<button style="${RV_BTN}${i === 0 ? ';color:var(--green);border-color:color-mix(in srgb,var(--green) 40%,var(--line2))' : ''}" data-rv-dec="${escapeHtml(p.clave + '|' + p.ancla)}" data-rv-val="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('');
    return `<div style="display:flex;gap:12px;align-items:flex-start;padding:13px 18px;border-top:1px solid var(--line)${dec ? ';opacity:.6' : ''}">
      ${avt}
      <div style="flex:1;min-width:0">
        <b style="font-size:13.5px;font-weight:800;color:var(--ink);display:block">${escapeHtml(p.titulo)}</b>
        <div style="font-size:12.5px;color:var(--ink2);line-height:1.5;margin-top:3px">${p.detalle}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:9px">${acciones}</div>
      </div>
    </div>`;
  }

  function rvBloqueHtml(b) {
    const puntos = revState.puntos.filter(p => p.severidad === b.sev);
    const pendientes = puntos.filter(p => !rvLeerDecision(p)).length;
    const personas = new Set(puntos.map(p => p.pid).filter(Boolean)).size;
    const color = b.sev === 'resolver' ? 'var(--red)' : (b.sev === 'confirmar' ? 'var(--amber)' : 'var(--ink3)');
    const soft = b.sev === 'resolver' ? 'var(--red-soft)' : (b.sev === 'confirmar' ? 'var(--amber-soft)' : 'var(--panel2)');
    const cuerpo = puntos.length
      ? puntos.map(rvPuntoHtml).join('')
      : `<div style="padding:22px 18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--ink3)">Nada por acá en este corte.</div>`;
    return `<div style="${RV_CARD};overflow:hidden;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;background:var(--panel2)">
        <span style="display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:24px;padding:0 9px;border-radius:999px;font-family:var(--mono);font-size:12px;font-weight:700;background:${soft};color:${color}">${puntos.length}</span>
        <b style="font-size:14.5px;font-weight:800;letter-spacing:-.01em;color:var(--ink)">${b.titulo}</b>
        <span style="font-size:12px;color:var(--ink2)">${escapeHtml(b.nota)}</span>
        ${puntos.length ? `<span style="margin-left:auto;font-size:11.5px;color:var(--ink3)">${pendientes} sin decidir · ${personas} persona(s)</span>` : ''}
      </div>
      ${cuerpo}
    </div>`;
  }

  function rvCabeceraHtml() {
    const c = revState.corte;
    const d = rvDiaDelCorte(c);
    const dia = d.terminado ? `corte terminado (${d.total} días)` : `día ${d.n} de ${d.total}`;
    return `<div class="rl-phead" style="margin-bottom:18px">
      <h1 style="font-size:27px;font-weight:800;letter-spacing:-.03em;line-height:1;color:var(--ink)">Revisión del corte</h1>
      <p style="font-size:13px;color:var(--ink2);margin-top:7px;max-width:660px;line-height:1.4">
        <b style="color:var(--ink)">Corte ${escapeHtml(c.label)}</b> · ${dia} · se paga el ${escapeHtml(rvFechaCorta(c.pagaEl))}.
        Lo que hay que decidir antes de que la quincena se pague, con el hecho al lado.
      </p>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button style="${RV_BTN}${revState.cual === 'curso' ? ';color:var(--ink);border-color:var(--ink);font-weight:800' : ''}" data-rv-corte="curso">Corte en curso</button>
        <button style="${RV_BTN}${revState.cual === 'anterior' ? ';color:var(--ink);border-color:var(--ink);font-weight:800' : ''}" data-rv-corte="anterior">Corte anterior</button>
        <div style="flex:1"></div>
        <button style="${RV_BTN}" data-rv-refrescar><svg class="icon" style="width:13px;height:13px;vertical-align:-2px"><use href="#i-refresh"/></svg> Volver a leer</button>
      </div>
    </div>`;
  }

  // LA CIFRA. Una sola, y no sale de acá: sale de BalanceCore.minutosPagables +
  // BalanceCore.horas, las mismas dos funciones que usa el informe que se paga.
  // Se pinta tal cual las devuelve, sin volver a formatearla, porque cualquier
  // retoque de acá es una quinta versión del mismo número.
  function rvCifraHtml() {
    const bc = rvBC();
    const sello = revState.selloISO ? rvHora(revState.selloISO) : '—';
    if (!bc) {
      return `<div style="${RV_CARD};padding:16px 18px;margin-bottom:16px;border-color:color-mix(in srgb,var(--amber) 40%,var(--line))">
        <b style="font-size:13.5px;color:var(--ink)">Sin total en esta pantalla</b>
        <div style="font-size:12.5px;color:var(--ink2);line-height:1.5;margin-top:4px">
          El módulo que suma las horas (<b>BalanceCore</b>) no está cargado, así que acá abajo va el detalle sin ninguna cifra total.
          Antes que mostrar un número calculado por otra cabeza, ninguno: el 10-sep hubo cuatro y esa es toda la historia de esta pantalla.
        </div>
      </div>`;
    }
    const horas = bc.horas(bc.minutosPagables(revState.shifts || []));
    const abiertos = (revState.shifts || []).filter(t => bc.clasificar(t) === 'curso').length;
    const nota = abiertos
      ? `${abiertos} turno(s) siguen abiertos y hoy suman 0 h: esta cifra sube cuando cierren.`
      : 'Todos los turnos del corte están cerrados.';
    return `<div style="${RV_CARD};padding:20px 22px;margin-bottom:16px;background:linear-gradient(180deg,var(--panel),var(--orange-soft));border-color:color-mix(in srgb,var(--orange) 26%,var(--line))">
      <div style="font-size:11.5px;font-weight:700;color:var(--ink2)">Horas pagables acumuladas del corte</div>
      <div style="font-size:44px;font-weight:800;letter-spacing:-.03em;line-height:1.05;color:var(--orange);font-variant-numeric:tabular-nums;margin-top:4px">${horas}<s style="font-size:20px;color:var(--ink3);text-decoration:none;font-weight:700"> h</s></div>
      <div style="font-size:12px;color:var(--ink2);margin-top:6px">Calculado hoy ${escapeHtml(sello)} · ${escapeHtml(nota)}</div>
      ${typeof rdWhy === 'function' ? rdWhy('¿Por qué este número y no otro?',
        'Sale de <b>BalanceCore</b>, la misma función que usa el informe de nómina: suma minutos enteros de los turnos que el conductor <b>abrió y cerró</b>, y redondea <b>una sola vez</b>, al pintar. Esta pantalla no vuelve a sumar nada por su cuenta. Los turnos que cerró el sistema (auto-cerrados) no entran, y los que siguen abiertos suman 0 h hasta que cierren — por eso la cifra puede subir de una hora a otra, y por eso arriba dice a qué hora se calculó.') : ''}
    </div>`;
  }

  function rvPieHtml() {
    const faltan = revState.puntos.filter(p => p.severidad === 'resolver' && !rvLeerDecision(p)).length;
    const puede = faltan === 0;
    return `<div style="${RV_CARD};padding:16px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <button id="rv-cerrar" ${puede ? '' : 'disabled'} style="height:42px;padding:0 20px;border-radius:11px;border:0;font-family:var(--font);font-size:13.5px;font-weight:800;color:#fff;background:${puede ? 'var(--green)' : 'var(--ink3)'};cursor:${puede ? 'pointer' : 'not-allowed'};opacity:${puede ? '1' : '.55'}">Cerrar el corte</button>
      <span style="font-size:12.5px;color:var(--ink2);line-height:1.5;flex:1;min-width:220px">
        ${puede
          ? 'Todo lo de <b>Por resolver</b> quedó decidido. El cierre contable de verdad llega después del 25: por ahora esta pantalla solo dice que ya se puede.'
          : `Faltan <b>${faltan}</b> punto(s) en <b>Por resolver</b>. Cada uno necesita una respuesta antes de cerrar.`}
      </span>
    </div>`;
  }

  function rvPintar() {
    const ui = $('#revision-ui');
    if (!ui) return;
    ui.innerHTML = rvCabeceraHtml() + rvCifraHtml()
      + RV_BLOQUES.map(rvBloqueHtml).join('')
      + rvPieHtml();
  }

  // ====================================================================
  // Carga
  // ====================================================================
  async function renderRevision() {
    rvBindRevision();
    const ui = $('#revision-ui');
    if (!ui) return;
    if (revState.cargando) return;
    revState.cargando = true;
    revState.corte = revState.cual === 'anterior' ? rvCorteAnterior() : rvCorteEnCurso();
    ui.innerHTML = rvCabeceraHtml() + `<div style="${RV_CARD};padding:40px 24px;text-align:center;color:var(--ink3);font-size:13px">Leyendo el corte…</div>`;
    try {
      const c = revState.corte;
      // El turno pertenece al día en que ARRANCÓ, así que el rango filtra por
      // start_at y llega hasta las 00:00 del día siguiente al "hasta": el turno
      // que arranca el 9 a las 14:02 y cierra el 10 a las 02:03 es del 9 y se
      // paga en este corte.
      const shifts = await Api.listShiftsForReview(
        `${c.from}T00:00:00-05:00`, `${rvDiaSiguiente(c.to)}T00:00:00-05:00`);
      const ids = shifts.map(s => s.id);
      const [insps, fuels, settings] = await Promise.all([
        Api.listInspectionsForShifts(ids),
        Api.listFuelReceiptsForShifts(ids),
        Api.getSettings().catch(() => null),
      ]);
      const porTurno = (rows, destino) => {
        rows.forEach(r => { (destino[r.shift_id] = destino[r.shift_id] || []).push(r); });
        return destino;
      };
      revState.shifts = shifts;
      revState.inspPorTurno = porTurno(insps || [], {});
      revState.fuelPorTurno = porTurno(fuels || [], {});
      const ach = Number((settings && settings.auto_close_hours) != null
        ? settings.auto_close_hours
        : (state.settings && state.settings.auto_close_hours));
      revState.autoCloseHours = Number.isFinite(ach) && ach > 0 ? ach : RV_AUTO_CLOSE_H;
      // El sello se pone DESPUÉS de traer todo: es la hora de los datos que están
      // en pantalla, no la hora en que se abrió la pestaña. Media hora de
      // diferencia en un corte que se mueve solo no es un detalle.
      revState.selloISO = new Date().toISOString();
      rvArmarPuntos();
      rvPintar();
    } catch (e) {
      // El detalle técnico se queda en la consola A PROPÓSITO. En esta pantalla
      // no va ni una palabra de jerga: el que la lee es el jefe que va a pagar la
      // quincena, y lo único que necesita saber es que la lista de abajo no
      // alcanzó a llegar completa y que no debe decidir con ella. Pegar el
      // mensaje crudo de la librería además metía la palabra "error" en pantalla,
      // que es justo lo que esta pantalla no dice en ninguna parte.
      console.error('revision del corte', e);
      ui.innerHTML = rvCabeceraHtml()
        + `<div style="${RV_CARD};padding:36px 24px;text-align:center">
             <b style="font-size:15px;color:var(--ink2)">El corte no alcanzó a cargar</b>
             <p style="font-size:13px;color:var(--ink3);margin-top:6px;line-height:1.5">
               La consulta no respondió. Antes que mostrar media lista —y que alguien decida sobre lo que sí llegó—
               esta pantalla prefiere no mostrar ninguna: vuelve a intentarlo con <b>Volver a leer</b>.
             </p>
           </div>`;
    } finally {
      revState.cargando = false;
    }
  }

  function rvBindRevision() {
    const root = $('#revision-ui');
    if (!root || root._rvBound) return;
    root._rvBound = true;
    root.addEventListener('click', (e) => {
      // Con una lectura en vuelo, renderRevision() se devuelve sola. Si acá ya se
      // hubiera cambiado revState.cual, el botón resaltado diría una cosa y el
      // corte en pantalla otra, y el clic se habría perdido sin que nada lo diga.
      // Se ignora el clic ENTERO y el estado no se toca: peor que esperar es
      // creerle a un encabezado que no corresponde a los datos de abajo.
      if (revState.cargando && e.target.closest('[data-rv-corte],[data-rv-refrescar]')) return;

      const sel = e.target.closest('[data-rv-corte]');
      if (sel) {
        if (revState.cual === sel.dataset.rvCorte) return;
        revState.cual = sel.dataset.rvCorte;
        renderRevision();
        return;
      }
      if (e.target.closest('[data-rv-refrescar]')) { renderRevision(); return; }

      // Las decisiones se buscan por clave+ancla, no por índice del arreglo: la
      // lista se vuelve a armar en cada pintado y un índice se desalinea solo.
      const buscar = (llave) => {
        const [clave, ancla] = String(llave).split('|');
        return revState.puntos.find(p => p.clave === clave && p.ancla === ancla);
      };
      const dec = e.target.closest('[data-rv-dec]');
      if (dec) {
        const p = buscar(dec.dataset.rvDec);
        if (!p) return;
        rvGuardarDecision(p, dec.dataset.rvVal);
        rvPintar();
        return;
      }
      const undo = e.target.closest('[data-rv-undo]');
      if (undo) {
        const p = buscar(undo.dataset.rvUndo);
        if (!p) return;
        rvBorrarDecision(p);
        rvPintar();
        return;
      }
      if (e.target.closest('#rv-cerrar')) {
        // TODO (después del 25): acá va el cierre contable — congelar el corte,
        // dejar el informe firmado y volver inmutable lo que se pagó. Hoy el
        // botón solo demuestra que la condición para cerrarlo ya se cumple.
        toast('El cierre contable del corte todavía no existe: por ahora el botón solo se habilita.');
      }
    });
  }
