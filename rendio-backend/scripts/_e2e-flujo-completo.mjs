#!/usr/bin/env node
// _e2e-flujo-completo.mjs — Prueba de punta a punta (Playwright) del flujo
// completo de Rendio contra el entorno 100 % LOCAL: tripulante, conductor, admin
// y los avisos que encola la base.
//
// Qué recorre (lo que pidió la dueña, 11-oct-2026):
//   admin      → Rutas › Asignación (v2): elegir el día, optimizar, ver los
//                tripulantes de cada ruta, «+ Asignar» conductor (los de turno
//                según el horario publicado), «Mover auxiliar» y deshacer, publicar
//                con la hoja de verificación; el botón de WhatsApp con el formato
//                del jefe; Reservas de hoy; la v2 en el celular (390 px).
//   tripulante → crear cuenta desde el login, pedir una salida, verla en Viajes
//                y abrir su detalle.
//   celular    → el conductor sin celular (pedro.local) no sigue sin uno válido.
//   salida     → casa → MDE: «Tu día» › «Iniciar ruta», avisos por hora y por GPS
//                (teléfono < 300 m y detector del servidor < 400 m), llamar, chat,
//                código de 2 dígitos (malo y bueno), «No tiene el código»,
//                recargar a mitad de ruta, «No se presentó», «Auxiliares
//                entregados», y el mapa del tripulante.
//   llegada    → MDE → casa: «Llegué al aeropuerto», una fila por tripulante,
//                código, «No llegó», «Salir del aeropuerto», entrega en casa.
//   jefe       → pedidos del jefe del 11-oct: Usuarios (restablecer contraseña),
//                «Horario del turno» en Inspecciones, horas en «h y min» (Balance y
//                Turnos activos), Ajustes › días de fotos, y «Mis horas» del
//                conductor (con turnos de prueba sembrados por SQL y borrados al final).
//   conductor  = celular + salida + llegada.
//
// Uso (stack local arriba y la app servida en http://localhost:5180 con el
// servidor e2e, que apunta /config.js a la base local):
//   node _e2e-flujo-completo.mjs                          → todo
//   node _e2e-flujo-completo.mjs --solo=tripulante,conductor
//   node _e2e-flujo-completo.mjs --solo=salida --headed
//   --sin-semilla  no rehace las reservas de hoy (por defecto corre
//                  `_seed-e2e-local.mjs --reservas` al empezar). salida y llegada
//                  la necesitan siempre: también publican el plan (bloque admin).
//
// Salidas, en .e2e-tools/run/flujo/ (E2E_OUT para cambiarla):
//   NN-rol-paso.png  una captura por paso.
//   resultados.json  una fila por prueba { id, rol, requerimiento, implementacion,
//                    pasos, esperado, obtenido, estado, captura, nota }. Una
//                    corrida parcial (--solo) reemplaza solo las filas que volvió
//                    a probar y deja las demás.
//   corrida.json     cuándo, qué bloques, errores de JavaScript vistos en pantalla.
//
// Los avisos push no llegan a un navegador headless: la evidencia del aviso es su
// fila en public.notification_outbox (lo que despacha dispatch-notifications).
//
// Dos cosas se simulan, y quedan escritas en el resultado:
//   · el reloj: para ver el recordatorio de «10 min antes» sin esperar una hora,
//     se adelanta por SQL la hora publicada a ahora+9 min (la base recalcula
//     calculated_pickup_at con su trigger de 0085) y se corre el detector;
//   · el GPS: context.setGeolocation mueve el teléfono del conductor.
//
// NUNCA toca dev ni producción: se niega a correr si /config.js de la app no
// apunta a 127.0.0.1:54321, y la base es la del stack local (_local-fixtures.mjs).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localClient } from './_local-fixtures.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium, devices } = await import(PW);
const BASE = (process.env.E2E_BASE || 'http://localhost:5180').replace(/\/$/, '');
const OUT = process.env.E2E_OUT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/flujo';
const HEADED = process.argv.includes('--headed');
const SIN_SEMILLA = process.argv.includes('--sin-semilla');
// Contraseña de las cuentas de prueba: la misma constante del seed (no se copia aquí).
const PASS = (readFileSync(join(AQUI, '_seed-e2e-local.mjs'), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
// La tripulante que se registra en cada corrida (cuenta nueva de la base local).
const PASS_NUEVA = 'Tortuga-Azul-9374q';
const TZ = 'America/Bogota';

// ---------------------------------------------------------------- bloques
const argSolo = (process.argv.find(a => a.startsWith('--solo=')) || '').slice(7);
const BLOQUES = new Set();
for (const b of (argSolo || 'todo').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
  if (b === 'todo' || b === 'all') ['admin', 'tripulante', 'celular', 'salida', 'llegada', 'jefe'].forEach(x => BLOQUES.add(x));
  else if (b === 'conductor') ['celular', 'salida', 'llegada'].forEach(x => BLOQUES.add(x));
  else if (['admin', 'tripulante', 'celular', 'salida', 'llegada', 'jefe'].includes(b)) BLOQUES.add(b);
  else { console.error(`Bloque desconocido: ${b}. Usa admin, tripulante, celular, salida, llegada, jefe o conductor.`); process.exit(2); }
}
// Las rutas del día se recorren una sola vez: salida y llegada siempre parten de
// reservas recién sembradas y de un plan recién publicado desde la pantalla.
if (BLOQUES.has('salida') || BLOQUES.has('llegada')) BLOQUES.add('admin');

// ---------------------------------------------------------------- catálogo de pruebas
// Lo que pidió la dueña (en sus palabras) y lo que hace la app. Las filas que no
// se alcanzan a probar salen igual, como NO PROBADO, con el motivo.
const CAT = [
  ['A01', 'admin', 'Admin', 'La ruta tiene que quedar PUBLICADA con conductor: el jefe la arma y la publica desde Rutas › Asignación.',
    'Asignación v2 (vista por defecto): ‹ día ›, «Optimizar» arma las vueltas por carro con el solver de siempre, «+ Asignar» ofrece solo a los conductores de turno según el horario publicado (o «Autoasignar»), y «Publicar plan» abre una hoja de verificación (riesgo, sin conductor, sin rutear, ajustadas) antes de guardar route_assignments + route_stops.',
    '1) Entrar como jefe.local (1440×900). 2) Rutas › Asignación (captura antes). 3) ‹ › para ver mañana y volver a hoy. 4) Optimizar. 5) Abrir cada ruta y ver sus tripulantes. 6) «+ Asignar» conductor en cada carro. 7) «Publicar plan» › hoja de verificación › Publicar (captura después). 8) Revisar la base.',
    'Todas las reservas de hoy quedan en vueltas publicadas (planned) con conductor y carro, y el conductor ya las ve.'],
  ['A02', 'admin', 'Admin', 'Mover a un tripulante de una ruta a otra (y poder deshacerlo).',
    '«Mover auxiliar» en el detalle de la ruta: se elige a quién y a qué ruta (sugeridas del mismo sector, buscador para otras), muestra el impacto en el margen y deja «Deshacer» en el aviso.',
    '1) Abrir la salida de 3 tripulantes. 2) «Mover auxiliar» › el último. 3) Elegir una ruta destino (buscador si no hay sugeridas) › Mover. 4) «Deshacer».',
    'El tripulante pasa a la otra ruta con su impacto a la vista, y «Deshacer» deja las rutas como estaban.'],
  ['A03', 'admin', 'Admin', 'En Asignación hay un botón sutil de WhatsApp que abre el plan en el formato del jefe.',
    'El ícono de WhatsApp de la barra (#rv2-wa en la v2, #rt-waBtn en la anterior) abre un modal de solo lectura con el plan del tablero en el formato de Julián, con «Copiar» y «Abrir WhatsApp».',
    '1) Con el plan armado en Asignación, tocar el ícono de WhatsApp. 2) Leer el texto del modal.',
    'Se abre el modal con el plan del día (carros, horas de recogida, nombres, vuelos y «deben estar») listo para pegar.'],
  ['A04', 'admin', 'Admin', 'Ver a todos los tripulantes que viajan hoy.',
    'Rutas › Reservas lista los traslados de la semana con filtro por día y estado, vuelo, botón de llamar y chat.',
    '1) Rutas › Reservas. 2) Filtro del día de hoy. 3) Buscar a los 6 tripulantes sembrados para hoy y su estado.',
    'Aparecen los 6 tripulantes de hoy; los que ya están en una ruta publicada se ven «Con conductor».'],
  ['A05', 'admin', 'Admin', 'Asignación se puede usar desde el celular del jefe (responsive).',
    'La v2 cambia a tarjetas y abre el detalle como cajón en pantallas angostas, con «Publicar» abajo.',
    '1) Entrar como jefe.local en un iPhone 13 (390 px). 2) Menú › Rutas › Asignación. 3) Abrir una ruta. 4) Medir si algo se sale de la pantalla.',
    'Se lee la lista y el detalle sin scroll horizontal y el botón de publicar queda a mano.'],
  ['A06', 'jefe', 'Admin', 'Un apartado para administrar usuarios: poder resetear claves y ese tipo de cosas.',
    'Turnos/Rutas › Equipo › Usuarios: todas las cuentas con buscador; «Restablecer contraseña» pone una nueva (generada o escrita), opcionalmente obliga a cambiarla al entrar y cierra sus sesiones (RPC admin_set_password).',
    '1) Turnos › Equipo › Usuarios. 2) Buscar a la tripulante que se registró en T01. 3) «Restablecer contraseña» con «pedirle que la cambie». 4) Entrar con la nueva en otro teléfono.',
    'La nueva contraseña funciona y al entrar la app le pide cambiarla.'],
  ['A07', 'jefe', 'Admin', 'En la inspección, ver el horario del turno (la revisión no es la hora de inicio del turno).',
    'El detalle de Inspecciones trae el bloque «Horario del turno»: inicio, inspección enviada, revisada por el jefe, fin y duración en h y min.',
    '1) Se siembra por SQL un turno cerrado de ayer con su inspección con novedad (datos de prueba). 2) Turnos › Revisión › Inspecciones › Revisar. 3) Leer el bloque.',
    'El bloque muestra las 5 horas con su nombre y la duración igual a fin − inicio.'],
  ['A08', 'jefe', 'Admin', 'Las horas se leen en horas y minutos (no en decimales).',
    'Balance y Turnos activos pintan las duraciones con BalanceCore.hm(): «9 h 13 min», «2 h 35 min».',
    '1) Turnos de prueba sembrados por SQL (uno cerrado de 9 h 13 min y uno en curso de ~2 h 35 min). 2) Turnos › Análisis › Balance. 3) Turnos › Revisión › Turnos activos.',
    'Las cifras salen como «X h Y min», sin «9,2 h».'],
  ['A09', 'jefe', 'Admin', 'En Ajustes: cuántos días se guardan las fotos de inspección.',
    'Turnos › Configuración › Ajustes: «Días que se guardan las fotos de inspección» (30 a 365, default 60); bajar el número pide confirmación porque esa noche se borran fotos.',
    '1) Ajustes: leer el valor. 2) Poner 90 y guardar. 3) Volver a 60 y guardar (confirmar el aviso). 4) Base.',
    'Se guarda 90 en app_settings.photo_retention_days; al bajar a 60 sale la confirmación y queda 60.'],
  ['T01', 'tripulante', 'Tripulante', 'Se registra desde la app (botón de crear cuenta en el login) y al terminar ve que completó el flujo.',
    '«Crear mi cuenta» en el login: paso 1 nombre, correo, celular y contraseña (crea la cuenta); paso 2 aerolínea y conjunto del catálogo; pantalla de bienvenida y presentación de 3 pasos.',
    '1) Login › «Crear mi cuenta». 2) Datos con un correo nuevo @rendio.test. 3) Aerolínea Avianca + conjunto Olivar Apartamentos. 4) «Crear mi cuenta». 5) «Entrar a la app» y saltar la presentación.',
    'Termina en «Te damos la bienvenida», llega a su Inicio y en la base queda el perfil de tripulante con su conjunto y aerolínea.'],
  ['T02', 'tripulante', 'Tripulante', 'Pide un traslado (salida casa → MDE) y lo ve en su lista con fecha, hora y punto.',
    '«Pedir traslado» en 4 pasos (a dónde, cuándo, nivel, revisar) que se confirma deslizando; queda en Viajes › Próximos.',
    '1) «Pedir traslado». 2) Casa → Aeropuerto. 3) Mañana, estar en MDE 06:30. 4) Compartido. 5) Deslizar para pedir. 6) Viajes › Próximos.',
    'En Viajes aparece la salida con la fecha, la hora en MDE y su punto de recogida; la reserva queda en la base.'],
  ['T03', 'tripulante', 'Tripulante', 'Empieza revisando su reserva y la información pertinente.',
    'Al tocar el traslado se abre su detalle: fecha, hora en MDE, nivel, estado del traslado y los botones de cambio de presentación y cancelar.',
    '1) En Viajes, tocar el traslado recién pedido.',
    'El detalle muestra su reserva (fecha, hora, punto) y dice que la hora de recogida llega cuando armen la ruta.'],
  ['T04', 'salida', 'Tripulante', 'Cuando el conductor arranca la ruta recibe el aviso («Eres el siguiente») y lo ve en la app.',
    'Al tocar «Iniciar ruta» la 1ª parada pasa a en_route y el trigger de 0097 encola «Eres el siguiente 🔜» con el carro y el código; la pantalla del viaje pasa a «En camino».',
    '1) El conductor toca «Iniciar ruta» en «Tu día». 2) Se lee la bandeja del 1er tripulante. 3) Se mira su pantalla del viaje.',
    'Fila en la bandeja «Eres el siguiente» para el 1er tripulante y su pantalla en «En camino» con el carro en el mapa.'],
  ['T05', 'salida', 'Tripulante', 'Aviso por ubicación: el conductor está cerca (GPS del conductor a menos de 300–400 m).',
    'El teléfono del conductor, con su GPS a menos de 300 m de la parada que sigue, llama driver_near_stop y la base encola «Tu conductor está por llegar 📍» (una sola vez).',
    '1) Con la ruta en curso, se mueve el GPS del conductor a 600 m y luego a 200 m de la 1ª parada. 2) Se lee la bandeja.',
    'Fila «Tu conductor está por llegar» para ese tripulante, y su pantalla dice que ya casi llega.'],
  ['T06', 'salida', 'Tripulante', 'Cuando el conductor llegó: recibe el aviso «¡Tu conductor llegó!» y lo ve en pantalla con su código.',
    '«Llegué» marca at_pickup; el trigger encola «¡Tu conductor llegó! 📍» con el punto de encuentro, la espera y el código; la pantalla pasa a «Llegó» y resalta el código.',
    '1) El conductor toca «Llegué» en la 1ª parada. 2) Se lee la bandeja. 3) Se mira la pantalla del tripulante.',
    'Fila «¡Tu conductor llegó!» y la pantalla del tripulante en «Llegó por ti» con el código resaltado y la cuenta de espera.'],
  ['T07', 'salida', 'Tripulante', 'Puede llamar al conductor (botón con tel: y el número del conductor).',
    'El botón «Llamar» del viaje abre tel: con el celular del conductor asignado.',
    '1) En su viaje, tocar «Llamar». 2) Se captura la URL tel: que abre el teléfono.',
    'Se abre tel:<celular del conductor asignado>.'],
  ['T08', 'salida', 'Tripulante', 'Puede escribirle al conductor por chat.',
    'El botón «Mensaje» abre el hilo del traslado (reservation_messages); el conductor lo ve en su parada y responde; los dos lo leen.',
    '1) El tripulante escribe «Hola, ya voy bajando». 2) El conductor abre el chat de esa parada y responde. 3) El tripulante ve la respuesta.',
    'Los dos mensajes quedan en el hilo y cada uno ve el del otro.'],
  ['T09', 'salida', 'Tripulante', 'Ve el código de encuentro de 2 dígitos.',
    'Desde que el conductor va en camino, la pantalla del viaje muestra el código de encuentro (reservations.meet_code, 2 dígitos) para decírselo al conductor.',
    '1) Con el conductor en camino, leer el código en la pantalla del tripulante. 2) Compararlo con la base.',
    'Se ve un código de 2 dígitos igual al de la base.'],
  ['T10', 'salida', 'Tripulante', 'Ve el trayecto en el mapa: el carro, las paradas que faltan (si le falta gente por recoger o si va directo al aeropuerto) y la línea de la ruta.',
    'El mapa del viaje pinta el carro con el último GPS, las paradas pendientes numeradas (de los compañeros solo el sector), el aeropuerto y la línea: la vía real de OSRM o, si el servidor público no responde, rectas punteadas.',
    '1) A bordo, con dos paradas por delante: captura del mapa. 2) Ya sin paradas: captura del mapa yendo a MDE. 3) Se cuentan los marcadores y se mira la línea.',
    'Con paradas pendientes: carro + paradas numeradas + aeropuerto + línea. Sin paradas: carro + aeropuerto + línea directa, y el texto lo dice.'],
  ['T11', 'llegada', 'Tripulante', 'Llegada (MDE → casa): cuando el conductor marca «Llegué al aeropuerto», el tripulante recibe el aviso y ve «Te espera en MDE».',
    'driver_mark_airport_arrival marca la llegada en todas las paradas de la vuelta y encola «¡Tu conductor llegó al aeropuerto! ✈️» a cada uno; la fase del viaje pasa a «Te espera en MDE».',
    '1) El conductor de la llegada toca «Llegué al aeropuerto». 2) Bandeja de cada tripulante. 3) Pantalla del viaje del tripulante.',
    'Una fila por tripulante en la bandeja y la pantalla en «Te espera en MDE» con su código.'],
  ['T12', 'tripulante', 'Tripulante', 'Servicio de puerto a casa: el tripulante pide una LLEGADA (Aeropuerto → Casa) desde la app (pedido del 12-oct).',
    'Pedir (aux-rx-pedir.js): tipo «Aeropuerto → Casa», día, aerolínea + número de vuelo, hora de aterrizaje, nivel, revisar y deslizar. Se guarda como airport_to_home en estado «scheduled».',
    '1) Con la tripulante de T01: Inicio › Pedir. 2) «Aeropuerto → Casa», mañana, AV 9412, aterriza 14:20. 3) Compartido. 4) Deslizar. 5) Revisar la base.',
    'Queda una reserva de llegada de mañana con aterrizaje 14:20, el vuelo AV9412 y estado scheduled.'],
  ['C01', 'celular', 'Conductor', 'Si no tiene celular, la app le pide el celular y no lo deja seguir sin uno válido.',
    'driver-celular.js: al entrar, si profiles.phone está vacío, una ventana que no se cierra hasta guardar un celular válido (10 dígitos, empieza por 3) o cerrar sesión; guarda con set_my_phone (0098). Después queda «Mi celular» en su Perfil.',
    '1) Entrar como pedro.local (sin celular). 2) Guardar vacío, «12345» y «2001234567». 3) Tocar fuera de la ventana. 4) Guardar «300 765 4321». 5) Perfil › Mi celular.',
    'La ventana no deja seguir sin un celular válido ni se cierra tocando afuera; con uno válido se guarda normalizado en la base, entra, y lo ve en su Perfil.'],
  ['C02', 'salida', 'Conductor', 'En su inicio ve «Tu día» con la vuelta y un botón «Iniciar ruta»: con UN toque abre la ruta y el tripulante recibe «Eres el siguiente» (meta: 2–3 toques).',
    '«Tu día» (driver-tabs.js) lista las vueltas publicadas para él; «Iniciar ruta» abre la ruta en ejecución y marca en_route la 1ª parada.',
    '1) Entrar como el conductor de la salida. 2) Inicio › «Tu día». 3) «Iniciar ruta». 4) Contar los toques hasta que la bandeja tiene el aviso.',
    '«Tu día» con la vuelta y «Iniciar ruta»; ≤ 3 toques desde el inicio hasta el aviso al tripulante.'],
  ['C03', 'salida', 'Conductor', '«Llegué» → aviso «¡Tu conductor llegó!».',
    '«Llegué» llama driver_set_reservation_status(at_pickup), arranca el reloj de espera y muestra el campo del código.',
    '1) En la 1ª parada, tocar «Llegué». 2) Leer la bandeja del tripulante.',
    'Fila «¡Tu conductor llegó!» para ese tripulante y, en el conductor, el campo para escribir el código.'],
  ['C04', 'salida', 'Conductor', 'Si escribe un código EQUIVOCADO lo rechaza y no lo sube.',
    'driver_board_with_code valida el código en la base; si no coincide responde codigo_incorrecto y la app limpia el campo con un aviso.',
    '1) En la 1ª parada, ya en «Llegué», escribir un código distinto al del tripulante. 2) Revisar la pantalla y la base.',
    'Mensaje «Ese no es el código…», sigue en la misma parada y en la base el tripulante NO queda a bordo.'],
  ['C05', 'salida', 'Conductor', 'Con el código correcto lo sube a bordo y pasa a la siguiente parada.',
    'Con el código bueno la base marca on_board con boarding_check = codigo y la app avanza a la siguiente parada (que pasa a en_route y le avisa a ese tripulante).',
    '1) Escribir el código correcto. 2) Revisar la pantalla, la base y la bandeja del siguiente.',
    '«✓ Código correcto», el tripulante queda on_board/codigo y la pantalla pasa a la parada 2 con su aviso «Eres el siguiente».'],
  ['C06', 'salida', 'Conductor', '«No tiene el código» (dos toques) en otra parada.',
    'El 1er toque arma el botón («Toca otra vez…») y el 2º lo sube sin código: boarding_check = sin_codigo queda registrado.',
    '1) En la 2ª parada, «Llegué». 2) «No tiene el código» dos veces. 3) Revisar la base.',
    'Con el 1er toque no pasa nada más que armar el botón; con el 2º queda on_board/sin_codigo y avanza.'],
  ['C07', 'salida', 'Conductor', 'Recargar la página a mitad de la ruta: retoma donde iba, sin reiniciar y sin repetir avisos.',
    'La vuelta se reanuda con el avance guardado en la base (drServerProgress): volver a «Iniciar ruta» no vuelve a la parada 1 y la base no repite avisos (dedupe de 0097).',
    '1) Con la parada 1 a bordo y la 2 en camino, contar las filas de la bandeja. 2) Recargar la página. 3) Volver a la ruta. 4) Contar otra vez.',
    'Retoma en la parada 2, la 1 sigue a bordo y la bandeja tiene las mismas filas.'],
  ['C08', 'salida', 'Conductor', '«No se presentó» solo después de la espera pactada; el tripulante queda avisado.',
    'Tras «Llegué» corre el reloj de espera (Ajustes, 5 min); «No se presentó» arranca deshabilitado y se suelta al vencer; la base encola «No pudimos recogerte».',
    '1) En la última parada, «Llegué». 2) Ver el botón deshabilitado y la cuenta. 3) Esperar los minutos de Ajustes. 4) «No se presentó».',
    'El botón solo se habilita al vencer la espera; la reserva queda no_show y el tripulante recibe «No pudimos recogerte».'],
  ['C09', 'salida', 'Conductor', 'En el aeropuerto (salida): «Auxiliares entregados» entrega solo a los que van a bordo.',
    'En MDE, «Auxiliares entregados» marca delivered a las paradas recogidas y deja como está a la que no se presentó.',
    '1) Llegar a MDE con 2 a bordo y 1 «no se presentó». 2) «Llegué al aeropuerto» › «Auxiliares entregados». 3) Revisar la base.',
    'Los 2 a bordo quedan delivered; el que no se presentó sigue no_show; la vuelta queda completa.'],
  ['C10', 'llegada', 'Conductor', 'Llegada: «Llegué al aeropuerto» → una fila por tripulante con su campo de código.',
    'En la llegada, «Llegué al aeropuerto» muestra una fila por tripulante con su campo de código, «Sin código» y «No llegó».',
    '1) El conductor de la llegada toca «Iniciar ruta» y luego «Llegué al aeropuerto».',
    'Una fila por tripulante de la vuelta, cada una con su campo de código.'],
  ['C11', 'llegada', 'Conductor', 'Llegada: un código correcto lo sube a bordo; «No llegó» lo resuelve.',
    'Código bueno → picked_up con boarding_check = codigo; «No llegó» (dos toques) → la parada queda no_show y la base le avisa «No te encontramos en el aeropuerto».',
    '1) Código correcto del 1er tripulante. 2) «No llegó» (dos toques) para el 2º. 3) Base y bandeja.',
    'El 1º ✓ A bordo; el 2º «No llegó» con su aviso en la bandeja.'],
  ['C12', 'llegada', 'Conductor', '«Salir del aeropuerto» solo se habilita cuando todos quedan resueltos.',
    'El botón principal dice «Faltan N por resolver» deshabilitado hasta que cada fila quede a bordo o «No llegó».',
    '1) Mirar el botón con 2 pendientes, con 1 pendiente y con 0.',
    'Deshabilitado con 2 y con 1; habilitado («Salir del aeropuerto · 1 a bordo») con 0.'],
  ['C13', 'llegada', 'Conductor', 'Llegada: deja al tripulante en su casa y cierra la vuelta (sin pasar por la casa del que no llegó).',
    '«Salir del aeropuerto» lleva a la casa del primero a bordo (salta las de «No llegó»); «Llegué a la casa» › «entregado» lo marca delivered y cierra la vuelta.',
    '1) «Salir del aeropuerto». 2) «Llegué a la casa». 3) «… entregado». 4) Base.',
    'Solo una casa por visitar, el tripulante queda delivered y la vuelta completa.'],
  ['C14', 'jefe', 'Conductor', 'El conductor ve sus horas en su perfil («Mis horas»).',
    '«Mis horas» del Perfil (driver-horas.js) muestra el corte en curso y el anterior con la misma cuenta del Balance (BalanceCore): turnos, horas pagables y los que no cuentan.',
    '1) Con el turno de prueba de 9 h 13 min de ayer, entrar como diana.local. 2) Perfil › Mis horas.',
    'Sale la tarjeta con el corte en curso y el turno de ayer con su duración en h y min.'],
  ['C15', 'salida', 'Conductor', 'El conductor ve su ruta en el mapa en cada parada (la línea y los puntos de las paradas).',
    'La pantalla de ejecución vuelve a crear el mapa en cada parada: puntos de cada parada, la vía de OSRM y su posición en vivo.',
    '1) Al iniciar la ruta, al pasar de parada, al recargar y al iniciar la llegada: contar lo que pinta el mapa del conductor (Ejecución: .rt-map-full, líneas y pines). 2) Errores de JavaScript en ese momento.',
    'En cada momento el mapa tiene la línea de la ruta y los puntos de las paradas, sin errores.'],
  ['C16', 'llegada', 'Conductor', '«Llegué al aeropuerto» antes de llegar NO debe avisarles a los tripulantes (pedido del 12-oct: el conductor lo marcó sin haber llegado y a los tripulantes les apareció).',
    'Ruta v2: driver-rutas.js · arrive() compara el GPS con MDE (1,5 km; 600 m en una casa) y abre la hoja «Todavía no estás en MDE» (rt-sheets.jsx · RtConfirmGps) antes de llamar a driver_mark_airport_arrival.',
    '1) Iniciar la llegada con el carro a ~2 km de MDE. 2) «Llegué al aeropuerto». 3) «Avisar cuando llegue». 4) Contar los avisos «llegó al aeropuerto» en la bandeja. 5) Mover el GPS a MDE y volver a tocar.',
    'Sale la hoja con la distancia real; con «Avisar cuando llegue» no sale ningún aviso y la pantalla sigue rumbo a MDE; ya en MDE sí avisa.'],
  ['C17', 'llegada', 'Conductor', 'En la lista del aeropuerto, «Deshacer» un «a bordo» o un «No llegó» tocado por error (entrega del diseñador del 12-oct).',
    'Mig 0102 · driver_airport_undo(reserva): devuelve la parada a «llegó» mientras el carro siga en MDE; al de «No llegó» le avisa una vez «Tu conductor todavía te espera».',
    '1) Con A a bordo (código) y B «No llegó»: «Deshacer» en B y en A. 2) Revisar la base y la bandeja de B. 3) Volver a resolverlos.',
    'Las dos filas vuelven a quedar por resolver; A pierde la marca de abordaje (status_a2h driver_assigned); B recibe «Tu conductor todavía te espera»; al resolverlos de nuevo todo queda como antes.'],
  ['C18', 'llegada', 'Conductor', '¿Dónde se habla con el tripulante? Chat con cualquier tripulante de la vuelta (Detalle y lista del aeropuerto), y el aviso del mensaje lleva al chat.',
    'Ruta v2: botón de chat en cada parada del Detalle y «Escribir» en cada fila del aeropuerto (RtChat con respuestas rápidas). Si el tripulante escribe con el chat cerrado, aparece el aviso de arriba (RxPushBanner) y al tocarlo abre ese chat. El push del tripulante al conductor ahora lleva #/viaje?r=<reserva>, que el conductor resuelve abriendo ese chat.',
    '1) En MDE, «Escribir» en la fila de A y mandar una respuesta rápida. 2) A responde desde su app. 3) Ver el aviso en la ruta del conductor y tocarlo. 4) Volver al Detalle y contar los botones de chat. 5) Revisar la URL del push que mandó la app de A.',
    'Los dos mensajes quedan guardados; el conductor ve el aviso con el texto de A y al tocarlo se abre el chat con el mensaje; cada parada del Detalle tiene su chat; el push de A apunta a #/viaje?r=<reserva>.'],
  ['C19', 'salida', 'Conductor', 'La ubicación sigue compartiéndose al salir de la pantalla de ejecución, y se vuelve con un toque (entrega del diseñador del 12-oct).',
    'Ruta v2: «Volver» desde Ejecución ya no apaga el GPS; Mi día y el Detalle muestran la barra «V1 en curso · ubicación activa» (RtNowBar) que lleva de vuelta a la parada.',
    '1) Con la vuelta en curso, «Volver» desde Ejecución. 2) Mover el GPS y contar los puntos guardados. 3) Tocar la barra «en curso».',
    'Aparece la barra; el carro sigue mandando su posición; un toque vuelve a la misma parada.'],
  ['C20', 'salida', 'Conductor', '«No se presentó» pide confirmación (antes era un toque).',
    'Ruta v2: hoja «¿X no se presentó?» (rt-sheets.jsx · RtConfirmNoShow) con «Sí, no se presentó» y «Seguir esperando».',
    '1) Vencida la espera, tocar «No se presentó». 2) «Seguir esperando». 3) Revisar la base. 4) Volver a tocar y confirmar.',
    'La hoja aparece; «Seguir esperando» no marca nada y sigue en la parada; al confirmar queda no_show.'],
  ['A10', 'llegada', 'Admin', 'Re-publicar el plan a mitad de la operación no puede borrar a quien ya va a bordo o ya se entregó (hallazgo del 12-oct al revisar la asignación).',
    'api.js · saveRoutePlan: una vuelta con paradas atendidas cuenta como arrancada aunque siga en «planned» (nadie la pasa a in_progress): no se borra, lo atendido queda fijo y lo pendiente solo se mueve si cambia de conductor. Los errores ya no se cuentan en silencio.',
    '1) Dejar la salida a mitad (una parada atendida y otra pendiente). 2) Re-publicar el plan del día tal cual con Api.saveRoutePlan desde la sesión del jefe. 3) Comparar las paradas antes y después.',
    'La vuelta sigue con el mismo id y con todas sus paradas en el mismo estado; no aparecen paradas duplicadas; saveRoutePlan no reporta fallas.'],
  ['S01', 'salida', 'Sistema', 'Aviso por hora: recordatorio 10 min antes de la recogida publicada.',
    'detect_trip_reminders() (pg_cron cada minuto) encola «Te recogen a las …» cuando faltan ≤ 10 min para la hora publicada (calculated_pickup_at) y la recogida no ha arrancado.',
    '1) Se adelanta por SQL la hora publicada de la 1ª parada a ahora + 9 min (equivale a que pase el tiempo; la base recalcula calculated_pickup_at). 2) SELECT detect_trip_reminders(). 3) Bandeja del tripulante.',
    'Una fila «Te recogen a las …» con el conductor, el carro y su código, y la pantalla del tripulante con esa hora.'],
  ['S02', 'salida', 'Sistema', 'Aviso por ubicación también con la app del conductor en segundo plano (detector del servidor, < 400 m).',
    'El detector del minuto toma el último GPS guardado del carro (menos de 2 min) y, si está a menos de 400 m de la parada en camino, encola «Tu conductor está por llegar».',
    '1) GPS del conductor a ~350 m de la parada 3 (afuera del radio de 300 m del teléfono). 2) Esperar el ping en driver_locations. 3) SELECT detect_trip_reminders(). 4) Bandeja.',
    'Fila «Tu conductor está por llegar» para el tripulante de esa parada, sin que el teléfono la haya pedido.'],
  ['S03', 'llegada', 'Sistema', 'Aviso por hora en llegadas: «Tu conductor sale de MDE a las …» 10 min antes.',
    'El mismo detector, en llegadas, encola «Tu conductor sale de MDE a las …» a cada tripulante 10 min antes de la salida del carro.',
    '1) Se adelanta por SQL la salida de la vuelta de llegada a ahora + 9 min. 2) SELECT detect_trip_reminders(). 3) Bandeja de cada tripulante.',
    'Una fila por tripulante de la llegada con la hora, el conductor y su código.'],
  ['S04', 'llegada', 'Sistema', 'Recordatorio al conductor antes de su vuelta.',
    'El detector encola al conductor «Tu vuelta arranca a las …» 20 min antes de una vuelta que nadie ha arrancado.',
    '1) Con la vuelta de llegada a 9 min, SELECT detect_trip_reminders(). 2) Bandeja del conductor.',
    'Fila «Tu vuelta arranca a las …» para el conductor con los nombres y «toca Iniciar ruta».'],
  ['S05', 'salida', 'Sistema', 'Los avisos no se repiten (aunque el conductor toque dos veces, recargue o vuelva a «Iniciar ruta»).',
    'trip_notify encola cada aviso una sola vez por dedupe_key, mire o no si ya salió.',
    '1) Al final de la corrida, agrupar la bandeja de los tripulantes de prueba por dedupe_key.',
    'Ninguna clave con más de una fila.'],
];
const META = Object.fromEntries(CAT.map(([id, bloque, rol, requerimiento, implementacion, pasos, esperado]) =>
  [id, { id, bloque, rol, requerimiento, implementacion, pasos, esperado }]));

// ---------------------------------------------------------------- utilidades
mkdirSync(OUT, { recursive: true });
const RES = new Map();
const ERRORES = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hora = (iso) => iso ? new Date(iso).toLocaleTimeString('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const diaBog = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const soloDig = (s) => String(s || '').replace(/\D/g, '');
const norte = (lat, lng, m) => ({ latitude: lat + m / 111320, longitude: lng });
class NoProbado extends Error {}

function resultado(id, estado, obtenido, captura, nota) {
  const m = META[id];
  RES.set(id, { id, rol: m.rol, requerimiento: m.requerimiento, implementacion: m.implementacion, pasos: m.pasos,
    esperado: m.esperado, obtenido: String(obtenido || ''), estado, captura: captura || '', nota: nota || '' });
  console.log(`  ${estado.padEnd(10)} ${id}  ${String(obtenido || '').slice(0, 160)}`);
  guardar();
}
// Corre una prueba: el cuerpo devuelve { estado, obtenido, captura, nota }. Si
// revienta, la fila queda en FALLA con el error y una captura de ese momento.
async function prueba(id, pg, rol, fn) {
  if (RES.has(id) && RES.get(id).__ahora) return;
  const antes = PASO; PASO = id;
  try {
    const r = await fn();
    resultado(id, r.estado, r.obtenido, r.captura, r.nota);
  } catch (e) {
    let cap = '';
    try { if (pg && !pg.isClosed()) cap = await foto(pg, rol, `${id.toLowerCase()}-error`); } catch (_) { /* */ }
    if (e instanceof NoProbado) resultado(id, 'NO PROBADO', e.message, cap, '');
    else resultado(id, 'FALLA', 'Error: ' + String(e && e.message || e).split('\n')[0].slice(0, 400), cap,
      'La prueba no terminó: este paso reventó. Ver captura.');
  }
  RES.get(id).__ahora = true;
  PASO = antes;
}
function guardar() {
  const prev = existsSync(join(OUT, 'resultados.json')) ? (() => { try { return JSON.parse(readFileSync(join(OUT, 'resultados.json'), 'utf8')); } catch (_) { return []; } })() : [];
  const by = new Map(prev.map(r => [r.id, r]));
  for (const [id, r] of RES) { const { __ahora, ...limpio } = r; by.set(id, limpio); }
  const orden = CAT.map(c => c[0]);
  const filas = [...by.values()].sort((a, b) => orden.indexOf(a.id) - orden.indexOf(b.id));
  writeFileSync(join(OUT, 'resultados.json'), JSON.stringify(filas, null, 2));
}

// Capturas NN-rol-paso.png; cada bloque numera en su propio rango para que una
// corrida parcial no pise las capturas de los otros bloques.
// En una corrida completa el contador sigue de bloque en bloque (Math.max): nunca se pisan.
const RANGO = { preparar: 0, admin: 1, tripulante: 18, celular: 30, salida: 35, llegada: 75, jefe: 88 };
let NUM = 0;
async function foto(pg, rol, paso, opts = {}) {
  const nombre = `${String(NUM++).padStart(2, '0')}-${rol}-${paso}.png`;
  if (rol === 'tripulante' && !opts.sinSubir) { await arriba(pg); await sleep(250); }
  await pg.screenshot({ path: join(OUT, nombre), fullPage: !!opts.full, timeout: 15000 }).catch(() => {});
  return nombre;
}

async function esperar(fn, { timeout = 15000, cada = 400 } = {}) {
  const fin = Date.now() + timeout;
  let v;
  while (Date.now() < fin) { v = await fn(); if (v) return v; await sleep(cada); }
  return v;
}
async function esperarTexto(pg, re, timeout = 20000) {
  return pg.waitForFunction(([s, f]) => new RegExp(s, f).test(document.body.innerText), [re.source, re.flags], { timeout })
    .then(() => true, () => false);
}

// ---------------------------------------------------------------- navegador
const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 120 : 0 });
const CTX = [];
// Instrumentación de la prueba (no de la app): guarda los toasts que aparecen.
const SPY_TOASTS = () => {
  window.__e2eToasts = [];
  setInterval(() => {
    document.querySelectorAll('#toast:not(.hidden), .rx-toast, [class*="toast"]').forEach(el => {
      const t = (el.innerText || '').trim();
      // getClientRects y no offsetParent: el toast es position:fixed (offsetParent null).
      if (t && !el.hidden && !el.classList.contains('hidden') && el.getClientRects().length && window.__e2eToasts[window.__e2eToasts.length - 1] !== t) window.__e2eToasts.push(t);
    });
  }, 100);
};
async function contexto(tipo, geo) {
  const base = { locale: 'es-CO', timezoneId: TZ };
  const opts = tipo === 'admin' ? { ...base, viewport: { width: 1440, height: 900 } }
    : { ...devices['iPhone 13'], ...base, permissions: ['geolocation'], geolocation: geo || { latitude: 6.1634, longitude: -75.3747, accuracy: 10 } };
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(SPY_TOASTS);
  CTX.push(ctx);
  return ctx;
}
let PASO = 'preparar';   // la prueba en curso, para fechar los errores de pantalla
function vigilar(pg, quien) {
  const t = () => new Date().toLocaleTimeString('es-CO', { timeZone: TZ, hour12: false });
  pg.on('pageerror', e => ERRORES.push({ quien, paso: PASO, hora: t(), tipo: 'pageerror', msg: e.message.slice(0, 300), pila: String(e.stack || '').split('\n').slice(1, 12).map(x => x.trim().replace(/https?:\/\/[^/]+\//, '')).join(' | ').slice(0, 900) }));
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) ERRORES.push({ quien, paso: PASO, hora: t(), tipo: 'console', msg: m.text().slice(0, 300) }); });
  pg.on('response', r => { if (r.status() >= 400) ERRORES.push({ quien, paso: PASO, hora: t(), tipo: 'http ' + r.status(), msg: r.request().method() + ' ' + r.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0].slice(0, 160) }); });
}
async function entrar(ctx, email, pass, quien) {
  const pg = await ctx.newPage();
  vigilar(pg, quien || email);
  await pg.goto(BASE + '/');
  await pg.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
  await pg.fill('#login-email', email);
  await pg.fill('#login-password', pass || PASS);
  await pg.click('#login-submit');
  await pg.waitForFunction(() => { const l = document.getElementById('screen-login'); return l && l.classList.contains('hidden'); }, null, { timeout: 25000 });
  return pg;
}
// La presentación del tripulante (3 pasos + avisos) aparece en cada aparato nuevo.
async function saltarPresentacion(pg) {
  const fin = Date.now() + 9000;
  while (Date.now() < fin) {
    const b = await pg.$('[data-ax=onb-skip]:visible, [data-ax=onb-later]:visible');
    if (b) { await b.click().catch(() => {}); await sleep(700); continue; }
    if (await pg.$('[data-ax=new]:visible, [data-ax=trip]:visible')) return;
    await sleep(300);
  }
}
async function abrirViaje(pg, rid) {
  const sel = `[data-ax=trip][data-id="${rid}"]`;
  if (!(await pg.$(sel + ':visible'))) {
    await pg.click('[data-rx=rx-tab][data-tab=viajes]').catch(() => {});
    await pg.waitForSelector(sel, { state: 'visible', timeout: 8000 }).catch(() => {});
  }
  if (await pg.$(sel + ':visible')) await pg.click(sel);
  else await pg.goto(`${BASE}/#/viaje?r=${rid}`);
  await pg.waitForSelector('.rx-trip', { state: 'visible', timeout: 15000 });
  await sleep(1200);
}
// Lo que dice la pantalla del viaje del tripulante (hero, fase, código, mapa).
async function leerViaje(pg) {
  return pg.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const map = q('#ax-track-map');
    const line = map ? [...map.querySelectorAll('path.leaflet-interactive')] : [];
    return {
      fase: q('#ax-phase')?.getAttribute('data-now') || '',
      grande: (q('#ax-eta-min')?.innerText || '').trim(),
      etiqueta: (q('#ax-eta-label')?.innerText || '').trim(),
      codigo: (q('#ax-meet .rx-meet-c')?.innerText || '').replace(/\s/g, ''),
      codigoLlego: !!q('#ax-meet.is-arrived'),
      espera: (q('#ax-wait')?.innerText || '').trim().replace(/\s+/g, ' '),
      frescura: (q('#ax-track-fresh')?.innerText || '').trim(),
      carro: map ? map.querySelectorAll('.rx-lf-car, .ax-car').length : 0,
      paradas: map ? [...map.querySelectorAll('.rx-lf-stop, .ax-stop')].map(e => e.innerText.trim()) : [],
      // ¿El marcador de parada tiene forma (círculo con fondo) o es texto suelto?
      paradaEstilo: (() => { const e = map && map.querySelector('.rx-lf-stop, .ax-stop'); if (!e) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
        return { clase: e.className, ancho: Math.round(r.width), alto: Math.round(r.height), fondo: cs.backgroundColor, radio: cs.borderRadius }; })(),
      aeropuerto: map ? map.querySelectorAll('.rx-lf-apt').length : 0,
      casa: map ? map.querySelectorAll('.rx-lf-pin').length : 0,
      lineas: line.map(p => ({ punteada: !!p.getAttribute('stroke-dasharray'), puntos: (p.getAttribute('d') || '').split(/[LM]/).length - 1 })),
      texto: (q('.rx-trip')?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    };
  });
}
// Playwright desplaza la hoja del viaje para tocar botones de abajo: antes de una
// captura del mapa se vuelve arriba para que se vea lo que ve el tripulante al abrir.
const arriba = (pg) => pg.evaluate(() => document.querySelectorAll('#auxiliar-ui [data-rx-scroll], #auxiliar-ui .rx-trip-sheet').forEach(e => { e.scrollTop = 0; })).catch(() => {});
const toastsDe = (pg) => pg.evaluate(() => window.__e2eToasts || []).catch(() => []);
// Ruta del conductor v2 (entrega del 12-oct-2026): la Ejecución es la capa de arriba.
const EX = '#driver-ruta-ui #rt-layers > .rx-layer:not(.out):last-child .rt-exec';
const SH = '#driver-ruta-ui #rt-sheet-host';
async function legActual(pg) {
  return pg.evaluate(() => {
    const x = [...document.querySelectorAll('#driver-ruta-ui #rt-layers > .rx-layer:not(.out)')].pop();
    const ex = x && x.querySelector('.rt-exec');
    const q = (s) => ex && ex.querySelector(s);
    const eb = (q('.rt-eb')?.innerText || '').trim();
    const apt = !q('.rt-person') && /aeropuerto|MDE/i.test(eb);
    const cta = q('.rt-cta .rx-btn:not(.rt-nav)');
    return {
      nombre: apt ? 'Aeropuerto MDE' : (q('.rt-person-tx > b')?.innerText || '').trim(),
      cta: (cta?.innerText || '').trim(), ctaAct: cta?.getAttribute('data-rt') || '', ctaOff: !!(cta && cta.disabled),
      exec: !!ex, chip: (q('.rt-steps > span')?.innerText || '').trim(), eb,
      pill: (q('.rt-x-pill')?.innerText || '').replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => ({}));
}
const esExec = (pg) => pg.waitForSelector(EX + ' .rt-xs', { timeout: 15000 });

// Lo que pinta el mapa del conductor en un momento dado (C15).
const MAPA_CONDUCTOR = [];
async function mapaConductor(pg, momento, cap) {
  await sleep(2500);   // OSRM responde y se dibuja la línea
  const m = await pg.evaluate((ex) => {
    const el = document.querySelector(ex + ' .rt-map-full .rt-lf');
    if (!el) return null;
    // Las líneas van en un canvas (preferCanvas): el mapa deja escrito lo que dibujó.
    return { trazos: +(el.dataset.trazos || 0), pines: el.querySelectorAll('.rt-lf-pin').length, yo: el.querySelectorAll('.rt-lf-car').length };
  }, EX).catch(() => null);
  const errores = ERRORES.filter(e => e.tipo === 'pageerror' && /conductor/.test(e.quien) && e.paso === PASO).map(e => e.msg);
  MAPA_CONDUCTOR.push({ momento, ...(m || { trazos: null, yo: null }), errores, cap });
}

// ---------------------------------------------------------------- base local
const db = await localClient();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const q1 = async (sql, p) => (await db.query(sql, p)).rows[0];
const ahoraDb = async () => (await q1('SELECT now() AS t')).t.toISOString();
async function avisos(profileId, clave, desde) {
  return q(`SELECT title, body, url, dedupe_key, created_at, sent_at, attempts, last_error
              FROM public.notification_outbox
             WHERE profile_id = $1 AND ($2::text IS NULL OR dedupe_key LIKE $2) AND created_at >= $3
             ORDER BY created_at`, [profileId, clave, desde || INICIO]);
}
const esperarAviso = (profileId, clave, timeout = 15000) =>
  esperar(async () => (await avisos(profileId, clave))[0], { timeout, cada: 500 });
const fmtAviso = (a) => a
  ? `«${a.title}» — «${a.body}» [clave ${a.dedupe_key} · url ${a.url} · encolado ${hora(a.created_at)} · ${a.sent_at ? 'despachado ' + hora(a.sent_at) : 'sin despachar todavía'}${a.last_error ? ' · error del despacho: ' + String(a.last_error).slice(0, 90) : ''}]`
  : 'SIN fila en la bandeja';
async function filasBandeja(profileIds) {
  return Number((await q1(`SELECT count(*)::int n FROM public.notification_outbox WHERE profile_id = ANY($1) AND created_at >= $2`, [profileIds, INICIO])).n);
}

// Evidencia de lo que solo vive en la base: la bandeja de avisos pintada como
// tabla en una página aparte y capturada (rol «sistema»).
async function fotoBandeja(paso, titulo, filas) {
  const ctx = await contexto('admin');
  const pg = await ctx.newPage();
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  await pg.setContent(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;margin:24px;color:#18181b">
    <h2 style="margin:0 0 4px">${esc(titulo)}</h2><p style="margin:0 0 14px;color:#71717a">public.notification_outbox · base local · ${esc(new Date().toLocaleString('es-CO', { timeZone: TZ }))}</p>
    <table style="border-collapse:collapse;width:100%">${['Para', 'Título', 'Texto', 'Clave (dedupe_key)', 'Encolado'].map(h => `<th style="text-align:left;border-bottom:2px solid #e4e4e7;padding:6px">${h}</th>`).join('')}
    ${filas.map(f => `<tr>${[f.para, f.title, f.body, f.dedupe_key, hora(f.created_at)].map(v => `<td style="border-bottom:1px solid #f4f4f5;padding:6px;vertical-align:top">${esc(v)}</td>`).join('')}</tr>`).join('')}</table></body>`);
  const n = await foto(pg, 'sistema', paso, { full: true });
  await ctx.close();
  return n;
}

// ---------------------------------------------------------------- preparar
console.log(`\nRendio · prueba de punta a punta LOCAL · bloques: ${[...BLOQUES].join(', ')}`);
if (!PASS) { console.error('ABORT: no encontré E2E_PASSWORD en _seed-e2e-local.mjs'); process.exit(2); }
{
  let cfg = '';
  try { cfg = await (await fetch(BASE + '/config.js')).text(); } catch (e) { console.error(`ABORT: la app no responde en ${BASE} (${e.message})`); process.exit(2); }
  if (!/127\.0\.0\.1:54321|localhost:54321/.test(cfg)) { console.error('ABORT: /config.js de la app no apunta a la base LOCAL. Nunca se prueba contra dev ni producción.'); process.exit(2); }
}
if (!SIN_SEMILLA) {
  console.log('· Sembrando reservas de hoy y mañana (_seed-e2e-local.mjs --reservas)…');
  const out = execFileSync(process.execPath, ['_seed-e2e-local.mjs', '--reservas'], { cwd: AQUI, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('  ' + out.trim().split('\n').pop());
}
// Los traslados que pidieron las tripulantes de corridas anteriores (T02, mañana)
// se cancelan: si no, cada corrida suma uno más a la planeación de mañana.
await db.query(`UPDATE public.reservations r SET cancelled_at = now(), cancellation_reason = 'E2E: limpieza de una corrida anterior'
                  FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id
                 WHERE r.auxiliar_profile_id = ap.id AND p.email LIKE 'nueva.%@rendio.test' AND r.cancelled_at IS NULL AND r.required_arrival_at > now()`).catch(() => {});
const INICIO = await ahoraDb();
const DIA = diaBog();
const MANANA = diaBog(new Date(Date.now() + 86400000));
const CUENTAS = Object.fromEntries((await q(`
  SELECT p.email, p.id, p.full_name, p.phone, p.role, ap.id AS aux_id, dp.id AS drv_id
    FROM public.profiles p
    LEFT JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id
    LEFT JOIN public.driver_profiles dp ON dp.profile_id = p.id
   WHERE p.email LIKE '%.local@rendio.test'`)).map(r => [r.email.split('@')[0].replace('.local', ''), r]));
for (const k of ['jefe', 'carlos', 'diana', 'pedro', 'tripu1', 'tripu6']) if (!CUENTAS[k]) { console.error(`ABORT: falta la cuenta ${k}.local; corre _seed-e2e-local.mjs`); process.exit(2); }
const porPerfil = Object.fromEntries(Object.entries(CUENTAS).map(([k, v]) => [v.id, { ...v, clave: k }]));
const porDriver = Object.fromEntries(Object.entries(CUENTAS).filter(([, v]) => v.drv_id).map(([k, v]) => [v.drv_id, { ...v, clave: k }]));
async function reservasDeHoy() {
  return q(`SELECT r.id, r.direction, r.required_arrival_at, r.calculated_pickup_at, r.meet_code, r.status_h2a, r.status_a2h,
                   r.boarding_check, r.pickup_latitude AS lat, r.pickup_longitude AS lng, r.notes, r.meeting_point,
                   p.email, p.full_name, p.id AS profile_id, p.phone
              FROM public.reservations r
              JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
              JOIN public.profiles p ON p.id = ap.profile_id
             WHERE p.email LIKE 'tripu%.local@rendio.test' AND r.cancelled_at IS NULL
               AND (r.required_arrival_at AT TIME ZONE '${TZ}')::date = $1::date
             ORDER BY r.required_arrival_at, p.email`, [DIA]);
}
const RESERVAS = await reservasDeHoy();
const reserva = async (rid) => q1(`SELECT r.*, (SELECT rs.status FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                                                  WHERE rs.reservation_id = r.id ORDER BY ra.planned_start_at DESC LIMIT 1) AS stop_status
                                     FROM public.reservations r WHERE r.id = $1`, [rid]);
console.log(`· Día ${DIA}: ${RESERVAS.length} reservas de tripulantes de prueba · inicio ${hora(INICIO)}`);

// El plan publicado de hoy para esas reservas.
async function planPublicado() {
  const ids = RESERVAS.map(r => r.id);
  const rows = await q(`
    SELECT ra.id, ra.direction, ra.status, ra.planned_start_at, ra.driver_profile_id, v.internal_code, v.license_plate,
           json_agg(json_build_object('rid', rs.reservation_id, 'orden', rs.stop_order, 'eta', rs.estimated_arrival_at, 'status', rs.status) ORDER BY rs.stop_order) AS stops
      FROM public.route_assignments ra
      JOIN public.route_stops rs ON rs.route_assignment_id = ra.id
      LEFT JOIN public.vehicles v ON v.id = ra.vehicle_id
     WHERE rs.reservation_id = ANY($1) AND ra.status IN ('draft', 'planned', 'in_progress')
     GROUP BY ra.id, v.internal_code, v.license_plate
     ORDER BY ra.planned_start_at`, [ids]);
  return rows.map(ra => ({ ...ra, conductor: porDriver[ra.driver_profile_id] || null,
    stops: ra.stops.map(s => ({ ...s, ...RESERVAS.find(r => r.id === s.rid) })) }));
}
let PLAN = [];
let NUEVA = null;   // la tripulante que se registra en T01 (la usa A06)

// ================================================================= ADMIN
// Menú del admin: espacio de trabajo (Turnos/Rutas) y módulo. Reintenta porque el
// menú se engancha un momento después de entrar.
async function irModulo(pg, ws, mod, movil) {
  for (let i = 0; i < 6; i++) {
    if (movil && !(await pg.$('#app-shell.side-open')) && await pg.$('#adm-mobmenu:visible')) { await pg.click('#adm-mobmenu').catch(() => {}); await sleep(600); }
    if (await pg.$(`.nav-i[data-mod=${mod}]:visible`)) {
      await pg.click(`.nav-i[data-mod=${mod}]`);
      await sleep(900);
      return;
    }
    await pg.click(`#adm-wstabs button[data-ws=${ws}]`).catch(() => {});
    await sleep(900);
  }
  throw new Error(`no encontré el módulo ${ws} › ${mod} en el menú del admin`);
}

async function bloqueAdmin() {
  NUM = Math.max(NUM, RANGO.admin);
  console.log('\n[admin] Publicar el plan desde Rutas › Asignación');
  const ctx = await contexto('admin');
  let pg = null;
  let v2 = false;
  await prueba('A01', null, 'admin', async () => {
    pg = await entrar(ctx, CUENTAS.jefe.email, PASS, 'admin');
    pg.on('dialog', d => d.accept().catch(() => {}));
    await pg.waitForSelector('#adm-wstabs', { state: 'visible', timeout: 20000 });
    await sleep(1500);
    await irModulo(pg, 'rutas', 'routes');
    v2 = await pg.waitForSelector('#routes-v2:not([hidden])', { timeout: 12000 }).then(() => true, () => false);
    if (v2) return publicarV2(pg);
    const vieja = await pg.waitForSelector('#rt-optBtn', { state: 'visible', timeout: 8000 }).then(() => true, () => false);
    if (vieja) return publicarVieja(pg);
    const cap = await foto(pg, 'admin', 'asignacion-desconocida');
    await publicarPorSQL();
    PLAN = await planPublicado();
    return { estado: 'PARCIAL', captura: cap, obtenido: `Asignación no muestra ni la v2 (#routes-v2) ni la anterior (#rt-optBtn). Se publicó por SQL igual que Api.saveRoutePlan: ${resumenPlan()}.`, nota: 'Publicado por SQL (último recurso).' };
  });
  if (!PLAN.some(r => r.driver_profile_id)) {
    // Sin plan publicado no hay salida ni llegada que recorrer: último recurso.
    await publicarPorSQL();
    PLAN = await planPublicado();
    console.log('  (plan publicado por SQL como último recurso: ' + resumenPlan() + ')');
  }

  await prueba('A03', pg, 'admin', async () => {
    if (!pg) throw new NoProbado('No se pudo entrar a Asignación.');
    const sel = v2 ? '#rv2-wa' : '#rt-waBtn';
    const hay = await pg.$(sel + ':visible');
    if (hay) await pg.click(sel);
    else await pg.evaluate(() => window.RendioWhatsApp && window.RendioWhatsApp.abrir());
    await pg.waitForSelector('.rwa-box', { state: 'visible', timeout: 8000 });
    await sleep(600);
    const cap = await foto(pg, 'admin', 'whatsapp');
    const texto = await pg.evaluate(() => (window.RendioWhatsApp && window.RendioWhatsApp.texto()) || (document.querySelector('.rwa-box textarea, .rwa-box pre')?.innerText) || '');
    const sal = PLAN.find(r => r.direction === 'home_to_airport');
    const nombres = (sal ? sal.stops : []).map(s => (s.full_name || '').split(' ')[0]).filter(Boolean);
    const estan = nombres.filter(n => texto.includes(n));
    await pg.keyboard.press('Escape').catch(() => {});
    await sleep(300);
    if (await pg.$('.rwa-box:visible')) await pg.click('.rwa-box [data-rwa=cerrar], .rwa-box .rwa-x, .rwa-box button:has-text("Cerrar")').catch(() => {});
    return {
      estado: texto && estan.length === nombres.length ? 'OK' : (texto ? 'PARCIAL' : 'FALLA'), captura: cap,
      obtenido: `${hay ? `El ícono ${sel} está en la barra` : `No encontré ${sel}: se abrió con RendioWhatsApp.abrir()`}. Texto del modal (${texto.split('\n').length} líneas): «${texto.split('\n').slice(0, 9).join(' ⏎ ').slice(0, 480)}». Nombres de la salida presentes: ${estan.join(', ') || 'ninguno'}.`,
      nota: 'No prueba «Copiar» ni «Abrir WhatsApp» (portapapeles y wa.me quedan fuera del navegador headless).',
    };
  });

  await prueba('A04', pg, 'admin', async () => {
    if (!pg) throw new NoProbado('No se pudo entrar al admin.');
    await irModulo(pg, 'rutas', 'reservas');
    await pg.waitForSelector('[data-rv-row]', { timeout: 15000 });
    await pg.click(`[data-rv-day="${DIA}"]`).catch(() => {});
    await sleep(900);
    const filas = await pg.$$eval('[data-rv-row]', els => els.map(e => ({ id: e.dataset.rvRow, nombre: (e.querySelector('.rv-top b')?.innerText || '').trim(), estado: (e.querySelector('.rv-st')?.innerText || '').trim(), hora: (e.querySelector('.rv-when b')?.innerText || '').trim() })));
    const cap = await foto(pg, 'admin', 'reservas-hoy', { full: true });
    const enRuta = new Set(PLAN.filter(r => r.driver_profile_id).flatMap(r => r.stops.map(s => s.rid)));
    const vistas = RESERVAS.map(r => ({ r, f: filas.find(x => x.id === r.id) }));
    const faltan = vistas.filter(v => !v.f).map(v => v.r.full_name);
    const malEstado = vistas.filter(v => v.f && enRuta.has(v.r.id) && /Sin rutear/i.test(v.f.estado));
    const ob = `Hoy (${DIA}) la lista tiene ${filas.length} filas: ${vistas.filter(v => v.f).map(v => `${v.f.nombre} ${v.f.hora} «${v.f.estado}»`).join(' · ')}.${faltan.length ? ` NO aparecen: ${faltan.join(', ')}.` : ' Están los 6.'}`;
    return {
      estado: faltan.length ? 'FALLA' : (malEstado.length ? 'PARCIAL' : 'OK'), captura: cap,
      obtenido: ob + (malEstado.length ? ` ${malEstado.length} de ellos ya tienen ruta y conductor publicados y aquí se ven «Sin rutear».` : ''),
      nota: malEstado.length ? 'Hallazgo: el estado de la fila sale de status_h2a/status_a2h (_auxTripStatus, rendio-turnos/api.js ~2375) y publicar (saveRoutePlan, api.js ~3048) no los cambia, así que Reservas dice «Sin rutear» de lo que Asignación ya muestra publicado. El Inicio del tripulante dice «Pedido» por lo mismo.' : '',
    };
  });
  await ctx.close();

  // --- A05 la misma pantalla en el celular del jefe
  await prueba('A05', null, 'admin', async () => {
    const ctxM = await contexto('movil');
    const pm = await entrar(ctxM, CUENTAS.jefe.email, PASS, 'admin-celular');
    await pm.waitForSelector('#adm-mobmenu', { state: 'visible', timeout: 20000 });
    await sleep(1500);
    await irModulo(pm, 'rutas', 'routes', true);
    const hayV2 = await pm.waitForSelector('#routes-v2:not([hidden])', { timeout: 12000 }).then(() => true, () => false);
    if (hayV2) await pm.waitForFunction(() => !/Cargando el día/.test(document.querySelector('#rv2-list')?.innerText || ''), null, { timeout: 40000 }).catch(() => {});
    await sleep(1500);
    const medir = () => pm.evaluate(() => ({ ancho: document.documentElement.scrollWidth, vista: window.innerWidth,
      // Lo que se sale por la derecha SIN estar dentro de algo que se desliza de lado.
      anchos: [...document.querySelectorAll('#routes-v2 *')].filter(e => {
        if (!e.offsetParent || e.getBoundingClientRect().right <= window.innerWidth + 2) return false;
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { if (/(auto|scroll|hidden)/.test(getComputedStyle(a).overflowX)) return false; }
        return true;
      }).slice(0, 4).map(e => (e.id ? '#' + e.id : e.className && String(e.className).split(' ')[0]) || e.tagName),
      chipsDeslizan: (() => { const c = document.getElementById('rv2-chips'); return !!c && c.scrollWidth > c.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(c).overflowX); })() }));
    const m1 = await medir();
    const cap = await foto(pm, 'admin', 'asignacion-celular');
    const filas = await pm.$$eval('#rv2-list .rv2-row', els => els.length).catch(() => 0);
    let m2 = null, capD = '';
    if (filas) {
      await pm.click('#rv2-list .rv2-row');
      await pm.waitForSelector('#rv2-detail.is-open', { timeout: 8000 }).catch(() => {});
      await sleep(900);
      m2 = await medir();
      capD = await foto(pm, 'admin', 'asignacion-celular-detalle');
      await pm.click('#rv2-detail [data-act=close]').catch(() => {});
    }
    const barra = await pm.$eval('#rv2-publishM', b => ({ vis: !!b.offsetParent, txt: b.innerText.trim() })).catch(() => ({ vis: false, txt: '' }));
    await ctxM.close();
    const desborde = m1.ancho > m1.vista + 1 || (m2 && m2.ancho > m2.vista + 1) || m1.anchos.length > 0;
    return { estado: !hayV2 ? 'FALLA' : desborde ? 'PARCIAL' : 'OK', captura: cap,
      obtenido: `iPhone 13 (${m1.vista} px): v2 ${hayV2 ? 'cargó' : 'NO cargó'}, ${filas} filas; ancho del documento ${m1.ancho} px (sin scroll horizontal de la página: ${m1.ancho <= m1.vista + 1 ? 'sí' : 'NO'})${m1.anchos.length ? `; se salen de la pantalla: ${m1.anchos.join(', ')}` : ''}${m1.chipsDeslizan ? '; la fila de filtros (chips) se desliza de lado' : ''}.${m2 ? ` Con el detalle abierto: ${m2.ancho} px.` : ''} Barra de abajo: «${barra.txt}» ${barra.vis ? 'visible' : 'NO visible'}.`,
      nota: `Responsive medido por código y captura; no reemplaza mirarlo en el teléfono (jsdom/headless no siente el dedo). Otra captura: ${capD}` };
  });
}

// Espera a que la v2 termine de cargar el día (o de optimizar).
async function esperarV2(pg, timeout = 40000) {
  await pg.waitForFunction(() => !/Cargando el día/.test(document.querySelector('#rv2-list')?.innerText || ''), null, { timeout });
  await pg.waitForFunction(() => !document.querySelector('#rt-ovl.show'), null, { timeout: 90000 }).catch(() => {});
  await sleep(700);
}
const rutasV2 = (pg) => pg.evaluate(() => {
  const D = window.RendioRutasV2 && window.RendioRutasV2.dia && window.RendioRutasV2.dia();
  return D ? D.routes.map(r => ({ id: r.id, type: r.type, status: r.status, vehicle: r.vehicle, shift: r.shift, driverId: r.driverId,
    // rt es un const de script de admin-rutas.js: se lee directo (no cuelga de window).
    names: r.stops.map(s => (typeof rt !== 'undefined' && rt.aux && rt.aux[s.crewId] && rt.aux[s.crewId].n) || '?') })) : [];
});
const toastV2 = (pg) => pg.evaluate(() => { const t = document.getElementById('rv2-toast'); return t && !t.hidden ? t.innerText.replace(/\s+/g, ' ').trim() : ''; });

async function publicarV2(pg) {
  const caps = [];
  await esperarV2(pg);
  const hoyTxt = (await pg.evaluate(() => document.querySelector('#rv2-list')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 120);
  caps.push(await foto(pg, 'admin', 'asignacion-antes'));
  // ‹ › elegir el día: mañana y de vuelta a hoy.
  await pg.click('#routes-v2 [data-act=nav][data-dir="1"]');
  await esperarV2(pg);
  const manana = `${(await pg.$eval('#rv2-dayLabel', e => e.innerText.trim()))}: «${(await pg.evaluate(() => document.querySelector('#rv2-list')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 90)}»`;
  caps.push(await foto(pg, 'admin', 'asignacion-manana'));
  await pg.click('#routes-v2 [data-act=nav][data-dir="-1"]');
  await esperarV2(pg);
  const hoyLabel = await pg.$eval('#rv2-dayLabel', e => e.innerText.trim());
  // Optimizar (o Re-optimizar si ya hay plan).
  await pg.click('#rv2-reopt');
  await pg.waitForFunction(() => document.querySelectorAll('#rv2-list .rv2-row').length > 0, null, { timeout: 90000 });
  await esperarV2(pg);
  caps.push(await foto(pg, 'admin', 'optimizado'));
  const rutas0 = await rutasV2(pg);
  // Ver los tripulantes de la ruta más larga (detalle).
  const sal = rutas0.filter(r => r.type === 'salida').sort((a, b) => b.names.length - a.names.length)[0];
  let detalle = '';
  if (sal) {
    await pg.click(`#rv2-list .rv2-row[data-id="${sal.id}"]`).catch(() => {});
    await sleep(700);
    detalle = (await pg.evaluate(() => document.querySelector('#rv2-detail')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 260);
    caps.push(await foto(pg, 'admin', 'detalle-ruta'));
  }
  // «+ Asignar» en cada carro sin conductor, con los de turno del horario publicado.
  const asignados = [];
  let autoOfrecido = false, nAsig = 0;
  for (let i = 0; i < 8; i++) {
    const b = await pg.$('#rv2-list [data-act=assign]');
    if (!b) {
      // Las «Listas» de una franja se esconden: se abren para no dejar carros sin revisar.
      const mas = await pg.$('#rv2-list .rv2-more'); if (mas) { await mas.click(); await sleep(400); continue; }
      break;
    }
    await b.click();
    await pg.waitForSelector('#rv2-sheet:not([hidden])', { timeout: 8000 });
    await sleep(400);
    const head = (await pg.$eval('#rv2-sheet .rv2-sh-head', e => e.innerText).catch(() => '')).replace(/\s+/g, ' ');
    const opts = await pg.$$eval('#rv2-dopts [data-pick]', els => els.map(e => ({ id: e.dataset.pick, t: e.innerText.replace(/\s+/g, ' ').trim(), off: e.disabled })));
    autoOfrecido = autoOfrecido || !!(await pg.$('#rv2-sheet [data-act=autoassign]'));
    if (!nAsig) caps.push(await foto(pg, 'admin', 'asignar-conductor'));
    // Primero los que tienen celular (Pedro no: el tripulante no podría llamarlo).
    const pick = ['Diana', 'Carlos', 'Pedro'].map(n => opts.find(o => !o.off && o.t.includes(n))).find(Boolean);
    if (!pick) { await pg.click('#rv2-sheet [data-act=sclose]').catch(() => {}); asignados.push(`${head}: nadie disponible`); break; }
    await pg.click(`#rv2-dopts [data-pick="${pick.id}"]`);
    await pg.click('#rv2-doAssign:not([disabled])');
    await sleep(700);
    asignados.push(`${head.split(' Turno')[0].replace('Conductor para ', '')} ${/Turno (AM|PM)/.exec(head)?.[1] || ''} → ${pick.t.split(' Libre')[0].split(' Actual')[0]}`);
    nAsig++;
  }
  caps.push(await foto(pg, 'admin', 'conductores-asignados'));
  // A02 «Mover auxiliar» + «Deshacer» (antes de publicar; deja todo como estaba).
  await prueba('A02', pg, 'admin', async () => {
    const rutas = await rutasV2(pg);
    const r = rutas.filter(x => x.type === 'salida').sort((a, b) => b.names.length - a.names.length)[0];
    if (!r || r.names.length < 2) throw new NoProbado('No hay una salida con 2 o más tripulantes para mover.');
    await pg.click(`#rv2-list .rv2-row[data-id="${r.id}"]`).catch(() => {});
    await sleep(600);
    await pg.click('#rv2-detail [data-act=pickmove]');
    await pg.waitForSelector('#rv2-sheet:not([hidden]) [data-act=move]', { timeout: 8000 });
    const quienes = await pg.$$eval('#rv2-sheet [data-act=move]', els => els.map(e => ({ c: e.dataset.crew, t: e.innerText.replace(/\s+/g, ' ').trim(), off: e.disabled })));
    const q0 = quienes.filter(x => !x.off).pop();
    await pg.click(`#rv2-sheet [data-act=move][data-crew="${q0.c}"]`);
    await pg.waitForSelector('#rv2-opts', { timeout: 8000 });
    await sleep(500);
    let opciones = await pg.$$eval('#rv2-opts [data-pick]', els => els.map(e => ({ p: e.dataset.pick, t: e.innerText.replace(/\s+/g, ' ').trim() })));
    const sinSugeridas = !opciones.length;
    const impacto = (await pg.evaluate(() => document.querySelector('#rv2-sheet .rv2-sh-body')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 200);
    if (!opciones.length) {
      const otro = rutas.find(x => x.id !== r.id && x.type === r.type) || rutas.find(x => x.id !== r.id);
      if (otro) { await pg.fill('#rv2-optq', otro.vehicle); await sleep(700); }
      opciones = await pg.$$eval('#rv2-opts [data-pick]', els => els.map(e => ({ p: e.dataset.pick, t: e.innerText.replace(/\s+/g, ' ').trim() })));
    }
    const capOpc = await foto(pg, 'admin', 'mover-opciones');
    if (!opciones.length) {
      await pg.click('#rv2-sheet [data-act=sclose]').catch(() => {});
      return { estado: 'PARCIAL', captura: capOpc, obtenido: `«Mover auxiliar» › ${q0.t}: «${impacto}». Ni sugeridas ni en el buscador hay otra ruta: no se pudo mover.`, nota: '' };
    }
    await pg.click(`#rv2-opts [data-pick="${opciones[0].p}"]`);
    await pg.click('#rv2-doMove:not([disabled])');
    await sleep(900);
    const toast = await toastV2(pg);
    const despues = await rutasV2(pg);
    const capMov = await foto(pg, 'admin', 'movido');
    const movio = !(despues.find(x => x.id === r.id)?.names || []).includes(q0.t.split(' · ')[0]);
    const undo = await pg.$('#rv2-toast [data-act=undo]');
    if (undo) { await undo.click(); await sleep(900); }
    const vuelta = await rutasV2(pg);
    const igual = JSON.stringify(vuelta.map(x => [x.id, x.names])) === JSON.stringify(rutas.map(x => [x.id, x.names]));
    const capUndo = await foto(pg, 'admin', 'mover-deshecho');
    return { estado: movio && igual ? 'OK' : 'FALLA', captura: capMov,
      obtenido: `Mover a ${q0.t.split(' · ')[0]} desde ${r.vehicle}: «${impacto}»${sinSugeridas ? ' (sin sugeridas; se buscó la otra ruta en el buscador)' : ''}. Destino elegido: «${opciones[0].t}». Aviso: «${toast}». Movido: ${movio ? 'sí' : 'NO'}. Tras «Deshacer»: ${igual ? 'las rutas quedan como antes' : 'las rutas NO quedaron como antes: ' + JSON.stringify(vuelta.map(x => [x.id, x.names]))}.`,
      nota: `El plan se publica después con el movimiento deshecho. Otras capturas: ${capOpc}, ${capUndo}` };
  });
  // «Publicar plan» › hoja de verificación.
  await pg.click('#rv2-publish:not([disabled])');
  await pg.waitForSelector('#rv2-sheet:not([hidden]) #rv2-doPublish', { timeout: 8000 });
  await sleep(500);
  const hoja = (await pg.evaluate(() => document.querySelector('#rv2-sheet')?.innerText || '')).replace(/\s+/g, ' ').trim();
  const ack = await pg.$('#rv2-ack');
  if (ack) await ack.check();
  caps.push(await foto(pg, 'admin', 'publicar-verificacion'));
  let forzado = false;
  if (await pg.$('#rv2-doPublish:not([disabled])')) await pg.click('#rv2-doPublish');
  else if (await pg.$('#rv2-forceOpen')) {
    forzado = true;
    await pg.click('#rv2-forceOpen');
    for (const c of await pg.$$('#rv2-force input[type=checkbox]')) await c.check();
    await pg.click('#rv2-doForce:not([disabled])');
  }
  const t = await esperar(async () => { const x = await toastV2(pg); return /publicad|No se pudo|Solo se publica|error/i.test(x) ? x : null; }, { timeout: 30000 });
  await sleep(1200);
  caps.push(await foto(pg, 'admin', 'publicado'));
  const chip = await pg.$eval('#rv2-pubChip', e => e.hidden ? '' : e.innerText.trim()).catch(() => '');
  PLAN = await planPublicado();
  const enRuta = new Set(PLAN.filter(r => r.driver_profile_id && r.status === 'planned').flatMap(r => r.stops.map(s => s.rid)));
  const faltan = RESERVAS.filter(r => !enRuta.has(r.id)).map(r => r.full_name);
  const ok = t && /publicad/i.test(t) && !/No se pudo/i.test(t) && !faltan.length;
  return { estado: ok ? (forzado ? 'PARCIAL' : 'OK') : 'FALLA', captura: caps[caps.length - 1],
    obtenido: `Hoy (${hoyLabel}) al entrar: «${hoyTxt}». Mañana ${manana}. Tras Optimizar: ${rutas0.length} rutas (${rutas0.map(r => `${r.vehicle} ${r.type} [${r.names.join(', ')}]`).join(' · ')}). Detalle de la salida: «${detalle}». Asignado: ${asignados.join(' · ')}${autoOfrecido ? ' («Autoasignar» ofrecido, no usado)' : ''}. Hoja de verificación: «${hoja.slice(0, 330)}»${forzado ? ' → se usó «Publicar de todos modos»' : ''}. Aviso al publicar: «${t || '(ninguno en 30 s)'}». Chip: «${chip}». En la base: ${resumenPlan()}.${faltan.length ? ` Sin ruta publicada: ${faltan.join(', ')}.` : ''}`,
    nota: `Capturas en 1440×900. Los push de «Conductor asignado»/«Ruta asignada» salen por send-push (en local 401): no se verifican aquí. Otras capturas: ${caps.slice(0, -1).join(', ')}` };
}

// La vista anterior de Asignación (por si la v2 no está).
async function publicarVieja(pg) {
  const caps = [];
  await sleep(1500);
  caps.push(await foto(pg, 'admin', 'asignacion-antes'));
  const elegidos = [];
  await pg.click('#rt-optBtn');
  await pg.waitForFunction(() => !document.querySelector('#rt-ovl.show'), null, { timeout: 90000 });
  await pg.waitForSelector('#rt-saveBtn', { state: 'visible', timeout: 15000 });
  await sleep(1200);
  caps.push(await foto(pg, 'admin', 'optimizado'));
  const carros = await pg.$$eval('[data-assign]', els => els.map(e => e.dataset.assign));
  for (const [i, lane] of carros.entries()) {
    await pg.click(`[data-assign="${lane}"]`);
    await pg.waitForSelector('#rt-drawer.show', { timeout: 8000 });
    await sleep(400);
    const opts = await pg.$$eval('#rt-drawer .drv-opt', els => els.map(e => ({ id: e.dataset.rtdrv, band: e.dataset.rtband, n: e.innerText.replace(/\s+/g, ' ').trim() })));
    for (const band of [...new Set(opts.map(o => o.band))]) {
      const pref = band === 'am' ? ['Carlos', 'Diana', 'Pedro'] : ['Diana', 'Carlos', 'Pedro'];
      const pick = pref.map(p => opts.find(o => o.band === band && o.n.includes(p) && !elegidos.some(e => e.band === band && e.id === o.id))).find(Boolean);
      if (pick) { await pg.click(`#rt-drawer .drv-opt[data-rtdrv="${pick.id}"][data-rtband="${band}"]`); elegidos.push({ band, id: pick.id, n: pick.n.replace(/^\w\w /, ''), lane }); }
    }
    if (i === 0) caps.push(await foto(pg, 'admin', 'asignar-conductor'));
    await pg.click('[data-rtconfirm]');
    await sleep(700);
  }
  await pg.click('#rt-saveBtn');
  const ok = await esperar(async () => (await toastsDe(pg)).find(t => /Plan publicado|No se pudo publicar/.test(t)), { timeout: 30000 });
  await sleep(800);
  caps.push(await foto(pg, 'admin', 'publicado'));
  PLAN = await planPublicado();
  resultado('A02', 'NO PROBADO', '«Mover auxiliar» es de la v2 y se usó la vista anterior.', '', '');
  return { estado: ok && /Plan publicado/.test(ok) ? 'OK' : 'FALLA', captura: caps[caps.length - 1],
    obtenido: `Vista ANTERIOR (no apareció la v2). Conductores: ${elegidos.map(e => `${e.lane} ${e.band.toUpperCase()} ${e.n.split(' En ')[0]}`).join(' · ')}. Aviso: «${ok || '(ninguno)'}». En la base: ${resumenPlan()}.`,
    nota: `Otras capturas: ${caps.slice(0, -1).join(', ')}` };
}
function resumenPlan() {
  return PLAN.map(r => `${r.direction === 'home_to_airport' ? 'Salida' : 'Llegada'} ${hhmm(r.planned_start_at)} ${r.internal_code || ''} ${r.conductor ? r.conductor.full_name : 'SIN conductor'} [${r.status}]: ${r.stops.map(s => `${s.orden}.${(s.full_name || '?').split(' ')[0]}${s.eta ? ' ' + hhmm(s.eta) : ''}`).join(', ')}`).join(' | ');
}
// Igual que Api.saveRoutePlan (rendio-turnos/api.js): borra lo draft/planned del
// día y crea una vuelta por vuelo con conductor, carro, hora y ETA por parada.
async function publicarPorSQL() {
  const veh = await q(`SELECT id, internal_code FROM public.vehicles ORDER BY internal_code`);
  const d0 = `${DIA}T00:00:00-05:00`, d1 = `${DIA}T23:59:59-05:00`;
  await q(`DELETE FROM public.route_assignments WHERE status IN ('draft','planned') AND planned_start_at BETWEEN $1 AND $2`, [d0, d1]);
  const grupos = {};
  for (const r of RESERVAS) { const k = r.direction + '|' + r.required_arrival_at.toISOString(); (grupos[k] = grupos[k] || []).push(r); }
  let i = 0;
  for (const g of Object.values(grupos)) {
    const sal = g[0].direction === 'home_to_airport';
    const t0 = new Date(g[0].required_arrival_at.getTime() + (sal ? -45 : 20) * 60000);
    const drv = sal && i === 0 ? CUENTAS.diana : CUENTAS.carlos;
    const ra = await q1(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
                         VALUES ($1, $2, $3, 'planned', $4) RETURNING id`, [drv.drv_id, veh[i % veh.length].id, g[0].direction, t0.toISOString()]);
    for (const [k, r] of g.entries()) {
      await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4)`,
        [ra.id, r.id, k + 1, new Date(t0.getTime() + (sal ? k * 6 : 15 + k * 6) * 60000).toISOString()]);
    }
    i++;
  }
}

// ================================================================= TRIPULANTE (registro)
async function bloqueTripulante() {
  NUM = Math.max(NUM, RANGO.tripulante);
  console.log('\n[tripulante] Registro, pedir traslado y revisar la reserva');
  const ctx = await contexto('movil');
  const pg = await ctx.newPage();
  vigilar(pg, 'tripulante-nueva');
  const email = `nueva.${Date.now().toString(36)}@rendio.test`;
  const nombre = 'Mariana Restrepo Vélez';
  let rid = null, okRegistro = false;
  await prueba('T01', pg, 'tripulante', async () => {
    const caps = [];
    await pg.goto(BASE + '/');
    await pg.waitForSelector('#login-signup', { state: 'visible', timeout: 20000 });
    caps.push(await foto(pg, 'tripulante', 'login-crear-cuenta'));
    await pg.click('#login-signup');
    await pg.waitForSelector('[data-rg-field=name]', { state: 'visible', timeout: 10000 });
    await pg.fill('[data-rg-field=name]', nombre);
    await pg.fill('[data-rg-field=email]', email);
    await pg.fill('[data-rg-field=phone]', '3105550199');
    await pg.fill('[data-rg-field=pass]', PASS_NUEVA);
    await pg.fill('[data-rg-field=pass2]', PASS_NUEVA);
    await sleep(300);
    caps.push(await foto(pg, 'tripulante', 'registro-datos'));
    await pg.click('[data-rg=crear]:not([disabled])', { timeout: 8000 });
    await pg.waitForSelector('[data-rg=airline]', { state: 'visible', timeout: 20000 });
    await pg.click('[data-rg=airline] >> text=Avianca');
    await pg.fill('[data-rg-q="1"]', 'Olivar');
    await pg.click('[data-rg=res-pick]', { timeout: 8000 });
    await pg.fill('[data-rg-field=unit]', 'Torre 5 · 801').catch(() => {});
    await pg.fill('[data-rg-field=meetingPoint]', 'Portería principal').catch(() => {});
    caps.push(await foto(pg, 'tripulante', 'registro-aerolinea-conjunto'));
    await pg.click('[data-rg=registrar]');
    const bienvenida = await esperarTexto(pg, /Te damos la bienvenida/, 20000);
    const textoBienvenida = (await pg.evaluate(() => document.body.innerText)).match(/Te damos la bienvenida[^\n]*\n?[^\n]*/)?.[0] || '';
    caps.push(await foto(pg, 'tripulante', 'registro-bienvenida'));
    await pg.click('[data-rg=entrar]', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    caps.push(await foto(pg, 'tripulante', 'presentacion'));
    await saltarPresentacion(pg);
    const inicio = await pg.waitForSelector('[data-ax=new]', { state: 'visible', timeout: 15000 }).then(() => true, () => false);
    caps.push(await foto(pg, 'tripulante', 'inicio-nueva'));
    const p = await q1(`SELECT p.id, p.role, p.phone, p.full_name, r.name AS conjunto, al.name AS aerolinea, ap.residence_unit
                          FROM public.profiles p LEFT JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id
                          LEFT JOIN public.residences r ON r.id = ap.residence_id LEFT JOIN public.airlines al ON al.id = ap.airline_id
                         WHERE p.email = $1`, [email]);
    okRegistro = !!(bienvenida && inicio && p && p.role === 'auxiliar');
    if (p) NUEVA = { email };
    return {
      estado: okRegistro && p.conjunto ? 'OK' : (p ? 'PARCIAL' : 'FALLA'), captura: caps[3],
      obtenido: `Correo ${email}. Pantalla final: «${textoBienvenida.replace(/\s+/g, ' ').trim()}». Llegó a su Inicio: ${inicio ? 'sí' : 'no'}. En la base: ${p ? `perfil ${p.role}, «${p.full_name}», celular ${p.phone}, conjunto ${p.conjunto || '—'} (${p.residence_unit || 'sin unidad'}), aerolínea ${p.aerolinea || '—'}` : 'NO quedó el perfil'}.`,
      nota: `No cubre la verificación por correo (está apagada hasta que paguen Supabase) ni «Activar notificaciones» (se tocó «Ahora no»). Otras capturas: ${caps.filter((_, i) => i !== 3).join(', ')}`,
    };
  });

  await prueba('T02', pg, 'tripulante', async () => {
    if (!okRegistro) throw new NoProbado('El registro (T01) no terminó, no hay con quién pedir.');
    const caps = [];
    await pg.click('[data-ax=new]:visible');
    await pg.click('[data-ax=type][data-type=sal]', { timeout: 8000 });
    await pg.click(`[data-ax=date][data-iso="${MANANA}"]`, { timeout: 8000 });
    await pg.fill('[data-field=time]', '06:30');
    await sleep(300);
    caps.push(await foto(pg, 'tripulante', 'pedir-cuando'));
    await pg.click('[data-ax=next]:not([disabled])');
    await pg.click('[data-ax=lvl][data-v=shared]', { timeout: 8000 });
    await pg.click('[data-ax=next]:not([disabled])');
    await pg.waitForSelector('.rx-slide-k', { state: 'visible', timeout: 8000 });
    await sleep(500);
    caps.push(await foto(pg, 'tripulante', 'pedir-revisar'));
    // Deslizar para pedir (el gesto real, no un clic).
    const k = await (await pg.$('.rx-slide-k')).boundingBox();
    const s = await (await pg.$('.rx-slide')).boundingBox();
    await pg.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await pg.mouse.down();
    for (let i = 1; i <= 14; i++) await pg.mouse.move(k.x + k.width / 2 + (s.width - k.width) * i / 14, k.y + k.height / 2);
    await pg.mouse.up();
    const pedido = await esperarTexto(pg, /Traslado pedido/, 15000);
    await sleep(900);
    caps.push(await foto(pg, 'tripulante', 'pedido-ok'));
    await pg.click('[data-ax=home]').catch(() => {});
    await sleep(800);
    await pg.click('[data-rx=rx-tab][data-tab=viajes]');
    await pg.waitForSelector('[data-ax=trip]', { state: 'visible', timeout: 10000 });
    await sleep(800);
    const capLista = await foto(pg, 'tripulante', 'viajes-lista');
    const tarjeta = await pg.evaluate(() => (document.querySelector('[data-ax=trip]')?.innerText || '').replace(/\s+/g, ' ').trim());
    rid = await pg.evaluate(() => document.querySelector('[data-ax=trip]')?.dataset.id || null);
    const r = rid ? await q1(`SELECT direction, required_arrival_at, pickup_address, service_level, status_h2a, meet_code FROM public.reservations WHERE id = $1`, [rid]) : null;
    const dd = new Date(MANANA + 'T12:00:00Z');
    const diaTxt = String(dd.getUTCDate());
    const ok = pedido && /06:30/.test(tarjeta) && /Olivar/i.test(tarjeta) && tarjeta.includes(diaTxt) && r && r.direction === 'home_to_airport';
    return {
      estado: ok ? 'OK' : 'FALLA', captura: capLista,
      obtenido: `«¡Traslado pedido!»: ${pedido ? 'sí' : 'no'}. Tarjeta en Viajes › Próximos: «${tarjeta.slice(0, 200)}». En la base: ${r ? `${r.direction}, estar en MDE ${hhmm(r.required_arrival_at)} del ${diaBog(r.required_arrival_at)}, recogida «${r.pickup_address}», ${r.service_level}, estado ${r.status_h2a}` : 'NO hay reserva'}.`,
      nota: `La hora de recogida aún no existe (la publica el plan). Otras capturas: ${caps.join(', ')}`,
    };
  });

  await prueba('T03', pg, 'tripulante', async () => {
    if (!rid) throw new NoProbado('No hay traslado pedido (T02).');
    await pg.click(`[data-ax=trip][data-id="${rid}"]`);
    await pg.waitForSelector('.rx-trip', { state: 'visible', timeout: 12000 });
    await sleep(1200);
    const cap = await foto(pg, 'tripulante', 'detalle-reserva');
    const t = (await pg.evaluate(() => document.querySelector('.rx-trip')?.innerText || '')).replace(/\s+/g, ' ');
    const ok = /06:30/.test(t) && /(armando tu ruta|te avisamos)/i.test(t);
    return { estado: ok ? 'OK' : 'PARCIAL', captura: cap, obtenido: `Detalle: «${t.slice(0, 330)}».`, nota: 'Solo lectura: no prueba cancelar ni cambiar la presentación.' };
  });

  // --- T12 pedir una LLEGADA (Aeropuerto → Casa)
  await prueba('T12', pg, 'tripulante', async () => {
    if (!okRegistro) throw new NoProbado('El registro (T01) no terminó, no hay con quién pedir.');
    const caps = [];
    await pg.goto(BASE + '/');
    await saltarPresentacion(pg);
    await pg.click('[data-ax=new]:visible', { timeout: 15000 });
    await pg.click('[data-ax=type][data-type=lle]', { timeout: 8000 });
    await pg.click(`[data-ax=date][data-iso="${MANANA}"]`, { timeout: 8000 });
    await pg.click('[data-ax=fl-pick][data-k=flight]', { timeout: 8000 });
    await pg.click('[data-ax=fl-set][data-k=flight][data-iata=AV]', { timeout: 8000 });
    await pg.fill('[data-field=flightNum]', '9412');
    await pg.fill('[data-field=time]', '14:20');
    await sleep(400);
    caps.push(await foto(pg, 'tripulante', 'pedir-llegada-vuelo'));
    await pg.click('[data-ax=next]:not([disabled])');
    if (await pg.waitForSelector('[data-ax=lvl][data-v=shared]', { timeout: 5000 }).then(() => true, () => false)) {
      await pg.click('[data-ax=lvl][data-v=shared]');
      await pg.click('[data-ax=next]:not([disabled])');
    }
    await pg.waitForSelector('.rx-slide-k', { state: 'visible', timeout: 10000 });
    await sleep(500);
    caps.push(await foto(pg, 'tripulante', 'pedir-llegada-revisar'));
    const k = await (await pg.$('.rx-slide-k')).boundingBox();
    const sl = await (await pg.$('.rx-slide')).boundingBox();
    await pg.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await pg.mouse.down();
    for (let i = 1; i <= 14; i++) await pg.mouse.move(k.x + k.width / 2 + (sl.width - k.width) * i / 14, k.y + k.height / 2);
    await pg.mouse.up();
    const pedido = await esperarTexto(pg, /Traslado pedido/, 15000);
    await sleep(900);
    const cap = await foto(pg, 'tripulante', 'pedido-llegada-ok');
    const r = await q1(`SELECT r.direction, r.required_arrival_at, r.status_a2h, r.notes, f.flight_number
                          FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                          JOIN public.profiles p ON p.id = ap.profile_id LEFT JOIN public.flights f ON f.id = r.flight_id
                         WHERE p.email = $1 AND r.direction = 'airport_to_home' ORDER BY r.created_at DESC LIMIT 1`, [NUEVA && NUEVA.email]);
    const vuelo = r && ((r.flight_number || '') + ' ' + (r.notes || ''));
    const ok = pedido && r && r.status_a2h === 'scheduled' && diaBog(r.required_arrival_at) === MANANA && hhmm(r.required_arrival_at) === '14:20' && /AV\s?9412/i.test(vuelo);
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `«¡Traslado pedido!»: ${pedido ? 'sí' : 'no'}. En la base: ${r ? `${r.direction}, aterriza ${hhmm(r.required_arrival_at)} del ${diaBog(r.required_arrival_at)}, estado ${r.status_a2h}, vuelo «${(vuelo || '').trim()}»` : 'NO hay reserva de llegada'}.`,
      nota: `Otras capturas: ${caps.join(', ')}` };
  });
  await ctx.close();
}

// ================================================================= CONDUCTOR sin celular
async function bloqueCelular() {
  NUM = Math.max(NUM, RANGO.celular);
  console.log('\n[celular] Conductor sin celular (pedro.local)');
  const ctx = await contexto('movil');
  await prueba('C01', null, 'conductor', async () => {
    await q(`UPDATE public.profiles SET phone = NULL WHERE id = $1`, [CUENTAS.pedro.id]);
    const pg = await entrar(ctx, CUENTAS.pedro.email, PASS, 'conductor-pedro');
    const hay = await pg.waitForSelector('#drv-tel-modal [data-drv-tel=input]', { state: 'visible', timeout: 15000 }).then(() => true, () => false);
    const cap = await foto(pg, 'conductor', 'pide-celular');
    if (!hay) {
      const home = (await pg.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 160);
      return { estado: 'FALLA', captura: cap, obtenido: `Pedro no tiene celular y NO aparece la ventana (#drv-tel-modal): entra directo («${home}»).`, nota: 'driver-celular.js · drvTelPedirSiFalta() la abre al entrar (core.js · enterApp).' };
    }
    const titulo = await pg.$eval('#drv-tel-modal', e => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 120)).catch(() => '');
    const sigue = async () => !!(await pg.$('#drv-tel-modal:visible'));
    const err = async () => (await pg.$eval('#drv-tel-modal [data-drv-tel=err]', e => e.classList.contains('hidden') ? '' : e.innerText.trim()).catch(() => ''));
    const intento = async (txt, valido) => {
      await pg.fill('#drv-tel-modal [data-drv-tel=input]', txt);
      await pg.click('#drv-tel-modal [data-drv-tel=guardar]');
      await sleep(900);
      const abierta = await sigue();
      if (valido) return `«${txt}» → ${abierta ? `NO lo acepta («${await err()}»)` : 'lo guarda, se cierra la ventana y entra'}`;
      return `«${txt || '(vacío)'}» → ${abierta ? `no deja seguir («${await err()}»)` : 'DEJA SEGUIR'}`;
    };
    const pasos = [];
    pasos.push(await intento(''));
    pasos.push(await intento('12345'));
    pasos.push(await intento('2001234567'));
    const capMalo = await foto(pg, 'conductor', 'celular-invalido');
    // Tocar afuera (esquina del velo) no la cierra cuando es obligatoria.
    await pg.mouse.click(5, 5); await sleep(500);
    pasos.push(`tocar afuera → ${await sigue() ? 'sigue abierta' : 'SE CERRÓ'}`);
    const cerrable = !!(await pg.$('#drv-tel-modal [data-drv-tel=cancelar]'));
    pasos.push(await intento('300 765 4321', true));
    const fila = await q1(`SELECT phone FROM public.profiles WHERE id = $1`, [CUENTAS.pedro.id]);
    const capOk = await foto(pg, 'conductor', 'celular-guardado');
    // «Mi celular» en su Perfil.
    let perfil = '';
    try {
      await pg.click('.dnav-btn[data-dtab=perfil]');
      await sleep(1500);
      perfil = (await pg.evaluate(() => { const t = document.body.innerText; const i = t.search(/Mi celular/i); return i >= 0 ? t.slice(i, i + 32) : ''; })).replace(/\s+/g, ' ');
    } catch (_) { /* */ }
    const capPerfil = await foto(pg, 'conductor', 'perfil-mi-celular');
    const ok = pasos.slice(0, 3).every(p => /no deja seguir/.test(p)) && /sigue abierta/.test(pasos[3]) && !cerrable
      && soloDig(fila.phone) === '3007654321' && !(await sigue());
    await q(`UPDATE public.profiles SET phone = NULL WHERE id = $1`, [CUENTAS.pedro.id]);   // queda como lo deja el seed
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Ventana al entrar: «${titulo}» (sin «Cancelar»: ${cerrable ? 'NO, sí tiene' : 'sí'}). ${pasos.join(' · ')}. En la base phone = ${fila.phone || 'NULL'}. Perfil: «${perfil || '(no encontré «Mi celular»)'}».`,
      nota: `Al final se devuelve el celular de pedro a NULL (como lo deja el seed). Otras capturas: ${capMalo}, ${capOk}, ${capPerfil}` };
  });
  await ctx.close();
}

// ================================================================= SALIDA (casa → MDE)
async function bloqueSalida() {
  NUM = Math.max(NUM, RANGO.salida);
  console.log('\n[salida] Casa → MDE');
  const ra = PLAN.filter(r => r.direction === 'home_to_airport' && r.driver_profile_id)
    .sort((a, b) => b.stops.length - a.stops.length || new Date(a.planned_start_at) - new Date(b.planned_start_at))[0];
  if (!ra || !ra.conductor) {
    for (const id of CAT.filter(c => c[1] === 'salida').map(c => c[0])) resultado(id, 'NO PROBADO', 'No hay una salida publicada con conductor para hoy (ver A01).', '', '');
    return;
  }
  const stops = ra.stops;
  const S = (i) => stops[i];
  const nom1 = (s) => (s.full_name || '').split(' ')[0];
  const drv = ra.conductor;
  // Si el plan le tocó al conductor sin celular (pedro.local), se le pone uno válido
  // antes, como haría él en la ventana que se lo pide (eso ya lo prueba C01).
  if (!soloDig(drv.phone)) { await q(`UPDATE public.profiles SET phone = '3009990011' WHERE id = $1`, [drv.id]); drv.phone = '3009990011'; }
  const tripIds = stops.map(s => s.profile_id);
  console.log(`  Vuelta ${hhmm(ra.planned_start_at)} · ${drv.full_name} · ${stops.map(s => `${s.orden}.${nom1(s)}`).join(', ')}`);
  const inicioGps = norte(S(0).lat, S(0).lng, -1200);
  const ctxD = await contexto('movil', { ...inicioGps, accuracy: 10 });
  const ctxA = await contexto('movil');
  const ultimo = stops.length - 1;
  const ctxL = ultimo > 0 ? await contexto('movil') : null;
  let pgD = null, pgA = null, pgL = null, bloqueo = null;
  const gps = async (p) => { await ctxD.setGeolocation({ latitude: p.latitude, longitude: p.longitude, accuracy: 10 }); };
  // Mueve el GPS y espera a que el teléfono GUARDE ese punto. La app escribe como
  // mucho uno cada 6 s y el emulador solo avisa al cambiar: si el aviso cayó dentro
  // de los 6 s, se vuelve a mover 3 m para que salga el siguiente.
  const gpsConPing = async (p) => {
    const t = await ahoraDb();
    const ping = () => q1(`SELECT latitude, longitude, recorded_at FROM public.driver_locations WHERE driver_profile_id = $1 AND source = 'gps' AND recorded_at >= $2 AND abs(latitude - $3) < 0.0003 ORDER BY recorded_at DESC LIMIT 1`, [ra.driver_profile_id, t, p.latitude]);
    await gps(p);
    let r = await esperar(ping, { timeout: 7000, cada: 500 });
    for (let i = 1; !r && i <= 2; i++) { await gps({ latitude: p.latitude + i * 0.000027, longitude: p.longitude }); r = await esperar(ping, { timeout: 7500, cada: 500 }); }
    return r;
  };
  const corta = (id, motivo) => resultado(id, 'NO PROBADO', `No se llegó a este paso: ${motivo}`, '', '');
  const T0 = await ahoraDb();

  // --- tripulantes mirando su viaje desde antes de que arranque la ruta
  pgA = await entrar(ctxA, S(0).email, PASS, `tripulante-${nom1(S(0))}`);
  await saltarPresentacion(pgA);
  await abrirViaje(pgA, S(0).id).catch(e => { bloqueo = 'no abre el viaje del 1er tripulante: ' + e.message; });
  if (ctxL) {
    pgL = await entrar(ctxL, S(ultimo).email, PASS, `tripulante-${nom1(S(ultimo))}`);
    await saltarPresentacion(pgL);
    await abrirViaje(pgL, S(ultimo).id).catch(() => {});
  }
  const capAsignado = await foto(pgA, 'tripulante', 'viaje-asignado');

  // --- S01 recordatorio por hora (se adelanta el reloj de la 1ª parada)
  await prueba('S01', pgA, 'tripulante', async () => {
    await q(`UPDATE public.route_stops SET estimated_arrival_at = now() + interval '9 minutes' WHERE route_assignment_id = $1 AND reservation_id = $2`, [ra.id, S(0).id]);
    const pub = await q1(`SELECT calculated_pickup_at FROM public.reservations WHERE id = $1`, [S(0).id]);
    const det = await q1(`SELECT public.detect_trip_reminders() AS r`);
    const a = await esperarAviso(S(0).profile_id, `trip:${S(0).id}:remind:%`, 10000);
    await esperarTexto(pgA, new RegExp(hhmm(pub.calculated_pickup_at).replace(/^0/, '0?')), 14000);
    const cap = await foto(pgA, 'tripulante', 'recordatorio-10min');
    const ok = a && /Te recogen a las/.test(a.title) && (!S(0).meet_code || a.body.includes(S(0).meet_code));
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Hora publicada adelantada a ${hhmm(pub.calculated_pickup_at)} (calculated_pickup_at la recalculó la base). detect_trip_reminders → «${det.r}». Bandeja de ${S(0).full_name}: ${fmtAviso(a)}.`,
      nota: `Reloj simulado: se adelantó por SQL route_stops.estimated_arrival_at a ahora+9 min en vez de esperar ~1 h. El aviso push real lo despacha dispatch-notifications (no llega a headless). Otra captura: ${capAsignado}` };
  });

  // --- C02 «Tu día» › «Iniciar ruta»
  let toques = 0, primerPing = null;
  await prueba('C02', null, 'conductor', async () => {
    pgD = await entrar(ctxD, drv.email, PASS, `conductor-${drv.clave}`);
    const btn = `[data-vuelta-start="${ra.id}"]`;
    const hay = await pgD.waitForSelector(btn, { state: 'visible', timeout: 20000 }).then(() => true, () => false);
    const capDia = await foto(pgD, 'conductor', 'tu-dia');
    if (!hay) { bloqueo = '«Tu día» no muestra «Iniciar ruta» para la vuelta publicada'; throw new Error(bloqueo); }
    const tuDia = (await pgD.evaluate(() => document.getElementById('driver-home-ruta')?.innerText || '')).replace(/\s+/g, ' ');
    await pgD.click(btn); toques++;
    await esExec(pgD);
    const a = await esperarAviso(S(0).profile_id, `trip:${S(0).id}:en_route`, 15000);
    // El GPS emulado solo avisa cuando la posición CAMBIA (un teléfono real manda
    // puntos solo): se mueve 10 m para que salga el primer punto del recorrido.
    await sleep(1500);
    await gps(norte(S(0).lat, S(0).lng, -1190));
    primerPing = await esperar(async () => q1(`SELECT recorded_at FROM public.driver_locations WHERE driver_profile_id = $1 AND source = 'gps' AND recorded_at >= $2 ORDER BY recorded_at LIMIT 1`, [ra.driver_profile_id, T0]), { timeout: 12000, cada: 600 });
    await sleep(1500);
    const cap = await foto(pgD, 'conductor', 'ruta-iniciada');
    await mapaConductor(pgD, 'al iniciar la ruta (parada 1)', cap);
    const st = await q1(`SELECT status FROM public.route_assignments WHERE id = $1`, [ra.id]);
    const leg = await legActual(pgD);
    return { estado: a && toques <= 3 ? 'OK' : 'FALLA', captura: cap,
      obtenido: `«Tu día»: «${tuDia.slice(0, 160)}». Toques desde el inicio hasta el aviso: ${toques}. Pantalla: parada «${leg.nombre}», botón «${leg.cta}». Bandeja de ${nom1(S(0))}: ${fmtAviso(a)}. route_assignments.status tras iniciar = ${st.status}. Primer punto GPS del carro guardado: ${primerPing ? hora(primerPing.recorded_at) : 'NINGUNO en 12 s'}.`,
      nota: `Sin iniciar turno (inspección): la ruta arranca igual. ${st.status === 'planned' ? 'La vuelta sigue en «planned» después de iniciar (nadie la pasa a in_progress). ' : ''}El GPS emulado de Playwright solo dispara cuando la posición cambia: se mueve el carro 10 m al arrancar. Otra captura: ${capDia}` };
  });
  if (bloqueo || !pgD) { ['T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'S02', 'S05'].forEach(id => corta(id, bloqueo || 'el conductor no pudo iniciar la ruta (C02)')); return; }

  // --- T04 Eres el siguiente (pantalla del tripulante)
  await prueba('T04', pgA, 'tripulante', async () => {
    const a = (await avisos(S(0).profile_id, `trip:${S(0).id}:en_route`))[0];
    // El carro con un punto FRESCO (el de esta vuelta, no el último de antes).
    const enCamino = await esperar(async () => { const v = await leerViaje(pgA); return v.fase === 'enroute' && v.carro && /ahora|hace \d+ s/.test(v.frescura) ? v : null; }, { timeout: 25000, cada: 1000 });
    await sleep(2500);
    await arriba(pgA);
    const v = await leerViaje(pgA);
    const cap = await foto(pgA, 'tripulante', 'en-camino');
    return { estado: a && enCamino ? 'OK' : (a ? 'PARCIAL' : 'FALLA'), captura: cap,
      obtenido: `Bandeja: ${fmtAviso(a)}. Pantalla: fase «${v.fase}», grande «${v.grande}» · «${v.etiqueta}», carro en el mapa: ${v.carro ? 'sí' : 'NO'} («${v.frescura}»).`,
      nota: /min/.test(v.grande) ? 'Con OSRM respondiendo, la pantalla muestra los minutos estimados («N min · X va por ti») en vez de la frase «Eres el siguiente», que sí va en el aviso.' : '' };
  });

  // --- T09 código de 2 dígitos
  await prueba('T09', pgA, 'tripulante', async () => {
    const v = await esperar(async () => { const x = await leerViaje(pgA); return x.codigo ? x : null; }, { timeout: 12000 });
    const r = await reserva(S(0).id);
    const cap = await foto(pgA, 'tripulante', 'codigo-encuentro');
    return { estado: v && /^\d{2}$/.test(v.codigo) && v.codigo === r.meet_code ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Pantalla: «Código de encuentro ${v ? v.codigo : '(no se ve)'}». Base: meet_code = ${r.meet_code}.`, nota: '' };
  });

  // --- T07 llamar
  await prueba('T07', pgA, 'tripulante', async () => {
    const tel = pgA.waitForEvent('request', r => r.url().startsWith('tel:'), { timeout: 6000 }).then(r => r.url(), () => null);
    await pgA.click('.rx-trip [data-ax=call]');
    const url = await tel;
    const cap = await foto(pgA, 'tripulante', 'llamar');
    const ok = url && soloDig(url).endsWith(soloDig(drv.phone)) && soloDig(drv.phone).length >= 10;
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Al tocar «Llamar» el teléfono abre ${url || '(nada)'}; celular de ${drv.full_name} en la base: ${drv.phone || '(vacío)'}.`,
      nota: 'El navegador headless no marca: se verifica la URL tel: que abre.' };
  });

  // --- T08 chat ida y vuelta
  await prueba('T08', pgA, 'tripulante', async () => {
    const ida = 'Hola, ya voy bajando';
    const vuelta = 'Listo, te espero en la portería';
    await pgA.click('.rx-trip [data-ax=chat]');
    await pgA.waitForSelector('#ax-chat-input', { state: 'visible', timeout: 8000 });
    await pgA.fill('#ax-chat-input', ida);
    await pgA.click('[data-ax=chat-send]');
    const m1 = await esperar(async () => q1(`SELECT sender_role, body, created_at FROM public.reservation_messages WHERE reservation_id = $1 AND body = $2`, [S(0).id, ida]), { timeout: 10000 });
    const capA = await foto(pgA, 'tripulante', 'chat-escribe');
    await pgA.click('[data-ax=chat-close]').catch(() => {});
    // El conductor ve el globo de su parada, abre el chat y responde.
    await pgD.click(`${EX} [data-rt=chat][data-rid="${S(0).id}"]`, { timeout: 15000 });
    const visto = await pgD.waitForFunction((t) => (document.getElementById('rt-thread')?.innerText || '').includes(t), ida, { timeout: 12000 }).then(() => true, () => false);
    await pgD.fill('#rt-chat-in', vuelta);
    await pgD.click(`${SH} [data-rt=send]`);
    const m2 = await esperar(async () => q1(`SELECT sender_role, body FROM public.reservation_messages WHERE reservation_id = $1 AND body = $2`, [S(0).id, vuelta]), { timeout: 10000 });
    await sleep(600);
    const capD = await foto(pgD, 'conductor', 'chat-responde');
    const telTrip = await pgD.$eval(`${EX} .rt-person a.rt-act[href^="tel:"]`, a => a.getAttribute('href')).catch(() => null);
    await pgD.click(`${SH} .rx-sheet-bg`, { position: { x: 20, y: 20 } }).catch(() => {}); await sleep(500);
    await pgA.click('.rx-trip [data-ax=chat]');
    const leyo = await pgA.waitForFunction((t) => document.body.innerText.includes(t), vuelta, { timeout: 15000 }).then(() => true, () => false);
    const capA2 = await foto(pgA, 'tripulante', 'chat-respuesta');
    await pgA.click('[data-ax=chat-close]').catch(() => {});
    const ok = m1 && m2 && visto && leyo;
    return { estado: ok ? 'OK' : 'FALLA', captura: capA2,
      obtenido: `Tripulante → «${ida}» (${m1 ? `guardado, sender_role ${m1.sender_role}` : 'NO guardado'}); el conductor lo ve: ${visto ? 'sí' : 'no'}. Conductor → «${vuelta}» (${m2 ? `guardado, ${m2.sender_role}` : 'NO guardado'}); el tripulante lo ve: ${leyo ? 'sí' : 'no'}. El conductor también tiene llamar: ${telTrip || '(sin botón)'} (celular del tripulante ${S(0).phone}).`,
      nota: `El aviso push del chat sale directo por la función send-push (no por la bandeja) y en local responde 401: no se puede verificar aquí. Otras capturas: ${capA}, ${capD}` };
  });

  // --- T05 por llegar (GPS del teléfono a < 300 m)
  await prueba('T05', pgA, 'tripulante', async () => {
    await gps(norte(S(0).lat, S(0).lng, -600)); await sleep(2500);
    const antes = (await avisos(S(0).profile_id, `trip:${S(0).id}:near`)).length;
    await gps(norte(S(0).lat, S(0).lng, -200));
    const a = await esperarAviso(S(0).profile_id, `trip:${S(0).id}:near`, 20000);
    const ping = await q1(`SELECT count(*)::int n, max(recorded_at) ult FROM public.driver_locations WHERE driver_profile_id = $1 AND source = 'gps' AND recorded_at >= $2`, [ra.driver_profile_id, T0]);
    await esperarTexto(pgA, /Ya casi|por llegar/i, 15000);
    const v = await leerViaje(pgA);
    const cap = await foto(pgA, 'tripulante', 'por-llegar');
    return { estado: a && antes === 0 ? 'OK' : 'FALLA', captura: cap,
      obtenido: `A 600 m: sin aviso (${antes} filas). A 200 m: ${fmtAviso(a)}. Pantalla: «${v.grande}» · «${v.etiqueta}». GPS del conductor en driver_locations desde que arrancó: ${ping.n} puntos (último ${hora(ping.ult)}).`,
      nota: 'GPS simulado con context.setGeolocation. Este camino es el del teléfono del conductor (driver_near_stop); el del servidor está en S02.' };
  });

  // --- C03 / T06 «Llegué»
  let codigoBueno = S(0).meet_code;
  await prueba('C03', pgD, 'conductor', async () => {
    await gps(norte(S(0).lat, S(0).lng, -20)); await sleep(1500);
    await pgD.click(`${EX} [data-rt=arrive]`);
    await pgD.waitForSelector(`${EX} .rt-code .rt-boxes input`, { timeout: 10000 });
    const a = await esperarAviso(S(0).profile_id, `trip:${S(0).id}:at_pickup`, 15000);
    const cap = await foto(pgD, 'conductor', 'llegue-codigo');
    const leg = await legActual(pgD);
    return { estado: a ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Bandeja de ${nom1(S(0))}: ${fmtAviso(a)}. Conductor: campo del código visible, botón «${leg.cta}» ${leg.ctaOff ? '(deshabilitado hasta escribirlo)' : ''}.`, nota: '' };
  });
  await prueba('T06', pgA, 'tripulante', async () => {
    const a = (await avisos(S(0).profile_id, `trip:${S(0).id}:at_pickup`))[0];
    const v = await esperar(async () => { const x = await leerViaje(pgA); return x.fase === 'arrived' || /Llegó/.test(x.grande) ? x : null; }, { timeout: 20000, cada: 1000 });
    await sleep(1500);
    const vv = await leerViaje(pgA);
    const cap = await foto(pgA, 'tripulante', 'llego');
    return { estado: a && v && vv.codigoLlego ? 'OK' : (a ? 'PARCIAL' : 'FALLA'), captura: cap,
      obtenido: `Bandeja: ${fmtAviso(a)}. Pantalla: fase «${vv.fase}», «${vv.grande}» · «${vv.etiqueta}», código ${vv.codigo} ${vv.codigoLlego ? 'resaltado' : 'sin resaltar'}, espera «${vv.espera || '—'}».`, nota: '' };
  });

  // --- C04 código equivocado
  await prueba('C04', pgD, 'conductor', async () => {
    const malo = String((Number(codigoBueno) + 37) % 100).padStart(2, '0');
    await pgD.fill(`${EX} .rt-code .rt-boxes input`, malo);
    const msg = await pgD.waitForFunction((ex) => /no es el código/i.test(document.querySelector(ex + ' .rt-code-m')?.innerText || ''), EX, { timeout: 10000 }).then(() => true, () => false);
    const texto = await pgD.$eval(`${EX} .rt-code-m`, e => e.innerText).catch(() => '');
    await sleep(1600);   // el campo se limpia solo a los 1,3 s (useRtCode del diseño)
    const cap = await foto(pgD, 'conductor', 'codigo-equivocado');
    const r = await reserva(S(0).id);
    const leg = await legActual(pgD);
    const ok = msg && r.status_h2a !== 'on_board' && !r.boarding_check && leg.nombre === S(0).full_name;
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Escribió ${malo} (el bueno es ${codigoBueno}): «${texto}». Sigue en la parada de ${leg.nombre}. Base: status_h2a = ${r.status_h2a}, boarding_check = ${r.boarding_check || 'NULL'}.`, nota: '' };
  });

  // --- C05 código correcto → a bordo → siguiente
  await prueba('C05', pgD, 'conductor', async () => {
    await pgD.fill(`${EX} .rt-code .rt-boxes input`, codigoBueno);
    const paso = stops.length > 1
      ? await pgD.waitForFunction(([ex, n]) => (document.querySelector(ex + ' .rt-person-tx > b')?.innerText || '').trim() === n, [EX, S(1).full_name], { timeout: 12000 }).then(() => true, () => false)
      : await pgD.waitForFunction((ex) => /aeropuerto/i.test(document.querySelector(ex + ' .rt-eb')?.innerText || ''), EX, { timeout: 12000 }).then(() => true, () => false);
    const todos = await toastsDe(pgD);
    const t = todos.find(x => /Código correcto|a bordo/.test(x)) || '';
    const cola = await pgD.evaluate(() => Object.keys(localStorage).filter(k => k.includes('rt-v2-cola')).map(k => localStorage.getItem(k)).join(' ')).catch(() => '');
    await sleep(1500);   // la escritura sale antes de pasar de parada; margen por si va en la cola
    const r = await reserva(S(0).id);
    const sig = stops.length > 1 ? await esperarAviso(S(1).profile_id, `trip:${S(1).id}:en_route`, 12000) : null;
    await sleep(800);
    const cap = await foto(pgD, 'conductor', 'codigo-correcto-siguiente');
    await mapaConductor(pgD, 'al pasar a la parada 2', cap);
    const leg = await legActual(pgD);
    const ok = paso && r.status_h2a === 'on_board' && r.boarding_check === 'codigo' && (stops.length < 2 || sig);
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Toast «${t}» (todos: ${todos.slice(-6).join(' | ')}; cola sin señal: ${cola || 'vacía'}). Base: ${nom1(S(0))} status_h2a = ${r.status_h2a}, boarding_check = ${r.boarding_check}, parada = ${r.stop_status}. Pantalla ahora: «${leg.chip}» ${leg.nombre}, botón «${leg.cta}».${stops.length > 1 ? ` Bandeja de ${nom1(S(1))}: ${fmtAviso(sig)}.` : ''}`, nota: '' };
  });

  // --- T10 (1/2) mapa a bordo con paradas por delante
  let mapa1 = null, capMapa1 = '';
  if (stops.length > 1) {
    const v = await esperar(async () => { const x = await leerViaje(pgA); return x.fase === 'onboard' && x.carro ? x : null; }, { timeout: 25000, cada: 1000 });
    await sleep(3500);
    await arriba(pgA);
    await sleep(500);
    mapa1 = await leerViaje(pgA);
    capMapa1 = await foto(pgA, 'tripulante', 'mapa-a-bordo-faltan');
    if (!v) mapa1.nota = 'no pasó a «A bordo» en 25 s';
  }

  // --- C19 la ubicación sigue al salir de Ejecución (barra «en curso»)
  if (stops.length > 1) {
    await prueba('C19', pgD, 'conductor', async () => {
      await pgD.click(`${EX} [data-rt=pop]`); await sleep(900);
      const barra = await pgD.waitForSelector('#driver-ruta-ui .rt-nowbar', { state: 'visible', timeout: 8000 }).then(() => true, () => false);
      const txt = barra ? await pgD.$eval('#driver-ruta-ui .rt-nowbar', e => e.innerText.replace(/\s+/g, ' ').trim()) : '';
      const t0 = await ahoraDb();
      await gps(norte(S(1).lat, S(1).lng, -900)); await sleep(7000);
      await gps(norte(S(1).lat, S(1).lng, -870)); await sleep(3000);
      const ping = await q1(`SELECT count(*)::int n FROM public.driver_locations WHERE driver_profile_id = $1 AND source = 'gps' AND recorded_at >= $2`, [ra.driver_profile_id, t0]);
      const cap = await foto(pgD, 'conductor', 'ruta-en-curso-barra');
      if (barra) await pgD.click('#driver-ruta-ui .rt-nowbar');
      await esExec(pgD).catch(() => {});
      const leg = await legActual(pgD);
      const ok = barra && /en curso/i.test(txt) && ping.n >= 1 && leg.nombre === S(1).full_name;
      return { estado: ok ? 'OK' : 'FALLA', captura: cap,
        obtenido: `Tras «Volver»: barra ${barra ? `«${txt}»` : 'NO aparece'}. Puntos GPS guardados mientras estaba fuera de Ejecución: ${ping.n}. Al tocar la barra: «${leg.chip}» ${leg.nombre}, botón «${leg.cta}».`, nota: '' };
    });
  } else corta('C19', 'la vuelta tiene una sola parada');

  // --- C07 recargar a mitad de ruta
  if (stops.length > 1) {
    await prueba('C07', pgD, 'conductor', async () => {
      // El «por llegar» de la parada 2 sale ANTES de recargar, para que lo que se
      // cuente después sea solo lo que la recarga pudiera repetir.
      await gps(norte(S(1).lat, S(1).lng, 150));
      await esperarAviso(S(1).profile_id, `trip:${S(1).id}:near`, 15000);
      await sleep(1500);
      const antes = await filasBandeja(tripIds);
      const claves = (await q(`SELECT dedupe_key FROM public.notification_outbox WHERE profile_id = ANY($1) AND created_at >= $2 ORDER BY created_at`, [tripIds, INICIO])).map(r => r.dedupe_key);
      await pgD.reload();
      await pgD.waitForFunction(() => document.getElementById('screen-login')?.classList.contains('hidden') && document.getElementById('app-shell') && !document.getElementById('app-shell').classList.contains('hidden'), null, { timeout: 25000 });
      await sleep(3000);
      const solo = await pgD.$(EX);
      const capRecarga = await foto(pgD, 'conductor', 'recarga-inicio');
      let como = solo ? 'la ruta se abrió sola' : '';
      if (!solo) {
        const b = await pgD.waitForSelector(`[data-vuelta-start="${ra.id}"]`, { state: 'visible', timeout: 15000 }).catch(() => null);
        const etiqueta = b ? (await b.innerText()).trim() : '';
        if (!b) throw new Error('tras recargar no aparece la vuelta en «Tu día»');
        await b.click();
        await esExec(pgD);
        como = `quedó en el inicio; con 1 toque en «${etiqueta}» volvió a la ruta`;
      }
      // El GPS vuelve a arrancar: se mueve 10 m para que el teléfono vuelva a
      // pedir «estoy cerca» (la base no debe repetirlo).
      let pidioCerca = 0;
      const oir = (r) => { if (/rpc\/driver_near_stop/.test(r.url())) pidioCerca++; };
      pgD.on('request', oir);
      await sleep(1500);
      await gps(norte(S(1).lat, S(1).lng, 140));
      await sleep(8000);
      pgD.off('request', oir);
      const leg = await legActual(pgD);
      const despues = await filasBandeja(tripIds);
      const r1 = await reserva(S(0).id);
      const cap = await foto(pgD, 'conductor', 'recarga-retoma');
      await mapaConductor(pgD, 'después de recargar', cap);
      const ok = leg.nombre === S(1).full_name && /Llegué/.test(leg.cta) && despues === antes && r1.status_h2a === 'on_board';
      return { estado: ok ? 'OK' : 'FALLA', captura: cap,
        obtenido: `Tras recargar ${como}. Pantalla: «${leg.chip}» ${leg.nombre}, botón «${leg.cta}». ${nom1(S(0))} sigue ${r1.status_h2a}. El teléfono volvió a pedir «estoy cerca» ${pidioCerca} vez/veces. Filas en la bandeja de los ${tripIds.length} tripulantes: ${antes} antes y ${despues} después (claves: ${claves.map(k => k.replace(/^trip:[0-9a-f-]+:/, '')).join(', ')}).`,
        nota: `El teléfono vuelve a pedir «estoy cerca» al recargar y la base no lo repite (dedupe). Otra captura: ${capRecarga}` };
    });
  } else corta('C07', 'la vuelta tiene una sola parada');

  // --- C06 «No tiene el código» en la parada 2
  if (stops.length > 1) {
    await prueba('C06', pgD, 'conductor', async () => {
      await gps(norte(S(1).lat, S(1).lng, 15)); await sleep(1200);
      await pgD.click(`${EX} [data-rt=arrive]`);
      await pgD.waitForSelector(`${EX} .rt-code-m [data-rt=nc]`, { state: 'visible', timeout: 10000 });
      const llego = await esperarAviso(S(1).profile_id, `trip:${S(1).id}:at_pickup`, 12000);
      await pgD.click(`${EX} .rt-code-m [data-rt=nc]`);
      await sleep(400);
      // Diseño v2: el 1er toque muestra la pista («Va a quedar registrado…») y el botón
      // principal pasa a «Subir a X sin código»; el 2º toque es ese botón.
      const armado = await pgD.$eval(`${EX} .rt-hint`, e => e.innerText.trim()).catch(() => '');
      const boton = await pgD.$eval(`${EX} .rt-cta [data-rt=board]`, e => e.innerText.trim()).catch(() => '');
      const r0 = await reserva(S(1).id);
      const capArm = await foto(pgD, 'conductor', 'sin-codigo-primer-toque');
      await pgD.click(`${EX} .rt-cta [data-rt=board]`);
      const sigNom = stops.length > 2 ? S(2).full_name : null;
      const paso = await pgD.waitForFunction(([ex, n]) => { const t = (document.querySelector(ex + ' .rt-person-tx > b')?.innerText || '').trim(); return n ? t === n : /aeropuerto/i.test(document.querySelector(ex + ' .rt-eb')?.innerText || ''); }, [EX, sigNom], { timeout: 12000 }).then(() => true, () => false);
      const r = await reserva(S(1).id);
      const t = (await toastsDe(pgD)).find(x => /sin código/.test(x)) || '';
      const cap = await foto(pgD, 'conductor', 'sin-codigo-a-bordo');
      const ok = /quedar registrado/i.test(armado) && /sin código/i.test(boton) && r0.status_h2a !== 'on_board' && paso && r.status_h2a === 'on_board' && r.boarding_check === 'sin_codigo';
      return { estado: ok ? 'OK' : 'FALLA', captura: cap,
        obtenido: `«Llegué» → ${fmtAviso(llego)}. 1er toque: «${armado}», botón «${boton}», base ${r0.status_h2a}. 2º toque: toast «${t}», base status_h2a = ${r.status_h2a}, boarding_check = ${r.boarding_check}; avanzó: ${paso ? 'sí' : 'no'}.`,
        nota: `Otra captura: ${capArm}` };
    });
  } else corta('C06', 'la vuelta tiene una sola parada');

  // --- S02 detector del servidor (< 400 m, sin el teléfono) en la última parada
  if (ultimo >= 2) {
    await prueba('S02', pgL, 'tripulante', async () => {
      const L = S(ultimo);
      const enRoute = await esperarAviso(L.profile_id, `trip:${L.id}:en_route`, 12000);
      const p = norte(L.lat, L.lng, 350);
      const ping = await gpsConPing(p);
      const antes = (await avisos(L.profile_id, `trip:${L.id}:near`)).length;
      const det = await q1(`SELECT public.detect_trip_reminders() AS r`);
      const a = await esperarAviso(L.profile_id, `trip:${L.id}:near`, 8000);
      await sleep(1500);
      const cap = await foto(pgL, 'tripulante', 'por-llegar-servidor');
      const ok = ping && antes === 0 && a;
      return { estado: ok ? 'OK' : 'FALLA', captura: cap,
        obtenido: `Parada de ${L.full_name} en camino (${fmtAviso(enRoute)}). GPS a ~350 m: ${ping ? `ping guardado ${hora(ping.recorded_at)}` : 'el teléfono NO guardó el ping'}; antes del detector ${antes} filas «near» (el teléfono no avisa a más de 300 m). detect_trip_reminders → «${det.r}». Bandeja: ${fmtAviso(a)}.`,
        nota: 'El cron del minuto también corre el detector; si se adelantó a la llamada manual, la fila es la misma (misma clave).' };
    });
  } else corta('S02', 'la vuelta tiene menos de 3 paradas');

  // --- C08 «No se presentó» tras la espera, en la última parada
  if (ultimo >= 2) {
    await prueba('C08', pgD, 'conductor', async () => {
      const L = S(ultimo);
      await gps(norte(L.lat, L.lng, 15)); await sleep(1200);
      await pgD.click(`${EX} [data-rt=arrive]`);
      const NS = `${EX} .rt-link.err[data-rt=noshow]`;
      await pgD.waitForSelector(NS, { state: 'visible', timeout: 10000 });
      const llego = await esperarAviso(L.profile_id, `trip:${L.id}:at_pickup`, 12000);
      await sleep(2500);
      const bloqueado = await pgD.$eval(NS, b => ({ off: b.disabled, txt: b.innerText.trim() }));
      const capEsp = await foto(pgD, 'conductor', 'espera-no-se-presento-bloqueado');
      let capTrip = '';
      if (pgL) { await sleep(1500); capTrip = await foto(pgL, 'tripulante', 'te-espera-cuenta'); }
      const espera = (await q1(`SELECT aux_wait_minutes FROM public.app_settings LIMIT 1`))?.aux_wait_minutes ?? 5;
      console.log(`    … esperando ${espera} min de espera pactada para «No se presentó»`);
      await pgD.waitForSelector(NS + ':not([disabled])', { timeout: (espera * 60 + 45) * 1000 });
      // C20: pide confirmación; «Seguir esperando» no marca nada.
      await pgD.click(NS);
      await pgD.waitForSelector(`${SH} [data-rt=noshow-yes]`, { timeout: 8000 });
      const hoja = (await pgD.$eval(`${SH} .rx-sh`, e => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''));
      const capHoja = await foto(pgD, 'conductor', 'confirmar-no-se-presento');
      await pgD.click(`${SH} [data-rt=sheet-close]`); await sleep(900);
      const r20 = await reserva(L.id); const sigue = (await legActual(pgD)).nombre;
      resultado('C20', /no se presentó\?/i.test(hoja) && r20.status_h2a !== 'no_show' && sigue === L.full_name ? 'OK' : 'FALLA',
        `Al tocar «No se presentó» sale la hoja: «${hoja.slice(0, 200)}». «Seguir esperando» la cierra: base status_h2a = ${r20.status_h2a}, sigue en la parada de ${sigue}.`, capHoja, '');
      await pgD.click(NS);
      await pgD.click(`${SH} [data-rt=noshow-yes]`);
      const a = await esperarAviso(L.profile_id, `trip:${L.id}:no_show`, 12000);
      const r = await reserva(L.id);
      await sleep(800);
      const cap = await foto(pgD, 'conductor', 'no-se-presento');
      let capL = '';
      if (pgL) { await esperarTexto(pgL, /no pudo recogerte|No pudimos/i, 15000); capL = await foto(pgL, 'tripulante', 'no-pudimos-recogerte'); }
      const ok = bloqueado.off && a && r.status_h2a === 'no_show';
      return { estado: ok ? 'OK' : 'FALLA', captura: cap,
        obtenido: `«Llegué» → ${fmtAviso(llego)}. A los segundos: botón «${bloqueado.txt}» ${bloqueado.off ? 'deshabilitado' : 'HABILITADO'}. Se habilitó al vencer los ${espera} min; tras tocarlo: base status_h2a = ${r.status_h2a}, parada ${r.stop_status}. Bandeja de ${nom1(L)}: ${fmtAviso(a)}.`,
        nota: `Otras capturas: ${[capEsp, capTrip, capL].filter(Boolean).join(', ')}` };
    });
  } else corta('C08', 'la vuelta tiene menos de 3 paradas');

  // --- T10 (2/2) mapa ya sin paradas, rumbo a MDE
  await prueba('T10', pgA, 'tripulante', async () => {
    await gps(norte(S(ultimo).lat, S(ultimo).lng, 300));
    const v2 = await esperar(async () => { const x = await leerViaje(pgA); return x.fase === 'onboard' && x.carro && !x.paradas.length ? x : null; }, { timeout: 25000, cada: 1000 });
    await sleep(3000);
    await arriba(pgA);
    await sleep(500);
    const m2 = await leerViaje(pgA);
    const cap2 = await foto(pgA, 'tripulante', 'mapa-directo-mde');
    const d = (m) => m ? `carro ${m.carro ? 'sí' : 'no'}, paradas [${m.paradas.join(', ') || 'ninguna'}], ícono de aeropuerto ${m.aeropuerto ? 'sí' : 'no'}, ícono de casa ${m.casa ? 'sí' : 'no'}, línea ${m.lineas.length ? m.lineas.map(l => l.punteada ? `recta punteada (${l.puntos} puntos)` : `vía real (${l.puntos} puntos)`).join(' + ') : 'NINGUNA'}, texto «${m.grande} · ${m.etiqueta}»` : 'no se pudo leer';
    const ok1 = !mapa1 || (mapa1.carro && mapa1.paradas.length >= 1 && mapa1.lineas.length);
    const est = mapa1 && mapa1.paradaEstilo;
    const sinForma = est && (est.fondo === 'rgba(0, 0, 0, 0)' || est.fondo === 'transparent') && !/50%|\d{2}px/.test(est.radio || '');
    const ok2 = v2 && m2.carro && m2.lineas.length && (m2.aeropuerto || m2.casa);
    // Rumbo a MDE el destino tiene que ser el avión, no la casita.
    const casitaEnMde = v2 && !m2.aeropuerto && m2.casa > 0;
    const punteada = [mapa1, m2].some(m => m && m.lineas.some(l => l.punteada));
    return { estado: ok1 && ok2 ? (sinForma || casitaEnMde ? 'PARCIAL' : 'OK') : 'FALLA', captura: capMapa1 || cap2,
      obtenido: `${mapa1 ? `A bordo con ${stops.length - 1} paradas por delante: ${d(mapa1)}. ` : ''}Sin paradas (rumbo a MDE): ${d(m2)}.${est ? ` Marcador de parada: clase ${est.clase}, ${est.ancho}×${est.alto} px, fondo ${est.fondo}, borde ${est.radio || '0'}${sinForma ? ' → se pinta como TEXTO SUELTO (sin círculo)' : ''}.` : ''}`,
      nota: `${casitaEnMde ? 'Hallazgo: ya sin paradas, rumbo al aeropuerto, el destino se pinta con la CASITA (rx-lf-pin) encima del aeropuerto: auxPlotDriver (rendio-turnos/auxiliar.js ~2492) mueve trackDestMk con setLatLng pero no le cambia el ícono, que se eligió al montar el mapa (auxDestIsApt). ' : ''}${sinForma ? 'Hallazgo: las paradas pendientes usan la clase .rx-lf-stop (rendio-turnos/auxiliar.js, auxPlotStops ~2534) y ninguna hoja de estilos la define (solo existe .ax-stop en styles.css:2563 para la piel vieja): salen como un número/★ suelto encima del mapa, y dos paradas en el mismo conjunto se montan («2★»). ' : ''}${punteada ? 'La línea quedó RECTA PUNTEADA: el servidor público de rutas (router.project-osrm.org) no respondió en ese momento. ' : 'La línea es la vía real de OSRM (servidor público). '}De los compañeros solo se muestra el número de parada y el sector. Otra captura: ${cap2}` };
  });

  // --- C09 «Auxiliares entregados» en MDE
  await prueba('C09', pgD, 'conductor', async () => {
    await gps({ latitude: 6.1715, longitude: -75.4270 }); await sleep(1500);
    let leg = await legActual(pgD);
    if (leg.ctaAct === 'arrive') { await pgD.click(`${EX} [data-rt=arrive]`); await sleep(800); }
    await pgD.waitForSelector(`${EX} .rt-cta [data-rt=finish]`, { timeout: 10000 });
    leg = await legActual(pgD);
    const capE = await foto(pgD, 'conductor', 'auxiliares-entregados');
    await pgD.click(`${EX} .rt-cta [data-rt=finish]`);
    const fin = await esperarTexto(pgD, /Vuelta completa/i, 12000);
    await sleep(1500);
    const cap = await foto(pgD, 'conductor', 'vuelta-completa');
    const filas = await q(`SELECT p.full_name, r.status_h2a, rs.status AS parada FROM public.route_stops rs JOIN public.reservations r ON r.id = rs.reservation_id
                             JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles p ON p.id = ap.profile_id
                            WHERE rs.route_assignment_id = $1 ORDER BY rs.stop_order`, [ra.id]);
    const aBordo = filas.filter((f, i) => i < (ultimo >= 2 ? ultimo : stops.length));
    const okEntrega = aBordo.every(f => f.status_h2a === 'delivered');
    const okNoShow = ultimo < 2 || filas[ultimo].status_h2a === 'no_show';
    const ra2 = await q1(`SELECT status FROM public.route_assignments WHERE id = $1`, [ra.id]);
    return { estado: fin && okEntrega && okNoShow ? 'OK' : 'FALLA', captura: capE,
      obtenido: `Botón en MDE: «${leg.cta}». Después: ${fin ? '«¡Vuelta completa!»' : 'NO terminó la vuelta'}. Base: ${filas.map(f => `${f.full_name.split(' ')[0]} ${f.status_h2a}/${f.parada}`).join(' · ')}. route_assignments.status = ${ra2.status}.`,
      nota: `Otra captura: ${cap}` };
  });
  if (pgA) { await sleep(6500); await foto(pgA, 'tripulante', 'en-el-aeropuerto'); }

  // --- S05 sin avisos repetidos
  await prueba('S05', null, 'sistema', async () => {
    const todos = Object.values(CUENTAS).map(c => c.id);
    const dup = await q(`SELECT dedupe_key, count(*)::int n FROM public.notification_outbox WHERE profile_id = ANY($1) AND created_at >= $2 AND dedupe_key IS NOT NULL GROUP BY dedupe_key HAVING count(*) > 1`, [todos, INICIO]);
    const filas = await q(`SELECT p.full_name, o.title, o.body, o.dedupe_key, o.created_at FROM public.notification_outbox o JOIN public.profiles p ON p.id = o.profile_id WHERE o.profile_id = ANY($1) AND o.created_at >= $2 ORDER BY o.created_at`, [tripIds, INICIO]);
    const cap = await fotoBandeja('bandeja-salida', `Avisos de la salida en la bandeja (${filas.length}, sin repetidos: ${dup.length ? 'NO' : 'sí'})`, filas.map(f => ({ ...f, para: f.full_name })));
    return { estado: dup.length ? 'FALLA' : 'OK', captura: cap,
      obtenido: `${filas.length} avisos de la salida en la bandeja, cada uno una vez: ${filas.map(f => `${f.full_name.split(' ')[0]} «${f.title}»`).join(' · ')}.${dup.length ? ` REPETIDOS: ${dup.map(d => `${d.dedupe_key} ×${d.n}`).join(', ')}` : ''}`,
      nota: 'Se cuentan las filas de la bandeja creadas durante esta corrida.' };
  });
  for (const c of [ctxD, ctxA, ctxL]) if (c) await c.close();
}

// ================================================================= LLEGADA (MDE → casa)
async function bloqueLlegada() {
  NUM = Math.max(NUM, RANGO.llegada);
  console.log('\n[llegada] MDE → casa');
  const ra = PLAN.filter(r => r.direction === 'airport_to_home' && r.driver_profile_id).sort((a, b) => b.stops.length - a.stops.length)[0];
  if (!ra || !ra.conductor) {
    for (const id of CAT.filter(c => c[1] === 'llegada').map(c => c[0])) resultado(id, 'NO PROBADO', 'No hay una llegada publicada con conductor para hoy (ver A01).', '', '');
    return;
  }
  const stops = ra.stops;
  const drv = ra.conductor;
  // Si el plan le tocó al conductor sin celular (pedro.local), se le pone uno válido
  // antes, como haría él en la ventana que se lo pide (eso ya lo prueba C01).
  if (!soloDig(drv.phone)) { await q(`UPDATE public.profiles SET phone = '3009990011' WHERE id = $1`, [drv.id]); drv.phone = '3009990011'; }
  const nom1 = (s) => (s.full_name || '').split(' ')[0];
  const A = stops[0], B = stops[1] || null;
  console.log(`  Vuelta ${hhmm(ra.planned_start_at)} · ${drv.full_name} · ${stops.map(s => `${s.orden}.${nom1(s)}`).join(', ')}`);
  const MDE = { latitude: 6.1715, longitude: -75.4270 };
  const ctxD = await contexto('movil', { latitude: MDE.latitude, longitude: MDE.longitude + 0.02, accuracy: 10 });
  const ctxA = await contexto('movil');
  const gps = async (p) => ctxD.setGeolocation({ latitude: p.latitude, longitude: p.longitude, accuracy: 10 });
  let pgD = null;
  const pgA = await entrar(ctxA, A.email, PASS, `tripulante-${nom1(A)}`);
  await saltarPresentacion(pgA);
  await abrirViaje(pgA, A.id).catch(() => {});

  // --- S03 / S04 recordatorios por hora de la llegada (reloj adelantado)
  await prueba('S03', pgA, 'tripulante', async () => {
    await q(`UPDATE public.route_assignments SET planned_start_at = now() + interval '9 minutes' WHERE id = $1`, [ra.id]);
    const pub = await q1(`SELECT calculated_pickup_at FROM public.reservations WHERE id = $1`, [A.id]);
    const det = await q1(`SELECT public.detect_trip_reminders() AS r`);
    const filas = [];
    for (const s of stops) filas.push([s, await esperarAviso(s.profile_id, `trip:${s.id}:remind:%`, 10000)]);
    await sleep(6500);
    const cap = await foto(pgA, 'tripulante', 'llegada-recordatorio');
    const ok = filas.every(([s, a]) => a && /sale de MDE/.test(a.title) && (!s.meet_code || a.body.includes(s.meet_code)));
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Salida de MDE adelantada a ${hhmm(pub.calculated_pickup_at)}. detect_trip_reminders → «${det.r}». ${filas.map(([s, a]) => `${nom1(s)}: ${fmtAviso(a)}`).join(' | ')}.`,
      nota: 'Reloj simulado: se adelantó por SQL route_assignments.planned_start_at a ahora+9 min.' };
  });
  await prueba('S04', null, 'sistema', async () => {
    const a = await esperarAviso(drv.id, `drv:${ra.id}:start:%`, 8000);
    const cap = a ? await fotoBandeja('bandeja-conductor', `Recordatorio a ${drv.full_name} antes de su vuelta`, [{ ...a, para: drv.full_name }]) : '';
    return { estado: a ? 'OK' : 'FALLA', captura: cap, obtenido: `Bandeja de ${drv.full_name}: ${fmtAviso(a)}.`, nota: 'Mismo detector y mismo reloj adelantado que S03.' };
  });

  // --- C10 «Llegué al aeropuerto» → filas
  let bloqueo = null;
  await prueba('C10', null, 'conductor', async () => {
    pgD = await entrar(ctxD, drv.email, PASS, `conductor-${drv.clave}`);
    const btn = `[data-vuelta-start="${ra.id}"]`;
    const hay = await pgD.waitForSelector(btn, { state: 'visible', timeout: 12000 }).then(() => true, () => false);
    const capDia = await foto(pgD, 'conductor', 'llegada-tu-dia');
    let camino = 'atajo «Iniciar ruta» de Tu día';
    if (hay) await pgD.click(btn);
    else {
      // Con otra vuelta antes sin terminar, el atajo es de esa: el conductor entra a
      // «Mi día» y abre la llegada desde «Más tarde» (Detalle › Iniciar ruta).
      const ver = await pgD.waitForSelector('[data-vuelta]', { state: 'visible', timeout: 10000 }).catch(() => null);
      if (!ver) { bloqueo = '«Tu día» no muestra la llegada'; throw new Error(bloqueo); }
      await ver.click();
      // Las tarjetas (la pantalla de carga también tiene título).
      await pgD.waitForSelector('#driver-ruta-ui .rt-hero, #driver-ruta-ui .rt-vc', { timeout: 15000 });
      // La hora vigente (S03 la adelantó a ahora+9 min).
      const ini = (await q1(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [ra.id])).planned_start_at;
      const tarjeta = await pgD.$(`#driver-ruta-ui .rt-vc:has-text("Llegada"):has-text("${hhmm(ini)}"), #driver-ruta-ui .rt-hero:has-text("Llegada"):has-text("${hhmm(ini)}") .rt-crew`);
      if (!tarjeta) { bloqueo = '«Mi día» no muestra la llegada publicada'; throw new Error(bloqueo); }
      await tarjeta.click();
      await pgD.waitForSelector('#driver-ruta-ui #rt-layers .rx-layer:last-child .rx-foot [data-rt=start]', { timeout: 10000 });
      await pgD.click('#driver-ruta-ui #rt-layers .rx-layer:last-child .rx-foot [data-rt=start]');
      camino = 'Mi día › Más tarde › Detalle › «Iniciar ruta» (el atajo de Tu día era de otra vuelta anterior sin terminar)';
    }
    await esExec(pgD);
    await sleep(1200);
    const leg0 = await legActual(pgD);
    const capIni = await foto(pgD, 'conductor', 'llegada-iniciada');
    await mapaConductor(pgD, 'al iniciar la llegada (aeropuerto)', capIni);
    // C16: el carro está a ~2 km de MDE (contexto del conductor): «Llegué al aeropuerto»
    // pide confirmar y «Avisar cuando llegue» NO le avisa a nadie.
    await gps({ latitude: MDE.latitude, longitude: MDE.longitude + 0.02 }); await sleep(1500);
    await pgD.click(`${EX} [data-rt=arrive]`);
    const hojaGps = await pgD.waitForSelector(`${SH} .rx-sh`, { timeout: 8000 }).then(() => pgD.$eval(`${SH} .rx-sh`, e => e.innerText.replace(/\s+/g, ' ').trim()), () => '');
    const capGps = await foto(pgD, 'conductor', 'llegue-aeropuerto-lejos');
    await pgD.click(`${SH} [data-rt=sheet-close]`).catch(() => {}); await sleep(2500);
    const avisosLejos = (await q(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key LIKE 'trip:%:apt_arrived' AND created_at >= $1 AND profile_id = ANY($2)`, [INICIO, stops.map(s => s.profile_id)]))[0].n;
    const sigueRumbo = (await legActual(pgD)).ctaAct === 'arrive';
    resultado('C16', /todavía no estás en MDE/i.test(hojaGps) && avisosLejos === 0 && sigueRumbo ? 'OK' : 'FALLA',
      `A ~2 km del aeropuerto, «Llegué al aeropuerto» abre: «${hojaGps.slice(0, 220)}». Tras «Avisar cuando llegue»: ${avisosLejos} avisos «llegó al aeropuerto» en la bandeja; la pantalla sigue rumbo a MDE: ${sigueRumbo ? 'sí' : 'no'}.`, capGps, '');
    await gps(MDE); await sleep(1500);
    await pgD.click(`${EX} [data-rt=arrive]`);
    await pgD.waitForSelector(`${EX} .rt-cr`, { timeout: 10000 });
    await sleep(800);
    const filas = await pgD.$$eval(`${EX} .rt-cr`, els => els.map(e => ({ nombre: e.querySelector('.rt-cl-tx > b')?.innerText.trim(), campo: !!e.querySelector('input[data-code]'), rid: e.dataset.row })));
    const leg = await legActual(pgD);
    const cap = await foto(pgD, 'conductor', 'aeropuerto-filas');
    const ok = filas.length === stops.length && filas.every(f => f.campo);
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `Entró por: ${camino}. Al iniciar: «${leg0.chip}», botón «${leg0.cta}». Tras «Llegué al aeropuerto»: ${filas.length} filas (${filas.map(f => `${f.nombre}${f.campo ? ' [campo de código]' : ' [SIN campo]'}`).join(', ')}); botón principal «${leg.cta}» ${leg.ctaOff ? 'deshabilitado' : 'habilitado'}.`,
      nota: `Otras capturas: ${capDia}, ${capIni}` };
  });
  if (bloqueo || !pgD) { ['T11', 'C11', 'C12', 'C13'].forEach(id => resultado(id, 'NO PROBADO', `No se llegó a este paso: ${bloqueo || 'no se pudo iniciar la llegada'}`, '', '')); for (const c of [ctxD, ctxA]) await c.close(); return; }

  // --- T11 «Te espera en MDE»
  await prueba('T11', pgA, 'tripulante', async () => {
    const filas = [];
    for (const s of stops) filas.push([s, await esperarAviso(s.profile_id, `trip:${s.id}:apt_arrived`, 12000)]);
    const v = await esperar(async () => { const x = await leerViaje(pgA); return x.fase === 'arrived' ? x : null; }, { timeout: 25000, cada: 1000 });
    await sleep(1500);
    const vv = await leerViaje(pgA);
    const cap = await foto(pgA, 'tripulante', 'te-espera-en-mde');
    const textoFase = await pgA.$eval('#ax-phase [data-ph=arrived]', e => e.innerText.trim()).catch(() => '');
    const ok = filas.every(([, a]) => a) && v;
    return { estado: ok ? 'OK' : (filas.every(([, a]) => a) ? 'PARCIAL' : 'FALLA'), captura: cap,
      obtenido: `${filas.map(([s, a]) => `${nom1(s)}: ${fmtAviso(a)}`).join(' | ')}. Pantalla de ${nom1(A)}: fase actual «${vv.fase}» («${textoFase}»), código ${vv.codigo || '(no se ve)'}${vv.codigoLlego ? ' resaltado' : ''}; arriba dice «${vv.texto.slice(0, 40)}»; carro en el mapa: ${vv.carro ? 'sí' : 'no'}.`,
      nota: vv.carro ? '' : 'Observación: con el conductor ya en MDE (la base guarda su ancla en el aeropuerto) el mapa del tripulante sigue «Sin ubicación todavía» y la píldora de arriba sigue en «Conductor asignado»: en llegadas el rastreo solo pinta el carro desde «A bordo» (auxTrackTick, rendio-turnos/auxiliar.js ~2300).' };
  });

  // --- C18 chat desde la lista del aeropuerto + aviso de mensaje + chat en el Detalle
  await prueba('C18', pgD, 'conductor', async () => {
    const urlsPush = [];
    const oir = (r) => { if (/functions\/v1\/send-push/.test(r.url())) { try { urlsPush.push(JSON.parse(r.postData() || '{}').url || ''); } catch (_) { /* */ } } };
    pgA.on('request', oir);
    await pgD.click(`${EX} .rt-cr[data-row="${A.id}"] [data-rt=chat]`);
    await pgD.waitForSelector('#rt-thread', { timeout: 8000 });
    const rapida = await pgD.$eval(`${SH} [data-rt=qr]`, e => e.innerText.trim());
    await pgD.click(`${SH} [data-rt=qr]`);
    const m1 = await esperar(async () => q1(`SELECT sender_role FROM public.reservation_messages WHERE reservation_id = $1 AND body = $2`, [A.id, rapida]), { timeout: 10000 });
    const capChat = await foto(pgD, 'conductor', 'chat-desde-aeropuerto');
    await pgD.click(`${SH} .rx-sheet-bg`, { position: { x: 20, y: 20 } }); await sleep(600);
    // A responde desde su app con el chat del conductor cerrado.
    const resp = 'Ya salí, estoy en la puerta 3';
    await pgA.click('.rx-trip [data-ax=chat]');
    await pgA.waitForSelector('#ax-chat-input', { state: 'visible', timeout: 8000 });
    await pgA.fill('#ax-chat-input', resp);
    await pgA.click('[data-ax=chat-send]');
    await sleep(1500);
    await pgA.click('[data-ax=chat-close]').catch(() => {});
    pgA.off('request', oir);
    const banner = await pgD.waitForFunction((t) => (document.querySelector('#driver-ruta-ui .rx-push')?.innerText || '').includes(t), resp, { timeout: 25000 }).then(() => true, () => false);
    const capBanner = await foto(pgD, 'conductor', 'aviso-mensaje');
    let abre = false;
    if (banner) {
      await pgD.click('#driver-ruta-ui .rx-push');
      abre = await pgD.waitForFunction((t) => (document.getElementById('rt-thread')?.innerText || '').includes(t), resp, { timeout: 10000 }).then(() => true, () => false);
      await pgD.click(`${SH} .rx-sheet-bg`, { position: { x: 20, y: 20 } }).catch(() => {}); await sleep(600);
    }
    // El Detalle de la vuelta: un chat por tripulante.
    await pgD.click(`${EX} [data-rt=pop]`); await sleep(900);
    await pgD.click('#driver-ruta-ui .rt-hero .rt-crew, #driver-ruta-ui .rt-vc[data-rt=detail]').catch(() => {});
    await pgD.waitForSelector('#driver-ruta-ui #rt-layers .rt-stops', { timeout: 8000 }).catch(() => {});
    const chatsDetalle = await pgD.$$eval('#driver-ruta-ui #rt-layers .rx-layer:last-child .rt-stop [data-rt=chat]', els => els.length).catch(() => 0);
    const capDet = await foto(pgD, 'conductor', 'detalle-chats');
    await pgD.click('#driver-ruta-ui #rt-layers .rx-layer:last-child .rx-foot .rx-btn');   // «Seguir ruta»
    await esExec(pgD);
    const urlOk = urlsPush.some(u => u.includes(`#/viaje?r=${A.id}`));
    const ok = m1 && m1.sender_role === 'driver' && banner && abre && chatsDetalle === stops.length && urlOk;
    return { estado: ok ? 'OK' : 'FALLA', captura: capBanner,
      obtenido: `Respuesta rápida «${rapida}» desde la fila de ${nom1(A)}: ${m1 ? `guardada (${m1.sender_role})` : 'NO guardada'}. ${nom1(A)} responde «${resp}»: aviso arriba en la ruta del conductor ${banner ? 'sí' : 'NO'}; al tocarlo abre el chat con el mensaje: ${abre ? 'sí' : 'no'}. Detalle: ${chatsDetalle} botones de chat para ${stops.length} tripulantes. URL del push de ${nom1(A)} al conductor: ${urlsPush.join(' | ') || '(no se vio la llamada a send-push)'}.`,
      nota: `El push real no llega a un navegador headless (y en local send-push responde 401): se verifica la URL que manda la app. El aviso de arriba sale del sondeo de mensajes sin leer (cada 15 s). Otras capturas: ${capChat}, ${capDet}` };
  });

  // --- C11 / C12 código correcto + «No llegó»; «Salir» solo con todos resueltos
  const estadosBoton = [];
  let capSalir = '';
  await prueba('C11', pgD, 'conductor', async () => {
    let leg = await legActual(pgD);
    estadosBoton.push(`${stops.length} pendientes: «${leg.cta}» ${leg.ctaOff ? 'deshabilitado' : 'HABILITADO'}`);
    await pgD.fill(`${EX} .rt-cr[data-row="${A.id}"] input[data-code]`, A.meet_code);
    await pgD.waitForSelector(`${EX} .rt-cr.done.ok[data-row="${A.id}"]`, { timeout: 12000 });
    await sleep(500);
    leg = await legActual(pgD);
    estadosBoton.push(`${stops.length - 1} pendiente: «${leg.cta}» ${leg.ctaOff ? 'deshabilitado' : 'HABILITADO'}`);
    const capUno = await foto(pgD, 'conductor', 'aeropuerto-uno-a-bordo');
    const rA = await reserva(A.id);
    let ns = null, rB = null, capNo = '';
    if (B) {
      await pgD.click(`${EX} [data-rt=ask][data-ask=notarrived][data-rid="${B.id}"]`);
      const armado = await pgD.$eval(`${EX} .rt-cr[data-row="${B.id}"] .rt-cr-ask`, e => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
      await pgD.click(`${EX} [data-rt=ask-yes][data-rid="${B.id}"]`);
      await pgD.waitForSelector(`${EX} .rt-cr.done.err[data-row="${B.id}"]`, { timeout: 12000 });
      ns = await esperarAviso(B.profile_id, `trip:${B.id}:apt_no_show`, 12000);
      rB = await reserva(B.id);
      if (ns) ns.armado = armado;
      await sleep(500);
      leg = await legActual(pgD);
      estadosBoton.push(`0 pendientes: «${leg.cta}» ${leg.ctaOff ? 'DESHABILITADO' : 'habilitado'}`);
      capNo = capSalir = await foto(pgD, 'conductor', 'aeropuerto-salir-habilitado');
      ns && (ns.pill = (await pgD.$eval(`${EX} .rt-x-pill`, e => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '')));
    }
    const ok = rA.status_a2h === 'picked_up' && rA.boarding_check === 'codigo' && (!B || (ns && rB.stop_status === 'no_show'));
    const pill = (ns && ns.pill) || '';
    const contadorViejo = /\b0\/\d/.test(pill);
    return { estado: ok ? 'OK' : 'FALLA', captura: capNo || capUno,
      obtenido: `${nom1(A)} con su código ${A.meet_code}: «✓ A bordo», base status_a2h = ${rA.status_a2h}, boarding_check = ${rA.boarding_check}.${B ? ` ${nom1(B)} «No llegó» (1er toque: «${ns && ns.armado}»): parada = ${rB.stop_status}; bandeja: ${fmtAviso(ns)}.` : ''}${pill ? ` Píldora de arriba: «${pill}».` : ''}`,
      nota: `${contadorViejo ? 'Detalle visual: con 1 a bordo la píldora de arriba sigue en «0/2» (cuenta las paradas ANTERIORES a la actual: drExecHTML, rendio-turnos/driver-rutas.js ~686). ' : ''}Otra captura: ${capUno}` };
  });
  // --- C17 «Deshacer» en la lista del aeropuerto (0102)
  await prueba('C17', pgD, 'conductor', async () => {
    if (!B) throw new NoProbado('la llegada tiene un solo tripulante');
    await pgD.click(`${EX} .rt-cr[data-row="${B.id}"] [data-rt=undo]`);
    await pgD.waitForSelector(`${EX} .rt-cr:not(.done)[data-row="${B.id}"]`, { timeout: 10000 });
    const rb = await reserva(B.id);
    const avUndo = await esperarAviso(B.profile_id, `trip:${B.id}:apt_undo`, 10000);
    await pgD.click(`${EX} .rt-cr[data-row="${A.id}"] [data-rt=undo]`);
    await pgD.waitForSelector(`${EX} .rt-cr:not(.done)[data-row="${A.id}"]`, { timeout: 10000 });
    const ra1 = await reserva(A.id);
    const cap = await foto(pgD, 'conductor', 'aeropuerto-deshacer');
    await pgD.fill(`${EX} .rt-cr[data-row="${A.id}"] input[data-code]`, A.meet_code);
    await pgD.waitForSelector(`${EX} .rt-cr.done.ok[data-row="${A.id}"]`, { timeout: 12000 });
    await pgD.click(`${EX} [data-rt=ask][data-ask=notarrived][data-rid="${B.id}"]`);
    await pgD.click(`${EX} [data-rt=ask-yes][data-rid="${B.id}"]`);
    await pgD.waitForSelector(`${EX} .rt-cr.done.err[data-row="${B.id}"]`, { timeout: 12000 });
    const ra2 = await reserva(A.id), rb2 = await reserva(B.id);
    const ok = rb.stop_status === 'arrived' && avUndo && ra1.stop_status === 'arrived' && ra1.status_a2h === 'driver_assigned' && !ra1.boarding_check && ra2.status_a2h === 'picked_up' && rb2.stop_status === 'no_show';
    return { estado: ok ? 'OK' : 'FALLA', captura: cap,
      obtenido: `«Deshacer» en ${nom1(B)} (no llegó): parada ${rb.stop_status}; bandeja: ${fmtAviso(avUndo)}. «Deshacer» en ${nom1(A)} (a bordo): parada ${ra1.stop_status}, status_a2h ${ra1.status_a2h}, boarding_check ${ra1.boarding_check || 'NULL'}. Resueltos de nuevo: ${nom1(A)} ${ra2.status_a2h}, ${nom1(B)} ${rb2.stop_status}.`, nota: '' };
  });
  await prueba('C12', pgD, 'conductor', async () => {
    const ok = estadosBoton.length >= 2 && estadosBoton.slice(0, -1).every(s => /deshabilitado/.test(s) && !/HABILITADO/.test(s)) && /habilitado/.test(estadosBoton[estadosBoton.length - 1]) && !/DESHABILITADO/.test(estadosBoton[estadosBoton.length - 1]);
    return { estado: ok ? 'OK' : 'FALLA', captura: capSalir, obtenido: estadosBoton.join(' → ') + '.', nota: '' };
  });

  // --- C13 entrega en casa
  await prueba('C13', pgD, 'conductor', async () => {
    await pgD.click(`${EX} .rt-cta [data-rt=leave]:not([disabled])`);
    await sleep(1200);
    let leg = await legActual(pgD);
    const primera = `${leg.chip} · ${leg.nombre} · «${leg.cta}»`;
    await gps({ latitude: A.lat, longitude: A.lng }); await sleep(1000);
    await pgD.click(`${EX} [data-rt=arrive]`);
    await pgD.waitForSelector(`${EX} .rt-cta [data-rt=drop]`, { timeout: 10000 });
    leg = await legActual(pgD);
    const capCasa = await foto(pgD, 'conductor', 'llegada-en-casa');
    await pgD.click(`${EX} .rt-cta [data-rt=drop]`);
    const fin = await esperarTexto(pgD, /Vuelta completa/i, 12000);
    const cap = await foto(pgD, 'conductor', 'llegada-completa');
    const rA = await reserva(A.id);
    const ok = leg.nombre === A.full_name && fin && rA.status_a2h === 'delivered';
    return { estado: ok ? 'OK' : 'FALLA', captura: capCasa,
      obtenido: `Tras salir del aeropuerto: ${primera}. En la casa: «${leg.cta}». Después: ${fin ? '«¡Vuelta completa!»' : 'NO terminó'}. Base: ${nom1(A)} status_a2h = ${rA.status_a2h}.${B ? ` La casa de ${nom1(B)} (no llegó) no aparece.` : ''}`,
      nota: `Otra captura: ${cap}` };
  });
  await sleep(6500);
  await foto(pgA, 'tripulante', 'llegada-en-casa');
  for (const c of [ctxD, ctxA]) await c.close();

  // --- A10 re-publicar con una vuelta a mitad no borra lo atendido
  await prueba('A10', null, 'admin', async () => {
    // La salida si la hubo (de noche no hay salidas de hoy); si no, la llegada recorrida.
    const sal = PLAN.find(r => r.direction === 'home_to_airport' && r.driver_profile_id && r.stops.length >= 2)
      || PLAN.find(r => r.direction === 'airport_to_home' && r.driver_profile_id && r.stops.length >= 2);
    if (!sal) throw new NoProbado('no hay una vuelta publicada con conductor y 2 o más paradas');
    // Escenario «a mitad»: la vuelta ya recorrida queda con su ÚLTIMA parada otra vez
    // pendiente (como si faltara atenderla); el resto sigue atendido.
    const paradas = await q(`SELECT id, reservation_id, status FROM public.route_stops WHERE route_assignment_id = $1 ORDER BY stop_order`, [sal.id]);
    if (paradas.length < 2) throw new NoProbado('la salida tiene una sola parada');
    await q(`UPDATE public.route_stops SET status = 'pending' WHERE id = $1`, [paradas[paradas.length - 1].id]);
    const antes = await q(`SELECT reservation_id, status FROM public.route_stops WHERE route_assignment_id = $1 ORDER BY stop_order`, [sal.id]);
    const plan = await q(`SELECT ra.id, ra.direction, ra.planned_start_at, ra.vehicle_id, dp.profile_id, array_agg(rs.reservation_id ORDER BY rs.stop_order) AS stops
                            FROM public.route_assignments ra JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
                            JOIN public.route_stops rs ON rs.route_assignment_id = ra.id
                           WHERE (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date = $1::date GROUP BY ra.id, dp.profile_id`, [DIA]);
    const lanes = plan.map(p => ({ driverProfileId: p.profile_id, vehicleId: p.vehicle_id, type: p.direction === 'airport_to_home' ? 'lle' : 'sal', startAt: new Date(p.planned_start_at).toISOString(), stops: p.stops, etas: {} }));
    const ctxJ = await contexto('admin');
    const pgJ = await entrar(ctxJ, CUENTAS.jefe.email, PASS, 'jefe-republica');
    await pgJ.waitForFunction(() => window.Api && Api.saveRoutePlan, null, { timeout: 15000 });
    const r = await pgJ.evaluate(async ([d, l]) => { try { const x = await Api.saveRoutePlan(d, l); return { saved: x.saved, skipped: x.skipped, kept: x.kept, failed: x.failed, failMsg: x.failMsg }; } catch (e) { return { error: e.message }; } }, [DIA, lanes]);
    await ctxJ.close();
    const sigue = await q1(`SELECT id, status FROM public.route_assignments WHERE id = $1`, [sal.id]);
    const despues = await q(`SELECT reservation_id, status FROM public.route_stops WHERE route_assignment_id = $1 ORDER BY stop_order`, [sal.id]);
    const dup = await q(`SELECT reservation_id, count(*)::int n FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                          WHERE (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date = $1::date GROUP BY reservation_id HAVING count(*) > 1`, [DIA]);
    const igual = antes.length === despues.length && antes.every((x, i) => despues[i] && despues[i].reservation_id === x.reservation_id && despues[i].status === x.status);
    const ok = !r.error && !r.failed && sigue && igual && !dup.length;
    return { estado: ok ? 'OK' : 'FALLA', captura: '',
      obtenido: `saveRoutePlan → ${r.error ? `ERROR ${r.error}` : `guardadas ${r.saved}, intactas ${r.kept}, fallas ${r.failed || 0}`}. La vuelta (${sal.direction === 'home_to_airport' ? 'salida' : 'llegada'}) ${sigue ? `sigue (id igual, ${sigue.status})` : 'DESAPARECIÓ'}. Paradas antes: ${antes.map(x => x.status).join(', ')} · después: ${despues.map(x => x.status).join(', ') || '(ninguna)'}. Duplicadas: ${dup.length}.`,
      nota: 'Escenario armado por SQL en la base local (la última parada de la salida vuelve a «pendiente»); la re-publicación es la misma llamada que hace Asignación al publicar.' };
  });
}

// ================================================================= PEDIDOS DEL JEFE (11-oct)
// Usuarios, horario del turno en la inspección, horas en «h y min», retención
// de fotos y «Mis horas». Los turnos que estas pantallas necesitan se siembran
// por SQL (datos de prueba, marcados «E2E») y se borran al terminar.
async function bloqueJefe() {
  NUM = Math.max(NUM, RANGO.jefe);
  console.log('\n[jefe] Usuarios, inspección, horas, ajustes y «Mis horas»');
  const ORG = (await q1(`SELECT organization_id FROM public.profiles WHERE id = $1`, [CUENTAS.jefe.id])).organization_id;
  const veh = await q(`SELECT id, internal_code, current_km FROM public.vehicles WHERE organization_id = $1 ORDER BY internal_code`, [ORG]);
  const vA = veh[1] || veh[0], vB = veh[2] || veh[0];
  const ayer = diaBog(new Date(Date.now() - 86400000));
  const kmA = vA.current_km || 40000, kmB = vB.current_km || 40000;
  await q(`DELETE FROM public.shifts WHERE notes = 'E2E prueba de horas'`);
  const shA = await q1(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, end_at, opening_km, closing_km, notes)
                        VALUES ($1, $2, $3, 'closed', $4, $5, $6, $7, 'E2E prueba de horas') RETURNING id`,
    [ORG, CUENTAS.diana.drv_id, vA.id, `${ayer}T05:02:00-05:00`, `${ayer}T14:15:00-05:00`, kmA, kmA + 85]);
  const insp = await q1(`INSERT INTO public.inspections (organization_id, shift_id, vehicle_id, driver_id, kind, odometer_km, checklist, has_damage, notes, performed_at)
                         VALUES ($1, $2, $3, $4, 'initial', $5, '{}'::jsonb, true, 'E2E: rayón en la puerta trasera derecha', $6) RETURNING id, review_status`,
    [ORG, shA.id, vA.id, CUENTAS.diana.drv_id, kmA, `${ayer}T05:09:00-05:00`]);
  const shB = await q1(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, opening_km, notes)
                        VALUES ($1, $2, $3, 'active', now() - interval '155 minutes', $4, 'E2E prueba de horas') RETURNING id, start_at`,
    [ORG, CUENTAS.carlos.drv_id, vB.id, kmB]);
  const datos = `Datos de prueba sembrados por SQL: turno cerrado de Diana ${ayer} 05:02–14:15 (9 h 13 min) en ${vA.internal_code} con inspección con novedad, y turno EN CURSO de Carlos desde hace 2 h 35 min en ${vB.internal_code}; se borran al terminar.`;
  const ctx = await contexto('admin');
  let pg = null;
  const irA = async (ws, mod) => { await irModulo(pg, ws, mod); await sleep(400); };
  try {
    pg = await entrar(ctx, CUENTAS.jefe.email, PASS, 'admin-jefe');
    const dialogos = [];
    pg.on('dialog', d => { dialogos.push(d.message()); d.accept().catch(() => {}); });
    await pg.waitForSelector('#adm-wstabs', { state: 'visible', timeout: 20000 });
    await sleep(1500);

    await prueba('A07', pg, 'admin', async () => {
      await irA('turnos', 'inspections');
      const sel = `[data-insp-open="${insp.id}"]`;
      const hay = await pg.waitForSelector(sel, { timeout: 15000 }).then(() => true, () => false);
      if (!hay) {
        const cap = await foto(pg, 'admin', 'inspecciones-cola');
        return { estado: 'FALLA', captura: cap, obtenido: `La inspección de prueba (review_status ${insp.review_status}) no aparece en la cola.`, nota: datos };
      }
      await pg.click(sel);
      await pg.waitForSelector('[data-insp-horario]', { timeout: 15000 });
      await sleep(900);
      const bloque = (await pg.$eval('[data-insp-horario]', e => e.innerText)).replace(/\s+/g, ' ').trim();
      await pg.$eval('[data-insp-horario]', e => e.scrollIntoView({ block: 'center' }));
      await sleep(400);
      const cap = await foto(pg, 'admin', 'inspeccion-horario-turno');
      const ok = /Inicio de turno/.test(bloque) && /5:02/.test(bloque) && /Fin de turno/.test(bloque) && /2:15|14:15/.test(bloque) && /9 h 13 min/.test(bloque) && /Inspección enviada/.test(bloque) && /5:09/.test(bloque);
      return { estado: ok ? 'OK' : 'FALLA', captura: cap, obtenido: `Bloque: «${bloque.slice(0, 420)}».`, nota: datos };
    });

    await prueba('A08', pg, 'admin', async () => {
      await irA('turnos', 'balance');
      await pg.waitForFunction(() => /Diana/.test(document.querySelector('[data-panel="balance"], #tab-balance, #balance-ui')?.innerText || document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      await sleep(1500);
      const txtBal = (await pg.evaluate(() => (document.querySelector('[data-panel="balance"]:not(.hidden), #tab-balance:not(.hidden)') || document.body).innerText)).replace(/\s+/g, ' ');
      const capBal = await foto(pg, 'admin', 'balance-horas');
      const diana = (txtBal.match(/Diana R[íi]os.{0,120}/) || [''])[0];
      await irA('turnos', 'shifts');
      await pg.waitForFunction(() => /Carlos/.test(document.getElementById('shifts-list')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
      await sleep(800);
      const txtAct = (await pg.$eval('#shifts-list', e => e.innerText).catch(() => '')).replace(/\s+/g, ' ');
      const capAct = await foto(pg, 'admin', 'turnos-activos-horas');
      const enBal = /9 h 13 min/.test(txtBal);
      const enAct = /2 h 3[4-9] min/.test(txtAct);
      const decimales = [...(txtBal + ' ' + txtAct).matchAll(/\b\d+[.,]\d+ ?h\b/g)].map(m => m[0]);
      return { estado: enBal && enAct && !decimales.length ? 'OK' : (enBal || enAct ? 'PARCIAL' : 'FALLA'), captura: capBal,
        obtenido: `Balance: «${diana.slice(0, 160) || txtBal.slice(0, 160)}» (9 h 13 min ${enBal ? 'sí' : 'NO'} aparece). Turnos activos: «${txtAct.slice(0, 200)}» (2 h 35 min ${enAct ? 'sí' : 'NO'}).${decimales.length ? ` Con decimales: ${decimales.join(', ')}.` : ' Sin horas con decimales.'}`,
        nota: `${datos} Otra captura: ${capAct}` };
    });

    await prueba('A09', pg, 'admin', async () => {
      await irA('turnos', 'settings');
      // El campo vive en la sección plegable «Fotos de inspección».
      const sec = 'details[data-secval="setting-photo-retention"]';
      await pg.waitForSelector(`${sec} > summary`, { timeout: 15000 });
      if (!(await pg.$eval(sec, d => d.open))) await pg.click(`${sec} > summary`);
      await pg.waitForSelector('#setting-photo-retention', { state: 'visible', timeout: 8000 });
      await sleep(800);
      const antes = await pg.$eval('#setting-photo-retention', e => ({ v: e.value, off: e.disabled }));
      const hint = (await pg.$eval('#setting-photo-retention-hint', e => e.innerText).catch(() => '')).replace(/\s+/g, ' ');
      const dbAntes = (await q1(`SELECT photo_retention_days FROM public.app_settings LIMIT 1`).catch(() => ({})))?.photo_retention_days;
      await pg.fill('#setting-photo-retention', '90');
      await pg.$eval('#setting-photo-retention', e => e.scrollIntoView({ block: 'center' }));
      await pg.click('#save-settings-btn');
      const g90 = await esperar(async () => (await q1(`SELECT photo_retention_days FROM public.app_settings LIMIT 1`)).photo_retention_days === 90, { timeout: 10000 });
      await sleep(600);
      const cap = await foto(pg, 'admin', 'ajustes-fotos-90');
      dialogos.length = 0;
      await pg.fill('#setting-photo-retention', String(dbAntes || 60));
      await pg.click('#save-settings-btn');
      const gBack = await esperar(async () => (await q1(`SELECT photo_retention_days FROM public.app_settings LIMIT 1`)).photo_retention_days === (dbAntes || 60), { timeout: 10000 });
      const conf = dialogos.find(d => /bajar/i.test(d)) || '';
      const ok = !antes.off && g90 && gBack && /bajar de 90/.test(conf);
      return { estado: ok ? 'OK' : 'FALLA', captura: cap,
        obtenido: `Campo «Días que se guardan las fotos de inspección» = ${antes.v}${antes.off ? ' (DESHABILITADO)' : ''}; ayuda: «${hint.slice(0, 140)}». Base antes ${dbAntes}. Guardar 90 → base ${g90 ? '90' : 'NO cambió'}. Volver a ${dbAntes || 60} → aviso «${conf.replace(/\s+/g, ' ').slice(0, 160)}» (aceptado) → base ${gBack ? dbAntes || 60 : 'NO volvió'}.`,
        nota: 'Se deja el valor como estaba. No prueba el borrado nocturno (purge-old-photos, 3:15 a. m.).' };
    });

    await prueba('A06', pg, 'admin', async () => {
      const nueva = NUEVA || await q1(`SELECT email FROM public.profiles WHERE email LIKE 'nueva.%@rendio.test' AND role = 'auxiliar' ORDER BY created_at DESC LIMIT 1`);
      if (!nueva) throw new NoProbado('No hay ninguna tripulante registrada por la prueba (T01) a la cual restablecerle la contraseña.');
      const perfil = await q1(`SELECT id, full_name FROM public.profiles WHERE email = $1`, [nueva.email]);
      await irA('turnos', 'usuarios');
      await pg.waitForSelector('#us-search', { state: 'visible', timeout: 15000 });
      await pg.fill('#us-search', nueva.email);
      const btn = `[data-us=act][data-act=clave][data-id="${perfil.id}"]`;
      await pg.waitForSelector(btn, { state: 'visible', timeout: 10000 });
      const capLista = await foto(pg, 'admin', 'usuarios-buscar');
      await pg.click(btn);
      await pg.waitForSelector('#usr-pw-modal [data-usr=pw]', { state: 'visible', timeout: 8000 });
      const nuevaClave = await pg.$eval('#usr-pw-modal [data-usr=pw]', e => e.value);
      const obliga = await pg.$eval('#usr-pw-modal [data-usr=force]', e => e.checked);
      const capModal = await foto(pg, 'admin', 'usuarios-restablecer');
      await pg.click('#usr-pw-modal [data-usr=save]');
      const listo = await esperarTexto(pg, /Pásale esta contraseña/, 10000);
      const capRes = await foto(pg, 'admin', 'usuarios-clave-lista');
      await pg.click('#usr-pw-modal [data-usr=cancel]').catch(() => {});
      const db1 = await q1(`SELECT must_change_password FROM public.profiles WHERE id = $1`, [perfil.id]);
      // Entrar con la nueva en otro teléfono.
      const ctxT = await contexto('movil');
      let entro = false, pide = '', capT = '';
      try {
        // Con «pedirle que la cambie», la app abre «Cambiar mi contraseña» ANTES de
        // entrar (el login queda detrás): se espera una cosa o la otra.
        const pt = await ctxT.newPage();
        vigilar(pt, 'tripulante-clave-nueva');
        await pt.goto(BASE + '/');
        await pt.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
        await pt.fill('#login-email', nueva.email);
        await pt.fill('#login-password', nuevaClave);
        await pt.click('#login-submit');
        await pt.waitForFunction(() => !!document.querySelector('#usr-mypw-modal') || document.getElementById('screen-login')?.classList.contains('hidden')
          || /incorrect|inválid|invalid/i.test(document.getElementById('login-error')?.innerText || ''), null, { timeout: 25000 });
        const errLogin = (await pt.$eval('#login-error', e => e.classList.contains('hidden') ? '' : e.innerText.trim()).catch(() => ''));
        entro = !errLogin;
        pide = await pt.waitForSelector('#usr-mypw-modal', { state: 'visible', timeout: 8000 }).then(() => pt.$eval('#usr-mypw-modal', e => e.innerText.replace(/\s+/g, ' ').slice(0, 140)), () => '');
        if (errLogin) pide = 'el login dice: ' + errLogin;
        capT = await foto(pt, 'tripulante', 'clave-temporal-pide-cambio', { sinSubir: true });
      } catch (e) { pide = 'no entró: ' + e.message.split('\n')[0]; }
      await ctxT.close();
      const ok = listo && db1.must_change_password === true && entro && /temporal|Cambiar mi contraseña/i.test(pide);
      return { estado: ok ? 'OK' : 'FALLA', captura: capRes,
        obtenido: `Usuarios › buscar ${nueva.email} › «Restablecer contraseña»: se generó una de ${nuevaClave.length} caracteres (no se copia aquí), «Pedirle que la cambie» ${obliga ? 'marcado' : 'sin marcar'}. Resultado: ${listo ? '«Pásale esta contraseña…»' : 'NO salió la pantalla de resultado'}; base must_change_password = ${db1.must_change_password}. Entrar con la nueva: ${entro ? 'entra' : 'NO entra'}; ${pide ? `la app pide cambiarla («${pide}»)` : 'NO pide cambiarla'}.`,
        nota: `Cuenta de prueba creada por T01. Otras capturas: ${[capLista, capModal, capT].filter(Boolean).join(', ')}` };
    });
  } finally {
    await ctx.close().catch(() => {});
  }

  await prueba('C14', null, 'conductor', async () => {
    const ctxD = await contexto('movil');
    try {
      const pd = await entrar(ctxD, CUENTAS.diana.email, PASS, 'conductor-diana-horas');
      await pd.waitForSelector('.dnav-btn[data-dtab=perfil]', { state: 'visible', timeout: 20000 });
      await pd.click('.dnav-btn[data-dtab=perfil]');
      const hay = await esperarTexto(pd, /Mis horas/i, 12000);
      await sleep(1200);
      const plano = (t) => String(t || '').replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\s+/g, ' ');
      const tarjeta = plano(await pd.evaluate(() => { const t = document.body.innerText; const i = t.search(/Mis horas/i); return i >= 0 ? t.slice(i, i + 200) : ''; }));
      await pd.$eval('#pf-horas-btn', e => e.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(400);
      const capP = await foto(pd, 'conductor', 'perfil-mis-horas');
      let vista = '';
      const abrir = await pd.$('#pf-horas-btn') || await pd.$('[data-dh=tarjeta]');
      if (abrir) { await abrir.click().catch(() => {}); await sleep(1200); vista = plano(await pd.evaluate(() => document.body.innerText)); }
      const cap = await foto(pd, 'conductor', 'mis-horas');
      const ok = hay && /9 h 13 min/i.test(tarjeta + ' ' + vista);
      const i = vista.search(/Mis horas/i);
      return { estado: ok ? 'OK' : (hay ? 'PARCIAL' : 'FALLA'), captura: cap,
        obtenido: `Perfil: «${tarjeta.slice(0, 180)}».${vista ? ` Al abrirla: «${vista.slice(Math.max(0, i), Math.max(0, i) + 260)}».` : ''} 9 h 13 min ${ok ? 'sí' : 'NO'} aparece.`,
        nota: `${datos} Otra captura: ${capP}` };
    } finally { await ctxD.close().catch(() => {}); }
  });

  await q(`DELETE FROM public.shifts WHERE id = ANY($1)`, [[shA.id, shB.id]]);
  await q(`UPDATE public.vehicles SET current_km = $2 WHERE id = $1`, [vA.id, kmA]);
}

// ================================================================= correr
const T_INI = Date.now();
try {
  if (BLOQUES.has('admin')) await bloqueAdmin();
  else PLAN = await planPublicado();
  if (BLOQUES.has('tripulante')) await bloqueTripulante();
  if (BLOQUES.has('celular')) await bloqueCelular();
  if (BLOQUES.has('salida')) await bloqueSalida();
  if (BLOQUES.has('llegada')) await bloqueLlegada();
  if (BLOQUES.has('jefe')) await bloqueJefe();
} catch (e) {
  console.error('\nLa corrida se cortó:', e);
} finally {
  if (MAPA_CONDUCTOR.length && !RES.has('C15')) {
    const malos = MAPA_CONDUCTOR.filter(m => !m.trazos || m.errores.length);
    resultado('C15', malos.length ? 'FALLA' : 'OK',
      MAPA_CONDUCTOR.map(m => `${m.momento}: ${m.trazos == null ? 'sin mapa' : `${m.trazos} trazos (línea + paradas)`}${m.yo ? ', con el punto de «estoy aquí»' : ''}${m.errores.length ? `; error: ${[...new Set(m.errores)].join(' / ')}` : ''}`).join(' · ') + '.',
      (malos[0] || MAPA_CONDUCTOR[0]).cap,
      malos.length ? 'Hallazgo: si un punto de GPS llega en los 80 ms entre crear el mapa (L.map sin vista, drExecMap) y el setTimeout que le pone la vista, drUpdateMe (rendio-turnos/driver-rutas.js ~856) hace Math.max(map.getZoom() → undefined, 15) = NaN y setView(NaN): Leaflet revienta («Attempted to load an infinite number of tiles») y la línea de la ruta ya no se dibuja («reading min» en drExecMap ~839). El mapa queda con calles pero sin ruta ni paradas hasta la siguiente parada. En un teléfono real el GPS llega cada segundo, así que pasa seguido. Pilas completas en corrida.json.' : '');
  }
  for (const [id, m] of Object.entries(META)) if (BLOQUES.has(m.bloque) && !RES.has(id)) resultado(id, 'NO PROBADO', 'La corrida se cortó antes de llegar aquí.', '', '');
  guardar();
  writeFileSync(join(OUT, 'corrida.json'), JSON.stringify({
    inicio: INICIO, fin: new Date().toISOString(), minutos: Math.round((Date.now() - T_INI) / 600) / 100, dia: DIA, bloques: [...BLOQUES],
    app: BASE, base: 'local 127.0.0.1:54322', plan: resumenPlan(), errores_js: ERRORES.slice(0, 200),
  }, null, 2));
  for (const c of CTX) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await db.end().catch(() => {});
  const filas = [...RES.values()];
  const cuenta = (e) => filas.filter(f => f.estado === e).length;
  console.log(`\n================ RESUMEN (${Math.round((Date.now() - T_INI) / 1000)} s) ================`);
  for (const f of filas.sort((a, b) => CAT.findIndex(c => c[0] === a.id) - CAT.findIndex(c => c[0] === b.id))) console.log(`${f.estado.padEnd(11)} ${f.id}  ${f.requerimiento.slice(0, 90)}`);
  console.log(`OK ${cuenta('OK')} · FALLA ${cuenta('FALLA')} · PARCIAL ${cuenta('PARCIAL')} · NO PROBADO ${cuenta('NO PROBADO')}`);
  const porTipo = ERRORES.reduce((a, e) => { a[e.tipo] = (a[e.tipo] || 0) + 1; return a; }, {});
  console.log(`Errores vistos en pantalla (detalle en corrida.json): ${Object.entries(porTipo).map(([k, v]) => `${k} ×${v}`).join(' · ') || 'ninguno'}`);
  for (const e of ERRORES.filter(x => x.tipo === 'pageerror')) console.log(`  ${e.hora} [${e.paso}] ${e.quien}: ${e.msg}`);
  console.log(`Capturas y resultados en ${OUT}`);
}
