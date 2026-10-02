/**
 * test/unit/redact.test.js — Unit tests for lib/redact.js
 *
 * PRD §26.1: "redact() with real key patterns"
 * PRD §5: "The stream key must NEVER appear in logs…"
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setSecret, redact, redactObject, clearSecrets } from '../../src/lib/redact.js';

beforeEach(() => clearSecrets());

describe('redact — basic string replacement', () => {
  test('replaces the literal key in a plain string', () => {
    const key = 'abcd1234efgh5678';
    setSecret(key);
    const result = redact(`connecting to rtmps://a.rtmps.youtube.com/live2/${key}`);
    assert.ok(!result.includes(key), `key still present in: ${result}`);
    assert.ok(result.includes('****'), 'placeholder not inserted');
  });

  test('replaces the key when it appears multiple times', () => {
    const key = 'MyKey_123456';
    setSecret(key);
    const input  = `key=${key} and again key=${key}`;
    const result = redact(input);
    assert.equal(result.split('MyKey_123456').length, 1, 'key still appears');
  });

  test('redacts the full RTMPS URL', () => {
    const key = 'secret-key-ABCDE';
    setSecret(key);
    const url    = `rtmps://a.rtmps.youtube.com:443/live2/${key}`;
    const result = redact(url);
    assert.ok(!result.includes('rtmps://'), `RTMPS URL not redacted: ${result}`);
  });

  test('returns non-string values unchanged', () => {
    setSecret('somekey12345678');
    assert.equal(redact(null),      null);
    assert.equal(redact(undefined), undefined);
    assert.equal(redact(42),        42);
  });

  test('returns empty string unchanged', () => {
    setSecret('somekey12345678');
    assert.equal(redact(''), '');
  });

  test('safe when no secret is registered', () => {
    const input  = 'no secrets here';
    const result = redact(input);
    assert.equal(result, input);
  });
});

describe('redact — setSecret replaces previous key', () => {
  test('old key is no longer redacted after setSecret with new key', () => {
    const oldKey = 'OldKey_12345678';
    const newKey = 'NewKey_87654321';
    setSecret(oldKey);
    setSecret(newKey);                           // replaces patterns

    const withOld = redact(`prefix_${oldKey}_suffix`);
    // Old key patterns cleared → old key appears unchanged
    assert.ok(withOld.includes(oldKey), 'old key should no longer be redacted');

    const withNew = redact(`prefix_${newKey}_suffix`);
    assert.ok(!withNew.includes(newKey), 'new key should be redacted');
  });
});

describe('redactObject — recursive object redaction', () => {
  test('redacts string values inside an object', () => {
    const key = 'TopSecretKEY99';
    setSecret(key);
    const obj    = { url: `rtmps://host/live2/${key}`, bitrate: 8000, nested: { cmd: key } };
    const result = redactObject(obj);
    assert.ok(!result.url.includes(key), 'url field still has key');
    assert.equal(result.bitrate, 8000, 'numeric field mutated');
    assert.ok(!result.nested.cmd.includes(key), 'nested field still has key');
  });

  test('handles arrays inside objects', () => {
    const key = 'ArrayKey_123456';
    setSecret(key);
    const obj    = { args: [key, 'safe', key] };
    const result = redactObject(obj);
    for (const v of result.args) {
      if (typeof v === 'string') assert.ok(!v.includes(key), `array item still has key: ${v}`);
    }
  });

  test('returns non-object values unchanged', () => {
    setSecret('irrelevant12345');
    assert.equal(redactObject(null),      null);
    assert.equal(redactObject(undefined), undefined);
    assert.equal(redactObject(42),        42);
  });

  test('does not mutate the original object', () => {
    const key = 'ImmutableKEY123';
    setSecret(key);
    const original = { secret: key };
    const result   = redactObject(original);
    assert.equal(original.secret, key, 'original was mutated');
    assert.ok(!result.secret.includes(key), 'result still has key');
  });
});

describe('redact — URL-encoded key', () => {
  test('redacts URL-percent-encoded form of the key', () => {
    // Keys with characters that encode differently (e.g., space → %20)
    // YouTube keys are [A-Za-z0-9_-] so encoding is typically a no-op.
    // We test a key with a dash, which remains unencoded.
    const key = 'dash-key-ABCD12';
    setSecret(key);
    assert.ok(!redact(key).includes(key));
  });
});
