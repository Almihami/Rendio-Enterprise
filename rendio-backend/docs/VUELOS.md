# Estado de vuelos (0099 + 0118) — Flightradar24

Cada 15 minutos la base revisa las **llegadas** de las reservas y le pregunta a Flightradar24 (FR24 API) por las que están por aterrizar. Guarda el estado en `flight_statuses`. Si la hora de una llegada se mueve 15 minutos o más, o el vuelo se desvía, avisa a los jefes de la organización y al conductor de la ruta publicada: «Vuelo AV9563 aterriza 14:35 (25 min tarde). Recogida sugerida 14:50».

**No mueve `required_arrival_at`.** Esa decisión es de un jefe. La idea es medir unas semanas qué tan exacta es la ETA (`flight_eta_report`, abajo) y después decidir si se automatiza algo.

La integración nace **apagada**: `app_settings.flight_api_enabled = false`. Sin el token, o con la bandera apagada, no consulta nada, no avisa nada y la app no pinta ningún estado.

## Por qué Flightradar24 y no AeroDataBox

En la prueba real del 14-oct, AeroDataBox no trajo el aterrizaje de **ningún** vuelo nacional en MDE (0 de 38; 0 de 56 al día siguiente). Flightradar24 sí lo trae. AeroDataBox queda apagado del todo y sin respaldo: los términos de FR24 prohíben mezclar o rellenar sus datos con los de otro proveedor.

## Cómo funciona con FR24

**FR24 no tiene horarios ni cancelaciones.** Un vuelo aparece en la API solo cuando el avión está transmitiendo. Eso tiene tres consecuencias:

- La hora «programada» es la de la **reserva**. En una llegada es la hora de aterrizaje que escribió el tripulante.
- El retraso es la ETA (o el aterrizaje real) menos esa hora.
- Si FR24 no encuentra el vuelo, queda «unknown» y el chip no pinta nada. Nunca se inventa un estado. El aviso «cancelado» ya no sale.

**Solo llegadas.** Las salidas no se consultan.

**Calendario de cada vuelo.** Lo decide la base en `flight_status_targets()`; la Edge Function solo pregunta lo que le toca a cada vuelo.

| Fase | Qué se pregunta | Cada cuánto | Costo por vuelo devuelto |
|---|---|---|---|
| Desde 2 h antes de la hora de la reserva hasta que despega | `flight-summary/light`: «¿ya despegó?» | 15 min. Si pasa la hora de la reserva sin despegar: 15 min la primera hora y 30 min hasta 3 h después. Ahí se rinde. | 1 |
| En el aire | `live/flight-positions/full`: la ETA | La primera en la vuelta siguiente al despegue. Después, cada 15 min si la ETA está a 60 min o menos, y cada hora si está más lejos. | 8 |
| La ETA ya llegó | `flight-summary/light` (por `fr24_id`): «¿ya aterrizó?» | 15 min, hasta que aterriza o se desvía | 1 |

- Si en vivo el vuelo ya no aparece, o está en tierra, la misma corrida lo confirma con un summary.
- No se pregunta si el tripulante ya está con el conductor (desembarcando, recogido o entregado) ni por las reservas de tierra.
- **Supuesto:** sin horario no hay forma de saber cuándo debería despegar el vuelo, porque el origen solo se conoce cuando el avión transmite. Por eso se empieza **2 h antes de la hora de aterrizaje de la reserva**.
  - Un nacional (≈1 h de vuelo) queda preguntado desde ~1 h antes de despegar.
  - Un vuelo largo ya va en el aire en la primera pregunta; no se pierde nada, solo se ve el despegue un poco tarde.
- Cada petición lleva hasta 15 números. Un mismo número se pide una sola vez aunque lo tengan dos organizaciones. Nunca se hacen más de 10 peticiones por minuto, ni más de 9 por corrida.

## Costo

**Plan Explorer:** US$9 al mes (+ IVA donde aplique). Incluye 30.000 créditos al mes (60.000 si se compra antes del 31-dic-2026), 10 peticiones por minuto y 20 resultados por respuesta. Uso comercial permitido. Precios confirmados en el portal de FR24 el 25-oct-2026.

**FR24 cobra por vuelo devuelto, no por petición.** Una respuesta vacía cuesta 1 crédito.

**Gasto con el calendario de arriba.** Son cifras de la simulación de `scripts/_verify-0118.mjs`, que corre el lector real contra el calendario real con vuelos falsos:

| Vuelo | Créditos |
|---|---|
| Nacional a tiempo | 20 |
| Nacional que sale 40 min tarde | 27 |
| Largo (3 h 15, tipo Miami) | 34 |
| Desviado | 19 |
| Nunca aparece | 0, más las respuestas vacías |
| **Promedio por llegada**, contando las respuestas vacías | **≈ 22** |

- Con 25 llegadas al día son **~16.600 créditos al mes**: el Explorer alcanza con margen.
- FR24 real puede costar algo más. Un avión que transmite mucho rato en tierra en el origen cuesta 1 crédito por vuelta. La primera semana hay que comparar con `/api/usage` (abajo).

**Si se acaban los créditos**, FR24 responde 402: la corrida se para, no se guarda nada y la respuesta de la función lo dice. No hay cobros sorpresa, pero los avisos se detienen hasta el mes siguiente o hasta recargar (≈ US$0,30 por 1.000 créditos).

## Términos de FR24 que tocan el código

- **No mezclar** con otro proveedor. Una fila que venía de otro proveedor se pisa entera (`flight_status_record`).
- **No guardar sus datos más de 30 días**, columna `raw` incluida. `purge_flight_statuses()` corre a diario (03:20 Bogotá, pg_cron `purge-flight-statuses`) y borra los vuelos de más de 28 días. También borra los avisos de vuelo de esa edad en `notification_outbox`, porque su texto trae horas de FR24. Nunca guarda más de 30 días, aunque alguien le pida más.
- Nada «flight-critical»: el aviso es una ayuda para el jefe, no una decisión automática.

## Pasos para encenderlo

1. **Suscribirse a FR24 API, plan Explorer.** Lo hace la profa. Después, crear el token en *Key management*. El token no va en el código ni en el chat. El sandbox tiene su propio token.

2. **Probar el token a mano**, antes de tocar la app, con un vuelo que esté llegando hoy. Primero se guarda el token en la terminal:
   ```bash
   read -s FR24_TOKEN
   ```
   ¿Ya despegó / aterrizó? (summary light, 1 crédito por vuelo; las horas en UTC, Bogotá + 5 h):
   ```bash
   curl -s "https://fr24api.flightradar24.com/api/flight-summary/light?flights=AV9563&flight_datetime_from=2026-11-02T00:00:00Z&flight_datetime_to=2026-11-02T23:59:59Z" -H "Accept: application/json" -H "Accept-Version: v1" -H "Authorization: Bearer $FR24_TOKEN"
   ```
   La ETA, mientras el avión va en el aire (live full, 8 créditos por vuelo):
   ```bash
   curl -s "https://fr24api.flightradar24.com/api/live/flight-positions/full?flights=AV9563" -H "Accept: application/json" -H "Accept-Version: v1" -H "Authorization: Bearer $FR24_TOKEN"
   ```
   Cuántos créditos se han gastado:
   ```bash
   curl -s "https://fr24api.flightradar24.com/api/usage?period=24h" -H "Accept-Version: v1" -H "Authorization: Bearer $FR24_TOKEN"
   ```

   **Lo primero que hay que confirmar es JetSmart.** Los tripulantes escriben `JA5116` (BOG→MDE). Hay que preguntar `flights=JA5116,J65116` en la misma petición y ver con cuál responde FR24.
   - Si solo responde `J65116`:
     ```sql
     update public.app_settings set flight_code_aliases = '{"JA": ["J6"]}' where id = 'singleton';
     ```
   - Si responde `JA5116`, no hay que hacer nada (el mapa nace vacío).
   - Para preguntar las dos siglas siempre: `'{"JA": ["JA","J6"]}'`. Se cobra por vuelo devuelto, así que casi no cuesta más.

   Confirmar también:
   - que `datetime_landed` llega en un nacional que ya aterrizó (lo que AeroDataBox no traía);
   - que `eta` viene en live;
   - que `dest_icao` es `SKRG`;
   - el formato de las horas (la especificación dice `2026-10-11T19:35:00Z`).

3. **Aplicar la migración `0118_vuelos_flightradar24.sql`** con `psql` y `--db-url`, como las demás. **Nunca `supabase db push`.** Necesita 0099 y 0107. La reversa está en `down_migrations/0118_vuelos_flightradar24.down.sql`: deja todo como en 0099 y borra lo que guardó FR24.

4. **Secretos de la Edge Function y despliegue:**
   ```bash
   supabase secrets set FLIGHT_PROVIDER=fr24 FR24_API_TOKEN=<el token> --project-ref <ref>
   ```
   ```bash
   supabase secrets unset FLIGHT_STATUS_MOCK AERODATABOX_API_KEY --project-ref <ref>
   ```
   ```bash
   supabase functions deploy flight-status --project-ref <ref>
   ```
   - `FLIGHT_PROVIDER` es `fr24` por defecto. `aerodatabox` se conserva en el código, pero está apagado.
   - `FR24_SANDBOX=1` usa el sandbox de FR24. Tiene datos FIJOS y token propio: sirve para probar token, headers y forma, no trae los vuelos de MDE. La ruta es `/api/sandbox/…`; hay que confirmarla en el portal la primera vez.
   - `FLIGHT_STATUS_MOCK=1` no llama a FR24. Cada reserva recibe un vuelo falso con la forma real (los fixtures de `functions/flight-status/fixtures/fr24-*.json`) que avanza con el reloj: despega 25 min tarde y aterriza 25 min después de la hora de la reserva. Se guarda con `source = 'mock'` y el chip dice «· prueba».
     - Sirve para probar la cadena en dev sin token: calendario, consulta, guardado y aviso.
     - **Hay que quitarlo antes de encender en producción.**

5. **La URL en Vault.** En dev ya están `flight_status_url` y `service_role_key`. En producción falta crear la URL:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/flight-status',
                              'flight_status_url', 'Edge Function de estado de vuelos (0099)');
   ```

6. **Encender:**
   ```sql
   update public.app_settings set flight_api_enabled = true where id = 'singleton';
   ```
   Para apagar, se pone en `false`. Eso corta todo: consultas, avisos y chips.

## Comprobar que anda

- `select public.poll_flight_status();` dice en texto lo que hizo:
  - `apagado…`
  - `sin vuelos por consultar`
  - `faltan secretos en Vault: …`
  - `disparado con N vuelos por consultar`
- `select flight_code, mode, ref_at from public.flight_status_targets();` muestra lo que toca preguntar ahora y cómo.
- Los últimos estados guardados:
  ```sql
  select flight_code, status, delay_min, departed_at, estimated_at, actual_at,
         provider_credits, fetched_at
    from public.flight_statuses order by fetched_at desc;
  ```
- Los logs de la función `flight-status`. Cada corrida trae `llamadas`, `creditos`, `guardados`, `avisos`, `errores` y `abortado`:
  - `HTTP 401`: el token no sirve.
  - `HTTP 402`: se acabaron los créditos.
  - `HTTP 429`: más de 10 peticiones por minuto.

## Medir antes de automatizar

Error de la ETA y retraso real de cada llegada que aterrizó. El error es la ETA que se tenía 60, 30 o 15 min antes del aterrizaje menos el aterrizaje real; positivo quiere decir que FR24 la daba más tarde:
```sql
select * from public.flight_eta_report();
```
El resumen:
```sql
select count(*) vuelos,
       round(avg(abs(eta_60_err_min)), 1) err_60,
       round(avg(abs(eta_30_err_min)), 1) err_30,
       round(avg(abs(eta_15_err_min)), 1) err_15,
       round(avg(creditos), 1) creditos_por_vuelo
  from public.flight_eta_report();
```
Créditos por día (los cargados a vuelos; las respuestas vacías solo salen en `/api/usage`):
```sql
select flight_date, count(*) vuelos, sum(provider_credits) creditos
  from public.flight_statuses where source = 'flightradar24'
 group by 1 order by 1;
```
Solo se ven 28 días hacia atrás (la purga). Para medir «unas semanas» hay que copiar el resumen cada semana.

## Lo que todavía no hace

- **No pinta el chip** en la pantalla del conductor ni en Asignación. El contrato está listo: `RendioVuelos.cargar / para / chip` en `rendio-turnos/vuelos-ui.js`.
  - Ojo: `driver-rutas.js` llama `RendioVuelos.describir`, que `vuelos-ui.js` no exporta, así que hoy nunca pinta nada ahí.
  - Con FR24 el chip dice «programado 14:10» cuando el avión está en tierra en el origen. Esa hora es la de la reserva, no un horario de la aerolínea.
  - El detalle del chip todavía no nombra a Flightradar24 como fuente. Hay que revisar en los términos si piden atribución cuando se muestran sus datos.
- No avisa de las salidas: ya no se consultan.
- No crea una eventualidad: el aviso va directo a la bandeja de avisos.
- **Un vuelo que nunca aparece no avisa.** Puede ser un número mal escrito, un JetSmart sin alias o un vuelo que no salió del origen. Se queda «unknown» y el jefe no se entera por aquí.
