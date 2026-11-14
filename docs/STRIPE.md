# Tarjetas y recargas simuladas con Stripe

La aplicación registra tarjetas de crédito o débito de prueba con Stripe, solicita un código al correo del usuario antes de activarlas y permite recargar el saldo simulado con una tarjeta activa. El saldo se acredita únicamente cuando Django recibe y valida la confirmación de Stripe. Resend envía el comprobante después del abono.

Las claves se completan manualmente; la integración no necesita credenciales durante sus pruebas automatizadas y no acepta claves de producción. Los datos completos de tarjeta se capturan mediante Stripe Elements y no se guardan en Django. La compra y venta de acciones BMV sigue usando el saldo interno de la aplicación.

## 1. Configurar el archivo .env de la raíz

Desde el entorno de pruebas de tu cuenta Stripe copia la clave secreta y la publicable. Completa estas variables en `.env`, junto a `README.md`:

```dotenv
STRIPE_SECRET_KEY=sk_test_REEMPLAZAR
STRIPE_PUBLISHABLE_KEY=pk_test_REEMPLAZAR
STRIPE_WEBHOOK_SECRET=whsec_REEMPLAZAR
```

El secreto `whsec_` se obtiene en el paso 3. Las tres claves deben pertenecer a la misma integración de pruebas. Los valores de ejemplo anteriores son marcadores, no credenciales válidas. No compartas el archivo ni copies la clave secreta al frontend. React obtiene la publicable desde el endpoint autenticado `/api/payments/config/`; no requiere `VITE_STRIPE_PUBLISHABLE_KEY` ni `frontend/.env.local`.

Mantén también la configuración de correo existente:

```dotenv
RESEND_API_KEY=
RESEND_FROM_EMAIL=
RESEND_REPLY_TO_EMAIL=
```

`RESEND_FROM_EMAIL` debe ser un remitente permitido por tu cuenta Resend. `RESEND_REPLY_TO_EMAIL` es opcional. Los códigos se envían al correo actual de la cuenta autenticada; el usuario no puede indicar un destinatario diferente en el formulario de tarjeta.

## 2. Preparar dependencias y tablas

En el entorno de trabajo verificado el 14 de noviembre de 2026, las dependencias ya están instaladas, la compilación está disponible y la migración `0004_stripe_payments` está aplicada en SQLite y Neon. Para comenzar las pruebas allí basta con completar las claves y seguir los pasos 3 y 4; no es necesario reinstalar las dependencias por agregar las claves.

Los comandos siguientes sirven para preparar otro entorno o reconstruir la instalación si faltan archivos:

Desde la raíz, en PowerShell:

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
npm.cmd --prefix frontend ci
.\.venv\Scripts\python.exe backend/manage.py migrate
npm.cmd --prefix frontend run build
.\.venv\Scripts\python.exe backend/manage.py collectstatic --noinput
```

Las migraciones usan la conexión seleccionada en `.env`. Para Neon, conserva `USE_SQLITE=false`. Para una base local de desarrollo, configura explícitamente `USE_SQLITE=true`. Las tablas nuevas guardan clientes Stripe, tarjetas, desafíos de correo, recargas y comprobantes pendientes; no reemplazan el catálogo ni el historial BMV existente.

## 3. Escuchar los webhooks en desarrollo

La CLI oficial portable está preparada en `.qa/bin/stripe-cli/`. Para escuchar los eventos usando las claves del `.env`, abre una terminal desde la raíz y ejecuta:

```powershell
.\.venv\Scripts\python.exe scripts/stripe_webhooks.py
```

Este script utiliza la clave de pruebas del `.env`, conserva la configuración de la CLI dentro de `.qa/stripe-config/` y oculta el secreto en la salida. Mantén esa terminal abierta mientras pruebas. No necesita un inicio de sesión adicional de la CLI.

Si necesitas volver a obtener y guardar el secreto para ese listener:

```powershell
.\.venv\Scripts\python.exe scripts/stripe_webhooks.py --configure
```

Después reinicia Django y ejecuta nuevamente el comando sin `--configure` para recibir los eventos.

Como alternativa, si instalas [Stripe CLI](https://docs.stripe.com/cli/install) globalmente, puedes usar el flujo manual en otra terminal:

```powershell
stripe login
stripe listen --events payment_intent.succeeded,payment_intent.payment_failed --forward-to http://127.0.0.1:8000/api/stripe/webhook/
```

En el flujo manual, selecciona el mismo entorno de pruebas que utiliza tu aplicación. Copia el secreto `whsec_...` que muestra `stripe listen` en `STRIPE_WEBHOOK_SECRET` y mantén esta terminal abierta. Reinicia Django después de cambiar las variables. Usa el secreto del listener que realmente estés ejecutando, que puede ser distinto del correspondiente a un endpoint configurado en el Dashboard.

Este manejador espera eventos **Snapshot**, con el objeto PaymentIntent en `data.object`. Si configuras un endpoint alojado, selecciona ese formato y su secreto correspondiente. La [documentación de webhooks](https://docs.stripe.com/webhooks?lang=python) explica la firma y el reenvío local.

## 4. Iniciar la aplicación

En otra terminal, desde la raíz:

```powershell
.\.venv\Scripts\python.exe scripts/dev.py
```

Abre `http://127.0.0.1:5173`. Este comando inicia Django en el puerto 8000, React en el 5173 y el proceso de reintentos de correos de recargas. Para servir la compilación desde Django puedes añadir `--built` y abrir `http://127.0.0.1:8000`.

El indicador `--local-demo` selecciona SQLite independientemente de la conexión Neon. `--no-payment-worker` permite iniciar solo los servidores si ya ejecutas el proceso de correos por separado.

## 5. Agregar y verificar una tarjeta

1. Inicia sesión con el código de acceso habitual.
2. En **Configuración → Mis tarjetas**, agrega una tarjeta de prueba y confirma el formulario de Stripe.
3. La tarjeta queda pendiente. Introduce el código recibido en el correo de tu cuenta para activarla.
4. Puedes solicitar otro código después de la espera indicada. El código vence en diez minutos, tiene cinco intentos y solo se utiliza una vez.

Ejemplo de tarjeta de crédito de prueba:

```text
Número: 4242 4242 4242 4242
Vencimiento: cualquier fecha futura
CVC: cualquier combinación de tres dígitos
```

Para débito de prueba puedes usar `4000 0566 5566 5556`. Stripe también documenta tarjetas para rechazos y autenticación adicional en su [guía de pruebas](https://docs.stripe.com/testing). No introduzcas datos de tarjetas reales en este entorno.

El código de correo autoriza el uso de la tarjeta en la aplicación; es independiente de la autenticación bancaria 3D Secure que pueda solicitar Stripe. Cambiar el correo de tu perfil requiere verificar de nuevo las tarjetas para utilizarlas con el nuevo correo.

## 6. Agregar fondos

Selecciona **Agregar fondos**, elige una tarjeta activa e introduce el importe en MXN. El rango admitido por la aplicación es de **$10.00 a $999,999.99 MXN**. Confirma el pago de prueba y completa cualquier autenticación adicional.

La interfaz espera la confirmación del servidor. Si el evento tarda, muestra la recarga pendiente y permite comprobar su estado. Si cierras o recargas la página, puedes recuperar la consulta de la operación pendiente en el mismo navegador; no se guardan secretos de Stripe para ello.

Cuando llega la confirmación válida de Stripe, el servidor acredita el saldo una sola vez, registra el movimiento y prepara el correo con el importe, la terminación de la tarjeta y la referencia. El mensaje identifica el pago como simulado. Un fallo del envío no revierte ni repite el abono.

## 7. Reintentar correos pendientes

`scripts/dev.py` ya inicia este proceso. Para ejecutarlo manualmente una vez:

```powershell
.\.venv\Scripts\python.exe backend/manage.py send_payment_emails
```

Para mantenerlo activo:

```powershell
.\.venv\Scripts\python.exe backend/manage.py send_payment_emails --watch --interval 10
```

En un entorno alojado, ejecuta el proceso persistente o programa el comando periódicamente. La notificación pendiente se guarda junto con el abono y se reintenta sin volver a acreditar el saldo.

## Puntos de integración

| Endpoint | Función |
| --- | --- |
| `GET /api/payments/config/` | Estado de configuración y clave publicable de pruebas. |
| `GET /api/cards/` | Tarjetas de la cuenta autenticada. |
| `POST /api/cards/setup/` | Preparar el registro de una tarjeta con SetupIntent. |
| `POST /api/cards/{id}/verification/request/` | Comprobar el registro en Stripe y enviar el código. |
| `POST /api/cards/{id}/verification/confirm/` | Confirmar el código y activar la tarjeta. |
| `DELETE /api/cards/{id}/` | Deshabilitar una tarjeta conservando el historial. |
| `POST /api/funds/` | Iniciar una recarga; no acredita saldo directamente. |
| `GET /api/funds/{id}/` | Consultar la recarga y el saldo confirmado. |
| `POST /api/stripe/webhook/` | Recibir eventos firmados de Stripe sin sesión de navegador. |

Los endpoints del usuario conservan autenticación por sesión y CSRF. Solo el webhook está exento de CSRF y exige en su lugar una firma válida de Stripe. Se comprueban el cliente, tarjeta, importe, moneda y referencia local antes de acreditar. La recarga y su PaymentIntent están vinculados de forma única para evitar duplicados.

## Si una prueba no termina

- **Pagos no disponibles:** revisa las tres variables de Stripe, que sean del entorno de pruebas y que hayas reiniciado Django.
- **No llega el código:** comprueba Resend y el correo de la cuenta. No se activa la tarjeta sin confirmar el código.
- **Recarga pendiente:** revisa que `stripe listen` siga activo, que reenvíe al puerto 8000 y que Django use su secreto `whsec_` actual. La redirección del navegador no acredita fondos.
- **Firma de webhook rechazada:** revisa el secreto del listener o del endpoint que realmente emitió la notificación y el formato Snapshot.
- **Comprobante pendiente:** conserva el proceso `send_payment_emails` activo y revisa la configuración de correo.
- **Tablas inexistentes:** ejecuta `manage.py migrate` sobre la misma base que usa el servidor.

Las pruebas automatizadas de la integración utilizan respuestas simuladas de Stripe y Resend y no realizan pagos ni envíos reales. La prueba manual con tu cuenta queda pendiente hasta que completes las claves.
