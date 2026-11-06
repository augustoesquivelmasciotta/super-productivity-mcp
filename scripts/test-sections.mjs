// Checks the section tools end to end without the app: the six MCP tools against a fake client that keeps
// sections the way the plugin API does (arguments passed through, null kept, a field not given not sent,
// the result read back, the API's own message returned as it came, an old plugin named instead of a
// timeout) and the plugin's socket handlers run in a sandbox against a fake socket and a fake PluginAPI
// (what reaches each API method, the answers, failures as { error }, a build without the methods).
// Run after `npm run build`:
//   node scripts/test-sections.mjs [distDir]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const { setupSectionTools } = await import(pathToFileURL(path.join(dist, 'tools', 'sections.js')).href);
const { z } = await import('zod');

// --- MCP tools ---------------------------------------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));
const section = (id, contextId, title, taskIds = []) => ({
  id,
  contextId,
  contextType: contextId === 'TODAY' ? 'TAG' : 'PROJECT',
  title,
  isExpanded: true,
  taskIds,
});

let sections; // the fake app's sections, in app order
let calls; // every call the tools made to the client, in order
let nextId;
let pluginVersion;
let failWith; // the next write is refused with this message (the API's own words)
let readFailsWith; // every read fails with this message

const reset = () => {
  sections = [
    section('sA', 'p1', 'Alpha', ['t1', 't2']),
    section('sB', 'p1', 'Beta', ['t3']),
    section('sT', 'TODAY', 'Focus', ['t5']),
  ];
  calls = [];
  nextId = 1;
  pluginVersion = '1.0.10';
  failWith = null;
  readFailsWith = null;
};

const refuse = () => {
  if (failWith) throw new Error(failWith);
};

const client = {
  getConnectionStatus: () => ({ connected: true, lastStartup: pluginVersion ? { version: pluginVersion } : null }),
  getSections: async (contextId) => {
    calls.push({ op: 'get', contextId });
    if (readFailsWith) throw new Error(readFailsWith);
    return clone(contextId === undefined ? sections : sections.filter((s) => s.contextId === contextId));
  },
  addSection: async (title, contextId, contextType) => {
    calls.push({ op: 'add', title, contextId, contextType });
    refuse();
    const created = section(`new-${nextId++}`, contextId, title);
    sections.push(created);
    return created.id;
  },
  updateSection: async (sectionId, changes) => {
    calls.push({ op: 'update', sectionId, changes });
    refuse();
    Object.assign(sections.find((s) => s.id === sectionId), changes);
  },
  deleteSection: async (sectionId) => {
    calls.push({ op: 'delete', sectionId });
    refuse();
    sections = sections.filter((s) => s.id !== sectionId);
  },
  reorderSections: async (contextId, sectionIds) => {
    calls.push({ op: 'reorder', contextId, sectionIds });
    refuse();
    const mine = sections.filter((s) => s.contextId === contextId);
    sections = [
      ...sections.filter((s) => s.contextId !== contextId),
      ...sectionIds.map((id) => mine.find((s) => s.id === id)),
    ];
  },
  moveTaskToSection: async (taskId, sectionId, options) => {
    calls.push({ op: 'move', taskId, sectionId, options });
    refuse();
    // The task leaves the sections of the target's context (or of the one named, default p1)...
    const target = sectionId === null ? null : sections.find((s) => s.id === sectionId);
    const contextId = target ? target.contextId : (options.contextId ?? 'p1');
    for (const s of sections) if (s.contextId === contextId) s.taskIds = s.taskIds.filter((id) => id !== taskId);
    // ...and goes to the end of the target, its top (null) or right after a task.
    if (target) {
      const at =
        options.afterTaskId === undefined
          ? target.taskIds.length
          : options.afterTaskId === null
            ? 0
            : target.taskIds.indexOf(options.afterTaskId) + 1;
      target.taskIds.splice(at, 0, taskId);
    }
  },
};

const tools = {};
const server = { registerTool: (name, def, handler) => (tools[name] = { def, handler }) };
setupSectionTools(server, client);
assert.deepEqual(Object.keys(tools).sort(), [
  'create_section',
  'delete_section',
  'list_sections',
  'move_task_to_section',
  'reorder_sections',
  'update_section',
]);

const run = async (name, input) => {
  const parsed = z.object(tools[name].def.inputSchema).parse(input);
  const res = await tools[name].handler(parsed);
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
};
const parseFails = (name, input) =>
  assert.throws(() => z.object(tools[name].def.inputSchema).parse(input), `${name} accepted ${JSON.stringify(input)}`);
const writes = () => calls.filter((c) => c.op !== 'get');
const taskLists = (list) => list.map((s) => [s.id, s.taskIds]);

// List: every section, or one context's; an unknown context is an empty list.
reset();
let res = await run('list_sections', {});
assert.deepEqual(calls, [{ op: 'get', contextId: undefined }]);
assert.equal(res.json.count, 3);
assert.deepEqual(res.json.sections[0], {
  id: 'sA',
  contextId: 'p1',
  contextType: 'PROJECT',
  title: 'Alpha',
  isExpanded: true,
  taskIds: ['t1', 't2'],
});
assert.deepEqual(res.json.sections.map((s) => s.id), ['sA', 'sB', 'sT']);
calls = [];
res = await run('list_sections', { contextId: 'TODAY' });
assert.deepEqual(calls, [{ op: 'get', contextId: 'TODAY' }]);
assert.deepEqual(res.json.sections.map((s) => s.id), ['sT']);
res = await run('list_sections', { contextId: 'nope' });
assert.equal(res.json.count, 0);
assert.deepEqual(res.json.sections, []);
readFailsWith = 'Timeout waiting for plugin response for event sections:get';
res = await run('list_sections', {});
assert.equal(res.isError, true);
assert.equal(res.text, `Error: ${readFailsWith}`);

// Create: the title goes as given (SP trims it, even an empty one reaches SP), the new section comes back
// as SP holds it, read for that context.
reset();
res = await run('create_section', { title: 'Plans', contextId: 'p1' });
assert.equal(res.isError, false);
assert.deepEqual(writes(), [{ op: 'add', title: 'Plans', contextId: 'p1', contextType: undefined }]);
assert.deepEqual(calls.at(-1), { op: 'get', contextId: 'p1' });
assert.equal(res.json.success, true);
assert.equal(res.json.sectionId, 'new-1');
assert.deepEqual(res.json.section, {
  id: 'new-1',
  contextId: 'p1',
  contextType: 'PROJECT',
  title: 'Plans',
  isExpanded: true,
  taskIds: [],
});
calls = [];
res = await run('create_section', { title: '  Padded  ', contextId: 'TODAY', contextType: 'TAG' });
assert.deepEqual(writes(), [{ op: 'add', title: '  Padded  ', contextId: 'TODAY', contextType: 'TAG' }]);
assert.equal(res.json.section.contextType, 'TAG');
calls = [];
failWith = 'A section needs a title';
for (const title of ['', '  ']) {
  calls = [];
  res = await run('create_section', { title, contextId: 'p1' });
  assert.deepEqual(writes(), [{ op: 'add', title, contextId: 'p1', contextType: undefined }]);
  assert.equal(res.isError, true);
  assert.equal(res.text, 'Error: A section needs a title');
}
failWith = null;
parseFails('create_section', { contextId: 'p1' });
parseFails('create_section', { title: 'x' });
parseFails('create_section', { title: 'x', contextId: 'p1', contextType: 'project' });
parseFails('create_section', { title: 4, contextId: 'p1' });

// Update: only the fields given reach the client; false is a value; nothing else can be written.
reset();
res = await run('update_section', { sectionId: 'sA', title: 'Alpha 2' });
assert.equal(res.isError, false);
assert.deepEqual(writes(), [{ op: 'update', sectionId: 'sA', changes: { title: 'Alpha 2' } }]);
assert.equal(res.json.sectionId, 'sA');
assert.deepEqual(res.json.section, {
  id: 'sA',
  contextId: 'p1',
  contextType: 'PROJECT',
  title: 'Alpha 2',
  isExpanded: true,
  taskIds: ['t1', 't2'],
});
calls = [];
res = await run('update_section', { sectionId: 'sA', isExpanded: false });
assert.deepEqual(writes(), [{ op: 'update', sectionId: 'sA', changes: { isExpanded: false } }]);
assert.equal(res.json.section.isExpanded, false);
assert.equal(res.json.section.title, 'Alpha 2');
calls = [];
await run('update_section', { sectionId: 'sB', title: 'Beta 2', isExpanded: false });
assert.deepEqual(writes(), [{ op: 'update', sectionId: 'sB', changes: { title: 'Beta 2', isExpanded: false } }]);
calls = [];
await run('update_section', { sectionId: 'sB', taskIds: ['x'], contextId: 'p2', id: 'other' });
assert.deepEqual(writes(), [{ op: 'update', sectionId: 'sB', changes: {} }]);
parseFails('update_section', { title: 'x' });
parseFails('update_section', { sectionId: 'sA', isExpanded: 'no' });
parseFails('update_section', { sectionId: 'sA', title: 3 });

// Delete.
reset();
res = await run('delete_section', { sectionId: 'sB' });
assert.deepEqual(writes(), [{ op: 'delete', sectionId: 'sB' }]);
assert.deepEqual(res.json, { success: true, sectionId: 'sB', deleted: true });
assert.deepEqual(sections.map((s) => s.id), ['sA', 'sT']);
parseFails('delete_section', {});

// Move: end of the section by default (no key in options), the top with afterTaskId null (kept), right
// after a task; the answer holds the target and every section whose task list changed, as SP holds them.
reset();
res = await run('move_task_to_section', { taskId: 't3', sectionId: 'sA' });
assert.equal(res.isError, false);
assert.deepEqual(calls.map((c) => c.op), ['get', 'move', 'get']);
assert.deepEqual(writes(), [{ op: 'move', taskId: 't3', sectionId: 'sA', options: {} }]);
assert.deepEqual(Object.keys(writes()[0].options), []);
assert.deepEqual(taskLists(res.json.sections), [['sA', ['t1', 't2', 't3']], ['sB', []]]);
assert.equal(res.json.taskId, 't3');
assert.equal(res.json.sectionId, 'sA');

reset();
res = await run('move_task_to_section', { taskId: 't2', sectionId: 'sA', afterTaskId: null });
assert.deepEqual(writes(), [{ op: 'move', taskId: 't2', sectionId: 'sA', options: { afterTaskId: null } }]);
assert.deepEqual(taskLists(res.json.sections), [['sA', ['t2', 't1']]]);

reset();
res = await run('move_task_to_section', { taskId: 't3', sectionId: 'sA', afterTaskId: 't1' });
assert.deepEqual(writes(), [{ op: 'move', taskId: 't3', sectionId: 'sA', options: { afterTaskId: 't1' } }]);
assert.deepEqual(taskLists(res.json.sections), [['sA', ['t1', 't3', 't2']], ['sB', []]]);

reset();
res = await run('move_task_to_section', { taskId: 'tX', sectionId: 'sT', afterTaskId: 't5', contextId: 'TODAY' });
assert.deepEqual(writes(), [
  { op: 'move', taskId: 'tX', sectionId: 'sT', options: { afterTaskId: 't5', contextId: 'TODAY' } },
]);
assert.deepEqual(taskLists(res.json.sections), [['sT', ['t5', 'tX']]]);

// Out of a section: sectionId null is sent as null; contextId says which list's section the task leaves.
reset();
res = await run('move_task_to_section', { taskId: 't5', sectionId: null, contextId: 'TODAY' });
assert.deepEqual(writes(), [{ op: 'move', taskId: 't5', sectionId: null, options: { contextId: 'TODAY' } }]);
assert.equal(res.json.sectionId, null);
assert.deepEqual(taskLists(res.json.sections), [['sT', []]]);
reset();
res = await run('move_task_to_section', { taskId: 't1', sectionId: null });
assert.deepEqual(writes(), [{ op: 'move', taskId: 't1', sectionId: null, options: {} }]);
assert.deepEqual(taskLists(res.json.sections), [['sA', ['t2']]]);
reset();
res = await run('move_task_to_section', { taskId: 't2', sectionId: null, afterTaskId: null });
assert.deepEqual(writes(), [{ op: 'move', taskId: 't2', sectionId: null, options: { afterTaskId: null } }]);
reset();
res = await run('move_task_to_section', { taskId: 't9', sectionId: null });
assert.equal(res.isError, false);
assert.deepEqual(res.json.sections, []);
parseFails('move_task_to_section', { taskId: 't1' });
parseFails('move_task_to_section', { taskId: 't1', sectionId: undefined });
parseFails('move_task_to_section', { sectionId: 'sA' });
parseFails('move_task_to_section', { taskId: 't1', sectionId: 5 });
parseFails('move_task_to_section', { taskId: 't1', sectionId: 'sA', afterTaskId: 5 });

// Reorder: the order goes as given; the answer is that context's sections in the order SP now holds.
reset();
res = await run('reorder_sections', { contextId: 'p1', sectionIds: ['sB', 'sA'] });
assert.equal(res.isError, false);
assert.deepEqual(writes(), [{ op: 'reorder', contextId: 'p1', sectionIds: ['sB', 'sA'] }]);
assert.deepEqual(calls.at(-1), { op: 'get', contextId: 'p1' });
assert.equal(res.json.contextId, 'p1');
assert.deepEqual(res.json.sections.map((s) => s.id), ['sB', 'sA']);
parseFails('reorder_sections', { contextId: 'p1' });
parseFails('reorder_sections', { sectionIds: ['sA'] });
parseFails('reorder_sections', { contextId: 'p1', sectionIds: [1, 2] });

// What SP refuses comes back as the API said it, nothing added or cut, and nothing is read back.
for (const [name, input, message] of [
  ['create_section', { title: 'X', contextId: 'tag-1' }, 'Sections exist only for projects and for Today (tag-1 is another tag)'],
  ['update_section', { sectionId: 'sA', title: 'X' }, 'updateSection() can only change title and isExpanded'],
  ['delete_section', { sectionId: 's-gone' }, 'Unknown section: s-gone'],
  [
    'move_task_to_section',
    { taskId: 'sub', sectionId: 'sA' },
    'a project section holds top-level tasks only (sub is a subtask)',
  ],
  [
    'reorder_sections',
    { contextId: 'p1', sectionIds: ['sA'] },
    'reorderSections(): the order must list every section of the context exactly once',
  ],
]) {
  reset();
  failWith = message;
  res = await run(name, input);
  assert.equal(res.isError, true, name);
  assert.equal(res.text, `Error: ${message}`, name);
  assert.notEqual(calls.at(-1).op, 'get', `${name} read back after a refusal`);
}

// A plugin older than 1.0.10 is named, and nothing is sent to it, not even a read.
reset();
const oneOfEach = [
  ['list_sections', {}],
  ['create_section', { title: 'X', contextId: 'p1' }],
  ['update_section', { sectionId: 'sA', title: 'X' }],
  ['delete_section', { sectionId: 'sA' }],
  ['move_task_to_section', { taskId: 't1', sectionId: 'sB' }],
  ['reorder_sections', { contextId: 'p1', sectionIds: ['sB', 'sA'] }],
];
pluginVersion = '1.0.9';
for (const [name, input] of oneOfEach) {
  res = await run(name, input);
  assert.equal(res.isError, true, name);
  assert.match(res.text, /1\.0\.9.*1\.0\.10.*mcp-bridge-plugin\.zip/, name);
}
assert.equal(calls.length, 0);
// Versions compare as numbers: 1.0.2 and 1.0.9 are older than 1.0.10, which a text comparison would deny.
for (const v of ['1.0.2', '1.0.8', '0.9.9']) {
  pluginVersion = v;
  res = await run('list_sections', {});
  assert.equal(res.isError, true, v);
}
assert.equal(calls.length, 0);
// The same version, a newer one, and one the server has not heard from yet are let through.
for (const v of ['1.0.10', '1.0.11', '1.1.0', '2.0.0', null]) {
  pluginVersion = v;
  res = await run('list_sections', {});
  assert.equal(res.isError, false, String(v));
}

// --- Plugin handlers ---------------------------------------------------------------------------

const pluginDir = path.join(root, 'mcp-bridge-plugin');
const pluginSource = fs.readFileSync(path.join(pluginDir, 'plugin-logic.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
const pluginPackage = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));

const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
// A recorded API call as data of this realm, undefined and null kept apart (JSON would turn one into the other).
const seen = (call) => structuredClone(call);

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

// What reaches each API method is recorded as [method, ...arguments].
const apiCalls = [];
const rec =
  (method, impl = () => undefined) =>
  async (...args) => {
    apiCalls.push([method, ...args]);
    return impl(...args);
  };
const listed = [{ id: 's1', contextId: 'p1', contextType: 'PROJECT', title: 'Alpha', isExpanded: true, taskIds: ['t1'] }];
const api = {
  registerHook() {},
  onUnload() {},
  getSections: rec('getSections', () => listed),
  addSection: rec('addSection', (title) => {
    if (title.trim() === '') throw new Error('A section needs a title');
    return 'new-section-id';
  }),
  updateSection: rec('updateSection', (id, changes) => {
    if ('taskIds' in changes) throw new Error('updateSection() can only change title and isExpanded');
  }),
  deleteSection: rec('deleteSection', (id) => {
    if (id === 'gone') throw new Error('Unknown section: gone');
  }),
  reorderSections: rec('reorderSections', (contextId, ids) => {
    if (ids.length < 2) throw new Error('reorderSections(): the order must list every section of the context exactly once');
  }),
  moveTaskToSection: rec('moveTaskToSection', (taskId) => {
    if (taskId === 'sub') throw new Error('a project section holds top-level tasks only (sub is a subtask)');
  }),
};
const plugin = loadPlugin(api);

// The heartbeat carries the version in manifest.json (and package.json says the same), which is what the
// server's check reads; the tools let the plugin of this very tree through.
plugin.handlers.connect();
assert.equal(plugin.emitted.find((e) => e.event === 'event:debug:startup').payload.version, manifest.version);
assert.equal(pluginPackage.version, manifest.version);
reset();
pluginVersion = manifest.version;
res = await run('list_sections', {});
assert.equal(res.isError, false, `the tools refuse the plugin they ship with (${manifest.version})`);

// plugin.js is what SP loads: socket.io.min.js + plugin-logic.js. A stale bundle would run the old handlers.
assert.ok(
  Buffer.concat([fs.readFileSync(path.join(pluginDir, 'socket.io.min.js')), Buffer.from(pluginSource)]).equals(
    fs.readFileSync(path.join(pluginDir, 'plugin.js')),
  ),
  'plugin.js is stale: run `npm run build:plugin` in mcp-bridge-plugin',
);

// The server's socket client emits exactly the events the plugin answers.
const serverSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
const emittedEvents = [...serverSource.matchAll(/emitWithAck\(\s*["'](sections:[A-Za-z]+)["']/g)].map((m) => m[1]).sort();
const handledEvents = Object.keys(plugin.handlers).filter((e) => e.startsWith('sections:')).sort();
assert.deepEqual(handledEvents, [
  'sections:create',
  'sections:delete',
  'sections:get',
  'sections:moveTask',
  'sections:reorder',
  'sections:update',
]);
assert.deepEqual(emittedEvents, handledEvents);

// Get: the list as the API gave it; a context only when given (no argument at all otherwise).
let answer = await plugin.ask('sections:get', undefined);
assert.deepEqual(seen(apiCalls.pop()), ['getSections']);
assert.deepEqual(answer, listed);
for (const payload of [null, {}, { contextId: null }]) {
  await plugin.ask('sections:get', payload);
  assert.deepEqual(seen(apiCalls.pop()), ['getSections'], JSON.stringify(payload));
}
await plugin.ask('sections:get', { contextId: 'p1' });
assert.deepEqual(seen(apiCalls.pop()), ['getSections', 'p1']);
await plugin.ask('sections:get', { contextId: 'TODAY' });
assert.deepEqual(seen(apiCalls.pop()), ['getSections', 'TODAY']);

// Create: the new id as the API gave it; contextType only when given.
answer = await plugin.ask('sections:create', { title: 'Plans', contextId: 'p1' });
assert.deepEqual(seen(apiCalls.pop()), ['addSection', 'Plans', 'p1']);
assert.equal(answer, 'new-section-id');
await plugin.ask('sections:create', { title: 'Focus', contextId: 'TODAY', contextType: 'TAG' });
assert.deepEqual(seen(apiCalls.pop()), ['addSection', 'Focus', 'TODAY', 'TAG']);

// Update: the changes as sent (false survives); none sent is an empty object.
answer = await plugin.ask('sections:update', { sectionId: 's1', changes: { isExpanded: false } });
assert.deepEqual(seen(apiCalls.pop()), ['updateSection', 's1', { isExpanded: false }]);
assert.deepEqual(answer, { success: true });
await plugin.ask('sections:update', { sectionId: 's1', changes: { title: 'Beta', isExpanded: true } });
assert.deepEqual(seen(apiCalls.pop()), ['updateSection', 's1', { title: 'Beta', isExpanded: true }]);
await plugin.ask('sections:update', { sectionId: 's1' });
assert.deepEqual(seen(apiCalls.pop()), ['updateSection', 's1', {}]);

// Delete.
answer = await plugin.ask('sections:delete', { sectionId: 's1' });
assert.deepEqual(seen(apiCalls.pop()), ['deleteSection', 's1']);
assert.deepEqual(answer, { success: true });

// Move: sectionId null and afterTaskId null reach the API as null; no options is an empty object.
answer = await plugin.ask('sections:moveTask', { taskId: 't1', sectionId: 's1' });
assert.deepEqual(seen(apiCalls.pop()), ['moveTaskToSection', 't1', 's1', {}]);
assert.deepEqual(answer, { success: true });
await plugin.ask('sections:moveTask', { taskId: 't1', sectionId: 's1', options: { afterTaskId: null } });
assert.deepEqual(seen(apiCalls.pop()), ['moveTaskToSection', 't1', 's1', { afterTaskId: null }]);
await plugin.ask('sections:moveTask', { taskId: 't1', sectionId: 's1', options: { afterTaskId: 't2' } });
assert.deepEqual(seen(apiCalls.pop()), ['moveTaskToSection', 't1', 's1', { afterTaskId: 't2' }]);
await plugin.ask('sections:moveTask', { taskId: 't1', sectionId: null, options: { contextId: 'TODAY' } });
assert.deepEqual(seen(apiCalls.pop()), ['moveTaskToSection', 't1', null, { contextId: 'TODAY' }]);

// Reorder.
answer = await plugin.ask('sections:reorder', { contextId: 'p1', sectionIds: ['s2', 's1'] });
assert.deepEqual(seen(apiCalls.pop()), ['reorderSections', 'p1', ['s2', 's1']]);
assert.deepEqual(answer, { success: true });

// What the API refuses with comes back as { error } with the message as it was.
for (const [event, data, message] of [
  ['sections:create', { title: ' ', contextId: 'p1' }, 'A section needs a title'],
  ['sections:update', { sectionId: 's1', changes: { taskIds: [] } }, 'updateSection() can only change title and isExpanded'],
  ['sections:delete', { sectionId: 'gone' }, 'Unknown section: gone'],
  ['sections:moveTask', { taskId: 'sub', sectionId: 's1' }, 'a project section holds top-level tasks only (sub is a subtask)'],
  [
    'sections:reorder',
    { contextId: 'p1', sectionIds: ['s1'] },
    'reorderSections(): the order must list every section of the context exactly once',
  ],
]) {
  answer = await plugin.ask(event, data);
  apiCalls.pop();
  assert.deepEqual(answer, { error: message }, event);
}
// A throw before any promise exists, and a rejection that is not an Error, also come back as { error }.
const odd = loadPlugin({ registerHook() {}, onUnload() {}, getSections() { throw new Error('boom'); }, addSection: () => Promise.reject('plain text') });
assert.deepEqual(await odd.ask('sections:get', {}), { error: 'boom' });
assert.deepEqual(await odd.ask('sections:create', { title: 'x', contextId: 'p1' }), { error: 'plain text' });

// A Super Productivity build without the methods says so, naming the feature, instead of throwing in the handler.
const stock = loadPlugin({ registerHook() {}, onUnload() {} });
for (const [event, method] of [
  ['sections:get', 'getSections'],
  ['sections:create', 'addSection'],
  ['sections:update', 'updateSection'],
  ['sections:delete', 'deleteSection'],
  ['sections:moveTask', 'moveTaskToSection'],
  ['sections:reorder', 'reorderSections'],
]) {
  answer = await stock.ask(event, {});
  assert.match(answer.error, new RegExp(`^${method} is not available in this Super Productivity build`), event);
  assert.match(answer.error, /plugin-api-sections/, event);
}
// A build with only some of them answers the ones it has.
const partial = loadPlugin({ registerHook() {}, onUnload() {}, getSections: async () => [] });
assert.deepEqual(await partial.ask('sections:get', {}), []);
assert.match((await partial.ask('sections:create', { title: 'x', contextId: 'p1' })).error, /addSection is not available/);

console.log('sections: ok');
