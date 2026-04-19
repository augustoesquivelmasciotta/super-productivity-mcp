import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SuperProductivityClient } from '../client/sp-client.js';
import { batchOperationsArraySchema } from '../batch-operations-schema.js';

const LIST_TASK_FIELDS = [
  'id',
  'title',
  'isDone',
  'timeEstimate',
  'timeSpent',
  'projectId',
  'notes',
  'dueDay',
  'dueWithTime',
  'deadlineDay',
  'deadlineWithTime',
  'remindAt',
  'tagIds',
  'subTaskIds',
  'parentId',
  'created',
  'doneOn',
  'isArchived',
] as const;

function mapTaskForList(t: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const k of LIST_TASK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(t, k) && t[k] !== undefined) {
      o[k] = t[k];
    }
  }
  return o;
}

const CREATE_FIELDS_FROM_SOURCE = [
  'notes',
  'timeEstimate',
  'tagIds',
  'dueDay',
  'dueWithTime',
  'deadlineDay',
  'deadlineWithTime',
  'remindAt',
] as const;

function applyCreateFieldsFromTask(payload: Record<string, unknown>, t: Record<string, unknown>) {
  for (const k of CREATE_FIELDS_FROM_SOURCE) {
    if (Object.prototype.hasOwnProperty.call(t, k) && t[k] !== undefined) {
      payload[k] = t[k];
    }
  }
}

function orderedChildIds(
  parent: Record<string, unknown>,
  pool: Map<string, Record<string, unknown>>,
): string[] {
  const pid = String(parent.id);
  const subIds = parent.subTaskIds;
  if (Array.isArray(subIds) && subIds.length > 0) {
    return subIds
      .map(String)
      .filter((id) => {
        const c = pool.get(id);
        return c && String(c.parentId) === pid;
      });
  }
  return [...pool.values()]
    .filter((c) => String(c.parentId) === pid)
    .sort((a, b) => Number(a.created ?? 0) - Number(b.created ?? 0))
    .map((c) => String(c.id));
}

async function loadTaskPool(
  client: SuperProductivityClient,
  mergeArchived: boolean,
): Promise<Map<string, Record<string, unknown>>> {
  const tasks = await client.getTasks();
  const byId = new Map<string, Record<string, unknown>>();
  for (const x of tasks) {
    if (x?.id) byId.set(String(x.id), x as Record<string, unknown>);
  }
  if (mergeArchived) {
    try {
      const archived = await client.getArchivedTasks();
      for (const x of archived) {
        const id = x?.id != null ? String(x.id) : '';
        if (id && !byId.has(id)) {
          byId.set(id, x as Record<string, unknown>);
        }
      }
    } catch {
      /* getArchivedTasks optional */
    }
  }
  return byId;
}

type DuplicateOpts = {
  projectId?: string;
  titleSuffix: string;
  copyCompletionState: boolean;
  includeSubtasks: boolean;
};

async function duplicateTaskTree(
  client: SuperProductivityClient,
  sourceId: string,
  newParentId: string | undefined,
  pool: Map<string, Record<string, unknown>>,
  opts: DuplicateOpts,
): Promise<{ newId: string; createdIds: string[] }> {
  const src = pool.get(sourceId);
  if (!src) {
    throw new Error(`Task not found: ${sourceId}`);
  }

  let title = String(src.title ?? 'Untitled');
  if (newParentId === undefined && opts.titleSuffix) {
    title += opts.titleSuffix;
  }

  const payload: Record<string, unknown> = { title };
  if (opts.projectId !== undefined) {
    payload.projectId = opts.projectId;
  } else if (src.projectId !== undefined) {
    payload.projectId = src.projectId;
  }
  applyCreateFieldsFromTask(payload, src);
  if (newParentId !== undefined) {
    payload.parentId = newParentId;
  }
  if (opts.copyCompletionState) {
    if (src.isDone !== undefined) payload.isDone = src.isDone;
    if (src.doneOn !== undefined) payload.doneOn = src.doneOn;
  } else {
    payload.isDone = false;
  }

  const newId = await client.createTask(payload);
  const createdIds = [newId];

  if (opts.includeSubtasks) {
    for (const childId of orderedChildIds(src, pool)) {
      const sub = await duplicateTaskTree(client, childId, newId, pool, opts);
      createdIds.push(...sub.createdIds);
    }
  }

  return { newId, createdIds };
}

const scheduleCreateSchema = {
  dueDay: z
    .string()
    .optional()
    .describe(
      'All-day due date YYYY-MM-DD. Prefer either dueDay or dueWithTime, not both for the same semantic slot.',
    ),
  dueWithTime: z
    .number()
    .optional()
    .describe('Due instant as Unix epoch milliseconds.'),
  deadlineDay: z.string().optional().describe('Hard deadline date YYYY-MM-DD (all-day).'),
  deadlineWithTime: z
    .number()
    .optional()
    .describe('Hard deadline as Unix epoch milliseconds.'),
  remindAt: z.number().optional().describe('Reminder instant as Unix epoch milliseconds.'),
};

const nullableStr = z.union([z.string(), z.null()]).optional();
const nullableNum = z.union([z.number(), z.null()]).optional();

export function setupTaskTools(server: McpServer, client: SuperProductivityClient) {
  server.registerTool(
    'list_tasks',
    {
      description: 'Lists tasks with optional filtering by project, archived status, or current context only.',
      inputSchema: {
        projectId: z.string().optional().describe('Filter tasks by project ID'),
        includeArchived: z
          .boolean()
          .default(false)
          .describe(
            'When true, merges in tasks from PluginAPI.getArchivedTasks (requires compatible Super Productivity + bridge).',
          ),
        currentContextOnly: z.boolean().default(false).describe('Only return tasks from the current work context'),
      },
    },
    async ({ projectId, includeArchived, currentContextOnly }) => {
      try {
        let tasks = currentContextOnly
          ? await client.getCurrentContextTasks()
          : await client.getTasks();

        let archivedWarning: string | undefined;
        if (includeArchived) {
          try {
            const archived = await client.getArchivedTasks();
            const byId = new Map<string, Record<string, unknown>>();
            for (const t of tasks) {
              if (t?.id) byId.set(String(t.id), t as Record<string, unknown>);
            }
            for (const a of archived) {
              if (a?.id) byId.set(String(a.id), a as Record<string, unknown>);
            }
            tasks = [...byId.values()] as typeof tasks;
          } catch (e: unknown) {
            archivedWarning =
              e instanceof Error
                ? e.message
                : 'includeArchived failed (getArchivedTasks unavailable or error); returning non-archived set only.';
          }
        }

        let filteredTasks = tasks;
        if (projectId) {
          filteredTasks = tasks.filter((t) => t.projectId === projectId);
        }

        const output = {
          count: filteredTasks.length,
          ...(archivedWarning ? { warning: archivedWarning } : {}),
          tasks: filteredTasks.map((t) => mapTaskForList(t as Record<string, unknown>)),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'create_task',
    {
      description: 'Creates a new task in Super Productivity with optional scheduling, project assignment, and tags.',
      inputSchema: {
        title: z.string().describe('Task title'),
        projectId: z.string().optional().describe('Project ID to add task to'),
        notes: z.string().optional().describe('Task notes/description'),
        timeEstimate: z.number().optional().describe('Time estimate in milliseconds'),
        tagIds: z.array(z.string()).optional().describe('Array of tag IDs'),
        parentId: z.string().optional().describe('Parent task ID for subtasks'),
        isDone: z.boolean().optional().describe('Whether the task is already completed'),
        ...scheduleCreateSchema,
      },
    },
    async (params) => {
      try {
        // SP's api.addTask() silently ignores tagIds, dueWithTime and remindAt.
        // Strip them here and apply via a separate updateTask call after creation,
        // which goes through its own socket round-trip and persists correctly.
        const payload: Record<string, unknown> = { title: params.title };
        if (params.projectId !== undefined) payload.projectId = params.projectId;
        if (params.notes !== undefined) payload.notes = params.notes;
        if (params.timeEstimate !== undefined) payload.timeEstimate = params.timeEstimate;
        if (params.parentId !== undefined) payload.parentId = params.parentId;
        if (params.isDone !== undefined) payload.isDone = params.isDone;
        if (params.dueDay !== undefined) payload.dueDay = params.dueDay;
        if (params.deadlineDay !== undefined) payload.deadlineDay = params.deadlineDay;
        if (params.deadlineWithTime !== undefined) payload.deadlineWithTime = params.deadlineWithTime;

        const postCreateUpdates: Record<string, unknown> = {};
        if (params.tagIds !== undefined) postCreateUpdates.tagIds = params.tagIds;
        if (params.dueWithTime !== undefined) postCreateUpdates.dueWithTime = params.dueWithTime;
        if (params.remindAt !== undefined) postCreateUpdates.remindAt = params.remindAt;

        const taskId = await client.createTask(payload);

        if (Object.keys(postCreateUpdates).length > 0) {
          await client.updateTask(taskId, postCreateUpdates);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                taskId,
                message: `Task created: ${params.title}`,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'duplicate_task',
    {
      description:
        'Creates a copy of an existing task (new id). Optionally duplicates nested subtasks in order. Root copy gets titleSuffix appended; subtasks keep original titles.',
      inputSchema: {
        taskId: z.string().describe('ID of the task to duplicate'),
        includeSubtasks: z
          .boolean()
          .default(false)
          .describe('When true, recursively duplicates direct children (same tree shape under the new root).'),
        titleSuffix: z
          .string()
          .default('')
          .describe('Appended to the root task title only; use empty string for no suffix.'),
        projectId: z
          .string()
          .optional()
          .describe('If set, assigns the duplicate (and subtree) to this project instead of the source project.'),
        searchArchived: z
          .boolean()
          .default(false)
          .describe(
            'When true, merges archived tasks into lookup so you can duplicate an archived task by id.',
          ),
        copyCompletionState: z
          .boolean()
          .default(false)
          .describe('When true, copies isDone and doneOn; default is new open tasks (isDone false).'),
      },
    },
    async ({
      taskId,
      includeSubtasks,
      titleSuffix,
      projectId,
      searchArchived,
      copyCompletionState,
    }) => {
      try {
        const pool = await loadTaskPool(client, searchArchived);
        if (!pool.has(taskId)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `Task not found: ${taskId}. Try searchArchived: true if it is archived.`,
                }),
              },
            ],
            isError: true,
          };
        }

        const { newId, createdIds } = await duplicateTaskTree(client, taskId, undefined, pool, {
          projectId,
          titleSuffix,
          copyCompletionState,
          includeSubtasks,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                taskId: newId,
                duplicatedCount: createdIds.length,
                duplicatedTaskIds: createdIds,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'update_task',
    {
      description: 'Updates an existing task. Use null to clear optional fields where supported.',
      inputSchema: {
        taskId: z.string().describe('Task ID to update'),
        title: z.string().optional().describe('New task title'),
        notes: z.string().optional().describe('New task notes/description'),
        timeEstimate: nullableNum.describe('Ms estimate; null clears if the app supports it'),
        isDone: z.boolean().optional().describe('Mark task as done or undone'),
        projectId: z.string().optional().describe('Move task to a different project'),
        tagIds: z.union([z.array(z.string()), z.null()]).optional().describe('Tag IDs; null removes all tags'),
        parentId: nullableStr.describe('Parent task ID; null removes parent (makes it a top-level task)'),
        dueDay: nullableStr.describe('YYYY-MM-DD or null to clear'),
        dueWithTime: nullableNum.describe('Unix epoch ms or null to clear'),
        deadlineDay: nullableStr.describe('YYYY-MM-DD or null to clear'),
        deadlineWithTime: nullableNum.describe('Unix epoch ms or null to clear'),
        remindAt: nullableNum.describe('Unix epoch ms or null to clear'),
        plannedAt: nullableNum.describe('Unix epoch ms when task is planned; null clears (removes from Today)'),
        timeSpent: nullableNum.describe('Total time spent in ms; null clears'),
        doneOn: nullableNum.describe('Timestamp when task was completed; null clears'),
        subTaskIds: z.union([z.array(z.string()), z.null()]).optional().describe('Array of subtask IDs'),
        repeatCfgId: nullableStr.describe('Repeat configuration ID; null clears'),
        issueId: nullableStr.describe('Linked issue ID; null clears'),
        issueProviderId: nullableStr.describe('Issue provider ID; null clears'),
        issuePoints: nullableNum.describe('Story points for linked issue; null clears'),
      },
    },
    async ({ taskId, ...raw }) => {
      try {
        const updates: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (v !== undefined) updates[k] = v;
        }
        await client.updateTask(taskId, updates);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Task updated successfully',
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'complete_task',
    {
      description: 'Marks a task as complete. Optionally archives it.',
      inputSchema: {
        taskId: z.string().describe('Task ID to complete'),
        archive: z.boolean().optional().default(false).describe('Also archive the task after completion'),
      },
    },
    async ({ taskId, archive }) => {
      try {
        const updates: Record<string, unknown> = { isDone: true };
        if (archive) {
          updates.isArchived = true;
        }
        await client.updateTask(taskId, updates);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: archive ? 'Task completed and archived' : 'Task marked as complete',
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'delete_task',
    {
      description: '⚠️ Permanently deletes a task. This action cannot be undone.',
      inputSchema: {
        taskId: z.string().describe('Task ID to delete permanently'),
      },
    },
    async ({ taskId }) => {
      try {
        await client.deleteTask(taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, message: 'Task deleted' }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'batch_update_tasks',
    {
      description:
        'Batch task operations for one project. Operations are validated with a discriminated union (create requires tempId+data.title; update requires taskId+updates; delete requires taskId; reorder requires non-empty taskIds). Extra keys on create.data / update.updates are forwarded (passthrough) for app-specific fields.',
      inputSchema: {
        projectId: z.string().describe('Project ID for batch operations'),
        operations: batchOperationsArraySchema,
      },
    },
    async ({ projectId, operations }) => {
      try {
        const result = await client.batchUpdate(projectId, operations as unknown[]);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'reorder_tasks',
    {
      description: 'Reorders tasks within a project or tag. Calls PluginAPI.reorderTasks(taskIds, contextId, contextType).',
      inputSchema: {
        taskIds: z.array(z.string()).describe('Ordered array of task IDs in the desired sequence'),
        contextId: z.string().optional().describe('Project ID or tag ID where tasks belong. Defaults to inbox if omitted.'),
        contextType: z.enum(['project', 'tag']).optional().default('project').describe('Type of context (project or tag)'),
      },
    },
    async ({ taskIds, contextId, contextType }) => {
      try {
        await client.reorderTasks(taskIds, contextId, contextType);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Reordered ${taskIds.length} tasks`,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
