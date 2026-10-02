/**
 * api/auth.routes.js — Authentication routes (login, logout, session info).
 */

import { Router } from 'express';
import {
  verifyPassword,
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailure,
  createSession,
  destroySession,
  signCookie,
  parseCookies,
  verifyCookie,
  getSession,
  COOKIE_NAME,
} from '../auth.js';
import { logger } from '../logger.js';

export function createAuthRouter(envConfig) {
  const router = Router();
  const { adminUsername, adminPasswordHash, sessionSecret } = envConfig;

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const { username, password } = req.body || {};

    const rateCheck = checkLoginRateLimit(ip, username);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Too many failed attempts. Locked for ${rateCheck.remainingSec} seconds.`,
        code: 'E_RATE_LIMIT',
      });
    }

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      recordLoginFailure(ip, username);
      return res.status(401).json({ error: 'Invalid credentials', code: 'E_INVALID_CREDENTIALS' });
    }

    // Verify username match
    const usernameMatches = username.trim().toLowerCase() === adminUsername.trim().toLowerCase();
    const passwordMatches = await verifyPassword(password, adminPasswordHash);

    if (!usernameMatches || !passwordMatches) {
      recordLoginFailure(ip, username);
      logger.warn('auth.login_failure', `Failed login attempt for user ${username} from ${ip}`);
      return res.status(401).json({ error: 'Invalid credentials', code: 'E_INVALID_CREDENTIALS' });
    }

    // Success
    resetLoginFailure(ip, username);
    const session = createSession(adminUsername);
    const signedCookie = signCookie(session.sid, sessionSecret);

    // Set secure cookie
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie(COOKIE_NAME, signedCookie, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 3600 * 1000,
    });

    logger.info('auth.login_success', `User ${adminUsername} logged in successfully from ${ip}`);

    res.json({
      success: true,
      username: adminUsername,
      csrfToken: session.csrfToken,
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    const rawCookies = parseCookies(req.headers.cookie);
    const signed = rawCookies[COOKIE_NAME];
    if (signed) {
      const sid = verifyCookie(signed, sessionSecret);
      destroySession(sid);
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  });

  // GET /api/auth/me
  router.get('/me', (req, res) => {
    const rawCookies = parseCookies(req.headers.cookie);
    const signed = rawCookies[COOKIE_NAME];
    if (!signed) {
      return res.status(401).json({ authenticated: false });
    }

    const sid = verifyCookie(signed, sessionSecret);
    const session = getSession(sid);
    if (!session) {
      return res.status(401).json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      username: session.username,
      csrfToken: session.csrfToken,
    });
  });

  return router;
}
