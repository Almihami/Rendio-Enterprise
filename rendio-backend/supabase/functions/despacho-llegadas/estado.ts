// De la foto de la base (despacho_estado) al estado que entiende el motor.
// Va aparte y sin dependencias para poder probarlo con node (scripts/_test-despacho.mjs).

export type Punto = { lat: number | null; lng: number | null };
export type Foto = {
  org: string; ahora: string; aeropuerto: { lat: number; lng: number };
  cfg: { horizonte: number; juntar: number; esperaMax: number; servicio: number; trafico: number };
  llegadas: { ra: string; sale: string; pax: number; lat: number | null; lng: number | null; quien?: string }[];
  carros: {
    dp: string; cupo: number; known: boolean; free_at: string; lat: number | null; lng: number | null; air: boolean;
    salida: { eta: string; air: boolean; lat: number | null; lng: number | null } | null;
  }[];
};

// Sin posición conocida (no ha hecho vuelta hoy y no hay GPS reciente) no se
// puede prometer que está en JMC: se cuenta como si le faltaran estos minutos.
const SIN_POSICION_MIN = 25;
// Tramo sin coordenadas (dato incompleto): lo mismo que usa reub_leg (0135).
const TRAMO_SIN_DATO_MIN = 15;

export function minutosEntre(a: Punto | undefined, b: Punto | undefined, trafico: number): number {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return TRAMO_SIN_DATO_MIN;
  const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h)) * 1.4;          // ×1,4 por el trazado de las vías
  return Math.max(2, (km / 30) * 60) * (trafico || 1);       // ~30 km/h en el Oriente (igual que reub_leg)
}

export function armarEstado(foto: Foto) {
  const t0 = Date.parse(foto.ahora);
  const aMin = (iso: string) => (Date.parse(iso) - t0) / 60000;      // minutos desde «ahora»
  const aISO = (min: number) => new Date(t0 + min * 60000).toISOString();
  const puntos: Record<string, Punto> = { airport: foto.aeropuerto };
  const traf = Number(foto.cfg.trafico) || 1;
  const leg = (a: string, b: string) => (a === b ? 0 : minutosEntre(puntos[a], puntos[b], traf));

  const llegadas = foto.llegadas.map((l) => {
    puntos[l.ra] = { lat: l.lat, lng: l.lng };
    return { id: l.ra, sale: aMin(l.sale), pax: l.pax || 1, puerta: l.ra };
  });
  const carros = foto.carros.map((c) => {
    const libre = Math.max(0, aMin(c.free_at));
    let listoEn: number;
    if (!c.known) listoEn = libre + SIN_POSICION_MIN;
    else if (c.air) listoEn = libre;
    else { puntos["pos:" + c.dp] = { lat: c.lat, lng: c.lng }; listoEn = libre + leg("pos:" + c.dp, "airport"); }
    let salida = null;
    if (c.salida) {
      const k = c.salida.air ? "airport" : "sal:" + c.dp;
      if (!c.salida.air) puntos[k] = { lat: c.salida.lat, lng: c.salida.lng };
      salida = { primera: k, etaPrimera: aMin(c.salida.eta) };
    }
    return { id: c.dp, cupo: c.cupo || 4, listoEn, salida };
  });
  return {
    aISO,
    estado: {
      ahora: 0, leg, carros, llegadas,
      // Cada llegada es una vuelta ya armada por el jefe: se reparte entera, no se
      // mezcla con otra (agrupar: false).
      cfg: { horizonte: foto.cfg.horizonte, juntar: foto.cfg.juntar, esperaMax: foto.cfg.esperaMax, servicio: foto.cfg.servicio, agrupar: false },
    },
  };
}
