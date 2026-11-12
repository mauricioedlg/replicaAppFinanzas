"""BMV catalog with illustrative MXN prices and a fictional account ledger.

Only a Django-compatible salted password hash is stored in source.
Selection criteria and sources: docs/BMV.md. Prices are not live quotes.
"""
DEMO_USER = {
    "username": "mauricioedlg",
    "email": "mauricioestrada580@gmail.com",
    "nombre": "Mauricio Estrada De la Garza",
    "telefono": "81 2622 8609",
    "cash_balance": "8420.50",
    "password": "pbkdf2_sha256$1000000$JxGTt_D_ayKsN2KGpm-W5A$dnUUzm0RoJ701ob9uxE3SLMmzsw1QLsR/YV6qpZnVIU=",
}

# symbol, name, sector, example price MXN, example daily change, chart color
STOCKS = [
    ("GMEXICOB", "Grupo México", "Minería", "220.00", "1.20", "#c35b43"),
    ("AMXB", "América Móvil", "Telecomunicaciones", "23.50", "-0.65", "#2672b8"),
    ("WALMEX", "Walmart de México", "Comercio", "58.50", "0.85", "#0071ce"),
    ("FEMSAUBD", "FEMSA", "Consumo", "190.00", "1.35", "#b82c3b"),
    ("GFNORTEO", "Banorte", "Finanzas", "210.00", "0.90", "#d52b32"),
    ("KOFUBL", "Coca-Cola FEMSA", "Consumo", "220.00", "-0.45", "#b82732"),
    ("FRES", "Fresnillo", "Minería", "650.00", "1.80", "#90654b"),
    ("AC", "Arca Continental", "Consumo", "240.00", "1.10", "#d16936"),
    ("GCARSOA1", "Grupo Carso", "Industrial", "170.00", "0.60", "#2d6595"),
    ("PE&OLES", "Industrias Peñoles", "Minería", "770.00", "-1.20", "#8d7543"),
    ("BIMBOA", "Grupo Bimbo", "Consumo", "71.00", "0.40", "#c72e41"),
    ("CEMEXCPO", "CEMEX", "Materiales", "20.00", "1.65", "#2766a5"),
    ("GFINBURO", "Inbursa", "Finanzas", "45.50", "-0.30", "#245481"),
    ("GAPB", "Grupo Aeroportuario del Pacífico", "Aeropuertos", "440.00", "0.75", "#3c8590"),
    ("ASURB", "Grupo Aeroportuario del Sureste", "Aeropuertos", "505.00", "-0.55", "#5c7d3d"),
    ("LIVEPOLC-1", "Liverpool", "Comercio", "112.50", "-0.40", "#d34e8c"),
    ("IDEALB-1", "IDEAL", "Infraestructura", "43.00", "0.25", "#59816d"),
    ("PINFRA", "Pinfra", "Infraestructura", "310.00", "0.95", "#427b69"),
    ("VISTAA", "Vista Energy", "Energía", "1040.00", "1.55", "#bc873d"),
    ("SIGMAFA", "Sigma Foods", "Consumo", "20.50", "0.70", "#a83d42"),
    ("KIMBERA", "Kimberly-Clark de México", "Consumo", "39.00", "-0.25", "#546bb0"),
    ("MFRISCOA-1", "Minera Frisco", "Minería", "18.00", "-1.10", "#9c734a"),
    ("CHDRAUIB", "Chedraui", "Comercio", "110.00", "0.50", "#e17b33"),
    ("OMAB", "Grupo Aeroportuario del Centro Norte", "Aeropuertos", "245.00", "-0.80", "#3c8b9c"),
    ("GRUMAB", "Gruma", "Consumo", "325.00", "1.25", "#c39842"),
    ("Q", "Quálitas", "Finanzas", "205.00", "-0.35", "#7555a1"),
    ("CMOCTEZ", "Corporación Moctezuma", "Materiales", "85.00", "0.30", "#58935f"),
    ("SIMECB", "Grupo Simec", "Materiales", "135.00", "-0.60", "#657d96"),
    ("ICHB", "Industrias CH", "Materiales", "180.00", "0.20", "#697989"),
    ("BBAJIOO", "Banco del Bajío", "Finanzas", "60.00", "0.55", "#488476"),
]

# symbol, owned shares, total acquisition cost
HOLDINGS = [
    ("CEMEXCPO", "800", "14400.00"),
    ("GFNORTEO", "100", "19000.00"),
    ("FEMSAUBD", "70", "11900.00"),
    ("WALMEX", "250", "13750.00"),
    ("LIVEPOLC-1", "80", "8400.00"),
    ("AC", "70", "15400.00"),
]

# type, symbol or None, quantity, unit price, total amount, days before seeding
TRANSACTIONS = [
    ("deposit", None, "0", "0", "89720.50", 90),
    ("buy", "CEMEXCPO", "1000", "18.00", "18000.00", 82),
    ("buy", "GFNORTEO", "120", "190.00", "22800.00", 74),
    ("buy", "FEMSAUBD", "80", "170.00", "13600.00", 66),
    ("sell", "CEMEXCPO", "200", "20.50", "4100.00", 60),
    ("buy", "WALMEX", "300", "55.00", "16500.00", 56),
    ("sell", "GFNORTEO", "20", "205.00", "4100.00", 48),
    ("buy", "LIVEPOLC-1", "100", "105.00", "10500.00", 42),
    ("sell", "FEMSAUBD", "10", "185.00", "1850.00", 35),
    ("buy", "AC", "80", "220.00", "17600.00", 28),
    ("sell", "WALMEX", "50", "60.00", "3000.00", 20),
    ("sell", "LIVEPOLC-1", "20", "115.00", "2300.00", 10),
    ("sell", "AC", "10", "235.00", "2350.00", 3),
]
