import test from "node:test";
import assert from "node:assert/strict";
import { GuildPlayer } from "../src/player/GuildPlayer.js";

function createContext({ bestMatch = null, randomTrack = null } = {}) {
  const calls = [];
  return {
    context: {
      current: null,
      queue: [],
      history: [],
      audioCache: {
        async getBestMatchTrack(options) {
          calls.push(["best", options]);
          return bestMatch;
        },
        async getAutoplayCandidate(options) {
          calls.push(["random", options]);
          return randomTrack;
        },
      },
    },
    calls,
  };
}

test("manual cache fallback does not select a random track", async () => {
  const { context, calls } = createContext({ randomTrack: { title: "Random" } });

  const result = await GuildPlayer.prototype.buildCacheFallbackTrack.call(context, {
    preferredQuery: "requested song",
    requester: { id: "user" },
  });

  assert.equal(result, null);
  assert.deepEqual(calls.map(([name]) => name), ["best"]);
});

test("autoplay cache fallback may select a random track", async () => {
  const randomTrack = { title: "Random" };
  const { context, calls } = createContext({ randomTrack });

  const result = await GuildPlayer.prototype.buildCacheFallbackTrack.call(context, {
    preferredQuery: "missing seed",
    requester: { id: "autoplay" },
    allowRandom: true,
  });

  assert.equal(result, randomTrack);
  assert.deepEqual(calls.map(([name]) => name), ["best", "random"]);
});

test("manual cache fallback still returns a fuzzy match", async () => {
  const bestMatch = { title: "Requested Song" };
  const { context, calls } = createContext({ bestMatch });

  const result = await GuildPlayer.prototype.buildCacheFallbackTrack.call(context, {
    preferredQuery: "requested song",
    requester: { id: "user" },
  });

  assert.equal(result, bestMatch);
  assert.deepEqual(calls.map(([name]) => name), ["best"]);
});
