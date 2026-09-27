# Pendientes, decisiones y preguntas abiertas — septiembre 2026

> **Fecha:** 27 de septiembre de 2026 · **Rama base:** `dev` (commit `2e6dd28`, SW v162)
>
> **Cómo se armó:** revisión del código de `dev`, consultas de solo lectura a las bases de dev (`lxlphbafhtphulanhzlp`) y producción (`wvuurnfdrrdondrbbkhd`), y lectura completa del PDF `docs/Rendio-Funcionalidades-y-Reglas-de-Negocio.pdf` (archivo local, no versionado). Las respuestas a las preguntas son del equipo, del mismo día.
>
> **Estado:** nada de esto está implementado todavía. Es la lista de trabajo acordada.

## Contenido

0. [Urgente, antes de todo](#0-urgente-antes-de-todo)
1. [Resumen](#1-resumen)
2. [Usuarios: editar datos y cambiar contraseñas](#2-usuarios-editar-datos-y-cambiar-contraseñas)
3. [Rutas del día: nombres y responsive](#3-rutas-del-día-nombres-y-responsive)
4. [Excel del Balance: columna "Valor a pagar"](#4-excel-del-balance-columna-valor-a-pagar)
5. [Facturario del tripulante](#5-facturario-del-tripulante)
6. [Doblar turno](#6-doblar-turno)
7. [Renombrar "Rendio Turnos" a "Rendio"](#7-renombrar-rendio-turnos-a-rendio)
8. [Preguntas abiertas](#8-preguntas-abiertas)
9. [Tareas técnicas y otros hallazgos](#9-tareas-técnicas-y-otros-hallazgos)
10. [Anexo: pasarelas de pago en Colombia](#10-anexo-pasarelas-de-pago-en-colombia)

---

## 0. Urgente, antes de todo

| # | Qué | Por qué importa | Tamaño |
|---|---|---|---|
| T1 | **Corregir un hallazgo de seguridad crítico en los permisos de la base**, verificado en dev y en producción. | Hay que arreglarlo antes de construir Usuarios o el Facturario encima. El detalle **no se escribe aquí porque este repositorio es público**; lo tiene el equipo. | S |
| T2 | **Los avisos programados no salen en producción.** `dispatch-notifications` no está desplegada en main y el Vault de main no tiene los secretos (`dispatch_notifications_url`, `service_role_key`). El cron `drain-notification-outbox` corre cada minuto pero no entrega nada. | Afecta los avisos de madrugada que ya existen y todos los avisos del Facturario. En dev sí está armado. | S |

---

## 1. Resumen

| # | Pendiente | Hoy | Qué falta | Tamaño | Qué lo frena |
|---|---|---|---|---|---|
| 1 | Usuarios: editar y contraseñas | Solo se crean. Nadie edita datos ni cambia contraseñas desde la app; solo con scripts locales. | Edge function de administración, pantallas de edición y "Cambiar mi contraseña". | L | T1. Falta confirmar U3. |
| 2 | Rutas del día: nombres y responsive | El reloj no muestra ningún nombre, solo la placa, en letra de 5 a 7,5 px. | Nombres en el reloj, responsive y táctil. Solo frontend. | M | **Preview de UX** (lo manda el equipo). |
| 3 | Excel del Balance: "Valor a pagar" | La hoja 3 tiene 7 columnas y un Total con valores fijos. | Columna al final y total con autosuma. | S | Confirmar la interpretación (sección 4). |
| 4 | Facturario del tripulante | No existe nada. | Módulo nuevo: estado de cuenta, cortes, avisos y suspensión. | L | Montos y fechas de los dueños, **preview de UX**, T2, preguntas C9, C11, C12 y C22. |
| 5 | Doblar turno | Las reglas lo prohíben, pero en producción ya se dobla por fuera del sistema. | Marca de doble, reglas relajadas, inspección corta y balance. | L | Preguntas D2 y D7. |
| 6 | Renombrar a "Rendio" | La app se llama "Rendio Turnos" / "Rendio · Turnos". | Cambiar el nombre y posiblemente el link. | S | Aclarar si es el nombre, el link o ambos. |

**Orden sugerido:** T1 → T2 → Excel y renombrar (rápidos) → Usuarios → Doblar → Facturario (cuando lleguen los datos y el UX) → Rutas (cuando llegue el UX).

---

## 2. Usuarios: editar datos y cambiar contraseñas

### 2.1 Cómo está hoy

| Acción | Conductor | Tripulante | Jefe |
|---|---|---|---|
| Crear | ✅ El jefe desde Personal (edge function `create-driver`) | ✅ Se registra solo (`register_auxiliar`, migración 0076) | ⚠️ Solo por script (`seed-turnos-users.mjs`) |
| Editar nombre, teléfono, correo, cédula | ❌ | ❌ | ❌ |
| Cambiar su propia contraseña | ❌ | ❌ | ❌ |
| El jefe le restablece la contraseña | ❌ Solo scripts locales | ❌ | ❌ |
| Desactivar / reactivar | ⚠️ Existe, pero solo lo frena la pantalla | ❌ No hay botón y no bloquea nada | ❌ La UI lo oculta y un jefe inactivo desaparece de la lista |

Lo que el jefe sí puede cambiar hoy: prioridad, "puede liderar", alertas de operación, activo o inactivo (solo conductores) y la fecha de ingreso del tripulante.

### 2.2 Decisiones

| # | Decisión |
|---|---|
| U1 | El jefe edita nombre, teléfono, correo, cédula y licencia/EPS/ARL. El usuario solo edita su teléfono y su foto. |
| U2 | Para una contraseña olvidada, el jefe genera una temporal que se muestra una sola vez, y la persona la cambia al entrar. **Además, el jefe puede poner una contraseña concreta si quiere.** No hay recuperación por correo porque no hay SMTP propio. |
| U3 | *Pendiente de confirmar:* dos niveles. **Suspendido:** entra, ve el motivo, pero no pide traslados ni abre turno. **Eliminado:** no entra. (C8 ya definió qué bloquea la suspensión.) |
| U4 | El jefe puede editar a los tripulantes (nombre, teléfono, aerolínea) y desactivarlos. Crear y borrar tripulantes sigue sin ser posible. Esto cambia la regla del PDF (p. 21). |
| U5 | Un jefe puede editar, resetear o desactivar a otro jefe. Nadie puede desactivarse a sí mismo y nunca pueden quedar 0 jefes activos. |
| U6 | Se pueden crear jefes y promover a alguien a jefe desde Personal. |
| U7 | Una sola regla de contraseña: mínimo 10 caracteres, con letra y número. Hoy conviven mínimo 8 (`create-driver`) y mínimo 10 (registro). |
| U8 | Para cambiar la contraseña propia se pide la actual. |
| U9 | El jefe puede cambiar el correo (que es el usuario de login) sin confirmación de la persona, y queda en la bitácora. |
| U10 | Se puede restaurar un conductor eliminado y reusar su correo. Hoy hay 9 eliminados en producción y `create-driver` rechaza su correo con 409. |
| U11 | Al desactivar o resetear a alguien se cierran sus sesiones abiertas. |

### 2.3 Tareas

| Tarea | Capa | Tamaño |
|---|---|---|
| T1: endurecer los permisos de perfiles (ver sección 0). | SQL | S |
| Edge function `admin-update-user` con service_role. Acciones: editar datos (perfil y subperfil), cambiar correo (con el "aparcado" de correos de eliminados, como hacen los scripts `rename-*.mjs`), poner contraseña temporal o concreta con la marca de cambio obligatorio, activar o desactivar (ban en auth), eliminar y restaurar (borrado blando; **nunca** `deleteUser`, porque `profiles.id` tiene `ON DELETE CASCADE`), y cambiar rol. Cada acción queda en `audit_events` con el actor = quien llama. | Edge function | M |
| Personal: "Editar datos", "Restablecer contraseña", y Suspender, Eliminar y Restaurar también para jefes, con las guardas de U5. Corregir que `listAdmins` oculta a los inactivos ([api.js:244](../rendio-turnos/api.js#L244)) y que `renderWorkers` fija `active:true` para jefes ([admin-personal.js:85](../rendio-turnos/admin-personal.js#L85)). | Frontend | M |
| Tripulantes: chip de estado, filtro de inactivos, editor de nombre, teléfono y aerolínea, "Restablecer contraseña" y "Desactivar/Reactivar". Corregir `listAuxiliares`: su filtro de eliminados no filtra nada porque el select no trae `deleted_at` ([api.js:102](../rendio-turnos/api.js#L102) y [:110](../rendio-turnos/api.js#L110)). | Frontend | M |
| "Cambiar mi contraseña" para los tres roles: vuelve a iniciar sesión con la actual y luego `updateUser`. Pantalla forzada si la contraseña es temporal. Columna nueva `profiles.must_change_password`. | Frontend + SQL | S |
| Que la suspensión se cumpla en la base (reservas, inicio de turno) y en el login, no solo en la pantalla. Es requisito del Facturario. | SQL + Frontend | S |
| `create-driver`: aplicar la regla U7, ignorar a los eliminados al buscar duplicados y mandar también licencia, EPS y ARL, que la función ya acepta. | Edge function | S |
| Mostrar al conductor los vencimientos de EPS y ARL: `getMyFullProfile` no los selecciona ([api.js:1754](../rendio-turnos/api.js#L1754)). | Frontend | S |

---

## 3. Rutas del día: nombres y responsive

> **Decisión:** el equipo define los cambios con UX y manda un preview. Lo que sigue es el diagnóstico, para tenerlo a mano cuando llegue.

**Pedido del jefe:** que desde la vista del reloj ("Día completo") se vea el nombre de la persona. Hoy, además, la vista no se ve bien en celular.

### 3.1 Diagnóstico

- **El reloj no muestra nombres.** Cada anillo lleva solo la placa o el código del carro, a 5–7,5 px reales. El detalle del arco (`<title>`) solo aparece con el mouse y no trae nombres ([admin-rutas.js:1433-1496](../rendio-turnos/admin-rutas.js#L1433)).
- **Los nombres ya están en la pantalla, pero no en el reloj.** El conductor aparece en el encabezado de cada tarjeta de carro ([admin-rutas.js:1204-1209](../rendio-turnos/admin-rutas.js#L1204)) y los tripulantes en el cajón del conductor, con nombre, zona, presentación y ETA ([admin-rutas.js:1405](../rendio-turnos/admin-rutas.js#L1405)). No hace falta consultar nada nuevo.
- **Después de publicar, el reloj sale vacío.** La pantalla no vuelve a leer el plan publicado: arma un tablero vacío en cada visita ([admin-rutas.js:166-170](../rendio-turnos/admin-rutas.js#L166), [api.js:2137](../rendio-turnos/api.js#L2137)).
- **Solo dibuja 3 anillos,** pero Ajustes permite hasta 6 carros. Del 4.º en adelante desaparecen sin aviso ([admin-rutas.js:1436](../rendio-turnos/admin-rutas.js#L1436)).
- **Caja de alto fijo con scroll adentro,** y tarjetas recortadas cuando el pool está visible ([styles.css:2012](../rendio-turnos/styles.css#L2012), [:1721](../rendio-turnos/styles.css#L1721)).
- **Con el dedo no funciona:** el drag & drop es HTML5 nativo y la aguja no tiene `touch-action:none`.
- **"Hoy" está escrito fijo** ([index.html:1185](../rendio-turnos/index.html#L1185)), aunque el tablero puede ser de mañana, y la aguja usa la hora del dispositivo en vez de la de Bogotá.
- El texto del centro dice "doble clic: ahora", pero basta un clic. En las llegadas, el detalle del arco dice "→ MDE" con la hora de la última casa.

### 3.2 Propuesta inicial (a ajustar con el preview)

Panel "Vuelta seleccionada" junto al reloj con los tripulantes (reusa el cajón) · leyenda por anillo con placa y conductor AM/PM · lista "A las HH:MM ruedan…" al mover la aguja · letra mínima de 10 px y zona de toque más grande · anillos según la cantidad real de carros · sin caja fija en celular · volver a leer el plan publicado (M) · fase 2: asignar desde el celular con "Mover a…".

---

## 4. Excel del Balance: columna "Valor a pagar"

**Pedido:** en la hoja "Resumen por persona", agregar al final la columna "Valor a pagar" y el total al final con autosuma.

**Interpretación (pendiente de confirmar):** agregar la columna **H "Valor a pagar"** vacía, para que el jefe escriba el valor de cada persona, y en la fila **Total** poner `=SUMA(H4:Hn)`, que se recalcula sola al escribir.

**Dónde:** `onDownloadBalanceXlsx`, hoja 3, [admin-balance.js:513-529](../rendio-turnos/admin-balance.js#L513). Columnas actuales: Conductor · Turnos completos · Horas reales · Turnos auto-cerrados · Horas auto (NO pagables) · Arranques falsos · En curso.

**Notas técnicas:**
- La librería es ExcelJS 4.4.0 y soporta fórmulas: `{ formula: 'SUM(H4:H20)', result: 0 }`. En el código la fórmula va en inglés (`SUM`) y Excel la muestra como `SUMA`.
- Ampliar el título y el sello a A1:H1 y A2:H2 y darle ancho a la columna. Formato de moneda opcional: `"$" #,##0`.
- Subir `CACHE_VERSION` en `sw.js`.

---

## 5. Facturario del tripulante

> **Concepto (decisión C1):** **no es un cobro dentro de la app.** Es un control y un recordatorio de que el tripulante debe pagar. La decisión escrita en la migración 0069 ("NO se cobra dentro de la app") se mantiene. El equipo diseña el módulo con UX y manda un preview.

### 5.1 Cómo está hoy

- No hay tablas, pantallas ni jobs de facturación, corte, saldo o mora.
- Desactivar a un tripulante hoy no le bloquea nada (ver sección 2).
- En producción hay 10 tripulantes, registrados entre el 7 y el 25 de septiembre. 6 tienen push activado.
- El único dato de dinero del tripulante es el precio del traslado privado (`reservations.price_cop`, $150.000 provisional), que es informativo.
- La app le dice al tripulante que el compartido es "Sin costo para ti" ([aux-privado.js:170](../rendio-turnos/aux-privado.js#L170) y :264, :270, :287). Revisar esos textos cuando exista el Facturario.

### 5.2 Decisiones

| # | Decisión |
|---|---|
| C1 | No se cobra en la app: es control y recordatorio. |
| C2 | Paga cada tripulante. |
| C3 | Se factura una mensualidad. |
| C4 | El monto no depende de dónde viva el tripulante. **Los montos los pasan los dueños.** |
| C5 | **Cada tripulante tiene su propia fecha de corte.** Pedir a los dueños una tabla: persona · concepto · día de corte · monto. |
| C6 | Se paga por adelantado. |
| C7 | Los 5 días de gracia son calendario. |
| C8 | Suspendido = no puede pedir traslados nuevos. Se respetan los que ya están en un plan publicado. |
| C10 | El jefe registra el pago con método y referencia. La pasarela queda para después. |
| C13 | Cuatro avisos: 3 días antes, el día de corte, "mañana se suspende" y "quedó suspendida". |
| C14 | El aviso de "ya casi" va 3 días antes. |
| C15 | Los avisos salen a las 7:00 a.m., hora de Bogotá. |
| C16 | Adicionales de la factura: traslado privado, cargo libre del jefe y descuento. |
| C17 | Los privados no se facturan hasta confirmar la tarifa. |
| C18 | Si un adicional llega con la factura ya pagada, va a la siguiente. |
| C19 | Sin prorrateo: el periodo de cada tripulante arranca en su propia fecha de corte. |
| C20 | No hay exentos. |
| C21 | Es un estado de cuenta interno, no factura electrónica DIAN. |
| C23 | Quien no tiene push ve un banner en la app, y la consola lo marca para que el jefe le escriba por WhatsApp. |
| C24 | Más adelante se podrá pagar con un link de pago (ver anexo). |

### 5.3 Diseño propuesto (a ajustar con el preview)

**Tablas (migración nueva):**
- `billing_plans`: nombre, monto, días de gracia (5), días de aviso (3).
- `auxiliar_billing`: una fila por tripulante con plan, **día de corte propio**, fecha de inicio y estado de bloqueo (fecha, motivo, quién). Va en tabla aparte porque el tripulante puede editar su `auxiliar_profiles`.
- `invoices`: periodo, fecha de corte, fecha límite (corte + 5), estado (abierta, pagada, vencida, anulada) y total.
- `invoice_items`: base, privado, cargo o descuento, con el vínculo a la reserva cuando es un privado.
- `payments`: monto, fecha, método, referencia, soporte opcional y quién lo registró.
- RLS: el tripulante solo lee lo suyo; el jefe gestiona todo lo de su organización.

**Job diario** (`pg_cron` a las 12:00 UTC = 7:00 a.m. Bogotá; las fechas se calculan en hora Bogotá):
1. Abre el periodo de cada tripulante cuyo corte es hoy y crea el ítem base.
2. Marca como vencidas las facturas que pasaron la fecha de corte sin pagar.
3. Al día corte + 5, suspende a quien no ha pagado (ver C9).
4. Encola los avisos en `notification_outbox` con una clave única por factura y tipo de aviso, para no repetirlos.

**Avisos:**

| Cuándo | Texto |
|---|---|
| 3 días antes | "Tu pago de {mes} vence el {fecha}" |
| Día de corte | "Hoy es tu fecha de pago · tienes hasta el {fecha + 5}" |
| Día + 4 | "Mañana se suspende tu cuenta" |
| Día + 5 | "Tu cuenta quedó suspendida", más un resumen al jefe (ver C22) |
| Al registrar el pago | "Recibimos tu pago" |

**Tareas:**

| Tarea | Capa | Tamaño |
|---|---|---|
| Prerrequisitos: T1 y T2 | SQL + Edge function | S + S |
| Tablas, RLS, down migration y carga de los 10 tripulantes actuales | SQL | L |
| Bloqueo real al crear y al editar reservas. Error con texto fijo para que la cascada de reintentos de `createReservation` ([api.js:2331-2335](../rendio-turnos/api.js#L2331)) no lo tome como columna faltante. | SQL + Frontend | S |
| Job diario y avisos | SQL | M |
| Acciones del jefe: registrar pago, agregar adicional, anular ítem, suspender o reactivar con motivo | SQL | M |
| Consola del jefe: estado de cuenta por tripulante | Frontend | L (según UX) |
| App del tripulante: "Mi cuenta" y banner de suspendido | Frontend | M (según UX) |

---

## 6. Doblar turno

**Contexto (A2):** Julián es el jefe y tiene un perfil de conductor aparte, porque hoy un usuario no puede ser admin y conductor a la vez. Las dobles aplican a los perfiles de conductor.

### 6.1 Restricciones que existen hoy

| Dónde | Regla | Efecto |
|---|---|---|
| Generador ([scheduler.js:343-364](../rendio-turnos/scheduler.js#L343)) | Una jornada por día | Nunca arma mañana + tarde. |
| Generador ([scheduler.js:287-299](../rendio-turnos/scheduler.js#L287), [horario.js:713-724](../rendio-turnos/horario.js#L713)) | Tarde hoy ⇒ no madrugada mañana, también de domingo a lunes | Nunca arma tarde + madrugada. |
| Tablero ([horario.js:538-540](../rendio-turnos/horario.js#L538), [:908-912](../rendio-turnos/horario.js#L908)) | Poner a alguien en la otra jornada del mismo día **lo mueve** | No se puede doblar a mano. La tarde→madrugada sí entra, sin ningún aviso. |
| Cambios de turno ([scheduler.js:448-467](../rendio-turnos/scheduler.js#L448)) | Rechaza la doble y la tarde→madrugada, revisando toda la semana | Quien tenga una tarde→madrugada publicada no puede hacer ningún cambio esa semana. |
| Líder ([scheduler.js:301-340](../rendio-turnos/scheduler.js#L301), PDF 2.3) | El líder de la mañana y el de la tarde son siempre personas distintas | Choca con D8. |
| Turno en vivo (migración 0033) | Un solo turno abierto por conductor; no hay descanso mínimo | Hoy se encadena cerrando uno y abriendo otro. |
| Inspección (0032, [shift-flow.js:94-106](../rendio-turnos/shift-flow.js#L94)) | Cada turno exige inspección inicial con 11 fotos; la madrugada no puede diferirla | Una doble son 22 fotos. El servidor solo exige que exista la inspección inicial; las fotos las exige el navegador. |
| Auto-cierre (0027) | Cierra turnos abiertos más de `auto_close_hours` (**23 h en producción, 14 h en dev**) | Un turno continuo de 24 h se cierra solo y no se paga. |
| Balance ([admin-balance.js:367](../rendio-turnos/admin-balance.js#L367), :427) | La jornada sale de la hora de inicio | La segunda mitad no publicada sale como "Trabajó sin publicar". |
| Revisión ([admin-revision.js:323-333](../rendio-turnos/admin-revision.js#L323)) | Más de 15 h = "duración rara" | Solo afecta a un turno continuo. |
| Rutas ([admin-rutas.js:1664-1668](../rendio-turnos/admin-rutas.js#L1664)) | Nada impide al mismo conductor en dos carros a la vez | Hay que validarlo. |

**En producción ya se dobla por fuera del sistema** (datos agregados, desde el 25-jun-2026):
- 11 turnos encadenados con menos de 3 h de diferencia. 9 son de tarde a madrugada, a veces con 4 minutos entre uno y otro.
- 7 horarios publicados con tarde→madrugada del mismo conductor.
- No hay ninguna doble del mismo día publicada.

**Bug encontrado:** al mover a alguien dentro del mismo día en el tablero, otro conductor puede desaparecer del cupo sin aviso. Con `morning=[A,B]`, mover A deja `[null]` y B se pierde ([horario.js:538-540](../rendio-turnos/horario.js#L538)). `saveCellEditor` tiene un desfase parecido ([horario.js:908-915](../rendio-turnos/horario.js#L908)).

### 6.2 Decisiones

| # | Decisión |
|---|---|
| D1 | Solo el jefe crea una doble, con una nota del motivo. El generador nunca dobla por su cuenta. |
| D2 | *Pendiente de confirmar:* valen los dos tipos: **doble día** (mañana + tarde del mismo día) y **doble noche** (tarde + madrugada siguiente). |
| D3 | Máximo 24 h seguidas, y después 24 h de descanso obligatorio. |
| D4 | Sin límite de dobles por semana. |
| D5 | Son dos turnos encadenados, no uno continuo. |
| D6 | En la segunda mitad, inspección corta si sigue con el mismo carro; completa si cambia de carro. |
| D7 | Se agrega "Puedo doblar" en Disponibilidad. *Interpretación a confirmar:* el jefe solo puede marcarle una doble a quien puso "Puedo doblar" ese día, y esa marca cuenta como su aceptación. |
| D8 | **Quien dobla puede liderar las dos jornadas.** Cambia la regla del PDF 2.3 y la del generador. |
| D9 | La doble se paga en horas normales: son horas acumuladas, sin recargo. |
| D10 | Lo legal y de RR.HH. está cubierto. |
| D11 | El generador no sugiere quién podría doblar. |

### 6.3 Diseño y tareas

- **Dónde se guarda la doble:** en `weekly_schedules.data._doubles = [{ day, id, tipo, nota }]`. Es jsonb y ya guarda otras llaves, como `_names` ([api.js:741-756](../rendio-turnos/api.js#L741)), así que no necesita migración.
- **"Puedo doblar":** ampliar el CHECK de `driver_availability.shift_pref` (hoy `am`, `pm`, `any`, y el generador no lo usa) con `both`, en vez de crear una columna.

| Tarea | Capa | Tamaño |
|---|---|---|
| Parámetro de descanso posterior (24 h) en `app_settings`, incluido en la cascada de `getSettings` ([api.js:831-846](../rendio-turnos/api.js#L831)) | SQL + Frontend | S |
| Tablero: preguntar "¿Mover o doblar?", mostrar la doble autorizada en ámbar, avisar la tarde→madrugada no autorizada y **arreglar el bug de índices** | Frontend | M |
| Generador: respetar las dobles marcadas y el descanso posterior | Frontend | M |
| Cambios de turno: no rechazar por una doble ya autorizada | Frontend | S |
| Líder: permitir las dos jornadas a quien dobla (D8) | Frontend | S |
| "Puedo doblar" en Disponibilidad y en la matriz del jefe | SQL + Frontend | M |
| Mostrar "Doble" en "Mi semana" del conductor y en la vista móvil del horario | Frontend | S |
| Inspección corta del relevo propio: mismo conductor, mismo carro y cierre reciente | Frontend | M |
| Balance y Revisión: la segunda mitad autorizada no cuenta como "Trabajó sin publicar" | Frontend | S |
| Push al conductor cuando le asignan o quitan una doble | Frontend | S |
| Rutas: impedir al mismo conductor en dos carros a la vez | Frontend | S |
| Actualizar las reglas escritas: [README.md:80 y :120](../rendio-turnos/README.md) y la sección 2.3 del PDF | Docs | S |

---

## 7. Renombrar "Rendio Turnos" a "Rendio"

**Pedido (A1):** es el link de la app que ya se les está pasando a los tripulantes. Hay que cambiar "Rendio Turnos" por "Rendio".

- **Dentro de la app:** la pestaña dice `Rendio · Turnos` ([index.html](../rendio-turnos/index.html)) y el nombre completo al instalarla es `Rendio Turnos` ([manifest.json](../rendio-turnos/manifest.json)). `short_name` ya es "Rendio". Son minutos.
- **El link:** si se cambia la dirección web, se hace en la configuración de dominios de Vercel, no en el código. **Quien ya instaló la app o activó push queda amarrado al link viejo:** con el nuevo tendría que reinstalarla y reactivar las notificaciones. Conviene hacerlo pronto, mientras son pocos, y dejar el link viejo redirigiendo.
- *Pendiente:* ¿se cambia solo el nombre, solo el link o los dos?

---

## 8. Preguntas abiertas

| # | Pregunta | Propuesta |
|---|---|---|
| U3 | ¿"Eliminado" significa que ya no puede entrar? | Sí: suspendido entra pero no opera; eliminado no entra. |
| B | ¿La columna "Valor a pagar" es vacía, para llenar a mano, con `=SUMA` en el total? | Ver sección 4. |
| C9 | ¿La suspensión al día corte + 5 es automática, o el sistema la propone y el jefe la confirma? | — |
| C11 | ¿Se aceptan abonos? | Sí: la factura queda pagada cuando los abonos cubren el total. |
| C12 | ¿La cuenta se reactiva sola cuando el jefe registra el pago? | Sí, y además el jefe puede reactivar a mano con motivo. |
| C22 | ¿Quién recibe el resumen de suspendidos? | Un flag nuevo en el perfil del jefe, con respaldo a todos los jefes. |
| D2 | ¿Valen la doble día y la doble noche? | Las dos. |
| D7 | ¿"Puedo doblar" es la aceptación del conductor? | Ver sección 6. |
| R | Preview de UX de Rutas del día | Lo manda el equipo. |
| F | Preview de UX del Facturario, y la tabla de montos y fechas de corte de los dueños | Lo manda el equipo. |
| N | Renombrar: ¿nombre, link o ambos? | Ver sección 7. |

---

## 9. Tareas técnicas y otros hallazgos

| # | Tarea | Estado |
|---|---|---|
| T1 | Hallazgo de seguridad crítico en permisos (detalle fuera del repo) | Esperando visto bueno para aplicar en dev y luego en producción |
| T2 | Desplegar `dispatch-notifications` en main y cargar los secretos del Vault | Hay que definir quién lo hace: no hay CLI de Supabase instalada y el acceso MCP es de solo lectura |
| T3 | Activar la verificación de correo en el registro (requiere SMTP) | Sin responder |
| T4 | Retirar la edge function `create-auxiliary`: está desplegada, sin uso y desactualizada frente a las migraciones 0055/0075/0076 | Sin responder |
| T5 | Revisar los permisos de envío de push (detalle fuera del repo) | Sin responder |
| T6 | Aplicar la migración `0080_strikes_mensuales`: no está aplicada ni en dev ni en producción (`driver_strikes.period_start` no existe) | Sin responder |
| T7 | Retirar los scripts de reseteo masivo de contraseñas y rotar las contraseñas compartidas (detalle fuera del repo) | Sin responder |

**Otros datos útiles:**
- `app_settings` difiere entre ambientes: `auto_close_hours` es 14 en dev y 23 en producción; el inicio diferido va de 12 a 22 h en dev y de 12 a 17 h en producción. Una prueba en dev no refleja lo que pasa en producción.
- `app_settings` la puede leer cualquier usuario autenticado. No guardar ahí nada que no deban ver conductores o tripulantes (tarifas de nómina, montos internos).
- `route_cars_count` es 2 en producción (con 7 vehículos) y 3 en dev (con 3 vehículos).
- Las ramas `origin/feat/rutas-modular`, `feat/balance-horas-reales` y `feat/liderazgo-strikes-novedades` ya están mergeadas en `dev`: no tienen trabajo pendiente.
- El PDF de reglas está desactualizado en el corte de disponibilidad: dice domingo 2:00 p.m., y desde el commit `d157478` es sábado 4:00 p.m.

---

## 10. Anexo: pasarelas de pago en Colombia

> Para cuando se habilite el pago por link (C24). Tarifas tomadas de las páginas oficiales el 27-sep-2026 y verificadas por segunda vez. Los valores incluyen el IVA del 19% sobre la comisión. Hay que confirmarlas al contratar: ninguna página publica fecha de vigencia.

| Opción | Tarifa | $100.000 | $300.000 | ¿Confirma el pago sola? | ¿Débito automático? | Notas |
|---|---|---|---|---|---|---|
| **Bre-B con llave o QR** (Nequi Negocios, DaviPlata, Bold QR Estándar) | 0% | $0 | $0 | ❌ Manual | ❌ Llega en 2027 | Sin tarjeta ni efectivo. Nequi Negocios solo para persona natural. |
| **Nequi Negocios, link de pago** | 1,5% (Nequi o Bancolombia) · 1,99% (tarjeta) · 2,69% (PSE) + IVA | $1.785–$3.201 | $5.355–$9.603 | ❌ Sin API | ❌ | Solo persona natural; máximo $2,5 M por pago. |
| **Bold** | QR Online 2,89% · PSE y Nequi 2,89% + $900 · tarjeta 2,99% + $900, + IVA | $3.439–$4.629 | $10.317–$11.745 | ✅ API y webhook | ❌ | Sin efectivo. El QR por API está en beta. El dinero debe llegar a la Cuenta Bold. |
| **Wompi** (Bancolombia) | 2,65% + $700 + IVA, la misma para todos los medios | $3.987 | $10.294 | ✅ API y webhook | ✅ Tarjeta, Nequi, Daviplata y Bancolombia tokenizados | Acepta tarjeta, PSE, Nequi, Daviplata, Bancolombia y efectivo. Primer mes sin comisión. |
| **ePayco** (Davivienda) | 2,64% + $690 + IVA con cuenta Davivienda · 3,29% + $700 con otro banco | $3.963 / $4.748 | $10.246 / $12.578 | ✅ | Solo tarjeta de crédito | Retiro de $7.735, salvo 4 gratis al mes con Davivienda. |
| **Mercado Pago** | 2,79% + $800 + IVA (dinero a 14 días) · 3,29% + $800 al instante | $4.272 / $4.867 | $10.912 / $12.697 | ✅ | ✅ Tarjeta | Sin Nequi ni Daviplata. |
| **PayU** | 3,29% + $300 + IVA | $4.272 | $12.102 | ✅ | ❌ Descontinuado | El link de pago no se puede crear por API. |
| **Openpay** (BBVA) | 2,99% + $800 + IVA con cuenta BBVA | $4.510 | $11.626 | ✅ | Solo tarjeta | |
| **Stripe** | No opera para empresas colombianas | — | — | — | — | |

**Recomendación preliminar:** dos caminos. **Wompi** con un link por factura: cubre todos los medios y el webhook marca la factura como pagada sola. Y, como alternativa sin costo, **transferencia Bre-B** con validación manual del jefe.

**Costos que no están en la tarifa:**
- **IVA de la comisión:** es costo si Rendio no es responsable de IVA.
- **Retenciones solo con tarjeta:** retefuente 1,5%, reteICA alrededor de 0,2% y reteIVA. Son anticipos de impuestos, recuperables. PSE, Nequi y Bre-B no tienen retenciones. Una persona natural no responsable de IVA puede pedir que no le retengan el 1,5% (art. 401-4 ET). Hay un proyecto para eliminar esa retención en tarjetas que todavía no está vigente.
- **4x1000** al retirar.
- **Contracargos:** los asume el comercio.

**Patrón técnico:**
- Una edge function crea un link de un solo uso por factura y guarda su id.
- Otra edge function recibe el webhook (`verify_jwt = false`): verifica la firma, confirma contra la API de la pasarela y marca la factura como pagada de forma idempotente.
- `pg_cron` hace una conciliación periódica, por si un aviso no llegó.
- Sandbox en rendio-dev y producción en rendio-main, con los secretos solo en `supabase secrets`.

**Para escoger hace falta saber:** si Rendio cobra como persona natural o como empresa, en qué banco tiene cuenta, y quién asume la comisión.
