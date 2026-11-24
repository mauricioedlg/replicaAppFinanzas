# App Finanzas Mauricio · inversiones en la web

Aplicación de inversión simulada con **React, Node.js, Express y PostgreSQL en Neon**. El mercado de 30 emisoras BMV usa precios de ejemplo en MXN. Todas las operaciones y recargas son de prueba.

## Ejecutar con Neon

Necesitas Node.js 22.12+ y npm. Si todavía no tienes un `.env` en la raíz, créalo a partir de `.env.example`. Configura `DATABASE_URL` y una `NODE_SECRET_KEY` aleatoria. Si ya tienes una base, conserva su cadena de conexión y las claves de Resend y Stripe. El comando `migrate` prepara las tablas para la API y conserva las cuentas, posiciones, movimientos, tarjetas y recargas existentes.

Ejecuta estos comandos en PowerShell desde la raíz.

```powershell
npm.cmd --prefix backend-node ci
npm.cmd --prefix frontend ci
npm.cmd --prefix backend-node run migrate
npm.cmd --prefix backend-node run dev
```

Abre **http://127.0.0.1:5173**. Vite reenvía `/api` al servidor Node.js en el puerto 8000. Si estás actualizando una instalación, vuelve a iniciar sesión después de aplicar la migración. Consulta [la guía de Neon](docs/NEON.md).

## Desarrollo local

El modo `--local-demo` usa PGlite y guarda su base en `backend-node/.local-db/`. Ejecuta los comandos después de instalar las dependencias.

```powershell
npm.cmd --prefix backend-node run migrate -- --local-demo
npm.cmd --prefix backend-node run seed:demo -- --local-demo
npm.cmd --prefix backend-node run dev -- --local-demo
```

`seed:demo` agrega el [catálogo BMV y los datos de ejemplo](docs/BMV.md). La cuenta `mauricioedlg` tiene seis posiciones y un saldo simulado de $8,420.50 MXN. Puedes usar el mismo comando sin `--local-demo` para cargar ejemplos en una rama de pruebas de Neon.

## Acceso y pagos

- Configura `RESEND_API_KEY` y `RESEND_FROM_EMAIL` para recibir los códigos de [acceso y registro](docs/ACCESO.md), [recuperación de contraseña](docs/RECUPERACION.md) y activación de tarjetas.
- Para [tarjetas y recargas con Stripe](docs/STRIPE.md), usa `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` y `STRIPE_WEBHOOK_SECRET` del entorno de pruebas. La API acredita el saldo al verificar el webhook y reintenta los comprobantes pendientes por correo.
- El portafolio, el historial y las preferencias se guardan por cuenta. Desde el historial puedes filtrar movimientos y exportarlos en CSV.

## Servir la compilación de React

```powershell
npm.cmd --prefix frontend run build -- --configLoader runner
npm.cmd --prefix backend-node start
```

En desarrollo, abre **http://127.0.0.1:8000**. Para usar la base local ya preparada, agrega `-- --local-demo` al comando `start`.

En producción usa HTTPS, `NODE_DEBUG_MODE=false` y una `NODE_SECRET_KEY` propia. Configura `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS` y, si el frontend se aloja en un origen distinto, `CORS_ALLOWED_ORIGINS`. Si un proxy de confianza termina TLS, configura `TRUST_PROXY_HOPS` según tu infraestructura.

## Verificar

```powershell
npm.cmd --prefix backend-node test
```

Las pruebas usan bases temporales y simulan Stripe y Resend. Consulta [la guía de verificación](docs/VERIFICACION.md).

## Estructura

| Ruta | Contenido |
| --- | --- |
| `frontend/` | React, Vite y componentes. |
| `backend-node/` | API Express, inicio del servidor, migraciones y pruebas. |
| `database/` | Esquema PostgreSQL y datos de ejemplo. |
| `docs/` | Guías de acceso, pagos, Neon y [funciones adaptadas de SwiftUI](docs/MIGRACION.md). |
