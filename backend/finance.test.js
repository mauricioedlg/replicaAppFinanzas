import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { ApiError } from './common.js';
import { migrate, openDatabase } from './database.js';
import { mountFinance } from './finance.js';

test('operaciones financieras con PostgreSQL local', async (t) => {
  const db = await openDatabase({ localDemo: true, localDatabase: 'memory://' });
  t.after(() => db.close());
  await migrate(db);
  await db.query(`
    INSERT INTO usuarios (password, username, is_active, date_joined, email, nombre, telefono,
      cash_balance, notifications, dark_mode)
    VALUES ('!', 'exact', true, NOW(), 'exact@example.test', 'Exact', '', 9999999999999999.99, true, false),
           ('!', 'other', true, NOW(), 'other@example.test', 'Other', '', 1000.00, true, false)`);
  await db.query(`
    INSERT INTO acciones (symbol, nombre, sector, precio, cambio_porcentual, color, fecha_actualizacion)
    VALUES ('EXACT', '100% Productivo', 'Pruebas', 1.00, -2.00, '#22c55e', NOW()),
           ('OTHER', 'Otro Instrumento', 'Pruebas', 100.00, 1.25, '#22c55e', NOW())`);

  const app = express();
  app.use(express.json());
  const requireUser = async (req, _res, next) => {
    const { rows: [user] } = await db.query('SELECT * FROM usuarios WHERE id = $1', [req.get('x-test-user')]);
    if (!user) throw new ApiError(403, { detail: 'Se requiere una sesión.' });
    req.user = user;
    next();
  };
  mountFinance(app, { db, requireUser, requireCsrf: (_req, _res, next) => next() });
  app.use((error, _req, res, _next) => {
    if (error instanceof ApiError) return res.status(error.status).json(error.body);
    return res.status(500).json({ detail: error.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const api = async (path, { user = '1', body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Test-User': user, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  const trade = (body, user = '1') => api('/trades/', { user, body });

  await t.test('redondea medio centavo y conserva saldos grandes y exactos', async () => {
    const response = await trade({ stock_id: 1, quantity: '0.005000', side: 'buy', usuario: 2, precio: '0.00' });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.equal(response.data.cash_balance, '9999999999999999.98');
    assert.equal(response.data.transaction.monto, '0.01');
    assert.equal(response.data.transaction.precio_unitario, '1.00');
    assert.equal(response.data.transaction.cantidad, '0.005000');
    assert.equal(response.data.transaction.descripcion, 'Compra de 0.005 títulos de 100% Productivo');
    const dashboard = await api('/dashboard/');
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.data));
    assert.equal(dashboard.data.summary.total_equity, '9999999999999999.99');
    assert.equal(dashboard.data.holdings[0].allocation, '100.00');
    assert.equal(dashboard.data.chart.at(-1).value, '0.01');
    assert.equal('password' in dashboard.data.user, false);
    assert.deepEqual((await api('/transactions/?user_id=1', { user: '2' })).data, []);
    assert.deepEqual((await api('/portfolio/?user_id=1', { user: '2' })).data.holdings, []);
  });

  await t.test('serializa compras simultáneas y prorratea el costo al vender', async () => {
    const body = { stock_id: 2, quantity: '8', side: 'buy' };
    const attempts = await Promise.all([trade(body, '2'), trade(body, '2')]);
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [201, 400], JSON.stringify(attempts));
    assert.equal(attempts.find(({ status }) => status === 201).data.cash_balance, '200.00');

    const response = await trade({ stock_id: 2, quantity: '1.5', side: 'sell' }, '2');
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const portfolio = await api('/portfolio/', { user: '2' });
    assert.equal(portfolio.data.holdings[0].quantity, '6.500000');
    assert.equal(portfolio.data.holdings[0].invested, '650.00');
    assert.equal(portfolio.data.summary.cash_balance, '350.00');
  });

  await t.test('filtra fechas en Ciudad de México y busca texto literal', async () => {
    await db.query(`
      INSERT INTO transacciones (usuario_id, tipo, descripcion, cantidad, precio_unitario, monto, fecha)
      VALUES (2, 'deposit', 'Depósito de prueba', 0, 0, 50.00, '2026-01-02T02:00:00.123456Z')`);
    const transactions = await api('/transactions/?type=deposit&start=2026-01-01&end=2026-01-01', { user: '2' });
    assert.equal(transactions.status, 200, JSON.stringify(transactions.data));
    assert.equal(transactions.data.length, 1);
    assert.equal(transactions.data[0].fecha, '2026-01-01T20:00:00.123456-06:00');
    assert.equal(transactions.data[0].symbol, null);
    assert.deepEqual((await api('/transactions/?type=deposit&start=2026-01-02', { user: '2' })).data, []);
    assert.equal((await api('/transactions/?start=2026-02-30')).status, 400);
    assert.equal((await api('/transactions/?start=2026-12-31&end=2026-01-01')).status, 400);
    assert.deepEqual((await api('/stocks/?search=%25')).data.map(({ symbol }) => symbol), ['EXACT']);
    assert.equal((await trade({ stock_id: 1, side: 'buy', quantity: '0.0000001' })).status, 400);
  });

  await t.test('revierte toda la operación cuando falla el registro contable', async () => {
    await db.query("ALTER TABLE transacciones ADD CONSTRAINT test_ledger_error CHECK (tipo <> 'buy') NOT VALID");
    const response = await trade({ stock_id: 2, quantity: '1', side: 'buy' });
    assert.equal(response.status, 500);
    const portfolio = await api('/portfolio/');
    assert.equal(portfolio.data.summary.cash_balance, '9999999999999999.98');
    assert.equal(portfolio.data.holdings.length, 1);
    assert.equal((await api('/transactions/')).data.length, 1);
  });
});
