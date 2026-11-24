import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase, seedDemo } from './database.js';
import { createSessions } from './sessions.js';

test('migración y datos de ejemplo repetibles con una sesión persistente', async (t) => {
  const config = loadConfig({
    env: { NODE_SECRET_KEY: 'node-session-fixture-only', NODE_LOCAL_DATABASE: 'memory://' },
    args: ['--local-demo'],
  });
  const db = await openDatabase(config);
  t.after(() => db.close());
  assert.equal(await migrate(db), true);
  assert.equal(await migrate(db), false);
  await seedDemo(db);
  const sessions = createSessions(db, config);
  const cookies = new Map();
  const commitCookies = await db.transaction(async (tx) => {
    const { rows: [user] } = await tx.query('SELECT * FROM usuarios WHERE id = 1 FOR UPDATE');
    return sessions.establish({ cookies: {} }, { cookie: (name, value) => cookies.set(name, value) }, tx, user);
  });
  commitCookies();
  const token = cookies.get('sessionid');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const key = createHash('sha256').update(token).digest('hex');
  const oldExpiry = new Date(Date.now() + 60_000);
  assert.equal((await db.query('UPDATE app_sessions SET expires_at = $1 WHERE session_key = $2', [oldExpiry, key])).rowCount, 1);
  await seedDemo(db);

  const api = createApp({ db, config });
  const server = api.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const auth = { Cookie: `sessionid=${token}` };

  const health = await fetch(`${url}/api/health/`);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(`${url}/api/unknown/`)).status, 404);
  assert.equal((await fetch(`${url}/api/dashboard/`)).status, 403);
  assert.equal((await fetch(`${url}/api/dashboard/`, { headers: { Cookie: `sessionid=${key}` } })).status, 403);

  const dashboard = await fetch(`${url}/api/dashboard/`, { headers: auth });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('set-cookie'), /HttpOnly/);
  const data = await dashboard.json();
  assert.equal(data.user.cash_balance, '8420.50');
  assert.equal(data.market.length, 30);
  assert.equal(data.holdings.length, 6);
  assert.equal(data.recent_transactions.length, 5);
  const { rows: [{ expires_at: expiry }] } = await db.query('SELECT expires_at FROM app_sessions WHERE session_key = $1', [key]);
  assert.ok(new Date(expiry) > oldExpiry);
  const csrf = await fetch(`${url}/api/auth/csrf/`);
  const csrfToken = csrf.headers.get('set-cookie').match(/csrftoken=([^;]+)/)[1];
  const unauthorizedOrigin = await fetch(`${url}/api/auth/logout/`, {
    method: 'POST',
    headers: { Cookie: `${auth.Cookie}; csrftoken=${csrfToken}`, 'X-CSRFToken': csrfToken, Origin: 'https://other.example' },
  });
  assert.equal(unauthorizedOrigin.status, 403);
  const logout = await fetch(`${url}/api/auth/logout/`, {
    method: 'POST',
    headers: { Cookie: `${auth.Cookie}; csrftoken=${csrfToken}`, 'X-CSRFToken': csrfToken },
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${url}/api/auth/me/`, { headers: auth })).status, 403);
});
