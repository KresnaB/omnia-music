import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatDuration,
  isTransientNetworkError,
  nowUnixPlus,
  truncate
} from '../src/utils/format.js';

test('formatDuration formats seconds correctly into MM:SS and HH:MM:SS', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(45), '00:45');
  assert.equal(formatDuration(60), '01:00');
  assert.equal(formatDuration(125), '02:05');
  assert.equal(formatDuration(3599), '59:59');
  assert.equal(formatDuration(3600), '01:00:00');
  assert.equal(formatDuration(3665), '01:01:05');
  assert.equal(formatDuration(86400), '24:00:00');
  // Edge cases
  assert.equal(formatDuration(-10), '00:00');
  assert.equal(formatDuration(null), '00:00');
  assert.equal(formatDuration(undefined), '00:00');
  assert.equal(formatDuration(75.8), '01:15');
});

test('truncate truncates strings and appends ellipsis correctly', () => {
  assert.equal(truncate('', 10), '');
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
  assert.equal(truncate('Hello', 10), 'Hello');
  assert.equal(truncate('Exact10Chr', 10), 'Exact10Chr');
  assert.equal(truncate('Hello World!', 8), 'Hello...');
  assert.equal(truncate('Testing Long String', 10), 'Testing...');
});

test('nowUnixPlus calculates future unix timestamp in seconds', () => {
  const before = Math.floor((Date.now() + 5000) / 1000);
  const result = nowUnixPlus(5000);
  const after = Math.floor((Date.now() + 5000) / 1000);
  assert.ok(result >= before && result <= after);
});

test('formatBytes formats file sizes with appropriate units and precision', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(10 * 1024), '10.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(formatBytes(25.5 * 1024 * 1024), '25.5 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024 * 1024), '2.50 TB');
});

test('isTransientNetworkError identifies transient network failures', () => {
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
  assert.equal(isTransientNetworkError({ code: 'ECONNRESET', message: 'connection reset' }), true);
  assert.equal(isTransientNetworkError({ code: 'ETIMEDOUT', message: 'timed out' }), true);
  assert.equal(isTransientNetworkError(new Error('Gateway Timeout')), true);
  assert.equal(isTransientNetworkError(new Error('WebSocket closed unexpectedly')), true);
  assert.equal(isTransientNetworkError(new Error('Server returned 403 Forbidden from googlevideo.com')), true);
  assert.equal(isTransientNetworkError(new Error('getaddrinfo ENOTFOUND discord.com')), true);

  // Non-transient errors
  assert.equal(isTransientNetworkError(new Error('SyntaxError: Unexpected token')), false);
  assert.equal(isTransientNetworkError(new Error('Invalid permissions')), false);
  assert.equal(isTransientNetworkError(new Error('Track not found')), false);
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError(undefined), false);
});
