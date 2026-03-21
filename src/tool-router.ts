import { EventEmitter } from 'node:events';
import type {
  RouterOptions,
  ServerConfig,
  ToolDefinition,
  ResourceDefinition,
  PromptDefinition,
  ToolCallRequest,
  ToolCallResponse,
  ToolCallHandler,
  ToolCallEvent,
  UpstreamEvent,
  UpstreamInfo,
  RouterMetrics,
  RouteEntry,
  ConflictResolution,
  MiddlewareFn,
  FilterConfig,
  AliasConfig,
} from './types.js';
import { NamespaceManager } from './namespace.js';
import { ServerRegistry } from './registry.js';
import { RequestRouter } from './router.js';

/**
 * Fluent builder for configuring a single upstream server.
 */
export class UpstreamBuilder {
  private readonly router: ToolRouter;
  private readonly serverName: string;

  constructor(router: ToolRouter, serverName: string) {
    this.router = router;
    this.serverName = serverName;
  }

  /**
   * Set the namespace prefix for this upstream's tools.
   * Pass null to disable namespacing.
   */
  namespace(prefix: string | null): UpstreamBuilder {
    this.router._setServerPrefix(this.serverName, prefix);
    return this;
  }

  /**
   * Set include/exclude filters for this upstream's tools.
   */
  filter(config: FilterConfig): UpstreamBuilder {
    this.router._setServerFilter(this.serverName, config);
    return this;
  }

  /**
   * Convenience: exclude specific tools by name.
   */
  exclude(toolNames: string[]): UpstreamBuilder {
    return this.filter({ exclude: toolNames });
  }

  /**
   * Convenience: include only specific tools by name or glob pattern.
   */
  include(patterns: string[]): UpstreamBuilder {
    return this.filter({ include: patterns });
  }

  /**
   * Register a tool alias for this upstream.
   */
  alias(from: string, to: string): UpstreamBuilder {
    this.router._addServerAlias(this.serverName, from, to);
    return this;
  }

  /**
   * Register middleware specific to this upstream.
   */
  use(middleware: MiddlewareFn): UpstreamBuilder {
    this.router._addServerMiddleware(this.serverName, middleware);
    return this;
  }
}

/**
 * ToolRouter is the main class that aggregates tools from multiple
 * upstream servers into a unified namespace.
 */
export class ToolRouter extends EventEmitter {
  private readonly options: Required<Pick<RouterOptions, 'name' | 'version' | 'separator' | 'conflictResolution' | 'healthCheck'>>;
  private readonly namespaceManager: NamespaceManager;
  private readonly serverRegistry: ServerRegistry;
  private readonly requestRouter: RequestRouter;
  private readonly startTime: number;
  private started = false;

  // Pending configurations from builders, applied before route table build
  private readonly pendingPrefixes: Map<string, string | null> = new Map();
  private readonly pendingFilters: Map<string, FilterConfig> = new Map();

  constructor(options: RouterOptions = {}) {
    super();
    this.options = {
      name: options.name ?? 'mcp-tool-router',
      version: options.version ?? '1.0.0',
      separator: options.separator ?? '/',
      conflictResolution: options.conflictResolution ?? 'prefix',
      healthCheck: options.healthCheck ?? false,
    };

    this.namespaceManager = new NamespaceManager(
      this.options.separator,
      this.options.conflictResolution,
    );
    this.serverRegistry = new ServerRegistry();
    this.requestRouter = new RequestRouter(this.namespaceManager, this.serverRegistry);
    this.startTime = Date.now();
  }

  /**
   * Register an upstream MCP server with its tools and handler.
   * Returns an UpstreamBuilder for further configuration.
   */
  addServer(
    name: string,
    config: Omit<ServerConfig, 'name'> & { tools?: ToolDefinition[]; handler?: ToolCallHandler },
  ): UpstreamBuilder {
    const serverConfig: ServerConfig = {
      ...config,
      name,
    };

    const tools = config.tools ?? [];
    const handler = config.handler ?? (async () => ({
      content: [{ type: 'text' as const, text: 'No handler configured' }],
      isError: true,
    }));

    this.serverRegistry.registerServer(serverConfig, tools, handler);
    this.emit('serverConnected', { name });

    // Rebuild route table when a server is added
    this.rebuildRouteTable();

    return new UpstreamBuilder(this, name);
  }

  /**
   * Remove an upstream server.
   */
  removeServer(name: string): boolean {
    const removed = this.serverRegistry.unregisterServer(name);
    if (removed) {
      this.emit('serverDisconnected', { name });
      this.rebuildRouteTable();
    }
    return removed;
  }

  /**
   * Update the tools for a registered server.
   */
  updateServerTools(name: string, tools: ToolDefinition[]): void {
    this.serverRegistry.updateTools(name, tools);
    this.rebuildRouteTable();
  }

  /**
   * Call a tool by its qualified (namespaced) name.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResponse> {
    const request: ToolCallRequest = { name, arguments: args };
    const startTime = Date.now();

    const response = await this.requestRouter.route(request);

    const entry = this.requestRouter.lookup(name);
    const durationMs = Date.now() - startTime;

    const event: ToolCallEvent = {
      timestamp: new Date().toISOString(),
      tool: name,
      upstream: entry?.upstreamName ?? 'unknown',
      durationMs,
      isError: !!response.isError,
      errorMessage: response.isError
        ? response.content.find((c) => c.type === 'text')?.text
        : undefined,
    };
    this.emit('toolCall', event);

    return response;
  }

  /**
   * List all available tools with their namespaced names.
   */
  listTools(): Array<ToolDefinition & { namespacedName: string; upstream: string }> {
    return this.requestRouter.listRoutes().map((entry) => ({
      ...entry.toolDefinition,
      namespacedName: entry.namespacedName,
      upstream: entry.upstreamName,
    }));
  }

  /**
   * List all registered servers with their status.
   */
  listServers(): UpstreamInfo[] {
    return this.serverRegistry.listServerNames()
      .map((name) => this.serverRegistry.getUpstreamInfo(name))
      .filter((info): info is UpstreamInfo => info !== undefined);
  }

  /**
   * Get the current tool list.
   */
  get tools(): ReadonlyArray<ToolDefinition & { namespacedName: string; upstream: string }> {
    return this.listTools();
  }

  /**
   * Get the current upstream info.
   */
  get upstreams(): ReadonlyArray<UpstreamInfo> {
    return this.listServers();
  }

  /**
   * Get router metrics.
   */
  get metrics(): RouterMetrics {
    const upstreams: Record<string, UpstreamInfo> = {};
    for (const name of this.serverRegistry.listServerNames()) {
      const info = this.serverRegistry.getUpstreamInfo(name);
      if (info) {
        upstreams[name] = info;
      }
    }

    const routes = this.requestRouter.listRoutes();

    return {
      totalCalls: Object.values(upstreams).reduce((sum, u) => sum + u.callCount, 0),
      totalErrors: Object.values(upstreams).reduce((sum, u) => sum + u.errorCount, 0),
      totalTools: routes.length,
      totalResources: 0,
      totalPrompts: 0,
      upstreams,
      uptimeMs: Date.now() - this.startTime,
    };
  }

  /**
   * Register a global middleware function for all tool calls.
   */
  use(middleware: MiddlewareFn): ToolRouter {
    this.requestRouter.addMiddleware(middleware);
    return this;
  }

  /**
   * Register a tool alias at the router level.
   */
  alias(from: string, to: string): ToolRouter {
    this.requestRouter.addAlias(from, to);
    this.rebuildRouteTable();
    return this;
  }

  /**
   * Start the router.
   */
  async start(): Promise<void> {
    this.started = true;
    this.rebuildRouteTable();
  }

  /**
   * Stop the router.
   */
  async stop(): Promise<void> {
    this.started = false;
    this.serverRegistry.clear();
    this.namespaceManager.clear();
    this.requestRouter.buildRouteTable();
  }

  /**
   * Get the route table size.
   */
  get routeCount(): number {
    return this.requestRouter.size;
  }

  /**
   * Get the namespace separator.
   */
  get separator(): string {
    return this.options.separator;
  }

  /**
   * Look up a route entry.
   */
  lookupRoute(qualifiedName: string): RouteEntry | undefined {
    return this.requestRouter.lookup(qualifiedName);
  }

  // ── Internal methods used by UpstreamBuilder ───────────────────────

  /** @internal */
  _setServerPrefix(serverName: string, prefix: string | null): void {
    this.pendingPrefixes.set(serverName, prefix);
    const server = this.serverRegistry.getServer(serverName);
    if (server) {
      server.config.prefix = prefix;
      this.rebuildRouteTable();
    }
  }

  /** @internal */
  _setServerFilter(serverName: string, filter: FilterConfig): void {
    this.pendingFilters.set(serverName, filter);
    const server = this.serverRegistry.getServer(serverName);
    if (server) {
      server.config.filter = filter;
      server.filter = filter;
      this.rebuildRouteTable();
    }
  }

  /** @internal */
  _addServerAlias(serverName: string, from: string, to: string): void {
    // The 'to' for a server alias should be the namespaced name
    const server = this.serverRegistry.getServer(serverName);
    if (server) {
      const prefix = server.config.prefix !== undefined ? server.config.prefix : serverName;
      const namespacedTo = prefix !== null
        ? `${prefix}${this.options.separator}${to}`
        : to;
      this.requestRouter.addServerAlias(serverName, from, namespacedTo);
      this.rebuildRouteTable();
    }
  }

  /** @internal */
  _addServerMiddleware(serverName: string, middleware: MiddlewareFn): void {
    this.requestRouter.addServerMiddleware(serverName, middleware);
  }

  private rebuildRouteTable(): void {
    this.requestRouter.buildRouteTable();
  }
}
