import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ApiError, saltedHmac, secureEqual } from './common.js';

const csrfAlphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const validSessionToken = /^[A-Za-z0-9_-]{43}$/;
const validCsrfToken = /^[a-zA-Z0-9]{32}$/;
const authenticationError = 'Las credenciales de autenticación no se proveyeron.';
const csrfError = 'La sesión de seguridad expiró. Actualiza la página e inténtalo de nuevo.';

function tokenDigest(token) {
  if (typeof token !== 'string' || !validSessionToken.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

function csrfSecret() {
  return Array.from({ length: 32 }, () => csrfAlphabet[randomInt(csrfAlphabet.length)]).join('');
}

function csrfToken(token) {
  return typeof token === 'string' && validCsrfToken.test(token) ? token : null;
}

function trustedOrigin(origin, req, config) {
  const ownOrigin = `${req.protocol}://${req.get('host')}`;
  if (origin === ownOrigin) return true;
  return config.csrfTrustedOrigins.some((trusted) => {
    if (!trusted.includes('://*.')) return origin === trusted;
    const [scheme, domain] = trusted.split('://*.');
    return origin === `${scheme}://${domain}` || (origin.startsWith(`${scheme}://`) && origin.endsWith(`.${domain}`));
  });
}

export function createSessions(db, config) {
  const sessionOptions = { httpOnly: true, sameSite: 'lax', secure: config.sessionCookieSecure, path: '/' };
  const csrfOptions = { sameSite: 'lax', secure: config.csrfCookieSecure, path: '/', maxAge: 31_449_600_000 };
  const sessionAge = config.sessionDays * 86_400_000;
  const authHash = (user) => saltedHmac('folio.session.credential', user.password, config.secret);
  const setSession = (res, token) => res.cookie('sessionid', token, { ...sessionOptions, maxAge: sessionAge });
  const clear = (res) => res.clearCookie('sessionid', sessionOptions);
  const resetCsrf = (res) => res.cookie('csrftoken', csrfSecret(), csrfOptions);

  function ensureCsrfCookie(req, res) {
    res.cookie('csrftoken', csrfToken(req.cookies.csrftoken) ?? csrfSecret(), csrfOptions);
  }

  function requireCsrf(req, res, next) {
    const token = csrfToken(req.get('x-csrftoken'));
    const cookie = csrfToken(req.cookies.csrftoken);
    const origin = req.get('origin');
    let allowed = true;
    if (origin) allowed = trustedOrigin(origin, req, config);
    else if (req.secure) {
      try {
        const referer = new URL(req.get('referer'));
        allowed = referer.protocol === 'https:' && trustedOrigin(referer.origin, req, config);
      } catch {
        allowed = false;
      }
    }
    if (!allowed || !secureEqual(cookie, token)) throw new ApiError(403, csrfError);
    next();
  }

  async function requireUser(req, res, next) {
    const token = req.cookies.sessionid;
    const key = tokenDigest(token);
    if (!key) {
      if (token) clear(res);
      throw new ApiError(403, authenticationError);
    }
    const { rows: [user] } = await db.query(`
      SELECT u.*, s.credential_hash
      FROM app_sessions s JOIN usuarios u ON u.id = s.user_id
      WHERE s.session_key = $1 AND s.expires_at > now() AND u.is_active`, [key]);
    if (!user || !secureEqual(user.credential_hash, authHash(user))) {
      clear(res);
      throw new ApiError(403, authenticationError);
    }
    const expiry = new Date(Date.now() + sessionAge);
    const renewed = await db.query(
      'UPDATE app_sessions SET expires_at = GREATEST(expires_at, $1) WHERE session_key = $2 AND expires_at > now()',
      [expiry, key],
    );
    if (!renewed.rowCount) throw new ApiError(403, authenticationError);
    setSession(res, token);
    req.user = user;
    req.sessionKey = key;
    next();
  }

  async function revokeAccount(req, tx, userId) {
    const key = tokenDigest(req.cookies.sessionid);
    // Acquire matching sessions in the same order when requests affect two accounts.
    await tx.query(`
      WITH locked AS (
        SELECT session_key FROM app_sessions
        WHERE user_id = $1 OR session_key = $2
        ORDER BY session_key FOR UPDATE
      )
      DELETE FROM app_sessions WHERE session_key IN (SELECT session_key FROM locked)
    `, [userId, key]);
  }

  async function establish(req, res, tx, user) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await revokeAccount(req, tx, user.id);
    await tx.query('INSERT INTO app_sessions (session_key, user_id, credential_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenDigest(token), user.id, authHash(user), new Date(now.getTime() + sessionAge)]);
    await tx.query('UPDATE usuarios SET last_login = $1 WHERE id = $2', [now, user.id]);
    return () => {
      setSession(res, token);
      resetCsrf(res);
    };
  }

  async function revoke(req, res) {
    await db.query('DELETE FROM app_sessions WHERE user_id = $1 AND session_key = $2', [req.user.id, req.sessionKey]);
    clear(res);
  }

  return { clear, ensureCsrfCookie, requireCsrf, requireUser, establish, revoke, revokeAccount };
}
