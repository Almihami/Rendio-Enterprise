// P12b · ADMIN › Cuentas de cobro (Facturario 0090) — prueba jsdom.
//
// Carga index.html + api-cobro.js + admin-cobro.js, reemplaza las funciones del
// jefe de window.ApiCobro por unas de PRUEBA (nada sale a la red: window.sb es una
// trampa que anota cualquier uso) y pinta #cobro-ui con window.renderCobro().
//
// Comprueba (AJUSTES §5):
//   · lista con estado (por revisar, pausado, en mora, pendiente, al día, sin
//     cuenta, sin cuenta de cobro abierta), filtros con conteo y buscador;
//   · el reloj diario: «todavía no ha corrido» si nunca corrió (no es «todo al día»);
//   · comprobantes por revisar con la imagen del enlace firmado (o el PDF),
//     aprobar, y rechazar SOLO con un motivo de la lista fija;
//   · editar / crear la cuenta del tripulante (monto, corte, plazos que pisan los de
//     la organización), marcar pagado, ajustar (descuento), abrir cuenta de cobro,
//     historial;
//   · métodos de pago (agregar, desactivar, borrar) y valores por defecto;
//   · enlace profundo #/cobro?aux=<id> solo para el jefe;
//   · sin montos ni cuentas inventadas; sin ApiCobro o con error, lo dice.
//
// 0094 (tarifas por sector, vacaciones y balance del mes):
//   · «Tarifas por sector»: sectores de la base con su conteo, «sin sector»,
//     guardar / agregar / borrar tarifa y validación de valores;
//   · fila con su sector (o «Sin sector»); editor con «Valor propio (opcional)» y
//     «vacío = la del sector»; guardar sin valor propio si el sector tiene
//     mensualidad; asignar el sector a mano (adminSetSector);
//   · chip «Vacaciones» / «Vacaciones en <mes>» y filtro «Vacaciones»; el jefe
//     marca (cálculo N × V en vivo) y cancela; sin valor por viaje, lo dice;
//   · «Balance del mes»: totales, por sector, por tripulante con la marca roja de
//     «reservó más de lo declarado», pagos, sin cuenta de cobro, cambiar de mes;
//   · «Descargar Excel» con el ExcelJS REAL del vendor: las 4 hojas (Resumen, Por
//     tripulante, Por sector, Pagos), encabezados en negrita, formato de pesos,
//     anchos, la fila en rojo y el nombre del archivo; sin ExcelJS, lo dice.
//   · Valor propio vs sector: chip «Valor propio» y aviso en el editor; en
//     «Tarifas por sector», «N con valor propio» y «Que paguen la del sector»
//     (solo si el sector tiene mensualidad, con confirmación).
//   · Las reglas del JEFE (adminCanChange): cambia un cobro vencido y reabre el
//     saldado solo en $0 (con el aviso de que hay que pagarlo); «Automático» en
//     el balance y el Excel para ese saldo; la foto «vacaciones canceladas
//     después de pagar».
//   · 30-sep: sin mensualidad por defecto (el panel ya no la tiene, el guardado
//     no la manda), «Valor propio (COP)» como campo principal, chip y filtro
//     «Sin valor», «Sin valor cargado» en el Balance; se cobra la diferencia:
//     chips «Extra pendiente» / «Incluye extra», declarados · reservados ·
//     cobrados en Vacaciones, «Incluye:» y «Extra pendiente» en el Historial, las
//     columnas Declarados · Reservados · Cobrados · Extra cobrado · Extra
//     pendiente en el Balance y el Excel (23 columnas) y los totales de extras.
//   · revisión 1-oct: en «Sin cuenta de cobro este mes», «Sin valor» sale de la
//     base (noValue): quien tiene un valor desde el próximo corte no lo es. En
//     el Historial, un descuento recortado por un cobro de vacaciones menor dice
//     cuánto puso el jefe (discountRequestedCOP).
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: la ficha apilada del celular se mira
// en el teléfono), la base real (RLS, reloj diario, push; los datos del balance
// son de prueba), el bucket privado real, la descarga real del archivo en el
// navegador (se intercepta el enlace) ni la navegación completa del admin
// (core.setTab se simula). OJO: aquí el front solo PINTA lo que da la base; que
// la base elija bien la mensualidad (propia → sector), recalcule, cobre la
// diferencia, deje el cargo pendiente, salde en $0 o reabra lo prueba
// _verify-0094.mjs contra la base LOCAL (no contra dev ni producción).
//
//   cd rendio-backend && node scripts/_smoke-admin-cobro-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addD = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const MC = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const fd = (iso) => { const [, m, d] = iso.split('-').map(Number); return d + ' de ' + MC[m - 1]; };

// ── datos de PRUEBA con la forma de admin_billing_list / proofs / detail ──────
function st(o = {}) {
  const dia = o.dia ?? 3, due = 5, grace = 3;
  const start = addD(HOY, -dia);
  const paid = !!o.paid, blocked = !!o.blocked;
  const base = paid ? 'pagado' : blocked ? 'bloqueado' : dia > due ? 'vencido' : dia === due ? 'venceHoy' : dia >= due - 2 ? 'porVencer' : 'pendiente';
  const amt = o.amt ?? 170000;      // el monto de la cuenta de cobro, el que manda la base
  return {
    id: o.id, periodStart: start, periodEnd: addD(start, 30), nextCut: addD(start, 31), amountCOP: amt, discountCOP: o.disc || 0, discountNote: o.discNote || null,
    modality: o.mod || 'mensual', paidAutomatic: !!o.auto,
    amountDueCOP: amt - (o.disc || 0), dueDays: due, noticeDays: 2, graceDays: grace, dueDate: addD(start, due), blockDate: addD(start, due + grace + 1),
    today: HOY, base, comp: paid ? 'approved' : (o.comp || 'none'), paid, paidOn: paid ? HOY : null, paidVia: paid ? 'proof' : null, paidViaLabel: paid ? 'Nequi' : null,
    review: o.comp === 'review', rejected: o.comp === 'rejected' ? 'El monto no coincide' : null, blocked, blockedOn: blocked ? addD(start, due + grace + 1) : null,
  };
}
const cuenta = (o = {}) => ({ reference: o.ref, active: o.active !== false, amountCOP: o.amount === undefined ? 170000 : o.amount, amountNextCOP: null,
  effectiveAmountCOP: o.eff === undefined ? 170000 : o.eff, cutDay: 12, dueDays: null, noticeDays: null, graceDays: null,
  effectiveDueDays: 5, effectiveNoticeDays: 2, effectiveGraceDays: 3, startsOn: addD(HOY, -40), paused: !!o.paused, nextCut: addD(HOY, 9) });
const LISTA = () => [
  { auxiliarProfileId: 'a-rev', profileId: 'p1', name: 'Ana Prueba', email: 'ana@prueba.test', phone: '3000000001', isActive: true,
    account: cuenta({ ref: 'AUX-0101' }), current: st({ id: 's-rev', dia: 3, comp: 'review' }),
    proofInReview: { id: 'pf-1', statementId: 's-rev', path: 'org/p1/s-rev/a.jpg', contentType: 'image/jpeg', viaLabel: 'Nequi', declaredAmountCOP: 170000, submittedOn: HOY } },
  { auxiliarProfileId: 'a-blk', profileId: 'p2', name: 'Beto Prueba', email: 'beto@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0102', paused: true }), current: st({ id: 's-blk', dia: 12, blocked: true }), proofInReview: null },
  { auxiliarProfileId: 'a-mora', profileId: 'p3', name: 'Caro Prueba', email: 'caro@prueba.test', phone: '3000000003', isActive: true,
    account: cuenta({ ref: 'AUX-0103' }), current: st({ id: 's-mora', dia: 7 }), proofInReview: null },
  { auxiliarProfileId: 'a-pend', profileId: 'p4', name: 'Dani Prueba', email: 'dani@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0104' }), current: st({ id: 's-pend', dia: 1 }), proofInReview: null },
  { auxiliarProfileId: 'a-ok', profileId: 'p5', name: 'Eli Prueba', email: 'eli@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0105' }), current: st({ id: 's-ok', dia: 4, paid: true }), proofInReview: null },
  { auxiliarProfileId: 'a-sin', profileId: 'p6', name: 'Fer Prueba', email: 'fer@prueba.test', phone: null, isActive: true,
    account: null, current: null, proofInReview: null },
  { auxiliarProfileId: 'a-corte', profileId: 'p7', name: 'Gabi Prueba', email: 'gabi@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0107' }), current: null, proofInReview: null },
];
const PROOFS = () => [
  { id: 'pf-1', statementId: 's-rev', auxiliarProfileId: 'a-rev', name: 'Ana Prueba', reference: 'AUX-0101', path: 'org/p1/s-rev/a.jpg', contentType: 'image/jpeg',
    viaLabel: 'Nequi', declaredAmountCOP: 170000, status: 'review', submittedOn: HOY, statement: st({ id: 's-rev', dia: 3, comp: 'review' }) },
  { id: 'pf-2', statementId: 's-blk', auxiliarProfileId: 'a-blk', name: 'Beto Prueba', reference: 'AUX-0102', path: 'org/p2/s-blk/b.pdf', contentType: 'application/pdf',
    viaLabel: 'Otro banco', declaredAmountCOP: 150500, status: 'review', submittedOn: HOY, statement: st({ id: 's-blk', dia: 12, blocked: true }) },
];

// ── 0094: tarifas por sector, vacaciones y balance (forma de admin_billing_*) ──
const START = addD(HOY, -3), NEXT = addD(START, 31);
const MES_HOY = HOY.slice(0, 7);
// canChange/why = las reglas del TRIPULANTE; adminCanChange/adminWhy = las del JEFE
// (sí cambia un cobro vencido y reabre el que quedó saldado solo en $0).
const per = (ps, o = {}) => ({ periodStart: ps, periodEnd: addD(ps, 30), statementId: o.st || null, statementPaid: !!o.paid, statementReview: !!o.review,
  statementZero: !!o.zero, statementOverdue: !!o.over,
  canChange: o.can !== false, why: o.why || null, adminCanChange: o.acan ?? (o.can !== false), adminWhy: o.awhy === undefined ? (o.acan ? null : o.why || null) : o.awhy,
  tripsBooked: o.booked ?? 0, tripsTaken: o.taken ?? 0, vacation: o.vac || null,
  // 30-sep: se cobra la diferencia (billing_vac_period_json)
  tripsBilled: o.billed ?? null, extraPendingTrips: o.pendT ?? 0, extraPendingCOP: o.pend ?? 0, extraTrips: o.xt ?? 0, extraCOP: o.xc ?? 0,
  freeTrips: o.free ?? null, statementLive: o.live ?? true });
const VACR = (ps, trips, o = {}) => ({ id: 'v-' + ps, periodStart: ps, startsOn: addD(ps, 2), endsOn: addD(ps, 12), trips, perTripCOP: o.per || 25000,
  totalCOP: (o.per || 25000) * trips, sector: o.sector || 'Llanogrande', setBy: o.by || 'aux', status: 'active' });
const acc94 = (o) => ({ ...cuenta(o), amountSource: o.src || 'own', sectorMonthlyCOP: o.secM ?? null, noValue: (o.eff === undefined ? 170000 : o.eff) == null, currentCut: START });
const LISTA94 = () => [
  { auxiliarProfileId: 'b-vac', profileId: 'q1', name: 'Hana Prueba', email: 'hana@prueba.test', phone: '3000000011', isActive: true,
    // Vacaciones en este cobro: la cuenta vale 3 × $25.000 = $75.000 (lo que dice la base).
    account: acc94({ ref: 'AUX-0201', amount: null, eff: 180000, src: 'sector', secM: 180000 }), current: st({ id: 's-vac', dia: 3, amt: 75000, mod: 'vacaciones' }), proofInReview: null,
    sector: 'Llanogrande', sectorSource: 'residence', manualSector: null, residenceName: 'Quintas de Llanogrande', residenceSector: 'Llanogrande',
    sectorRate: { monthlyCOP: 180000, perTripCOP: 25000 },
    vacation: { current: per(START, { st: 's-vac', booked: 5, billed: 5, xt: 2, xc: 50000, vac: VACR(START, 3) }), next: per(NEXT) } },
  { auxiliarProfileId: 'b-rio', profileId: 'q2', name: 'Iván Prueba', email: 'ivan@prueba.test', phone: null, isActive: true,
    // Valor propio ($160.000) que NO es la del sector (Rionegro, $170.000).
    account: acc94({ ref: 'AUX-0202', amount: 160000, eff: 160000, src: 'own', secM: 170000 }), proofInReview: null,
    // Trae $40.000 de viajes extra de vacaciones del cobro anterior (ya van en el monto).
    current: { ...st({ id: 's-rio', dia: 1, amt: 200000 }), extrasCOP: 40000, baseAmountCOP: 160000,
      extras: [{ id: 'x-1', sourcePeriodStart: addD(START, -30), trips: 2, perTripCOP: 20000, amountCOP: 40000, label: 'Viajes extra de vacaciones de agosto: 2 × $20.000 = $40.000' }] },
    sector: 'Rionegro', sectorSource: 'residence', manualSector: null, residenceName: 'El Olivar', residenceSector: 'Rionegro',
    sectorRate: { monthlyCOP: 170000, perTripCOP: null }, vacation: { current: per(START, { st: 's-rio' }), next: per(NEXT) } },
  { auxiliarProfileId: 'b-casa', profileId: 'q3', name: 'Juan Prueba', email: 'juan@prueba.test', phone: null, isActive: true,
    account: acc94({ ref: 'AUX-0203', amount: null, eff: null, src: null }), current: null, proofInReview: null,
    sector: null, sectorSource: null, manualSector: null, residenceName: null, residenceSector: null, sectorRate: null,
    vacation: { current: per(START), next: per(NEXT) } },
  { auxiliarProfileId: 'b-next', profileId: 'q4', name: 'Kata Prueba', email: 'kata@prueba.test', phone: null, isActive: true,
    account: acc94({ ref: 'AUX-0204', amount: null, eff: 200000, src: 'sector', secM: 200000 }), current: st({ id: 's-next', dia: 4, paid: true }), proofInReview: null,
    sector: 'Marinilla', sectorSource: 'manual', manualSector: 'Marinilla', residenceName: null, residenceSector: null,
    sectorRate: { monthlyCOP: 200000, perTripCOP: 30000 },
    // Reservó de más con la cuenta ya pagada: 1 viaje entra en su próximo cobro.
    extrasPending: { trips: 1, amountCOP: 30000, items: [{ id: 'x-2', sourcePeriodStart: START, trips: 1, perTripCOP: 30000, amountCOP: 30000, pending: true, label: 'Viajes extra de vacaciones de este mes: 1 × $30.000 = $30.000' }] },
    vacation: { current: per(START, { st: 's-next', paid: true, can: false, why: 'paid' }), next: per(NEXT, { vac: VACR(NEXT, 6, { per: 30000, sector: 'Marinilla' }) }) } },
  { auxiliarProfileId: 'b-sin', profileId: 'q5', name: 'Lina Prueba', email: 'lina@prueba.test', phone: null, isActive: true,
    account: null, current: null, proofInReview: null,
    sector: 'Llanogrande', sectorSource: 'residence', manualSector: null, residenceName: 'Quintas de Llanogrande', residenceSector: 'Llanogrande',
    sectorRate: { monthlyCOP: 180000, perTripCOP: 25000 }, vacation: null },
  // Sin cuenta de cobro abierta todavía: la fila muestra la mensualidad EFECTIVA que da la base.
  { auxiliarProfileId: 'b-sec', profileId: 'q6', name: 'Mona Prueba', email: 'mona@prueba.test', phone: null, isActive: true,
    account: { ...acc94({ ref: 'AUX-0206', amount: null, eff: 180000, src: 'sector', secM: 180000 }), nextCut: addD(HOY, 5) }, current: null, proofInReview: null,
    sector: 'Llanogrande', sectorSource: 'residence', manualSector: null, residenceName: 'Quintas de Llanogrande', residenceSector: 'Llanogrande',
    sectorRate: { monthlyCOP: 180000, perTripCOP: 25000 }, vacation: { current: per(START), next: per(NEXT) } },
  // Vacaciones sin viajes: la cuenta quedó saldada SOLA en $0 (pago automático).
  { auxiliarProfileId: 'b-zero', profileId: 'q7', name: 'Nina Prueba', email: 'nina@prueba.test', phone: null, isActive: true,
    account: acc94({ ref: 'AUX-0207', amount: null, eff: 180000, src: 'sector', secM: 180000 }), current: st({ id: 's-zero', dia: 3, amt: 0, mod: 'vacaciones', paid: true, auto: true }), proofInReview: null,
    sector: 'Llanogrande', sectorSource: 'residence', manualSector: null, residenceName: 'Quintas de Llanogrande', residenceSector: 'Llanogrande',
    sectorRate: { monthlyCOP: 180000, perTripCOP: 25000 },
    vacation: { current: per(START, { st: 's-zero', paid: true, zero: true, can: false, why: 'zero', acan: true, booked: 2, taken: 1, vac: VACR(START, 0) }), next: per(NEXT) } },
];
const RATES = () => ({ sectors: [
  { sector: 'Llanogrande', rateId: 'r-1', monthlyCOP: 180000, perTripCOP: 25000, fromResidences: true, residences: 1, crew: 2, crewManual: 0 },
  { sector: 'Marinilla', rateId: 'r-2', monthlyCOP: 200000, perTripCOP: 30000, fromResidences: false, residences: 0, crew: 1, crewManual: 1 },
  { sector: 'Rionegro', rateId: 'r-3', monthlyCOP: 170000, perTripCOP: null, fromResidences: true, residences: 1, crew: 1, crewManual: 0, crewOwn: 1 },
  { sector: 'Guarne', rateId: null, monthlyCOP: null, perTripCOP: null, fromResidences: true, residences: 2, crew: 0, crewManual: 0 },
], crewWithoutSector: 1, crewTotal: 5 });
const BAL = () => ({
  month: MES_HOY + '-01', monthEnd: addD(MES_HOY + '-01', 29), today: HOY, organizationName: 'Operación de prueba',
  totals: { statements: 5, billedGrossCOP: 525000, discountsCOP: 10000, netCOP: 515000, collectedCOP: 270000, paidCount: 3, pendingCOP: 245000, pendingCount: 2,
    reviewCOP: 0, reviewCount: 0, overdueCOP: 170000, overdueCount: 1, pausedCOP: 0, pausedCount: 0, monthlyCount: 2, monthlyNetCOP: 340000,
    vacationsCount: 3, vacationsNetCOP: 175000, vacationsTripsDeclared: 7, vacationsTripsBooked: 9, overBookedCount: 1,
    extraBilledCOP: 25000, extraPendingCOP: 25000, extraCOP: 50000, extraTrips: 2, extrasIncludedCOP: 40000, extrasIncludedCount: 1 },
  bySector: [
    { sector: 'Llanogrande', crew: 3, statements: 3, netCOP: 175000, collectedCOP: 100000, pendingCOP: 75000, vacationsCount: 3, monthlyCOP: 180000, perTripCOP: 25000 },
    { sector: 'Rionegro', crew: 1, statements: 1, netCOP: 170000, collectedCOP: 170000, pendingCOP: 0, vacationsCount: 0, monthlyCOP: 170000, perTripCOP: null },
    { sector: null, crew: 1, statements: 1, netCOP: 170000, collectedCOP: 0, pendingCOP: 170000, vacationsCount: 0, monthlyCOP: null, perTripCOP: null }],
  rows: [
    { statementId: 's-vac', auxiliarProfileId: 'b-vac', name: 'Hana Prueba', reference: 'AUX-0201', sector: 'Llanogrande', modality: 'vacaciones',
      tripsDeclared: 3, perTripCOP: 25000, tripsBooked: 5, overBooked: true, periodStart: START, periodEnd: addD(START, 30), dueDate: addD(START, 5),
      // 30-sep: 4 cobrados (1 de más en la cuenta) + 1 pendiente para el próximo cobro.
      tripsBilled: 4, extraBilledTrips: 1, extraBilledCOP: 25000, extraPendingTrips: 1, extraPendingCOP: 25000, extraTrips: 2, extraCOP: 50000, extrasIncludedCOP: 0, extrasIncluded: [],
      amountCOP: 75000, discountCOP: 0, discountNote: null, netCOP: 75000, status: 'pendiente', base: 'pendiente', comp: 'none', blocked: false, paid: false, daysLate: 0 },
    { statementId: 's-rio', auxiliarProfileId: 'b-rio', name: 'Iván Prueba', reference: 'AUX-0202', sector: 'Rionegro', modality: 'mensual',
      tripsDeclared: null, tripsBooked: 8, overBooked: false, periodStart: START, periodEnd: addD(START, 30), dueDate: addD(START, 5),
      tripsBilled: null, extraBilledCOP: 0, extraPendingCOP: 0, extraTrips: 0, extraCOP: 0,
      // Trae $40.000 de viajes extra del cobro anterior (dentro del monto).
      extrasIncludedCOP: 40000, extrasIncluded: [{ label: 'Viajes extra de vacaciones de agosto: 2 × $20.000 = $40.000', amountCOP: 40000 }],
      amountCOP: 170000, discountCOP: 0, discountNote: null, netCOP: 170000, status: 'pagado', base: 'pagado', comp: 'approved', blocked: false,
      paid: true, paidOn: HOY, paidVia: 'proof', paidViaLabel: 'Nequi', paidAmountCOP: 170000, approvedBy: 'Jefa Prueba', daysLate: 2 },
    { statementId: 's-casa', auxiliarProfileId: 'b-casa', name: 'Juan Prueba', reference: 'AUX-0203', sector: null, modality: 'mensual',
      tripsDeclared: null, tripsBooked: 0, overBooked: false, periodStart: START, periodEnd: addD(START, 30), dueDate: addD(START, 5),
      amountCOP: 180000, discountCOP: 10000, discountNote: 'Canje de puntos', netCOP: 170000, status: 'vencido', base: 'vencido', comp: 'none', blocked: false, paid: false, daysLate: 4 },
    // Vacaciones sin viajes: saldada sola en $0 (nadie la aprobó).
    { statementId: 's-auto', auxiliarProfileId: 'b-zero', name: 'Nina Prueba', reference: 'AUX-0207', sector: 'Llanogrande', modality: 'vacaciones', vacationStatus: 'active',
      tripsDeclared: 0, perTripCOP: 25000, tripsBooked: 0, overBooked: false, periodStart: START, periodEnd: addD(START, 30), dueDate: addD(START, 5),
      amountCOP: 0, discountCOP: 0, discountNote: null, netCOP: 0, status: 'pagado', base: 'pagado', comp: 'approved', blocked: false,
      paid: true, paidOn: START, paidVia: 'manual', paidViaLabel: 'Vacaciones sin viajes', paidAmountCOP: 0, paidAutomatic: true, approvedBy: null, daysLate: 0 },
    // Pagada con vacaciones que el jefe canceló después: sigue siendo «vacaciones» (la foto).
    { statementId: 's-canc', auxiliarProfileId: 'b-x', name: 'Olga Prueba', reference: 'AUX-0208', sector: 'Llanogrande', modality: 'vacaciones', vacationStatus: 'cancelled',
      tripsDeclared: 4, perTripCOP: 25000, tripsBooked: 4, overBooked: false, periodStart: START, periodEnd: addD(START, 30), dueDate: addD(START, 5),
      amountCOP: 100000, discountCOP: 0, discountNote: null, netCOP: 100000, status: 'pagado', base: 'pagado', comp: 'approved', blocked: false,
      paid: true, paidOn: HOY, paidVia: 'proof', paidViaLabel: 'Nequi', paidAmountCOP: 100000, paidAutomatic: false, approvedBy: 'Jefa Prueba', daysLate: 0 }],
  payments: [
    { kind: 'proof', date: HOY, name: 'Iván Prueba', reference: 'AUX-0202', periodStart: START, viaLabel: 'Nequi', amountCOP: 170000, status: 'approved', by: 'Jefa Prueba' },
    { kind: 'payment', date: HOY, name: 'Iván Prueba', reference: 'AUX-0202', periodStart: START, viaLabel: 'Nequi', amountCOP: 170000, status: 'proof', by: 'Jefa Prueba' },
    { kind: 'proof', date: HOY, name: 'Juan Prueba', reference: 'AUX-0203', periodStart: START, viaLabel: 'Otro banco', amountCOP: 150500, status: 'rejected', rejectReason: 'El monto no coincide', by: 'Jefa Prueba' },
    { kind: 'payment', date: START, name: 'Nina Prueba', reference: 'AUX-0207', periodStart: START, viaLabel: 'Vacaciones sin viajes', amountCOP: 0, status: 'manual', by: null, automatic: true, note: 'Saldado solo: vacaciones sin nada que pagar' }],
  withoutStatement: [{ auxiliarProfileId: 'b-next', name: 'Kata Prueba', reference: 'AUX-0204', sector: 'Marinilla', effectiveAmountCOP: 200000, cutDay: 28, cutThisMonth: MES_HOY + '-28', cutPending: true }],
  withoutAccount: 1,
  withoutValue: 1,
});

async function boot(o = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' + (o.hash || '') });
  const w = dom.window;
  if (o.excel) { try { w.eval(read('vendor/exceljs-4.4.0.min.js')); } catch (e) { console.log('  (ExcelJS no cargó en jsdom: ' + e.message + ')'); } }
  w.URL.createObjectURL = () => 'blob:prueba';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { (w.__descargas = w.__descargas || []).push(this.download); };
  const errors = [], toasts = [], calls = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.toast = (m) => toasts.push(m);
  w.confirm = () => true;
  const red = [];
  const trampa = new Proxy(function () {}, {
    get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
    apply: () => { red.push('()'); return trampa; },
  });
  w.sb = trampa;
  w.eval('var state = { profile: ' + JSON.stringify(o.profile || { id: 'jefe', role: 'admin' }) + ', activeTab: "consola" };');
  w.eval('function setTab(n) { state.activeTab = n; (window.__tabs = window.__tabs || []).push(n); if (n === "cobro" && window.renderCobro) window.renderCobro(); }');
  if (!o.sinApi) { try { w.eval(read('api-cobro.js')); } catch (e) { errors.push('api-cobro.js: ' + e.message); } }
  const C = w.ApiCobro;
  const D = { list: o.lista ? o.lista() : LISTA(), proofs: o.lista ? [] : PROOFS(), lastRun: null, rates: RATES(), bal: BAL(), methods: [
    { id: 'm-1', kind: 'bank', label: 'Bancolombia', accountType: 'Ahorros', number: '111-222333-44', holderName: null, holderNit: null, position: 0, active: true }],
    settings: { exists: true, dueDays: 5, noticeDays: 2, graceDays: 3, holderName: null, holderNit: null } };
  const cl = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const rec = (fn, ret) => async (...a) => { calls.push([fn, ...cl(a)]); if (ret instanceof Error) throw ret; return typeof ret === 'function' ? ret(...a) : cl(ret); };
  if (C) {
    C.adminList = async () => { calls.push(['adminList']); if (D.listErr) throw new Error('0090 no está'); return cl(D.list); };
    C.adminProofs = async (s) => { calls.push(['adminProofs', s]); return cl(D.proofs); };
    C.adminLastRun = async () => cl(D.lastRun);
    C.proofUrl = async (p) => { calls.push(['proofUrl', p]); return 'https://almacen.prueba/firmado/' + p; };
    C.adminApprove = rec('adminApprove', { id: 's-rev' });
    C.adminReject = rec('adminReject', { id: 's-blk' });
    C.adminSaveAccount = rec('adminSaveAccount', {});
    C.adminMarkPaid = rec('adminMarkPaid', {});
    C.adminAdjust = rec('adminAdjust', {});
    C.adminOpenStatement = rec('adminOpenStatement', {});
    C.adminDetail = async (aux) => { calls.push(['adminDetail', aux]); return { statements: [
      // 30-sep: una cuenta que trae viajes extra de un cobro anterior.
      { ...st({ id: 's-ok', dia: 4, paid: true, amt: 210000 }), extrasCOP: 40000, extras: [{ id: 'x-9', trips: 2, perTripCOP: 20000, amountCOP: 40000, label: 'Viajes extra de vacaciones de agosto: 2 × $20.000 = $40.000' }] },
      // Revisión 1-oct: vacaciones de 1 viaje ($20.000) con un canje de $30.000: se
      // aplica hasta el monto y la base guarda lo que puso el jefe.
      { ...st({ id: 's-old', dia: 34, paid: true, amt: 20000, disc: 20000, discNote: 'Canje de puntos', mod: 'vacaciones', auto: true }), discountRequestedCOP: 30000 }],
      proofs: [{ id: 'pf-0', statementId: 's-ok', status: 'approved' }], payments: [],
      extraCharges: D.detailPend ? [{ id: 'x-8', pending: true, trips: 1, perTripCOP: 20000, amountCOP: 20000, label: 'Viajes extra de vacaciones de septiembre: 1 × $20.000 = $20.000' }] : [] }; };
    C.adminMethods = async () => cl(D.methods);
    C.adminSaveMethod = rec('adminSaveMethod', {});
    C.adminSetMethodActive = rec('adminSetMethodActive', undefined);
    C.adminDeleteMethod = rec('adminDeleteMethod', undefined);
    C.adminSettings = async () => cl(D.settings);
    C.adminSaveSettings = rec('adminSaveSettings', {});
    // 0094
    C.adminSectorRates = async () => { calls.push(['adminSectorRates']); if (D.ratesErr) throw new Error('0094 no está'); return cl(D.rates); };
    C.adminSaveSectorRate = rec('adminSaveSectorRate', {});
    C.adminUseSectorRate = rec('adminUseSectorRate', (sec) => ({ sector: sec, monthlyCOP: 170000, cleared: 1 }));
    C.adminSetSector = rec('adminSetSector', {});
    C.adminSetVacation = rec('adminSetVacation', (aux, f) => ({ vacation: { trips: f.trips, perTripCOP: 25000, totalCOP: 25000 * f.trips } }));
    C.adminCancelVacation = rec('adminCancelVacation', {});
    C.adminBalance = async (m) => { calls.push(['adminBalance', m]); if (D.balErr) throw new Error('0094 no está'); return cl(D.bal); };
  }
  try { w.eval(read('admin-cobro.js')); } catch (e) { errors.push('admin-cobro.js: ' + e.message); }
  const sec = w.document.querySelector('section[data-panel="cobro"]');
  if (sec) sec.classList.remove('hidden');
  const R = () => w.document.getElementById('cobro-ui');
  const q = (s) => R().querySelector(s);
  const qa = (s) => [...R().querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const row = (aux) => q(`.cb-row[data-aux="${aux}"]`);
  return { w, D, calls, toasts, errors, red, R, q, qa, click, type, row };
}
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const PROHIBIDOS = ['$150.000', 'Rendio S.A.S.', '901.555.019-2', '123-456789-01', '300 555 0192', 'AUX-0231', 'Laura', 'Carlos Mejía', 'Juliana'];

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Lista, reloj y filtros ──');
{
  const b = await boot();
  const { w } = b;
  t('exporta renderCobro y stopCobroTimer (la consola muestra la entrada)', typeof w.renderCobro === 'function' && typeof w.stopCobroTimer === 'function');
  w.renderCobro(); await wait(30);
  t('encabezado «Cuentas de cobro» con el conteo (7)', txt(b.q('.sh-phead h1')) === 'Cuentas de cobro 7');
  t('el reloj nunca corrió → lo dice (no es «todo al día»)', /El reloj diario todavía no ha corrido/.test(b.q('.cb-note.warn').textContent));
  const tagOf = (a) => txt(b.row(a).querySelector('.cb-st .cb-tag'));
  t('estados: Por revisar · Pausado · En mora · Pendiente · Al día · Sin cuenta · Sin cuenta de cobro abierta',
    ['a-rev', 'a-blk', 'a-mora', 'a-pend', 'a-ok', 'a-sin', 'a-corte'].map(tagOf).join('|') === 'Por revisar|Pausado|En mora|Pendiente|Al día|Sin cuenta|Sin cuenta de cobro abierta',
    ['a-rev', 'a-blk', 'a-mora', 'a-pend', 'a-ok', 'a-sin', 'a-corte'].map(tagOf).join('|'));
  const amt = (a) => { const e = b.row(a).querySelector('.cb-amt'); return txt(e.querySelector('b')) + ' | ' + txt(e.querySelector('span')); };
  t('monto de la base y la fecha real («Vence el …», «Pagó el …», «Sin mensualidad»)',
    amt('a-mora') === '$170.000 | Vence el ' + fd(st({ dia: 7 }).dueDate) && /^\$170\.000 \| Pagó el /.test(amt('a-ok')) && amt('a-sin') === '— | Sin mensualidad',
    ['a-mora', 'a-ok', 'a-sin'].map(amt).join(' // '));
  t('referencia AUX-#### de la base', /AUX-0103/.test(b.row('a-mora').querySelector('.cb-who').textContent));
  t('acciones según el estado: sin cuenta → «Crear cuenta»; pagado → sin «Marcar pagado»; sin corte → «Abrir cuenta de cobro»',
    txt(b.row('a-sin').querySelector('[data-m="edit"]')) === 'Crear cuenta' && !b.row('a-ok').querySelector('[data-m="paid"]') && !!b.row('a-corte').querySelector('[data-cb="open-st"]')
    && !!b.row('a-mora').querySelector('[data-m="paid"]') && !!b.row('a-mora').querySelector('[data-m="adjust"]'));
  const counts = b.qa('.cb-tools .cb-filters button').map(x => txt(x)).join('|');
  t('filtros con conteo (0094: + Vacaciones; 30-sep: + Sin valor)', counts === 'Todos 7|Por revisar 1|Pausados 1|En mora 1|Pendientes 1|Al día 1|Vacaciones 0|Sin valor 0|Sin cuenta 2', counts);
  t('sin 0094 en la base (filas sin «sector»): la fila no inventa «Sin sector» y el campo sigue siendo «Mensualidad (COP)»',
    !/Sin sector/.test(b.row('a-mora').textContent));
  b.click(b.q('.cb-filters [data-v="pausados"]')); await wait(10);
  t('filtro Pausados → solo Beto', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'a-blk');
  b.click(b.q('.cb-filters [data-v="todos"]')); await wait(10);
  b.type(b.q('#cb-search'), 'caro');
  t('buscador por nombre', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'a-mora');
  b.type(b.q('#cb-search'), 'aux-0105');
  t('…y por referencia', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'a-ok');
  b.type(b.q('#cb-search'), '');
  b.D.lastRun = { runOn: HOY, ranAt: HOY + 'T12:00:00Z', opened: 2, alerts: 5, paused: 1 };
  b.click(b.q('[data-cb="reload"]')); await wait(30);
  t('con el reloj al día: una línea con lo que hizo', /Reloj diario: corrió el .* · 2 cuentas abiertas, 5 avisos, 1 pausa/.test(txt(b.q('.cb-clock'))) && !b.q('.cb-note.warn'));
  b.D.lastRun = { runOn: addD(HOY, -4), opened: 0, alerts: 0, paused: 0 };
  b.click(b.q('[data-cb="reload"]')); await wait(30);
  t('reloj atrasado: «no corre desde el …»', /El reloj diario no corre desde el/.test(txt(b.q('.cb-note.warn'))));
  const all = b.R().innerHTML;
  t('sin textos inventados del diseño', PROHIBIDOS.every(p => !all.includes(p)), PROHIBIDOS.filter(p => all.includes(p)).join(','));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 5).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Comprobantes por revisar ──');
{
  const b = await boot();
  const { w } = b;
  w.renderCobro(); await wait(40);
  const cards = b.qa('.cb-proof');
  t('dos comprobantes por revisar, con el conteo', cards.length === 2 && /Comprobantes por revisar 2/.test(txt(b.q('.cb-sec h2'))));
  t('la imagen sale del enlace FIRMADO del bucket privado', cards[0].querySelector('.cb-proof-img img') && cards[0].querySelector('.cb-proof-img img').getAttribute('src') === 'https://almacen.prueba/firmado/org/p1/s-rev/a.jpg'
    && b.calls.some(c => c[0] === 'proofUrl' && c[1] === 'org/p1/s-rev/a.jpg'));
  t('un PDF se abre como enlace', !!cards[1].querySelector('.cb-proof-img a') && /Abrir el PDF/.test(cards[1].querySelector('.cb-proof-img').textContent));
  t('datos: nombre, referencia, cuenta del mes, lo que dice que pagó, por dónde', /Ana Prueba/.test(cards[0].textContent) && /AUX-0101/.test(cards[0].textContent) && /Cuenta del mes\s*\$170\.000/.test(cards[0].textContent) && /Pagó por\s*Nequi/.test(cards[0].textContent));
  t('si declaró otro monto, se marca (.bad)', !!cards[1].querySelector('.cb-kvs b.bad') && txt(cards[1].querySelector('.cb-kvs b.bad')) === '$150.500' && !cards[0].querySelector('.cb-kvs b.bad'));
  t('pausado: avisa que al aprobar se reactivan sus reservas', /al aprobar se reactivan/.test(cards[1].textContent));
  b.click(cards[0].querySelector('[data-cb="approve"]')); await wait(30);
  t('Aprobar → adminApprove(id), aviso y se recarga', b.calls.some(c => c[0] === 'adminApprove' && c[1] === 'pf-1') && b.toasts.includes('Ana Prueba quedó al día') && b.calls.filter(c => c[0] === 'adminList').length >= 2);
  const c2 = () => b.q('.cb-proof[data-proof="pf-2"]');
  b.click(c2().querySelector('[data-cb="reject"]')); await wait(10);
  const reasons = [...c2().querySelectorAll('.cb-reasons input[type=radio]')].map(x => x.value);
  t('Rechazar abre SOLO los 4 motivos de la lista (CB_REASONS)', reasons.join('|') === 'No se lee el comprobante|El monto no coincide|No es a la cuenta de Rendio|La fecha es anterior al cobro', reasons.join('|'));
  t('sin motivo, «Rechazar» está deshabilitado', c2().querySelector('[data-cb="reject-go"]').disabled);
  const r2 = c2().querySelectorAll('.cb-reasons input[type=radio]')[1];
  r2.checked = true; r2.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(5);
  t('elegir un motivo lo habilita', !c2().querySelector('[data-cb="reject-go"]').disabled);
  b.click(c2().querySelector('[data-cb="reject-go"]')); await wait(30);
  t('adminReject(id, motivo de la lista)', b.calls.some(c => c[0] === 'adminReject' && c[1] === 'pf-2' && c[2] === 'El monto no coincide') && b.toasts.includes('Comprobante rechazado'));
  b.D.proofs = [];
  b.click(b.q('[data-cb="reload"]')); await wait(30);
  t('sin nada por revisar: «Nada por revisar.»', /Nada por revisar/.test(b.q('.cb-sec').textContent));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Editar cuenta, marcar pagado, ajustar, abrir, historial ──');
{
  const b = await boot();
  const { w } = b;
  w.renderCobro(); await wait(30);
  b.click(b.row('a-mora').querySelector('[data-m="edit"]')); await wait(20);
  const f = (k) => b.row('a-mora').querySelector(`[data-cbf="${k}"]`);
  t('Editar cuenta: el formulario trae los valores de la base (170000, corte 12, plazos vacíos = los de la organización)',
    f('amountCOP').value === '170000' && f('cutDay').value === '12' && f('dueDays').value === '' && /De la organización: 5/.test(f('dueDays').getAttribute('placeholder')));
  b.type(f('amountCOP'), '175.000'); b.type(f('graceDays'), '4');
  b.click(b.row('a-mora').querySelector('[data-cb="save-acc"]')); await wait(30);
  const sa = b.calls.find(c => c[0] === 'adminSaveAccount');
  t('Guardar → adminSaveAccount(aux, {amountCOP:175000, cutDay:12, graceDays:4, dueDays:null, active:true…})',
    sa && sa[1] === 'a-mora' && sa[2].amountCOP === 175000 && sa[2].cutDay === 12 && sa[2].graceDays === 4 && sa[2].dueDays === null && sa[2].active === true, JSON.stringify(sa));
  t('se cierra el editor y aparece «Cuenta guardada»', !b.q('.cb-row.open') && b.toasts.includes('Cuenta guardada'));
  // Crear cuenta sin monto ni valor por defecto
  b.click(b.row('a-sin').querySelector('[data-m="edit"]')); await wait(30);
  b.click(b.row('a-sin').querySelector('[data-cb="save-acc"]')); await wait(20);
  t('crear sin monto y sin monto por defecto: no se guarda y lo dice', !b.calls.some(c => c[0] === 'adminSaveAccount' && c[1] === 'a-sin') && /Falta la mensualidad/.test(b.toasts.at(-1)));
  b.type(b.row('a-sin').querySelector('[data-cbf="amountCOP"]'), '160000');
  b.type(b.row('a-sin').querySelector('[data-cbf="cutDay"]'), '40');
  b.click(b.row('a-sin').querySelector('[data-cb="save-acc"]')); await wait(20);
  t('día de corte fuera de 1-31: lo dice', /1 a 31/.test(b.toasts.at(-1)));
  b.type(b.row('a-sin').querySelector('[data-cbf="cutDay"]'), '');
  b.click(b.row('a-sin').querySelector('[data-cb="save-acc"]')); await wait(30);
  const sa2 = b.calls.filter(c => c[0] === 'adminSaveAccount').at(-1);
  t('crear con monto → adminSaveAccount(a-sin, {amountCOP:160000, cutDay:null})', sa2 && sa2[1] === 'a-sin' && sa2[2].amountCOP === 160000 && sa2[2].cutDay === null);
  // Marcar pagado
  b.click(b.row('a-blk').querySelector('[data-m="paid"]')); await wait(20);
  const pf = (k) => b.row('a-blk').querySelector(`[data-cbf="${k}"]`);
  t('Marcar pagado: monto de la cuenta y hoy por defecto; avisa que se reactivan sus reservas', pf('amountCOP').value === '170000' && pf('paidOn').value === HOY && /sus reservas se reactivan/.test(b.row('a-blk').textContent));
  b.type(pf('viaLabel'), 'Efectivo'); b.type(pf('note'), 'Lo trajo a la oficina');
  b.click(b.row('a-blk').querySelector('[data-cb="save-paid"]')); await wait(30);
  const mp = b.calls.find(c => c[0] === 'adminMarkPaid');
  t('adminMarkPaid(statementId, {viaLabel, amountCOP, paidOn, note})', mp && mp[1] === 's-blk' && mp[2].viaLabel === 'Efectivo' && mp[2].amountCOP === 170000 && mp[2].paidOn === HOY && mp[2].note === 'Lo trajo a la oficina', JSON.stringify(mp));
  // Ajustar
  b.click(b.row('a-pend').querySelector('[data-m="adjust"]')); await wait(20);
  const af = (k) => b.row('a-pend').querySelector(`[data-cbf="${k}"]`);
  b.type(af('discountCOP'), '200000');
  b.click(b.row('a-pend').querySelector('[data-cb="save-adjust"]')); await wait(20);
  t('descuento mayor que el monto: no se guarda y lo dice', !b.calls.some(c => c[0] === 'adminAdjust') && /no puede ser mayor/.test(b.toasts.at(-1)));
  b.type(af('discountCOP'), '17000'); b.type(af('discountNote'), 'Canje de puntos');
  b.click(b.row('a-pend').querySelector('[data-cb="save-adjust"]')); await wait(30);
  const aj = b.calls.find(c => c[0] === 'adminAdjust');
  t('Ajustar → adminAdjust(statementId, {amountCOP, discountCOP, discountNote})', aj && aj[1] === 's-pend' && aj[2].amountCOP === 170000 && aj[2].discountCOP === 17000 && aj[2].discountNote === 'Canje de puntos', JSON.stringify(aj));
  // Abrir cuenta de cobro
  b.click(b.row('a-corte').querySelector('[data-cb="open-st"]')); await wait(30);
  t('Abrir cuenta de cobro → adminOpenStatement(aux)', b.calls.some(c => c[0] === 'adminOpenStatement' && c[1] === 'a-corte'));
  // Historial
  b.click(b.row('a-ok').querySelector('[data-m="hist"]')); await wait(30);
  const rows = [...b.row('a-ok').querySelectorAll('.cb-hist tbody tr')];
  t('Historial → adminDetail(aux) en tabla: mes, monto, estado, pago, comprobantes', b.calls.some(c => c[0] === 'adminDetail' && c[1] === 'a-ok') && rows.length === 2 && /Al día/.test(rows[0].textContent) && /Aprobado/.test(rows[0].textContent));
  t('…la cuenta que trae viajes extra lo dice: «Incluye: Viajes extra de vacaciones de agosto: 2 × $20.000 = $40.000»', txt(rows[0].querySelector('[data-cb-hist-extra]')) === 'Incluye: Viajes extra de vacaciones de agosto: 2 × $20.000 = $40.000' && !rows[1].querySelector('[data-cb-hist-extra]'));
  t('…sin cargos pendientes no sale la nota de «Extra pendiente»', !b.row('a-ok').querySelector('[data-cb-hist-pend]'));
  t('(revisión 1-oct) descuento recortado: «− $20.000 · Canje de puntos (puso $30.000; se aplica hasta el monto)»; sin recorte, sin la nota',
    txt(rows[1].querySelector('[data-cb-hist-disc]')) === '− $20.000 · Canje de puntos (puso $30.000; se aplica hasta el monto)' && !rows[0].querySelector('[data-cb-hist-disc]'),
    txt(rows[1].querySelector('[data-cb-hist-disc]')));
  b.D.detailPend = true;
  b.click(b.row('a-ok').querySelector('[data-m="hist"]')); await wait(10);
  b.click(b.row('a-ok').querySelector('[data-m="hist"]')); await wait(30);
  t('…con un cargo pendiente: «Extra pendiente para su próximo cobro: $20.000» con su línea', /^Extra pendiente para su próximo cobro: \$20\.000/.test(txt(b.row('a-ok').querySelector('[data-cb-hist-pend] b')))
    && /Viajes extra de vacaciones de septiembre: 1 × \$20\.000 = \$20\.000/.test(txt(b.row('a-ok').querySelector('[data-cb-hist-pend]'))), txt(b.row('a-ok').querySelector('[data-cb-hist-pend]')));
  b.D.detailPend = false;
  // Error del servidor: se muestra su texto.
  w.ApiCobro.adminOpenStatement = async () => { throw new Error('Falta el monto de la mensualidad'); };
  b.click(b.row('a-corte').querySelector('[data-cb="open-st"]')); await wait(30);
  t('un error del servidor se muestra tal cual (en español)', b.toasts.at(-1) === 'Falta el monto de la mensualidad');
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Métodos de pago y valores por defecto ──');
{
  const b = await boot();
  const { w } = b;
  w.renderCobro(); await wait(30);
  b.click(b.q('[data-cb="panel"][data-v="methods"]')); await wait(30);
  t('Métodos de pago: la lista de la base', b.qa('.cb-method').length === 1 && /Bancolombia · Ahorros/.test(txt(b.q('.cb-method'))) && /111-222333-44/.test(txt(b.q('.cb-method'))));
  b.click(b.q('[data-cb="m-new"]')); await wait(10);
  const mf = (k) => b.q(`[data-cbm="${k}"]`);
  b.type(mf('label'), 'Nequi');
  b.click(b.q('[data-cb="m-save"]')); await wait(20);
  t('sin número: no se guarda', !b.calls.some(c => c[0] === 'adminSaveMethod') && /Falta el nombre o el número/.test(b.toasts.at(-1)));
  const sel = mf('kind'); sel.value = 'nequi'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  b.type(mf('number'), '310 000 0000');
  b.click(b.q('[data-cb="m-save"]')); await wait(30);
  const sm = b.calls.find(c => c[0] === 'adminSaveMethod');
  t('Guardar método → adminSaveMethod({kind:nequi, label, number})', sm && sm[1].kind === 'nequi' && sm[1].label === 'Nequi' && sm[1].number === '310 000 0000' && !sm[1].id, JSON.stringify(sm));
  b.click(b.q('[data-cb="m-toggle"]')); await wait(30);
  t('Desactivar → adminSetMethodActive(id, false)', b.calls.some(c => c[0] === 'adminSetMethodActive' && c[1] === 'm-1' && c[2] === false));
  b.click(b.q('[data-cb="m-del"]')); await wait(30);
  t('Borrar (con confirmación) → adminDeleteMethod(id)', b.calls.some(c => c[0] === 'adminDeleteMethod' && c[1] === 'm-1'));
  b.D.methods = [];
  b.click(b.q('[data-cb="panel"][data-v="methods"]')); await wait(5);
  b.click(b.q('[data-cb="panel"][data-v="methods"]')); await wait(30);
  t('sin métodos: dice que el tripulante no tiene a dónde transferir', /No hay métodos de pago/.test(b.q('.cb-panel').textContent));
  b.click(b.q('[data-cb="panel"][data-v="settings"]')); await wait(30);
  const sf = (k) => b.q(`[data-cbs="${k}"]`);
  t('Valores por defecto (30-sep): YA NO hay mensualidad por defecto; quedan los plazos 5/2/3 y el titular', !sf('defaultAmountCOP') && sf('dueDays').value === '5' && sf('noticeDays').value === '2' && sf('graceDays').value === '3'
    && !!sf('holderName') && /cada tripulante tiene su valor propio/.test(txt(b.q('.cb-panel-h span'))));
  b.type(sf('dueDays'), '6'); b.type(sf('holderName'), 'Operación de Prueba S.A.S.'); b.type(sf('holderNit'), '900.111.222-3');
  b.click(b.q('[data-cb="s-save"]')); await wait(30);
  const ss = b.calls.find(c => c[0] === 'adminSaveSettings');
  t('Guardar → adminSaveSettings({dueDays:6, …, holderName, holderNit}) SIN mensualidad por defecto', ss && !('defaultAmountCOP' in ss[1]) && ss[1].dueDays === 6 && ss[1].holderName === 'Operación de Prueba S.A.S.' && ss[1].holderNit === '900.111.222-3', JSON.stringify(ss));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Enlace profundo, errores y sin facturario ──');
{
  const b = await boot();
  const { w } = b;
  w.location.hash = '#/cobro?aux=a-blk';
  await wait(60);
  t('#/cobro?aux=<id> (jefe) → setTab("cobro") y abre esa fila', (w.__tabs || []).includes('cobro') && b.q('.cb-row.open') && b.q('.cb-row.open').getAttribute('data-aux') === 'a-blk');
  t('el hash se consume', !/cobro/.test(w.location.hash));
  w.stopCobroTimer();
  const b2 = await boot({ profile: { id: 'x', role: 'auxiliar' } });
  b2.w.location.hash = '#/cobro?aux=a-blk';
  await wait(40);
  t('un tripulante con ese hash no abre el panel del jefe', !(b2.w.__tabs || []).includes('cobro'));
  const b3 = await boot();
  b3.D.listErr = true;
  b3.w.renderCobro(); await wait(30);
  t('si la lista falla: «No pudimos cargar las cuentas de cobro» + Reintentar', /No pudimos cargar las cuentas de cobro/.test(b3.R().textContent) && !!b3.q('.cb-empty [data-cb="reload"]'));
  b3.D.listErr = false;
  b3.click(b3.q('.cb-empty [data-cb="reload"]')); await wait(30);
  t('Reintentar la trae', b3.qa('.cb-row').length === 7);
  b3.w.stopCobroTimer();
  const b4 = await boot({ sinApi: true });
  b4.w.renderCobro(); await wait(20);
  t('sin ApiCobro: «El facturario no está disponible en esta versión»', /El facturario no está disponible/.test(b4.R().textContent));
  b4.w.stopCobroTimer();
  t('sin errores de consola', [b, b2, b3, b4].every(x => x.errors.length === 0), [b, b2, b3, b4].map(x => x.errors.join(' | ')).join(' || '));
  t('sin red (window.sb nunca se usó)', [b, b2, b3, b4].every(x => x.red.length === 0));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 0094 · Tarifas por sector ──');
{
  const b = await boot({ lista: LISTA94 });
  const { w } = b;
  w.renderCobro(); await wait(30);
  t('el encabezado trae «Tarifas por sector» junto a Métodos de pago y Valores por defecto',
    b.qa('.sh-phead [data-cb="panel"]').map(x => txt(x)).join('|') === 'Métodos de pago|Tarifas por sector|Valores por defecto');
  b.click(b.q('[data-cb="panel"][data-v="rates"]')); await wait(30);
  t('abre el panel y lo pide a la base (adminSectorRates)', b.calls.some(c => c[0] === 'adminSectorRates') && /Tarifas por sector/.test(txt(b.q('.cb-panel-h b'))));
  const rows = b.qa('.cb-rates tbody tr[data-cb-sector]');
  t('un renglón por sector de la base (residencias + con tarifa + a mano), en orden', rows.map(r => txt(r.querySelector('td b'))).join('|') === 'Llanogrande|Marinilla|Rionegro|Guarne', rows.map(r => txt(r.querySelector('td b'))).join('|'));
  const rowS = (k) => b.q(`.cb-rates tr[data-cb-sector="${k}"]`);
  t('cuántos tripulantes caen en cada sector y de dónde sale (conjuntos / a mano)', /2 tripulantes/.test(txt(rowS('llanogrande'))) && /1 conjunto/.test(txt(rowS('llanogrande')))
    && /1 asignado a mano/.test(txt(rowS('marinilla'))) && /Puesto a mano/.test(txt(rowS('marinilla'))) && /0 tripulantes/.test(txt(rowS('guarne'))));
  t('mensualidad y valor por viaje de la base; vacío = «Sin valor» (nada inventado)', rowS('llanogrande').querySelector('[data-cbt="monthlyCOP"]').value === '180000'
    && rowS('llanogrande').querySelector('[data-cbt="perTripCOP"]').value === '25000' && rowS('rionegro').querySelector('[data-cbt="perTripCOP"]').value === ''
    && rowS('guarne').querySelector('[data-cbt="monthlyCOP"]').getAttribute('placeholder') === 'Sin valor');
  t('«5 tripulantes · 1 sin sector» en aviso (hay que asignárselo en su cuenta)', /5 tripulantes · 1 sin sector: asígnaselo en su cuenta/.test(txt(b.q('[data-cb-rates-sum]'))) && b.q('[data-cb-rates-sum]').classList.contains('warn'));
  b.type(rowS('rionegro').querySelector('[data-cbt="perTripCOP"]'), '22.000');
  b.click(rowS('rionegro').querySelector('[data-cb="rate-save"]')); await wait(30);
  const sr = b.calls.find(c => c[0] === 'adminSaveSectorRate');
  t('Guardar → adminSaveSectorRate("Rionegro", {monthlyCOP:170000, perTripCOP:22000})', sr && sr[1] === 'Rionegro' && sr[2].monthlyCOP === 170000 && sr[2].perTripCOP === 22000, JSON.stringify(sr));
  t('…aviso y vuelve a pedir las tarifas', b.toasts.includes('Tarifa de Rionegro guardada') && b.calls.filter(c => c[0] === 'adminSectorRates').length >= 2);
  b.type(rowS('guarne').querySelector('[data-cbt="monthlyCOP"]'), '0');
  b.click(rowS('guarne').querySelector('[data-cb="rate-save"]')); await wait(20);
  t('valor 0: no se guarda y lo dice', /de \$1 a \$10\.000\.000/.test(b.toasts.at(-1)) && b.calls.filter(c => c[0] === 'adminSaveSectorRate').length === 1);
  b.type(rowS('llanogrande').querySelector('[data-cbt="monthlyCOP"]'), '');
  b.type(rowS('llanogrande').querySelector('[data-cbt="perTripCOP"]'), '');
  b.click(rowS('llanogrande').querySelector('[data-cb="rate-save"]')); await wait(30);
  const del = b.calls.filter(c => c[0] === 'adminSaveSectorRate').at(-1);
  t('los dos vacíos = borrar la tarifa (adminSaveSectorRate con nulls) y lo dice', del[1] === 'Llanogrande' && del[2].monthlyCOP === null && del[2].perTripCOP === null && b.toasts.includes('Tarifa de Llanogrande borrada'));
  b.click(b.q('[data-cb="rate-add"]')); await wait(10);
  t('agregar sin nombre: lo pide', /Escribe el nombre del sector/.test(b.toasts.at(-1)));
  b.type(b.q('[data-cbt-new="sector"]'), 'El Carmen');
  b.click(b.q('[data-cb="rate-add"]')); await wait(10);
  t('agregar sin ningún valor: lo pide', /Escribe la mensualidad o el valor por viaje/.test(b.toasts.at(-1)));
  b.type(b.q('[data-cbt-new="perTripCOP"]'), '28000');
  b.click(b.q('[data-cb="rate-add"]')); await wait(30);
  const add = b.calls.filter(c => c[0] === 'adminSaveSectorRate').at(-1);
  t('agregar → adminSaveSectorRate("El Carmen", {monthlyCOP:null, perTripCOP:28000})', add[1] === 'El Carmen' && add[2].monthlyCOP === null && add[2].perTripCOP === 28000, JSON.stringify(add));
  // Valor propio: esos NO pagan la mensualidad del sector (las cuentas de 0090 casi todas lo tienen).
  t('«1 con valor propio (no usa esta mensualidad)» en el sector que lo tiene, con «Que paguen la del sector»', /1 con valor propio \(no usa esta mensualidad\)/.test(txt(rowS('rionegro').querySelector('[data-cb-own]')))
    && !!rowS('rionegro').querySelector('[data-cb="rate-use"]') && !rowS('llanogrande').querySelector('[data-cb-own]') && !rowS('llanogrande').querySelector('[data-cb="rate-use"]'));
  const confirms = []; w.confirm = (m) => { confirms.push(m); return true; };
  b.click(rowS('rionegro').querySelector('[data-cb="rate-use"]')); await wait(40);
  const use = b.calls.find(c => c[0] === 'adminUseSectorRate');
  t('…pide confirmación (a cuántos, el monto, desde el próximo corte) → adminUseSectorRate("Rionegro")', use && use[1] === 'Rionegro'
    && /Quitar el valor propio a 1 tripulante de Rionegro\? Desde su próximo corte pagan la del sector: \$170\.000\. Las cuentas de cobro ya abiertas no cambian\./.test(confirms.at(-1)), JSON.stringify([use, confirms.at(-1)]));
  t('…y lo dice con lo que contestó la base: «1 cuenta de Rionegro pasa a la del sector desde su próximo corte»', b.toasts.includes('1 cuenta de Rionegro pasa a la del sector desde su próximo corte'), b.toasts.at(-1));
  w.confirm = () => false;
  const nUse = b.calls.filter(c => c[0] === 'adminUseSectorRate').length;
  b.click(rowS('rionegro').querySelector('[data-cb="rate-use"]')); await wait(20);
  t('…si no confirma, no se llama a la base', b.calls.filter(c => c[0] === 'adminUseSectorRate').length === nUse);
  w.confirm = () => true;
  b.D.rates.sectors.find(x => x.sector === 'Rionegro').monthlyCOP = null;
  b.click(b.q('[data-cb="panel"][data-v="rates"]')); await wait(5);
  b.click(b.q('[data-cb="panel"][data-v="rates"]')); await wait(30);
  t('sector sin mensualidad: dice cuántos tienen valor propio pero NO ofrece quitárselo (quedarían sin monto)', /1 con valor propio/.test(txt(rowS('rionegro'))) && !rowS('rionegro').querySelector('[data-cb="rate-use"]'));
  b.D.ratesErr = true;
  b.click(b.q('[data-cb="panel"][data-v="rates"]')); await wait(5);
  b.click(b.q('[data-cb="panel"][data-v="rates"]')); await wait(30);
  t('si la base no tiene 0094: «No pudimos cargar las tarifas por sector»', /No pudimos cargar las tarifas por sector/.test(b.q('.cb-panel').textContent));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 5).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 0094 · Sector y valor propio en la cuenta, chip y filtro de vacaciones ──');
{
  const b = await boot({ lista: LISTA94 });
  const { w } = b;
  w.renderCobro(); await wait(30);
  const who = (a) => txt(b.row(a).querySelector('.cb-who span'));
  t('la fila dice su sector (de la residencia o a mano) o «Sin sector»', who('b-vac') === 'AUX-0201 · Llanogrande · 3000000011' && who('b-casa') === 'AUX-0203 · Sin sector · juan@prueba.test' && /Marinilla/.test(who('b-next')), [who('b-vac'), who('b-casa')].join(' // '));
  // El front NO elige el monto: pinta el que da la base. Que la base elija bien
  // (propio → sector → por defecto) solo lo prueba _verify-0094.mjs contra una base.
  t('con cuenta de cobro abierta, la fila muestra SU monto (vacaciones: 3 × $25.000 = $75.000), no la mensualidad del sector', txt(b.row('b-vac').querySelector('.cb-amt b')) === '$75.000', txt(b.row('b-vac').querySelector('.cb-amt b')));
  t('sin cuenta de cobro abierta, la fila muestra la mensualidad efectiva que da la base (effectiveAmountCOP; aquí, la del sector: $180.000)', txt(b.row('b-sec').querySelector('.cb-amt b')) === '$180.000'
    && /^Primer corte el /.test(txt(b.row('b-sec').querySelector('.cb-amt span'))) && txt(b.row('b-sin').querySelector('.cb-amt b')) === '—');
  t('saldada sola en $0: «$0 · Pagó el …» con el chip «Vacaciones»', txt(b.row('b-zero').querySelector('.cb-amt b')) === '$0' && /^Pagó el /.test(txt(b.row('b-zero').querySelector('.cb-amt span')))
    && txt(b.row('b-zero').querySelector('[data-cb-chip="vac"]')) === 'Vacaciones');
  t('«Valor propio» solo en quien tiene monto propio distinto del sector (Iván: $160.000 vs Rionegro $170.000), con la razón', txt(b.row('b-rio').querySelector('[data-cb-chip="own"]')) === 'Valor propio'
    && /No paga la del sector Rionegro \(\$170\.000\)/.test(b.row('b-rio').querySelector('[data-cb-chip="own"]').getAttribute('title')) && !b.row('b-vac').querySelector('[data-cb-chip="own"]') && !b.row('b-sec').querySelector('[data-cb-chip="own"]'));
  t('chip «Vacaciones» (este cobro) y «Vacaciones en <mes>» (el siguiente)', txt(b.row('b-vac').querySelector('[data-cb-chip="vac"]')) === 'Vacaciones'
    && /^Vacaciones en \w+/.test(txt(b.row('b-next').querySelector('[data-cb-chip="vac-next"]'))) && !b.row('b-rio').querySelector('[data-cb-chip^="vac"]'));
  const counts = b.qa('.cb-tools .cb-filters button').map(x => txt(x)).join('|');
  t('filtro «Vacaciones» con su conteo (3)', /Vacaciones 3/.test(counts), counts);
  b.click(b.q('.cb-tools .cb-filters [data-v="vacaciones"]')); await wait(10);
  t('filtro Vacaciones → las tres con vacaciones (esta, la siguiente y la saldada sola)', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'b-vac,b-next,b-zero', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(','));
  b.click(b.q('.cb-tools .cb-filters [data-v="todos"]')); await wait(10);
  // 30-sep: sin valor (ni propio ni del sector) → no se le abre cobro.
  t('chip «Sin valor» solo en quien no tiene valor propio ni sector con mensualidad (Juan), con «Sin valor: no se le abre cobro»', txt(b.row('b-casa').querySelector('[data-cb-chip="noval"]')) === 'Sin valor'
    && txt(b.row('b-casa').querySelector('.cb-amt span')) === 'Sin valor: no se le abre cobro' && !b.row('b-vac').querySelector('[data-cb-chip="noval"]') && !b.row('b-sin').querySelector('[data-cb-chip="noval"]'));
  t('filtro «Sin valor» con su conteo (1) → solo Juan', /Sin valor 1/.test(b.qa('.cb-tools .cb-filters button').map(x => txt(x)).join('|')));
  b.click(b.q('.cb-tools .cb-filters [data-v="sinvalor"]')); await wait(10);
  t('…al tocarlo, la lista queda con Juan', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'b-casa', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(','));
  b.click(b.q('.cb-tools .cb-filters [data-v="todos"]')); await wait(10);
  // Se cobra la diferencia: lo pendiente para el próximo cobro y lo que la cuenta ya trae.
  t('chip «Extra pendiente $30.000» (reservó de más con la cuenta pagada) y «Incluye extra $40.000» (la cuenta abierta trae viajes de un cobro anterior)',
    txt(b.row('b-next').querySelector('[data-cb-chip="extra-pend"]')) === 'Extra pendiente $30.000' && txt(b.row('b-rio').querySelector('[data-cb-chip="extra-inc"]')) === 'Incluye extra $40.000'
    && /Viajes extra de vacaciones de agosto/.test(b.row('b-rio').querySelector('[data-cb-chip="extra-inc"]').getAttribute('title'))
    && !b.row('b-vac').querySelector('[data-cb-chip^="extra"]'));
  // Editor
  b.click(b.row('b-vac').querySelector('[data-m="edit"]')); await wait(40);
  const f = (a, k) => b.row(a).querySelector(`[data-cbf="${k}"]`);
  const lbl = (a, k) => txt(f(a, k).closest('.cb-f').querySelector('span'));
  t('editor (30-sep): «Valor propio (COP)» es el campo principal, vacío con «Vacío = la del sector Llanogrande: $180.000»', lbl('b-vac', 'amountCOP') === 'Valor propio (COP)' && f('b-vac', 'amountCOP').value === ''
    && b.row('b-vac').querySelector('.cb-grid .cb-f [data-cbf]').getAttribute('data-cbf') === 'amountCOP'
    && /Vacío = la mensualidad de su sector; sin ninguna, no se le abre cobro\./.test(txt(f('b-vac', 'amountCOP').closest('.cb-f')))
    && f('b-vac', 'amountCOP').getAttribute('placeholder') === 'Vacío = la del sector Llanogrande: $180.000', f('b-vac', 'amountCOP').getAttribute('placeholder'));
  t("campo Sector: vacío = el de su residencia (dice cuál y dónde vive), con la lista de sectores (también los que solo tienen tarifa)", f('b-vac', 'sector').value === '' && f('b-vac', 'sector').getAttribute('placeholder') === 'De su residencia: Llanogrande'
    && /Vive en Quintas de Llanogrande \(sector Llanogrande\)\. Vacío = el de su residencia\./.test(txt(f('b-vac', 'sector').closest('.cb-f')))
    && [...b.row('b-vac').querySelectorAll('#cb-sectors option')].map(o => o.value).join('|') === 'Guarne|Llanogrande|Marinilla|Rionegro');
  b.click(b.row('b-vac').querySelector('[data-cb="save-acc"]')); await wait(30);
  const sa = b.calls.find(c => c[0] === 'adminSaveAccount' && c[1] === 'b-vac');
  t('guardar SIN valor propio (su sector tiene mensualidad) → adminSaveAccount(amountCOP:null) y NO toca el sector', sa && sa[2].amountCOP === null && !b.calls.some(c => c[0] === 'adminSetSector'), JSON.stringify(sa));
  // Valor propio que pisa la tarifa del sector: el editor lo dice.
  b.click(b.row('b-rio').querySelector('[data-m="edit"]')); await wait(30);
  t('editor con valor propio: «Tiene valor propio: no paga la del sector Rionegro ($170.000). Bórralo…»', f('b-rio', 'amountCOP').value === '160000'
    && /Tiene valor propio: no paga la del sector Rionegro \(\$170\.000\)\. Bórralo para que pague la del sector\./.test(txt(f('b-rio', 'amountCOP').closest('.cb-f'))));
  b.click(b.row('b-rio').querySelector('[data-cb="close"]')); await wait(10);
  // Casa, sin sector ni valor: no se deja guardar sin nada; con sector a mano sí.
  b.click(b.row('b-casa').querySelector('[data-m="edit"]')); await wait(30);
  t('vive en casa: «asígnale uno a mano» y el valor dice que falta', /Vive en casa \(sin conjunto\): asígnale uno a mano\./.test(txt(f('b-casa', 'sector').closest('.cb-f')))
    && f('b-casa', 'amountCOP').getAttribute('placeholder') === 'Sin sector con mensualidad: escribe su valor', f('b-casa', 'amountCOP').getAttribute('placeholder'));
  b.click(b.row('b-casa').querySelector('[data-cb="save-acc"]')); await wait(20);
  t('sin valor propio ni sector con mensualidad: no se guarda y lo dice («Falta el valor…»)', /^Falta el valor: escribe su valor propio \(o carga la mensualidad de su sector en «Tarifas por sector»\)$/.test(b.toasts.at(-1)) && !b.calls.some(c => c[0] === 'adminSaveAccount' && c[1] === 'b-casa'), b.toasts.at(-1));
  b.type(f('b-casa', 'sector'), 'marinilla');
  t('al escribir un sector con tarifa, el «vacío = …» se actualiza en su lugar (sin repintar)', f('b-casa', 'amountCOP').getAttribute('placeholder') === 'Vacío = la del sector marinilla: $200.000', f('b-casa', 'amountCOP').getAttribute('placeholder'));
  b.click(b.row('b-casa').querySelector('[data-cb="save-acc"]')); await wait(40);
  const sa2 = b.calls.find(c => c[0] === 'adminSaveAccount' && c[1] === 'b-casa');
  const ss = b.calls.find(c => c[0] === 'adminSetSector');
  t('…con el sector puesto a mano (Marinilla tiene mensualidad) sí se guarda: adminSaveAccount + adminSetSector("b-casa","marinilla")',
    !!sa2 && sa2[2].amountCOP === null && ss && ss[1] === 'b-casa' && ss[2] === 'marinilla' && b.calls.indexOf(ss) > b.calls.indexOf(sa2), JSON.stringify([sa2, ss]));
  // Quitar el sector a mano
  b.click(b.row('b-next').querySelector('[data-m="edit"]')); await wait(30);
  t('sector puesto a mano: el campo lo trae', f('b-next', 'sector').value === 'Marinilla');
  b.type(f('b-next', 'sector'), '');
  b.type(f('b-next', 'amountCOP'), '210000');
  b.click(b.row('b-next').querySelector('[data-cb="save-acc"]')); await wait(40);
  const ss2 = b.calls.filter(c => c[0] === 'adminSetSector').at(-1);
  t('borrarlo → adminSetSector(aux, null) (vuelve el de su residencia)', ss2 && ss2[1] === 'b-next' && ss2[2] === null, JSON.stringify(ss2));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 5).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 0094 · Vacaciones desde el admin ──');
{
  const b = await boot({ lista: LISTA94 });
  const { w } = b;
  w.renderCobro(); await wait(30);
  t('«Vacaciones» en las acciones de quien tiene cuenta activa (no en quien no tiene cuenta)', !!b.row('b-vac').querySelector('[data-m="vac"]') && !b.row('b-sin').querySelector('[data-m="vac"]'));
  b.click(b.row('b-vac').querySelector('[data-m="vac"]')); await wait(20);
  const ed = () => b.row('b-vac').querySelector('.cb-ed');
  const lines = [...ed().querySelectorAll('[data-cb-vac]')];
  t('muestra este cobro (con sus vacaciones: 3 viajes × $25.000 = $75.000) y el siguiente (mensualidad)',
    lines.length === 2 && /Vacaciones: 3 viajes × \$25\.000 = \$75\.000/.test(txt(lines[0])) && /las marcó el tripulante/.test(txt(lines[0])) && /Mensualidad/.test(txt(lines[1])));
  t('«5 viajes reservados · más de lo declarado: se le cobran 2 viajes de más ($50.000)» en rojo (.cb-bad)', txt(lines[0].querySelector('.cb-bad')) === '5 viajes reservados · más de lo declarado: se le cobran 2 viajes de más ($50.000)', txt(lines[0].querySelector('.cb-bad')));
  t('30-sep · «Declarados 3 · Reservados 5 · Cobrados 5» (lo de la base, sin pendiente)', txt(lines[0].querySelector('[data-cb-vac-counts]')) === 'Declarados 3 · Reservados 5 · Cobrados 5' && !lines[1].querySelector('[data-cb-vac-counts]'), txt(lines[0].querySelector('[data-cb-vac-counts]')));
  const vf = (k) => ed().querySelector(`[data-cbf="${k}"]`);
  t('el formulario abre en el cobro con vacaciones, con sus fechas y viajes', vf('period').value === 'current' && vf('startsOn').value === addD(START, 2) && vf('endsOn').value === addD(START, 12) && vf('trips').value === '3');
  t('cálculo en vivo: «3 viajes × $25.000 (sector Llanogrande) = $75.000» y, con 5 reservados, «se cobran 5 = $125.000» (se cobra la diferencia)',
    txt(ed().querySelector('[data-cb-vac-calc]')) === '3 viajes × $25.000 (sector Llanogrande) = $75.000 · tiene 5 viajes reservados: se cobran 5 = $125.000', txt(ed().querySelector('[data-cb-vac-calc]')));
  b.type(vf('trips'), '5');
  t('…al escribir 5: «5 viajes × $25.000 (sector Llanogrande) = $125.000»', txt(ed().querySelector('[data-cb-vac-calc]')) === '5 viajes × $25.000 (sector Llanogrande) = $125.000');
  b.click(ed().querySelector('[data-cb="save-vac"]')); await wait(30);
  const sv = b.calls.find(c => c[0] === 'adminSetVacation');
  t('Marcar → adminSetVacation(aux, {period:"current", startsOn, endsOn, trips:5})', sv && sv[1] === 'b-vac' && sv[2].period === 'current' && sv[2].trips === 5 && sv[2].startsOn === addD(START, 2), JSON.stringify(sv));
  t('…aviso con el cálculo de la base y se cierra', /Vacaciones marcadas: 5 viajes × \$25\.000 = \$125\.000/.test(b.toasts.at(-1)) && !b.q('.cb-row.open'));
  b.click(b.row('b-vac').querySelector('[data-m="vac"]')); await wait(20);
  b.click(b.row('b-vac').querySelector('[data-cb="vac-cancel"][data-p="current"]')); await wait(30);
  t('Cancelar (con confirmación) → adminCancelVacation(aux, "current")', b.calls.some(c => c[0] === 'adminCancelVacation' && c[1] === 'b-vac' && c[2] === 'current') && b.toasts.includes('Vacaciones canceladas'));
  // Cobro pagado: se ve la razón y no se deja marcar ese cobro
  b.click(b.row('b-next').querySelector('[data-m="vac"]')); await wait(20);
  const ed2 = b.row('b-next').querySelector('.cb-ed');
  t('con vacaciones en el siguiente: abre ahí (6 viajes × $30.000 = $180.000) con «Cancelar vacaciones»', ed2.querySelector('[data-cbf="period"]').value === 'next'
    && /6 viajes × \$30\.000 = \$180\.000/.test(txt(ed2.querySelector('[data-cb-vac="next"]'))) && !!ed2.querySelector('[data-cb="vac-cancel"][data-p="next"]'));
  const sel = ed2.querySelector('[data-cbf="period"]'); sel.value = 'current'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(10);
  const ed3 = b.row('b-next').querySelector('.cb-ed');
  t('elegir «Este cobro» (pagado): lo dice y el botón queda deshabilitado', /Ese cobro ya está pagado/.test(txt(ed3.querySelector('[data-cb-vac-why]'))) && ed3.querySelector('[data-cb="save-vac"]').disabled
    && ed3.querySelector('[data-cbf="startsOn"]').value === START);
  // Saldada sola en $0: el tripulante no puede tocarla; el jefe sí (se reabre).
  b.click(b.row('b-zero').querySelector('[data-m="vac"]')); await wait(20);
  const edz = b.row('b-zero').querySelector('.cb-ed');
  t('saldada sola en $0: el jefe SÍ puede cambiarla (botón activo, sin «ya está pagado») y el aviso dice que se reabre y hay que pagarla',
    edz.querySelector('[data-cbf="period"]').value === 'current' && !edz.querySelector('[data-cb="save-vac"]').disabled && !edz.querySelector('[data-cb-vac-why]')
    && /quedó saldado solo en \$0.*se reabre con el monto nuevo y hay que pagarlo/.test(txt(edz.querySelector('[data-cb-vac-info]'))), txt(edz));
  b.w.ApiCobro.adminSetVacation = async (aux, f) => { b.calls.push(['adminSetVacation', aux, JSON.parse(JSON.stringify(f))]); return { vacation: { trips: f.trips, perTripCOP: 25000, totalCOP: 25000 * f.trips }, reopened: true }; };
  b.type(edz.querySelector('[data-cbf="trips"]'), '2');
  b.click(edz.querySelector('[data-cb="save-vac"]')); await wait(30);
  t('…reabrirla con 2 viajes → adminSetVacation y el aviso «· el cobro se reabrió»', b.calls.some(c => c[0] === 'adminSetVacation' && c[1] === 'b-zero' && c[2].trips === 2)
    && /Vacaciones marcadas: 2 viajes × \$25\.000 = \$50\.000 · el cobro se reabrió/.test(b.toasts.at(-1)), b.toasts.at(-1));
  const confirmsV = []; w.confirm = (m) => { confirmsV.push(m); return true; };
  b.click(b.row('b-zero').querySelector('[data-m="vac"]')); await wait(20);
  b.click(b.row('b-zero').querySelector('[data-cb="vac-cancel"][data-p="current"]')); await wait(30);
  t('cancelar la saldada sola: la confirmación dice que se reabre con la mensualidad', /quedó saldado solo en \$0: se reabre con la mensualidad y hay que pagarlo/.test(confirmsV.at(-1)), confirmsV.at(-1));
  b.click(b.row('b-next').querySelector('[data-m="vac"]')); await wait(20);
  b.click(b.row('b-next').querySelector('[data-cb="vac-cancel"][data-p="next"]')); await wait(30);
  t('cancelar las del siguiente (sin cuenta de cobro): «vuelve a la mensualidad»', /Ese cobro vuelve a la mensualidad\./.test(confirmsV.at(-1)), confirmsV.at(-1));
  w.confirm = () => true;
  // Vencida: el tripulante ya no la puede cambiar; el jefe sí.
  const bv = b.D.list.find(x => x.auxiliarProfileId === 'b-vac');
  bv.vacation.current = per(START, { st: 's-vac', booked: 5, taken: 4, can: false, why: 'overdue', over: true, acan: true, vac: VACR(START, 3) });
  b.click(b.q('[data-cb="reload"]')); await wait(40);
  b.click(b.row('b-vac').querySelector('[data-m="vac"]')); await wait(20);
  const edo = b.row('b-vac').querySelector('.cb-ed');
  t('vencida: el jefe la puede cambiar y se le avisa que el tripulante ya no', !edo.querySelector('[data-cb="save-vac"]').disabled && !edo.querySelector('[data-cb-vac-why]')
    && /Ese cobro está vencido: el tripulante ya no lo puede cambiar; tú sí/.test(txt(edo.querySelector('[data-cb-vac-info]'))), txt(edo));
  b.click(edo.querySelector('[data-cb="close"]')); await wait(10);
  bv.vacation.current = per(START, { st: 's-vac', booked: 5, taken: 4, vac: VACR(START, 3) });
  b.click(b.q('[data-cb="reload"]')); await wait(40);
  b.click(b.row('b-vac').querySelector('[data-m="vac"]')); await wait(20);
  t('con viajes ya hechos: «Ya hizo 4 viajes en ese cobro: el tripulante no puede declarar menos»', /Ya hizo 4 viajes en ese cobro: el tripulante no puede declarar menos/.test(txt(b.row('b-vac').querySelector('[data-cb-vac-info]'))));
  b.click(b.row('b-vac').querySelector('[data-cb="close"]')); await wait(10);
  // Sector sin valor por viaje
  b.click(b.row('b-rio').querySelector('[data-m="vac"]')); await wait(20);
  const ed4 = b.row('b-rio').querySelector('.cb-ed');
  t('sector sin valor por viaje: «El sector Rionegro no tiene valor por viaje» y sin botón de marcar', /El sector Rionegro no tiene valor por viaje/.test(txt(ed4)) && !ed4.querySelector('[data-cb="save-vac"]'));
  // Fechas al revés
  b.click(b.row('b-vac').querySelector('[data-m="vac"]')); await wait(20);
  const ed5 = b.row('b-vac').querySelector('.cb-ed');
  b.type(ed5.querySelector('[data-cbf="startsOn"]'), addD(START, 20)); b.type(ed5.querySelector('[data-cbf="endsOn"]'), addD(START, 10));
  const n0 = b.calls.filter(c => c[0] === 'adminSetVacation').length;
  b.click(ed5.querySelector('[data-cb="save-vac"]')); await wait(20);
  t('fechas al revés: no se manda y lo dice', /el regreso no puede ser antes de la salida/.test(b.toasts.at(-1)) && b.calls.filter(c => c[0] === 'adminSetVacation').length === n0);
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 5).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 0094 · Balance del mes y Excel ──');
{
  const b = await boot({ lista: LISTA94, excel: true });
  const { w } = b;
  w.renderCobro(); await wait(30);
  const views = b.qa('.cb-views button').map(x => txt(x)).join('|');
  t('pestañas «Cuentas | Balance del mes» (píldoras de siempre)', views === 'Cuentas|Balance del mes', views);
  b.click(b.q('.cb-views [data-v="balance"]')); await wait(40);
  const bc = b.calls.find(c => c[0] === 'adminBalance');
  t('Balance → adminBalance(mes de hoy AAAA-MM)', bc && bc[1] === MES_HOY, JSON.stringify(bc));
  t('en el balance no se pinta la lista de cuentas ni los comprobantes por revisar', !b.q('.cb-row') && !b.q('.cb-proofs') && !!b.q('.cb-bal'));
  const tot = (l) => { const e = b.q(`[data-cb-tot="${l}"]`); return e ? txt(e.querySelector('b')) + (e.querySelector('em') ? ' | ' + txt(e.querySelector('em')) : '') : null; };
  t('totales de la base: facturado, descuentos, neto, cobrado, pendiente',
    tot('Facturado (bruto)') === '$525.000 | 5 cuentas de cobro' && tot('Descuentos') === '$10.000' && tot('Neto a cobrar') === '$515.000'
    && tot('Cobrado') === '$270.000 | 3 pagadas' && tot('Pendiente') === '$245.000 | 2 sin pagar', ['Facturado (bruto)', 'Cobrado', 'Pendiente'].map(tot).join(' // '));
  t('…en revisión, en mora (en rojo), pausadas, mensualidades, vacaciones con viajes declarados/reservados',
    tot('En revisión') === '$0 | 0 comprobantes' && /^\$170\.000 \| 1 cuenta/.test(tot('En mora')) && b.q('[data-cb-tot="En mora"] b').classList.contains('bad')
    && tot('Pausadas') === '$0 | 0 cuentas' && tot('Mensualidades') === '$340.000 | 2 cuentas'
    && tot('Vacaciones') === '$175.000 | 3 cuentas · 7 viajes declarados, 9 reservados', ['En mora', 'Vacaciones'].map(tot).join(' // '));
  t('30-sep · los extras: «Tienen viajes extra» 1 (2 viajes de más · $50.000) en rojo, extra cobrado, extra pendiente (rojo) y lo de cobros anteriores',
    tot('Tienen viajes extra') === '1 | 2 viajes de más · $50.000' && b.q('[data-cb-tot="Tienen viajes extra"] b').classList.contains('bad')
    && tot('Extra cobrado') === '$25.000 | Viajes de más que ya entraron en una cuenta' && tot('Extra pendiente') === '$25.000 | Entra en el próximo cobro'
    && b.q('[data-cb-tot="Extra pendiente"] b').classList.contains('bad') && tot('Extra de cobros anteriores') === '$40.000 | 1 cuenta lo incluye',
    ['Tienen viajes extra', 'Extra cobrado', 'Extra pendiente', 'Extra de cobros anteriores'].map(tot).join(' // '));
  t('«Sin cuenta de cobro este mes»: 1, y «1 tripulante sin cuenta»', tot('Sin cuenta de cobro este mes') === '1 | 1 tripulante sin cuenta');
  t('30-sep · «Sin valor cargado»: 1 tripulante (en rojo), no se le abre cobro', tot('Sin valor cargado') === '1 | 1 tripulante sin valor cargado: no se les abre cobro' && b.q('[data-cb-tot="Sin valor cargado"] b').classList.contains('bad'), tot('Sin valor cargado'));
  const secRows = b.qa('.cb-bal-sec tbody tr').map(r => [...r.querySelectorAll('td')].map(txt).join(' ; '));
  t('por sector: tripulantes, cuentas, neto, cobrado, pendiente, vacaciones, tarifa vigente; «Sin sector» al final',
    secRows.length === 3 && secRows[0] === 'Llanogrande ; 3 ; 3 ; $175.000 ; $100.000 ; $75.000 ; 3 ; $180.000/mes · $25.000/viaje'
    && /Sin valor por viaje/.test(secRows[1]) && /^Sin sector/.test(secRows[2]), secRows.join(' // '));
  const tr = (id) => b.q(`.cb-bal-rows tr[data-cb-bal="${id}"]`);
  const cells = (id) => [...tr(id).querySelectorAll('td')].map(txt);
  const heads = b.qa('.cb-bal-rows thead th').map(txt).join('|');
  t('por tripulante (30-sep): columnas Declarados · Reservados · Cobrados · Extra cobrado · Extra pendiente', heads === 'Tripulante|Sector|Modalidad|Declarados|Reservados|Cobrados|Extra cobrado|Extra pendiente|Monto|Descuento|Neto|Estado|Pagó|Medio · aprobó|Días de mora', heads);
  const td = (id, i) => tr(id).querySelectorAll('td')[i];
  t('…vacaciones: 3 · 5 · 4 · $25.000 · $25.000; la marca roja ahora es «Tiene extra: 2 viajes · $50.000» y la fila marcada', tr('s-vac').classList.contains('over')
    && /^Vacaciones\s*Tiene extra: 2 viajes · \$50\.000$/.test(cells('s-vac')[2]) && td('s-vac', 2).querySelector('[data-cb-bal-extra]').classList.contains('cb-bad')
    && cells('s-vac')[3] === '3' && cells('s-vac')[4] === '5' && td('s-vac', 4).classList.contains('cb-bad') && cells('s-vac')[5] === '4'
    && cells('s-vac')[6] === '$25.000' && td('s-vac', 6).classList.contains('cb-bad') && cells('s-vac')[7] === '$25.000' && td('s-vac', 7).classList.contains('cb-bad'), cells('s-vac').join(' ; '));
  t('…mensual: «—» en declarados/cobrados/extras, la cuenta que trae $40.000 de extra de antes lo dice en el Monto; pagado, medio, aprobó y 2 días de mora en rojo',
    cells('s-rio')[2] === 'Mensual' && cells('s-rio')[3] === '—' && cells('s-rio')[4] === '8' && cells('s-rio')[5] === '—' && cells('s-rio')[6] === '—' && cells('s-rio')[7] === '—'
    && cells('s-rio')[8] === '$170.000Incluye $40.000 de viajes extra de un cobro anterior'
    && cells('s-rio')[11] === 'Al día' && cells('s-rio')[12] === fd(HOY) && cells('s-rio')[13] === 'Nequi · Jefa Prueba' && cells('s-rio')[14] === '2'
    && td('s-rio', 14).classList.contains('cb-bad') && !tr('s-rio').classList.contains('over'), cells('s-rio').join(' ; '));
  t('…descuento con su motivo, neto y estado «En mora» (el de la base)', /\$10\.000Canje de puntos/.test(cells('s-casa')[9]) && cells('s-casa')[10] === '$170.000' && cells('s-casa')[11] === 'En mora' && cells('s-casa')[1] === 'Sin sector');
  t('«Sin cuenta de cobro este mes»: Kata, con su corte pendiente', /Kata Prueba/.test(txt(b.q('.cb-bal ~ .cb-sec .cb-method, .cb-sec .cb-method'))) && /Su corte es el 28 de/.test(b.R().textContent));
  const pays = b.qa('.cb-bal-pays tbody tr').map(r => [...r.querySelectorAll('td')].map(txt).join(' ; '));
  t('comprobantes y pagos: aprobado, pago con comprobante, rechazado con su motivo, y quién', pays.length === 4 && /Comprobante ; Nequi ; \$170\.000 ; Aprobado ; Jefa Prueba/.test(pays[0])
    && /Pago ; Nequi ; \$170\.000 ; Con comprobante/.test(pays[1]) && /Rechazado\s*El monto no coincide/.test(pays[2]), pays.join(' // '));
  t('…el saldo automático de $0: «Saldado solo ($0)» y «Automático» (nunca el nombre del tripulante)', /^.* ; Nina Prueba.* ; Pago ; Vacaciones sin viajes ; \$0 ; Saldado solo \(\$0\) ; Automático$/.test(pays[3]) && !/Nina Prueba$/.test(pays[3]), pays[3]);
  t('por tripulante: la saldada sola dice «Vacaciones sin viajes · Automático» y 0 días de mora', cells('s-auto')[13] === 'Vacaciones sin viajes · Automático' && cells('s-auto')[14] === '0' && cells('s-auto')[10] === '$0', cells('s-auto').join(' ; '));
  t('…y la pagada con vacaciones canceladas después sigue «Vacaciones» con la nota (la foto de la cuenta)', /^Vacaciones\s*Canceladas después de pagar$/.test(cells('s-canc')[2]) && cells('s-canc')[3] === '4' && cells('s-canc')[4] === '4', cells('s-canc').join(' ; '));
  const all = b.R().innerHTML;
  t('sin textos inventados del diseño', PROHIBIDOS.every(p => !all.includes(p)), PROHIBIDOS.filter(p => all.includes(p)).join(','));
  // Otro mes
  const mi = b.q('[data-cbb="month"]'); mi.value = '2026-08'; mi.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(40);
  t('cambiar de mes → adminBalance("2026-08")', b.calls.some(c => c[0] === 'adminBalance' && c[1] === '2026-08'));

  console.log('   · Excel (ExcelJS real del vendor)');
  t('ExcelJS cargó en jsdom', !!w.ExcelJS && typeof w.ExcelJS.Workbook === 'function');
  b.click(b.q('[data-cb="bal-xlsx"]')); await wait(400);
  const st8 = w.renderCobro._state();
  const MES_BAL = BAL().month.slice(0, 7);
  t('«Descargar Excel» arma el archivo y lo descarga con nombre cuentas_de_cobro_AAAA-MM.xlsx', !!st8.xlsx && st8.xlsx.file === 'cuentas_de_cobro_' + MES_BAL + '.xlsx'
    && (w.__descargas || []).includes(st8.xlsx.file) && /Excel listo/.test(b.toasts.at(-1)), JSON.stringify([st8.xlsx && st8.xlsx.file, w.__descargas, b.toasts.at(-1)]));
  const wb = new w.ExcelJS.Workbook();
  let leido = true;
  try { await wb.xlsx.load(st8.xlsx.buf); } catch (e) { leido = false; console.log('   (no se pudo leer el Excel: ' + e.message + ')'); }
  t('el Excel se vuelve a abrir y trae las 4 hojas: Resumen, Por tripulante, Por sector, Pagos', leido && wb.worksheets.map(s => s.name).join('|') === 'Resumen|Por tripulante|Por sector|Pagos', wb.worksheets.map(s => s.name).join('|'));
  if (leido && wb.worksheets.length === 4) {
    const R = wb.getWorksheet('Resumen'), PT = wb.getWorksheet('Por tripulante'), PS = wb.getWorksheet('Por sector'), PG = wb.getWorksheet('Pagos');
    const find = (ws, txt0) => { let hit = null; ws.eachRow((row) => { if (!hit && String(row.getCell(1).value) === txt0) hit = row; }); return hit; };
    t('Resumen: título con el mes, encabezados en negrita, «Facturado (bruto)» $425.000 con formato de pesos', /Cuentas de cobro · /.test(String(R.getCell('A1').value))
      && R.getRow(3).getCell(1).font.bold === true && find(R, 'Facturado (bruto)').getCell(2).value === 525000 && find(R, 'Facturado (bruto)').getCell(2).numFmt === '"$" #,##0');
    t('Resumen (30-sep): «Tienen viajes extra» = 1 en rojo', find(R, 'Tienen viajes extra').getCell(2).value === 1 && /B91C1C/.test(JSON.stringify(find(R, 'Tienen viajes extra').getCell(2).font)) && !find(R, 'Reservaron más de lo declarado'));
    t('Resumen: el total de extras en pesos (cobrados $25.000, pendientes $25.000 en rojo, de cobros anteriores $40.000) y «Tripulantes sin valor cargado» = 1',
      find(R, 'Viajes extra cobrados').getCell(2).value === 25000 && find(R, 'Viajes extra cobrados').getCell(2).numFmt === '"$" #,##0'
      && find(R, 'Viajes extra pendientes').getCell(2).value === 25000 && /B91C1C/.test(JSON.stringify(find(R, 'Viajes extra pendientes').getCell(2).font))
      && find(R, 'Viajes extra de cobros anteriores').getCell(2).value === 40000 && find(R, 'Tripulantes sin valor cargado').getCell(2).value === 1);
    const hana = find(PT, 'Hana Prueba');
    const hdr = []; PT.getRow(3).eachCell((cc) => hdr.push(cc.value));
    t('Por tripulante: 23 columnas con anchos y encabezados Declarados · Reservados · Cobrados · Extra cobrado · Extra pendiente',
      PT.columns.length === 23 && PT.columns.every(c => c.width > 0) && hdr.slice(5, 11).join('|') === 'Declarados|Reservados|Cobrados|Extra cobrado|Extra pendiente|¿Tiene extra?', hdr.join('|'));
    t('…vacaciones: 3 · 5 · 4 · $25.000 · $25.000 (rojo) · «Sí: 2 viajes» en rojo', hana.getCell(4).value === 'Vacaciones' && hana.getCell(6).value === 3 && hana.getCell(7).value === 5
      && hana.getCell(8).value === 4 && hana.getCell(9).value === 25000 && hana.getCell(9).numFmt === '"$" #,##0' && hana.getCell(10).value === 25000
      && /B91C1C/.test(JSON.stringify(hana.getCell(10).font)) && hana.getCell(11).value === 'Sí: 2 viajes' && /B91C1C/.test(JSON.stringify(hana.getCell(11).font)));
    const ivan = find(PT, 'Iván Prueba');
    t('Por tripulante: montos en pesos (con lo que trae de cobros anteriores), estado, medio, aprobó y días de mora', ivan.getCell(12).value === 170000 && ivan.getCell(12).numFmt === '"$" #,##0'
      && ivan.getCell(13).value === 40000 && ivan.getCell(17).value === 'Al día' && ivan.getCell(20).value === 'Nequi' && ivan.getCell(22).value === 'Jefa Prueba' && ivan.getCell(23).value === 2);
    const totPT = find(PT, 'Total');
    t('Por tripulante: fila Total con SUM del neto y de los extras', totPT && totPT.getCell(16).value && /SUM\(P4:P8\)/.test(totPT.getCell(16).value.formula) && totPT.getCell(16).value.result === 515000
      && /SUM\(I4:I8\)/.test(totPT.getCell(9).value.formula) && totPT.getCell(9).value.result === 25000 && totPT.getCell(13).value.result === 40000);
    const nina = find(PT, 'Nina Prueba'), olga = find(PT, 'Olga Prueba');
    t('Por tripulante: el saldo automático dice «Automático» en «Aprobó»; la de vacaciones canceladas después de pagar lo dice en la modalidad',
      nina && nina.getCell(22).value === 'Automático' && nina.getCell(16).value === 0 && olga && olga.getCell(4).value === 'Vacaciones (canceladas después de pagar)' && olga.getCell(22).value === 'Jefa Prueba');
    t('Por sector: los 3 sectores (con «Sin sector») y su neto en pesos', !!find(PS, 'Llanogrande') && !!find(PS, 'Sin sector') && find(PS, 'Rionegro').getCell(4).value === 170000
      && find(PS, 'Rionegro').getCell(9).value === 'Sin valor' && find(PS, 'Llanogrande').getCell(4).numFmt === '"$" #,##0');
    const pgRows = []; PG.eachRow((row, i) => { if (i > 3) pgRows.push([2, 3, 7, 8, 9].map(k => row.getCell(k).value).join(' ; ')); });
    t('Pagos: los 4 movimientos con estado y motivo del rechazo (y el automático)', pgRows.length === 4 && pgRows[0] === 'Comprobante ; Iván Prueba ; 170000 ; Aprobado ; ' && pgRows[2] === 'Comprobante ; Juan Prueba ; 150500 ; Rechazado ; El monto no coincide'
      && pgRows[3] === 'Pago ; Nina Prueba ; 0 ; Saldado solo ($0) ; ', pgRows.join(' // '));
    const todo = JSON.stringify(wb.worksheets.map(s => { const a = []; s.eachRow(r => a.push(r.values)); return a; }));
    t('el Excel no trae textos inventados del diseño', PROHIBIDOS.every(p => !todo.includes(p)), PROHIBIDOS.filter(p => todo.includes(p)).join(','));
  }
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 5).join('.'));
  // Sin ExcelJS y sin 0094
  const b2 = await boot({ lista: LISTA94 });
  b2.w.renderCobro(); await wait(30);
  b2.click(b2.q('.cb-views [data-v="balance"]')); await wait(40);
  b2.click(b2.q('[data-cb="bal-xlsx"]')); await wait(30);
  t('sin la librería de Excel: lo dice (no falla en silencio)', /No se pudo cargar la librería de Excel/.test(b2.toasts.at(-1)));
  b2.D.balErr = true;
  b2.click(b2.q('[data-cb="bal-reload"]')); await wait(40);
  t('si la base no tiene el balance: «No pudimos cargar el balance» + Reintentar, y el Excel deshabilitado', /No pudimos cargar el balance/.test(b2.R().textContent) && b2.q('[data-cb="bal-xlsx"]').disabled);
  b2.click(b2.q('.cb-views [data-v="cuentas"]')); await wait(20);
  t('volver a «Cuentas» pinta la lista otra vez', b2.qa('.cb-row').length === 7);
  b2.w.stopCobroTimer();
  t('sin errores de consola (sin Excel)', b2.errors.length === 0, b2.errors.slice(0, 3).join(' | '));

  // (revisión 1-oct) «Sin cuenta de cobro este mes»: «Sin valor» lo dice la base
  // (noValue). Quien solo tiene un valor «desde el próximo corte» (sin monto
  // efectivo hoy) NO es «sin valor».
  const b3 = await boot({ lista: LISTA94 });
  b3.D.bal = Object.assign(BAL(), { withoutStatement: [
    { auxiliarProfileId: 'b-nv', name: 'Sin Valor Prueba', reference: 'AUX-0301', sector: null, effectiveAmountCOP: null, noValue: true, cutDay: 28, cutThisMonth: MES_HOY + '-28', cutPending: true },
    { auxiliarProfileId: 'b-nx', name: 'Desde Noviembre Prueba', reference: 'AUX-0302', sector: 'Marinilla', effectiveAmountCOP: null, noValue: false, cutDay: 28, cutThisMonth: MES_HOY + '-28', cutPending: true }] });
  b3.w.renderCobro(); await wait(30);
  b3.click(b3.q('.cb-views [data-v="balance"]')); await wait(40);
  const ms = b3.qa('.cb-sec .cb-method').map(txt);
  t('sin cuenta este mes: «Sin valor» solo a quien la base dice noValue; el que tiene valor desde el próximo corte dice su corte',
    ms.length === 2 && /Sin Valor Prueba/.test(ms[0]) && /Sin valor \(ni propio ni del sector\)/.test(ms[0])
    && /Desde Noviembre Prueba/.test(ms[1]) && !/Sin valor/.test(ms[1]) && /Su corte es el 28 de/.test(ms[1]), ms.join(' // '));
  b3.w.stopCobroTimer();
  t('sin errores de consola (sin cuenta este mes)', b3.errors.length === 0, b3.errors.slice(0, 3).join(' | '));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: layout (la ficha apilada del celular y las tablas anchas del balance se miran en el teléfono), la base');
console.log('          real (RLS, reloj diario, push; 0094 solo se corrió en la base LOCAL con _verify-0094.mjs), el bucket privado real, la descarga');
console.log('          real del archivo (se intercepta el enlace) ni la navegación completa del admin (core.setTab se simula).');
process.exit(bad ? 1 : 0);
