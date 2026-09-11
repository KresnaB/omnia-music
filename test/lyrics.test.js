import test from 'node:test';
import assert from 'node:assert/strict';
import { LyricsService } from '../src/services/lyrics.js';

test('LyricsService cleans title and artist in search queries', async () => {
  const lyricsService = new LyricsService();
  const originalFetch = globalThis.fetch;

  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      json: async () => [
        {
          id: 123,
          trackName: 'Yellow',
          artistName: 'Coldplay',
          plainLyrics: 'Look at the stars...',
          syncedLyrics: '[00:10.00] Look at the stars...'
        }
      ]
    };
  };

  try {
    const result = await lyricsService.search(
      'Yellow (Official Music Video) [4K Remastered] feat. Someone',
      'Coldplay - OfficialChannel'
    );

    assert.ok(result);
    assert.equal(result.trackName, 'Yellow');
    assert.equal(result.plainLyrics, 'Look at the stars...');

    const searchParams = capturedUrl.searchParams;
    assert.equal(searchParams.get('track_name'), 'yellow');
    assert.equal(searchParams.get('artist_name'), 'coldplay');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LyricsService omits artist_name when artist is unknown or empty', async () => {
  const lyricsService = new LyricsService();
  const originalFetch = globalThis.fetch;

  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      json: async () => []
    };
  };

  try {
    const result = await lyricsService.search('Bohemian Rhapsody', 'unknown');
    assert.equal(result, null);
    assert.equal(capturedUrl.searchParams.has('artist_name'), false);
    assert.equal(capturedUrl.searchParams.get('track_name'), 'bohemian rhapsody');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LyricsService throws when LRCLIB returns HTTP error status', async () => {
  const lyricsService = new LyricsService();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 503
  });

  try {
    await assert.rejects(
      async () => lyricsService.search('Sample Track', 'Sample Artist'),
      /LRCLIB returned HTTP 503/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LyricsService returns null when payload is empty or invalid', async () => {
  const lyricsService = new LyricsService();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => null
  });

  try {
    const result = await lyricsService.search('Nonexistent', 'No Artist');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
