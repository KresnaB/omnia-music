import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerManager } from '../src/player/PlayerManager.js';
import { GuildPlayer } from '../src/player/GuildPlayer.js';

test('PlayerManager manages per-guild player instances correctly', () => {
  const fakeDeps = {
    audioCache: {},
    lyrics: {},
    ytdlp: {}
  };

  const manager = new PlayerManager(fakeDeps);

  assert.equal(manager.has('guild-1'), false);
  assert.equal(manager.getIfExists('guild-1'), null);

  const player1 = manager.get('guild-1');
  assert.ok(player1 instanceof GuildPlayer);
  assert.equal(player1.guildId, 'guild-1');
  assert.equal(manager.has('guild-1'), true);
  assert.equal(manager.getIfExists('guild-1'), player1);

  // Calling get again returns the exact same instance
  const player1Again = manager.get('guild-1');
  assert.equal(player1, player1Again);

  // Another guild has a separate player instance
  const player2 = manager.get('guild-2');
  assert.ok(player2 instanceof GuildPlayer);
  assert.equal(player2.guildId, 'guild-2');
  assert.notEqual(player1, player2);
  assert.equal(manager.has('guild-2'), true);
});
