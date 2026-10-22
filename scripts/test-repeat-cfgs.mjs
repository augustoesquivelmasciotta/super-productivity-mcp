// Checks the repeat-config writes end to end without the app: the three MCP tools against a fake
// client (fields passed through, null kept, an old plugin named instead of a timeout) and the plugin's
// socket handlers run in a sandbox against a fake socket and a fake PluginAPI (each answer carries
// the stored config, failures come back as { error }). Run after `npm run build`:
//   node scripts/test-repeat-cfgs.mjs [distDir]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '..', 'dist'));
const { setupRepeatCfgTools } = await import(
  pathToFileURL(path.join(dist, 'tools', 'repeat-cfgs.js')).href
);
const { z } = await import('zod');

// --- MCP tools ---------------------------------------------------------------------------------

const tools = {};
const server = { registerTool: (name, def, handler) => (tools[name] = { def, handler }) };
const calls = [];
let pluginVersion = '1.0.9';
let failWith = null;
const client = {
  getConnectionStatus: () => ({ connected: true, lastStartup: pluginVersion ? { version: pluginVersion } : null }),
  addTaskRepeatCfg: async (taskId, cfg) => {
    calls.push({ op: 'add', taskId, cfg });
    if (failWith) throw new Error(failWith);
    return { repeatCfgId: 'cfg-new', repeatCfg: { id: 'cfg-new', ...cfg } };
  },
  updateTaskRepeatCfg: async (repeatCfgId, changes) => {
    calls.push({ op: 'update', repeatCfgId, changes });
    return { repeatCfgId, repeatCfg: { id: repeatCfgId, ...changes } };
  },
  deleteTaskRepeatCfg: async (repeatCfgId) => {
    calls.push({ op: 'delete', repeatCfgId });
    return { repeatCfgId, deleted: true };
  },
};
setupRepeatCfgTools(server, client);
assert.deepEqual(Object.keys(tools).sort(), [
  'create_task_repeat_cfg',
  'delete_task_repeat_cfg',
  'update_task_repeat_cfg',
]);

const run = async (name, input) => {
  const parsed = z.object(tools[name].def.inputSchema).parse(input);
  const res = await tools[name].handler(parsed);
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
};
const parseFails = (name, input) =>
  assert.throws(() => z.object(tools[name].def.inputSchema).parse(input), `${name} accepted ${JSON.stringify(input)}`);

// Create: only the fields given reach the client, null kept (it removes a time in the app).
let res = await run('create_task_repeat_cfg', {
  taskId: '7n_TCj6E-6Ih2sq0RhHFK',
  quickSetting: 'MONTHLY_CURRENT_DATE',
  startTime: null,
});
assert.equal(res.isError, false);
assert.deepEqual(calls.pop(), {
  op: 'add',
  taskId: '7n_TCj6E-6Ih2sq0RhHFK',
  cfg: { quickSetting: 'MONTHLY_CURRENT_DATE', startTime: null },
});
assert.equal(res.json.success, true);
assert.equal(res.json.repeatCfgId, 'cfg-new');

// A full routine: weekdays, time, reminder, subtasks.
await run('create_task_repeat_cfg', {
  taskId: 't1',
  repeatCycle: 'WEEKLY',
  monday: true,
  thursday: true,
  startTime: '18:30',
  remindAt: 'AtStart',
  shouldInheritSubtasks: true,
  startDate: '2026-10-26',
});
assert.deepEqual(calls.pop().cfg, {
  repeatCycle: 'WEEKLY',
  monday: true,
  thursday: true,
  startTime: '18:30',
  remindAt: 'AtStart',
  shouldInheritSubtasks: true,
  startDate: '2026-10-26',
});

// Keys the app keeps for itself never reach it.
await run('create_task_repeat_cfg', { taskId: 't1', projectId: 'p2', subTaskTemplates: [] });
assert.deepEqual(calls.pop().cfg, {});

// Shapes refused before the app: bad cycle, bad date, bad time, repeatEvery < 1, bad weekday.
parseFails('create_task_repeat_cfg', { taskId: 't1', repeatCycle: 'HOURLY' });
parseFails('create_task_repeat_cfg', { taskId: 't1', startDate: '22/10/2026' });
parseFails('create_task_repeat_cfg', { taskId: 't1', startTime: '7pm' });
parseFails('create_task_repeat_cfg', { taskId: 't1', repeatEvery: 0 });
parseFails('create_task_repeat_cfg', { taskId: 't1', monthlyWeekday: 7 });
parseFails('create_task_repeat_cfg', {});

// An error from the app comes back as a tool error.
failWith = 'Task t1 already repeats (repeat config c1). Change it with updateTaskRepeatCfg().';
res = await run('create_task_repeat_cfg', { taskId: 't1' });
assert.equal(res.isError, true);
assert.match(res.text, /already repeats/);
calls.pop();
failWith = null;

// Update: pause, resume, and nothing-to-change refused.
res = await run('update_task_repeat_cfg', { repeatCfgId: 'c1', isPaused: true });
assert.equal(res.isError, false);
assert.deepEqual(calls.pop(), { op: 'update', repeatCfgId: 'c1', changes: { isPaused: true } });
await run('update_task_repeat_cfg', { repeatCfgId: 'c1', isPaused: false, monthlyWeekOfMonth: null, monthlyWeekday: null });
assert.deepEqual(calls.pop().changes, { isPaused: false, monthlyWeekOfMonth: null, monthlyWeekday: null });
res = await run('update_task_repeat_cfg', { repeatCfgId: 'c1' });
assert.equal(res.isError, true);
assert.match(res.text, /Nothing to change/);
assert.equal(calls.length, 0);

// Delete.
res = await run('delete_task_repeat_cfg', { repeatCfgId: 'c1' });
assert.equal(res.isError, false);
assert.deepEqual(calls.pop(), { op: 'delete', repeatCfgId: 'c1' });
assert.equal(res.json.deleted, true);

// A plugin older than 1.0.9 is named, and nothing is sent to it.
pluginVersion = '1.0.8';
for (const [name, input] of [
  ['create_task_repeat_cfg', { taskId: 't1' }],
  ['update_task_repeat_cfg', { repeatCfgId: 'c1', isPaused: true }],
  ['delete_task_repeat_cfg', { repeatCfgId: 'c1' }],
]) {
  res = await run(name, input);
  assert.equal(res.isError, true, name);
  assert.match(res.text, /1\.0\.8.*1\.0\.9.*mcp-bridge-plugin\.zip/, name);
}
assert.equal(calls.length, 0);
// A newer one, and one the server has not heard from yet, are let through.
for (const v of ['1.0.10', '1.1.0', null]) {
  pluginVersion = v;
  res = await run('delete_task_repeat_cfg', { repeatCfgId: 'c1' });
  assert.equal(res.isError, false, String(v));
  calls.pop();
}

// --- Plugin handlers ---------------------------------------------------------------------------

const pluginSource = fs.readFileSync(path.join(here, '..', 'mcp-bridge-plugin', 'plugin-logic.js'), 'utf8');

const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const loadPlugin = (api) => {
  const handlers = {};
  const emitted = [];
  const socket = {
    id: 'sock-1',
    on: (event, fn) => (handlers[event] = fn),
    emit: (event, payload) => emitted.push({ event, payload }),
    removeAllListeners() {},
    disconnect() {},
    io: { on() {}, engine: null },
  };
  const context = vm.createContext({
    io: () => socket,
    PluginAPI: api,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    Promise,
  });
  vm.runInContext(pluginSource, context);
  // A callback-style handler as a promise of its single answer, as plain data: objects made inside
  // the sandbox have its own Object prototype, which deepStrictEqual would hold against them.
  const ask = (event, data) =>
    new Promise((resolve) => handlers[event](data, (v) => resolve(plain(v))));
  return { handlers, emitted, ask };
};

const stored = {
  'cfg-1': { id: 'cfg-1', repeatCycle: 'MONTHLY', quickSetting: 'MONTHLY_CURRENT_DATE' },
};
const apiCalls = [];
const api = {
  registerHook() {},
  onUnload() {},
  getAppState: async () => ({ taskRepeatCfgs: stored }),
  addTaskRepeatCfg: async (taskId, cfg) => {
    apiCalls.push(['add', taskId, cfg]);
    if (taskId === 'sub') throw new Error('A subtask cannot repeat. Make its parent task repeat instead.');
    return 'cfg-1';
  },
  updateTaskRepeatCfg: async (id, changes) => void apiCalls.push(['update', id, changes]),
  deleteTaskRepeatCfg: async (id) => void apiCalls.push(['delete', id]),
};
const plugin = loadPlugin(api);

// The heartbeat says 1.0.9, which is what the server's check reads.
plugin.handlers.connect();
assert.deepEqual(plain(plugin.emitted.find((e) => e.event === 'event:debug:startup').payload), {
  version: '1.0.9',
  socketId: 'sock-1',
});

let answer = await plugin.ask('repeatCfgs:create', { taskId: 't1', cfg: { quickSetting: 'MONTHLY_CURRENT_DATE' } });
assert.deepEqual(plain(apiCalls.pop()), ['add', 't1', { quickSetting: 'MONTHLY_CURRENT_DATE' }]);
assert.deepEqual(answer, { repeatCfgId: 'cfg-1', repeatCfg: stored['cfg-1'] });

answer = await plugin.ask('repeatCfgs:create', { taskId: 't1' });
assert.deepEqual(plain(apiCalls.pop()), ['add', 't1', {}]);

answer = await plugin.ask('repeatCfgs:create', { taskId: 'sub', cfg: {} });
apiCalls.pop();
assert.deepEqual(answer, { error: 'A subtask cannot repeat. Make its parent task repeat instead.' });

answer = await plugin.ask('repeatCfgs:update', { repeatCfgId: 'cfg-1', changes: { isPaused: true } });
assert.deepEqual(plain(apiCalls.pop()), ['update', 'cfg-1', { isPaused: true }]);
assert.deepEqual(answer, { repeatCfgId: 'cfg-1', repeatCfg: stored['cfg-1'] });

answer = await plugin.ask('repeatCfgs:update', { repeatCfgId: 'gone', changes: { isPaused: true } });
apiCalls.pop();
assert.deepEqual(answer, { repeatCfgId: 'gone', repeatCfg: null });

answer = await plugin.ask('repeatCfgs:delete', { repeatCfgId: 'cfg-1' });
assert.deepEqual(plain(apiCalls.pop()), ['delete', 'cfg-1']);
assert.deepEqual(answer, { repeatCfgId: 'cfg-1', deleted: true });

// A Super Productivity build without the methods says so instead of throwing in the handler.
const stock = loadPlugin({ registerHook() {}, onUnload() {}, getAppState: api.getAppState });
for (const [event, method] of [
  ['repeatCfgs:create', 'addTaskRepeatCfg'],
  ['repeatCfgs:update', 'updateTaskRepeatCfg'],
  ['repeatCfgs:delete', 'deleteTaskRepeatCfg'],
]) {
  answer = await stock.ask(event, { taskId: 't1', repeatCfgId: 'cfg-1' });
  assert.match(answer.error, new RegExp(`${method} is not available`), event);
}

// The read handler is untouched.
answer = await plugin.ask('repeatCfgs:get', {});
assert.deepEqual(answer, [stored['cfg-1']]);

console.log('repeat config writes: ok');
