import test from 'node:test';
import assert from 'node:assert/strict';
import { GuildPlayer } from '../src/player/GuildPlayer.js';

function createPlayerContext(overrides = {}) {
  return {
    guildId: 'test-guild',
    queue: [],
    history: [],
    current: null,
    currentProcess: null,
    currentSourceProcess: null,
    loopMode: 'off',
    shuffleActive: false,
    autoplay: false,
    skipTransitionActive: false,
    skipTransitionTimeout: null,
    lyricMessages: [],
    killProcessPair: GuildPlayer.prototype.killProcessPair,
    publishNowPlaying: () => Promise.resolve(),
    preloadUpcomingTracks: () => Promise.resolve(),
    ...overrides
  };
}

test('GuildPlayer shuffle reorders tracks and updates shuffleActive flag', () => {
  const context = createPlayerContext({
    queue: [
      { id: '1', title: 'Track 1' },
      { id: '2', title: 'Track 2' },
      { id: '3', title: 'Track 3' },
      { id: '4', title: 'Track 4' },
      { id: '5', title: 'Track 5' }
    ]
  });

  const count = GuildPlayer.prototype.shuffle.call(context);
  assert.equal(count, 5);
  assert.equal(context.shuffleActive, true);
  assert.equal(context.queue.length, 5);

  const ids = new Set(context.queue.map((t) => t.id));
  assert.deepEqual(ids, new Set(['1', '2', '3', '4', '5']));
});

test('GuildPlayer shuffle on empty or single track queue disables shuffleActive', () => {
  const context = createPlayerContext({ queue: [{ id: '1', title: 'Single' }] });
  const count = GuildPlayer.prototype.shuffle.call(context);
  assert.equal(count, 1);
  assert.equal(context.shuffleActive, false);
});

test('GuildPlayer move reorders queue items by 1-based index', () => {
  const context = createPlayerContext({
    queue: [
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
      { id: '3', title: 'C' }
    ]
  });

  // Move track from pos 1 to pos 3
  GuildPlayer.prototype.move.call(context, 1, 3);
  assert.deepEqual(context.queue.map((t) => t.id), ['2', '3', '1']);

  // Move track from pos 3 to pos 1
  GuildPlayer.prototype.move.call(context, 3, 1);
  assert.deepEqual(context.queue.map((t) => t.id), ['1', '2', '3']);

  // Throws on out of range indices
  assert.throws(() => GuildPlayer.prototype.move.call(context, 0, 2), /Posisi queue tidak valid/);
  assert.throws(() => GuildPlayer.prototype.move.call(context, 1, 4), /Posisi queue tidak valid/);
});

test('GuildPlayer nextLoopMode cycles through off -> track -> queue -> off', () => {
  const context = createPlayerContext({ loopMode: 'off' });

  assert.equal(GuildPlayer.prototype.nextLoopMode.call(context), 'track');
  assert.equal(context.loopMode, 'track');

  assert.equal(GuildPlayer.prototype.nextLoopMode.call(context), 'queue');
  assert.equal(context.loopMode, 'queue');

  assert.equal(GuildPlayer.prototype.nextLoopMode.call(context), 'off');
  assert.equal(context.loopMode, 'off');
});

test('GuildPlayer queueLines formats queue preview correctly', () => {
  const context = createPlayerContext();

  // Case 1: Empty
  assert.deepEqual(GuildPlayer.prototype.queueLines.call(context), ['Queue kosong.']);

  // Case 2: Currently playing with empty queue
  context.current = { title: 'Now Playing Song' };
  assert.deepEqual(GuildPlayer.prototype.queueLines.call(context), [
    'Sedang diputar: **Now Playing Song**',
    'Queue kosong.'
  ]);

  // Case 3: Queue items under limit
  context.queue = [
    { title: 'First' },
    { title: 'Second' }
  ];
  assert.deepEqual(GuildPlayer.prototype.queueLines.call(context, 5), [
    'Sedang diputar: **Now Playing Song**',
    '1. First',
    '2. Second'
  ]);

  // Case 4: Queue items exceeding limit
  context.queue = [
    { title: 'Song 1' },
    { title: 'Song 2' },
    { title: 'Song 3' },
    { title: 'Song 4' }
  ];
  const lines = GuildPlayer.prototype.queueLines.call(context, 2);
  assert.deepEqual(lines, [
    'Sedang diputar: **Now Playing Song**',
    '1. Song 1',
    '2. Song 2',
    '...dan 2 lagu lain.'
  ]);
});

test('GuildPlayer addLyricMessage caps messages to 10 and clearLyricMessages empties array', () => {
  const context = createPlayerContext();
  const deleted = [];

  for (let i = 1; i <= 12; i++) {
    GuildPlayer.prototype.addLyricMessage.call(context, {
      id: i,
      delete: async () => {
        deleted.push(i);
      }
    });
  }

  // Length must never exceed 10
  assert.equal(context.lyricMessages.length, 10);
  // Oldest items (1 and 2) should have been deleted
  assert.deepEqual(deleted, [1, 2]);

  // Clear removes all remaining 10 items
  GuildPlayer.prototype.clearLyricMessages.call(context);
  assert.equal(context.lyricMessages.length, 0);
  assert.equal(deleted.length, 12);
});

test('GuildPlayer setSkipTransitionActive sets and clears safety timer', () => {
  const context = createPlayerContext();

  GuildPlayer.prototype.setSkipTransitionActive.call(context, true);
  assert.equal(context.skipTransitionActive, true);
  assert.ok(context.skipTransitionTimeout);

  GuildPlayer.prototype.setSkipTransitionActive.call(context, false);
  assert.equal(context.skipTransitionActive, false);
  assert.equal(context.skipTransitionTimeout, null);
});

test('GuildPlayer killProcessPair cleanly unpipes, destroys stdio streams, and kills processes', () => {
  const context = createPlayerContext();
  const actions = [];

  const fakeSourceProcess = {
    killed: false,
    stdout: {
      destroyed: false,
      unpipe: () => actions.push('source.stdout.unpipe'),
      destroy: () => actions.push('source.stdout.destroy')
    },
    stderr: {
      destroyed: false,
      destroy: () => actions.push('source.stderr.destroy')
    },
    stdin: {
      destroyed: false,
      destroy: () => actions.push('source.stdin.destroy')
    },
    kill: (sig) => actions.push(`source.kill.${sig}`)
  };

  const fakeFfmpegProcess = {
    killed: false,
    stdin: {
      destroyed: false,
      destroy: () => actions.push('ffmpeg.stdin.destroy')
    },
    stdout: {
      destroyed: false,
      destroy: () => actions.push('ffmpeg.stdout.destroy')
    },
    stderr: {
      destroyed: false,
      destroy: () => actions.push('ffmpeg.stderr.destroy')
    },
    kill: (sig) => actions.push(`ffmpeg.kill.${sig}`)
  };

  GuildPlayer.prototype.killProcessPair.call(context, fakeFfmpegProcess, fakeSourceProcess);

  assert.ok(actions.includes('source.stdout.unpipe'));
  assert.ok(actions.includes('source.stdout.destroy'));
  assert.ok(actions.includes('source.stderr.destroy'));
  assert.ok(actions.includes('source.stdin.destroy'));
  assert.ok(actions.includes('source.kill.SIGKILL'));

  assert.ok(actions.includes('ffmpeg.stdin.destroy'));
  assert.ok(actions.includes('ffmpeg.stdout.destroy'));
  assert.ok(actions.includes('ffmpeg.stderr.destroy'));
  assert.ok(actions.includes('ffmpeg.kill.SIGKILL'));

  // Should safely handle null processes
  assert.doesNotThrow(() => {
    GuildPlayer.prototype.killProcessPair.call(context, null, null);
  });
});

test('GuildPlayer killCurrentProcesses resets currentProcess and currentSourceProcess', () => {
  const killed = [];
  const context = createPlayerContext({
    currentProcess: {
      killed: false,
      kill: (sig) => killed.push(`ffmpeg.${sig}`)
    },
    currentSourceProcess: {
      killed: false,
      kill: (sig) => killed.push(`source.${sig}`)
    }
  });

  GuildPlayer.prototype.killCurrentProcesses.call(context, 'unit-test');

  assert.equal(context.currentProcess, null);
  assert.equal(context.currentSourceProcess, null);
  assert.deepEqual(killed, ['source.SIGKILL', 'ffmpeg.SIGKILL']);
});
