import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './database.js';
import { EmailDeliveryError } from './email.js';

function browser(base) {
  const cookies = new Map();
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${base}/api/auth/${path}/`, {
      method,
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        'Content-Type': 'application/json',
        'X-CSRFToken': cookies.get('csrftoken') ?? '',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) {
      const [name, value] = header.split(';', 1)[0].split('=');
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
    return { status: response.status, data: await response.json(), csrf: cookies.get('csrftoken') };
  };
}

test('acceso con una cuenta existente y recuperación segura', async (t) => {
  const config = {
    ...loadConfig({ env: {}, args: ['--local-demo'] }),
    localDatabase: 'memory://',
  };
  const db = await openDatabase(config);
  t.after(() => db.close());
  await migrate(db);
  const password = 'OriginalExample492!';
  const salt = 'existingFixtureSalt12345';
  const hash = pbkdf2Sync(password, salt, 1_000_000, 32, 'sha256').toString('base64');
  const address = 'owner@example.test';
  await db.query(`
    INSERT INTO usuarios (password, username, is_active, date_joined, email, nombre, telefono,
      cash_balance, notifications, dark_mode)
    VALUES ($1, 'existing_user', true, NOW(), $2, 'Persona de prueba', '',
      9999999999999999.99, false, false)`, [`pbkdf2_sha256$1000000$${salt}$${hash}`, address]);
  const messages = [];
  let emailUnavailable = false;
  const email = {
    ensureConfigured() {},
    async send(message) {
      if (emailUnavailable) throw new EmailDeliveryError('Error de entrega simulado.');
      messages.push(message);
    },
  };
  const server = createApp({ db, config, email }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const original = browser(base);
  const other = browser(base);
  const login = (device, identifier = address, input = password) => (
    device('login', { method: 'POST', body: { identifier, password: input } })
  );
  const submit = (device, path, body) => device(path, { method: 'POST', body });
  const latestCode = () => messages.at(-1).text.match(/\b[0-9]{6}\b/)[0];
  const credentials = (response) => ({ challenge_id: response.data.challenge_id, code: latestCode() });

  await t.test('verifica una contraseña PBKDF2 y vincula el código al navegador', async () => {
    assert.equal((await login(original)).status, 403);
    const { csrf } = await original('csrf');
    const pending = await login(original, 'OWNER@EXAMPLE.TEST');
    assert.equal(pending.status, 200);
    assert.equal(pending.data.verification_required, true);
    assert.equal(pending.data.expires_in, 600);
    assert.equal((await original('me')).status, 403);
    const code = credentials(pending);
    const { rows: [challenge] } = await db.query('SELECT * FROM login_challenges');
    assert.notEqual(challenge.code_digest, code.code);
    assert.equal(challenge.code_digest.length, 64);
    await other('csrf');
    assert.equal((await submit(other, 'login/verify', code)).status, 400);
    assert.equal((await login(original)).data.challenge_id, code.challenge_id);
    assert.equal(messages.length, 1);
    assert.equal((await submit(original, 'login/resend', { challenge_id: code.challenge_id })).status, 429);
    const verified = await submit(original, 'login/verify', code);
    assert.equal(verified.status, 200);
    assert.equal(verified.data.user.cash_balance, '9999999999999999.99');
    assert.equal('password' in verified.data.user, false);
    assert.notEqual(verified.csrf, csrf);
    assert.equal((await submit(original, 'login/verify', code)).status, 400);
  });

  await t.test('un nuevo dispositivo revoca la sesión anterior al verificar el código', async () => {
    await db.query("UPDATE login_challenges SET sent_at = NOW() - INTERVAL '61 seconds'");
    const pending = await login(other, 'EXISTING_USER');
    assert.equal(pending.status, 200);
    assert.equal((await original('me')).status, 200);
    assert.equal((await submit(other, 'login/verify', credentials(pending))).status, 200);
    assert.equal((await submit(original, 'logout', {})).status, 403);
    assert.equal((await other('me')).status, 200);
    const updated = await other('me', { method: 'PATCH', body: { dark_mode: true, cash_balance: '0.00' } });
    assert.equal(updated.data.user.dark_mode, true);
    assert.equal(updated.data.user.cash_balance, '9999999999999999.99');
  });

  await t.test('la recuperación conserva el token si la contraseña se rechaza y revoca la sesión al cambiarla', async () => {
    const recipient = { email: address };
    const pending = await submit(original, 'password-reset/request', recipient);
    assert.equal(pending.status, 200);
    const code = { ...recipient, ...credentials(pending) };
    const verification = await submit(original, 'password-reset/verify', code);
    assert.equal(verification.status, 200);
    assert.equal((await submit(original, 'password-reset/verify', code)).status, 400);
    const token = { ...recipient, challenge_id: code.challenge_id, reset_token: verification.data.reset_token };
    const changePassword = (value) => submit(original, 'password-reset/confirm', {
      ...token, password: value, confirm_password: value,
    });
    assert.equal((await changePassword('password')).status, 400);
    const newPassword = 'AnotherPrivate3729!';
    emailUnavailable = true;
    const confirmed = await changePassword(newPassword);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.confirmation_email_sent, false);
    assert.equal((await other('me')).status, 403);
    assert.equal((await login(original)).status, 400);
    assert.equal((await changePassword(newPassword)).status, 400);
  });

  await t.test('el registro se revierte si el correo falla', async () => {
    const account = {
      username: 'undelivered', email: 'undelivered@example.test',
      nombre: 'Persona de prueba', password: 'AnotherPrivate789!',
    };
    assert.equal((await submit(original, 'register', { ...account, email: 'undelivered@example.test/path' })).status, 400);
    assert.equal((await submit(original, 'register', account)).status, 503);
    assert.equal((await db.query('SELECT id FROM usuarios WHERE username = $1', [account.username])).rowCount, 0);
    emailUnavailable = false;
    const registered = await submit(original, 'register', account);
    assert.equal(registered.status, 201);
    assert.equal((await original('me')).status, 403);
    assert.equal((await submit(original, 'login/verify', credentials(registered))).data.user.username, account.username);
  });
});
