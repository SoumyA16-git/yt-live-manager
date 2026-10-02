/**
 * lib/redact.js — Central secret redaction filter.
 *
 * PRD §10 / §20: "The full output URL contains the stream key…
 * argv is NEVER logged — the logger logs a redacted command (…/live2/****)."
 * "redact() replaces the key, the full URL, and any rtmps://… token."
 *
 * Usage:
 *   import { setSecret, redact, redactObject, clearSecrets } from './lib/redact.js';
 *   setSecret(streamKey);        // call whenever key is loaded/changed
 *   logger.info(redact(someStr)); // or rely on logger calling redact() itself
 */

const PLACEHOLDER = '****';

/** @type {RegExp[]} — rebuilt whenever setSecret() is called */
const _patterns = [];

/**
 * Register the stream key as a secret. Builds patterns for:
 *   - The literal key string
 *   - URL-percent-encoded form (if different)
 *   - Any rtmps:// URL token (catches full destination URL in argv logs)
 *
 * Safe to call multiple times; replaces the previous key's patterns.
 */
export function setSecret(key) {
  if (!key || typeof key !== 'string') return;
  _patterns.length = 0;

  // Escape all regex metacharacters in the key
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  _patterns.push(new RegExp(escaped, 'g'));

  // URL-encoded variant (if it differs)
  const urlEncoded = encodeURIComponent(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (urlEncoded !== escaped) {
    _patterns.push(new RegExp(urlEncoded, 'g'));
  }

  // Broad RTMPS URL pattern — catches the full destination argument in any
  // context where the key is embedded in the URL.
  _patterns.push(/rtmps:\/\/[^\s"',\]]+/g);
}

/**
 * Redact all registered secrets from a string.
 * Returns the original value unchanged if it is not a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const pattern of _patterns) {
    pattern.lastIndex = 0;           // reset global regex state
    result = result.replace(pattern, PLACEHOLDER);
  }
  return result;
}

/**
 * Recursively redact secrets from all string values of a plain object.
 * Does NOT mutate the original — returns a new object.
 *
 * @param {object} obj
 * @returns {object}
 */
export function redactObject(obj) {
  if (typeof obj === 'string') return redact(obj);
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')         out[k] = redact(v);
    else if (v !== null && typeof v === 'object') out[k] = redactObject(v);
    else                               out[k] = v;
  }
  return out;
}

/**
 * Remove all registered secrets (useful between unit tests).
 */
export function clearSecrets() {
  _patterns.length = 0;
}
