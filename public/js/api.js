/**
 * public/js/api.js — Frontend API client with CSRF token management and error handling.
 */

let _csrfToken = '';

export async function initSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return null;
    }
    const data = await res.json();
    if (data.authenticated) {
      _csrfToken = data.csrfToken;
      return data;
    } else {
      window.location.href = '/login.html';
      return null;
    }
  } catch (err) {
    console.error('Session init error:', err);
    window.dispatchEvent(new CustomEvent('dashboard:disconnected', { detail: { error: err.message } }));
    return null;
  }
}

export function getCsrfToken() {
  return _csrfToken;
}

export async function apiRequest(endpoint, { method = 'GET', body = null, isFormData = false } = {}) {
  const headers = {};

  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
  }

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase()) && _csrfToken) {
    headers['X-CSRF-Token'] = _csrfToken;
  }

  const options = { method, headers };
  if (body) {
    options.body = isFormData ? body : JSON.stringify(body);
  }

  try {
    const res = await fetch(endpoint, options);

    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.code = json.code;
      err.errors = json.errors;
      throw err;
    }

    window.dispatchEvent(new CustomEvent('dashboard:connected'));
    return json;
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      window.dispatchEvent(new CustomEvent('dashboard:disconnected', { detail: { error: err.message } }));
    }
    throw err;
  }
}

export const apiGet    = (endpoint)       => apiRequest(endpoint, { method: 'GET' });
export const apiPost   = (endpoint, body) => apiRequest(endpoint, { method: 'POST', body });
export const apiPut    = (endpoint, body) => apiRequest(endpoint, { method: 'PUT', body });
export const apiDelete = (endpoint)       => apiRequest(endpoint, { method: 'DELETE' });
