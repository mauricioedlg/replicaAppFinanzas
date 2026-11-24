import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from './config.js';

const schemaFile = new URL('../database/schema.sql', import.meta.url);
const sessionsFile = new URL('../database/sessions.sql', import.meta.url);
const seedFile = new URL('../database/seed.sql', import.meta.url);
const businessTables = [
  'usuarios', 'acciones', 'portafolio', 'transacciones',
  'login_challenges', 'password_reset_challenges', 'stripe_customers',
  'payment_cards', 'card_verifications', 'payment_topups', 'payment_email_outbox',
];
const tables = [...businessTables, 'app_sessions'];
const existingUserDefaults = new Map([
  ['first_name', "''"], ['last_name', "''"],
  ['is_staff', 'false'], ['is_superuser', 'false'], ['active_session_key', "''"],
]);

function queryInterface(connection) {
  return {
    async query(sql, params = []) {
      const result = await connection.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
    },
    exec: (sql) => connection.exec ? connection.exec(sql) : connection.query(sql),
  };
}

export async function openDatabase(config) {
  if (config.localDemo) {
    const { PGlite } = await import('@electric-sql/pglite');
    const connection = await PGlite.create(config.localDatabase);
    return {
      ...queryInterface(connection),
      transaction: (work) => connection.transaction((tx) => work(queryInterface(tx))),
      close: () => connection.close(),
    };
  }

  let url;
  try { url = new URL(config.databaseUrl); } catch { /* checked below */ }
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Configura una DATABASE_URL de PostgreSQL o inicia con --local-demo.');
  }
  const sslMode = url.searchParams.get('sslmode');
  if (url.hostname.endsWith('.neon.tech') && (!sslMode || sslMode === 'require')) {
    url.searchParams.set('sslmode', 'verify-full');
  }
  const pool = new pg.Pool({
    connectionString: url.toString(),
    enableChannelBinding: url.searchParams.get('channel_binding') !== 'disable',
    connectionTimeoutMillis: 10_000,
    application_name: 'app-finanzas-node',
  });
  pool.on('error', (error) => console.error('Se perdió una conexión de PostgreSQL.', error.code || error.name));
  return {
    ...queryInterface(pool),
    async transaction(work) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        const result = await work(queryInterface(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    close: () => pool.end(),
  };
}

async function installedTables(db) {
  const { rows } = await db.query(
    'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL',
    [tables],
  );
  return new Set(rows.map(({ name }) => name));
}

function assertTables(installed, expected) {
  const missing = expected.filter((name) => !installed.has(name));
  if (missing.length) {
    throw new Error(`Esquema incompleto. Ejecuta npm run migrate. Tablas faltantes: ${missing.join(', ')}.`);
  }
}

export async function assertSchema(db) {
  assertTables(await installedTables(db), tables);
  await db.query('SELECT session_key, user_id, credential_hash, expires_at FROM app_sessions LIMIT 0');
}

async function allowExistingUserTables(tx) {
  // Older databases may require extra user fields that the API no longer writes.
  const { rows } = await tx.query(`
    SELECT attname FROM pg_catalog.pg_attribute
    WHERE attrelid = 'usuarios'::regclass AND attnum > 0 AND NOT attisdropped
      AND attnotnull AND NOT atthasdef AND attname = ANY($1::text[])
  `, [[...existingUserDefaults.keys()]]);
  if (!rows.length) return false;
  const changes = rows.map(({ attname }) => `ALTER COLUMN "${attname}" SET DEFAULT ${existingUserDefaults.get(attname)}`);
  await tx.exec(`ALTER TABLE usuarios ${changes.join(', ')}`);
  return true;
}

export async function migrate(db) {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL lock_timeout = '5s'");
    await tx.query('SELECT pg_advisory_xact_lock(24166131)');
    const installed = await installedTables(tx);
    if (installed.size) assertTables(installed, businessTables);
    else await tx.exec(await readFile(schemaFile, 'utf8'));
    const needsSessions = !installed.has('app_sessions');
    if (needsSessions) await tx.exec(await readFile(sessionsFile, 'utf8'));
    const changedDefaults = await allowExistingUserTables(tx);
    await assertSchema(tx);
    return needsSessions || changedDefaults;
  });
}

export async function seedDemo(db) {
  const script = await readFile(seedFile, 'utf8');
  return db.transaction(async (tx) => {
    await assertSchema(tx);
    await tx.query('SELECT pg_advisory_xact_lock(24166131)');
    await tx.exec(script.replace(/^BEGIN;\r?$/m, '').replace(/^COMMIT;\r?$/m, ''));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  let database;
  try {
    database = await openDatabase(loadConfig({ args }));
    if (command === 'migrate') {
      console.log(await migrate(database) ? 'Esquema actualizado.' : 'El esquema ya está disponible.');
    } else if (command === 'seed') {
      await seedDemo(database);
      console.log('Catálogo BMV y datos de ejemplo disponibles.');
    } else {
      throw new Error('Usa el comando migrate o seed.');
    }
  } catch (error) {
    console.error('Error de base de datos.', error.message);
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}
