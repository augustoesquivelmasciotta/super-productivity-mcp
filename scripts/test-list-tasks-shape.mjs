// Checks list_tasks' default task shape against a fake client: a recurring task shows its
// repeatCfgId (the link a read-back of a repeat config needs), a task that does not repeat has no
// such key, and `fields` still returns only the keys asked for. Run after `npm run build`:
//   node scripts/test-list-tasks-shape.mjs [distDir]
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '..', 'dist'));
const { setupTaskTools } = await import(pathToFileURL(path.join(dist, 'tools', 'tasks.js')).href);
const { z } = await import('zod');

const tools = {};
const server = { registerTool: (name, def, handler) => (tools[name] = { def, handler }) };
const tasks = [
  {
    id: 'rep',
    title: 'Reposición despensa',
    isDone: false,
    projectId: 'p',
    tagIds: [],
    subTaskIds: [],
    created: 1,
    dueDay: '2026-10-22',
    repeatCfgId: 'cfg-1',
  },
  { id: 'one', title: 'One-off', isDone: false, projectId: 'p', tagIds: [], subTaskIds: [], created: 2 },
];
const client = {
  getTasks: async () => tasks,
  getCurrentContextTasks: async () => tasks,
  getArchivedTasks: async () => [],
};
setupTaskTools(server, client);

const list = async (input) => {
  const parsed = z.object(tools.list_tasks.def.inputSchema).parse(input);
  const res = await tools.list_tasks.handler(parsed);
  assert.ok(!res.isError, res.content[0].text);
  return JSON.parse(res.content[0].text).tasks;
};

let out = await list({});
assert.equal(
  out.find((t) => t.id === 'rep').repeatCfgId,
  'cfg-1',
  'a recurring task shows its repeatCfgId in the default shape',
);
assert.ok(!('repeatCfgId' in out.find((t) => t.id === 'one')), 'a task that does not repeat has no repeatCfgId key');

out = await list({ recurringOnly: true });
assert.deepEqual(
  out.map((t) => [t.id, t.repeatCfgId]),
  [['rep', 'cfg-1']],
);

out = await list({ fields: ['id', 'title'] });
assert.deepEqual(
  out,
  [
    { id: 'rep', title: 'Reposición despensa' },
    { id: 'one', title: 'One-off' },
  ],
  '`fields` still returns only the keys asked for',
);

console.log('list_tasks default shape: ok');
