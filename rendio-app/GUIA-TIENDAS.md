# Rendio en Play Store y App Store — guía

Rama `feat/app-nativa-1031` (worktree `Proyect-app-nativa-1031`), armada la noche del 30 al 31-oct-2026 sobre **main 3c62c67** (producción). Nada de esto está en GitHub, Vercel ni Supabase todavía.

La app de las tiendas es **la misma web** (`rendio-turnos/`) dentro de un contenedor nativo (Capacitor 8). rendio.co sigue igual: las dos usan el mismo código y el mismo Supabase.

---

## 1. Qué quedó hecho

**App nativa (`rendio-app/`)**
- Proyectos de Android (`android/`) e iPhone (`ios/`), con el identificador `co.rendio.app` y el nombre «Rendio».
- Ícono y pantalla de carga con la marca (avión + punto naranja). Se regeneran con `node scripts/iconos.mjs`.
- `npm run sync:dev` / `npm run sync:prod`: copia la web a la app con el Supabase de pruebas o el de producción (`entornos.json`).
- Android: permisos de ubicación con servicio en primer plano (sin «ubicación todo el tiempo»), cámara y notificaciones. La notificación fija del GPS lleva la «R» de Rendio.
- iPhone: textos de los permisos en español, modo de ubicación en segundo plano, push y solo iPhone (en iPad corre en modo iPhone, así no hacen falta capturas de iPad).
- **APK de prueba compilada** (apunta a Supabase **dev**): `rendio-app/salidas/Rendio-dev.apk`.

**Web compartida (`rendio-turnos/`)**: en rendio.co nada cambia; dentro de la app:
- `native.js`: GPS que sigue con Waze abierto y la pantalla apagada (con aviso previo que exige Google), el ping de ubicación por la red nativa, Waze/WhatsApp/tel:/comprobantes en su app, los Excel por «Compartir», el botón atrás que minimiza y la pantalla «Actualiza Rendio».
- Push nativo listo pero **apagado** hasta tener Firebase y la llave de Apple (sección 4).
- **«Eliminar mi cuenta»** (obligatorio en las dos tiendas): Perfil del conductor, Perfil del tripulante, pantalla de la app en pausa y menú del jefe. Pide escribir ELIMINAR. A los jefes les llega un aviso («Alguien eliminó su cuenta») para que revisen si tenía traslados o vueltas pendientes; se restaura desde Personal o Tripulantes.
- Al cerrar sesión en la app se borra el token de avisos de ese teléfono (en un celular compartido, los avisos no le llegan al siguiente). Si la página se recarga con el GPS prendido, al volver a cargar se apaga el que quedó colgado.
- Páginas públicas nuevas: `privacidad.html`, `eliminar-cuenta.html`, `soporte.html` (**borradores**: completar lo que va entre [CORCHETES]) y `app-version.json`.
- `sw.js` en **v250** (agrega native.js y cuenta-eliminar.js). Si al subir ya hay otra v250, usar la siguiente.

**Backend (`rendio-backend/`)**
- Migración **0156** `delete_my_account()` (+ su down). El último jefe activo no puede eliminarse. Avisa a los jefes por la bandeja de avisos (como «olvidé mi contraseña»).
- `_shared/push-nativo.ts`: envío por FCM (Android) y APNs (iPhone). `send-push` y `dispatch-notifications` lo usan para los dispositivos `fcm:` / `apns:`; los de navegador siguen por web-push.
- Los tokens nativos se guardan en la misma tabla `push_subscriptions` (endpoint `fcm:…` / `apns:…`): **no hace falta migración para el push**, y Personal sigue contando los dispositivos.

**Probado esta noche**
- Envío FCM/APNs con servidores simulados: firmas JWT válidas, tokens muertos, token de Xcode por sandbox (15/15).
- Migración 0156 en un Postgres en memoria: conductor, tripulante, jefes, último jefe, sesiones, avisos a los jefes, permisos (18/18).
- `native.js` con un Capacitor simulado en el navegador: enlaces, descargas, GPS, push, versión, teléfono compartido, GPS colgado tras recargar (todo OK).
- Una revisión independiente del código encontró 7 detalles (GPS que quedaba prendido tras cerrar sesión, token de avisos en teléfono compartido, avisos repetidos, etc.); todos corregidos y vueltos a probar.
- La web en local: sin errores en la consola; `RendioNative.isNative` es false.
- Android compila (APK de prueba y AAB de la tienda sin firmar).

**No probado**
- **Nada en un teléfono real.**
- **iPhone no compiló todavía**: Xcode 26 pide bajar la plataforma iOS 26.5 (unos 8 GB), y esta noche se dejó fuera por espacio. Ver la sección 3.

---

## 2. Probar en Android (mañana, 10 minutos)

1. Pasa al teléfono `rendio-app/salidas/Rendio-dev.apk` (por cable, Drive o WhatsApp a ti mismo) y ábrelo. Android pide permitir «instalar apps desconocidas».
2. Entra con una cuenta de **dev** (el APK apunta a Rendio-dev).
3. Qué revisar:
   - Login, Inicio y que no haya nada tapado por la barra de arriba o la de abajo.
   - **Conductor con una vuelta en curso**: aparece el aviso «Tu ubicación durante las vueltas», das permiso, sale la notificación fija «Rendio · vuelta en curso». Toca «Navegar» (abre Waze), deja Waze 10–15 min y mira en Operación (otro teléfono o el computador) que el carro se siga moviendo. **Es la prueba más importante.**
   - Fotos de la inspección (cámara), un Excel desde el balance (abre «Compartir»), un comprobante, el link de WhatsApp.
   - Mapas: que carguen los cuadritos del mapa (ver «Riesgos»).
   - Perfil → Eliminar mi cuenta: **solo con una cuenta de prueba de dev**, y después de aplicar 0156 en dev.

Para volver a compilar el APK de prueba:
```bash
cd rendio-app && npm run sync:dev && cd android && ./gradlew assembleDebug
```
(con `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` y `JAVA_HOME=/opt/homebrew/opt/openjdk@21`). Sale en `android/app/build/outputs/apk/debug/app-debug.apk`.

## 3. Probar en iPhone

1. Xcode → Settings → **Components** → descargar **iOS 26.5** (unos 8 GB; sin esto Xcode no compila ni para un teléfono conectado).
2. `cd rendio-app && npm run sync:dev`, y abrir `ios/App/App.xcodeproj` en Xcode.
3. Target App → **Signing & Capabilities** → Team: tu Apple ID (gratis sirve para probar; la app dura 7 días instalada).
4. Conecta el iPhone, elígelo arriba y dale ▶︎. La primera vez hay que confiar en el desarrollador en Ajustes → General → VPN y gestión de dispositivos.
5. Las mismas pruebas de Android. En iPhone, con la vuelta en curso y Waze adelante, se ve la barra azul de ubicación arriba.

---

## 4. Lo que falta, en orden

### A. Decisiones y cuentas (los dueños)
- [ ] **A nombre de quién**: empresa (necesita **D-U-N-S**, gratis, puede tardar semanas) o persona (en Google, una cuenta personal nueva exige una **prueba cerrada con 12 personas durante 14 días** antes de publicar).
- [ ] **Google Play Console** (USD 25 una vez) y **Apple Developer** (USD 99 al año).
- [ ] **Firebase** (gratis): proyecto «Rendio», con una app Android `co.rendio.app`.
- [ ] Completar los [CORCHETES] de `privacidad.html`, `eliminar-cuenta.html` y `soporte.html` (razón social, NIT, correos, WhatsApp, plazos) y que los revise quien responde legalmente.
- [ ] Definir quién borra los datos personales de las cuentas eliminadas y en qué plazo (la página dice 30 días). Hoy la cuenta queda bloqueada al instante y los datos se conservan; el borrado es a mano.
- [ ] Los traslados futuros de quien elimina su cuenta **no se cancelan solos**: los jefes reciben el aviso y los reacomodan.
- [ ] Confirmar o quitar «las ubicaciones GPS se borran a los 90 días» (hoy no hay nada que las borre).

### B. Subir lo de la web y la base (dev → probar → main)
- [ ] Migración **0156** en dev, probar «Eliminar mi cuenta» con una cuenta de prueba, y después en main.
- [ ] `supabase functions deploy send-push dispatch-notifications` en dev y después en main (sin las llaves nativas funcionan igual que hoy).
- [ ] Desplegar `rendio-turnos` (native.js, cuenta-eliminar.js, las 3 páginas, app-version.json, SW v250). Comprobar rendio.co/privacidad, /eliminar-cuenta y /soporte.

### C. Encender el push nativo
1. Firebase → Configuración del proyecto → Cuentas de servicio → **Generar nueva clave privada** (JSON):
   ```bash
   supabase secrets set FCM_SERVICE_ACCOUNT="$(cat ruta/al/archivo.json)"
   ```
2. Firebase → app Android → descargar **google-services.json** → copiarlo a `rendio-app/android/app/` (no va al repo).
3. Apple Developer → Certificates, IDs & Profiles → **Keys** → nueva con «Apple Push Notifications service» → bajar el `.p8` (solo se puede una vez):
   ```bash
   supabase secrets set APNS_KEY="$(cat AuthKey_XXXX.p8)" APNS_KEY_ID=XXXX APNS_TEAM_ID=YYYY APNS_TOPIC=co.rendio.app
   ```
4. Xcode → Signing & Capabilities → **+ Capability → Push Notifications** (el archivo `App.entitlements` ya existe; Xcode lo enlaza con el Team).
5. `rendio-app/entornos.json` → `"PUSH_NATIVO": true` en dev y en prod, y volver a compilar.
6. Probar: Perfil → Notificaciones → «Actívalas» y después «Activas · probar».

### D. Firmar y subir Android
1. Crear la llave de subida **una sola vez** y guardarla con la clave en un lugar seguro (si se pierde, se pide un cambio a Google):
   ```bash
   keytool -genkeypair -v -keystore rendio-subida.jks -alias rendio -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Crear `rendio-app/android/keystore.properties` (no va al repo):
   ```
   storeFile=../../rendio-subida.jks
   storePassword=…
   keyAlias=rendio
   keyPassword=…
   ```
3. `cd rendio-app && npm run sync:prod && cd android && ./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`.
4. Play Console → Crear app → **Prueba interna** → subir el .aab (Google guarda la llave final con «Firma de apps de Play»).

### E. Subir iPhone
1. App Store Connect → Apps → **+** → iOS, nombre «Rendio», bundle `co.rendio.app`, SKU `rendio-app`.
2. `npm run sync:prod`, abrir Xcode, elegir «Any iOS Device» → Product → **Archive** → Distribute App → App Store Connect.
3. Probar en **TestFlight** y después mandar a revisión.

### F. Fichas y formularios (textos listos en la sección 5)

---

## 5. Textos para las tiendas

**Nombre:** Rendio
**Subtítulo (Apple, 30 caracteres):** Traslados de tripulación
**Descripción corta (Play, 80):** Traslados de tripulación al aeropuerto JMC: rutas, turnos y avisos en vivo.

**Descripción larga:**
> Rendio organiza los traslados de las tripulaciones entre su casa y el aeropuerto José María Córdova.
>
> Para conductores: tus vueltas del día con el orden de recogidas, navegación con Waze, el estado de cada vuelo, el chat con tus pasajeros, tus turnos, horas y disponibilidad, y la inspección del carro con fotos.
>
> Para tripulantes: pide tu traslado, mira quién te recoge y cuándo llega, y recibe avisos si tu vuelo cambia.
>
> Para los jefes de operación: asignación de rutas, operación en vivo con la ubicación de cada carro, reservas, cobros y avisos de emergencia de madrugada.
>
> Rendio es una herramienta de trabajo: necesitas una cuenta de la empresa (los conductores y jefes) o registrarte como tripulante.

**Categoría:** Play: Viajes y guías (o Empresa). Apple: Viajes (secundaria: Negocios).
**Clasificación de contenido:** sin violencia, sin compras, sin anuncios; «Todos» / 4+. Tiene chat entre usuarios (Apple pregunta por «contenido generado por usuarios»: sí, chat del traslado; se puede reportar a Coordinación).
**URLs:** privacidad `https://rendio.co/privacidad` · soporte `https://rendio.co/soporte` · eliminar cuenta `https://rendio.co/eliminar-cuenta`.

**Capturas:** Play pide mínimo 2 del teléfono; Apple pide las de iPhone de 6,9" (1320×2868). Tómalas de la app en dev con datos de prueba (nunca con nombres ni teléfonos reales): Inicio del conductor, una vuelta en el mapa, la operación en vivo del jefe, Pedir traslado. El ícono de 512 y el gráfico destacado de 1024×500 ya están en `rendio-app/recursos/`.

**Cuenta para los revisores** (las dos tiendas la piden): un **conductor de prueba en producción**, en una organización o con un nombre que no ensucie la operación, con una vuelta de ejemplo para que vean el GPS. Ponerla en «Notas para el revisor» con este texto:
> Rendio es la herramienta interna de una empresa de transporte de tripulaciones. Usuario de prueba (conductor): [correo] / [clave]. La ubicación en segundo plano solo se usa mientras el conductor tiene una vuelta en curso, para que el jefe de operación y los pasajeros vean el carro mientras el conductor navega con Waze; al terminar la vuelta se detiene. La cuenta se elimina en Perfil → Eliminar mi cuenta.

**Si Apple la rechaza por ser «para una sola empresa» (regla 3.2):** pedir **distribución no listada** (Unlisted App Distribution). Se instala con un link y no sale en el buscador; para Rendio funciona igual.

### Formulario de Google: seguridad de los datos
| Dato | ¿Se recoge? | Para qué | Opcional |
|---|---|---|---|
| Ubicación precisa | Sí (solo conductores, durante la vuelta) | Funcionalidad de la app | No |
| Nombre, correo, teléfono | Sí | Funcionalidad, gestión de la cuenta | No |
| Dirección (de recogida) | Sí (tripulantes) | Funcionalidad | No |
| Fotos | Sí (inspección, comprobantes, perfil) | Funcionalidad | Sí |
| Mensajes en la app | Sí (chat del traslado) | Funcionalidad | Sí |
| Información de pagos | Comprobantes que sube el tripulante (no tarjetas) | Funcionalidad | Sí |
| ID del dispositivo | Token de notificaciones | Funcionalidad | Sí |

Cifrado en tránsito: **sí**. Se puede pedir el borrado: **sí** (en la app y en rendio.co/eliminar-cuenta). No se comparte con terceros para publicidad.

### Google: servicio en primer plano de ubicación
Play Console → Contenido de la app → **Permisos de servicio en primer plano** → «Ubicación». Justificación: *«Durante una vuelta en curso el conductor navega con Waze; el servicio mantiene el envío de su ubicación a la operación y a los pasajeros que va a recoger, con una notificación visible. Se detiene al terminar la vuelta.»* Piden un **video corto** (pantalla del teléfono): iniciar vuelta → aviso → permiso → notificación fija → abrir Waze → ver el carro moverse en Operación.

### Apple: etiquetas de privacidad
Datos vinculados a la persona, para «Funcionalidad de la app», **sin rastreo**: Ubicación precisa; Información de contacto (nombre, correo, teléfono, dirección); Contenido del usuario (fotos, mensajes); Identificadores (ID de usuario); Información financiera: solo si cuentan los comprobantes de pago como tal.

---

## 6. Cómo se publican los cambios después

- **Cambios de pantallas o lógica (lo de todos los días):** se suben a main como hoy (rendio.co se actualiza solo). La app de las tiendas **no** se entera hasta que se publique una versión nueva. Para no pasar por las tiendas en cada cambio, el siguiente paso es poner actualizaciones en caliente (Capgo, o un servidor propio con @capgo/capacitor-updater); **no está hecho**.
- **Versión nueva en las tiendas:** subir `versionCode` (android/app/build.gradle) y `CURRENT_PROJECT_VERSION` (Xcode) en 1, `npm run sync:prod`, y compilar y subir como en 4-D / 4-E.
- **Obligar a actualizar:** en `rendio-turnos/app-version.json` poner `min` = el número de compilación mínimo, y la URL de la tienda en `store` (la de iPhone se conoce cuando App Store Connect crea la app). Se despliega con la web.
- **Base de datos:** los cambios tienen que seguir sirviendo a la versión anterior de la app, porque habrá teléfonos sin actualizar unos días.

---

## 7. Riesgos conocidos

- **Mapas en la app**: los cuadritos salen de `tile.openstreetmap.org`, y la búsqueda y las rutas de `nominatim` y `router.project-osrm.org` (servidores gratuitos de demostración). Desde la app de iPhone el origen es `capacitor://localhost` y no se manda «Referer»; si OpenStreetMap las bloquea, el mapa sale gris. Si pasa: cambiar a un proveedor con llave (TomTom ya tiene cuenta, o MapTiler).
- **El GPS solo sale con una vuelta en curso** (igual que hoy en la web). Entre vueltas el carro se queda en el último punto. La app soluciona lo de Waze, no eso.
- **Android y el ahorro de batería**: algunos Xiaomi, Huawei o Samsung matan apps en segundo plano aunque tengan notificación fija. Si en la prueba se corta, hay que decirle al conductor que quite Rendio del ahorro de batería.
- **Revisión de Apple** por app de una sola empresa (3.2) o «solo una web» (4.2): el GPS en segundo plano, el push nativo y la cámara ayudan; si no, distribución no listada.
- **Número de la migración**: hay una 0155 solo local en otro worktree; si al subir ya existe otra 0156, renumerar.
