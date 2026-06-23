import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SuperProductivityClient } from "../client/sp-client.js";

export function setupProjectTools(server: McpServer, client: SuperProductivityClient) {
  server.registerTool(
    "list_projects",
    {
      description:
        "Lists Super Productivity projects. Filters are applied client-side on the project list returned by the plugin.",
      inputSchema: {
        includeArchived: z.boolean().optional().default(false).describe("Include archived projects in the list"),
        folderId: z.string().optional().describe("Only projects with this folderId"),
        titleContains: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on project title"),
      },
    },
    async ({ includeArchived, folderId, titleContains }) => {
      try {
        const projects = await client.getProjects();
        let filtered = includeArchived
          ? projects
          : projects.filter((p: Record<string, unknown>) => !p.isArchived);
        if (folderId) {
          filtered = filtered.filter((p: Record<string, unknown>) => p.folderId === folderId);
        }
        if (titleContains) {
          const q = titleContains.toLowerCase();
          filtered = filtered.filter((p: Record<string, unknown>) =>
            String(p.title ?? "").toLowerCase().includes(q),
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: filtered.length,
                  projects: filtered,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "create_project",
    {
      description: "Creates a new project in Super Productivity with optional theme, folder, icon, and backlog settings.",
      inputSchema: {
        title: z.string().describe("Project title"),
        theme: z.record(z.any()).optional().describe("Project theme configuration"),
        isArchived: z.boolean().optional().default(false),
        folderId: z.string().nullable().optional().describe("Folder ID to organize projects"),
        icon: z.string().nullable().optional().describe("Project icon identifier"),
        isEnableBacklog: z.boolean().optional().describe("Enable backlog feature"),
        isHiddenFromMenu: z.boolean().optional().describe("Hide project from sidebar menu"),
      },
    },
    async (params) => {
      try {
        const projectId = await client.createProject(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                projectId,
                message: `Project created: ${params.title}`,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "update_project",
    {
      description: "Updates an existing project (title, theme, archive state, folder, icon, backlog, visibility).",
      inputSchema: {
        projectId: z.string().describe("Project ID to update"),
        title: z.string().optional(),
        theme: z.record(z.any()).optional(),
        isArchived: z.boolean().optional(),
        folderId: z.string().nullable().optional().describe("Folder ID to organize projects"),
        icon: z.string().nullable().optional().describe("Project icon identifier"),
        isEnableBacklog: z.boolean().optional().describe("Enable backlog feature"),
        isHiddenFromMenu: z.boolean().optional().describe("Hide project from sidebar menu"),
        taskIds: z.array(z.string()).optional().describe("Ordered IDs of tasks in the project's main list (today/active area). Pass to reorder or to move tasks between taskIds and backlogTaskIds."),
        backlogTaskIds: z.array(z.string()).optional().describe("Ordered IDs of tasks in the project's backlog list. Requires isEnableBacklog=true to be visible."),
      },
    },
    async ({ projectId, ...updates }) => {
      try {
        await client.updateProject(projectId, updates);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Project updated successfully",
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
