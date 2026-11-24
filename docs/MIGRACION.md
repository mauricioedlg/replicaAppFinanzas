# De SwiftUI a App Finanzas Mauricio web

La aplicación web usa React, Node.js y PostgreSQL en Neon. Conserva las cinco áreas de la app de iOS, además del registro y el inicio de sesión. Los archivos ZIP y el PDF son la referencia funcional.

Las referencias contienen dos estados distintos del proyecto. El ZIP de Swift tiene listas y cifras locales; el PDF de 41 páginas documenta una versión posterior que llama una API, compra desde Invertir y vende desde Portafolio. La adaptación conserva también estos flujos posteriores. La página 9 del PDF enumera las nueve pantallas, incluidas las vistas de compra y venta; las páginas 10 y 11 describen las cuatro tablas de MySQL. Se reemplaza esa infraestructura por PostgreSQL en Neon según la solicitud actual.

## Correspondencia funcional

| Proyecto SwiftUI | Versión web | Cambio |
| --- | --- | --- |
| `LoginView` y `RegistroView` | Acceso y registro | La API comprueba las contraseñas mediante hashes y mantiene una sesión por cookie. |
| `ContentView` | Navegación adaptable | Las mismas secciones quedan disponibles en escritorio y móvil. |
| `InicioView` | Inicio | El saludo utiliza el nombre del usuario autenticado; las cifras proceden de su cuenta. |
| `PortafolioView` y `PieChartView` | Portafolio | La distribución y los rendimientos se calculan con las posiciones y los precios de ejemplo, en lugar de porcentajes constantes. |
| `InvertirView` y detalle de compra del PDF | Mercado simulado | Se conserva la búsqueda de empresas y la compra se registra de forma persistente. |
| Detalle de venta desde Portafolio del PDF | Venta de una posición | La venta se puede iniciar desde una posición del usuario y actualiza su saldo e historial. |
| `TransaccionesView` | Historial | Las operaciones pertenecen al usuario autenticado y se guardan con fecha, cantidad, precio e importe. |
| `ConfiguracionView` | Configuración | Los datos de perfil y las preferencias dejan de depender de `UserDefaults`. |

## Datos y comportamiento

Las empresas, los precios y los movimientos iniciales son ejemplos para probar la aplicación. Todos los importes se expresan en pesos mexicanos (MXN). No se consultan cotizaciones en tiempo real y las operaciones no envían órdenes a una casa de bolsa.

El rendimiento de las posiciones compara su valor con su costo de adquisición. La serie del historial muestra el importe acumulado de compras menos ventas a partir de transacciones guardadas; no representa una serie de precios de mercado ni permite deducir rendimientos históricos.

El comando `npm.cmd --prefix backend-node run migrate` prepara el esquema. Las cuatro tablas de negocio representan usuarios, acciones, portafolio y transacciones. El portafolio guarda cantidades y costo de adquisición, y su porcentaje se obtiene al calcular la valuación.

Los cálculos de dinero y cantidades se hacen con valores decimales en el servidor. La compra o venta actualiza saldo, posición e historial dentro de una transacción de base de datos. Las validaciones del servidor impiden invertir más efectivo del disponible o vender más títulos de los que posee el usuario.

## Autenticación y privacidad

La versión web verifica la contraseña en el servidor y limita las consultas de posiciones e historial al usuario de la sesión.

El usuario de Mauricio se incluye en los datos de ejemplo con nombre, correo, nombre de usuario y teléfono solicitados. Su contraseña se guarda como un hash PBKDF2.

Las credenciales de Neon pertenecen únicamente al backend y se leen desde `DATABASE_URL`. No deben colocarse en variables `VITE_*`, porque esas variables terminan en el JavaScript enviado al navegador. La conexión a Neon conserva TLS mediante los parámetros de su cadena de conexión.

La opción de notificaciones guarda una preferencia de la cuenta. No configura un servicio de correo, SMS ni notificaciones push.

La venta se abre directamente desde cada posición del portafolio. El historial conserva fecha y hora, y las secciones actualizan sus datos al entrar o al volver a la ventana. El importe mínimo de una operación se explica antes de confirmar. La sección de información conserva la versión 1.0.0 del prototipo.

## Alcance de la migración

Se adaptaron las funciones del código proporcionado. No se copiaron bases de datos ni sesiones del prototipo: los ZIP contienen código, no una exportación de datos de producción. El script SQL proporciona datos nuevos de ejemplo y la cuenta solicitada.
