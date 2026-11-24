import { randomUUID } from 'node:crypto';
import { ApiError, uuid } from './common.js';
import { formatDecimal, parseDecimal, readDecimal } from './decimal.js';

const cardColumns = 'c.id, c.brand, c.last4, c.exp_month, c.exp_year';

async function eligibleCards(db, userId, cardId = null) {
  const { rows } = await db.query(
    `SELECT ${cardColumns} FROM payment_cards c
     JOIN payment_topups t ON t.card_id = c.id AND t.usuario_id = c.usuario_id
     WHERE c.usuario_id = $1 AND c.disabled_at IS NULL
       AND t.status = 'succeeded' AND t.credited_at IS NOT NULL
       AND ($2::uuid IS NULL OR c.id = $2::uuid)
     GROUP BY c.id ORDER BY MAX(t.credited_at) DESC, c.id`,
    [userId, cardId],
  );
  return rows;
}

function readWithdrawal(body) {
  const cardId = uuid(body?.card_id);
  const requestId = uuid(body?.request_id);
  const amount = parseDecimal(body?.amount, 2, 18);
  const errors = {};
  if (!cardId) errors.card_id = ['Selecciona una tarjeta válida.'];
  if (!requestId) errors.request_id = ['La referencia del retiro no es válida.'];
  if (amount === null || amount <= 0n) {
    errors.amount = ['Ingresa un importe positivo con hasta dos decimales.'];
  }
  if (Object.keys(errors).length) throw new ApiError(400, errors);
  return { cardId, requestId, amount };
}

function withdrawalResult(withdrawalId, amount, card, createdAt, balance) {
  const { id, brand, last4, exp_month, exp_year } = card;
  return {
    detail: 'Retiro simulado registrado correctamente.',
    withdrawal: {
      id: withdrawalId,
      status: 'succeeded',
      amount: formatDecimal(amount, 2),
      card: { id, brand, last4, exp_month, exp_year },
      created_at: new Date(createdAt).toISOString(),
    },
    cash_balance: formatDecimal(balance, 2),
  };
}

async function createWithdrawal(db, userId, { cardId, requestId, amount }) {
  return db.transaction(async (tx) => {
    // Match the account-first lock order used by deposits, trades and card removal.
    const { rows: [account] } = await tx.query(
      'SELECT cash_balance FROM usuarios WHERE id = $1 AND is_active FOR UPDATE', [userId],
    );
    if (!account) throw new ApiError(403, 'Se requiere una sesión activa.');
    const balance = readDecimal(account.cash_balance, 2);

    const { rows: [previous] } = await tx.query(
      `SELECT w.id AS withdrawal_id, w.amount, w.created_at, ${cardColumns}
       FROM payment_withdrawals w
       JOIN payment_cards c ON c.id = w.card_id AND c.usuario_id = w.usuario_id
       WHERE w.usuario_id = $1 AND w.request_id = $2`,
      [userId, requestId],
    );
    if (previous) {
      if (previous.id !== cardId || readDecimal(previous.amount, 2) !== amount) {
        throw new ApiError(409, 'Esta referencia ya corresponde a otro retiro. Inicia una operación nueva.');
      }
      return withdrawalResult(previous.withdrawal_id, amount, previous, previous.created_at, balance);
    }

    const [card] = await eligibleCards(tx, userId, cardId);
    if (!card) throw new ApiError(400, { card_id: ['Selecciona una tarjeta que hayas usado para una recarga acreditada.'] });
    if (amount > balance) throw new ApiError(400, { amount: ['El importe supera tu saldo disponible.'] });

    const withdrawalId = randomUUID();
    const amountText = formatDecimal(amount, 2);
    const newBalance = balance - amount;
    const createdAt = new Date();
    const { rows: [transaction] } = await tx.query(
      `INSERT INTO transacciones (usuario_id, tipo, descripcion, cantidad, precio_unitario, monto, fecha)
       VALUES ($1, 'withdrawal', $2, 0, 0, $3, $4) RETURNING id`,
      [userId, `Retiro simulado a ${card.brand.toUpperCase()} terminada en ${card.last4}`, amountText, createdAt],
    );
    await tx.query(
      `INSERT INTO payment_withdrawals (id, usuario_id, card_id, request_id, transaction_id, amount, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [withdrawalId, userId, card.id, requestId, transaction.id, amountText, createdAt],
    );
    await tx.query('UPDATE usuarios SET cash_balance = $1 WHERE id = $2', [formatDecimal(newBalance, 2), userId]);
    return withdrawalResult(withdrawalId, amount, card, createdAt, newBalance);
  });
}

export function mountWithdrawals(app, { db, requireUser, requireCsrf }) {
  app.get('/api/withdrawals/', requireUser, async (req, res) => {
    const cards = await eligibleCards(db, req.user.id);
    const balance = readDecimal(req.user.cash_balance, 2);
    res.json({ cards, cash_balance: formatDecimal(balance, 2) });
  });

  app.post('/api/withdrawals/', requireUser, requireCsrf, async (req, res) => {
    const result = await createWithdrawal(db, req.user.id, readWithdrawal(req.body));
    res.status(201).json(result);
  });
}
