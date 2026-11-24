import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './database.js';
import { createSessions } from './sessions.js';

async function createAccount(db, username, balance) {
  const { rows: [account] } = await db.query(`
    INSERT INTO usuarios (password, username, is_active, date_joined, email, nombre, telefono,
      cash_balance, notifications, dark_mode)
    VALUES ('!', $1, true, now(), $2, '', '', $3, true, false) RETURNING *`,
  [username, `${username}@example.test`, balance]);
  return account;
}

async function createCard(db, account, last4, disabled = false) {
  const id = randomUUID();
  await db.query(`
    INSERT INTO payment_cards (id, usuario_id, request_id, stripe_customer_id, stripe_payment_method_id,
      brand, last4, exp_month, exp_year, verified_at, verified_email, disabled_at, created_at)
    VALUES ($1, $2, $3, $4, $5, 'visa', $6, 12, 2099, now(), $7, CASE WHEN $8 THEN now() END, now())`,
  [id, account.id, randomUUID(), `cus_${account.id}`, `pm_${id}`, last4, account.email, disabled]);
  return id;
}

async function createTopUp(db, account, cardId, creditedAt = null) {
  const id = randomUUID();
  const transactionId = creditedAt && (await db.query(`
    INSERT INTO transacciones (usuario_id, tipo, descripcion, cantidad, precio_unitario, monto, fecha)
    VALUES ($1, 'deposit', 'Recarga de prueba', 0, 0, 50, $2) RETURNING id`, [account.id, creditedAt])).rows[0].id;
  await db.query(`
    INSERT INTO payment_topups (id, usuario_id, card_id, request_id, amount, currency,
      stripe_customer_id, stripe_payment_intent_id, status, credited_at, transaction_id, created_at)
    VALUES ($1, $2, $3, $4, 50, 'mxn', $5, $6, $7, $8, $9, COALESCE($8, now()))`,
  [id, account.id, cardId, randomUUID(), `cus_${account.id}`, `pi_${id}`,
    creditedAt ? 'succeeded' : 'pending', creditedAt, transactionId]);
}

async function accountHeaders(db, sessions, user) {
  const cookies = new Map();
  const commitCookies = await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM usuarios WHERE id = $1 FOR UPDATE', [user.id]);
    return sessions.establish({ cookies: {} }, { cookie: (name, value) => cookies.set(name, value) }, tx, user);
  });
  commitCookies();
  return {
    Cookie: `sessionid=${cookies.get('sessionid')}; csrftoken=${cookies.get('csrftoken')}`,
    'X-CSRFToken': cookies.get('csrftoken'),
  };
}

test('retiros simulados a tarjetas de recargas acreditadas', async (t) => {
  const config = loadConfig({ args: ['--local-demo'], env: { NODE_LOCAL_DATABASE: 'memory://' } });
  const db = await openDatabase(config);
  t.after(() => db.close());
  await migrate(db);
  const member = await createAccount(db, 'withdraw-member', '125.50');
  const other = await createAccount(db, 'withdraw-other', '75.00');
  const eligible = await createCard(db, member, '4242');
  const rotation = await createCard(db, member, '5151');
  const uncredited = await createCard(db, member, '9898');
  const removed = await createCard(db, member, '6789', true);
  const foreign = await createCard(db, other, '1111');
  await createTopUp(db, member, eligible, '2026-01-01T00:00:00Z');
  await createTopUp(db, member, rotation, '2026-01-02T00:00:00Z');
  await createTopUp(db, member, eligible, '2026-01-03T00:00:00Z');
  await createTopUp(db, member, uncredited);
  await createTopUp(db, member, removed, '2026-01-04T00:00:00Z');
  await createTopUp(db, other, foreign, '2026-01-04T00:00:00Z');

  const sessions = createSessions(db, config);
  const memberHeaders = await accountHeaders(db, sessions, member);
  const otherHeaders = await accountHeaders(db, sessions, other);
  const server = createApp({ db, config, stripe: {} }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = `http://127.0.0.1:${server.address().port}/api`;
  async function get(path, headers = memberHeaders) {
    const response = await fetch(`${api}${path}`, { headers });
    return { status: response.status, body: await response.json() };
  }
  async function withdraw({ card = eligible, amount = '25.50', requestId = randomUUID() } = {}, headers = memberHeaders) {
    const response = await fetch(`${api}/withdrawals/`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: card, amount, request_id: requestId }),
    });
    return { status: response.status, body: await response.json() };
  }

  await t.test('solo ofrece tarjetas propias de recargas acreditadas, una vez cada una', async () => {
    const result = await get('/withdrawals/');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      cards: [
        { id: eligible, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2099 },
        { id: rotation, brand: 'visa', last4: '5151', exp_month: 12, exp_year: 2099 },
      ],
      cash_balance: '125.50',
    });
    const otherResult = await get('/withdrawals/', otherHeaders);
    assert.deepEqual(otherResult.body.cards.map(({ id }) => id), [foreign]);
  });

  await t.test('rechaza sesiones, tarjetas o importes inválidos sin descontar saldo', async () => {
    assert.equal((await get('/withdrawals/', {})).status, 403);
    assert.equal((await withdraw({}, { Cookie: memberHeaders.Cookie })).status, 403);
    for (const card of [foreign, uncredited, removed]) assert.equal((await withdraw({ card })).status, 400);
    for (const amount of ['0.00', '-10.00', '1.001', '125.51']) assert.equal((await withdraw({ amount })).status, 400);
    assert.equal((await get('/withdrawals/')).body.cash_balance, '125.50');
    assert.equal((await db.query('SELECT id FROM payment_withdrawals')).rows.length, 0);
  });

  await t.test('registra un solo retiro si se reintenta, y evita gastar el mismo saldo dos veces', async () => {
    const requestId = randomUUID();
    const results = await Promise.all([withdraw({ requestId }), withdraw({ requestId })]);
    const first = results[0].body.withdrawal;
    for (const { status, body } of results) {
      assert.equal(status, 201);
      assert.equal(body.withdrawal.id, first.id);
      assert.equal(body.withdrawal.status, 'succeeded');
      assert.equal(body.withdrawal.amount, '25.50');
      assert.equal(body.withdrawal.card.last4, '4242');
      assert.ok(Number.isFinite(Date.parse(body.withdrawal.created_at)));
      assert.equal(body.cash_balance, '100.00');
    }
    assert.equal((await withdraw({ requestId, amount: '25.51' })).status, 409);
    const competing = await Promise.all([withdraw({ amount: '100.00' }), withdraw({ amount: '100.00' })]);
    assert.deepEqual(competing.map(({ status }) => status).sort(), [201, 400]);
    await db.query('UPDATE payment_cards SET disabled_at = now() WHERE id = $1', [eligible]);
    const retry = await withdraw({ requestId });
    assert.equal(retry.body.withdrawal.id, first.id);
    assert.equal(retry.body.cash_balance, '0.00');
    const history = await get('/transactions/?type=withdrawal');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.map(({ tipo, monto }) => [tipo, monto]), [['withdrawal', '100.00'], ['withdrawal', '25.50']]);
    assert.match(history.body[0].descripcion, /4242/);
    assert.deepEqual((await get('/transactions/?type=withdrawal', otherHeaders)).body, []);
    assert.equal((await get('/withdrawals/', otherHeaders)).body.cash_balance, '75.00');
    const { rows } = await db.query(`
      SELECT w.amount, t.monto, t.accion_id FROM payment_withdrawals w JOIN transacciones t ON t.id = w.transaction_id
      ORDER BY w.amount`);
    assert.deepEqual(rows, [
      { amount: '25.50', monto: '25.50', accion_id: null },
      { amount: '100.00', monto: '100.00', accion_id: null },
    ]);
  });
});
