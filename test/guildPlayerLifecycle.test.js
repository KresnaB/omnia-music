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

test('GuildPlayer buildControlRows and buildDisabledControlRows have 8 symmetrical buttons without playlist button', () => {
  const context = createPlayerContext({
    player: { state: { status: 'playing' } },
    shuffleActive: false,
    autoplay: false,
    loopMode: 'off'
  });

  const activeRows = GuildPlayer.prototype.buildControlRows.call(context);
  assert.equal(activeRows.length, 2);
  assert.equal(activeRows[0].components.length, 4);
  assert.equal(activeRows[1].components.length, 4);
  const activeButtons = activeRows.flatMap((r) => r.components);
  assert.equal(activeButtons.length, 8);
  const playlistActive = activeButtons.find((b) => b.data?.custom_id === 'player:playlist');
  assert.equal(playlistActive, undefined, 'Active control rows must not include player:playlist button');

  for (const btn of activeButtons) {
    assert.ok(btn.data.emoji?.name, `Active button ${btn.data.custom_id} must have an emoji`);
    assert.equal(btn.data.label, undefined, `Active button ${btn.data.custom_id} must not have text label`);
  }

  const disabledRows = GuildPlayer.prototype.buildDisabledControlRows.call(context);
  assert.equal(disabledRows.length, 2);
  assert.equal(disabledRows[0].components.length, 4);
  assert.equal(disabledRows[1].components.length, 4);
  const disabledButtons = disabledRows.flatMap((r) => r.components);
  assert.equal(disabledButtons.length, 8);
  const playlistDisabled = disabledButtons.find((b) => b.data?.custom_id === 'player:playlist');
  assert.equal(playlistDisabled, undefined, 'Disabled control rows must not include player:playlist button');

  for (const btn of disabledButtons) {
    assert.ok(btn.data.emoji?.name, `Disabled button ${btn.data.custom_id} must have an emoji`);
    assert.equal(btn.data.label, undefined, `Disabled button ${btn.data.custom_id} must not have text label`);
    assert.equal(btn.data.disabled, true);
  }
});

test('GuildPlayer buildNowPlayingEmbed is simplified, has no cache details, and includes Kubiku footer', () => {
  const context = createPlayerContext({
    current: {
      title: 'Test Song',
      uploader: 'Test Artist',
      duration: 215,
      requester: { id: 'u1', name: 'JohnDoe' },
      webpageUrl: 'https://youtube.com/watch?v=123',
      thumbnail: 'https://img.youtube.com/vi/123/default.jpg'
    },
    queue: [{ title: 'Next Song' }],
    loopMode: 'off',
    autoplay: true,
    status: () => ({
      loopMode: 'off',
      autoplay: true,
      offlineMode: false
    })
  });

  const embed = GuildPlayer.prototype.buildNowPlayingEmbed.call(context);
  assert.equal(embed.data.title, 'Test Song');
  assert.ok(embed.data.footer.text.includes('Powered by Kubiku Technology'));
  assert.ok(embed.data.footer.text.includes('Requested by JohnDoe'));
  assert.ok(!embed.data.description.includes('Source:'));
  assert.ok(!embed.data.description.includes('Mode:'));
  assert.ok(!embed.data.description.includes('Cache:'));
  assert.ok(!embed.data.description.includes('YouTube:'));
  assert.ok(embed.data.description.includes('**Uploader:** Test Artist'));
  assert.ok(embed.data.description.includes('**Duration:** `03:35`'));
});

test('GuildPlayer playPlaylist validates voice channel and track list', async () => {
  const context = createPlayerContext();

  await assert.rejects(
    () => GuildPlayer.prototype.playPlaylist.call(context, { member: {}, textChannel: { id: 'tc-1' }, name: 'Rock', tracks: [{ id: '1' }] }),
    /Kamu harus berada di voice channel terlebih dahulu/
  );

  await assert.rejects(
    () => GuildPlayer.prototype.playPlaylist.call(context, {
      member: { voice: { channel: { id: 'vc-1' } } },
      textChannel: { id: 'tc-1' },
      name: 'Empty',
      tracks: []
    }),
    /tidak memiliki lagu/
  );
});

test('GuildPlayer playPlaylist connects voice, enqueues tracks, and starts playback when idle', async () => {
  let voiceEnsured = false;
  let playNextCalled = false;
  let inserted = [];

  const context = createPlayerContext({
    ensureVoice: async (vc) => { voiceEnsured = vc.id === 'vc-1'; },
    insertUserTracks: (tracks) => { inserted = tracks; },
    queuePlayNext: (reason) => { playNextCalled = reason === 'enqueue-playlist'; },
    ytdlp: { hydrate: async () => {} }
  });

  const member = {
    id: 'user-1',
    displayName: 'TestUser',
    voice: { channel: { id: 'vc-1' } }
  };
  const textChannel = { id: 'tc-1' };
  const rawTracks = [
    { id: 'track-1', title: 'Song 1', duration: 180, url: 'https://youtu.be/1' },
    { id: 'track-2', title: 'Song 2', duration: 200, url: 'https://youtu.be/2' }
  ];

  const res = await GuildPlayer.prototype.playPlaylist.call(context, {
    member,
    textChannel,
    name: 'My Mix',
    tracks: rawTracks
  });

  assert.equal(voiceEnsured, true);
  assert.equal(playNextCalled, true);
  assert.equal(context.lastTextChannelId, 'tc-1');
  assert.equal(res.type, 'playlist');
  assert.equal(res.playlistTitle, 'My Mix');
  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].requester.name, 'TestUser');
  assert.equal(inserted[0].originalQuery, 'Playlist: My Mix');
});

test('GuildPlayer remove removes track by 1-based index and validates bounds', () => {
  const context = createPlayerContext({
    queue: [
      { id: '1', title: 'Track 1' },
      { id: '2', title: 'Track 2' },
      { id: '3', title: 'Track 3' }
    ]
  });

  const removed = GuildPlayer.prototype.remove.call(context, 2);
  assert.equal(removed.id, '2');
  assert.equal(context.queue.length, 2);
  assert.equal(context.queue[0].id, '1');
  assert.equal(context.queue[1].id, '3');

  assert.throws(() => GuildPlayer.prototype.remove.call(context, 0), /tidak valid/);
  assert.throws(() => GuildPlayer.prototype.remove.call(context, 5), /tidak valid/);
});

test('GuildPlayer clearQueue empties queue and resets shuffleActive', () => {
  const context = createPlayerContext({
    queue: [{ id: '1' }, { id: '2' }],
    shuffleActive: true
  });

  const count = GuildPlayer.prototype.clearQueue.call(context);
  assert.equal(count, 2);
  assert.equal(context.queue.length, 0);
  assert.equal(context.shuffleActive, false);
});

test('GuildPlayer pause and resume toggle player states and guard against invalid calls', () => {
  let paused = false;
  let unpaused = false;

  const context = createPlayerContext({
    current: { id: '1', title: 'Song' },
    player: {
      state: { status: 'playing' },
      pause: () => { paused = true; return true; },
      unpause: () => { unpaused = true; return true; }
    }
  });

  // Pause when playing
  const pauseResult = GuildPlayer.prototype.pause.call(context);
  assert.equal(pauseResult, true);
  assert.equal(paused, true);

  // Pause when already paused
  context.player.state.status = 'paused';
  assert.equal(GuildPlayer.prototype.pause.call(context), false);

  // Resume when paused
  const resumeResult = GuildPlayer.prototype.resume.call(context);
  assert.equal(resumeResult, true);
  assert.equal(unpaused, true);

  // Resume when already playing
  context.player.state.status = 'playing';
  assert.equal(GuildPlayer.prototype.resume.call(context), false);

  // Throw if no current track
  context.current = null;
  assert.throws(() => GuildPlayer.prototype.pause.call(context), /Tidak ada lagu/);
  assert.throws(() => GuildPlayer.prototype.resume.call(context), /Tidak ada lagu/);
});

test('GuildPlayer replay seeks to 0 for current track', async () => {
  let seekCalledWith = null;
  const context = createPlayerContext({
    current: { id: '1', title: 'Song' },
    seek: async (sec) => { seekCalledWith = sec; }
  });

  const res = await GuildPlayer.prototype.replay.call(context);
  assert.equal(res.id, '1');
  assert.equal(seekCalledWith, 0);

  context.current = null;
  await assert.rejects(() => GuildPlayer.prototype.replay.call(context), /Tidak ada lagu/);
});

test('GuildPlayer skipto advances queue to selected index and calls skip', async () => {
  let skipCalled = false;
  const context = createPlayerContext({
    current: { id: 'curr', title: 'Current' },
    queue: [
      { id: '1', title: 'Song 1' },
      { id: '2', title: 'Song 2' },
      { id: '3', title: 'Song 3' }
    ],
    skip: async () => { skipCalled = true; return true; }
  });

  const target = await GuildPlayer.prototype.skipto.call(context, 2);
  assert.equal(target.id, '2');
  assert.equal(skipCalled, true);
  assert.equal(context.queue.length, 2);
  assert.equal(context.queue[0].id, '2');

  assert.rejects(() => GuildPlayer.prototype.skipto.call(context, 0), /tidak valid/);
  assert.rejects(() => GuildPlayer.prototype.skipto.call(context, 10), /tidak valid/);
});

test('GuildPlayer previous restores previous track from history', async () => {
  let stopped = false;
  const context = createPlayerContext({
    current: { id: 'curr', title: 'Current Track' },
    history: [
      { id: 'hist-1', title: 'Old Track' },
      { id: 'hist-2', title: 'Previous Track' }
    ],
    queue: [{ id: 'q-1', title: 'Next Track' }],
    player: {
      state: { status: 'playing' },
      stop: (force) => { stopped = force; }
    }
  });

  const prev = await GuildPlayer.prototype.previous.call(context);
  assert.equal(prev.id, 'hist-2');
  assert.equal(stopped, true);
  assert.equal(context.history.length, 1);
  assert.equal(context.queue[0].id, 'hist-2');
  assert.equal(context.queue[1].id, 'curr');
  assert.equal(context.queue[2].id, 'q-1');

  // Throws if history is empty
  context.history = [];
  await assert.rejects(() => GuildPlayer.prototype.previous.call(context), /Tidak ada riwayat/);
});

test('GuildPlayer historyLines formats history output correctly', () => {
  const emptyContext = createPlayerContext({ history: [] });
  assert.deepEqual(GuildPlayer.prototype.historyLines.call(emptyContext), [
    'Belum ada riwayat lagu yang diputar.'
  ]);

  const filledContext = createPlayerContext({
    history: [
      { title: 'Song A', duration: 120 },
      { title: 'Song B', duration: 240 }
    ]
  });

  const lines = GuildPlayer.prototype.historyLines.call(filledContext);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('Song B')); // Newest first (reversed)
  assert.ok(lines[1].includes('Song A'));
});
