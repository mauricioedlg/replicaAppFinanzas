# Recuperación de contraseña

La pantalla de acceso tiene el botón **Olvidaste tu contraseña** encima del texto para crear una cuenta. El flujo pide el correo registrado, un código de seis dígitos enviado por Resend y, después de verificarlo, la contraseña nueva con su confirmación. Al guardar regresa al acceso y muestra el mensaje encima de los campos.

## Configuración pendiente

En el archivo **`.env` de la raíz**, completa los espacios preparados:

```dotenv
RESEND_API_KEY=re_tu_api_key
RESEND_FROM_EMAIL="App Finanzas Mauricio <seguridad@tudominio.com>"
RESEND_REPLY_TO_EMAIL=soporte@tudominio.com
RESEND_TIMEOUT_SECONDS=10
```

- `RESEND_API_KEY`: clave de Resend con permiso para enviar correos desde tu dominio.
- `RESEND_FROM_EMAIL`: remitente que aparecerá en ambos correos. Usa un dominio tuyo verificado en Resend; no pongas una dirección personal de Gmail como remitente. Consulta la [configuración oficial de dominios](https://resend.com/docs/dashboard/domains/introduction).
- `RESEND_REPLY_TO_EMAIL`: opcional; correo que recibirá las respuestas. Puedes dejarlo vacío.
- `RESEND_TIMEOUT_SECONDS`: tiempo máximo de espera por envío; por defecto, 10 segundos.

Cada mensaje se envía al correo de la cuenta. La API usa las plantillas de texto y HTML de `backend-node/auth.js` y mantiene la clave de Resend en el servidor. Consulta [la API de envío de Resend](https://resend.com/docs/api-reference/emails/send-email).

Configura una `NODE_SECRET_KEY` aleatoria y estable en `.env`. Esta clave protege los códigos y autorizaciones. Cambiarla invalida las recuperaciones en curso.

## Aplicar los cambios

Ejecuta estos comandos desde la raíz con tu conexión habitual a la base de datos.

```powershell
npm.cmd --prefix backend-node run migrate
npm.cmd --prefix backend-node run dev
```

`migrate` prepara las tablas de la aplicación. Reinicia el servidor después de editar `.env`.

El acceso, el registro y la recuperación necesitan la configuración de Resend para enviar sus códigos. Sin ella, la aplicación muestra un error de envío y no inicia una sesión autenticada. Las pruebas automatizadas simulan Resend y no requieren una API key. Consulta [el flujo de acceso verificado](ACCESO.md).

## Comportamiento y límites

- El código dura 10 minutos y permite cinco intentos fallidos. Para pedir otro hay una espera de 60 segundos y un máximo de cinco envíos por cuenta en una hora; también hay límites por IP.
- La solicitud muestra el mismo mensaje para cuentas existentes e inexistentes. Si no llega un correo, revisa la dirección, la carpeta de spam y la configuración del remitente en Resend.
- Reenviar reemplaza el código anterior. La autorización para crear la contraseña dura cinco minutos desde la verificación y solo puede usarse una vez.
- Los códigos y las autorizaciones se guardan como resúmenes criptográficos. La API valida la contraseña nueva y la almacena mediante PBKDF2.
- Cambiar el correo o la contraseña de la cuenta invalida su recuperación anterior. El cambio de contraseña cierra las sesiones previas; después debes iniciar sesión de nuevo.
- Las notificaciones de seguridad se envían aunque el usuario desactive las notificaciones generales.
- Al confirmar el cambio, el backend pide a Resend el envío de la confirmación. Si Resend rechaza ese segundo correo, la contraseña queda actualizada y el acceso muestra que no se pudo enviar la confirmación, sin indicar falsamente que se envió. No hay reintentos automáticos de ese correo.
- El progreso solo permanece en memoria del navegador. Al recargar se empieza de nuevo y puedes solicitar otro código cuando termine la espera.

## Verificar sin enviar correos reales

```powershell
npm.cmd --prefix backend-node test
```

Las pruebas usan una base de pruebas aislada. Para una comprobación real después de configurar Resend, usa una cuenta de prueba propia: solicita el código, verifica, cambia la contraseña, comprueba el correo de confirmación y entra con la contraseña nueva. La aceptación de un envío por Resend no garantiza su entrega en la bandeja de entrada.
