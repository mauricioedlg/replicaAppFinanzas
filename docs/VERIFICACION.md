# Verificación de App Finanzas

Desde la raíz del repositorio instala las dependencias y ejecuta las pruebas.

```powershell
npm.cmd --prefix backend-node ci
npm.cmd --prefix frontend ci
npm.cmd --prefix backend-node test
npm.cmd --prefix frontend run build -- --configLoader runner
```

Las pruebas de Node.js crean bases PGlite temporales y simulan los proveedores externos. Cubren el registro y la recuperación, la revocación de sesiones, el aislamiento de las cuentas, la precisión de los importes, las compras simultáneas y la acreditación única de recargas con webhook firmado.

## Verificar el arranque

Con una [base local preparada](../README.md#desarrollo-local), inicia React y la API.

```powershell
npm.cmd --prefix backend-node run dev -- --local-demo
```

Comprueba la API desde otra terminal.

```powershell
Invoke-RestMethod http://127.0.0.1:5173/api/health/
```

La respuesta devuelve el estado `ok`. En el navegador, la aplicación abre en **http://127.0.0.1:5173**. Para probar la compilación servida por Express, detén el servidor de desarrollo, ejecuta `npm.cmd --prefix backend-node start -- --local-demo` y abre **http://127.0.0.1:8000**.

Los flujos manuales requieren configurar [Resend](RECUPERACION.md) para la entrega de códigos, y el [entorno de pruebas de Stripe](STRIPE.md) para activar tarjetas y simular recargas.

## Verificaciones de interfaz de noviembre de 2026

- Las cinco secciones se revisaron a 320, 390, 768, 1024 y 1440 píxeles.
- Las pantallas de acceso y recuperación se comprobaron a 320, 390, 768 y 1440 píxeles. Las capturas locales se guardaron en `artifacts/screenshots/`.
- El catálogo BMV y los diálogos de compraventa se probaron con la API simulada. La prueba de pagos en el navegador usó Stripe simulado y cubrió el registro, la verificación y la eliminación de una tarjeta, además de la recarga y su recuperación después de actualizar la página.
