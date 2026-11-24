import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import Stripe from 'stripe';
import { mountAuth } from './auth.js';
import { ApiError } from './common.js';
import { createEmail } from './email.js';
import { mountFinance } from './finance.js';
import { mountPayments } from './payments.js';
import { createSessions } from './sessions.js';

const frontend = fileURLToPath(new URL('../frontend/dist/', import.meta.url));
const index = fileURLToPath(new URL('../frontend/dist/index.html', import.meta.url));
const webhook = /^\/api\/stripe\/webhook\/?$/;

function buildThrottle() {
  const histories = new Map();
  let nextSweep = 0;
  return (scope, limit, windowMs) => (req, res, next) => {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [key, entry] of histories) {
        if (entry.times.at(-1) + entry.windowMs <= now) histories.delete(key);
      }
      nextSweep = now + 60_000;
    }
    const key = `${scope}:${req.user?.id ?? req.ip}`;
    const times = (histories.get(key)?.times ?? []).filter((time) => time > now - windowMs);
    if (times.length >= limit) {
      const retry = Math.ceil((times[0] + windowMs - now) / 1000);
      throw new ApiError(429, `Solicitud fue regulada (throttled). Se espera que esté disponible en ${retry} segundos.`,
        { 'Retry-After': String(retry) });
    }
    times.push(now);
    histories.set(key, { times, windowMs });
    next();
  };
}

function hostAllowed(hostname, allowedHosts) {
  const host = hostname?.toLowerCase().replace(/\.$/, '');
  return host && allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith('.')) return host === allowed.slice(1) || host.endsWith(allowed);
    return allowed === '*' || host === allowed;
  });
}

function securityHeaders(config) {
  return (req, res, next) => {
    const host = req.hostname;
    if (!hostAllowed(host, config.allowedHosts)) throw new ApiError(400, 'El host de la solicitud no está permitido.');
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (config.sslRedirect && !req.secure) {
      const target = new URL(`https://${req.get('host')}`);
      return res.redirect(301, `${target.origin}${req.originalUrl}`);
    }
    if (!config.debug && req.secure) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
    next();
  };
}

function apiHeaders(config) {
  return (req, res, next) => {
    const origin = req.get('origin');
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    if (config.corsAllowedOrigins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT',
        'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-CSRFToken',
        'Access-Control-Max-Age': '86400',
      });
      if (req.method === 'OPTIONS' && req.get('access-control-request-method')) return res.sendStatus(204);
    }
    next();
  };
}

function createStripe(config) {
  // A webhook can verify its signature even when Stripe API calls are disabled.
  const key = /^(sk|rk)_test_/.test(config.stripeSecretKey) ? config.stripeSecretKey : 'sk_test_unconfigured';
  return new Stripe(key, { apiVersion: '2026-10-28.endive', maxNetworkRetries: 1, timeout: 10_000 });
}

export function createApp({ db, config, email = createEmail(config), stripe = createStripe(config) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('trust proxy', config.proxyHops);
  app.use(securityHeaders(config));
  app.use('/api', apiHeaders(config));
  app.use(cookieParser());
  const parseWebhook = express.raw({ type: '*/*', limit: '1mb', inflate: false });
  const parseJson = express.json({ limit: '100kb' });
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && webhook.test(req.originalUrl.split('?')[0])) return parseWebhook(req, res, next);
    return parseJson(req, res, next);
  });

  const sessions = createSessions(db, config);
  const throttle = buildThrottle();
  const userLimit = throttle('user', 600, 60_000);
  const requireUser = [sessions.requireUser, userLimit];
  const context = { db, config, email, stripe, sessions, throttle, requireUser, requireCsrf: sessions.requireCsrf };
  app.get('/api/health/', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/auth/csrf/', (req, res) => {
    sessions.ensureCsrfCookie(req, res);
    res.json({ detail: 'Token CSRF disponible.' });
  });
  mountAuth(app, context);
  mountFinance(app, context);
  mountPayments(app, context);
  app.use('/api', (req, res) => res.status(404).json({ detail: 'Ruta de API no encontrada.' }));

  app.use('/static', express.static(frontend, { index: false, fallthrough: false }));
  app.get(/.*/, (req, res) => {
    sessions.ensureCsrfCookie(req, res);
    res.set('Cache-Control', 'no-cache');
    if (existsSync(index)) return res.sendFile(index);
    res.type('text').send('La API está disponible. Inicia el frontend con npm run dev o ejecuta npm run build en frontend/.');
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) return res.set(error.headers).status(error.status).json(error.body);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ detail: 'El cuerpo JSON no es válido.' });
    if (error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ detail: 'No se pudo procesar la solicitud.' });
    }
    console.error('Error interno de la API.', error.code || error.name);
    return res.status(500).json({ detail: 'Ocurrió un error en el servidor.' });
  });
  return app;
}
