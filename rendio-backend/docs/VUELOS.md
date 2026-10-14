# Estado de vuelos (0099) — cómo encenderlo

Cada 15 min la base pregunta por los vuelos de las reservas de hoy y mañana que pasan en las próximas 12 h (AeroDataBox, vía RapidAPI). Guarda el estado en `flight_statuses`. Si una **llegada** se mueve 15 min o más (o se cancela o se desvía), les avisa a los jefes de la organización y al conductor de la ruta publicada: «Vuelo AV9563 aterriza 14:35 (25 min tarde). Recogida sugerida 14:50». **No mueve `required_arrival_at`**: esa decisión es de un jefe. En Reservas (admin) cada vuelo muestra su chip de estado.

Nace **apagada** (`app_settings.flight_api_enabled = false`). Sin la llave, o con la bandera apagada, no consulta nada, no avisa nada y la app no pinta ningún estado.

## ¿AeroDataBox cubre MDE / SKRG?

- El aeropuerto está en su base: tiene página propia, [aerodatabox.com/airports/SKRG](https://aerodatabox.com/airports/SKRG) (Rionegro José María Córdova, MDE).
- Su [página de cobertura](https://aerodatabox.com/data-coverage) (actualizada el 3-jun-2026) solo da cifras por país. **Colombia: 97 % de horarios y 45 % de estado en vivo**, sin ADS-B propio. No publica la cifra de SKRG.
- O sea: el horario programado casi seguro llega. **La hora estimada en vivo no está garantizada.** Si un vuelo viene sin dato en vivo, el chip dice «programado 14:10» y no sale ningún aviso. No se inventa un retraso.
- **Lo primero que hay que hacer con la llave:** `GET /health/services/airports/SKRG/feeds` (estado de las fuentes del aeropuerto). Después, consultar un vuelo real del día y ver si trae `revisedTime`.

## Pasos (los hace la dueña)

1. **Crear la cuenta en RapidAPI** y suscribirse a AeroDataBox: [rapid.aerodatabox.com](https://rapid.aerodatabox.com/).
2. **Elegir plan.** Precios de [aerodatabox.com/pricing](https://aerodatabox.com/pricing), consultados el 11-oct-2026, planes de RapidAPI:

   | Plan | USD/mes | Unidades/mes | Límite |
   |---|---|---|---|
   | Basic | 0 | 400 | 1 consulta/s, 1.000/h |
   | Pro | 8 | 5.000 | 2/s |
   | Ultra | 40 | 50.000 | 4/s |
   | Mega | 200 | 500.000 | 8/s (+USD 0,0004 por unidad extra) |

   - **Cada consulta de estado de vuelo cuesta 2 unidades** (es un endpoint *Tier 2*).
   - Cuando se acaba la cuota, RapidAPI rechaza las consultas hasta el mes siguiente; solo el plan Mega cobra el excedente. No hay cobros sorpresa, pero los avisos se detienen.
   - El 7-sep-2026 AeroDataBox [ajustó precios y cupos](https://aerodatabox.com/2026-09-terms-update) para los suscriptores nuevos. Hay que confirmar la cifra en el momento de suscribirse.
   - **Gasto estimado:**
     - Cada vuelo se consulta cada 2 h mientras falte más de 3 h, y cada 20–30 min en las últimas 3 h. Se deja de consultar cuando aterriza, despega o se cancela.
     - Eso da unas 11 consultas, unas **22 unidades por vuelo distinto al día**.
     - Con 15 vuelos al día son unas 10.000 unidades/mes: **plan Ultra**.
     - El Pro alcanza para unos 7 vuelos al día. El Basic sirve solo para la primera prueba.
3. **Guardar la llave en la Edge Function.** No va en el código ni en el chat:
   ```bash
   supabase secrets set AERODATABOX_API_KEY=<la llave de RapidAPI> --project-ref <ref>
   supabase functions deploy flight-status --project-ref <ref>
   ```
   Con `FLIGHT_STATUS_MOCK=1` la función no llama al proveedor. Usa la respuesta de ejemplo de `functions/flight-status/fixtures/`, corrida a la hora de cada reserva, siempre con 25 min de retraso. Sirve para probar la cadena en dev sin llave. El chip lo marca «· prueba». **Hay que quitarla antes de encender en producción.**
4. **Aplicar la migración `0099_vuelos.sql`**, igual que las demás. La reversa está en `down_migrations/0099_vuelos.down.sql`.
5. **Cargar la URL en Vault.** El secreto `service_role_key` ya existe si `dispatch-notifications` funciona: es el mismo.
   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/flight-status',
                              'flight_status_url', 'Edge Function de estado de vuelos (0099)');
   ```
6. **Encender:**
   ```sql
   update public.app_settings set flight_api_enabled = true where id = 'singleton';
   ```
   Para apagar, `false`. Corta todo: consultas, avisos y chips.

## Comprobar que anda

- `select public.poll_flight_status();` dice en texto lo que hizo:
  - `apagado…`
  - `sin vuelos por consultar`
  - `faltan secretos en Vault: …`
  - `disparado con N vuelos por consultar`
- `select * from public.flight_status_targets();` lista lo que toca consultar ahora.
- `select flight_code, status, delay_min, fetched_at from public.flight_statuses order by fetched_at desc;`
- Logs de la función `flight-status`. La respuesta trae `llamadas`, `guardados`, `avisos` y `abortado`:
  - `HTTP 401/403`: la llave o la suscripción.
  - `HTTP 429`: se acabó la cuota.

## Lo que todavía no hace

- No pinta el chip en la pantalla del conductor ni en Asignación. El contrato está listo: `RendioVuelos.cargar / para / chip` (`rendio-turnos/vuelos-ui.js`).
- No crea una eventualidad: el aviso va directo a la bandeja de avisos.
- No avisa de las salidas retrasadas: solo se guardan y se ven en el chip.
- El formato exacto de las horas del proveedor sale de la especificación oficial y de la forma conocida («2026-10-11 19:10Z»). La primera llamada real tiene que confirmarlo; el parser acepta también la forma ISO.
