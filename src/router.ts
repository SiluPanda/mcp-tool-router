import type {
  ToolCallRequest,
  ToolCallResponse,
  ToolDefinition,
  RouteEntry,
  MiddlewareFn,
  ToolCallContext,
  FilterConfig,
  AliasConfig,
} from './types.js';
import { NamespaceManager } from './namespace.js';
import { ServerRegistry } from './registry.js';

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports * (any chars), ? (single char).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${withWildcards}$`);
}

/**
 * Check if a name matches a glob pattern.
 */
function matchesGlob(name: string, pattern: string): boolean {
  return globToRegExp(pattern).test(name);
}

/**
 * Apply filter configuration to a list of tool definitions.
 */
export function applyFilter(tools: ToolDefinition[], filter?: FilterConfig): ToolDefinition[] {
  if (!filter) return tools;

  let result = tools;

  if (filter.include && filter.include.length > 0) {
    result = result.filter((tool) =>
      filter.include!.some((pattern) => matchesGlob(tool.name, pattern)),
    );
  }

  if (filter.exclude && filter.exclude.length > 0) {
    result = result.filter((tool) =>
      !filter.exclude!.some((pattern) => matchesGlob(tool.name, pattern)),
    );
  }

  if (filter.predicate) {
    result = result.filter(filter.predicate);
  }

  return result;
}

/**
 * RequestRouter handles routing tool calls to the correct upstream server.
 * It builds and maintains a route table from the namespace manager and registry.
 */
export class RequestRouter {
  private readonly namespace: NamespaceManager;
  private readonly registry: ServerRegistry;
  private readonly routeTable: Map<string, RouteEntry> = new Map();
  private readonly globalMiddleware: MiddlewareFn[] = [];
  private readonly serverMiddleware: Map<string, MiddlewareFn[]> = new Map();
  private readonly aliases: Map<string, string> = new Map();
  private readonly serverAliases: Map<string, AliasConfig[]> = new Map();

  constructor(namespace: NamespaceManager, registry: ServerRegistry) {
    this.namespace = namespace;
    this.registry = registry;
  }

  /**
   * Rebuild the route table from the current state of the namespace manager
   * and server registry.
   */
  buildRouteTable(): void {
    this.namespace.clear();
    this.routeTable.clear();

    const servers = this.registry.listServers();

    for (const server of servers) {
      const prefix = server.config.prefix !== undefined ? server.config.prefix : server.config.name;
      const filteredTools = applyFilter(server.tools, server.filter);

      for (const tool of filteredTools) {
        this.namespace.addTool(server.config.name, tool, prefix);
      }
    }

    // Build route entries from namespace
    for (const nsEntry of this.namespace.listTools()) {
      const routeEntry: RouteEntry = {
        namespacedName: nsEntry.qualifiedName,
        upstreamName: nsEntry.serverName,
        originalName: nsEntry.tool.name,
        isAlias: false,
        toolDefinition: {
          ...nsEntry.tool,
          name: nsEntry.qualifiedName,
        },
      };
      this.routeTable.set(nsEntry.qualifiedName, routeEntry);
    }

    // Apply per-server aliases
    for (const server of servers) {
      const serverAlias = this.serverAliases.get(server.config.name);
      if (serverAlias) {
        for (const alias of serverAlias) {
          this.applyAlias(alias.from, alias.to, server.config.name);
        }
      }
      if (server.aliases) {
        for (const alias of server.aliases) {
          this.applyAlias(alias.from, alias.to, server.config.name);
        }
      }
    }

    // Apply global aliases
    for (const [from, to] of this.aliases) {
      this.applyAlias(from, to);
    }
  }

  private applyAlias(from: string, to: string, _serverName?: string): void {
    const targetEntry = this.routeTable.get(to);
    if (!targetEntry) return;

    // Remove the original namespaced entry
    this.routeTable.delete(to);

    // Add alias entry
    const aliasEntry: RouteEntry = {
      namespacedName: from,
      upstreamName: targetEntry.upstreamName,
      originalName: targetEntry.originalName,
      isAlias: true,
      toolDefinition: {
        ...targetEntry.toolDefinition,
        name: from,
      },
    };
    this.routeTable.set(from, aliasEntry);
  }

  /**
   * Register a global middleware.
   */
  addMiddleware(middleware: MiddlewareFn): void {
    this.globalMiddleware.push(middleware);
  }

  /**
   * Register middleware for a specific server.
   */
  addServerMiddleware(serverName: string, middleware: MiddlewareFn): void {
    if (!this.serverMiddleware.has(serverName)) {
      this.serverMiddleware.set(serverName, []);
    }
    this.serverMiddleware.get(serverName)!.push(middleware);
  }

  /**
   * Register a global alias.
   */
  addAlias(from: string, to: string): void {
    this.aliases.set(from, to);
  }

  /**
   * Register a per-server alias.
   */
  addServerAlias(serverName: string, from: string, to: string): void {
    if (!this.serverAliases.has(serverName)) {
      this.serverAliases.set(serverName, []);
    }
    this.serverAliases.get(serverName)!.push({ from, to });
  }

  /**
   * Route a tool call request to the correct upstream server.
   */
  async route(request: ToolCallRequest): Promise<ToolCallResponse> {
    const entry = this.routeTable.get(request.name);
    if (!entry) {
      return {
        content: [{ type: 'text', text: `Unknown tool: "${request.name}"` }],
        isError: true,
      };
    }

    const server = this.registry.getServer(entry.upstreamName);
    if (!server) {
      return {
        content: [{ type: 'text', text: `Server "${entry.upstreamName}" is not available` }],
        isError: true,
      };
    }

    if (server.status !== 'connected') {
      return {
        content: [{ type: 'text', text: `Server "${entry.upstreamName}" is ${server.status}` }],
        isError: true,
      };
    }

    const context: ToolCallContext = {
      namespacedName: entry.namespacedName,
      originalName: entry.originalName,
      upstreamName: entry.upstreamName,
      arguments: request.arguments,
      toolDefinition: entry.toolDefinition,
    };

    // Build middleware chain: server-specific middleware first, then global
    const serverMw = this.serverMiddleware.get(entry.upstreamName) ?? [];
    const allMiddleware = [...serverMw, ...this.globalMiddleware];

    const executeCall = async (): Promise<ToolCallResponse> => {
      const startTime = Date.now();
      try {
        const response = await server.handler(entry.originalName, context.arguments);
        const durationMs = Date.now() - startTime;
        this.registry.recordCall(entry.upstreamName, durationMs, !!response.isError);
        return response;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        this.registry.recordCall(entry.upstreamName, durationMs, true);
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error calling tool "${entry.originalName}" on server "${entry.upstreamName}": ${message}` }],
          isError: true,
        };
      }
    };

    if (allMiddleware.length === 0) {
      return executeCall();
    }

    // Execute middleware chain
    let index = 0;
    const next = (): Promise<ToolCallResponse> => {
      if (index < allMiddleware.length) {
        const mw = allMiddleware[index++];
        return mw(context, next);
      }
      return executeCall();
    };

    return next();
  }

  /**
   * Look up a route entry by qualified name.
   */
  lookup(qualifiedName: string): RouteEntry | undefined {
    return this.routeTable.get(qualifiedName);
  }

  /**
   * Get all route entries.
   */
  listRoutes(): RouteEntry[] {
    return Array.from(this.routeTable.values());
  }

  /**
   * Get all tool definitions (with namespaced names).
   */
  listTools(): ToolDefinition[] {
    return this.listRoutes().map((entry) => entry.toolDefinition);
  }

  /**
   * Get the number of routes.
   */
  get size(): number {
    return this.routeTable.size;
  }
}
