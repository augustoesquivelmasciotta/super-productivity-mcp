#!/usr/bin/env node

import { Command } from 'commander';
import figlet from 'figlet';
import chalk from 'chalk';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { io as socketIOClient } from "socket.io-client";
import { randomUUID } from "crypto";
import { setupTaskTools } from "./tools/tasks.js";
import { setupProjectTools } from "./tools/projects.js";
import { setupSmartActions } from "./tools/smart-actions.js";
import { setupUITools } from "./tools/ui.js";
import { setupTagTools } from "./tools/tags.js";
import { setupCounterTools } from "./tools/counters.js";
import { setupDataTools } from "./tools/data.js";
import { setupMiscTools } from "./tools/misc.js";
import { UnscheduleMirror } from "./listeners/unschedule-mirror.js";

function tsLog(...parts: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

function oneLine(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class SocketSuperProductivityClient {
    private socket: Socket | null = null;
  
    setSocket(socket: Socket) {
      this.socket = socket;
    }
  
    private async emitWithAck<T>(event: string, data?: any): Promise<T> {
      if (!this.socket) {
        throw new Error(
          "Super Productivity plugin is not connected. Ensure the MCP Bridge plugin is installed and enabled.",
        );
      }
  
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Timeout waiting for plugin response for event ${event}`,
            ),
          );
        }, 10000);
  
        this.socket!.emit(event, data, (response: any) => {
          clearTimeout(timeout);
          if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });
    }
  
    async getTasks(): Promise<any[]> {
      return this.emitWithAck("tasks:get");
    }
  
    async getCurrentContextTasks(): Promise<any[]> {
      return this.emitWithAck("tasks:getCurrent");
    }

    async getArchivedTasks(): Promise<any[]> {
      return this.emitWithAck("tasks:getArchived");
    }
  
    async createTask(taskData: any): Promise<string> {
      return this.emitWithAck("tasks:create", taskData);
    }
  
    async updateTask(taskId: string, updates: any): Promise<void> {
      return this.emitWithAck("tasks:update", { taskId, updates });
    }
  
    async deleteTask(taskId: string): Promise<void> {
      return this.emitWithAck("tasks:delete", { taskId });
    }
  
    async batchUpdate(projectId: string, operations: any[]): Promise<any> {
      return this.emitWithAck("tasks:batch", { projectId, operations });
    }

    async reorderTasks(
      taskIds: string[],
      contextId?: string,
      contextType?: string,
    ): Promise<void> {
      return this.emitWithAck("tasks:reorder", { taskIds, contextId, contextType });
    }
  
    async getProjects(): Promise<any[]> {
      return this.emitWithAck("projects:get");
    }
  
    async createProject(projectData: any): Promise<string> {
      return this.emitWithAck("projects:create", projectData);
    }

    async updateProject(projectId: string, updates: any): Promise<void> {
      return this.emitWithAck("projects:update", { projectId, updates });
    }
  
    async getTags(): Promise<any[]> {
      return this.emitWithAck("tags:get");
    }
  
    async createTag(tagData: any): Promise<string> {
      return this.emitWithAck("tags:create", tagData);
    }
  
    async updateTag(tagId: string, updates: any): Promise<void> {
      return this.emitWithAck("tags:update", { tagId, updates });
    }
  
    async notify(config: any): Promise<void> {
      return this.emitWithAck("ui:notify", config);
    }
  
    async showSnack(config: any): Promise<void> {
      return this.emitWithAck("ui:showSnack", config);
    }
  
    async openDialog(config: any): Promise<any> {
      return this.emitWithAck("ui:openDialog", config);
    }

    async deleteTag(tagId: string): Promise<void> {
      return this.emitWithAck("tags:delete", { tagId });
    }

    async getCounters(): Promise<any[]> {
      return this.emitWithAck("counters:get");
    }

    async getCounter(id: string): Promise<any> {
      return this.emitWithAck("counter:get", { id });
    }

    async setCounter(id: string, value: number): Promise<void> {
      return this.emitWithAck("counter:set", { id, value });
    }

    async incrementCounter(id: string, incrementBy?: number): Promise<any> {
      return this.emitWithAck("counter:increment", {
        id,
        ...(incrementBy !== undefined && { incrementBy }),
      });
    }

    async decrementCounter(id: string, decrementBy?: number): Promise<any> {
      return this.emitWithAck("counter:decrement", {
        id,
        ...(decrementBy !== undefined && { decrementBy }),
      });
    }

    async deleteCounter(id: string): Promise<void> {
      return this.emitWithAck("counter:delete", { id });
    }

    async getPersistedData(key: string): Promise<any> {
      return this.emitWithAck("persisted-data:load", { key });
    }

    async savePersistedData(key: string, data: any): Promise<void> {
      return this.emitWithAck("persisted-data:save", { key, data });
    }

    async getConfig(): Promise<any> {
      return this.emitWithAck("config:get");
    }

    async dispatchAction(action: string, payload?: any): Promise<void> {
      return this.emitWithAck("actions:dispatch", { action, payload });
    }

    async focusWindow(): Promise<void> {
      return this.emitWithAck("window:focus");
    }
  }

const program = new Command();
const spClient = new SocketSuperProductivityClient() as any;

program
  .version('1.0.0')
  .description('Super Productivity MCP CLI');

program
  .command('start')
  .description('Start the Super Productivity MCP Server')
  .action(() => {
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.MCP_HOST?.trim() || '127.0.0.1';
    const app = express();
    const httpServer = createServer(app);
    const pingTimeout = parseInt(process.env.SOCKET_IO_PING_TIMEOUT_MS || "120000", 10);
    const pingInterval = parseInt(process.env.SOCKET_IO_PING_INTERVAL_MS || "25000", 10);
    const io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
      pingTimeout,
      pingInterval,
      connectTimeout: parseInt(process.env.SOCKET_IO_CONNECT_TIMEOUT_MS || "120000", 10),
    });

    app.use(express.json());

    const unscheduleMirror = new UnscheduleMirror(spClient);

    io.engine.on("connection_error", (err) => {
      tsLog(
        "Socket.IO engine connection error:",
        `code=${err.code}`,
        `message=${oneLine(err.message)}`,
        `transport=${err.context?.transport ?? "unknown"}`,
        `url=${err.req?.url ?? "unknown"}`,
      );
    });

    io.on("connection", (socket) => {
      const transport = socket.conn?.transport?.name ?? "unknown";
      const remoteAddress =
        socket.handshake.address || socket.conn.remoteAddress || "unknown";
      const userAgent = oneLine(socket.handshake.headers["user-agent"]);
      tsLog(
        "Super Productivity plugin connected:",
        socket.id,
        `transport=${transport}`,
        `remote=${remoteAddress}`,
        `userAgent=${userAgent || "unknown"}`,
      );
      spClient.setSocket(socket);

      // Seed the unschedule mirror cache so we don't fire on tasks that were
      // already unscheduled before the connection opened. Don't await — let it
      // run in background so socket setup doesn't block.
      unscheduleMirror.seed().catch(() => {});

      socket.on("event:taskUpdate", (payload: unknown) => {
        unscheduleMirror.handleEvent(payload).catch((err) => {
          tsLog("unschedule mirror handler error:", oneLine(err));
        });
      });

      // Cache-only handlers. These don't trigger mirror writes — they keep
      // the listener's `{taskId → scheduled state}` cache fresh so that
      // transitions on freshly-created/deleted/drag-to-Today'd tasks are
      // detected correctly when the next taskUpdate arrives.
      socket.on("event:taskCreated", (payload: unknown) => {
        try { unscheduleMirror.handleTaskCreated(payload); }
        catch (err) { tsLog("taskCreated handler error:", oneLine(err)); }
      });
      socket.on("event:taskDelete", (payload: unknown) => {
        try { unscheduleMirror.handleTaskDelete(payload); }
        catch (err) { tsLog("taskDelete handler error:", oneLine(err)); }
      });
      socket.on("event:taskScheduled", (payload: unknown) => {
        try { unscheduleMirror.handleTaskScheduledForToday(payload); }
        catch (err) { tsLog("taskScheduled handler error:", oneLine(err)); }
      });

      // Heartbeat events: always logged. They're cheap (one per connect/setup)
      // and tell us at a glance which plugin code is running.
      socket.on("event:debug:startup", (payload: unknown) => {
        tsLog(`[plugin-heartbeat] startup ${oneLine(payload)}`);
      });
      socket.on("event:debug:hooksRegistered", (payload: unknown) => {
        tsLog(`[plugin-heartbeat] hooks registered ${oneLine(payload)}`);
      });

      // Verbose tracing: every event (including hook payloads) gets logged.
      // Off by default. Toggle SP_MCP_DEBUG_EVENTS=1 in the launchd plist
      // when diagnosing why a hook didn't fire / a transition was missed.
      if (process.env.SP_MCP_DEBUG_EVENTS === "1") {
        socket.onAny((eventName: string, ...args: unknown[]) => {
          const preview = JSON.stringify(args).slice(0, 250);
          tsLog(`[any-event] name=${eventName} args=${preview}`);
        });
      }

      socket.conn?.once("upgrade", () => {
        tsLog(
          "Super Productivity plugin transport upgraded:",
          socket.id,
          `transport=${socket.conn?.transport?.name ?? "unknown"}`,
        );
      });

      socket.conn?.on("close", (reason: string) => {
        tsLog(
          "Super Productivity engine transport closed:",
          socket.id,
          `reason=${reason}`,
          `transport=${socket.conn?.transport?.name ?? "unknown"}`,
        );
      });

      socket.conn?.on("error", (err: unknown) => {
        tsLog(
          "Super Productivity engine transport error:",
          socket.id,
          oneLine(err),
        );
      });

      socket.on("error", (err: Error) => {
        tsLog(
          "Super Productivity socket error:",
          socket.id,
          `message=${oneLine(err.message)}`,
        );
      });

      socket.on("disconnect", (reason: string, description?: unknown) => {
        const detail =
          description !== undefined && description !== null
            ? ` detail=${String(description)}`
            : "";
        tsLog(
          "Super Productivity plugin disconnected:",
          socket.id,
          `reason=${reason}${detail}`,
        );
        if (spClient.socket?.id === socket.id) {
          spClient.setSocket(null);
        }
      });
    });

    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            tsLog(`MCP session initialized: ${sid}`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            tsLog(
              `MCP session closed: ${transport.sessionId} reason=DELETE /mcp (client ended Streamable HTTP session)`,
            );
            delete transports[transport.sessionId];
          }
        };

        const server = new McpServer({
          name: "super-productivity",
          version: "1.0.0",
        });

        setupTaskTools(server, spClient);
        setupProjectTools(server, spClient);
        setupSmartActions(server, spClient);
        setupUITools(server, spClient);
        setupTagTools(server, spClient);
        setupCounterTools(server, spClient);
        setupDataTools(server, spClient);
        setupMiscTools(server, spClient);

        await server.connect(transport);
      } else {
        return res.status(400).json({
          error: { message: "Bad Request: No valid session ID" },
        });
      }

      await transport.handleRequest(req, res, req.body);
    });

    const handleSessionRequest = async (
      req: express.Request,
      res: express.Response,
    ) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        return res.status(404).send("Session not found");
      }
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    };

    app.get("/mcp", handleSessionRequest);
    app.delete("/mcp", handleSessionRequest);

    httpServer.listen(port, host, () => {
      figlet.text('SUPER PRODUCTIVITY MCP', {
        font: 'Standard',
        horizontalLayout: 'default',
        verticalLayout: 'default',
        width: 80,
        whitespaceBreak: true
      }, function(err, data) {
        if (err) {
          console.log('Something went wrong...');
          console.dir(err);
          return;
        }
        console.log(chalk.blue(data));
        const base = host === '0.0.0.0' ? 'all interfaces' : host;
        tsLog(
          chalk.green(
            `Super Productivity MCP: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/mcp (bind ${base})`,
          ),
        );
      });
    });
  });

program
  .command('connect')
  .description('Connect to the Super Productivity plugin')
  .action(() => {
    const socket = socketIOClient("http://localhost:1044");
    spClient.setSocket(socket);
    console.log('Connecting to Super Productivity plugin...');
    socket.on('connect', () => {
      console.log(chalk.green('Connected to Super Productivity plugin.'));
    });
    socket.on('disconnect', (reason: string) => {
      console.log(
        chalk.red(`Disconnected from Super Productivity plugin. reason=${reason}`),
      );
    });
  });

program
  .command('projects')
  .description('List all projects')
  .action(async () => {
    try {
      const projects = await spClient.getProjects();
      console.log(chalk.blue('Projects:'));
      console.log(projects);
    } catch (error: any) {
      console.error(chalk.red(error.message));
    }
  });

program
  .command('tasks')
  .description('List all tasks')
  .action(async () => {
    try {
      const tasks = await spClient.getTasks();
      console.log(chalk.blue('Tasks:'));
      console.log(tasks);
    } catch (error: any) {
      console.error(chalk.red(error.message));
    }
  });

program
  .command('tags')
  .description('List all tags')
  .action(async () => {
    try {
      const tags = await spClient.getTags();
      console.log(chalk.blue('Tags:'));
      console.log(tags);
    } catch (error: any) {
      console.error(chalk.red(error.message));
    }
  });

program.parse(process.argv);

