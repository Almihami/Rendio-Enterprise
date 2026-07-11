# Rutas de auxiliares — Consola + Asignación (rama `feat/rutas-modular`)

> **2026-07-10 — PORTEADO a la estructura modular** (app.js ya no existe). El código
> vive ahora en 3 módulos propios: `admin-consola.js` (sidebar + hub), `admin-rutas.js`
> (asignación + asignador real) y `admin-operacion.js` (operación en vivo). Los hooks
> de `setTab`/`enterApp` están en `core.js`; el badge de aceite "!" se integró al
> sidebar (Ajustes). SW v74. La rama vieja `feat/rutas-consola` queda como referencia.


Implementación de la **gestión de rutas de auxiliares** en la PWA `rendio-turnos`,
a partir de los previews del UX (`Rendio Admin - Consola.html` / `Rendio Admin - Asignacion.html`).

## Qué se implementó (frontend, todo en `rendio-turnos`)

1. **Consola** (tab nuevo `consola`, es la nueva landing del admin) — hub de navegación
   "por capas": switcher de espacio de trabajo **Turnos / Rutas**, módulos agrupados
   (Planeación / Revisión / Equipo / Análisis / Operación) en cards. Las cards de Turnos
   navegan a los módulos existentes; las de Rutas a Asignación (las demás: "Por construir").
2. **Asignación** (tab nuevo `routes`) — la pieza central. Pool de auxiliares "sin rutear",
   carriles por carro, botón **Optimizar**, **semáforo de holgura vs. hora de presentación**
   (a tiempo / ajustado / **no llega**), drag & drop, capacidad x/4, y **drawer de asignar
   conductor** con estado "ruta en borrador · sin conductor" (el conductor se asigna al final).

### Archivos tocados
- `index.html` — sprite de iconos (rutas/consola) + 2 tabs (`consola`, `routes`) + 2 `<section>`.
- `styles.css` — bloques scopeados `#consola-ui` y `#routes-ui` (tokens del UX: Hanken Grotesk,
  naranja `#E2551A`, etc.). Sin `:root`, igual que el resto del repo (sin colisión global).
- `app.js` — `renderConsola()` + `renderRoutes()` (+ optimizador, drag&drop, drawer) dentro del
  IIFE; hooks en `setTab()`; landing del admin cambiado a `consola`.
- `api.js` — `listRoutePlanning(tripType)` (lee reservas reales; si no hay → `null`) y
  `saveRouteAssignment(...)`, expuestos en `window.Api`.
- `sw.js` — `CACHE_VERSION` v62 → **v63**.

### Backend (repo aparte `rendio-backend`, **NO aplicado a remoto**)
- `supabase/migrations/0040_routes_planning.sql` (+ `down_migrations/0040_*.down.sql`):
  `route_assignments.driver_profile_id`/`vehicle_id` NULLABLE + estado `draft`; quita el tope
  `route_stops.stop_order ≤ 4`; `reservations.flight_id` NULLABLE; params de ruteo en `app_settings`.

## Estado / verificado en local (2026-06-28)
Servido con `python3 -m http.server` y probado en navegador (sin login, forzando vista admin):
- ✓ Tabs nuevos, Consola (ambos workspaces, navegación card→módulo), Asignación.
- ✓ Optimizar → semáforo correcto (RD-01 "no llega" en rojo, RD-02 "a tiempo" en verde).
- ✓ Drawer de conductor (borrador). Sin errores de consola JS.
- Como en dev **no hay reservas sembradas**, la pantalla usa **datos de ejemplo** (fallback).
  `listRoutePlanning` intenta leer reservas reales y, al no haber, cae a demo automáticamente.

## Cómo correr en local
```bash
cd rendio-turnos
python3 -m http.server 8077 --bind 127.0.0.1
# abrir http://127.0.0.1:8077  (login con un usuario admin real para ver el admin)
```

## Pendiente (siguiente iteración)
1. **Aplicar la migración 0040** a Supabase dev (requiere OK de la profa). Sin ella no se pueden
   guardar rutas en borrador (driver NULL) ni paradas > 4.
2. **Datos reales**: sembrar reservas/vuelos de prueba en dev para ver el tablero con datos vivos.
3. **Solver real**: hoy el "tramo" (minutos por parada) es un estimado fijo. Falta estimar tiempos
   con OSRM/heurística y un orden óptimo (VROOM) — Fase 1 puede ir con buffers, sin tráfico en vivo.
4. **route_stops**: `saveRouteAssignment` crea la cabecera; falta persistir las paradas (necesitan
   `reservation_id` real por parada).
5. **Operación / Monitoreo en vivo** y **Métricas**: marcados "Por construir" en la Consola.
6. **Llegadas (a2h)**: el tablero ya alterna Salidas/Llegadas; falta el flujo a2h completo.

## Modelo de tiempos v2 (2026-07-10) — honesto y parametrizable

El modelo v1 solo sumaba manejo a flujo libre → rutas "de 10 minutos" imposibles.
El v2 calcula: **tiempo real de manejo (OSRM) × factor de tráfico + tiempo de
servicio por parada + colchón de entrega en aeropuerto**.

| Parámetro | Default | Clave en app_settings | Qué cubre |
|---|---|---|---|
| Factor de tráfico | ×1.25 | `route_traffic_factor` | OSRM da flujo libre; esto aterriza (madrugada, lluvia, tráfico) |
| Servicio por parada | 4 min | `route_service_min` | Frenar, timbrar, subir gente y maletas |
| Colchón de entrega | 10 min | `route_airport_buffer_min` | Bajar maletas + entrar; llegar "justo" ES tarde |

- El semáforo (holgura) compara `llegada + colchón` contra la hora de presentación.
- **Salida recomendada**: cada carril muestra "sal máx HH:MM" — lo más tarde que
  puede arrancar el carro y aún entregar con colchón (la palanca del despachador).
- Chip "ETAs" en el tablero: dice si los tiempos vienen de **OSRM** (carretera real)
  o son **estimados** (haversine 30 km/h ×1.4) — sin conexión se degrada avisando.
- Sin tráfico EN VIVO todavía: eso es la fase de APIs de pago (Google/TomTom) y el
  factor ×1.25 es el sustituto conservador mientras tanto.
