// Checks that update_task passes the SP fork's `waiting` field through to the client unchanged and
// that null clears it (no app, no network: a fake server records the registered tool and a fake client
// records the call). Run after `npm run build`: node scripts/test-update-task-waiting.mjs [distDir]
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '..', 'dist'));
const { setupTaskTools } = await import(pathToFileURL(path.join(dist, 'tools', 'tasks.js')).href);
const { z } = await import('zod');

let tool;
const server = {
  registerTool(name, def, handler) {
    if (name === 'update_task') tool = { def, handler };
  },
};
const calls = [];
const client = {
  updateTask: async (taskId, updates) => void calls.push({ taskId, updates }),
};
setupTaskTools(server, client);
assert.ok(tool, 'update_task was not registered');

const run = async (input) => {
  const parsed = z.object(tool.def.inputSchema).parse(input);
  return tool.handler(parsed);
};

// An object passes through unchanged, whatever its keys.
const waiting = {
  state: 'toSend',
  person: 'Gonza',
  slack: { channelId: 'C0123ABCD', threadTs: '1791224687.953179' },
  message: 'Hola',
  cadenceDays: 2,
  nextPingDay: '2026-10-16',
};
let res = await run({ taskId: 't1', waiting });
assert.equal(res.isError, undefined);
assert.deepEqual(calls.pop(), { taskId: 't1', updates: { waiting } });

// null clears the whole field.
res = await run({ taskId: 't1', waiting: null });
assert.equal(res.isError, undefined);
assert.deepEqual(calls.pop(), { taskId: 't1', updates: { waiting: null } });

// A write without it does not carry the key.
await run({ taskId: 't1', notes: 'x' });
assert.deepEqual(calls.pop(), { taskId: 't1', updates: { notes: 'x' } });

// Something that is not an object or null is refused before it reaches the app.
assert.throws(() => z.object(tool.def.inputSchema).parse({ taskId: 't1', waiting: 'toSend' }));
assert.throws(() => z.object(tool.def.inputSchema).parse({ taskId: 't1', waiting: [1] }));

console.log('update_task waiting: ok');
