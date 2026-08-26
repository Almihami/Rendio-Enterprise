# El correo del registro — APAGADO POR AHORA

**Estado a 2026-08-25: la verificación por correo está apagada a propósito.**
El correo que Supabase presta para pruebas admite ~2 mensajes por hora (medido:
el segundo intento devolvió `429 email rate limit exceeded`), así que no sirve
para que se registren tripulantes de verdad. Se retoma cuando haya un servidor
de correo propio.

## Cómo se apaga y cómo se vuelve a encender

**Supabase → Authentication → Sign In / Providers → Email → «Confirm email»**

- **Apagado** (lo de ahora): al registrarse, Supabase devuelve la sesión de una.
  La app se salta el paso del código sola y el registro queda de 2 pasos.
- **Encendido**: Supabase manda el correo y no devuelve sesión. La app pone el
  paso del código sola y el registro pasa a 3 pasos.

**No hay que tocar ni desplegar nada para cambiar entre los dos.** La app lo
decide leyendo lo que Supabase le responde al registrar, no una bandera nuestra
(ver `crear()` en `aux-registro.js`). La pantalla del código y todo lo suyo
—reenvío con cuenta regresiva, pegar el código, el camino de rescate por
enlace— siguen en el repositorio, probados, esperando.

---

# Lo que hay que hacer el día que se retome

## 1. La plantilla del correo (5 minutos)

**Supabase → Authentication → Emails → Confirm signup**

- **Asunto:** `Tu código de Rendio: {{ .Token }}`
- **Cuerpo:** pegar el contenido de `confirmacion-registro.html` (esta misma
  carpeta), tal cual.

Lo único que no se puede tocar de esa plantilla es `{{ .Token }}`: ese es el
código que la app pide. La plantilla que Supabase trae de fábrica manda
`{{ .ConfirmationURL }}` — un enlace — y por eso hay que reemplazarla.

## 2. El servidor de correo (esto es el motivo del apagón)

**Supabase → Project Settings → Authentication → SMTP Settings**

Hace falta conectar un servidor propio: Resend, SendGrid o Amazon SES. Es
gratis en el volumen que necesitamos, pero alguien tiene que crear la cuenta y
verificar el dominio de Rendio.

## 3. Cuántos dígitos tiene el código

Este proyecto emite códigos de **8** dígitos. La app pinta 8 casillas porque lee
`OTP_LENGTH` de `config.js`. Si en **Authentication → Email OTP Length** se baja
a 6 (que es lo más común), hay que poner `OTP_LENGTH: 6` en `config.js` — es una
línea, y es el único sitio donde el número está escrito.

## 4. Dominios que Supabase rechaza

`@rendio.demo` y `@example.com` **no sirven** para registrarse: Supabase valida
el dominio y los rechaza con «Email address is invalid». Los usuarios de prueba
de dev (`*@rendio.demo`) se crearon con la llave de servicio, que se salta esa
validación; el registro desde la app no puede.

Para probar el registro hay que usar un correo real o uno `@rendio.co`.
