import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export function loadConfig({ env, args = [] } = {}) {
  if (!env) {
    const file = new URL('../.env', import.meta.url);
    if (existsSync(file)) loadEnvFile(file);
    env = process.env;
  }
  const bool = (name, fallback = false) => env[name] === undefined
    ? fallback : ['true', '1', 'yes'].includes(env[name].toLowerCase());
  const list = (name, fallback) => (env[name] ?? fallback).split(',').map((item) => item.trim()).filter(Boolean);
  const debug = bool('NODE_DEBUG_MODE', env.NODE_ENV !== 'production');
  const secret = env.NODE_SECRET_KEY || 'local-development-only-change-before-deployment';
  if (!debug && secret === 'local-development-only-change-before-deployment') {
    throw new Error('Configura NODE_SECRET_KEY para producción.');
  }
  const sessionDays = Number(env.LOGIN_SESSION_DAYS ?? 365);
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 400) {
    throw new Error('LOGIN_SESSION_DAYS debe ser un entero entre 1 y 400.');
  }
  const port = Number(env.PORT ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT debe ser un entero entre 1 y 65535.');
  }
  const proxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isSafeInteger(proxyHops) || proxyHops < 0) {
    throw new Error('TRUST_PROXY_HOPS debe ser un entero mayor o igual a cero.');
  }
  const developmentOrigins = 'http://localhost:5173,http://127.0.0.1:5173';
  return {
    debug, secret, sessionDays, port, proxyHops,
    host: env.HOST || (debug ? '127.0.0.1' : '0.0.0.0'),
    allowedHosts: list('ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver'),
    csrfTrustedOrigins: list('CSRF_TRUSTED_ORIGINS', `${developmentOrigins},http://localhost:8000,http://127.0.0.1:8000`),
    corsAllowedOrigins: list('CORS_ALLOWED_ORIGINS', developmentOrigins),
    sessionCookieSecure: bool('SESSION_COOKIE_SECURE', !debug),
    csrfCookieSecure: bool('CSRF_COOKIE_SECURE', !debug),
    sslRedirect: bool('SECURE_SSL_REDIRECT', !debug),
    paymentWorker: !args.includes('--no-payment-worker') && bool('RUN_PAYMENT_EMAIL_WORKER', true),
    built: args.includes('--built'),
    localDemo: args.includes('--local-demo') || bool('NODE_LOCAL_DEMO'),
    localDatabase: env.NODE_LOCAL_DATABASE || fileURLToPath(new URL('./.local-db', import.meta.url)),
    databaseUrl: (env.DATABASE_URL ?? '').trim(),
    resendApiKey: (env.RESEND_API_KEY ?? '').trim(),
    resendFromEmail: (env.RESEND_FROM_EMAIL ?? '').trim(),
    resendReplyToEmail: (env.RESEND_REPLY_TO_EMAIL ?? '').trim(),
    resendTimeoutSeconds: Number(env.RESEND_TIMEOUT_SECONDS ?? 10),
    stripeSecretKey: (env.STRIPE_SECRET_KEY ?? '').trim(),
    stripePublishableKey: (env.STRIPE_PUBLISHABLE_KEY ?? '').trim(),
    stripeWebhookSecret: (env.STRIPE_WEBHOOK_SECRET ?? '').trim(),
    stripeMinTopup: '10.00',
    stripeMaxTopup: '999999.99',
  };
}
