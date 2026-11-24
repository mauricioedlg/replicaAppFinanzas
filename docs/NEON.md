# PostgreSQL con Neon

## Preparar la conexión

1. En **Connect** de Neon, selecciona la rama, base de datos y rol que usará la aplicación. Copia la cadena PostgreSQL con sus parámetros TLS.
2. Guarda la cadena como `DATABASE_URL` en `.env`, en la raíz del proyecto. La API lee ese archivo al iniciar.
3. Ejecuta la migración de Node.js desde la raíz.

```powershell
npm.cmd --prefix backend-node ci
npm.cmd --prefix backend-node run migrate
```

La migración prepara el esquema completo en una base vacía e incorpora `app_sessions` a la base configurada que ya contiene las tablas de la aplicación. Las cuentas y sus datos de negocio se conservan. Después de migrar una instalación existente, inicia sesión de nuevo desde la aplicación.

## Insertar los datos de ejemplo

Para preparar una rama de pruebas, ejecuta lo siguiente después de migrar.

```powershell
npm.cmd --prefix backend-node run seed:demo
```

El comando ejecuta `database/seed.sql` dentro de una transacción y omite los símbolos que ya existen. Solo incorpora la cuenta de ejemplo y su historial si su nombre de usuario y correo están disponibles. Puedes repetir el comando y conservar los saldos y movimientos existentes.

| Tabla | Datos de ejemplo |
| --- | --- |
| `usuarios` | Una cuenta con contraseña almacenada mediante PBKDF2. |
| `acciones` | 30 emisoras BMV con precios ilustrativos en MXN. |
| `portafolio` | Seis posiciones de ejemplo. |
| `transacciones` | Un depósito, seis compras y seis ventas parciales. |

Consulta [el catálogo BMV](BMV.md) para ver las emisoras y el saldo inicial de ejemplo.

## Comprobar el esquema y la carga

En el SQL Editor de la rama de Neon seleccionada, puedes contar los registros de negocio.

```sql
SELECT 'acciones' AS tabla, count(*) AS registros FROM acciones
UNION ALL
SELECT 'portafolio', count(*) FROM portafolio
UNION ALL
SELECT 'transacciones', count(*) FROM transacciones;
```

Una base nueva con los ejemplos tiene 30 acciones, seis posiciones y 13 transacciones. Si el servidor indica que faltan tablas, confirma que `DATABASE_URL` apunta a la base donde ejecutaste `migrate`. Para desarrollo local, el modo `--local-demo` ejecuta la misma migración en una base PGlite independiente.
