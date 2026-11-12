# Catálogo BMV

La aplicación incluye 30 empresas con acciones listadas directamente en la Bolsa Mexicana de Valores. Se interpreta «más grandes» como capitalización bursátil, no ingresos ni ponderación dentro del IPC. La selección se revisó el **12 de noviembre de 2026**; es un catálogo estático, no un ranking que se actualice automáticamente.

Se tomó como base [la clasificación por capitalización de Stock Analysis](https://stockanalysis.com/list/largest-companies-in-mexico/), excluyendo FIBRAs y otros fideicomisos, y se contrastó con [TradingView](https://www.tradingview.com/markets/stocks-mexico/market-movers-large-cap/). No se incluyen acciones extranjeras negociadas solamente mediante el SIC. Las fuentes pueden discrepar por series, unidades y hora de actualización; el catálogo no afirma un orden oficial entre emisoras. Banco del Bajío se incluye en el corte de capitalización de Stock Analysis, por encima de Vesta.

Fresnillo se incluye por su [listado directo activo en el mercado de capitales de la BMV](https://www.bmv.com.mx/es/emisoras/eventosrelevantes/FRES-7019-CGEN_CAPIT), aunque su domicilio sea extranjero. Minera Frisco se incorpora por su capitalización en TradingView y su [serie A-1 activa en BMV](https://www.bmv.com.mx/es/emisoras/informacionfinanciera/MFRISCO-7475). Se usa `SIGMAFA`, pues [Sigma Foods sustituyó la clave ALFA A por SIGMAF A](https://bmv.com.mx/docs-pub/eventemi/eventemi_1516241_1.pdf).

Los símbolos unen la clave y la serie sin espacios; se conservan el ampersand y los guiones de las series correspondientes. Los precios y variaciones de `backend/core/demo.py` son **ejemplos ficticios en MXN**, no cotizaciones obtenidas de estas fuentes.

| Símbolo | Empresa |
| --- | --- |
| AC | Arca Continental |
| AMXB | América Móvil |
| ASURB | Grupo Aeroportuario del Sureste |
| BBAJIOO | Banco del Bajío |
| BIMBOA | Grupo Bimbo |
| CEMEXCPO | CEMEX |
| CHDRAUIB | Chedraui |
| CMOCTEZ | Corporación Moctezuma |
| FEMSAUBD | FEMSA |
| FRES | Fresnillo |
| GAPB | Grupo Aeroportuario del Pacífico |
| GCARSOA1 | Grupo Carso |
| GFINBURO | Inbursa |
| GFNORTEO | Banorte |
| GMEXICOB | Grupo México |
| GRUMAB | Gruma |
| ICHB | Industrias CH |
| IDEALB-1 | IDEAL |
| KIMBERA | Kimberly-Clark de México |
| KOFUBL | Coca-Cola FEMSA |
| LIVEPOLC-1 | Liverpool |
| MFRISCOA-1 | Minera Frisco |
| OMAB | Grupo Aeroportuario del Centro Norte |
| PE&OLES | Industrias Peñoles |
| PINFRA | Pinfra |
| Q | Quálitas |
| SIGMAFA | Sigma Foods |
| SIMECB | Grupo Simec |
| VISTAA | Vista Energy |
| WALMEX | Walmart de México |

## Portafolio de Mauricio

El historial contiene un depósito de $89,720.50 MXN y una compra y una venta parcial de cada empresa solicitada. Las ventas ocurren después de sus compras; ningún movimiento deja el saldo o las cantidades en negativo. El costo de las ventas se descuenta al costo promedio, como en las operaciones de la aplicación.

| Empresa | Compradas | Vendidas | Restantes | Costo de la posición (MXN) |
| --- | ---: | ---: | ---: | ---: |
| CEMEX | 1,000 | 200 | 800 | $14,400.00 |
| Banorte | 120 | 20 | 100 | $19,000.00 |
| FEMSA | 80 | 10 | 70 | $11,900.00 |
| Walmart de México | 300 | 50 | 250 | $13,750.00 |
| Liverpool | 100 | 20 | 80 | $8,400.00 |
| Arca Continental | 80 | 10 | 70 | $15,400.00 |

Compras: $99,000.00. Ventas: $17,700.00. Saldo disponible: **$8,420.50 MXN**. Hay seis posiciones y 13 movimientos. Las fechas son relativas al día en que se cargan los ejemplos, dentro de los últimos 90 días.

## Convertir el catálogo anterior

Con las dependencias instaladas y la conexión configurada en `.env`, desde la raíz:

```powershell
.\.venv\Scripts\python.exe backend/manage.py seed_demo --replace-with-bmv
```

El comando usa la misma base configurada que Django. Para la base SQLite de desarrollo se debe seleccionar explícitamente `USE_SQLITE=true`. La conversión se ejecuta en una transacción: reemplaza las posiciones y el historial del usuario de ejemplo, retira los símbolos fuera del catálogo BMV y conserva los datos de acceso, perfil, preferencias y sesión. Si el usuario y el correo identifican cuentas diferentes, o alguna otra cuenta tiene movimientos o posiciones en las acciones anteriores, se cancela sin cambios.

Una vez retiradas las acciones anteriores, ejecutar de nuevo este comando no reinicia el portafolio ni duplica movimientos. `seed_demo` sin la opción conserva las cuentas existentes; `database/seed.sql` genera los mismos ejemplos para instalaciones nuevas, sin convertir datos anteriores.
