import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/discord/commands.js';

test('commands array conforms to Discord slash command specifications', () => {
  assert.ok(Array.isArray(commands));
  assert.ok(commands.length > 0);

  const commandNames = new Set();

  for (const cmd of commands) {
    // Name must be lowercase, 1-32 chars, matching ^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]+$
    assert.ok(typeof cmd.name === 'string', 'Command name must be a string');
    assert.match(cmd.name, /^[a-z0-9_-]{1,32}$/, `Invalid command name: ${cmd.name}`);
    assert.ok(!commandNames.has(cmd.name), `Duplicate command name: ${cmd.name}`);
    commandNames.add(cmd.name);

    // Description must be 1-100 chars
    assert.ok(typeof cmd.description === 'string', `Command ${cmd.name} must have a description`);
    assert.ok(cmd.description.length >= 1 && cmd.description.length <= 100);

    // If options exist, validate each option
    if (cmd.options) {
      assert.ok(Array.isArray(cmd.options));
      for (const opt of cmd.options) {
        assert.ok(typeof opt.name === 'string');
        assert.match(opt.name, /^[a-z0-9_-]{1,32}$/);
        assert.ok(typeof opt.description === 'string');
        assert.ok(opt.description.length >= 1 && opt.description.length <= 100);
      }
    }
  }
});

test('commands includes all critical music bot commands', () => {
  const expectedCommands = [
    'play',
    'offlinemode',
    'normalmode',
    'skip',
    'stop',
    'seek',
    'queue',
    'loop',
    'shuffle',
    'autoplay',
    'move',
    'status',
    'lyrics',
    'cache-stats',
    'cache-list',
    'cache-delete',
    'sleep',
    'reconnect'
  ];

  const map = new Map(commands.map((cmd) => [cmd.name, cmd]));

  for (const name of expectedCommands) {
    assert.ok(map.has(name), `Missing expected slash command: ${name}`);
  }

  // Verify play command has required query option
  const playCmd = map.get('play');
  const queryOpt = playCmd.options?.find((o) => o.name === 'query');
  assert.ok(queryOpt);
  assert.equal(queryOpt.required, true);

  // Verify loop command choices
  const loopCmd = map.get('loop');
  const modeOpt = loopCmd.options?.find((o) => o.name === 'mode');
  assert.ok(modeOpt);
  assert.equal(modeOpt.required, true);
  const choiceValues = modeOpt.choices?.map((c) => c.value);
  assert.deepEqual(choiceValues, ['off', 'track', 'queue']);
});
