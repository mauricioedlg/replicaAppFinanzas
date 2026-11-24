-- Folio: datos de ejemplo para PostgreSQL / Neon.
-- Requisito: ejecutar primero npm run migrate en backend-node.
-- Precios ficticios en MXN; las operaciones no son inversiones reales.
-- La cuenta usa un hash PBKDF2.
-- Se preservan los símbolos existentes y las cuentas ya registradas.
BEGIN;

-- 1. Acciones: 30 emisoras BMV con precios de ejemplo.
INSERT INTO "acciones" ("symbol", "nombre", "sector", "precio", "cambio_porcentual", "color", "fecha_actualizacion")
VALUES
    ('GMEXICOB', 'Grupo México', 'Minería', 220.00, 1.20, '#c35b43', CURRENT_TIMESTAMP),
    ('AMXB', 'América Móvil', 'Telecomunicaciones', 23.50, -0.65, '#2672b8', CURRENT_TIMESTAMP),
    ('WALMEX', 'Walmart de México', 'Comercio', 58.50, 0.85, '#0071ce', CURRENT_TIMESTAMP),
    ('FEMSAUBD', 'FEMSA', 'Consumo', 190.00, 1.35, '#b82c3b', CURRENT_TIMESTAMP),
    ('GFNORTEO', 'Banorte', 'Finanzas', 210.00, 0.90, '#d52b32', CURRENT_TIMESTAMP),
    ('KOFUBL', 'Coca-Cola FEMSA', 'Consumo', 220.00, -0.45, '#b82732', CURRENT_TIMESTAMP),
    ('FRES', 'Fresnillo', 'Minería', 650.00, 1.80, '#90654b', CURRENT_TIMESTAMP),
    ('AC', 'Arca Continental', 'Consumo', 240.00, 1.10, '#d16936', CURRENT_TIMESTAMP),
    ('GCARSOA1', 'Grupo Carso', 'Industrial', 170.00, 0.60, '#2d6595', CURRENT_TIMESTAMP),
    ('PE&OLES', 'Industrias Peñoles', 'Minería', 770.00, -1.20, '#8d7543', CURRENT_TIMESTAMP),
    ('BIMBOA', 'Grupo Bimbo', 'Consumo', 71.00, 0.40, '#c72e41', CURRENT_TIMESTAMP),
    ('CEMEXCPO', 'CEMEX', 'Materiales', 20.00, 1.65, '#2766a5', CURRENT_TIMESTAMP),
    ('GFINBURO', 'Inbursa', 'Finanzas', 45.50, -0.30, '#245481', CURRENT_TIMESTAMP),
    ('GAPB', 'Grupo Aeroportuario del Pacífico', 'Aeropuertos', 440.00, 0.75, '#3c8590', CURRENT_TIMESTAMP),
    ('ASURB', 'Grupo Aeroportuario del Sureste', 'Aeropuertos', 505.00, -0.55, '#5c7d3d', CURRENT_TIMESTAMP),
    ('LIVEPOLC-1', 'Liverpool', 'Comercio', 112.50, -0.40, '#d34e8c', CURRENT_TIMESTAMP),
    ('IDEALB-1', 'IDEAL', 'Infraestructura', 43.00, 0.25, '#59816d', CURRENT_TIMESTAMP),
    ('PINFRA', 'Pinfra', 'Infraestructura', 310.00, 0.95, '#427b69', CURRENT_TIMESTAMP),
    ('VISTAA', 'Vista Energy', 'Energía', 1040.00, 1.55, '#bc873d', CURRENT_TIMESTAMP),
    ('SIGMAFA', 'Sigma Foods', 'Consumo', 20.50, 0.70, '#a83d42', CURRENT_TIMESTAMP),
    ('KIMBERA', 'Kimberly-Clark de México', 'Consumo', 39.00, -0.25, '#546bb0', CURRENT_TIMESTAMP),
    ('MFRISCOA-1', 'Minera Frisco', 'Minería', 18.00, -1.10, '#9c734a', CURRENT_TIMESTAMP),
    ('CHDRAUIB', 'Chedraui', 'Comercio', 110.00, 0.50, '#e17b33', CURRENT_TIMESTAMP),
    ('OMAB', 'Grupo Aeroportuario del Centro Norte', 'Aeropuertos', 245.00, -0.80, '#3c8b9c', CURRENT_TIMESTAMP),
    ('GRUMAB', 'Gruma', 'Consumo', 325.00, 1.25, '#c39842', CURRENT_TIMESTAMP),
    ('Q', 'Quálitas', 'Finanzas', 205.00, -0.35, '#7555a1', CURRENT_TIMESTAMP),
    ('CMOCTEZ', 'Corporación Moctezuma', 'Materiales', 85.00, 0.30, '#58935f', CURRENT_TIMESTAMP),
    ('SIMECB', 'Grupo Simec', 'Materiales', 135.00, -0.60, '#657d96', CURRENT_TIMESTAMP),
    ('ICHB', 'Industrias CH', 'Materiales', 180.00, 0.20, '#697989', CURRENT_TIMESTAMP),
    ('BBAJIOO', 'Banco del Bajío', 'Finanzas', 60.00, 0.55, '#488476', CURRENT_TIMESTAMP)
ON CONFLICT ("symbol") DO NOTHING;

-- 2. Usuario y ejemplos de sus posiciones y transacciones.
-- Si el usuario o correo ya existen, no se modifica su saldo ni historial.
DO $folio_seed$
DECLARE
    demo_user_id bigint;
BEGIN
    INSERT INTO "usuarios" ("password", "username", "email", "is_active", "date_joined", "nombre", "telefono", "cash_balance", "notifications", "dark_mode")
    VALUES ('pbkdf2_sha256$1000000$JxGTt_D_ayKsN2KGpm-W5A$dnUUzm0RoJ701ob9uxE3SLMmzsw1QLsR/YV6qpZnVIU=', 'mauricioedlg', 'mauricioestrada580@gmail.com', true, CURRENT_TIMESTAMP, 'Mauricio Estrada De la Garza', '81 2622 8609', 8420.50, true, false)
    ON CONFLICT DO NOTHING RETURNING "id" INTO demo_user_id;

    IF demo_user_id IS NULL THEN
        RAISE NOTICE 'La cuenta de ejemplo ya existe (usuario o correo). Se conserva sin cambios.';
        RETURN;
    END IF;

    -- 3. Portafolio: 6 posiciones; las relaciones se buscan por símbolo.
    INSERT INTO "portafolio" ("usuario_id", "accion_id", "quantity", "invested")
    SELECT demo_user_id, a."id", examples.quantity, examples.invested
    FROM (VALUES
        ('CEMEXCPO', 800, 14400.00),
        ('GFNORTEO', 100, 19000.00),
        ('FEMSAUBD', 70, 11900.00),
        ('WALMEX', 250, 13750.00),
        ('LIVEPOLC-1', 80, 8400.00),
        ('AC', 70, 15400.00)
    ) AS examples(symbol, quantity, invested)
    JOIN "acciones" a ON a."symbol" = examples.symbol;

    -- 4. Transacciones: 13 movimientos que explican las posiciones y saldo.
    INSERT INTO "transacciones" ("usuario_id", "accion_id", "tipo", "descripcion", "cantidad", "precio_unitario", "monto", "fecha")
    SELECT demo_user_id, a."id", examples.tipo, examples.descripcion, examples.cantidad, examples.precio_unitario, examples.monto, CURRENT_TIMESTAMP - examples.days_ago * INTERVAL '1 day'
    FROM (VALUES
        ('deposit', NULL, 'Depósito de saldo de simulación', 0, 0, 89720.50, 90),
        ('buy', 'CEMEXCPO', 'Compra de 1000 títulos de CEMEX', 1000, 18.00, 18000.00, 82),
        ('buy', 'GFNORTEO', 'Compra de 120 títulos de Banorte', 120, 190.00, 22800.00, 74),
        ('buy', 'FEMSAUBD', 'Compra de 80 títulos de FEMSA', 80, 170.00, 13600.00, 66),
        ('sell', 'CEMEXCPO', 'Venta de 200 títulos de CEMEX', 200, 20.50, 4100.00, 60),
        ('buy', 'WALMEX', 'Compra de 300 títulos de Walmart de México', 300, 55.00, 16500.00, 56),
        ('sell', 'GFNORTEO', 'Venta de 20 títulos de Banorte', 20, 205.00, 4100.00, 48),
        ('buy', 'LIVEPOLC-1', 'Compra de 100 títulos de Liverpool', 100, 105.00, 10500.00, 42),
        ('sell', 'FEMSAUBD', 'Venta de 10 títulos de FEMSA', 10, 185.00, 1850.00, 35),
        ('buy', 'AC', 'Compra de 80 títulos de Arca Continental', 80, 220.00, 17600.00, 28),
        ('sell', 'WALMEX', 'Venta de 50 títulos de Walmart de México', 50, 60.00, 3000.00, 20),
        ('sell', 'LIVEPOLC-1', 'Venta de 20 títulos de Liverpool', 20, 115.00, 2300.00, 10),
        ('sell', 'AC', 'Venta de 10 títulos de Arca Continental', 10, 235.00, 2350.00, 3)
    ) AS examples(tipo, symbol, descripcion, cantidad, precio_unitario, monto, days_ago)
    LEFT JOIN "acciones" a ON a."symbol" = examples.symbol;
END;
$folio_seed$;

COMMIT;
