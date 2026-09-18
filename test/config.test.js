import test from 'node:test';
import assert from 'node:assert/strict';
import { config, validateConfig } from '../src/config.js';

test('config object exposes all necessary fields with appropriate defaults', () => {
  assert.ok(typeof config === 'object');
  assert.ok('discordToken' in config);
  assert.ok('clientId' in config);
  assert.ok('ffmpegPath' in config);
  assert.ok('ytDlpPath' in config);
  assert.ok('playlistDbPath' in config);
  assert.equal(config.maxUserPlaylists, 10);
  assert.equal(config.maxUserPlaylistTracks, 50);
  assert.ok(typeof config.defaultVolume === 'number');
  assert.ok(config.defaultVolume >= 0);
  assert.ok(typeof config.defaultIdleTimeoutMs === 'number');
  assert.ok(config.defaultIdleTimeoutMs > 0);
});

test('validateConfig checks for required DISCORD_TOKEN and DISCORD_CLIENT_ID', () => {
  // If current config has valid values, validateConfig does not throw
  if (config.discordToken && config.clientId) {
    assert.doesNotThrow(() => validateConfig());
  }

  // Test failure condition with empty dummy
  const originalToken = config.discordToken;
  try {
    config.discordToken = '';
    assert.throws(() => validateConfig(), /Missing required environment variables.*DISCORD_TOKEN/);
  } finally {
    config.discordToken = originalToken;
  }
});
