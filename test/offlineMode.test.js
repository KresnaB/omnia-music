import test from "node:test";
import assert from "node:assert/strict";
import { GuildPlayer } from "../src/player/GuildPlayer.js";

test("offline mode replaces the session with matching cached tracks", async () => {
  const tracks = [
    { id: "one", title: "Artist - One", localPath: "one.ogg" },
    { id: "two", title: "Artist - Two", localPath: "two.ogg" },
  ];
  const calls = [];
  const context = {
    guildId: "guild",
    offlineMode: false,
    offlineModeQuery: null,
    offlineModeStartedAt: null,
    stopRequested: true,
    lastTextChannelId: null,
    audioCache: {
      async resolveQueryToTracks(query, overrides, options) {
        calls.push(["resolve", query, overrides, options]);
        return tracks;
      },
    },
    async ensureVoice(channel) {
      calls.push(["voice", channel.id]);
    },
    async stop(options) {
      calls.push(["stop", options]);
    },
    insertUserTracks(value) {
      calls.push(["insert", value]);
    },
    publishNowPlaying(reason) {
      calls.push(["publish", reason]);
    },
    queuePlayNext(reason) {
      calls.push(["play", reason]);
    },
  };

  const result = await GuildPlayer.prototype.enableOfflineMode.call(context, {
    member: {
      id: "user",
      displayName: "User",
      voice: { channel: { id: "voice" } },
    },
    textChannel: { id: "text" },
    query: "Artist",
  });

  assert.equal(result.type, "offline");
  assert.equal(result.tracks, tracks);
  assert.equal(context.offlineMode, true);
  assert.equal(context.offlineModeQuery, "Artist");
  assert.equal(context.stopRequested, false);
  assert.deepEqual(calls.map(([name]) => name), [
    "resolve",
    "voice",
    "stop",
    "insert",
    "publish",
    "play",
  ]);
  assert.deepEqual(calls[2][1], {
    disconnect: false,
    resetPlaybackMode: false,
  });
});

test("offline mode is not activated when cache has no matches", async () => {
  const context = {
    guildId: "guild",
    offlineMode: false,
    audioCache: {
      async resolveQueryToTracks() {
        return [];
      },
    },
  };

  await assert.rejects(
    GuildPlayer.prototype.enableOfflineMode.call(context, {
      member: {
        id: "user",
        displayName: "User",
        voice: { channel: { id: "voice" } },
      },
      textChannel: { id: "text" },
      query: "Missing",
    }),
    /Cache lokal tidak menemukan/,
  );
  assert.equal(context.offlineMode, false);
});

test("normal mode clears forced offline session state", () => {
  const context = {
    guildId: "guild",
    offlineMode: true,
    offlineModeQuery: "Artist",
    offlineModeStartedAt: Date.now(),
    publishNowPlaying() {},
  };

  const changed = GuildPlayer.prototype.setNormalMode.call(context, "test");

  assert.equal(changed, true);
  assert.equal(context.offlineMode, false);
  assert.equal(context.offlineModeQuery, null);
  assert.equal(context.offlineModeStartedAt, null);
});

test("offline playback guard never requests a YouTube stream", async () => {
  let streamRequested = false;
  const context = {
    guildId: "guild",
    offlineMode: true,
    youtubeStatus: "up",
    audioCache: {
      async hydrateLocalReference() {
        return null;
      },
    },
    ytdlp: {
      async ensureStreamUrl() {
        streamRequested = true;
      },
    },
  };

  await assert.rejects(
    GuildPlayer.prototype.prepareTrackForPlayback.call(
      context,
      { title: "Not Cached", localPath: null, metadataPending: false },
      { allowBackgroundDownload: false },
    ),
    /Mode offline aktif/,
  );
  assert.equal(streamRequested, false);
});
