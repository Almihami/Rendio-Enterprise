# rendio-turnos

Módulo web para gestionar la disponibilidad de los conductores y generar el horario semanal de turnos por jornadas (Mañana / Tarde).

- **Conductores** inician sesión y registran su disponibilidad AM/PM día por día.
- **Admins** consolidan la disponibilidad, generan el horario con un algoritmo balanceado, lo ajustan a mano y lo publican.
- Stack: HTML + Tailwind (CDN) + JavaScript vanilla + `@supabase/supabase-js` (CDN). Sin build step → deploy directo en Vercel.

---

## Estructura

```
rendio-turnos/
├── index.html             # Login + shells de admin/conductor
├── config.js              # SUPABASE_URL + ANON_KEY (público por diseño)
├── supabase-client.js     # crea window.sb
├── api.js                 # wrappers de queries a Supabase
├── scheduler.js           # algoritmo de asignación AM/PM
├── app.js                 # controlador + routing por rol
├── styles.css             # estilos + reglas de impresión
├── vercel.json            # configuración mínima de deploy
└── README.md
```

---

## Backend dependencies

Este módulo depende del proyecto Supabase `rendio-dev`. Antes de usarlo:

1. **Aplicar la migration 0008** que añade las tablas:
   - `driver_availability` (una fila por conductor / semana / día con `am_state` + `pm_state`)
   - `weekly_schedules` (snapshot JSONB del horario publicado por semana)
   - `app_settings` (singleton con cupos y etiquetas de jornada)

   ```bash
   cd ../rendio-backend
   set -a; source ../.env.local.dev; set +a
   supabase db push
   ```

2. **Crear los usuarios** (2 admins + 7 conductores) con el seed script:

   ```bash
   cd ../rendio-backend/scripts
   npm install
   set -a; source ../../.env.local.dev; set +a
   node seed-turnos-users.mjs
   ```

   Edita primero `seed-turnos-users.json` para ajustar nombres, correos y contraseña por defecto. La contraseña inicial es la misma para todos; cada usuario debería cambiarla luego.

3. **(Opcional) Activar el Custom Access Token Hook** en el Dashboard de Supabase (Auth → Hooks). Mejora el rendimiento del RLS, pero todo funciona sin él porque los helpers tienen fallback.

---

## Flujo de uso semanal

1. **Sábado o domingo** — el admin avisa al equipo: "actualicen su disponibilidad para la próxima semana".
2. Cada **conductor** entra al módulo desde su navegador, va a la semana siguiente con las flechas, y marca sus celdas AM/PM (Disponible / Prefiere descanso / No disponible). Guarda.
3. El **admin** entra, va a la pestaña **Horario**, elige la semana, presiona **Generar horario**.
4. El generador balancea los turnos respetando las disponibilidades. Si faltan cupos muestra advertencias.
5. El admin ajusta manualmente las celdas que quiera (clic sobre cada nombre).
6. **Publicar** marca el horario como visible para los conductores. **Guardar** lo persiste como borrador.
7. Los conductores ven el horario publicado al pie de su vista, con su propio nombre resaltado en verde.

---

## Reglas del generador

- 2 cupos Mañana + 2 cupos Tarde por día (configurables en *Ajustes*).
- Cada conductor hace máximo un turno por día (no puede estar en Mañana **y** Tarde el mismo día).
- Excluye a quien marca `unavailable` en esa jornada.
- Prefiere a quien marca `available` sobre `prefer_rest`.
- A igualdad, prioriza al de menor carga acumulada en la semana.
- Quien no entra a ningún turno queda en *Descanso*.

---

## RLS aplicado

| Tabla                  | Conductor        | Admin                    |
|------------------------|------------------|--------------------------|
| `driver_availability`  | Solo la propia   | Lee/escribe todo         |
| `weekly_schedules`     | Solo lectura     | Lee/escribe todo         |
| `app_settings`         | Solo lectura     | Lee/escribe              |
| `profiles`             | Solo el propio   | Todos (policy existente) |

---

## Deploy en Vercel

1. Sube el proyecto a GitHub (incluyendo esta carpeta).
2. En Vercel → *New Project* → importa el repo.
3. En *Project Settings → General → Root Directory* selecciona `rendio-turnos`.
4. Framework Preset: **Other** (estático).
5. Build Command: (vacío). Output Directory: `.` (la raíz de `rendio-turnos`).
6. Deploy.

El `SUPABASE_ANON_KEY` y el `SUPABASE_URL` están en `config.js`. El anon key es público por diseño (RLS protege los datos); no necesitas variables de entorno para esto.

> **Importante:** asegúrate de que en Supabase → *Auth → URL Configuration* esté añadido el dominio de Vercel como **Site URL** y como **Redirect URL**, sino el cliente puede rechazar las cookies de sesión.

---

## Funciones nuevas (mayo 2026)

Estas requieren aplicar las migrations **0018–0021** (`cd ../rendio-backend && supabase db push`):

- **Strikes (0018):** amonestaciones con razón. Al 3er strike activo, el conductor queda **suspendido automáticamente la semana siguiente** (tabla `driver_suspensions`, trigger `apply_strike_suspension`). Gestión desde *Personal*.
- **Cambio de turno entre conductores (0019):** un driver propone a otro intercambiar dos turnos del horario publicado; el otro acepta/rechaza, sin admin. El sistema **valida** que no genere indisponibilidad (doble turno, PM→AM, descansos fijos). Se aplica como *overlay* al mostrar el horario; no muta `weekly_schedules`.
- **Reglas editables (0020):** los descansos fijos por conductor (antes hardcodeados por email en `scheduler.js`) se mueven a la tabla `driver_rules`, editable desde *Ajustes → Descansos fijos*. La migration siembra las reglas existentes (Juan Andrés, Cardona). El hardcode queda como fallback si la tabla no responde.
- **Notificaciones push (0021):** ver abajo.

### Notificaciones push (PWA)

1. Genera las llaves VAPID (una sola vez):

   ```bash
   npx web-push generate-vapid-keys
   ```

2. Pega la **public key** en `config.js` → `VAPID_PUBLIC_KEY`. Mientras esté vacía, la app oculta el botón de notificaciones y todo lo demás funciona igual.

3. Configura los secrets de la Edge Function y despliégala:

   ```bash
   cd ../rendio-backend
   supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> VAPID_SUBJECT=mailto:tu@correo.co
   supabase functions deploy send-push --project-ref $SUPABASE_PROJECT_REF
   ```

4. En la app, cada usuario pulsa **Activar** en la barra 🔔. En **iPhone** solo funciona si la PWA está **instalada** en la pantalla de inicio (iOS 16.4+).

Eventos que disparan push: propuesta/decisión de cambio de turno, strike/suspensión, y publicación del horario.

---

## Integración futura con `rendio-admin-web`

Cuando el panel admin oficial esté listo (React + TS + Tailwind v4):

- Migrar este módulo a `rendio-admin-web/src/features/shifts/`.
- Reusar el mismo schema (`driver_availability`, `weekly_schedules`, `app_settings`).
- Convertir la captura de disponibilidad por conductor en pantalla del `rendio-mobile` (app driver) para que cada uno la llene desde el celular.
- Mantener la separación api / scheduler / vistas.
