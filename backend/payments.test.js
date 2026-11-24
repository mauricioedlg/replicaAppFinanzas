import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import Stripe from 'stripe';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './database.js';
import { EmailDeliveryError } from './email.js';
import { deliverPendingPaymentEmails } from './payments.js';

test('el webhook firmado acredita una sola vez y el comprobante se reintenta', async (t) => {
  const config = loadConfig({ args: ['--local-demo'], env: {
    NODE_LOCAL_DATABASE: 'memory://',
    STRIPE_SECRET_KEY: 'sk_test_local_assertions',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_local_assertions',
    STRIPE_WEBHOOK_SECRET: 'whsec_local_assertions',
  } });
  const db = await openDatabase(config);
  t.after(() => db.close());
  await migrate(db);
  const { rows: [user] } = await db.query(`
    INSERT INTO usuarios (password, username, is_active, date_joined, email, nombre, telefono,
      cash_balance, notifications, dark_mode)
    VALUES ('!', 'payment-test', true, NOW(), 'payments@example.test', '', '', 1000.00, true, false)
    RETURNING id, email`);
  const cardId = randomUUID();
  const topupId = randomUUID();
  await db.query(`
    INSERT INTO payment_cards (id, usuario_id, request_id, stripe_customer_id, stripe_payment_method_id,
      brand, last4, verified_at, verified_email, created_at)
    VALUES ($1, $2, $3, 'cus_local', 'pm_local', 'visa', '4242', NOW(), $4, NOW())`,
  [cardId, user.id, randomUUID(), user.email]);
  await db.query(`
    INSERT INTO payment_topups (id, usuario_id, card_id, request_id, amount, currency,
      stripe_customer_id, stripe_payment_intent_id, status, created_at)
    VALUES ($1, $2, $3, $4, 500.00, 'mxn', 'cus_local', 'pi_local', 'pending', NOW())`,
  [topupId, user.id, cardId, randomUUID()]);

  const receiptAttempts = [];
  const email = { async send(message) {
    receiptAttempts.push(message);
    if (receiptAttempts.length === 1) throw new EmailDeliveryError('Correo temporalmente indisponible.');
  } };
  const { webhooks } = new Stripe(config.stripeSecretKey);
  const app = createApp({ db, config, email, stripe: { webhooks } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/stripe/webhook/`;
  const payment = {
    id: 'pi_local', object: 'payment_intent', livemode: false, status: 'succeeded',
    customer: 'cus_local', payment_method: 'pm_local', amount: 50000, amount_received: 50000,
    currency: 'mxn', metadata: { topup_id: topupId },
  };
  const event = (details = {}, type = 'payment_intent.succeeded') => ({
    id: `evt_${randomUUID()}`, object: 'event', livemode: false, type, data: { object: { ...payment, ...details } },
  });
  async function webhook(payload, signature) {
    const body = JSON.stringify(payload, null, 2);
    const response = await fetch(url, {
      method: 'POST', body, headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature ?? webhooks.generateTestHeaderString({ payload: body, secret: config.stripeWebhookSecret }),
      },
    });
    return { status: response.status, data: await response.json() };
  }

  await t.test('rechaza firmas, importes y tarjetas ajenos a la recarga', async () => {
    assert.equal((await webhook(event(), 't=1,v1=invalid')).status, 400);
    for (const details of [
      { amount_received: 49999 }, { customer: 'cus_other' }, { payment_method: 'pm_other' }, { livemode: true },
    ]) {
      assert.equal((await webhook(event(details))).status, 400);
    }
    const { rows: [unchanged] } = await db.query('SELECT cash_balance FROM usuarios WHERE id = $1', [user.id]);
    assert.equal(unchanged.cash_balance, '1000.00');
    assert.equal((await db.query('SELECT id FROM transacciones')).rows.length, 0);
  });

  await t.test('acepta un fallo seguido de un éxito y conserva un solo depósito', async () => {
    const failure = event({ payment_method: null, status: 'requires_payment_method' }, 'payment_intent.payment_failed');
    assert.deepEqual(await webhook(failure), { status: 200, data: { received: true } });
    assert.equal((await db.query('SELECT status FROM payment_topups')).rows[0].status, 'failed');
    const responses = await Promise.all([webhook(event()), webhook(event())]);
    for (const response of responses) assert.deepEqual(response, { status: 200, data: { received: true } });
    assert.equal((await webhook(failure)).status, 200);
    const { rows: [account] } = await db.query('SELECT cash_balance FROM usuarios WHERE id = $1', [user.id]);
    assert.equal(account.cash_balance, '1500.00');
    const { rows: [topup] } = await db.query('SELECT status, transaction_id FROM payment_topups');
    assert.equal(topup.status, 'succeeded');
    assert.ok(topup.transaction_id);
    assert.equal((await db.query("SELECT id FROM transacciones WHERE tipo = 'deposit'")).rows.length, 1);
    assert.equal((await db.query('SELECT id FROM payment_email_outbox')).rows.length, 1);
  });

  await t.test('reintenta el correo con la misma referencia sin volver a acreditar', async () => {
    assert.deepEqual(await deliverPendingPaymentEmails({ db, email }), { sent: 0, failed: 1 });
    assert.deepEqual(await deliverPendingPaymentEmails({ db, email }), { sent: 0, failed: 0 });
    await db.query("UPDATE payment_email_outbox SET next_attempt_at = NOW() - INTERVAL '1 second'");
    assert.deepEqual(await deliverPendingPaymentEmails({ db, email }), { sent: 1, failed: 0 });
    assert.deepEqual(await deliverPendingPaymentEmails({ db, email }), { sent: 0, failed: 0 });
    assert.equal(receiptAttempts[0].idempotencyKey, receiptAttempts[1].idempotencyKey);
    assert.equal(receiptAttempts[1].to, user.email);
    const { rows: [outbox] } = await db.query('SELECT attempts, sent_at FROM payment_email_outbox');
    assert.equal(outbox.attempts, 2);
    assert.ok(outbox.sent_at);
    assert.equal((await db.query("SELECT id FROM transacciones WHERE tipo = 'deposit'")).rows.length, 1);
  });
});
