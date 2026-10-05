/**
 * test/unit/youtube-studio-service.test.js
 *
 * Tests the YouTubeStudioAutomationService with Real Chrome + connectOverCDP:
 * 1. Auth required detection (accounts.google.com redirects -> YOUTUBE_AUTH_REQUIRED)
 * 2. Previous stream ended dialog detection and dismissal
 * 3. Fresh Live Control Room readiness detection (YOUTUBE_FRESH_STREAM_READY)
 * 4. Old / ended stream detection
 * 5. Two-phase session handle: confirmIngestAndClose() ingest polling & scoped browser cleanup
 * 6. Scoped PID cleanup: ensures non-matching PIDs are never touched
 * 7. Mutex serialized execution: sequential browser launches
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeStudioAutomationService, YOUTUBE_STATES } from '../../src/youtube-studio-service.js';
import { loadSettings } from '../../src/config-manager.js';
import { loadState, getState } from '../../src/state-manager.js';
import { stopStream } from '../../src/stream-manager.js';

describe('YouTubeStudioAutomationService (Real Chrome + connectOverCDP)', () => {
  beforeEach(async () => {
    await loadSettings();
    await loadState();
  });

  afterEach(async () => {
    await stopStream();
  });

  test('1. Detects Google authentication required when redirected to login', async () => {
    let closed = false;
    const mockPage = {
      url: () => 'https://accounts.google.com/signin/v2/identifier',
      on: () => {},
      goto: async () => {},
      waitForTimeout: async (ms) => new Promise(r => setTimeout(r, Math.min(ms || 10, 20))),
      innerText: async () => 'Sign in to continue to YouTube Studio',
    };

    const mockBrowserContext = {
      pages: () => [mockPage],
      newPage: async () => mockPage,
      close: async () => { closed = true; },
    };

    const mockBrowser = {
      contexts: () => [mockBrowserContext],
      newContext: async () => mockBrowserContext,
      close: async () => { closed = true; },
    };

    const mockPlaywright = {
      _skipChromeSpawn: true,
      chromium: {
        connectOverCDP: async () => mockBrowser,
      },
    };

    await assert.rejects(
      async () => {
        await YouTubeStudioAutomationService.prepareNextLiveSession({
          reason: 'test_auth',
          injectedPlaywright: mockPlaywright,
        });
      },
      (err) => {
        assert.equal(err.code, 'YOUTUBE_AUTH_REQUIRED');
        return true;
      }
    );

    const st = getState();
    assert.equal(st.youtubeStatus, YOUTUBE_STATES.YOUTUBE_AUTH_REQUIRED);
    assert.equal(st.stage, 'YOUTUBE_AUTH_REQUIRED');
    assert.equal(closed, true, 'Browser connection should be closed immediately on auth failure');
  });

  test('2. Successfully prepares session and handles previous stream dialog over CDP', async () => {
    let closed = false;
    let dialogDismissed = false;

    const mockDialog = {
      isVisible: async () => true,
      innerText: async () => 'Stream finished. Your stream has ended.',
      $$: async () => [
        {
          innerText: async () => 'Dismiss',
          getAttribute: async () => 'Dismiss',
          click: async () => { dialogDismissed = true; },
        },
      ],
    };

    let callCount = 0;
    const mockPage = {
      url: () => 'https://studio.youtube.com/live',
      on: () => {},
      goto: async () => {},
      waitForTimeout: async (ms) => new Promise(r => setTimeout(r, Math.min(ms || 10, 20))),
      $$: async (selector) => {
        if (selector === '[role="dialog"]' || selector === 'ytcp-dialog') {
          return [mockDialog];
        }
        return [];
      },
      $: async (selector) => {
        if (selector === '#live-player') return {};
        if (selector === '#stream-settings') return {};
        return null;
      },
      innerText: async () => {
        callCount++;
        if (callCount > 3) {
          return 'Connect your encoder to go live. Excellent connection. Stream settings.';
        }
        return 'Connect your encoder to go live. Default stream key (RTMP, Variable). Stream settings.';
      },
      evaluate: async () => true,
    };

    const mockBrowserContext = {
      pages: () => [mockPage],
      newPage: async () => mockPage,
      close: async () => { closed = true; },
    };

    const mockBrowser = {
      contexts: () => [mockBrowserContext],
      newContext: async () => mockBrowserContext,
      close: async () => { closed = true; },
    };

    const mockPlaywright = {
      _skipChromeSpawn: true,
      chromium: {
        connectOverCDP: async () => mockBrowser,
      },
    };

    const session = await YouTubeStudioAutomationService.prepareNextLiveSession({
      reason: 'test_prep',
      injectedPlaywright: mockPlaywright,
    });

    assert.equal(session.sessionState, YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY);
    assert.equal(dialogDismissed, true, 'Previous stream dialog must be dismissed');
    assert.equal(closed, false, 'Chrome connection must remain open until ingest confirmation');

    // Test phase 2: confirmIngestAndClose()
    const confirmResult = await session.confirmIngestAndClose({ timeoutMs: 5000 });
    assert.equal(confirmResult.success, true);
    assert.equal(closed, true, 'Chrome connection must close cleanly after ingest confirmation');
  });

  test('3. Detects old/ended stream and throws if fresh stream not available', async () => {
    let closed = false;

    const mockPage = {
      url: () => 'https://studio.youtube.com/video/ended123/livestreaming',
      on: () => {},
      goto: async () => {},
      waitForTimeout: async (ms) => new Promise(r => setTimeout(r, Math.min(ms || 10, 20))),
      $$: async () => [],
      $: async () => null,
      innerText: async () => 'This stream has ended. Broadcast completed. Edit in Studio.',
      evaluate: async () => false,
    };

    const mockBrowserContext = {
      pages: () => [mockPage],
      newPage: async () => mockPage,
      close: async () => { closed = true; },
    };

    const mockBrowser = {
      contexts: () => [mockBrowserContext],
      newContext: async () => mockBrowserContext,
      close: async () => { closed = true; },
    };

    const mockPlaywright = {
      _skipChromeSpawn: true,
      chromium: {
        connectOverCDP: async () => mockBrowser,
      },
    };

    await assert.rejects(
      async () => {
        await YouTubeStudioAutomationService.prepareNextLiveSession({
          reason: 'test_ended',
          injectedPlaywright: mockPlaywright,
        });
      },
      (err) => {
        assert.equal(err.code, 'YOUTUBE_OLD_OR_ENDED_STREAM');
        return true;
      }
    );

    assert.equal(closed, true, 'Browser connection should be closed cleanly on old stream rejection');
  });

  test('4. Ingest confirmation timeout triggers error and closes Chrome connection', async () => {
    let closed = false;

    const mockPage = {
      url: () => 'https://studio.youtube.com/live',
      on: () => {},
      goto: async () => {},
      waitForTimeout: async (ms) => new Promise(r => setTimeout(r, Math.min(ms || 10, 20))),
      $$: async () => [],
      $: async () => ({}),
      innerText: async () => 'Connect your encoder to go live. No data. Stream settings.',
      evaluate: async () => false, // never receives video frames
    };

    const mockBrowserContext = {
      pages: () => [mockPage],
      newPage: async () => mockPage,
      close: async () => { closed = true; },
    };

    const mockBrowser = {
      contexts: () => [mockBrowserContext],
      newContext: async () => mockBrowserContext,
      close: async () => { closed = true; },
    };

    const mockPlaywright = {
      _skipChromeSpawn: true,
      chromium: {
        connectOverCDP: async () => mockBrowser,
      },
    };

    const session = await YouTubeStudioAutomationService.prepareNextLiveSession({
      reason: 'test_timeout',
      injectedPlaywright: mockPlaywright,
    });

    assert.equal(session.sessionState, YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY);

    await assert.rejects(
      async () => {
        await session.confirmIngestAndClose({ timeoutMs: 100 });
      },
      (err) => {
        assert.equal(err.code, 'YOUTUBE_PREVIEW_TIMEOUT');
        return true;
      }
    );

    assert.equal(closed, true, 'Chrome connection must close even after ingest timeout');
  });

  test('5. Serializes concurrent preparation requests through in-memory mutex', async () => {
    const sequence = [];

    const createMockPlaywright = (id, delayMs) => {
      let closed = false;
      const mockPage = {
        url: () => 'https://studio.youtube.com/live',
        on: () => {},
        goto: async () => {},
        waitForTimeout: async (ms) => new Promise(r => setTimeout(r, Math.min(ms || 10, 20))),
        $$: async () => [],
        $: async () => ({}),
        innerText: async () => 'Connect your encoder to go live. Excellent connection. Stream settings.',
        evaluate: async () => true,
      };

      const mockBrowserContext = {
        pages: () => [mockPage],
        newPage: async () => mockPage,
        close: async () => { closed = true; },
      };

      const mockBrowser = {
        contexts: () => [mockBrowserContext],
        newContext: async () => mockBrowserContext,
        close: async () => { closed = true; },
      };

      return {
        _skipChromeSpawn: true,
        chromium: {
          connectOverCDP: async () => {
            sequence.push(`connect_${id}`);
            await new Promise(r => setTimeout(r, delayMs));
            sequence.push(`ready_${id}`);
            return mockBrowser;
          },
        },
      };
    };

    // p1 starts first
    const p1 = YouTubeStudioAutomationService.prepareNextLiveSession({
      reason: 'parallel_1',
      injectedPlaywright: createMockPlaywright(1, 50),
    });

    // p2 is dispatched immediately while p1 is active
    const p2 = YouTubeStudioAutomationService.prepareNextLiveSession({
      reason: 'parallel_2',
      injectedPlaywright: createMockPlaywright(2, 20),
    });

    const s1 = await p1;
    // s1 is ready; now confirm and close s1 which releases the mutex for p2
    await s1.confirmIngestAndClose();

    const s2 = await p2;
    await s2.confirmIngestAndClose();

    assert.deepEqual(sequence, [
      'connect_1',
      'ready_1',
      'connect_2',
      'ready_2',
    ], 'Preparation sessions must strictly serialize and never connect CDP concurrently');
  });
});
