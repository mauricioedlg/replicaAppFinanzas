import { pbkdf2, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { ApiError, escapeHtml, saltedHmac, secureEqual, uuid } from './common.js';
import { formatDecimal, readDecimal } from './decimal.js';
import { EmailDeliveryError } from './email.js';

const derivePassword = promisify(pbkdf2);
const PASSWORD_ITERATIONS = 1_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CODE_TTL = 600;
const RESET_TTL = 300;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;
const NONCE_COOKIE = 'folio_login_nonce';
const INVALID_LOGIN = 'El usuario o la contraseña son incorrectos.';
const INVALID_CODE = 'El código es inválido o ha vencido. Solicita uno nuevo e inténtalo de nuevo.';
const INVALID_TOKEN = 'La verificación es inválida o ha vencido. Solicita un nuevo código.';
const LOGIN_EMAIL_ERROR = 'No pudimos enviar el código de acceso. Inténtalo de nuevo más tarde.';
const RESET_EMAIL_ERROR = 'La recuperación no está disponible en este momento. Inténtalo de nuevo más tarde.';
const RESET_REQUEST_DETAIL = 'Si el correo está registrado, recibirás un código de verificación. Revisa también tu carpeta de spam.';
const SELECT_USER = 'SELECT * FROM usuarios';

const commonPasswords = new Set(
  gunzipSync(readFileSync(new URL('./common-passwords.txt.gz', import.meta.url)))
    .toString('utf8').trim().split(/\r?\n/).map((line) => line.trim()),
);

export function userData(user) {
  return {
    id: Number(user.id),
    username: user.username,
    email: user.email,
    nombre: user.nombre,
    telefono: user.telefono,
    cash_balance: formatDecimal(readDecimal(user.cash_balance, 2), 2),
    notifications: user.notifications,
    dark_mode: user.dark_mode,
  };
}

function textField(body, name, { min = 1, max, trim = true, pattern, message } = {}) {
  const raw = body[name];
  if (raw === undefined) throw new ApiError(400, { [name]: ['Este campo es requerido.'] });
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new ApiError(400, { [name]: ['Introduce un valor válido.'] });
  }
  const value = trim ? String(raw).trim() : String(raw);
  if (/[\u0000\uD800-\uDFFF]/u.test(value)) {
    throw new ApiError(400, { [name]: ['Introduce un valor válido.'] });
  }
  const length = [...value].length;
  if (!length && min) throw new ApiError(400, { [name]: ['Este campo no puede estar en blanco.'] });
  if (max !== undefined && length > max) {
    throw new ApiError(400, { [name]: [`Asegúrate de que este campo no tenga más de ${max} caracteres.`] });
  }
  if (length < min || (pattern && length > 0 && !pattern.test(value))) {
    throw new ApiError(400, { [name]: [message ?? 'Introduce un valor válido.'] });
  }
  return value;
}

function emailField(body) {
  const email = textField(body, 'email', { max: 254 }).toLowerCase();
  const separator = email.lastIndexOf('@');
  const local = email.slice(0, separator);
  const address = email.slice(separator + 1);
  const domain = domainToASCII(address);
  const labels = domain.split('.');
  const validDomain = domain === 'localhost' || (
    labels.length > 1 && /^(?:[a-z-]{2,63}|xn--[a-z0-9-]{1,59})$/i.test(labels.at(-1))
    && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) || (/^\[.+\]$/.test(address) && isIP(address.slice(1, -1)) !== 0);
  const validLocal = /^[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/i.test(local)
    ? !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    : /^"(?:[^"\\\r\n]|\\[^\r\n])*"$/.test(local);
  if (separator < 1 || /[\s/\\?#%]/u.test(address) || !validDomain || !validLocal) {
    throw new ApiError(400, { email: ['Introduce una dirección de correo electrónico válida.'] });
  }
  return email;
}

function challengeField(body) {
  const value = uuid(body.challenge_id);
  if (!value) throw new ApiError(400, { challenge_id: ['Introduce un UUID válido.'] });
  return value;
}

function codeField(body) {
  return textField(body, 'code', { min: 6, max: 6, trim: false, pattern: /^[0-9]{6}$/ });
}

function booleanField(body, name) {
  const value = typeof body[name] === 'string' ? body[name].toLowerCase() : body[name];
  if ([true, 1, '1', 'true', 'yes', 'on', 't', 'y'].includes(value)) return true;
  if ([false, 0, '0', 'false', 'no', 'off', 'f', 'n'].includes(value)) return false;
  throw new ApiError(400, { [name]: ['Introduce un booleano válido.'] });
}

function profileFields(body, partial) {
  const fields = {};
  if (!partial || 'email' in body) fields.email = emailField(body);
  if (!partial || 'nombre' in body) fields.nombre = textField(body, 'nombre', { max: 150 });
  if ('telefono' in body) {
    fields.telefono = textField(body, 'telefono', {
      min: 0,
      max: 30,
      pattern: /^[+()\p{Nd}\s-]{7,30}$/u,
      message: 'Escribe un teléfono válido de 7 a 30 caracteres.',
    });
  }
  if (partial && 'notifications' in body) fields.notifications = booleanField(body, 'notifications');
  if (partial && 'dark_mode' in body) fields.dark_mode = booleanField(body, 'dark_mode');
  return fields;
}

function validatePassword(password, user) {
  const errors = [];
  const normalized = password.toLowerCase();
  const counts = new Map();
  for (const letter of normalized) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  for (const [field, label] of [
    ['username', 'nombre de usuario'],
    ['nombre', 'nombre'],
    ['email', 'dirección de correo electrónico'],
  ]) {
    if (!user[field]) continue;
    const value = user[field].toLowerCase();
    const parts = [value, ...value.split(/[^\p{L}\p{N}_]+/u)];
    const similar = parts.some((part) => {
      const available = new Map(counts);
      let matches = 0;
      for (const letter of part) {
        const remaining = available.get(letter) ?? 0;
        if (remaining > 0) {
          matches += 1;
          available.set(letter, remaining - 1);
        }
      }
      return 2 * matches / ([...normalized].length + [...part].length) >= 0.7;
    });
    if (similar) {
      errors.push(`La contraseña es demasiado similar a ${label}.`);
      break;
    }
  }
  if ([...password].length < 8) errors.push('La contraseña debe contener al menos 8 caracteres.');
  if (commonPasswords.has(normalized.trim())) errors.push('Esta contraseña es demasiado común.');
  if (!/[^\p{N}]/u.test(password)) errors.push('Esta contraseña es completamente numérica.');
  if (errors.length) throw new ApiError(400, { password: errors });
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${salt}$${hash.toString('base64')}`;
}

async function checkPassword(password, encoded = '') {
  const [algorithm, rounds, salt, digest] = encoded.split('$');
  const iterations = Number(rounds);
  if (['pbkdf2_sha256', 'pbkdf2_sha1'].includes(algorithm) && salt && digest
      && Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 10_000_000) {
    const method = algorithm === 'pbkdf2_sha256' ? 'sha256' : 'sha1';
    const candidate = await derivePassword(password, salt, iterations, method === 'sha256' ? 32 : 20, method);
    const matches = secureEqual(candidate.toString('base64'), digest);
    if (!matches && method === 'sha256' && iterations < PASSWORD_ITERATIONS) {
      await derivePassword(password, salt, PASSWORD_ITERATIONS - iterations, 32, method);
    }
    return matches;
  }
  await hashPassword(password);
  return false;
}

function challengeDigest(secret, kind, purpose, value) {
  return saltedHmac(`folio.${kind}.${purpose}`, value, secret);
}

function fingerprint(secret, kind, user) {
  return challengeDigest(secret, kind, 'password', user.password);
}

function verifyDigest(secret, kind, purpose, challenge, value) {
  return challengeDigest(secret, kind, purpose, `${challenge.challenge_id}:${value}`);
}

function usableAccount(user) {
  return !!user?.is_active && !!user.password && !user.password.startsWith('!');
}

function accountMatches(secret, kind, user, challenge) {
  return usableAccount(user) && user.email.toLowerCase() === challenge.email.toLowerCase()
    && secureEqual(challenge.password_fingerprint, fingerprint(secret, kind, user));
}

function windowActive(challenge, now) {
  return !!challenge && +new Date(challenge.send_window_started_at) > +now - HOUR;
}

function remainingSeconds(date, now, offset = 0) {
  return Math.max(0, Math.ceil((+new Date(date) + offset - +now) / 1000));
}

function pendingLogin(challenge, now) {
  return challenge && !challenge.consumed_at && !!challenge.code_digest
    && Number(challenge.attempts) < MAX_ATTEMPTS && remainingSeconds(challenge.expires_at, now) > 0;
}

function loginMetadata(challenge, now) {
  const separator = challenge.email.lastIndexOf('@');
  return {
    verification_required: true,
    challenge_id: challenge.challenge_id,
    email_hint: `${challenge.email.slice(0, separator).slice(0, 2)}***${challenge.email.slice(separator)}`,
    detail: 'Te enviamos un código por correo. Verifícalo para iniciar sesión.',
    expires_in: remainingSeconds(challenge.expires_at, now),
    retry_after: remainingSeconds(challenge.sent_at, now, MINUTE),
  };
}

function nonceFor(req) {
  const value = req.cookies?.[NONCE_COOKIE];
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

function browserMatches(secret, req, challenge) {
  const nonce = nonceFor(req);
  return !!nonce && secureEqual(challenge.browser_digest, verifyDigest(secret, 'login-verification', 'browser', challenge, nonce));
}

async function sendCodeEmail(email, user, challenge, code, isLogin) {
  const name = user.nombre || user.username;
  const title = isLogin ? 'Verifica tu acceso a App Finanzas Mauricio' : 'Recupera tu cuenta de App Finanzas Mauricio';
  const description = isLogin ? 'iniciar sesión en App Finanzas Mauricio' : 'recuperar tu cuenta de App Finanzas Mauricio';
  const security = isLogin
    ? 'Ingresa el código en la pantalla de acceso. Al verificarlo, tu sesión quedará guardada en este dispositivo y se cerrará la sesión anterior. Si no solicitaste este acceso, no compartas el código y cambia tu contraseña.'
    : 'Ingresa el código en la pantalla de recuperación para crear una contraseña. Si no solicitaste este cambio, ignora este correo y no compartas el código.';
  return email.send({
    to: user.email,
    subject: `Tu código para ${description}`,
    text: `Hola, ${name}.\n\nTu código para ${description} es ${code}.\n\nVence en 10 minutos y solo puede utilizarse una vez. ${security}`,
    html: `<h1>${title}</h1><p>Hola, ${escapeHtml(name)}.</p>
      <p>Tu código de verificación es:</p><p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p>
      <p>Vence en 10 minutos y solo puede utilizarse una vez. ${security}</p>`,
    idempotencyKey: `${isLogin ? 'login-verification' : 'password-reset'}-code/${challenge.challenge_id}`,
  });
}

async function sendResetConfirmation(email, user, challengeId) {
  const name = user.nombre || user.username;
  const body = 'Tu contraseña de App Finanzas Mauricio se actualizó correctamente. Ya puedes iniciar sesión con tu nueva contraseña. Las sesiones anteriores se cerraron.';
  const security = 'Si no reconoces este cambio, recupera tu cuenta nuevamente y contacta a soporte. Nunca te pediremos tu contraseña por correo.';
  return email.send({
    to: user.email,
    subject: 'Tu contraseña de App Finanzas Mauricio se actualizó',
    text: `Hola, ${name}.\n\n${body}\n\n${security}`,
    html: `<h1>Tu contraseña se actualizó</h1><p>Hola, ${escapeHtml(name)}.</p><p>${body}</p><p>${security}</p>`,
    idempotencyKey: `password-reset-confirmation/${challengeId}`,
  });
}

function deliveryError(error, detail) {
  if (error instanceof EmailDeliveryError) throw new ApiError(503, { detail });
  throw error;
}

async function loginChallengeFor(tx, challengeId) {
  const { rows: [owner] } = await tx.query('SELECT user_id FROM login_challenges WHERE challenge_id = $1', [challengeId]);
  if (!owner) return {};
  // Account must be locked before its challenge in every mutation.
  const { rows: [user] } = await tx.query(`${SELECT_USER} WHERE id = $1 FOR UPDATE`, [owner.user_id]);
  const { rows: [challenge] } = await tx.query(
    'SELECT * FROM login_challenges WHERE user_id = $1 AND challenge_id = $2 FOR UPDATE',
    [owner.user_id, challengeId],
  );
  return { user, challenge };
}

async function recordBadCode(tx, kind, challenge) {
  const attempts = Number(challenge.attempts) + 1;
  // Table selection is internal and never derived from request input.
  const table = kind === 'login-verification' ? 'login_challenges' : 'password_reset_challenges';
  await tx.query(`UPDATE ${table} SET attempts = $1, code_digest = $2 WHERE id = $3`, [
    attempts, attempts >= MAX_ATTEMPTS ? '' : challenge.code_digest, challenge.id,
  ]);
}

async function replaceLoginChallenge(tx, email, config, req, user, old, now) {
  const active = windowActive(old, now);
  const retryAfter = active && Number(old.send_count) >= MAX_SENDS
    ? remainingSeconds(old.send_window_started_at, now, HOUR)
    : old ? remainingSeconds(old.sent_at, now, MINUTE) : 0;
  if (retryAfter > 0) {
    throw new ApiError(429, {
      detail: 'Espera antes de solicitar otro código de acceso.',
      retry_after: retryAfter,
    }, { 'Retry-After': String(retryAfter) });
  }
  const nonce = nonceFor(req) || randomBytes(32).toString('base64url');
  const challenge = {
    challenge_id: randomUUID(),
    email: user.email,
    expires_at: new Date(+now + CODE_TTL * 1000),
    sent_at: now,
  };
  const code = String(randomInt(1_000_000)).padStart(6, '0');
  const kind = 'login-verification';
  await tx.query(`
    INSERT INTO login_challenges
      (user_id, challenge_id, email, password_fingerprint, browser_digest, code_digest,
       expires_at, consumed_at, attempts, sent_at, send_window_started_at, send_count)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 0, $8, $9, $10)
    ON CONFLICT (user_id) DO UPDATE SET
      challenge_id = EXCLUDED.challenge_id, email = EXCLUDED.email,
      password_fingerprint = EXCLUDED.password_fingerprint, browser_digest = EXCLUDED.browser_digest,
      code_digest = EXCLUDED.code_digest, expires_at = EXCLUDED.expires_at, consumed_at = NULL,
      attempts = 0, sent_at = EXCLUDED.sent_at, send_window_started_at = EXCLUDED.send_window_started_at,
      send_count = EXCLUDED.send_count
  `, [user.id, challenge.challenge_id, user.email, fingerprint(config.secret, kind, user),
    verifyDigest(config.secret, kind, 'browser', challenge, nonce),
    verifyDigest(config.secret, kind, 'code', challenge, code),
    challenge.expires_at, now, active ? old.send_window_started_at : now,
    active ? Number(old.send_count) + 1 : 1]);
  await sendCodeEmail(email, user, challenge, code, true);
  return { nonce, metadata: loginMetadata(challenge, now) };
}

async function beginLogin(tx, email, config, req, user) {
  email.ensureConfigured();
  const now = new Date();
  const { rows: [challenge] } = await tx.query('SELECT * FROM login_challenges WHERE user_id = $1 FOR UPDATE', [user.id]);
  if (pendingLogin(challenge, now) && accountMatches(config.secret, 'login-verification', user, challenge)
      && browserMatches(config.secret, req, challenge)) return { metadata: loginMetadata(challenge, now) };
  return replaceLoginChallenge(tx, email, config, req, user, challenge, now);
}

async function resetAccount(tx, email) {
  const { rows: [user] } = await tx.query(`${SELECT_USER} WHERE LOWER(email) = $1 AND is_active = TRUE LIMIT 1 FOR UPDATE`, [email]);
  return usableAccount(user) ? user : null;
}

async function validResetChallenge(tx, config, user, email, challengeId, now) {
  if (!user) return null;
  const { rows: [challenge] } = await tx.query(
    'SELECT * FROM password_reset_challenges WHERE user_id = $1 AND challenge_id = $2 FOR UPDATE',
    [user.id, challengeId],
  );
  if (!challenge || challenge.consumed_at || remainingSeconds(challenge.expires_at, now) === 0
      || Number(challenge.attempts) >= MAX_ATTEMPTS || challenge.email.toLowerCase() !== email
      || !accountMatches(config.secret, 'password-reset', user, challenge)) return null;
  return challenge;
}

async function replaceResetChallenge(tx, config, email, user, recipient, challengeId, now) {
  const { rows: [old] } = await tx.query('SELECT * FROM password_reset_challenges WHERE user_id = $1 FOR UPDATE', [user.id]);
  const active = windowActive(old, now);
  if ((old && remainingSeconds(old.sent_at, now, MINUTE) > 0)
      || (active && Number(old.send_count) >= MAX_SENDS)) return;
  const challenge = { challenge_id: challengeId };
  const kind = 'password-reset';
  const code = String(randomInt(1_000_000)).padStart(6, '0');
  await tx.query(`
    INSERT INTO password_reset_challenges
      (user_id, challenge_id, email, password_fingerprint, code_digest, reset_token_digest,
       expires_at, verified_at, consumed_at, attempts, sent_at, send_window_started_at, send_count)
    VALUES ($1, $2, $3, $4, $5, '', $6, NULL, NULL, 0, $7, $8, $9)
    ON CONFLICT (user_id) DO UPDATE SET
      challenge_id = EXCLUDED.challenge_id, email = EXCLUDED.email,
      password_fingerprint = EXCLUDED.password_fingerprint, code_digest = EXCLUDED.code_digest,
      reset_token_digest = '', expires_at = EXCLUDED.expires_at, verified_at = NULL, consumed_at = NULL,
      attempts = 0, sent_at = EXCLUDED.sent_at, send_window_started_at = EXCLUDED.send_window_started_at,
      send_count = EXCLUDED.send_count
  `, [user.id, challengeId, recipient, fingerprint(config.secret, kind, user),
    verifyDigest(config.secret, kind, 'code', challenge, code),
    new Date(+now + CODE_TTL * 1000), now, active ? old.send_window_started_at : now,
    active ? Number(old.send_count) + 1 : 1]);
  await sendCodeEmail(email, user, challenge, code, false);
}

function bodyData(req) {
  if (!req.body) return {};
  if (Array.isArray(req.body) || typeof req.body !== 'object') {
    throw new ApiError(400, { non_field_errors: ['Se esperaba un objeto JSON.'] });
  }
  return req.body;
}

export function mountAuth(app, { db, config, email, requireUser, requireCsrf, throttle, sessions }) {
  const publicAction = (scope, limit, windowMs) => [requireCsrf, throttle(scope, limit, windowMs)];
  const nonceOptions = { httpOnly: true, secure: config.sessionCookieSecure, sameSite: 'lax', path: '/' };
  const writeLogin = (res, result, status = 200) => {
    if (result.nonce) {
      res.cookie(NONCE_COOKIE, result.nonce, { ...nonceOptions, maxAge: (config.sessionDays ?? 365) * 24 * HOUR });
    }
    return res.status(status).json(result.metadata);
  };

  app.post('/api/auth/login/', ...publicAction('login', 10, MINUTE), async (req, res) => {
    const body = bodyData(req);
    const identifier = textField(body, 'identifier', { max: 254 }).toLowerCase();
    const password = textField(body, 'password', { max: 128, trim: false });
    const { rows: [candidate] } = await db.query(
      `${SELECT_USER} WHERE LOWER(username) = $1 OR LOWER(email) = $1 ORDER BY id LIMIT 1`,
      [identifier],
    );
    const valid = await checkPassword(password, candidate?.password);
    if (!valid || !usableAccount(candidate)) throw new ApiError(400, { detail: INVALID_LOGIN });
    try {
      const result = await db.transaction(async (tx) => {
        const { rows: [user] } = await tx.query(`${SELECT_USER} WHERE id = $1 FOR UPDATE`, [candidate.id]);
        if (!usableAccount(user) || !secureEqual(candidate.password, user.password)) {
          throw new ApiError(400, { detail: INVALID_LOGIN });
        }
        return beginLogin(tx, email, config, req, user);
      });
      return writeLogin(res, result);
    } catch (error) {
      deliveryError(error, LOGIN_EMAIL_ERROR);
    }
  });

  app.post('/api/auth/register/', ...publicAction('login', 10, MINUTE), async (req, res) => {
    const body = bodyData(req);
    const username = textField(body, 'username', { min: 3, max: 150, pattern: /^[A-Za-z0-9_.-]+$/ });
    const fields = profileFields(body, false);
    const password = textField(body, 'password', { max: 128, trim: false });
    const { rows: conflicts } = await db.query(
      'SELECT username, email FROM usuarios WHERE LOWER(username) = $1 OR LOWER(email) = $2',
      [username.toLowerCase(), fields.email],
    );
    const errors = {};
    if (conflicts.some((row) => row.username.toLowerCase() === username.toLowerCase())) {
      errors.username = ['Este nombre de usuario ya está registrado.'];
    }
    if (conflicts.some((row) => row.email.toLowerCase() === fields.email)) {
      errors.email = ['Este correo ya está registrado.'];
    }
    if (Object.keys(errors).length) throw new ApiError(400, errors);
    validatePassword(password, { ...fields, username });
    const passwordHash = await hashPassword(password);
    try {
      const result = await db.transaction(async (tx) => {
        const { rows: [user] } = await tx.query(`
          INSERT INTO usuarios
            (username, email, nombre, telefono, password, is_active, date_joined, cash_balance, notifications, dark_mode)
          VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP, 0, TRUE, FALSE)
          RETURNING *
        `, [username, fields.email, fields.nombre, fields.telefono ?? '', passwordHash]);
        return beginLogin(tx, email, config, req, user);
      });
      return writeLogin(res, result, 201);
    } catch (error) {
      if (error.code === '23505') throw new ApiError(400, { detail: 'El usuario o correo ya está registrado.' });
      deliveryError(error, LOGIN_EMAIL_ERROR);
    }
  });

  app.post('/api/auth/login/verify/', ...publicAction('login_verify', 30, MINUTE), async (req, res) => {
    const body = bodyData(req);
    const challengeId = challengeField(body);
    const code = codeField(body);
    const now = new Date();
    const kind = 'login-verification';
    const verified = await db.transaction(async (tx) => {
      const { user, challenge } = await loginChallengeFor(tx, challengeId);
      if (!user || !pendingLogin(challenge, now) || !accountMatches(config.secret, kind, user, challenge)
          || !browserMatches(config.secret, req, challenge)) return null;
      if (!secureEqual(challenge.code_digest, verifyDigest(config.secret, kind, 'code', challenge, code))) {
        await recordBadCode(tx, kind, challenge);
        return null;
      }
      await tx.query("UPDATE login_challenges SET consumed_at = $1, code_digest = '' WHERE id = $2", [now, challenge.id]);
      const commitCookies = await sessions.establish(req, res, tx, user);
      return { user, commitCookies };
    });
    if (!verified) throw new ApiError(400, { detail: INVALID_CODE });
    verified.commitCookies();
    res.clearCookie(NONCE_COOKIE, nonceOptions);
    return res.json({ user: userData(verified.user) });
  });

  app.post('/api/auth/login/resend/', ...publicAction('login_resend', 10, HOUR), async (req, res) => {
    const challengeId = challengeField(bodyData(req));
    const now = new Date();
    try {
      const result = await db.transaction(async (tx) => {
        const { user, challenge } = await loginChallengeFor(tx, challengeId);
        if (!user || !challenge || challenge.consumed_at || !accountMatches(config.secret, 'login-verification', user, challenge)
            || !browserMatches(config.secret, req, challenge)) throw new ApiError(400, { detail: INVALID_CODE });
        email.ensureConfigured();
        return replaceLoginChallenge(tx, email, config, req, user, challenge, now);
      });
      return writeLogin(res, result);
    } catch (error) {
      deliveryError(error, LOGIN_EMAIL_ERROR);
    }
  });

  app.post('/api/auth/password-reset/request/', ...publicAction('password_reset_request', 10, HOUR), async (req, res) => {
    const recipient = emailField(bodyData(req));
    const challengeId = randomUUID();
    const now = new Date();
    try {
      email.ensureConfigured();
      await db.transaction(async (tx) => {
        const user = await resetAccount(tx, recipient);
        if (user) await replaceResetChallenge(tx, config, email, user, recipient, challengeId, now);
      });
    } catch (error) {
      deliveryError(error, RESET_EMAIL_ERROR);
    }
    return res.json({
      detail: RESET_REQUEST_DETAIL,
      challenge_id: challengeId,
      expires_in: CODE_TTL,
      retry_after: MINUTE / 1000,
    });
  });

  app.post('/api/auth/password-reset/verify/', ...publicAction('password_reset_verify', 30, MINUTE), async (req, res) => {
    const body = bodyData(req);
    const recipient = emailField(body);
    const challengeId = challengeField(body);
    const code = codeField(body);
    const now = new Date();
    const kind = 'password-reset';
    const resetToken = await db.transaction(async (tx) => {
      const user = await resetAccount(tx, recipient);
      const challenge = await validResetChallenge(tx, config, user, recipient, challengeId, now);
      if (!challenge || challenge.verified_at || !challenge.code_digest) return null;
      if (!secureEqual(challenge.code_digest, verifyDigest(config.secret, kind, 'code', challenge, code))) {
        await recordBadCode(tx, kind, challenge);
        return null;
      }
      const token = randomBytes(32).toString('base64url');
      await tx.query(`
        UPDATE password_reset_challenges
        SET reset_token_digest = $1, code_digest = '', verified_at = $2, expires_at = $3
        WHERE id = $4
      `, [verifyDigest(config.secret, kind, 'token', challenge, token), now, new Date(+now + RESET_TTL * 1000), challenge.id]);
      return token;
    });
    if (!resetToken) throw new ApiError(400, { detail: INVALID_CODE });
    return res.json({ reset_token: resetToken, expires_in: RESET_TTL });
  });

  app.post('/api/auth/password-reset/confirm/', ...publicAction('password_reset_confirm', 10, MINUTE), async (req, res) => {
    const body = bodyData(req);
    const recipient = emailField(body);
    const challengeId = challengeField(body);
    const token = textField(body, 'reset_token', { min: 32, max: 128, trim: false });
    const password = textField(body, 'password', { max: 128, trim: false });
    const confirmation = textField(body, 'confirm_password', { max: 128, trim: false });
    if (password !== confirmation) {
      throw new ApiError(400, { confirm_password: ['Las contraseñas no coinciden.'] });
    }
    const now = new Date();
    const user = await db.transaction(async (tx) => {
      const account = await resetAccount(tx, recipient);
      const challenge = await validResetChallenge(tx, config, account, recipient, challengeId, now);
      if (!challenge?.verified_at || !challenge.reset_token_digest
          || !secureEqual(challenge.reset_token_digest, verifyDigest(config.secret, 'password-reset', 'token', challenge, token))) {
        throw new ApiError(400, { detail: INVALID_TOKEN });
      }
      validatePassword(password, account);
      const passwordHash = await hashPassword(password);
      await tx.query('UPDATE usuarios SET password = $1 WHERE id = $2', [passwordHash, account.id]);
      await sessions.revokeAccount(req, tx, account.id);
      await tx.query(`
        UPDATE password_reset_challenges SET consumed_at = $1, code_digest = '', reset_token_digest = ''
        WHERE id = $2
      `, [now, challenge.id]);
      return account;
    });
    sessions.clear(res);
    res.clearCookie(NONCE_COOKIE, nonceOptions);
    let confirmationEmailSent = true;
    try {
      await sendResetConfirmation(email, user, challengeId);
    } catch (error) {
      if (!(error instanceof EmailDeliveryError)) throw error;
      confirmationEmailSent = false;
    }
    return res.json({
      detail: confirmationEmailSent
        ? 'Tu contraseña se ha actualizado. Te enviamos un correo de confirmación.'
        : 'Tu contraseña se ha actualizado. No pudimos enviar el correo de confirmación, pero ya puedes iniciar sesión.',
      confirmation_email_sent: confirmationEmailSent,
    });
  });

  app.get('/api/auth/me/', requireUser, (req, res) => res.json({ user: userData(req.user) }));

  app.patch('/api/auth/me/', requireUser, requireCsrf, async (req, res) => {
    const changes = Object.entries(profileFields(bodyData(req), true));
    if (!changes.length) return res.json({ user: userData(req.user) });
    const values = changes.map(([, value]) => value);
    const assignments = changes.map(([field], index) => `${field} = $${index + 1}`);
    try {
      const { rows: [user] } = await db.query(
        `UPDATE usuarios SET ${assignments.join(', ')} WHERE id = $${values.length + 1} RETURNING *`,
        [...values, req.user.id],
      );
      return res.json({ user: userData(user) });
    } catch (error) {
      if (error.code === '23505') throw new ApiError(400, { email: ['Este correo ya está registrado.'] });
      throw error;
    }
  });

  app.post('/api/auth/logout/', requireUser, requireCsrf, async (req, res) => {
    await sessions.revoke(req, res);
    res.clearCookie(NONCE_COOKIE, nonceOptions);
    return res.json({ detail: 'Sesión cerrada.' });
  });
}
