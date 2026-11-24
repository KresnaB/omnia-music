import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlaylistService } from '../src/services/playlistService.js';

test('PlaylistService records, searches, and matches play history and guild settings', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-history-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const service = new PlaylistService(dbPath);

  try {
    service.recordHistory('guild-1', {
      id: '_xCVvUVPV7c',
      title: 'Kendrick Lamar - Money Trees',
      webpageUrl: 'https://www.youtube.com/watch?v=_xCVvUVPV7c',
      uploader: 'Kendrick Lamar',
      duration: 387,
      source: 'youtube'
    });

    const found = service.searchHistory('guild-1', 'money', 10);
    assert.equal(found.length, 1);
    assert.equal(found[0].url, 'https://www.youtube.com/watch?v=_xCVvUVPV7c');

    const exact = service.findHistoryMatch('guild-1', 'Kendrick Lamar - Money Trees');
    assert.equal(exact?.webpageUrl, 'https://www.youtube.com/watch?v=_xCVvUVPV7c');

    assert.deepEqual(service.getGuildSettings('guild-1'), {
      guildId: 'guild-1',
      mode247: false,
      djRoleId: null
    });

    service.setMode247('guild-1', true);
    service.setDjRole('guild-1', 'role-123');
    assert.deepEqual(service.getGuildSettings('guild-1'), {
      guildId: 'guild-1',
      mode247: true,
      djRoleId: 'role-123'
    });
  } finally {
    service.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
