import { randomInt, randomUUID } from 'node:crypto';
import { ApiError, escapeHtml, saltedHmac, secureEqual, uuid } from './common.js';
import { formatDecimal, maxMoney, parseDecimal, readDecimal } from './decimal.js';
import { EmailDeliveryError } from './email.js';

const unavailable = 'Los pagos de prueba todavía no están disponibles. Inténtalo más tarde.';
const invalidCode = 'El código es inválido o ha vencido. Solicita uno nuevo e inténtalo de nuevo.';
const invalidEvent = 'El evento no coincide con una recarga válida.';
const codeTtl = 600;
const resendCooldown = 60;
const maxCodeAttempts = 5;
const maxSendsPerHour = 5;
const hourMs = 3_600_000;
const defaultMin = 1000n;
const defaultMax = 99_999_999n;

const monthInMexico = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
});
const receiptDate = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const amountLabel = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

function paymentConfig(config) {
  const secret = config.stripeSecretKey ?? '';
  const publishable = config.stripePublishableKey ?? '';
  const webhook = config.stripeWebhookSecret ?? '';
  const min = parseDecimal(config.stripeMinTopup ?? '10.00', 2, 18);
  const max = parseDecimal(config.stripeMaxTopup ?? '999999.99', 2, 18);
  const validLimits = min !== null && max !== null && min >= defaultMin && max <= defaultMax && min <= max;
  const configured = Boolean(
    /^(sk|rk)_test_.+/.test(secret) && /^pk_test_.+/.test(publishable)
      && /^whsec_.+/.test(webhook) && validLimits,
  );
  return {
    configured,
    publishable_key: publishable.startsWith('pk_test_') ? publishable : '',
    mode: 'test',
    min_amount: formatDecimal(validLimits ? min : defaultMin, 2),
    max_amount: formatDecimal(validLimits ? max : defaultMax, 2),
    detail: configured ? 'Pagos de prueba disponibles.' : 'Los pagos de prueba todavía no están habilitados.',
  };
}

function ensureConfigured(config) {
  const settings = paymentConfig(config);
  if (!settings.configured) throw new ApiError(503, { detail: unavailable });
  return settings;
}

async function stripeCall(callback) {
  try {
    return await callback();
  } catch {
    throw new ApiError(503, { detail: 'No pudimos contactar al servicio de pagos. Puedes reintentar la misma operación.' });
  }
}

function testObject(result) {
  if (result?.livemode !== false) {
    throw new ApiError(400, { detail: 'Solo se permiten operaciones en el entorno de pruebas.' });
  }
}

function objectId(value) {
  return (typeof value === 'object' ? value?.id : value) ?? null;
}

function apiDate(value) {
  return value ? new Date(value).toISOString().replace(/(?:\.000)?Z$/, '+00:00') : null;
}

function cardExpired(card) {
  if (!card.exp_year || !card.exp_month) return false;
  const parts = monthInMexico.formatToParts(new Date());
  const month = Number(parts.find(({ type }) => type === 'month').value);
  const year = Number(parts.find(({ type }) => type === 'year').value);
  return Number(card.exp_year) * 12 + Number(card.exp_month) < year * 12 + month;
}

function cardActive(card, email) {
  return Boolean(
    card.verified_at && card.stripe_payment_method_id && !card.disabled_at
      && !cardExpired(card) && card.verified_email.toLowerCase() === email.toLowerCase(),
  );
}

function cardData(card, email) {
  let status = 'pending';
  if (card.disabled_at) status = 'disabled';
  else if (cardExpired(card)) status = 'expired';
  else if (cardActive(card, email)) status = 'active';
  return {
    id: card.id, brand: card.brand, last4: card.last4,
    exp_month: card.exp_month, exp_year: card.exp_year, status, verified_at: apiDate(card.verified_at),
  };
}

function topupData(topup, email) {
  return {
    id: topup.id, status: topup.status, amount: formatDecimal(readDecimal(topup.amount, 2), 2),
    currency: topup.currency, card: cardData(topup.card, email),
    created_at: apiDate(topup.created_at), credited_at: apiDate(topup.credited_at),
  };
}

function uuidInput(body, field, errors) {
  const value = uuid(body?.[field]);
  if (!value) errors[field] = [body?.[field] == null ? 'Este campo es requerido.' : 'No es un UUID válido.'];
  return value;
}

function pathId(req, field) {
  const value = req.params[field];
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value)) {
    throw new ApiError(404, { detail: 'Ruta de API no encontrada.' });
  }
  return value;
}

function validate(errors) {
  if (Object.keys(errors).length) throw new ApiError(400, errors);
}

async function lockedAccount(tx, id) {
  const { rows } = await tx.query(
    'SELECT id, email, username, nombre, cash_balance FROM usuarios WHERE id = $1 FOR UPDATE', [id],
  );
  if (!rows[0]) throw new ApiError(403, { detail: 'Las credenciales de autenticación no se proveyeron.' });
  return rows[0];
}

async function ownedCard(db, userId, cardId, { lock = false, includeDisabled = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM payment_cards WHERE id = $1 AND usuario_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [cardId, userId],
  );
  const card = rows[0];
  if (!card) throw new ApiError(404, { detail: 'La tarjeta no está disponible.' });
  if (!includeDisabled && card.disabled_at) {
    throw new ApiError(400, { detail: 'Esta tarjeta se eliminó. Registra una tarjeta nueva.' });
  }
  return card;
}

async function customerIdFor(db, userId) {
  const { rows } = await db.query('SELECT customer_id FROM stripe_customers WHERE usuario_id = $1', [userId]);
  return rows[0]?.customer_id ?? null;
}

async function stripeCustomerFor(db, stripe, userId) {
  const customer = await db.transaction(async (tx) => {
    await lockedAccount(tx, userId);
    await tx.query(
      `INSERT INTO stripe_customers (id, usuario_id, created_at)
       VALUES ($1, $2, $3) ON CONFLICT (usuario_id) DO NOTHING`,
      [randomUUID(), userId, new Date()],
    );
    const { rows } = await tx.query('SELECT * FROM stripe_customers WHERE usuario_id = $1', [userId]);
    return rows[0];
  });
  if (customer.customer_id) return customer.customer_id;

  const result = await stripeCall(() => stripe.customers.create(
    { metadata: { app_customer_id: customer.id } },
    { idempotencyKey: `customer:${customer.id}` },
  ));
  testObject(result);
  await db.transaction(async (tx) => {
    await lockedAccount(tx, userId);
    const existing = await customerIdFor(tx, userId);
    if (existing && existing !== result.id) {
      throw new ApiError(400, { detail: 'No pudimos vincular el cliente de pruebas.' });
    }
    await tx.query('UPDATE stripe_customers SET customer_id = $1 WHERE id = $2', [result.id, customer.id]);
  });
  return result.id;
}

async function createCardSetup(db, stripe, config, user, requestId) {
  ensureConfigured(config);
  if (!stripe) throw new ApiError(503, { detail: unavailable });
  const customerId = await stripeCustomerFor(db, stripe, user.id);
  const registration = await db.transaction(async (tx) => {
    await lockedAccount(tx, user.id);
    await tx.query(
      `INSERT INTO payment_cards (id, usuario_id, request_id, stripe_customer_id, brand, last4, verified_email, created_at)
       VALUES ($1, $2, $3, $4, '', '', '', $5) ON CONFLICT (usuario_id, request_id) DO NOTHING`,
      [randomUUID(), user.id, requestId, customerId, new Date()],
    );
    const { rows: [card] } = await tx.query(
      'SELECT * FROM payment_cards WHERE usuario_id = $1 AND request_id = $2', [user.id, requestId],
    );
    if (card.disabled_at) throw new ApiError(400, { detail: 'Este registro se eliminó. Inicia un registro nuevo.' });
    return card;
  });
  const setup = await stripeCall(() => registration.stripe_setup_intent_id
    ? stripe.setupIntents.retrieve(registration.stripe_setup_intent_id)
    : stripe.setupIntents.create({
      customer: customerId, allowed_payment_method_types: ['card'],
      usage: 'on_session', metadata: { card_registration_id: registration.id },
    }, { idempotencyKey: `card-setup:${registration.id}` }));
  testObject(setup);
  if (objectId(setup.customer) !== customerId) {
    throw new ApiError(400, { detail: 'El registro de tarjeta no corresponde a tu cuenta.' });
  }
  return db.transaction(async (tx) => {
    const account = await lockedAccount(tx, user.id);
    const card = await ownedCard(tx, user.id, registration.id, { lock: true });
    if (card.stripe_setup_intent_id && card.stripe_setup_intent_id !== setup.id) {
      throw new ApiError(400, { detail: 'Este registro ya tiene una tarjeta asociada.' });
    }
    await tx.query(
      'UPDATE payment_cards SET stripe_customer_id = $1, stripe_setup_intent_id = $2 WHERE id = $3',
      [customerId, setup.id, card.id],
    );
    return { card: cardData(card, account.email), client_secret: setup.client_secret };
  });
}

function codeDigest(config, challengeId, code) {
  return saltedHmac('folio.card-verification.code', `${challengeId}:${code}`, config.secret);
}

function rateLimited(waitMs) {
  const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
  throw new ApiError(429, {
    detail: 'Espera antes de solicitar otro código de tarjeta.', retry_after: String(retryAfter),
  }, { 'Retry-After': String(retryAfter) });
}

function cardLabel(card) {
  return `${card.brand.toUpperCase()} terminada en ${card.last4}`;
}

function sendCardCode(email, user, card, code, challengeId) {
  const name = user.nombre || user.username;
  const label = cardLabel(card);
  return email.send({
    to: user.email, subject: 'Confirma tu tarjeta de prueba en App Finanzas Mauricio',
    text: `Hola, ${name}.\n\nTu código para registrar la tarjeta de prueba ${label} en App Finanzas Mauricio es: ${code}\n\n`
      + 'Vence en 10 minutos y solo se puede utilizar una vez. Ingresa el código en la aplicación para activar esta tarjeta. '
      + 'Este registro y los pagos son simulados; no se realiza ningún cargo real.\n\n'
      + 'Si no solicitaste este registro, no compartas el código.',
    html: `<h1>Confirma tu tarjeta de prueba</h1><p>Hola, ${escapeHtml(name)}.</p><p>Tarjeta: ${escapeHtml(label)}.</p>`
      + `<p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p>`
      + '<p>Vence en 10 minutos y solo se puede utilizar una vez. Ingresa el código en App Finanzas Mauricio para activar esta tarjeta.</p>'
      + '<p>Registro y pagos simulados. No se realiza ningún cargo real.</p><p>Si no lo solicitaste, no compartas el código.</p>',
    idempotencyKey: `card-verification/${challengeId}`,
  });
}

async function requestCardVerification(db, stripe, config, email, user, cardId) {
  ensureConfigured(config);
  await email.ensureConfigured();
  const registration = await ownedCard(db, user.id, cardId);
  if (!registration.stripe_setup_intent_id) {
    throw new ApiError(400, { detail: 'Completa primero el formulario de tarjeta.' });
  }
  const setup = await stripeCall(() => stripe.setupIntents.retrieve(registration.stripe_setup_intent_id));
  testObject(setup);
  const customerId = await customerIdFor(db, user.id);
  if (setup.status !== 'succeeded' || objectId(setup.customer) !== customerId || registration.stripe_customer_id !== customerId) {
    throw new ApiError(400, { detail: 'No se ha completado el registro de esta tarjeta en Stripe.' });
  }
  const methodId = objectId(setup.payment_method);
  if (!methodId) throw new ApiError(400, { detail: 'No se recibió una tarjeta válida.' });
  const method = await stripeCall(() => stripe.paymentMethods.retrieve(methodId));
  testObject(method);
  const details = method.card;
  if (method.type !== 'card' || objectId(method.customer) !== customerId || !details?.last4) {
    throw new ApiError(400, { detail: 'La tarjeta no corresponde a tu cuenta.' });
  }

  return db.transaction(async (tx) => {
    const account = await lockedAccount(tx, user.id);
    const card = await ownedCard(tx, user.id, cardId, { lock: true });
    if (cardActive(card, account.email)) throw new ApiError(400, { detail: 'Esta tarjeta ya está verificada.' });
    const { rowCount: duplicate } = await tx.query(
      'SELECT id FROM payment_cards WHERE stripe_payment_method_id = $1 AND id <> $2', [methodId, card.id],
    );
    if (duplicate) throw new ApiError(400, { detail: 'Este método de pago ya está registrado.' });
    Object.assign(card, {
      stripe_payment_method_id: methodId, brand: String(details.brand ?? 'card').slice(0, 30),
      last4: String(details.last4).slice(-4), exp_month: details.exp_month ?? null, exp_year: details.exp_year ?? null,
    });
    if (cardExpired(card)) throw new ApiError(400, { detail: 'La tarjeta ha vencido. Registra una tarjeta vigente.' });

    const now = new Date();
    const window = new Date(now.getTime() - hourMs);
    const { rows: [recent] } = await tx.query(
      `SELECT COALESCE(SUM(v.send_count), 0) AS total, MIN(v.send_window_started_at) AS first_send
       FROM card_verifications v JOIN payment_cards c ON c.id = v.card_id
       WHERE c.usuario_id = $1 AND v.send_window_started_at > $2`,
      [account.id, window],
    );
    if (Number(recent.total) >= maxSendsPerHour) rateLimited(new Date(recent.first_send).getTime() + hourMs - now.getTime());
    const { rows: [previous] } = await tx.query('SELECT * FROM card_verifications WHERE card_id = $1 FOR UPDATE', [card.id]);
    if (previous) {
      const remaining = new Date(previous.sent_at).getTime() + resendCooldown * 1000 - now.getTime();
      if (remaining > 0) rateLimited(remaining);
    }
    const windowContinues = previous && new Date(previous.send_window_started_at) > window;
    const sendWindowStartedAt = windowContinues ? previous.send_window_started_at : now;
    const sendCount = windowContinues ? Number(previous.send_count) + 1 : 1;
    const challengeId = randomUUID();
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + codeTtl * 1000);
    await tx.query(
      `UPDATE payment_cards SET stripe_payment_method_id = $1, brand = $2, last4 = $3,
       exp_month = $4, exp_year = $5 WHERE id = $6`,
      [methodId, card.brand, card.last4, card.exp_month, card.exp_year, card.id],
    );
    await tx.query(
      `INSERT INTO card_verifications
       (card_id, challenge_id, email, code_digest, expires_at, attempts, sent_at, send_window_started_at, send_count)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
       ON CONFLICT (card_id) DO UPDATE SET challenge_id = EXCLUDED.challenge_id, email = EXCLUDED.email,
       code_digest = EXCLUDED.code_digest, expires_at = EXCLUDED.expires_at, consumed_at = NULL, attempts = 0,
       sent_at = EXCLUDED.sent_at, send_window_started_at = EXCLUDED.send_window_started_at, send_count = EXCLUDED.send_count`,
      [card.id, challengeId, account.email, codeDigest(config, challengeId, code), expiresAt, now, sendWindowStartedAt, sendCount],
    );
    await sendCardCode(email, account, card, code, challengeId);
    const separator = account.email.lastIndexOf('@');
    const hint = `${account.email.slice(0, separator).slice(0, 2)}***@${account.email.slice(separator + 1)}`;
    return {
      card: cardData(card, account.email), challenge_id: challengeId, email_hint: hint, expires_in: codeTtl,
      retry_after: resendCooldown, detail: 'Te enviamos un código para confirmar esta tarjeta.',
    };
  });
}

async function confirmCardVerification(db, config, user, cardId, challengeId, code) {
  ensureConfigured(config);
  const verified = await db.transaction(async (tx) => {
    const account = await lockedAccount(tx, user.id);
    const card = await ownedCard(tx, user.id, cardId, { lock: true });
    const { rows: [challenge] } = await tx.query(
      'SELECT * FROM card_verifications WHERE card_id = $1 AND challenge_id = $2 FOR UPDATE', [card.id, challengeId],
    );
    const now = new Date();
    if (!challenge || challenge.consumed_at || !challenge.code_digest || new Date(challenge.expires_at) <= now
      || challenge.attempts >= maxCodeAttempts || challenge.email.toLowerCase() !== account.email.toLowerCase()
      || !card.stripe_payment_method_id || cardExpired(card)) return null;

    if (!secureEqual(challenge.code_digest, codeDigest(config, challengeId, code))) {
      const attempts = Number(challenge.attempts) + 1;
      await tx.query('UPDATE card_verifications SET attempts = $1, code_digest = $2 WHERE id = $3', [
        attempts, attempts >= maxCodeAttempts ? '' : challenge.code_digest, challenge.id,
      ]);
      return null;
    }
    await tx.query("UPDATE card_verifications SET consumed_at = $1, code_digest = '' WHERE id = $2", [now, challenge.id]);
    await tx.query('UPDATE payment_cards SET verified_at = $1, verified_email = $2 WHERE id = $3', [now, account.email, card.id]);
    return cardData({ ...card, verified_at: now, verified_email: account.email }, account.email);
  });
  if (!verified) throw new ApiError(400, { detail: invalidCode });
  return { card: verified, detail: 'Tarjeta de prueba verificada correctamente.' };
}

async function disableCard(db, userId, cardId) {
  await db.transaction(async (tx) => {
    await lockedAccount(tx, userId);
    const card = await ownedCard(tx, userId, cardId, { lock: true, includeDisabled: true });
    const now = new Date();
    await tx.query('UPDATE payment_cards SET disabled_at = $1 WHERE id = $2', [now, card.id]);
    await tx.query("UPDATE card_verifications SET consumed_at = $1, code_digest = '' WHERE card_id = $2", [now, card.id]);
  });
}

async function findTopup(db, userId, key, { lock = false, byRequest = false } = {}) {
  const { rows } = await db.query(
    `SELECT t.*, row_to_json(c) AS card, u.email AS account_email, u.cash_balance
     FROM payment_topups t JOIN payment_cards c ON c.id = t.card_id JOIN usuarios u ON u.id = t.usuario_id
     WHERE t.usuario_id = $1 AND t.${byRequest ? 'request_id' : 'id'} = $2${lock ? ' FOR UPDATE OF t' : ''}`,
    [userId, key],
  );
  return rows[0];
}

async function createTopup(db, stripe, config, user, { requestId, cardId, amount }) {
  const { min_amount: min, max_amount: max } = ensureConfigured(config);
  if (amount < readDecimal(min, 2) || amount > readDecimal(max, 2)) {
    throw new ApiError(400, {
      amount: [`El monto debe estar entre $${amountLabel.format(Number(min))} y $${amountLabel.format(Number(max))} MXN.`],
    });
  }
  const topup = await db.transaction(async (tx) => {
    const account = await lockedAccount(tx, user.id);
    const existing = await findTopup(tx, account.id, requestId, { byRequest: true });
    if (existing) {
      if (existing.card_id !== cardId || readDecimal(existing.amount, 2) !== amount) {
        throw new ApiError(400, { detail: 'Esta referencia ya corresponde a otra recarga. Inicia una operación nueva.' });
      }
      return existing;
    }
    const card = await ownedCard(tx, account.id, cardId, { lock: true });
    if (!cardActive(card, account.email)) {
      throw new ApiError(400, { detail: 'Confirma primero el código de esta tarjeta para agregar fondos.' });
    }
    const customerId = await customerIdFor(tx, account.id);
    if (!customerId || customerId !== card.stripe_customer_id) {
      throw new ApiError(400, { detail: 'La tarjeta no corresponde al cliente de tu cuenta.' });
    }
    if (readDecimal(account.cash_balance, 2) + amount > maxMoney) {
      throw new ApiError(400, { amount: ['La recarga supera el límite de saldo permitido.'] });
    }
    const { rows: [created] } = await tx.query(
      `INSERT INTO payment_topups
       (id, usuario_id, card_id, request_id, amount, currency, stripe_customer_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'mxn', $6, 'pending', $7) RETURNING *`,
      [randomUUID(), account.id, card.id, requestId, formatDecimal(amount, 2), customerId, new Date()],
    );
    return { ...created, card, account_email: account.email };
  });
  if (topup.status === 'succeeded' || topup.status === 'failed') {
    return { topup: topupData(topup, topup.account_email), client_secret: '' };
  }
  const payment = await stripeCall(() => topup.stripe_payment_intent_id
    ? stripe.paymentIntents.retrieve(topup.stripe_payment_intent_id)
    : stripe.paymentIntents.create({
      amount: Number(amount), currency: 'mxn', customer: topup.stripe_customer_id,
      payment_method: topup.card.stripe_payment_method_id, allowed_payment_method_types: ['card'],
      metadata: { topup_id: topup.id }, description: 'Recarga de saldo simulado App Finanzas Mauricio',
    }, { idempotencyKey: `topup:${topup.id}` }));
  testObject(payment);
  if (objectId(payment.customer) !== topup.stripe_customer_id || payment.amount !== Number(amount)
    || payment.currency !== 'mxn' || objectId(payment.payment_method) !== topup.card.stripe_payment_method_id) {
    throw new ApiError(400, { detail: 'La confirmación del pago no corresponde a esta recarga.' });
  }
  return db.transaction(async (tx) => {
    await lockedAccount(tx, user.id);
    const current = await findTopup(tx, user.id, topup.id, { lock: true });
    if (current.stripe_payment_intent_id && current.stripe_payment_intent_id !== payment.id) {
      throw new ApiError(400, { detail: 'Esta recarga ya tiene un pago asociado.' });
    }
    await tx.query('UPDATE payment_topups SET stripe_payment_intent_id = $1 WHERE id = $2', [payment.id, current.id]);
    return {
      topup: topupData(current, current.account_email),
      client_secret: current.status === 'pending' ? payment.client_secret ?? '' : '',
    };
  });
}

async function processPaymentEvent(db, event) {
  if (event?.livemode !== false) throw new ApiError(400, { detail: invalidEvent });
  const success = event.type === 'payment_intent.succeeded';
  if (!success && event.type !== 'payment_intent.payment_failed') return;
  const payment = event.data?.object;
  testObject(payment);
  const reference = payment.metadata?.topup_id;
  if (!reference) return;
  const topupId = uuid(reference);
  if (!topupId) throw new ApiError(400, { detail: invalidEvent });
  const { rows: [original] } = await db.query('SELECT usuario_id FROM payment_topups WHERE id = $1', [topupId]);
  if (!original) return;

  await db.transaction(async (tx) => {
    const account = await lockedAccount(tx, original.usuario_id);
    const topup = await findTopup(tx, account.id, topupId, { lock: true });
    const customerId = topup.stripe_customer_id || await customerIdFor(tx, account.id);
    const amount = readDecimal(topup.amount, 2);
    const methodId = objectId(payment.payment_method)
      || (success ? null : objectId(payment.last_payment_error?.payment_method));
    const methodMatches = (methodId !== null && methodId === topup.card.stripe_payment_method_id) || (!success && methodId === null);
    if (!payment.id || payment.id !== topup.stripe_payment_intent_id || !customerId
      || objectId(payment.customer) !== customerId || payment.currency !== topup.currency
      || payment.amount !== Number(amount) || !methodMatches) {
      throw new ApiError(400, { detail: invalidEvent });
    }
    if (topup.credited_at) return;
    if (!success) {
      await tx.query("UPDATE payment_topups SET status = 'failed' WHERE id = $1", [topup.id]);
      return;
    }
    const newBalance = readDecimal(account.cash_balance, 2) + amount;
    if (payment.status !== 'succeeded' || payment.amount_received !== Number(amount) || newBalance > maxMoney) {
      throw new ApiError(400, { detail: invalidEvent });
    }
    const now = new Date();
    await tx.query('UPDATE usuarios SET cash_balance = $1 WHERE id = $2', [formatDecimal(newBalance, 2), account.id]);
    const { rows: [record] } = await tx.query(
      `INSERT INTO transacciones (usuario_id, tipo, descripcion, cantidad, precio_unitario, monto, fecha)
       VALUES ($1, 'deposit', $2, 0, 0, $3, $4) RETURNING id`,
      [account.id, `Recarga simulada con ${cardLabel(topup.card)}`, formatDecimal(amount, 2), now],
    );
    await tx.query(
      "UPDATE payment_topups SET status = 'succeeded', credited_at = $1, transaction_id = $2 WHERE id = $3",
      [now, record.id, topup.id],
    );
    await tx.query(
      `INSERT INTO payment_email_outbox (topup_id, recipient, attempts, next_attempt_at, created_at)
       VALUES ($1, $2, 0, $3, $3) ON CONFLICT (topup_id) DO NOTHING`,
      [topup.id, account.email, now],
    );
  });
}

function sendTopupConfirmation(email, outbox) {
  const date = receiptDate.format(new Date(outbox.credited_at)).replace(',', '');
  const amount = `$${amountLabel.format(Number(outbox.amount))} MXN`;
  const label = cardLabel(outbox);
  return email.send({
    to: outbox.recipient, subject: 'Tu recarga simulada se acreditó correctamente',
    text: `Tu recarga simulada de ${amount} se acreditó correctamente en App Finanzas Mauricio.\n\n`
      + `Tarjeta de prueba: ${label}\nFecha: ${date} (Ciudad de México)\nReferencia: ${outbox.topup_id}\n\n`
      + 'Ya puedes utilizar este saldo dentro de la aplicación. Esta operación es de prueba y no se realizó ningún cargo real.',
    html: '<h1>Tu saldo simulado está disponible</h1>'
      + `<p>Se acreditaron <strong>${escapeHtml(amount)}</strong> en App Finanzas Mauricio.</p>`
      + `<p>Tarjeta de prueba: ${escapeHtml(label)}<br>Fecha: ${escapeHtml(date)} (Ciudad de México)<br>Referencia: ${outbox.topup_id}</p>`
      + '<p>Ya puedes utilizar este saldo dentro de la aplicación.</p><p>Operación de prueba. No se realizó ningún cargo real.</p>',
    idempotencyKey: `topup-confirmation/${outbox.topup_id}`,
  });
}

export async function deliverPendingPaymentEmails({ db, email, limit = 25 }) {
  const { rows } = await db.query(
    `SELECT id FROM payment_email_outbox WHERE sent_at IS NULL AND next_attempt_at <= $1
     ORDER BY created_at LIMIT $2`, [new Date(), limit],
  );
  const result = { sent: 0, failed: 0 };
  for (const { id } of rows) {
    const outcome = await db.transaction(async (tx) => {
      const now = new Date();
      const { rows: [outbox] } = await tx.query(
        `SELECT o.*, t.amount, t.credited_at, c.brand, c.last4
         FROM payment_email_outbox o JOIN payment_topups t ON t.id = o.topup_id JOIN payment_cards c ON c.id = t.card_id
         WHERE o.id = $1 AND o.sent_at IS NULL AND o.next_attempt_at <= $2 FOR UPDATE OF o`,
        [id, now],
      );
      if (!outbox) return null;
      const attempts = Number(outbox.attempts) + 1;
      try {
        await sendTopupConfirmation(email, outbox);
      } catch (error) {
        if (!(error instanceof EmailDeliveryError)) throw error;
        const delay = Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7));
        await tx.query(
          'UPDATE payment_email_outbox SET attempts = $1, last_attempt_at = $2, next_attempt_at = $3 WHERE id = $4',
          [attempts, now, new Date(now.getTime() + delay * 1000), id],
        );
        return 'failed';
      }
      await tx.query(
        'UPDATE payment_email_outbox SET attempts = $1, last_attempt_at = $2, sent_at = $3 WHERE id = $4',
        [attempts, now, new Date(), id],
      );
      return 'sent';
    });
    if (outcome) result[outcome] += 1;
  }
  return result;
}

export function mountPayments(app, { db, config, email, requireUser, requireCsrf, stripe }) {
  app.get('/api/payments/config/', requireUser, (req, res) => res.json(paymentConfig(config)));

  app.get('/api/cards/', requireUser, async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM payment_cards WHERE usuario_id = $1 AND disabled_at IS NULL ORDER BY created_at DESC', [req.user.id],
    );
    res.json({ cards: rows.map((card) => cardData(card, req.user.email)) });
  });

  app.post('/api/cards/setup/', requireUser, requireCsrf, async (req, res) => {
    const errors = {};
    const requestId = uuidInput(req.body, 'request_id', errors);
    validate(errors);
    res.status(201).json(await createCardSetup(db, stripe, config, req.user, requestId));
  });

  app.post('/api/cards/:cardId/verification/request/', requireUser, requireCsrf, async (req, res) => {
    const cardId = pathId(req, 'cardId');
    try {
      res.json(await requestCardVerification(db, stripe, config, email, req.user, cardId));
    } catch (error) {
      if (!(error instanceof EmailDeliveryError)) throw error;
      throw new ApiError(503, { detail: 'No pudimos enviar el código de la tarjeta. Inténtalo de nuevo más tarde.' });
    }
  });

  app.post('/api/cards/:cardId/verification/confirm/', requireUser, requireCsrf, async (req, res) => {
    const cardId = pathId(req, 'cardId');
    const errors = {};
    const challengeId = uuidInput(req.body, 'challenge_id', errors);
    const code = String(req.body?.code ?? '');
    if (!/^[0-9]{6}$/.test(code)) errors.code = ['Ingresa un código de 6 dígitos.'];
    validate(errors);
    res.json(await confirmCardVerification(db, config, req.user, cardId, challengeId, code));
  });

  app.delete('/api/cards/:cardId/', requireUser, requireCsrf, async (req, res) => {
    await disableCard(db, req.user.id, pathId(req, 'cardId'));
    res.status(204).end();
  });

  app.post('/api/funds/', requireUser, requireCsrf, async (req, res) => {
    const errors = {};
    const requestId = uuidInput(req.body, 'request_id', errors);
    const cardId = uuidInput(req.body, 'card_id', errors);
    const amount = parseDecimal(req.body?.amount, 2, 18);
    if (amount === null || amount < 0n) errors.amount = ['Ingresa un monto válido con hasta 2 decimales.'];
    validate(errors);
    res.status(201).json(await createTopup(db, stripe, config, req.user, { requestId, cardId, amount }));
  });

  app.get('/api/funds/:topupId/', requireUser, async (req, res) => {
    const topup = await findTopup(db, req.user.id, pathId(req, 'topupId'));
    if (!topup) throw new ApiError(404, { detail: 'La recarga no existe.' });
    res.json({
      topup: topupData(topup, topup.account_email), cash_balance: formatDecimal(readDecimal(topup.cash_balance, 2), 2),
    });
  });

  app.post('/api/stripe/webhook/', async (req, res) => {
    if (!paymentConfig(config).configured || !stripe) {
      throw new ApiError(503, { detail: 'El servicio de pagos de prueba no está configurado.' });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') ?? '', config.stripeWebhookSecret);
    } catch {
      throw new ApiError(400, { detail: 'La firma del evento no es válida.' });
    }
    try {
      await processPaymentEvent(db, event);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 400) throw error;
      throw new ApiError(400, { detail: invalidEvent });
    }
    res.json({ received: true });
  });
}
