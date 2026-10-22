import axios, { AxiosInstance } from "axios";

export interface SPClientConfig {
  baseUrl: string;
  apiKey?: string;
}

export class SuperProductivityClient {
  private client: AxiosInstance;

  constructor(config: SPClientConfig) {
    this.client = axios.create({
      baseURL: config.baseUrl,
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
      },
    });
  }

  async getTasks(): Promise<any[]> {
    const response = await this.client.get("/api/tasks");
    return response.data.data;
  }

  async getCurrentContextTasks(): Promise<any[]> {
    const response = await this.client.get("/api/tasks/current");
    return response.data.data;
  }

  async getArchivedTasks(): Promise<any[]> {
    const response = await this.client.get("/api/tasks/archived");
    return response.data.data;
  }

  async createTask(taskData: any): Promise<string> {
    const response = await this.client.post("/api/tasks", taskData);
    return response.data.taskId;
  }

  async updateTask(taskId: string, updates: any): Promise<void> {
    await this.client.patch(`/api/tasks/${taskId}`, updates);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.client.delete(`/api/tasks/${taskId}`);
  }

  async batchUpdate(projectId: string, operations: any[]): Promise<any> {
    const response = await this.client.post("/api/tasks/batch", {
      projectId,
      operations,
    });
    return response.data.data;
  }

  async reorderTasks(taskIds: string[], contextId?: string, contextType?: string): Promise<void> {
    await this.client.post("/api/tasks/reorder", { taskIds, contextId, contextType });
  }

  async getProjects(): Promise<any[]> {
    const response = await this.client.get("/api/projects");
    return response.data.data;
  }

  async createProject(projectData: any): Promise<string> {
    const response = await this.client.post("/api/projects", projectData);
    return response.data.projectId;
  }

  async updateProject(projectId: string, updates: any): Promise<void> {
    await this.client.patch(`/api/projects/${projectId}`, updates);
  }

  async getTags(): Promise<any[]> {
    const response = await this.client.get("/api/tags");
    return response.data.data;
  }

  async createTag(tagData: any): Promise<string> {
    const response = await this.client.post("/api/tags", tagData);
    return response.data.tagId;
  }

  async updateTag(tagId: string, updates: any): Promise<void> {
    await this.client.patch(`/api/tags/${tagId}`, updates);
  }

  async deleteTag(tagId: string): Promise<void> {
    await this.client.delete(`/api/tags/${tagId}`);
  }

  async notify(config: any): Promise<void> {
    await this.client.post("/api/ui/notify", config);
  }

  async showSnack(config: any): Promise<void> {
    await this.client.post("/api/ui/showSnack", config);
  }

  async openDialog(config: any): Promise<any> {
    const response = await this.client.post("/api/ui/openDialog", config);
    const body = response.data;
    return body?.data !== undefined ? body.data : body;
  }

  async getCounters(): Promise<any[]> {
    const response = await this.client.get("/api/counters");
    return response.data.data;
  }

  async getCounter(id: string): Promise<any> {
    const response = await this.client.get(`/api/counters/${id}`);
    return response.data.data;
  }

  async setCounter(id: string, value: number): Promise<void> {
    await this.client.post(`/api/counters/${id}/set`, { value });
  }

  async incrementCounter(id: string, incrementBy?: number): Promise<any> {
    const response = await this.client.post(`/api/counters/${id}/increment`, {
      ...(incrementBy !== undefined && { incrementBy }),
    });
    return response.data.data;
  }

  async decrementCounter(id: string, decrementBy?: number): Promise<any> {
    const response = await this.client.post(`/api/counters/${id}/decrement`, {
      ...(decrementBy !== undefined && { decrementBy }),
    });
    return response.data.data;
  }

  async deleteCounter(id: string): Promise<void> {
    await this.client.delete(`/api/counters/${id}`);
  }

  async getPersistedData(key: string): Promise<any> {
    const response = await this.client.get(`/api/persisted-data/${key}`);
    return response.data.data;
  }

  async savePersistedData(key: string, data: any): Promise<void> {
    await this.client.post(`/api/persisted-data/${key}`, { data });
  }

  async getConfig(): Promise<any> {
    const response = await this.client.get("/api/config");
    return response.data.data;
  }

  async dispatchAction(action: string, payload?: any): Promise<void> {
    await this.client.post("/api/actions/dispatch", { action, payload });
  }

  async focusWindow(): Promise<void> {
    await this.client.post("/api/window/focus");
  }

  // The methods below are served at runtime by the Socket.IO client in
  // index.ts (this axios class is the type contract only). Bodies kept
  // axios-shaped for coherence; they are not exercised.
  async addTagToTask(taskId: string, tagId: string): Promise<any> {
    const response = await this.client.post(`/api/tasks/${taskId}/tags/${tagId}`);
    return response.data.data;
  }

  async removeTagFromTask(taskId: string, tagId: string): Promise<any> {
    const response = await this.client.delete(`/api/tasks/${taskId}/tags/${tagId}`);
    return response.data.data;
  }

  async getTaskRepeatCfgs(): Promise<any[]> {
    const response = await this.client.get("/api/task-repeat-cfgs");
    return response.data.data;
  }

  async addTaskRepeatCfg(
    taskId: string,
    cfg: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.client.post(`/api/tasks/${taskId}/repeat-cfg`, cfg);
    return response.data.data;
  }

  async updateTaskRepeatCfg(
    repeatCfgId: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.client.patch(`/api/task-repeat-cfgs/${repeatCfgId}`, changes);
    return response.data.data;
  }

  async deleteTaskRepeatCfg(repeatCfgId: string): Promise<Record<string, unknown>> {
    const response = await this.client.delete(`/api/task-repeat-cfgs/${repeatCfgId}`);
    return response.data.data;
  }

  getConnectionStatus(): Record<string, unknown> {
    return { connected: false, note: "HTTP client has no socket bridge" };
  }
}
