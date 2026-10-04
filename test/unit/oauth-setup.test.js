/**
 * test/unit/oauth-setup.test.js — Unit tests for scripts/oauth-setup.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthUrl,
  extractCodeFromInput,
  exchangeCodeForTokens,
  verifyYouTubeChannel,
} from '../../scripts/oauth-setup.js';

describe('oauth-setup utility', () => {
  test('buildAuthUrl generates valid Google OAuth URL with required parameters', () => {
    const urlStr = buildAuthUrl({
      clientId: 'mock-client-id-12345.apps.googleusercontent.com',
      redirectUri: 'http://localhost:8085/oauth2callback',
      state: 'state_xyz_789',
    });

    const parsed = new URL(urlStr);
    assert.strictEqual(parsed.origin, 'https://accounts.google.com');
    assert.strictEqual(parsed.pathname, '/o/oauth2/v2/auth');
    assert.strictEqual(parsed.searchParams.get('client_id'), 'mock-client-id-12345.apps.googleusercontent.com');
    assert.strictEqual(parsed.searchParams.get('redirect_uri'), 'http://localhost:8085/oauth2callback');
    assert.strictEqual(parsed.searchParams.get('response_type'), 'code');
    assert.strictEqual(parsed.searchParams.get('access_type'), 'offline'); // mandatory for refresh token
    assert.strictEqual(parsed.searchParams.get('prompt'), 'consent');       // mandatory for refresh token
    assert.strictEqual(parsed.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube');
    assert.strictEqual(parsed.searchParams.get('state'), 'state_xyz_789');
  });

  test('extractCodeFromInput handles raw code, query param, and full redirect URL', () => {
    // 1. Raw code
    assert.strictEqual(extractCodeFromInput('4/0AdQt8q...xyz'), '4/0AdQt8q...xyz');

    // 2. Query param string
    assert.strictEqual(extractCodeFromInput('code=4/0AdQt8q...xyz&state=123'), '4/0AdQt8q...xyz');

    // 3. Full redirect URL
    const fullUrl = 'http://localhost:8085/oauth2callback?code=4%2F0AdQt8q...xyz&state=abcdef';
    assert.strictEqual(extractCodeFromInput(fullUrl), '4/0AdQt8q...xyz');

    // 4. Empty or whitespace
    assert.strictEqual(extractCodeFromInput(''), '');
    assert.strictEqual(extractCodeFromInput('   '), '');
  });

  test('exchangeCodeForTokens exchanges code for refresh_token', async () => {
    let capturedBody = null;
    let capturedUrl = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = opts.body;
      return {
        ok: true,
        json: async () => ({
          access_token: 'mock-access-token-abc',
          expires_in: 3599,
          refresh_token: 'mock-refresh-token-xyz',
          scope: 'https://www.googleapis.com/auth/youtube',
          token_type: 'Bearer',
        }),
      };
    };

    const tokens = await exchangeCodeForTokens({
      code: 'test-auth-code-123',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:8085/oauth2callback',
      fetchFn: mockFetch,
    });

    assert.strictEqual(capturedUrl, 'https://oauth2.googleapis.com/token');
    assert.ok(capturedBody.includes('code=test-auth-code-123'));
    assert.ok(capturedBody.includes('client_id=test-client-id'));
    assert.ok(capturedBody.includes('grant_type=authorization_code'));
    assert.strictEqual(tokens.refresh_token, 'mock-refresh-token-xyz');
    assert.strictEqual(tokens.access_token, 'mock-access-token-abc');
  });

  test('exchangeCodeForTokens throws on Google OAuth error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Bad Request: Code expired or already used',
      }),
    });

    await assert.rejects(
      async () => {
        await exchangeCodeForTokens({
          code: 'expired-code',
          clientId: 'cid',
          clientSecret: 'csec',
          fetchFn: mockFetch,
        });
      },
      /Code expired or already used/
    );
  });

  test('verifyYouTubeChannel retrieves authenticated channel details', async () => {
    const mockFetch = async (url, opts) => {
      assert.ok(url.includes('channels?part=snippet,contentDetails&mine=true'));
      assert.strictEqual(opts.headers.Authorization, 'Bearer valid-token');
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'UC_test_channel_123',
              snippet: { title: '24/7 Live Stream Channel' },
            },
          ],
        }),
      };
    };

    const channel = await verifyYouTubeChannel('valid-token', mockFetch);
    assert.strictEqual(channel.id, 'UC_test_channel_123');
    assert.strictEqual(channel.title, '24/7 Live Stream Channel');
  });
});
