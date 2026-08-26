# El correo del registro — lo que falta hacer a mano

El registro del tripulante está terminado y probado, **menos dos cosas que solo
se pueden cambiar desde el panel de Supabase** (no hay migración ni código que
las resuelva: son configuración del servicio de correo del proyecto).

Mientras no se hagan, el registro funciona pero llega un **enlace** en vez del
código de dígitos. La app tiene un camino de rescate para eso — en la pantalla
del código hay un «Me llegó un enlace, no un código» donde se pega el enlace y
sigue igual —, pero no es lo que se pidió y no es lo que el tripulante espera.

---

## 1. La plantilla del correo (5 minutos, obligatorio)

**Supabase → Authentication → Emails → Confirm signup**

- **Asunto:** `Tu código de Rendio: {{ .Token }}`
- **Cuerpo:** pegar el contenido de `confirmacion-registro.html` (esta misma
  carpeta), tal cual.

Lo único que no se puede tocar de esa plantilla es `{{ .Token }}`: ese es el
código que la app pide. La plantilla que Supabase trae de fábrica manda
`{{ .ConfirmationURL }}` — un enlace — y por eso hay que reemplazarla.

## 2. El servidor de correo (esto sí es un tapón de verdad)

**Supabase → Project Settings → Authentication → SMTP Settings**

Hoy el proyecto usa el correo que Supabase presta para pruebas, y ese tiene un
**límite de unos 2 correos por hora**. Está medido, no supuesto: al probar el
registro dos veces seguidas el segundo intento respondió
`429 email rate limit exceeded`.

Con ese límite, el registro no se puede abrir a los tripulantes: el tercero de
la fila se queda sin código. Hace falta conectar un servidor de correo propio
(Resend, SendGrid o Amazon SES). Es gratis en el rango que necesitamos, pero
alguien tiene que crear la cuenta y verificar el dominio de Rendio — por eso no
lo dejé hecho.

Mientras tanto, para probar entre nosotros, dos correos por hora alcanzan.

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
