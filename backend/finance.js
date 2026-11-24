import { userData } from './auth.js';
import { ApiError } from './common.js';
import { formatDecimal, maxMoney, parseDecimal, readDecimal, roundDivision } from './decimal.js';

const stockColumns = 's.id, s.symbol, s.nombre, s.sector, s.precio, s.cambio_porcentual, s.color';
const transactionColumns = 't.id, t.tipo, t.descripcion, t.cantidad, t.precio_unitario, t.monto';
const transactionTime = `to_char(t.fecha AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fecha`;
const calendarZone = 'America/Mexico_City';
const transactionDay = `CAST(t.fecha AT TIME ZONE '${calendarZone}' AS date)`;
const dateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: calendarZone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  timeZoneName: 'longOffset',
});
const shareUnits = 1000000n;
const maxShareUnits = 999999999999999999n;
const maxStockId = 9223372036854775807n;
const dayMillis = 86400000;

function money(value) {
  return formatDecimal(value, 2);
}

function percentage(value, base) {
  if (base === 0n) return '0.00';
  const rounded = roundDivision(value * 10000n, base);
  return rounded === 0n && value < 0n ? '-0.00' : money(rounded);
}

function stockData(row) {
  return {
    id: Number(row.id), symbol: row.symbol, nombre: row.nombre, sector: row.sector,
    precio: money(readDecimal(row.precio, 2)),
    cambio_porcentual: money(readDecimal(row.cambio_porcentual, 2)), color: row.color,
  };
}

function localParts(date) {
  return Object.fromEntries(dateTime.formatToParts(date).map(({ type, value }) => [type, value]));
}

function localDate(parts) {
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function transactionData(row) {
  const parts = localParts(new Date(row.fecha));
  const microseconds = row.fecha.slice(20, 26);
  const fraction = microseconds === '000000' ? '' : `.${microseconds}`;
  const offset = parts.timeZoneName.slice(3) || '+00:00';
  return {
    id: Number(row.id), tipo: row.tipo, descripcion: row.descripcion,
    symbol: row.symbol, stock_name: row.stock_name,
    cantidad: formatDecimal(readDecimal(row.cantidad, 6), 6),
    precio_unitario: money(readDecimal(row.precio_unitario, 2)), monto: money(readDecimal(row.monto, 2)),
    fecha: `${localDate(parts)}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`,
  };
}

function queryParam(query, name) {
  const value = query[name];
  return (Array.isArray(value) ? value.at(-1) : value) ?? '';
}

function searchPattern(search) {
  return `%${search.replace(/[\\%_]/g, '\\$&')}%`;
}

async function stocksFor(db, search = '') {
  const conditions = search ? 'WHERE s.symbol ILIKE $1 OR s.nombre ILIKE $1 OR s.sector ILIKE $1' : '';
  const { rows } = await db.query(`SELECT ${stockColumns} FROM acciones s ${conditions} ORDER BY s.nombre`,
    search ? [searchPattern(search)] : []);
  return rows.map(stockData);
}

async function portfolioFor(db, user) {
  const { rows } = await db.query(
    `SELECT h.id AS holding_id, h.quantity, h.invested, ${stockColumns}
     FROM portafolio h JOIN acciones s ON s.id = h.accion_id WHERE h.usuario_id = $1 ORDER BY s.nombre`, [user.id],
  );
  let totalValue = 0n;
  let totalCost = 0n;
  const positions = rows.map((row) => {
    const quantity = readDecimal(row.quantity, 6);
    const invested = readDecimal(row.invested, 2);
    const value = roundDivision(quantity * readDecimal(row.precio, 2), shareUnits);
    totalValue += value;
    totalCost += invested;
    return { row, quantity, invested, value };
  });
  const cash = readDecimal(user.cash_balance, 2);
  return {
    summary: {
      portfolio_value: money(totalValue), invested: money(totalCost), profit: money(totalValue - totalCost),
      profit_percent: percentage(totalValue - totalCost, totalCost), cash_balance: money(cash),
      total_equity: money(totalValue + cash), assets_count: positions.length,
    },
    holdings: positions.map(({ row, quantity, invested, value }) => ({
      id: Number(row.holding_id), stock: stockData(row), quantity: formatDecimal(quantity, 6),
      invested: money(invested), current_value: money(value), profit: money(value - invested),
      profit_percent: percentage(value - invested, invested), allocation: percentage(value, totalValue),
    })),
  };
}

function parseDate(text) {
  const calendar = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (calendar) {
    const [, year, month, day] = calendar;
    const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const date = new Date(`${candidate}T00:00:00Z`);
    return year !== '0000' && Number.isFinite(date.valueOf()) && date.toISOString().startsWith(candidate) ? candidate : null;
  }
  const weekDate = /^(\d{4})-W(\d{2})(?:-([1-7]))?$/.exec(text) ?? /^(\d{4})W(\d{2})([1-7])?$/.exec(text);
  if (!weekDate) return null;
  const [, year, week, weekday = '1'] = weekDate;
  if (year === '0000' || week < '01' || week > '53') return null;
  const januaryFourth = new Date(`${year}-01-04T00:00:00Z`);
  const monday = januaryFourth.valueOf() - ((januaryFourth.getUTCDay() + 6) % 7) * dayMillis;
  const weekStart = monday + (Number(week) - 1) * 7 * dayMillis;
  if (new Date(weekStart + 3 * dayMillis).getUTCFullYear() !== Number(year)) return null;
  const date = new Date(weekStart + (Number(weekday) - 1) * dayMillis).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

async function transactionsFor(db, userId, query = {}, recent = false) {
  const parameters = [userId];
  const conditions = ['t.usuario_id = $1'];
  const type = queryParam(query, 'type');
  const search = queryParam(query, 'search').trim();
  if (type) {
    if (!['buy', 'sell', 'deposit', 'withdrawal'].includes(type)) {
      throw new ApiError(400, { type: ['Tipo de movimiento inválido.'] });
    }
    parameters.push(type);
    conditions.push(`t.tipo = $${parameters.length}`);
  }
  if (search) {
    parameters.push(searchPattern(search));
    const parameter = `$${parameters.length}`;
    conditions.push(`(t.descripcion ILIKE ${parameter} OR s.symbol ILIKE ${parameter})`);
  }
  const range = {};
  for (const [field, operator] of [['start', '>='], ['end', '<=']]) {
    const raw = queryParam(query, field);
    if (!raw) continue;
    const date = parseDate(raw);
    if (!date) throw new ApiError(400, { [field]: ['Usa una fecha válida con formato AAAA-MM-DD.'] });
    range[field] = date;
    parameters.push(date);
    conditions.push(`${transactionDay} ${operator} $${parameters.length}::date`);
  }
  if (range.start && range.end && range.start > range.end) {
    throw new ApiError(400, { start: ['La fecha inicial debe ser anterior o igual a la final.'] });
  }
  const { rows } = await db.query(
    `SELECT ${transactionColumns}, ${transactionTime}, s.symbol, s.nombre AS stock_name
     FROM transacciones t LEFT JOIN acciones s ON s.id = t.accion_id
     WHERE ${conditions.join(' AND ')} ORDER BY t.fecha DESC, t.id DESC ${recent ? 'LIMIT 5' : ''}`, parameters,
  );
  return rows.map(transactionData);
}

async function investmentChart(db, userId) {
  const { rows } = await db.query(
    `SELECT t.tipo, t.monto, ${transactionDay}::text AS day FROM transacciones t
     WHERE t.usuario_id = $1 AND t.tipo IN ('buy', 'sell') ORDER BY t.fecha, t.id`, [userId],
  );
  let net = 0n;
  const byDay = new Map();
  for (const row of rows) {
    const amount = readDecimal(row.monto, 2);
    net += row.tipo === 'buy' ? amount : -amount;
    byDay.set(row.day, money(net));
  }
  byDay.set(localDate(localParts(new Date())), money(net));
  return Array.from(byDay, ([date, value]) => ({ date, value }));
}

function tradeInput(body) {
  const payload = body ?? {};
  const errors = {};
  for (const field of ['stock_id', 'side', 'quantity']) {
    if (!Object.hasOwn(payload, field)) errors[field] = ['Este campo es requerido.'];
    else if (payload[field] === null) errors[field] = ['Este campo no puede ser nulo.'];
  }

  let stockId;
  if (!errors.stock_id) {
    const value = payload.stock_id;
    const text = ['number', 'string'].includes(typeof value) ? String(value).trim() : '';
    if (text.length > 1000 || !/^[+-]?\d+(?:\.0*)?$/.test(text)) {
      errors.stock_id = ['Introduce un número entero válido.'];
    } else {
      stockId = BigInt(text.replace(/\.0*$/, ''));
      if (stockId < 1n) errors.stock_id = ['Asegúrate de que este valor sea mayor o igual a 1.'];
    }
  }
  if (!errors.side && !['buy', 'sell'].includes(payload.side)) {
    errors.side = ['Elige un tipo de operación válido.'];
  }
  const quantity = parseDecimal(payload.quantity, 6, 18);
  if (!errors.quantity && (quantity === null || quantity < 1n)) {
    errors.quantity = ['Introduce una cantidad positiva con hasta 12 dígitos enteros y 6 decimales.'];
  }
  if (Object.keys(errors).length) throw new ApiError(400, errors);
  return { stockId, quantity, side: payload.side };
}

async function executeTrade(db, userId, { stockId, side, quantity }) {
  if (stockId > maxStockId) throw new ApiError(404, { detail: 'La acción no existe.' });
  return db.transaction(async (tx) => {
    const { rows: [user] } = await tx.query('SELECT cash_balance FROM usuarios WHERE id = $1 FOR UPDATE', [userId]);
    if (!user) throw new ApiError(403, { detail: 'Las credenciales de autenticación no se proveyeron.' });
    const { rows: [stock] } = await tx.query('SELECT id, precio, symbol, nombre FROM acciones WHERE id = $1 FOR UPDATE',
      [stockId.toString()]);
    if (!stock) throw new ApiError(404, { detail: 'La acción no existe.' });

    const cash = readDecimal(user.cash_balance, 2);
    const amount = roundDivision(quantity * readDecimal(stock.precio, 2), shareUnits);
    if (amount <= 0n || amount > maxMoney) {
      throw new ApiError(400, { quantity: ['El importe debe ser al menos $0.01 y estar dentro del límite permitido.'] });
    }
    const { rows: [holding] } = await tx.query(
      'SELECT id, quantity, invested FROM portafolio WHERE usuario_id = $1 AND accion_id = $2 FOR UPDATE', [userId, stock.id],
    );
    const owned = holding ? readDecimal(holding.quantity, 6) : 0n;
    const invested = holding ? readDecimal(holding.invested, 2) : 0n;
    let balance;
    let verb;
    if (side === 'buy') {
      if (amount > cash) throw new ApiError(400, { detail: 'No tienes saldo disponible suficiente para esta compra.' });
      const newQuantity = owned + quantity;
      const newCost = invested + amount;
      if (newQuantity > maxShareUnits || newCost > maxMoney) {
        throw new ApiError(400, { quantity: ['La posición supera el límite permitido.'] });
      }
      if (holding) {
        await tx.query('UPDATE portafolio SET quantity = $2, invested = $3 WHERE id = $1',
          [holding.id, formatDecimal(newQuantity, 6), money(newCost)]);
      } else {
        await tx.query('INSERT INTO portafolio (usuario_id, accion_id, quantity, invested) VALUES ($1, $2, $3, $4)',
          [userId, stock.id, formatDecimal(newQuantity, 6), money(newCost)]);
      }
      balance = cash - amount;
      verb = 'Compra';
    } else {
      if (quantity > owned) throw new ApiError(400, { detail: 'No tienes suficientes títulos para esta venta.' });
      balance = cash + amount;
      if (balance > maxMoney) throw new ApiError(400, { detail: 'La venta supera el límite de saldo permitido.' });
      if (quantity === owned) {
        await tx.query('DELETE FROM portafolio WHERE id = $1', [holding.id]);
      } else {
        const costSold = roundDivision(invested * quantity, owned);
        await tx.query('UPDATE portafolio SET quantity = $2, invested = $3 WHERE id = $1',
          [holding.id, formatDecimal(owned - quantity, 6), money(invested - costSold)]);
      }
      verb = 'Venta';
    }

    const quantityText = formatDecimal(quantity, 6);
    const quantityLabel = quantityText.replace(/\.?0+$/, '');
    await tx.query('UPDATE usuarios SET cash_balance = $2 WHERE id = $1', [userId, money(balance)]);
    const { rows: [entry] } = await tx.query(
      `INSERT INTO transacciones AS t (usuario_id, accion_id, tipo, descripcion, cantidad, precio_unitario, monto, fecha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp()) RETURNING ${transactionColumns}, ${transactionTime}`,
      [userId, stock.id, side, `${verb} de ${quantityLabel} títulos de ${stock.nombre}`, quantityText, stock.precio, money(amount)],
    );
    return {
      detail: 'Operación de simulación registrada.',
      transaction: transactionData({ ...entry, symbol: stock.symbol, stock_name: stock.nombre }),
      cash_balance: money(balance),
    };
  });
}

export function mountFinance(app, { db, requireUser, requireCsrf }) {
  app.get('/api/stocks/', requireUser, async (req, res) => {
    res.json(await stocksFor(db, queryParam(req.query, 'search').trim()));
  });
  app.get('/api/portfolio/', requireUser, async (req, res) => {
    res.json(await portfolioFor(db, req.user));
  });
  app.get('/api/dashboard/', requireUser, async (req, res) => {
    const [portfolio, recentTransactions, chart, market] = await Promise.all([
      portfolioFor(db, req.user), transactionsFor(db, req.user.id, {}, true),
      investmentChart(db, req.user.id), stocksFor(db),
    ]);
    res.json({ user: userData(req.user), ...portfolio, recent_transactions: recentTransactions, chart, market });
  });
  app.get('/api/transactions/', requireUser, async (req, res) => {
    res.json(await transactionsFor(db, req.user.id, req.query));
  });
  app.post('/api/trades/', requireUser, requireCsrf, async (req, res) => {
    res.status(201).json(await executeTrade(db, req.user.id, tradeInput(req.body)));
  });
}
