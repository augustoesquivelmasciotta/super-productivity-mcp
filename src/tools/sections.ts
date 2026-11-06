import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MoveToSectionOptions, SpSection, SuperProductivityClient } from '../client/sp-client.js';

// Sections: the named groups of a project's task list, and of Today. The SP fork's plugin API does the
// work (getSections / addSection / updateSection / deleteSection / reorderSections / moveTaskToSection,
// with the work view's own rules); these tools pass the arguments through and answer with what SP holds
// afterwards, read back with the same read list_sections uses. The API refuses what the work view would
// refuse, with a plain message: nothing here repeats those rules, so the message reaches the caller as it is.
// The plugin handlers arrived in MCP Bridge 1.0.10, so an older plugin is named in the error instead of
// letting the call wait out the socket timeout.

const MIN_PLUGIN_VERSION = '1.0.10';

const versionParts = (v: string): number[] => v.split('.').map((n) => parseInt(n, 10) || 0);

const isOlder = (version: string, than: string): boolean => {
  const a = versionParts(version);
  const b = versionParts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
};

/** Throws when the connected plugin is known to predate the section handlers. */
export function assertPluginHasSections(client: SuperProductivityClient): void {
  const status = client.getConnectionStatus() as { lastStartup?: { version?: unknown } | null };
  const version = status?.lastStartup?.version;
  if (typeof version === 'string' && isOlder(version, MIN_PLUGIN_VERSION)) {
    throw new Error(
      `The MCP Bridge plugin in Super Productivity is ${version}; sections need ${MIN_PLUGIN_VERSION} or later. ` +
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

const asList = (value: unknown): SpSection[] => (Array.isArray(value) ? (value as SpSection[]) : []);

const sameIds = (a: string[] = [], b: string[] = []): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export function setupSectionTools(server: McpServer, client: SuperProductivityClient) {
  server.registerTool(
    'list_sections',
    {
      description:
        "Lists sections (the named groups of a project's task list, and of Today) in the order SP shows them. Each has id, contextId, contextType (PROJECT, or TAG for Today), title, isExpanded and taskIds (the section's stored order). Give contextId for one project or for Today; without it, every section.",
      inputSchema: {
        contextId: z
          .string()
          .optional()
          .describe(
            "A project id (full), or 'TODAY' for the Today tag. Sections exist only for projects and for Today; an unknown id gives an empty list. Omit for every section",
          ),
      },
    },
    async ({ contextId }) => {
      try {
        assertPluginHasSections(client);
        const sections = asList(await client.getSections(contextId));
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ count: sections.length, sections }, null, 2) },
          ],
        };
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'create_section',
    {
      description:
        "Adds a section at the end of a project's sections (or of Today's), expanded and empty, as Add section does in the work view. Sections exist only for projects and for Today. Returns sectionId and the new section.",
      inputSchema: {
        title: z
          .string()
          .describe('Title of the section (trimmed and capped at 200 characters by SP; an empty title is refused)'),
        contextId: z.string().describe("A project id (full), or 'TODAY' for the Today tag"),
        contextType: z
          .enum(['PROJECT', 'TAG'])
          .optional()
          .describe(
            "PROJECT or TAG. Optional: derived from contextId ('TODAY' is the Today tag, any other id a project); if given it must match",
          ),
      },
    },
    async ({ title, contextId, contextType }) => {
      try {
        assertPluginHasSections(client);
        const sectionId = await client.addSection(title, contextId, contextType);
        const sections = asList(await client.getSections(contextId));
        return ok({ sectionId, section: sections.find((s) => s.id === sectionId) ?? null });
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'update_section',
    {
      description:
        'Renames a section and/or collapses or expands it; only the fields given change. Returns the section as SP now holds it.',
      inputSchema: {
        sectionId: z.string().describe('The section (full id, from list_sections)'),
        title: z
          .string()
          .optional()
          .describe('New title (trimmed and capped at 200 characters by SP; an empty title is refused)'),
        isExpanded: z.boolean().optional().describe('false collapses the section, true expands it'),
      },
    },
    async ({ sectionId, title, isExpanded }) => {
      try {
        assertPluginHasSections(client);
        // Only the fields given: a key set to undefined would read as "set" in the app.
        const changes: Record<string, unknown> = {};
        if (title !== undefined) changes.title = title;
        if (isExpanded !== undefined) changes.isExpanded = isExpanded;
        await client.updateSection(sectionId, changes);
        const sections = asList(await client.getSections());
        return ok({ sectionId, section: sections.find((s) => s.id === sectionId) ?? null });
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'delete_section',
    {
      description:
        "Deletes a section, as its menu's Delete does but without the confirmation. Its tasks stay in their list, in no section.",
      inputSchema: {
        sectionId: z.string().describe('The section to delete (full id, from list_sections)'),
      },
    },
    async ({ sectionId }) => {
      try {
        assertPluginHasSections(client);
        await client.deleteSection(sectionId);
        return ok({ sectionId, deleted: true });
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'move_task_to_section',
    {
      description:
        'Files a task into a section, or with sectionId null takes it out of its section. A task goes to the end of the section unless afterTaskId says where. A project section takes top-level tasks of that project that are in its main list (not the backlog); a Today section takes tasks that are in Today, or their subtasks. Returns the sections whose tasks changed, as SP now holds them.',
      inputSchema: {
        taskId: z.string().describe('The task to move (full id)'),
        sectionId: z
          .string()
          .nullable()
          .describe('The section to file the task in (full id), or null to take the task out of its section'),
        afterTaskId: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Where in the section: omit for the end, a task id (full) to go right after that task (which must already be in the section), or null for the top. With sectionId null, the same for the list of tasks in no section',
          ),
        contextId: z
          .string()
          .optional()
          .describe(
            "A project id (full) or 'TODAY'. With sectionId null, which list's section to leave (default: the task's project); with a sectionId it must be that section's context",
          ),
      },
    },
    async ({ taskId, sectionId, afterTaskId, contextId }) => {
      try {
        assertPluginHasSections(client);
        // Only what was given; null is kept (afterTaskId: null means the top of the section).
        const options: MoveToSectionOptions = {};
        if (afterTaskId !== undefined) options.afterTaskId = afterTaskId;
        if (contextId !== undefined) options.contextId = contextId;
        // The sections as they were tell which ones the task leaves; the ones as they are now show the result.
        const before = asList(await client.getSections());
        await client.moveTaskToSection(taskId, sectionId, options);
        const after = asList(await client.getSections());
        const sections = after.filter((s) => {
          if (s.id === sectionId) return true;
          const was = before.find((b) => b.id === s.id);
          return was !== undefined && !sameIds(was.taskIds, s.taskIds);
        });
        return ok({ taskId, sectionId, sections });
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'reorder_sections',
    {
      description:
        "Sets the order of a project's sections (or Today's), as dragging a section header does. sectionIds must be every section of that context, once each, in the new order. Returns the context's sections in the new order.",
      inputSchema: {
        contextId: z.string().describe("A project id (full), or 'TODAY' for the Today tag"),
        sectionIds: z
          .array(z.string())
          .describe('Every section id of the context (full ids, from list_sections), once each, in the new order'),
      },
    },
    async ({ contextId, sectionIds }) => {
      try {
        assertPluginHasSections(client);
        await client.reorderSections(contextId, sectionIds);
        const sections = asList(await client.getSections(contextId));
        return ok({ contextId, sections });
      } catch (error: unknown) {
        return fail(error);
      }
    },
  );
}
