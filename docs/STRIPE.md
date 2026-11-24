# Tarjetas y recargas simuladas con Stripe

La aplicación registra tarjetas de crédito o débito de prueba con Stripe, solicita un código al correo del usuario antes de activarlas y permite recargar el saldo simulado con una tarjeta activa. El saldo se acredita cuando la API valida la confirmación de Stripe. Resend envía el comprobante después del abono.

Para las pruebas manuales, configura las claves del entorno de pruebas de Stripe. Stripe Elements captura los datos completos de tarjeta y la API guarda la referencia y la terminación. La compra y venta de acciones BMV usa el saldo interno de la aplicación.

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

Ejecuta estos comandos en PowerShell desde la raíz.

```powershell
npm.cmd --prefix backend-node ci
npm.cmd --prefix frontend ci
npm.cmd --prefix backend-node run migrate
```

Si vas a usar la base PGlite local, agrega `-- --local-demo` al comando `migrate`. Los pagos usan tablas de clientes Stripe, tarjetas, desafíos por correo, recargas y comprobantes pendientes.

## 3. Escuchar los webhooks en desarrollo

Instala Stripe CLI y ejecuta estos comandos en otra terminal. [Instalación de Stripe CLI](https://docs.stripe.com/cli/install)

```powershell
stripe login
stripe listen --events payment_intent.succeeded,payment_intent.payment_failed --forward-to http://127.0.0.1:8000/api/stripe/webhook/
```

Selecciona el mismo entorno de pruebas que utiliza la aplicación. Copia el secreto `whsec_...` del listener en `STRIPE_WEBHOOK_SECRET`, deja la terminal abierta y reinicia el servidor si ya estaba en ejecución.

Este manejador espera eventos **Snapshot**, con el objeto PaymentIntent en `data.object`. Si configuras un endpoint alojado, selecciona ese formato y su secreto correspondiente. Consulta [la documentación de webhooks](https://docs.stripe.com/webhooks?lang=node).

## 4. Iniciar la aplicación

En otra terminal, desde la raíz:

```powershell
npm.cmd --prefix backend-node run dev
```

Abre `http://127.0.0.1:5173`. El comando inicia la API Node.js en el puerto 8000, React en el 5173 y el proceso de reintentos de correos de recargas.

Agrega `-- --local-demo` para usar la base PGlite que preparaste. Si ya compilaste React, `npm.cmd --prefix backend-node start` sirve la aplicación y la API en el puerto 8000.

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

### Retirar saldo de forma simulada

En **Inicio → Retirar fondos**, elige una tarjeta guardada que ya usaste en una recarga acreditada. Introduce un importe en MXN hasta el saldo disponible, revisa y confirma. El importe se descuenta del saldo simulado y la app muestra la tarjeta enmascarada y la referencia del retiro. El movimiento se consulta en **Transacciones → Retiros**. La simulación se ejecuta dentro de la app. Los eventos de Stripe CLI corresponden a las recargas de prueba.

## 7. Reintentar correos pendientes

El servidor revisa los comprobantes pendientes en segundo plano. La notificación se guarda en la misma transacción que el abono, y cada reintento de envío conserva la referencia de la recarga. Mantén `RUN_PAYMENT_EMAIL_WORKER=true` en una instancia de la API para que procese los correos.

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
| `GET /api/withdrawals/` | Consultar saldo disponible y tarjetas con recargas acreditadas. |
| `POST /api/withdrawals/` | Confirmar un retiro simulado y registrar el movimiento. |
| `POST /api/stripe/webhook/` | Recibir eventos firmados de Stripe sin sesión de navegador. |

Los endpoints del usuario conservan autenticación por sesión y CSRF. Solo el webhook está exento de CSRF y exige en su lugar una firma válida de Stripe. Se comprueban el cliente, tarjeta, importe, moneda y referencia local antes de acreditar. La recarga y su PaymentIntent están vinculados de forma única para evitar duplicados.

## Si una prueba no termina

- **Pagos no disponibles.** Revisa que las tres variables de Stripe pertenezcan al entorno de pruebas y reinicia la API.
- **No llega el código:** comprueba Resend y el correo de la cuenta. No se activa la tarjeta sin confirmar el código.
- **Recarga pendiente.** Revisa que `stripe listen` siga activo, que reenvíe al puerto 8000 y que la API use el secreto `whsec_` actual.
- **Firma de webhook rechazada:** revisa el secreto del listener o del endpoint que realmente emitió la notificación y el formato Snapshot.
- **Comprobante pendiente.** Mantén activo el proceso de correo de la API y revisa la configuración de Resend.
- **Tablas inexistentes.** Ejecuta `npm.cmd --prefix backend-node run migrate` sobre la misma base que usa el servidor.
- **Error al cargar el SDK de Stripe.** Ejecuta `npm.cmd --prefix backend-node ci` para instalar las dependencias de la API.

Las pruebas automatizadas de la integración utilizan respuestas simuladas de Stripe y Resend y no realizan pagos ni envíos reales. La prueba manual con tu cuenta queda pendiente hasta que completes las claves.
