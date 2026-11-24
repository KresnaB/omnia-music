import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYoutubeClientCandidates,
  isRetryableYoutubeClientError,
  normalizeEntry,
  selectBestSearchEntry
} from '../src/services/ytdlp.js';

test('normalizeEntry throws explicit error on null or non-object entry', () => {
  assert.throws(() => normalizeEntry(null, 'query'), /empty track metadata/);
  assert.throws(() => normalizeEntry(undefined, 'query'), /empty track metadata/);
  assert.throws(() => normalizeEntry({ _type: 'playlist', entries: [null] }, 'query'), /empty track metadata/);
});

test('buildYoutubeClientCandidates deduplicates primary, android fallback, and default', () => {
  assert.deepEqual(buildYoutubeClientCandidates('youtube:player_client=web_safari'), [
    'youtube:player_client=web_safari',
    'youtube:player_client=android',
    null
  ]);
  assert.deepEqual(buildYoutubeClientCandidates('youtube:player_client=android'), [
    'youtube:player_client=android',
    null
  ]);
});

test('isRetryableYoutubeClientError matches format/client failures but not removed videos', () => {
  assert.equal(isRetryableYoutubeClientError(new Error('Requested format is not available')), true);
  assert.equal(isRetryableYoutubeClientError(new Error('No playable track found in yt-dlp output')), true);
  assert.equal(isRetryableYoutubeClientError(new Error('Sign in to confirm you\'re not a bot')), true);
  assert.equal(isRetryableYoutubeClientError(new Error('Video unavailable. This video has been removed by the uploader')), false);
});

test('selectBestSearchEntry prioritizes artist/topic channel over lyrics reuploads', () => {
  const entries = [
    { id: '1', title: 'Kendrick Lamar - Money Trees (Lyrics)', channel: 'Aquila', uploader: 'Aquila' },
    { id: '2', title: 'Money Trees', channel: 'Kendrick Lamar', uploader: 'Kendrick Lamar' },
    { id: '3', title: 'Money Trees (Nightcore)', channel: 'NightcoreHub', uploader: 'NightcoreHub' }
  ];
  assert.equal(selectBestSearchEntry(entries, 'money tree kendrick').id, '2');
  assert.equal(selectBestSearchEntry(entries, 'money tree kendrick lyrics').id, '1');
});
