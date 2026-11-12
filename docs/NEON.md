# PostgreSQL con Neon

## Preparar la conexión

1. Crea un proyecto y una base de datos en tu cuenta de Neon. Para pruebas utiliza una rama de desarrollo.
2. En **Connect**, selecciona la base y el rol correspondientes y copia la cadena de conexión de PostgreSQL. Conserva los parámetros de seguridad que agrega Neon, como `sslmode=require`.
3. Copia `.env.example` a `.env` en la raíz del proyecto y asigna esa cadena a `DATABASE_URL`. No compartas el archivo `.env` ni incluyas esta cadena en el frontend.
4. Instala las dependencias del backend siguiendo el README principal y ejecuta las migraciones:

```powershell
.\.venv\Scripts\python.exe backend\manage.py migrate
```

Las migraciones crean las tablas de negocio y las tablas de Django para sesiones, permisos y administración. No debes crear a mano las tablas de autenticación.

## Insertar los datos solicitados

Después de `migrate`, abre el SQL Editor de Neon, selecciona la misma rama y base indicadas en `DATABASE_URL`, y ejecuta el contenido completo de `database/seed.sql`.

También puedes insertar los mismos ejemplos desde Django:

```powershell
.\.venv\Scripts\python.exe backend\manage.py seed_demo
```

El script incluye registros de las cuatro tablas de negocio:

| Tabla | Ejemplos |
| --- | --- |
| `usuarios` | La cuenta `mauricioedlg` con nombre, correo y teléfono proporcionados; no tiene privilegios administrativos. |
| `acciones` | 30 emisoras de la BMV con precios ilustrativos expresados en MXN. |
| `portafolio` | Seis posiciones: CEMEX, Banorte, FEMSA, Walmart de México, Liverpool y Arca Continental. |
| `transacciones` | Un depósito, seis compras y seis ventas parciales que explican el saldo y las posiciones iniciales. |

La contraseña del usuario solicitado se almacena como un hash PBKDF2 de Django. Para iniciar sesión utiliza la contraseña de tu solicitud y el nombre de usuario o correo indicados. Los datos de ejemplo no son un respaldo de una cuenta de inversión real.

El script se ejecuta dentro de una transacción y omite los símbolos de acciones que ya existen. Solo incorpora la cuenta y su historial si el nombre de usuario y el correo no están registrados. Repetir el script no reinicia el saldo, no cambia contraseñas y no duplica operaciones. Si ya registraste una cuenta con ese usuario o correo, debes conservarla; el script no la reemplaza.

Para una base que aún tiene las acciones extranjeras del catálogo anterior, usa `python backend/manage.py seed_demo --replace-with-bmv` desde la raíz. Esta conversión explícita reemplaza únicamente los ejemplos financieros de Mauricio y retira las acciones anteriores; conserva su identidad, contraseña, sesión y preferencias. Si otra cuenta tiene referencias a esas acciones, revierte toda la operación. Consulta [la actualización BMV](BMV.md). El SQL de ejemplos no realiza esta conversión.

Las tablas internas de Django se llenan según su función: `migrate` registra las migraciones y prepara permisos, mientras que el inicio de sesión crea la sesión. No se insertan sesiones de ejemplo ni permisos de administrador en el SQL de negocio.

## Esquema

`database/schema.sql` es una referencia de las sentencias PostgreSQL generadas a partir de la migración inicial de la aplicación. Las migraciones son la fuente de verdad: para instalar la app utiliza `manage.py migrate`, y después `seed.sql`. Ejecutar manualmente el esquema y luego `migrate` en la misma base causaría conflictos por tablas existentes.

La conexión real a una cuenta de Neon requiere tu propia `DATABASE_URL`; no viene incluida en el proyecto. El modo `USE_SQLITE=true` permite una prueba local explícita, pero no reemplaza la configuración PostgreSQL de la aplicación.

## Comprobar la carga

En el SQL Editor puedes revisar las cantidades sin exponer hashes:

```sql
SELECT username, nombre, email, telefono, cash_balance
FROM usuarios
WHERE username = 'mauricioedlg';

SELECT 'acciones' AS tabla, count(*) AS registros FROM acciones
UNION ALL
SELECT 'portafolio', count(*) FROM portafolio
UNION ALL
SELECT 'transacciones', count(*) FROM transacciones;
```

En una base nueva los resultados de negocio son un usuario de ejemplo, 30 acciones, seis posiciones y 13 transacciones. Los registros creados posteriormente por el uso de la app incrementan estos totales.

Documentación de referencia: [conexión de Django a Neon](https://neon.com/docs/guides/django) y [bases de datos de Django](https://docs.djangoproject.com/en/5.2/ref/databases/).

## Si el acceso falla por `django_session`

El mensaje `relation "django_session" does not exist` indica que faltan las migraciones de sesiones en la base seleccionada por el backend. Puede aparecer después de que Django haya aceptado la contraseña, al intentar guardar la sesión. Mantén las contraseñas como hashes; no las reemplaces por texto plano en PostgreSQL.

Desde `backend/`, la instalación habitual se completa con:

```powershell
python manage.py migrate
python manage.py seed_demo
```

Luego actualiza la página e inicia sesión. El aviso de migraciones pendientes al iniciar Django también debe desaparecer.

Si `migrate` encuentra tablas que ya existen porque se ejecutó manualmente `schema.sql`, hay que verificar y conciliar ese esquema antes de registrar la migración inicial. No borres las tablas para resolver el acceso. `--fake-initial` comprueba principalmente nombres de tablas, no garantiza que coincidan columnas, relaciones, restricciones e índices; esas diferencias deben revisarse y completarse antes de usarlo. Consulta las [migraciones iniciales de Django](https://docs.djangoproject.com/en/5.2/topics/migrations/#initial-migrations).
