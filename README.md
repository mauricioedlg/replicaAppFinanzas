# App Finanzas Mauricio · inversiones en la web

Adaptación de tu app SwiftUI a **React + Django REST Framework + PostgreSQL en Neon**. Interfaz en español, moneda MXN y operaciones con dinero virtual. Los precios incluidos son ejemplos fijos; no son cotizaciones actuales ni se envían órdenes a una bolsa.

## Funciones

- Inicio de sesión por usuario o correo, verificación por correo, registro y cierre de sesión.
- Sesión persistente con cookie protegida y un solo dispositivo activo por cuenta.
- Recuperación de contraseña mediante código por correo y confirmación con Resend.
- Tarjetas de prueba guardadas con Stripe y activadas mediante un código enviado al correo de la cuenta.
- Recargas con tarjeta verificada: el webhook firmado de Stripe acredita el saldo y Resend envía el comprobante con reintentos.
- Resumen con saldo disponible, valor del portafolio y rendimiento.
- Portafolio con posiciones, cantidades, distribución y costo de inversión.
- Catálogo de 30 emisoras de la Bolsa Mexicana de Valores con búsqueda y operaciones de compra y venta simuladas.
- Historial de operaciones con filtros y exportación CSV.
- Perfil y preferencias persistentes de tema y notificaciones de la aplicación.
- Sesiones con cookies HttpOnly, protección CSRF, contraseñas con hash y acceso a datos limitado al usuario autenticado.

Se conservaron las funciones de los ZIP y las operaciones documentadas en el PDF, que muestra una versión posterior. El PDF se utiliza como referencia funcional; sus instrucciones académicas no cambian el alcance de esta implementación. Consulta [el mapa de migración](docs/MIGRACION.md).

## Requisitos

Python 3.10+, Node.js 22.12+ y npm. Para el entorno principal, una base PostgreSQL de Neon. No se requiere Docker. En Windows los scripts usan `npm.cmd`, por lo que no necesitas habilitar la ejecución de `npm.ps1`.

El acceso y el registro requieren configurar Resend para recibir el código por correo, también al usar SQLite. Las pruebas automatizadas simulan el envío y no necesitan credenciales de Resend.

Las tarjetas y recargas requieren las claves de un entorno de pruebas de Stripe. Si aún no se configuran, la aplicación informa que los pagos de prueba no están disponibles; no se acredita saldo desde el navegador. El saldo y las posiciones BMV existentes se pueden consultar y utilizar normalmente.

## Ejecutar con Neon

1. Copia `.env.example` como `.env` en la raíz del proyecto.
2. En Neon, abre **Connect**, copia la cadena PostgreSQL de tu base y pégala en `DATABASE_URL`. Mantén sus parámetros SSL. Para migraciones puedes usar la conexión directa; la aplicación admite la conexión agrupada.
3. Configura un valor aleatorio para `DJANGO_SECRET_KEY`.
   Guarda tus valores en **`.env`**, junto a este README: `.env.example` es solo una plantilla y Django no la carga. Para desarrollo usa `DJANGO_DEBUG=true`; esta variable tiene prioridad sobre `DEBUG`.
4. Ejecuta desde esta carpeta:

```powershell
python scripts/setup.py
python scripts/dev.py
```

Abre **http://127.0.0.1:5173**. La API corre en el puerto 8000; Vite reenvía `/api` al servidor Django. El asistente de preparación instala dependencias, ejecuta migraciones, carga los ejemplos y compila React. Requiere acceso a Internet para descargar dependencias.

El usuario de ejemplo es **`mauricioedlg`**, también puedes entrar con **`mauricioestrada580@gmail.com`**, y la contraseña que proporcionaste en la solicitud. Su nombre y teléfono están incluidos. La contraseña está almacenada como hash PBKDF2; el script de ejemplo no concede permisos de administrador.

## Acceso con código y sesión guardada

Al entrar con usuario/correo y contraseña, se envía un código al correo de la cuenta. El acceso y el registro requieren confirmar ese código antes de mostrar los datos. Una cookie HttpOnly conserva la sesión al cerrar y volver a abrir el navegador. Al verificar el acceso en otro dispositivo se revoca la sesión anterior; pedir un código todavía no la cierra.

Se utiliza la misma configuración de Resend descrita abajo. `LOGIN_SESSION_DAYS=365` controla la vigencia renovable de la cookie. Consulta [la guía de acceso y sesiones](docs/ACCESO.md).

## Recuperación de contraseña con Resend

El acceso incluye **Olvidaste tu contraseña**, con los pasos de correo, código de verificación y nueva contraseña. Al terminar regresa al inicio de sesión con el resultado y envía un correo de confirmación.

Completa `RESEND_API_KEY` y `RESEND_FROM_EMAIL` en el archivo `.env` de la raíz; `RESEND_REPLY_TO_EMAIL` es opcional. El destinatario se obtiene automáticamente de la cuenta del usuario. Después ejecuta `.\.venv\Scripts\python.exe backend/manage.py migrate`, compila con `npm.cmd --prefix frontend run build` y reinicia Django. La guía [Configurar la recuperación de contraseña](docs/RECUPERACION.md) explica los valores, los remitentes permitidos y las pruebas.

## Tarjetas y recargas con Stripe

Completa `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` y `STRIPE_WEBHOOK_SECRET` en el **`.env` de la raíz** con claves de pruebas. Resend utiliza la configuración existente. React recibe únicamente la clave pública desde Django; no necesitas otro archivo de variables para el frontend. Esta integración admite exclusivamente pagos simulados con Stripe; no acepta claves de producción.

Después de instalar las dependencias y ejecutar las migraciones, `scripts/dev.py` inicia también el proceso que reintenta los comprobantes pendientes. En otra terminal, reenvía los eventos de Stripe a `/api/stripe/webhook/`. Consulta [la guía de configuración y pruebas de Stripe](docs/STRIPE.md) para copiar los comandos y probar tarjetas, códigos y recargas.

## Probar sin una cuenta de Neon

Esta opción usa SQLite de forma explícita para desarrollo; no representa una conexión a Neon:

```powershell
python scripts/setup.py --local-demo
python scripts/dev.py --local-demo
```

Para servir la compilación React y la API en **http://127.0.0.1:8000**:

```powershell
python scripts/dev.py --local-demo --built
```

El indicador `--local-demo` siempre elige la base local aunque exista una conexión Neon en `.env`. No modifica esa configuración ni copia datos entre bases. Si las dependencias ya están instaladas, puedes agregar `--skip-install` a `setup.py`.

`USE_SQLITE=true` también selecciona explícitamente SQLite aunque exista `DATABASE_URL`. Para conectar a Neon usa `USE_SQLITE=false` y elimina cualquier variable `USE_SQLITE=true` que haya quedado en la terminal de pruebas.

## SQL y datos de ejemplo

El esquema que utiliza la aplicación se crea con las migraciones de Django. Se incluye el esquema PostgreSQL de referencia en [database/schema.sql](database/schema.sql) y los `INSERT` de ejemplo en [database/seed.sql](database/seed.sql). Estos cubren las cuatro tablas de negocio: `usuarios`, `acciones`, `portafolio` y `transacciones`.

La ruta recomendada para una base vacía es **`migrate` y luego `seed_demo`**, como hace `setup.py`. Si prefieres ejecutar los `INSERT` en el editor SQL de Neon, ejecuta primero las migraciones y después `database/seed.sql`; el comando y el SQL son alternativas para cargar los mismos ejemplos. Las tablas internas de autenticación, sesiones y migraciones las administra Django. No ejecutes el esquema de referencia antes de `migrate` en la misma base.

La carga normal de ejemplos conserva los usuarios existentes y evita duplicar operaciones. El portafolio inicial incluye CEMEX, Banorte, FEMSA, Walmart de México, Liverpool y Arca Continental: seis compras, seis ventas parciales y un depósito que explican las seis posiciones y el saldo disponible de $8,420.50 MXN.

Para convertir una base que todavía contiene las acciones anteriores, ejecuta una vez sobre la base que usa la aplicación:

```powershell
.\.venv\Scripts\python.exe backend/manage.py seed_demo --replace-with-bmv
```

Esta opción sustituye el catálogo anterior y los ejemplos financieros de `mauricioedlg`, conservando su cuenta, contraseña, sesión y preferencias. Se detiene sin cambios si otra cuenta tiene posiciones o movimientos asociados a las acciones que se retirarían. Después de la conversión, repetir el comando conserva las operaciones nuevas. `database/seed.sql` sigue siendo una alternativa para bases nuevas, no convierte portafolios existentes. Consulta [el catálogo, sus fuentes y la actualización BMV](docs/BMV.md).

Usa una base o rama de desarrollo para los ejemplos. El saldo de demostración y el botón para agregar fondos solo manejan dinero virtual.

## Estructura

```text
frontend/       React, Vite, estilos y componentes
backend/        Proyecto Django, API, modelos, migraciones y pruebas
database/       Esquema PostgreSQL e INSERT de ejemplo
docs/           Mapa de migración y documentación de la base
scripts/        Preparación e inicio sin activar manualmente el entorno
.env.example    Plantilla de conexión y configuración
```

## Verificar

En PowerShell, después de preparar las dependencias:

```powershell
$env:DATABASE_URL = ''
$env:USE_SQLITE = 'true'
$env:DEBUG = 'true'
$env:DJANGO_DEBUG = 'true'
.\.venv\Scripts\python.exe backend/manage.py test core
.\.venv\Scripts\python.exe backend/manage.py makemigrations --check --dry-run
npm.cmd --prefix frontend run build
```

Las pruebas cubren autenticación, privacidad y consistencia de operaciones. SQLite permite verificarlas sin credenciales; para comprobar bloqueos concurrentes y conectividad real debes ejecutarlas con una base PostgreSQL de pruebas aislada. No ejecutes pruebas sobre datos que debas conservar.

Consulta los [resultados de verificación](docs/VERIFICACION.md), incluidas las pruebas del navegador sobre la compilación React servida por Django y los tamaños de pantalla comprobados.

## Despliegue

Compila `frontend` con `npm run build`, ejecuta `migrate` y `collectstatic`, y sirve Django con un servidor WSGI como Gunicorn en Linux (`gunicorn config.wsgi:application` desde `backend/`). Django sirve también la compilación React. Configura `DJANGO_DEBUG=false`, `ALLOWED_HOSTS`, orígenes HTTPS y una clave secreta propia; usa HTTPS para las cookies seguras. Nunca publiques `.env`, la base local o las referencias originales.

No se crea una base remota ni se publica la aplicación automáticamente. La conexión a tu instancia Neon requiere tu `DATABASE_URL`.

Referencias: [conexión Django con Neon](https://neon.com/blog/python-django-and-neons-serverless-postgres), [configuración de producción de Django](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/).
