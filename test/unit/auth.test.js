/**
 * test/unit/auth.test.js — Unit tests for auth.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  signCookie,
  verifyCookie,
  createSession,
  getSession,
  destroySession,
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailure,
} from '../../src/auth.js';

describe('auth — scrypt password hashing & verification', () => {
  test('hashes password and verifies successfully', async () => {
    const rawPass = 'SuperSecretAdmin123!';
    const hash = await hashPassword(rawPass);

    assert.ok(hash.startsWith('scrypt:16384:8:1:'));
    assert.ok(!hash.includes('$')); // PRD §19.1 no $ signs

    const valid = await verifyPassword(rawPass, hash);
    assert.equal(valid, true);

    const wrong = await verifyPassword('WrongPassword123!', hash);
    assert.equal(wrong, false);
  });

  test('rejects malformed hash strings gracefully', async () => {
    assert.equal(await verifyPassword('pass', 'bad:hash'), false);
    assert.equal(await verifyPassword('pass', ''), false);
    assert.equal(await verifyPassword('pass', null), false);
  });
});

describe('auth — cookie signing and verification', () => {
  const secret = 'test-secret-key-1234567890';

  test('signs and verifies cookie integrity', () => {
    const sid = 'my-session-id-abcdef';
    const signed = signCookie(sid, secret);

    assert.ok(signed.startsWith(`${sid}.`));

    const verified = verifyCookie(signed, secret);
    assert.equal(verified, sid);
  });

  test('detects tampered cookie payload or signature', () => {
    const sid = 'legit-session';
    const signed = signCookie(sid, secret);

    // Tamper payload
    const tampered = `attacker-session.${signed.split('.')[1]}`;
    assert.equal(verifyCookie(tampered, secret), null);

    // Tamper signature
    const badSig = `${sid}.invalidsignature`;
    assert.equal(verifyCookie(badSig, secret), null);

    // Wrong secret
    assert.equal(verifyCookie(signed, 'different-secret'), null);
  });
});

describe('auth — in-memory session management', () => {
  test('creates session with csrfToken and retrieves it', () => {
    const session = createSession('admin');
    assert.ok(session.sid);
    assert.ok(session.csrfToken);
    assert.equal(session.username, 'admin');

    const retrieved = getSession(session.sid);
    assert.equal(retrieved.username, 'admin');
    assert.equal(retrieved.csrfToken, session.csrfToken);
  });

  test('destroySession removes session', () => {
    const session = createSession('testuser');
    destroySession(session.sid);
    assert.equal(getSession(session.sid), null);
  });
});

describe('auth — login rate limiting', () => {
  test('locks out client after 5 consecutive failures', () => {
    const ip = '192.168.1.100';
    const user = 'admin';

    resetLoginFailure(ip, user);
    assert.equal(checkLoginRateLimit(ip, user).allowed, true);

    for (let i = 0; i < 4; i++) {
      recordLoginFailure(ip, user);
      assert.equal(checkLoginRateLimit(ip, user).allowed, true);
    }

    // 5th failure triggers lockout
    recordLoginFailure(ip, user);
    const check = checkLoginRateLimit(ip, user);
    assert.equal(check.allowed, false);
    assert.ok(check.remainingSec > 0);

    // Reset clears lockout
    resetLoginFailure(ip, user);
    assert.equal(checkLoginRateLimit(ip, user).allowed, true);
  });
});
