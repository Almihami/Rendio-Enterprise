// zonas-dibujo.js — De qué zona es un punto (0108, 13-oct-2026).
//
// Las zonas de la tabla de tiempos se DIBUJAN en el mapa (Calibración › Zonas)
// y cada conjunto toma la zona del dibujo que lo contiene. Las excepciones se
// ponen a mano (residences.zona_jefe) y ganan siempre: las zonas de Julián son
// operativas, no geográficas — Los Cerezos queda a 200 m de Olivar (Fontibón) y
// él lo puso en Porvenir.
//
// UN SOLO LECTOR DE LA REGLA. Lo usan el tablero (api.js › listRoutePlanning),
// la pantalla de calibración (admin-zonas.js) y el plan por WhatsApp
// (rendio-backend/scripts/plan-desde-formulario.mjs, que evalúa este archivo).
// Si la regla cambia, cambia aquí y nada más.
//
// Funciones puras, sin dependencias. Comparte el ámbito global con los demás
// archivos: antes de agregar un nombre, correr _nombres-repetidos.mjs.

// ¿El punto cae dentro del dibujo? `poly` es [[lat, lng], …] (3 o más), en el
// orden en que se marcaron. Rayo hacia el este: a esta escala (unos km) la
// curvatura no importa y lat/lng se tratan como un plano.
function zonaContienePunto(poly, lat, lng) {
  if (!Array.isArray(poly) || poly.length < 3) return false;
  if (lat == null || lng == null || lat === '' || lng === '') return false;
  const y = Number(lat), x = Number(lng);
  if (!isFinite(x) || !isFinite(y)) return false;
  let dentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = Number(poly[i][0]), xi = Number(poly[i][1]);
    const yj = Number(poly[j][0]), xj = Number(poly[j][1]);
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

// Nombres de TODAS las zonas cuyo dibujo contiene el punto. `zonas` es la lista
// de route_zones: [{ name, polygon }]. Las que no tienen dibujo no cuentan.
function zonasQueContienen(zonas, lat, lng) {
  return (zonas || []).filter(z => zonaContienePunto(z.polygon, lat, lng)).map(z => z.name);
}

// LA ZONA CON LA QUE SE PROGRAMA. Devuelve { zona, origen, en }:
//   · manual puesta → { zona: manual, origen: 'mano' }         (gana siempre)
//   · dentro de UN dibujo → { zona, origen: 'dibujo' }
//   · en dos o más a la vez, o en ninguno → { zona: null, origen: null }
//     Dos dibujos encimados no se desempatan solos: que decida una persona.
// `en` lleva siempre las zonas cuyo dibujo contiene el punto, para poder decir
// en pantalla por qué quedó como quedó.
function zonaEfectiva(manual, zonas, lat, lng) {
  const en = zonasQueContienen(zonas, lat, lng);
  if (manual) return { zona: manual, origen: 'mano', en };
  if (en.length === 1) return { zona: en[0], origen: 'dibujo', en };
  return { zona: null, origen: null, en };
}
