# Entrega y verificación de App Finanzas Mauricio

La versión web usa React, Django REST Framework y PostgreSQL mediante `DATABASE_URL`. Se conservaron los flujos del proyecto Swift y de la versión posterior documentada en el PDF. La instancia Neon configurada se verificó y actualizó en las intervenciones de acceso y catálogo BMV descritas abajo.

## Funciones completadas

- Registro, acceso por usuario o correo y cierre de sesión.
- Inicio con cifras calculadas para la cuenta autenticada.
- Portafolio con distribución, cantidades, valor actual y costo de inversión.
- Compra desde el catálogo y venta directa desde cada posición del portafolio.
- Operaciones decimales, importe mínimo explicado, saldo suficiente y límites de títulos.
- Historial con fecha y hora, búsqueda, filtros y exportación CSV.
- Perfil, tema oscuro y preferencia de notificaciones persistentes.
- Actualización de datos al navegar entre secciones y al volver a la ventana.
- Reinicio de la interfaz cuando termina la sesión, sin conservar el diálogo de otra cuenta.
- Interfaz móvil, tabla de portafolio desplazable y gráfica que se adapta al ancho disponible.

## Comprobaciones realizadas

| Comprobación | Resultado |
| --- | --- |
| Pruebas Django de autenticación, privacidad, perfil y operaciones | 24 correctas con base de pruebas SQLite |
| Compatibilidad de la API con PostgreSQL embebido | 23 pruebas correctas en la primera validación; la prueba adicional posterior verifica el límite de intentos de acceso |
| Migraciones pendientes | Ninguna; `makemigrations --check --dry-run` correcto |
| Configuración de producción | `check --deploy` correcto con clave propia y opciones de producción |
| Preparación documentada | `python scripts/setup.py --local-demo --skip-install` completado: migraciones, ejemplos, compilación y archivos estáticos |
| SQL PostgreSQL | Esquema e INSERT ejecutados con PGlite; relaciones, restricciones, saldo, cantidades y segunda ejecución comprobados |
| Navegador con Vite | Acceso, registro, operaciones, CSV, preferencias y expiración de sesión correctos |
| Navegador con React compilado servido por Django | Los mismos flujos correctos, sin errores JavaScript |
| Anchos de pantalla | Las cinco secciones comprobadas a 320, 390, 768, 1024 y 1440 píxeles, sin desbordamiento de la página |
| Usuario solicitado | Nombre, correo, usuario y teléfono incluidos; contraseña proporcionada comprobada contra su hash Django |

Las capturas locales están en `artifacts/screenshots/`. Las cuentas temporales creadas para probar las operaciones se retiraron al terminar; se conservan la cuenta y los ejemplos solicitados.

## Recuperación de contraseña · 11 de noviembre de 2026

- 55 pruebas Django correctas en SQLite aislado: las 24 anteriores y 31 nuevas de recuperación y transporte Resend. Cubren código, caducidad, límites, consumo único, CSRF, validación de contraseña, cierre de sesiones y fallos del proveedor.
- Dos pruebas de navegador correctas sobre React compilado servido por Django: recuperación completa y fallo del correo de confirmación con contraseña actualizada. Se comprobó el código incorrecto, la confirmación de contraseña, el rechazo de la contraseña anterior y el acceso con la nueva.
- Pantallas de recuperación y resultado comprobadas a 320, 390, 768 y 1440 píxeles sin desbordamiento horizontal ni errores JavaScript. Capturas en `artifacts/screenshots/recovery-*.png`.
- Compilación correcta con `npm.cmd --prefix frontend run build -- --configLoader runner`. Este argumento evita una restricción local de lectura de directorios superiores durante la carga de la configuración de Vite.
- `makemigrations --check --dry-run` correcto. La migración `0002_password_reset_challenge` se aplicó en las bases aisladas de pruebas.
- Esquema PostgreSQL actualizado y validado con PGlite, incluidas la nueva tabla de recuperación y la conservación de los ejemplos de negocio al repetir la carga.

Todos los envíos se simularon. Falta completar los valores de Resend en `.env`, aplicar `migrate` a la base habitual y comprobar una entrega real. Estas verificaciones no modificaron la base remota ni enviaron correos reales. Consulta [la guía de configuración](RECUPERACION.md).

## Acceso por correo y sesión persistente · 11 de noviembre de 2026

- 82 pruebas Django correctas: incluyen 27 pruebas nuevas de códigos de acceso, registro, persistencia, revocación entre dispositivos y transporte de correo. Las pruebas anteriores se adaptaron para confirmar el código antes de acceder.
- Cuatro pruebas de navegador correctas: dos de recuperación, una de registro con código y una de sesión persistente con reemplazo de dispositivo. La sesión se restauró en un nuevo contexto de navegador conservando la cookie y sin reenviar el correo.
- Al iniciar acceso desde otro dispositivo, el primero conserva el acceso hasta verificar el código del segundo. Después de verificar, la sesión anterior obtiene acceso denegado; cerrar sesión en el segundo obliga a autenticarse otra vez.
- Pantalla de código comprobada a 320, 390, 768 y 1440 píxeles sin desbordamiento. Capturas en `artifacts/screenshots/login-code-390.png` y `login-code-1440.png`.
- Compilación React correcta, `makemigrations --check --dry-run` sin diferencias y esquema/ejemplos PostgreSQL comprobados con PGlite.
- Migración `0003_login_verification_sessions` aplicada a la base Neon configurada. Añade el campo de sesión activa y la tabla de códigos sin alterar saldos o inversiones; las sesiones anteriores deben verificarse nuevamente.

Los envíos de las pruebas se simularon. La entrega real depende de la configuración de Resend existente. Las pruebas de navegador usan archivos SQLite de pruebas separados para que las solicitudes concurrentes tengan conexiones independientes. Consulta [la guía de acceso](ACCESO.md).

## Nombre y diseño de acceso · 11 de noviembre de 2026

La aplicación se presenta como **App Finanzas Mauricio** en el acceso, la navegación, los mensajes, el título de la página y los correos. El diseño toma la composición de la captura original Swift de la página 3 del PDF: formulario en una columna centrada, campos redondeados y botón de ancho completo. Se aplicaron el fondo verde y las letras blancas solicitados a login, registro, recuperación y verificación de códigos.

- Compilación React correcta y 82 pruebas Django correctas con correo simulado.
- Cuatro pruebas completas en navegador correctas: registro con código, sesión persistente y cambio de dispositivo, recuperación normal y recuperación con fallo del correo de confirmación.
- Pantallas verificadas a 320, 390, 768 y 1440 píxeles sin desbordamiento horizontal. Capturas actuales en `artifacts/screenshots/mauricio-*.png` y `recovery-mobile-email.png`.
- Se corrigieron caracteres acentuados y se preservó el texto blanco en avisos y pasos de recuperación, incluso si se fuerza el tema oscuro del navegador.

Este cambio no requiere migraciones adicionales. La compilación actual está en `frontend/dist` y puede verse al recargar la aplicación.

## Catálogo y portafolio BMV · 12 de noviembre de 2026

- 91 pruebas Django correctas en SQLite aislado. Incluyen las 82 anteriores y nueve pruebas del catálogo BMV, compra/venta, conciliación cronológica, preservación de cuentas y reversión de la actualización cuando otra cuenta tiene referencias a las acciones anteriores.
- Catálogo con 30 emisoras, seis posiciones, seis compras, seis ventas parciales y un depósito. Comprobados los importes, las cantidades restantes y el costo promedio, sin saldo ni posiciones negativos en el historial.
- Compilación React y archivos estáticos actualizados. Catálogo y diálogos de operación comprobados con API simulada a 320, 390, 768 y 1440 píxeles, sin desbordamiento ni errores JavaScript.
- SQL PostgreSQL generado desde los mismos ejemplos y ejecutado con PGlite: esquema, cantidades, saldo e idempotencia correctos. `makemigrations --check --dry-run` sin diferencias; `manage.py check` sin incidencias.
- Conversión aplicada a la base Neon configurada y a la base SQLite local, con respaldos financieros previos en `.qa/backups/`. En la base local también se aplicaron las migraciones de acceso que estaban pendientes.
- Las API de catálogo, portafolio e historial devolvieron 30, seis y 13 registros respectivamente para Mauricio en ambas bases. Valor del portafolio: $90,725.00; costo: $82,850.00; saldo disponible: $8,420.50; patrimonio simulado: $99,145.50 MXN.
- Se verificó que la identidad, contraseña, preferencias y sesión de Mauricio se conservaran, al igual que los datos de la otra cuenta existente en Neon. No se enviaron correos ni órdenes reales.

Consulta [las emisoras, fuentes y criterios de selección](BMV.md).

## Alcance de los datos y de Neon

Los precios, saldos y órdenes son ejemplos de simulación. El historial de la gráfica representa compras acumuladas menos ingresos por ventas; no es una serie de cotizaciones históricas. La preferencia de notificaciones no configura correo, SMS ni push.

Para configurar otra instancia de Neon, prepara `.env` según [NEON.md](NEON.md) y ejecuta la preparación sin `--local-demo`. La actualización BMV sí se aplicó a la conexión Neon existente; las pruebas automatizadas aisladas y PostgreSQL embebido no sustituyen una prueba de concurrencia contra un servidor PostgreSQL real.
