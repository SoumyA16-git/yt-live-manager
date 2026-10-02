/**
 * auth.js — scrypt password hashing, session management, CSRF validation, and rate limiting.
 *
 * PRD §19.1:
 * - Hash format: scrypt:<N>:<r>:<p>:<saltB64>:<hashB64> (no $ characters).
 * - Constant-time comparison via crypto.timingSafeEqual.
 * - In-memory session store (D-006): idle 12 h, absolute 7 d.
 * - Session cookie: signed with SESSION_SECRET.
 * - CSRF token generated per session; required in x-csrf-token for non-GET.
 * - Rate limiting: 5 failures / 15 min → 15 min lockout.
 */

import crypto from 'node:crypto';
import { logger } from './logger.js';

// ─── Scrypt Configuration ────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN  = 64;

/**
 * Hash a plain password using scrypt.
 * Format: scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) return reject(err);
      const saltB64 = salt.toString('base64');
      const hashB64 = derivedKey.toString('base64');
      resolve(`scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${saltB64}:${hashB64}`);
    });
  });
}

/**
 * Verify a plain password against a stored scrypt hash string.
 * Uses crypto.timingSafeEqual.
 *
 * @param {string} password
 * @param {string} storedHash
 * @returns {Promise<boolean>}
 */
export function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    if (!password || !storedHash || typeof storedHash !== 'string') {
      return resolve(false);
    }

    const parts = storedHash.split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return resolve(false);
    }

    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], 'base64');
    const expectedHash = Buffer.from(parts[5], 'base64');

    crypto.scrypt(password, salt, expectedHash.length, { N, r, p }, (err, derivedKey) => {
      if (err || derivedKey.length !== expectedHash.length) {
        return resolve(false);
      }
      try {
        resolve(crypto.timingSafeEqual(derivedKey, expectedHash));
      } catch {
        resolve(false);
      }
    });
  });
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

const FAILED_LIMIT = 5;
const WINDOW_MS    = 15 * 60 * 1000; // 15 minutes

const _rateLimitStore = new Map(); // key -> { count, lockedUntil, firstFailedAt }

function getClientKey(ip, username = '') {
  return `${ip || 'unknown'}:${username.trim().toLowerCase()}`;
}

export function checkLoginRateLimit(ip, username = '') {
  const key = getClientKey(ip, username);
  const entry = _rateLimitStore.get(key);
  if (!entry) return { allowed: true };

  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remainingSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, remainingSec };
  }

  // If window expired, reset
  if (now - entry.firstFailedAt > WINDOW_MS) {
    _rateLimitStore.delete(key);
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordLoginFailure(ip, username = '') {
  const key = getClientKey(ip, username);
  const now = Date.now();
  let entry = _rateLimitStore.get(key);

  if (!entry || now - entry.firstFailedAt > WINDOW_MS) {
    entry = { count: 1, firstFailedAt: now, lockedUntil: null };
  } else {
    entry.count += 1;
    if (entry.count >= FAILED_LIMIT) {
      entry.lockedUntil = now + WINDOW_MS;
      logger.warn('auth.login_lockout', `Login rate limit reached for ${key}; locked for 15 minutes`);
    }
  }

  _rateLimitStore.set(key, entry);
}

export function resetLoginFailure(ip, username = '') {
  const key = getClientKey(ip, username);
  _rateLimitStore.delete(key);
}

// ─── In-Memory Session Store (PRD §19.1, D-006) ───────────────────────────────

const IDLE_TIMEOUT_MS     = 12 * 3600 * 1000;      // 12 hours
const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 3600 * 1000;  // 7 days

const _sessions = new Map(); // sid -> { sid, username, createdAt, lastActiveAt, csrfToken }

export function createSession(username) {
  const sid = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  const session = {
    sid,
    username,
    createdAt: now,
    lastActiveAt: now,
    csrfToken,
  };

  _sessions.set(sid, session);
  return session;
}

export function getSession(sid) {
  if (!sid) return null;
  const session = _sessions.get(sid);
  if (!session) return null;

  const now = Date.now();
  // Check absolute timeout (7 days)
  if (now - session.createdAt > ABSOLUTE_TIMEOUT_MS) {
    _sessions.delete(sid);
    return null;
  }

  // Check idle timeout (12 hours)
  if (now - session.lastActiveAt > IDLE_TIMEOUT_MS) {
    _sessions.delete(sid);
    return null;
  }

  session.lastActiveAt = now;
  return session;
}

export function destroySession(sid) {
  if (sid) _sessions.delete(sid);
}

// ─── Cookie Signing & Parsing ─────────────────────────────────────────────────

export function signCookie(value, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${hmac}`;
}

export function verifyCookie(signedVal, secret) {
  if (!signedVal || typeof signedVal !== 'string') return null;
  const idx = signedVal.lastIndexOf('.');
  if (idx === -1) return null;

  const val  = signedVal.slice(0, idx);
  const signature = signedVal.slice(idx + 1);

  const expectedSig = crypto.createHmac('sha256', secret).update(val).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
    return val;
  }
  return null;
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v.join('='));
  }
  return cookies;
}

// ─── Express Middlewares ──────────────────────────────────────────────────────

export const COOKIE_NAME = 'ytlm_sid';

/**
 * Authentication middleware: verifies session cookie, checks timeouts.
 */
export function requireAuth(sessionSecret) {
  return (req, res, next) => {
    const rawCookies = parseCookies(req.headers.cookie);
    // Support both prefix formats
    const signedSid = rawCookies['__Host-' + COOKIE_NAME] || rawCookies[COOKIE_NAME];

    if (!signedSid) {
      return res.status(401).json({ error: 'Unauthorized', code: 'E_UNAUTHORIZED' });
    }

    const sid = verifyCookie(signedSid, sessionSecret);
    if (!sid) {
      return res.status(401).json({ error: 'Invalid session signature', code: 'E_INVALID_SESSION' });
    }

    const session = getSession(sid);
    if (!session) {
      return res.status(401).json({ error: 'Session expired or invalid', code: 'E_SESSION_EXPIRED' });
    }

    req.session = session;
    next();
  };
}

/**
 * CSRF middleware: checks x-csrf-token header against session csrfToken for non-GET.
 */
export function requireCsrf() {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const token = req.headers['x-csrf-token'];
    if (!token || !req.session?.csrfToken) {
      return res.status(403).json({ error: 'Missing CSRF token', code: 'E_CSRF_MISSING' });
    }

    try {
      const match = crypto.timingSafeEqual(
        Buffer.from(String(token)),
        Buffer.from(String(req.session.csrfToken))
      );
      if (!match) {
        return res.status(403).json({ error: 'Invalid CSRF token', code: 'E_CSRF_INVALID' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid CSRF token', code: 'E_CSRF_INVALID' });
    }

    next();
  };
}
