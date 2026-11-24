import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, body, headers = {}) {
    super(typeof body === 'string' ? body : body?.detail);
    this.status = status;
    this.body = typeof body === 'string' ? { detail: body } : body;
    this.headers = headers;
  }
}

export function uuid(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^urn:uuid:/, '').replace(/[{}-]/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

export function saltedHmac(salt, value, secret, encoding = 'hex') {
  const key = createHash('sha256').update(salt).update(secret).digest();
  return createHmac('sha256', key).update(value).digest(encoding);
}
