const API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
export const SESSION_EXPIRED_EVENT = 'folio:session-expired';
let sessionCheck = null;

export class ApiError extends Error {
  constructor(message, status, fields = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

function csrfToken() {
  return document.cookie.split('; ').find((item) => item.startsWith('csrftoken='))?.split('=').slice(1).join('=') || '';
}

async function inspectSession() {
  if (!sessionCheck) {
    sessionCheck = (async () => {
      try {
        const session = await fetch(`${API_URL}/auth/me/`, { credentials: 'include', headers: { Accept: 'application/json' } });
        if ([401, 403].includes(session.status)) {
          window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
          return true;
        }
        // A rejected CSRF token must never replay a money-changing request.
        // Refresh the token so the user can review the error and retry once.
        if (session.ok) await fetch(`${API_URL}/auth/csrf/`, { credentials: 'include' });
      } catch {
        // A network failure is not evidence that the account signed out.
      }
      return false;
    })().finally(() => { sessionCheck = null; });
  }
  return sessionCheck;
}

export async function api(path, { method = 'GET', body, signal, checkSession = true } = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      credentials: 'include',
      signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRFToken': decodeURIComponent(csrfToken()) } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('No pudimos conectar con el servidor. Comprueba que Django esté en ejecución e inténtalo de nuevo.', 0);
  }
  const contentType = response.headers.get('content-type') || '';
  const data = response.status !== 204 && contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const message = data?.detail || (data && Object.values(data).flat().filter((value) => typeof value === 'string').join(' ')) || 'No se pudo completar la solicitud. Inténtalo de nuevo.';
    const error = new ApiError(message, response.status, data || {});
    if (checkSession && [401, 403].includes(response.status) && !/^\/auth\/(csrf|login|register)\//.test(path)) {
      error.sessionExpired = await inspectSession();
    }
    throw error;
  }
  return data;
}

export async function initializeSession() {
  await api('/auth/csrf/');
  try {
    const result = await api('/auth/me/', { checkSession: false });
    return result.user;
  } catch (error) {
    if ([401, 403].includes(error.status)) return null;
    throw error;
  }
}
