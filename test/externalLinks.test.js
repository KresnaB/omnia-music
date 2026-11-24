import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAppleMusicMetadata,
  extractSpotifyEmbedTracks,
  isExternalMusicUrl,
  parseExternalMusicUrl
} from '../src/services/externalLinks.js';

test('parseExternalMusicUrl identifies Spotify and Apple Music URLs', () => {
  assert.deepEqual(parseExternalMusicUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=123'), {
    provider: 'spotify',
    kind: 'track',
    id: '4uLU6hMCjMI75M1A2tKUQC',
    url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=123'
  });

  const appleSong = parseExternalMusicUrl('https://music.apple.com/us/album/some-album/123456?i=7890');
  assert.equal(appleSong.provider, 'apple_music');
  assert.equal(appleSong.kind, 'song');
  assert.equal(isExternalMusicUrl('https://youtube.com/watch?v=abc'), false);
});

test('extractSpotifyEmbedTracks parses trackList from __NEXT_DATA__', () => {
  const html = `
    <html><script id="__NEXT_DATA__" type="application/json">
      {"props":{"pageProps":{"state":{"data":{"entity":{"name":"Chill Mix","trackList":[{"title":"Money Trees","subtitle":"Kendrick Lamar"},{"title":"Nights","subtitle":"Frank Ocean"}]}}}}}}
    </script></html>
  `;
  const result = extractSpotifyEmbedTracks(html);
  assert.equal(result.title, 'Chill Mix');
  assert.deepEqual(result.tracks, [
    { title: 'Money Trees', artist: 'Kendrick Lamar', query: 'Money Trees Kendrick Lamar' },
    { title: 'Nights', artist: 'Frank Ocean', query: 'Nights Frank Ocean' }
  ]);
});

test('extractAppleMusicMetadata parses song title and artist from title tag', () => {
  const html = '<title>Money Trees by Kendrick Lamar on Apple Music</title>';
  const result = extractAppleMusicMetadata(html, 'song');
  assert.equal(result.type, 'single');
  assert.deepEqual(result.queries, ['Money Trees Kendrick Lamar']);
});
