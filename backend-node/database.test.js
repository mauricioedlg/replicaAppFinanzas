import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertSchema, migrate, openDatabase } from './database.js';

test('actualiza una base existente sin perder cuentas ni movimientos', async (t) => {
  const db = await openDatabase({ localDemo: true, localDatabase: 'memory://' });
  t.after(() => db.close());
  await db.exec(await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8'));
  await db.exec(`
    ALTER TABLE usuarios
      ADD COLUMN first_name varchar(150) NOT NULL,
      ADD COLUMN last_name varchar(150) NOT NULL,
      ADD COLUMN is_staff boolean NOT NULL,
      ADD COLUMN is_superuser boolean NOT NULL,
      ADD COLUMN active_session_key varchar(40) NOT NULL;
    INSERT INTO usuarios (username, email, password, nombre, telefono, is_active, date_joined,
      cash_balance, notifications, dark_mode, first_name, last_name, is_staff, is_superuser, active_session_key)
    VALUES ('existing', 'existing@example.test', 'stored_hash', 'Existente', '', true, NOW(),
      250.00, true, false, 'Nombre', 'Apellido', false, false, 'session-preexistente');
    INSERT INTO transacciones (tipo, descripcion, cantidad, precio_unitario, monto, fecha, usuario_id)
    VALUES ('deposit', 'Ejemplo', 0, 0, 250.00, NOW(), 1);
  `);
  await assert.rejects(() => assertSchema(db), /app_sessions/);
  assert.equal(await migrate(db), true);
  assert.equal(await migrate(db), false);
  const { rows: [oldAccount] } = await db.query(`
    SELECT password, cash_balance, first_name, active_session_key FROM usuarios WHERE username = 'existing'`);
  assert.deepEqual(oldAccount, {
    password: 'stored_hash',
    cash_balance: '250.00',
    first_name: 'Nombre',
    active_session_key: 'session-preexistente',
  });
  assert.equal((await db.query('SELECT monto FROM transacciones')).rows[0].monto, '250.00');
  const { rows: [newAccount] } = await db.query(`
    INSERT INTO usuarios (username, email, password, nombre, telefono, is_active, date_joined,
      cash_balance, notifications, dark_mode)
    VALUES ('new', 'new@example.test', 'new_hash', 'Nuevo', '', true, NOW(), 0, true, false)
    RETURNING first_name, is_staff, active_session_key
  `);
  assert.deepEqual(newAccount, { first_name: '', is_staff: false, active_session_key: '' });
});
