# rendio-app

La app de Rendio para Play Store y App Store: `rendio-turnos/` (la misma web de
rendio.co) dentro de Capacitor 8. Todo lo nativo vive en `rendio-turnos/native.js`;
en el navegador ese archivo no hace nada.

```bash
npm install
npm run sync:dev     # web → app, con Supabase de pruebas (Rendio-dev)
npm run sync:prod    # web → app, con producción (lo que va a las tiendas)
node scripts/iconos.mjs   # ícono y pantalla de carga desde la marca
```

Android: `cd android && ./gradlew assembleDebug` (prueba) o `bundleRelease` (tienda).
iPhone: abrir `ios/App/App.xcodeproj` en Xcode.

Cómo probar, firmar y subir: **GUIA-TIENDAS.md**.
