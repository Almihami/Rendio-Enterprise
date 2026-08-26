# Verificación del correo — SACADA DEL REGISTRO

**Estado a 2026-08-25: el registro NO verifica el correo.** El paso del código
se quitó del flujo; está entero y probado en
`PENDIENTE-verificacion-correo.js`, en esta misma carpeta, con las
instrucciones para devolverlo.

## Por qué se quitó

El correo que Supabase presta en el plan gratuito admite unos **2 mensajes por
hora**. No es una estimación: al probar el registro dos veces seguidas, el
segundo intento respondió `429 email rate limit exceeded`. Con ese tope el
registro no se puede abrir a los tripulantes — el tercero de la fila se queda
sin código. Se retoma cuando el proyecto tenga plan pago o un SMTP propio.

## Lo que hay que tener apagado para que el registro funcione HOY

**Supabase → Authentication → Sign In / Providers → Email → «Confirm email»:
APAGADO.**

Esto no es opcional y no depende del código. Con esa opción encendida, Supabase
crea el usuario pero NO devuelve sesión, y desde el navegador no hay forma de
continuar: la app se lo dice al usuario en vez de dejarlo trancado, pero el
registro no se completa. Es un interruptor del servidor, no una pantalla.

## Lo que se pierde mientras tanto, dicho claro

**El correo no se comprueba.** Cualquiera puede registrarse con la dirección
que quiera, incluida la de otra persona. Es una decisión tomada a sabiendas
para poder avanzar, no un descuido. Dos consecuencias prácticas:

- Un correo mal escrito no se detecta hasta que alguien intente escribirle.
- El registro queda abierto a cualquiera con el enlace. Vale la pena mirar de
  vez en cuando el padrón (**Rutas → Tripulantes**) hasta que vuelva la
  verificación.

## El día que se retome

1. Conseguir el servidor de correo: **Project Settings → Authentication → SMTP
   Settings**. Resend, SendGrid o Amazon SES — gratis en el volumen que hace
   falta, pero alguien tiene que crear la cuenta y verificar el dominio de
   Rendio.
2. Pegar la plantilla de `confirmacion-registro.html` en **Authentication →
   Emails → Confirm signup**, con el asunto `Tu código de Rendio: {{ .Token }}`.
   Lo único intocable es `{{ .Token }}`: ese es el código que la app pide. La
   plantilla de fábrica manda un enlace, y por eso hay que reemplazarla.
3. Encender **«Confirm email»**.
4. Devolver el código siguiendo las instrucciones de la cabecera de
   `PENDIENTE-verificacion-correo.js`.

### Dos datos que ya costó averiguar

- Este proyecto emite códigos de **8 dígitos**, no 6 (**Authentication → Email
  OTP Length**). La app lee el número de `OTP_LENGTH` en `config.js`, que
  también se quitó y hay que devolver.
- `@rendio.demo` y `@example.com` **no sirven** para registrarse: Supabase
  valida el dominio y los rechaza con «Email address is invalid». Los usuarios
  de prueba de dev (`*@rendio.demo`) existen porque se crearon con la llave de
  servicio, que se salta esa validación. Para probar hay que usar un correo
  real o uno `@rendio.co`.
