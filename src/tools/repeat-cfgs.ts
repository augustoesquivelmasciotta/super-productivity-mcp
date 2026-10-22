import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SuperProductivityClient } from '../client/sp-client.js';

// Writes of repeat configs (recurring tasks). The SP fork's plugin API does the
// work (addTaskRepeatCfg / updateTaskRepeatCfg / deleteTaskRepeatCfg, with the
// Repeat dialog's defaults and checks); these tools pass the fields through.
// The plugin handlers arrived in MCP Bridge 1.0.9, so an older plugin is named
// in the error instead of letting the call wait out the socket timeout.

const MIN_PLUGIN_VERSION = '1.0.9';

const QUICK_SETTINGS = [
  'DAILY',
  'WEEKLY_CURRENT_WEEKDAY',
  'MONTHLY_CURRENT_DATE',
  'MONTHLY_FIRST_DAY',
  'MONTHLY_LAST_DAY',
  'MONTHLY_NTH_WEEKDAY',
  'MONDAY_TO_FRIDAY',
  'YEARLY_CURRENT_DATE',
  'CUSTOM',
] as const;

const REMIND_OPTIONS = ['DoNotRemind', 'AtStart', 'm5', 'm10', 'm15', 'm30', 'h1'] as const;

const weekday = (name: string) =>
  z.boolean().optional().describe(`Repeat on ${name} (WEEKLY only)`);

export const repeatCfgFields = {
  title: z.string().optional().describe('Title of the tasks it creates (default: the task title)'),
  notes: z.string().optional().describe('Notes of the tasks it creates (default: the task notes)'),
  tagIds: z.array(z.string()).optional().describe('Tags of the tasks it creates (default: the task tags)'),
  defaultEstimate: z
    .number()
    .min(0)
    .optional()
    .describe('Estimate of the tasks it creates, in milliseconds (default: the task estimate)'),
  isPaused: z.boolean().optional().describe('true pauses the repetition, false resumes it'),
  quickSetting: z
    .enum(QUICK_SETTINGS)
    .optional()
    .describe(
      'A preset schedule, as in the Repeat dialog. Give either this or repeatCycle/repeatEvery/weekdays/monthly anchor, not both. Default on create: DAILY',
    ),
  repeatCycle: z
    .enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
    .optional()
    .describe('Schedule by hand (makes the config CUSTOM); required on create when no quickSetting'),
  repeatEvery: z.number().int().min(1).optional().describe('Every N cycles (default 1)'),
  monday: weekday('Monday'),
  tuesday: weekday('Tuesday'),
  wednesday: weekday('Wednesday'),
  thursday: weekday('Thursday'),
  friday: weekday('Friday'),
  saturday: weekday('Saturday'),
  sunday: weekday('Sunday'),
  monthlyWeekOfMonth: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)])
    .nullable()
    .optional()
    .describe('MONTHLY: with monthlyWeekday, the Nth weekday of the month (-1 = last). null for both = day of month'),
  monthlyWeekday: z
    .number()
    .int()
    .min(0)
    .max(6)
    .nullable()
    .optional()
    .describe('MONTHLY: 0 = Sunday … 6 = Saturday, with monthlyWeekOfMonth'),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD the schedule starts from; sets the weekday or day of month (default: the task day, else today)'),
  startTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable()
    .optional()
    .describe('HH:mm the tasks it creates are scheduled at; null = no time (default on create: the task time, if any)'),
  remindAt: z
    .enum(REMIND_OPTIONS)
    .nullable()
    .optional()
    .describe('Reminder of a timed task (needs startTime); default: the reminder set in SP'),
  shouldInheritSubtasks: z
    .boolean()
    .optional()
    .describe("Give each new task the task's subtasks (default: true when the task has subtasks)"),
  disableAutoUpdateSubtasks: z
    .boolean()
    .optional()
    .describe('Freeze the subtask templates instead of following the latest task'),
  repeatFromCompletionDate: z
    .boolean()
    .optional()
    .describe('Count the next occurrence from the day the last one was done'),
  waitForCompletion: z.boolean().optional().describe('Create the next task only once the last one is done'),
  skipOverdue: z
    .boolean()
    .optional()
    .describe('Skip missed occurrences (default: on only for an every-day schedule)'),
};

const fieldNames = Object.keys(repeatCfgFields) as (keyof typeof repeatCfgFields)[];

// Only the fields the caller gave: undefined keys would read as "set" in the app.
const pickFields = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of fieldNames) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
};

const versionParts = (v: string): number[] => v.split('.').map((n) => parseInt(n, 10) || 0);

const isOlder = (version: string, than: string): boolean => {
  const a = versionParts(version);
  const b = versionParts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
};

/** Throws when the connected plugin is known to predate the repeat-config handlers. */
export function assertPluginCanWriteRepeatCfgs(client: SuperProductivityClient): void {
  const status = client.getConnectionStatus() as { lastStartup?: { version?: unknown } | null };
  const version = status?.lastStartup?.version;
  if (typeof version === 'string' && isOlder(version, MIN_PLUGIN_VERSION)) {
    throw new Error(
      `The MCP Bridge plugin in Super Productivity is ${version}; writing repeat configs needs ${MIN_PLUGIN_VERSION} or later. ` +
        'Install super-productivity-mcp/mcp-bridge-plugin.zip in SP (Settings > Plugins).',
    );
  }
}

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...payload }, null, 2) }],
});

const fail = (error: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
    },
  ],
  isError: true,
});

export function setupRepeatCfgTools(server: McpServer, client: SuperProductivityClient) {
  server.registerTool(
    'create_task_repeat_cfg',
    {
      description:
        "Makes a task repeat, as the task's Repeat dialog in SP does: creates its repeat config and schedules the task on the first occurrence. Unset fields take the dialog's defaults (DAILY; title, notes, tags, estimate, time and day from the task). The config belongs to the task's project. Refused for subtasks and for a task that already repeats (use update_task_repeat_cfg). Returns repeatCfgId and the stored config.",
      inputSchema: {
        taskId: z.string().describe('The task to make repeat (full id)'),
        ...repeatCfgFields,
      },
    },
    async (args) => {
      try {
        assertPluginCanWriteRepeatCfgs(client);
        const result = await client.addTaskRepeatCfg(args.taskId, pickFields(args));
        return ok(result);
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_task_repeat_cfg',
    {
      description:
        'Changes a repeat config; only the fields given change. Pause with isPaused=true, resume with isPaused=false. The open task moves when the schedule changes; title, notes, tags, estimate, start time and reminder apply to the tasks created from then on. Returns the stored config.',
      inputSchema: {
        repeatCfgId: z.string().describe('The repeat config (full id, from get_task_repeat_cfgs or a task repeatCfgId)'),
        ...repeatCfgFields,
      },
    },
    async (args) => {
      try {
        assertPluginCanWriteRepeatCfgs(client);
        const changes = pickFields(args);
        if (Object.keys(changes).length === 0) {
          throw new Error('Nothing to change: give at least one field.');
        }
        const result = await client.updateTaskRepeatCfg(args.repeatCfgId, changes);
        return ok(result);
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'delete_task_repeat_cfg',
    {
      description:
        'Deletes a repeat config. Its tasks stay (open and archived) and stop repeating.',
      inputSchema: {
        repeatCfgId: z.string().describe('The repeat config (full id)'),
      },
    },
    async ({ repeatCfgId }) => {
      try {
        assertPluginCanWriteRepeatCfgs(client);
        const result = await client.deleteTaskRepeatCfg(repeatCfgId);
        return ok(result);
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );
}
