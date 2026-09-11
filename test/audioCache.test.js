import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioCacheService } from '../src/services/audioCache.js';

function createMockEntry({ id, title, uploader, canonicalKey, filePath = '/cache/track.ogg', size = 5000000 }) {
  return {
    canonicalKey: canonicalKey || title.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    filePath,
    fileSize: size,
    sizeBytes: size,
    cachedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 1,
    track: {
      id,
      title,
      uploader,
      duration: 210,
      url: `https://youtube.com/watch?v=${id}`
    }
  };
}

test('AudioCacheService indexes and finds exact and partial matches', () => {
  const service = new AudioCacheService();
  service.readyPromise = Promise.resolve();

  const entry1 = createMockEntry({
    id: 'track1',
    title: 'Viva La Vida',
    uploader: 'Coldplay',
    canonicalKey: 'viva-la-vida'
  });

  const entry2 = createMockEntry({
    id: 'track2',
    title: 'Fix You',
    uploader: 'Coldplay',
    canonicalKey: 'fix-you'
  });

  const entry3 = createMockEntry({
    id: 'track3',
    title: 'Adventure of a Lifetime',
    uploader: 'Coldplay',
    canonicalKey: 'adventure-of-a-lifetime'
  });

  service.index.set(entry1.canonicalKey, entry1);
  service.index.set(entry2.canonicalKey, entry2);
  service.index.set(entry3.canonicalKey, entry3);
  service.rebuildSearchIndex();

  const results = service.searchEntries('Viva La Vida');
  assert.equal(results.length, 1);
  assert.equal(results[0].entry.track.title, 'Viva La Vida');
});

test('AudioCacheService respects excludeCanonicalKeys when searching', () => {
  const service = new AudioCacheService();
  service.readyPromise = Promise.resolve();
  const entry = createMockEntry({
    id: 'track1',
    title: 'Yellow',
    uploader: 'Coldplay',
    canonicalKey: 'yellow'
  });

  service.index.set(entry.canonicalKey, entry);
  service.rebuildSearchIndex();

  const results = service.searchEntries('Yellow', { excludeCanonicalKeys: ['yellow'] });
  assert.equal(results.length, 0);
});

test('AudioCacheService getBestMatchTrack returns cloned track structure', async () => {
  const service = new AudioCacheService();
  service.readyPromise = Promise.resolve();
  const entry = createMockEntry({
    id: 'track1',
    title: 'Clocks',
    uploader: 'Coldplay',
    canonicalKey: 'clocks',
    filePath: '/music/clocks.ogg'
  });

  service.index.set(entry.canonicalKey, entry);
  service.rebuildSearchIndex();

  const match = await service.getBestMatchTrack({ query: 'Clocks' });
  assert.ok(match);
  assert.equal(match.title, 'Clocks');
  assert.equal(match.localPath, '/music/clocks.ogg');
  assert.equal(match.cacheStatus, 'cached');
  assert.equal(match.streamUrl, null);
});

test('AudioCacheService getBestMatchTrack returns null when no match found', async () => {
  const service = new AudioCacheService();
  service.readyPromise = Promise.resolve();
  service.rebuildSearchIndex();

  const match = await service.getBestMatchTrack({ query: 'Nonexistent Track 12345' });
  assert.equal(match, null);
});

test('AudioCacheService getAutoplayCandidate selects track not in excluded list', async () => {
  const service = new AudioCacheService();
  service.readyPromise = Promise.resolve();
  const entry1 = createMockEntry({ id: '1', title: 'Song One', uploader: 'Artist' });
  const entry2 = createMockEntry({ id: '2', title: 'Song Two', uploader: 'Artist' });

  service.index.set(entry1.canonicalKey, entry1);
  service.index.set(entry2.canonicalKey, entry2);
  service.rebuildSearchIndex();

  const candidate = await service.getAutoplayCandidate({
    excludeCanonicalKeys: [entry1.canonicalKey]
  });

  assert.ok(candidate);
  assert.equal(candidate.id, '2');
});

test('AudioCacheService getStats calculates track count and size', async () => {
  const service = new AudioCacheService();
  service.readyPromise = Promise.resolve();
  const entry1 = createMockEntry({ id: '1', title: 'A', uploader: 'Artist', size: 1000 });
  const entry2 = createMockEntry({ id: '2', title: 'B', uploader: 'Artist', size: 2000 });

  service.index.set(entry1.canonicalKey, entry1);
  service.index.set(entry2.canonicalKey, entry2);

  const stats = await service.getStats();
  assert.equal(stats.totalTracks, 2);
  assert.equal(stats.totalBytes, 3000);
});
