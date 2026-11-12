# Acceso verificado y sesión persistente

Cada acceso que comienza sin una sesión válida requiere contraseña y un código por correo. Al volver a abrir la aplicación en el navegador que conserva su sesión, se entra directamente sin volver a enviar un código. Después de cerrar sesión o de confirmar el acceso en otro dispositivo, es necesario autenticarse de nuevo.

## Flujo

1. El usuario escribe su correo o usuario y contraseña. Si son correctos, Resend envía un código de seis dígitos al correo registrado.
2. La aplicación muestra **Confirma que eres tú**. Antes de validar el código no permite consultar saldos, inversiones ni datos de perfil.
3. Después de verificar el código, Django crea la sesión autenticada y devuelve una cookie HttpOnly. La contraseña y el código no se guardan en el navegador.
4. El navegador conserva la cookie al cerrar y abrir la ventana. La aplicación recupera la cuenta automáticamente mientras esa sesión siga vigente.
5. Al confirmar un acceso desde otro navegador o dispositivo, el servidor revoca la sesión anterior. Pedir el código en otro dispositivo todavía no la revoca.

El registro también pide verificar el correo antes de dar acceso. Se conserva la configuración de Resend existente; no necesitas otra API key.

## Cookie y duración

La cookie solo contiene un identificador de sesión. Los datos de autenticación se guardan en la base de Django, siguiendo su [sistema oficial de sesiones](https://docs.djangoproject.com/en/5.2/topics/http/sessions/). Es HttpOnly, usa SameSite=Lax y se envía únicamente por HTTPS en producción.

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

Se usan `RESEND_API_KEY`, `RESEND_FROM_EMAIL` y, opcionalmente, `RESEND_REPLY_TO_EMAIL` del `.env` existente. Las plantillas están en `backend/core/emails.py`. Consulta [la configuración de Resend](RECUPERACION.md) si necesitas cambiarlas.

Para otra instalación del proyecto:

```powershell
.\.venv\Scripts\python.exe backend/manage.py migrate
npm.cmd --prefix frontend run build -- --configLoader runner
```

Reinicia Django después de actualizar el código o `.env`. Las sesiones anteriores a esta implementación deben verificarse de nuevo antes de acceder a la API; los usuarios y sus inversiones se conservan.

Las pruebas automatizadas usan una base aislada y Resend simulado. No envían códigos reales ni requieren acceso a un buzón.
