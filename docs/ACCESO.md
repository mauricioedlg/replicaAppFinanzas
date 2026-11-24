# Acceso verificado y sesión persistente

Cada acceso que comienza sin una sesión válida requiere contraseña y un código por correo. Al volver a abrir la aplicación en el navegador que conserva su sesión, se entra directamente sin volver a enviar un código. Después de cerrar sesión o de confirmar el acceso en otro dispositivo, es necesario autenticarse de nuevo.

## Flujo

1. El usuario escribe su correo o usuario y contraseña. Si son correctos, Resend envía un código de seis dígitos al correo registrado.
2. La aplicación muestra **Confirma que eres tú**. Antes de validar el código no permite consultar saldos, inversiones ni datos de perfil.
3. Después de verificar el código, la API crea la sesión autenticada y devuelve una cookie HttpOnly. La contraseña y el código no se guardan en el navegador.
4. El navegador conserva la cookie al cerrar y abrir la ventana. La aplicación recupera la cuenta automáticamente mientras esa sesión siga vigente.
5. Al confirmar un acceso desde otro navegador o dispositivo, el servidor revoca la sesión anterior. Pedir el código en otro dispositivo todavía no la revoca.

El registro también pide verificar el correo antes de dar acceso. Se conserva la configuración de Resend existente; no necesitas otra API key.

## Cookie y duración

La cookie contiene un identificador de sesión. El servidor conserva la sesión en PostgreSQL. La cookie usa HttpOnly y SameSite=Lax y, en producción, se envía únicamente por HTTPS.

`LOGIN_SESSION_DAYS=365` en `.env` establece una duración renovable de un año. Cada uso renueva ese plazo; cerrar el navegador no cierra la sesión. El usuario deberá entrar de nuevo si borra las cookies o deja pasar la vigencia completa sin usar la aplicación. Esta duración es configurable y no representa una cookie permanente sin caducidad.

Solo se conserva una sesión activa de la aplicación por cuenta. Varias pestañas del mismo navegador comparten la sesión; un navegador distinto cuenta como otro dispositivo. Cerrar sesión borra la cookie y revoca la sesión del servidor. Cambiar la contraseña también invalida las sesiones anteriores.

## Seguridad del código

- Caduca en 10 minutos y admite cinco intentos fallidos.
- Se permite reenviar cada 60 segundos, con un máximo de cinco envíos por cuenta en una hora y límites adicionales por IP.
- Reenviar invalida el código anterior. Cada código sirve una sola vez y está vinculado al navegador que inició el acceso.
- Cambiar la contraseña o el correo mientras se espera invalida el código pendiente.
- El servidor guarda un resumen criptográfico del código, sin texto plano. El correo de acceso es independiente del correo de recuperación de contraseña.
- Si falla el envío, no se inicia sesión. Un fallo de envío durante el registro cancela la creación de esa cuenta para poder intentar nuevamente.

## Configurar y ejecutar

Se usan `RESEND_API_KEY`, `RESEND_FROM_EMAIL` y, opcionalmente, `RESEND_REPLY_TO_EMAIL` del `.env` existente. Las plantillas están en `backend-node/auth.js`. Consulta [la configuración de Resend](RECUPERACION.md) para preparar el remitente.

Con las dependencias instaladas, ejecuta estos comandos desde la raíz.

```powershell
npm.cmd --prefix backend-node run migrate
npm.cmd --prefix backend-node run dev
```

Reinicia el servidor después de actualizar `.env`. En una instalación existente, vuelve a iniciar sesión al estrenar el nuevo almacenamiento de sesiones. Se conservan las cuentas y sus inversiones.

Las pruebas automatizadas usan una base aislada y Resend simulado. No envían códigos reales ni requieren acceso a un buzón.
