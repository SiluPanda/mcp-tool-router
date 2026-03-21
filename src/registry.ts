import type {
  ServerConfig,
  ServerRegistration,
  ToolDefinition,
  ResourceDefinition,
  PromptDefinition,
  ToolCallHandler,
  UpstreamStatus,
  UpstreamInfo,
  FilterConfig,
  AliasConfig,
} from './types.js';

export interface ServerEntry {
  config: ServerConfig;
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  handler: ToolCallHandler;
  status: UpstreamStatus;
  callCount: number;
  errorCount: number;
  totalLatencyMs: number;
  lastCallAt?: string;
  reconnectAttempts: number;
  filter?: FilterConfig;
  aliases: AliasConfig[];
}

export class ServerRegistry {
  private readonly servers: Map<string, ServerEntry> = new Map();

  /**
   * Register a server with its tools, resources, prompts, and handler.
   */
  registerServer(
    config: ServerConfig,
    tools: ToolDefinition[],
    handler: ToolCallHandler,
    resources: ResourceDefinition[] = [],
    prompts: PromptDefinition[] = [],
  ): void {
    if (this.servers.has(config.name)) {
      throw new Error(`Server "${config.name}" is already registered`);
    }

    this.servers.set(config.name, {
      config,
      tools,
      resources,
      prompts,
      handler,
      status: 'connected',
      callCount: 0,
      errorCount: 0,
      totalLatencyMs: 0,
      reconnectAttempts: 0,
      filter: config.filter,
      aliases: config.aliases ?? [],
    });
  }

  /**
   * Unregister a server and remove all its tools.
   */
  unregisterServer(name: string): boolean {
    return this.servers.delete(name);
  }

  /**
   * Get a server entry by name.
   */
  getServer(name: string): ServerEntry | undefined {
    return this.servers.get(name);
  }

  /**
   * Check if a server is registered.
   */
  hasServer(name: string): boolean {
    return this.servers.has(name);
  }

  /**
   * List all registered servers.
   */
  listServers(): ServerEntry[] {
    return Array.from(this.servers.values());
  }

  /**
   * List server names.
   */
  listServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Update a server's tools list.
   */
  updateTools(name: string, tools: ToolDefinition[]): void {
    const entry = this.servers.get(name);
    if (!entry) {
      throw new Error(`Server "${name}" is not registered`);
    }
    entry.tools = tools;
  }

  /**
   * Update a server's resources list.
   */
  updateResources(name: string, resources: ResourceDefinition[]): void {
    const entry = this.servers.get(name);
    if (!entry) {
      throw new Error(`Server "${name}" is not registered`);
    }
    entry.resources = resources;
  }

  /**
   * Update a server's prompts list.
   */
  updatePrompts(name: string, prompts: PromptDefinition[]): void {
    const entry = this.servers.get(name);
    if (!entry) {
      throw new Error(`Server "${name}" is not registered`);
    }
    entry.prompts = prompts;
  }

  /**
   * Update a server's status.
   */
  updateStatus(name: string, status: UpstreamStatus): void {
    const entry = this.servers.get(name);
    if (entry) {
      entry.status = status;
    }
  }

  /**
   * Record a tool call for metrics.
   */
  recordCall(name: string, durationMs: number, isError: boolean): void {
    const entry = this.servers.get(name);
    if (!entry) return;

    entry.callCount++;
    entry.totalLatencyMs += durationMs;
    entry.lastCallAt = new Date().toISOString();
    if (isError) {
      entry.errorCount++;
    }
  }

  /**
   * Get upstream info for a server.
   */
  getUpstreamInfo(name: string): UpstreamInfo | undefined {
    const entry = this.servers.get(name);
    if (!entry) return undefined;

    return {
      name: entry.config.name,
      status: entry.status,
      toolCount: entry.tools.length,
      resourceCount: entry.resources.length,
      promptCount: entry.prompts.length,
      callCount: entry.callCount,
      errorCount: entry.errorCount,
      avgLatencyMs: entry.callCount > 0 ? entry.totalLatencyMs / entry.callCount : 0,
      lastCallAt: entry.lastCallAt,
      reconnectAttempts: entry.reconnectAttempts,
    };
  }

  /**
   * Get the number of registered servers.
   */
  get size(): number {
    return this.servers.size;
  }

  /**
   * Clear all server registrations.
   */
  clear(): void {
    this.servers.clear();
  }
}
