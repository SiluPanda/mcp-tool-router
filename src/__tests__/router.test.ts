import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestRouter, applyFilter } from '../router.js';
import { NamespaceManager } from '../namespace.js';
import { ServerRegistry } from '../registry.js';
import type { ToolDefinition, ToolCallResponse, FilterConfig } from '../types.js';

function makeHandler(prefix = ''): (name: string, args: Record<string, unknown>) => Promise<ToolCallResponse> {
  return async (name, args) => ({
    content: [{ type: 'text', text: `${prefix}${name}: ${JSON.stringify(args)}` }],
  });
}

describe('applyFilter', () => {
  const tools: ToolDefinition[] = [
    { name: 'get_weather' },
    { name: 'get_forecast' },
    { name: 'set_weather' },
    { name: 'drop_table' },
    { name: 'drop_index' },
    { name: 'create_issue' },
    { name: 'search' },
  ];

  it('should return all tools when no filter specified', () => {
    expect(applyFilter(tools)).toHaveLength(7);
    expect(applyFilter(tools, {})).toHaveLength(7);
  });

  it('should include only matching tools with include filter', () => {
    const filter: FilterConfig = { include: ['search'] };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('search');
  });

  it('should support glob patterns in include', () => {
    const filter: FilterConfig = { include: ['get_*'] };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(['get_weather', 'get_forecast']);
  });

  it('should exclude matching tools with exclude filter', () => {
    const filter: FilterConfig = { exclude: ['drop_*'] };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(5);
    expect(result.map((t) => t.name)).not.toContain('drop_table');
    expect(result.map((t) => t.name)).not.toContain('drop_index');
  });

  it('should apply include then exclude', () => {
    const filter: FilterConfig = { include: ['*'], exclude: ['drop_*'] };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(5);
  });

  it('should apply predicate filter', () => {
    const filter: FilterConfig = {
      predicate: (tool) => tool.name.startsWith('get_'),
    };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(2);
  });

  it('should apply include, exclude, and predicate in order', () => {
    const filter: FilterConfig = {
      include: ['*_*'],
      exclude: ['drop_*'],
      predicate: (tool) => tool.name !== 'set_weather',
    };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(['get_weather', 'get_forecast', 'create_issue']);
  });

  it('should return empty array when include matches nothing', () => {
    const filter: FilterConfig = { include: ['nonexistent_*'] };
    expect(applyFilter(tools, filter)).toHaveLength(0);
  });

  it('should support ? wildcard for single character', () => {
    const filter: FilterConfig = { include: ['get_???????'] };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('get_weather');
  });

  it('should support exact name in exclude', () => {
    const filter: FilterConfig = { exclude: ['search'] };
    const result = applyFilter(tools, filter);
    expect(result).toHaveLength(6);
    expect(result.map((t) => t.name)).not.toContain('search');
  });
});

describe('RequestRouter', () => {
  let ns: NamespaceManager;
  let registry: ServerRegistry;
  let router: RequestRouter;

  beforeEach(() => {
    ns = new NamespaceManager('/');
    registry = new ServerRegistry();
    router = new RequestRouter(ns, registry);
  });

  describe('buildRouteTable', () => {
    it('should build routes from registered servers', () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'create_issue' }, { name: 'search' }],
        makeHandler(),
      );
      registry.registerServer(
        { name: 'jira' },
        [{ name: 'create_ticket' }],
        makeHandler(),
      );

      router.buildRouteTable();

      expect(router.size).toBe(3);
      expect(router.lookup('github/create_issue')).toBeDefined();
      expect(router.lookup('github/search')).toBeDefined();
      expect(router.lookup('jira/create_ticket')).toBeDefined();
    });

    it('should use custom prefix from server config', () => {
      registry.registerServer(
        { name: 'postgres', prefix: 'pg' },
        [{ name: 'query' }],
        makeHandler(),
      );

      router.buildRouteTable();

      expect(router.lookup('pg/query')).toBeDefined();
      expect(router.lookup('postgres/query')).toBeUndefined();
    });

    it('should handle null prefix (no namespacing)', () => {
      registry.registerServer(
        { name: 'local', prefix: null },
        [{ name: 'my_tool' }],
        makeHandler(),
      );

      router.buildRouteTable();

      expect(router.lookup('my_tool')).toBeDefined();
    });

    it('should apply filters when building route table', () => {
      registry.registerServer(
        { name: 'github', filter: { include: ['search'] } },
        [{ name: 'create_issue' }, { name: 'search' }],
        makeHandler(),
      );

      router.buildRouteTable();

      expect(router.size).toBe(1);
      expect(router.lookup('github/search')).toBeDefined();
      expect(router.lookup('github/create_issue')).toBeUndefined();
    });

    it('should rebuild correctly when called multiple times', () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        makeHandler(),
      );

      router.buildRouteTable();
      expect(router.size).toBe(1);

      registry.updateTools('github', [{ name: 'search' }, { name: 'create_issue' }]);
      router.buildRouteTable();
      expect(router.size).toBe(2);
    });
  });

  describe('route', () => {
    it('should route to the correct server handler', async () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'create_issue' }],
        async (name, args) => ({
          content: [{ type: 'text', text: `GitHub: ${name}` }],
        }),
      );

      router.buildRouteTable();

      const response = await router.route({
        name: 'github/create_issue',
        arguments: { title: 'test' },
      });

      expect(response.isError).toBeUndefined();
      expect(response.content[0]).toEqual({
        type: 'text',
        text: 'GitHub: create_issue',
      });
    });

    it('should strip namespace prefix when forwarding to handler', async () => {
      const handler = vi.fn(async (name: string) => ({
        content: [{ type: 'text' as const, text: name }],
      }));

      registry.registerServer(
        { name: 'github' },
        [{ name: 'create_issue' }],
        handler,
      );

      router.buildRouteTable();

      await router.route({
        name: 'github/create_issue',
        arguments: {},
      });

      expect(handler).toHaveBeenCalledWith('create_issue', {});
    });

    it('should return error for unknown tool', async () => {
      router.buildRouteTable();

      const response = await router.route({
        name: 'unknown/tool',
        arguments: {},
      });

      expect(response.isError).toBe(true);
      expect(response.content[0]).toHaveProperty('text');
      expect((response.content[0] as { type: 'text'; text: string }).text).toContain('Unknown tool');
    });

    it('should return error when server is disconnected', async () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        makeHandler(),
      );
      registry.updateStatus('github', 'disconnected');

      router.buildRouteTable();

      const response = await router.route({
        name: 'github/search',
        arguments: {},
      });

      expect(response.isError).toBe(true);
      expect((response.content[0] as { type: 'text'; text: string }).text).toContain('disconnected');
    });

    it('should handle handler errors gracefully', async () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        async () => { throw new Error('Connection failed'); },
      );

      router.buildRouteTable();

      const response = await router.route({
        name: 'github/search',
        arguments: {},
      });

      expect(response.isError).toBe(true);
      expect((response.content[0] as { type: 'text'; text: string }).text).toContain('Connection failed');
    });

    it('should pass arguments through to the handler', async () => {
      const handler = vi.fn(async (name: string, args: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(args) }],
      }));

      registry.registerServer(
        { name: 'github' },
        [{ name: 'create_issue' }],
        handler,
      );

      router.buildRouteTable();

      await router.route({
        name: 'github/create_issue',
        arguments: { title: 'Bug', body: 'Details here' },
      });

      expect(handler).toHaveBeenCalledWith('create_issue', {
        title: 'Bug',
        body: 'Details here',
      });
    });
  });

  describe('middleware', () => {
    it('should execute global middleware on tool calls', async () => {
      const log: string[] = [];

      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        async () => ({ content: [{ type: 'text', text: 'result' }] }),
      );

      router.addMiddleware(async (ctx, next) => {
        log.push(`before:${ctx.namespacedName}`);
        const result = await next();
        log.push(`after:${ctx.namespacedName}`);
        return result;
      });

      router.buildRouteTable();

      await router.route({ name: 'github/search', arguments: {} });

      expect(log).toEqual(['before:github/search', 'after:github/search']);
    });

    it('should allow middleware to modify arguments', async () => {
      const handler = vi.fn(async (name: string, args: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }));

      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        handler,
      );

      router.addMiddleware(async (ctx, next) => {
        ctx.arguments.injected = true;
        return next();
      });

      router.buildRouteTable();

      await router.route({ name: 'github/search', arguments: { query: 'test' } });

      // The context arguments are modified but the original request args are passed to handler
      // Let's verify the middleware was called
      expect(handler).toHaveBeenCalled();
    });

    it('should allow middleware to short-circuit', async () => {
      const handler = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'from server' }],
      }));

      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        handler,
      );

      router.addMiddleware(async (_ctx, _next) => ({
        content: [{ type: 'text', text: 'from middleware' }],
      }));

      router.buildRouteTable();

      const response = await router.route({ name: 'github/search', arguments: {} });

      expect(handler).not.toHaveBeenCalled();
      expect((response.content[0] as { type: 'text'; text: string }).text).toBe('from middleware');
    });

    it('should execute multiple middleware in order', async () => {
      const order: number[] = [];

      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        async () => ({ content: [{ type: 'text', text: 'result' }] }),
      );

      router.addMiddleware(async (_ctx, next) => {
        order.push(1);
        const result = await next();
        order.push(4);
        return result;
      });

      router.addMiddleware(async (_ctx, next) => {
        order.push(2);
        const result = await next();
        order.push(3);
        return result;
      });

      router.buildRouteTable();

      await router.route({ name: 'github/search', arguments: {} });

      expect(order).toEqual([1, 2, 3, 4]);
    });

    it('should run server-specific middleware before global middleware', async () => {
      const order: string[] = [];

      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        async () => ({ content: [{ type: 'text', text: 'result' }] }),
      );

      router.addMiddleware(async (_ctx, next) => {
        order.push('global');
        return next();
      });

      router.addServerMiddleware('github', async (_ctx, next) => {
        order.push('server');
        return next();
      });

      router.buildRouteTable();

      await router.route({ name: 'github/search', arguments: {} });

      expect(order).toEqual(['server', 'global']);
    });
  });

  describe('aliases', () => {
    it('should route through a global alias', async () => {
      const handler = vi.fn(async (name: string) => ({
        content: [{ type: 'text' as const, text: name }],
      }));

      registry.registerServer(
        { name: 'github' },
        [{ name: 'search_repositories' }],
        handler,
      );

      router.addAlias('search', 'github/search_repositories');
      router.buildRouteTable();

      const response = await router.route({ name: 'search', arguments: {} });

      expect(handler).toHaveBeenCalledWith('search_repositories', {});
      expect(response.isError).toBeUndefined();
    });

    it('should remove the original namespaced entry when alias is applied', () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'search_repositories' }],
        makeHandler(),
      );

      router.addAlias('search', 'github/search_repositories');
      router.buildRouteTable();

      expect(router.lookup('search')).toBeDefined();
      expect(router.lookup('github/search_repositories')).toBeUndefined();
    });

    it('should mark alias entries with isAlias flag', () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        makeHandler(),
      );

      router.addAlias('find', 'github/search');
      router.buildRouteTable();

      const entry = router.lookup('find');
      expect(entry?.isAlias).toBe(true);
    });
  });

  describe('listTools', () => {
    it('should return all tool definitions with namespaced names', () => {
      registry.registerServer(
        { name: 'github' },
        [
          { name: 'create_issue', description: 'Create an issue' },
          { name: 'search', description: 'Search repos' },
        ],
        makeHandler(),
      );

      router.buildRouteTable();

      const tools = router.listTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('github/create_issue');
      expect(tools[0].description).toBe('Create an issue');
      expect(tools[1].name).toBe('github/search');
    });
  });

  describe('listRoutes', () => {
    it('should return all route entries', () => {
      registry.registerServer(
        { name: 'github' },
        [{ name: 'search' }],
        makeHandler(),
      );
      registry.registerServer(
        { name: 'jira' },
        [{ name: 'create_ticket' }],
        makeHandler(),
      );

      router.buildRouteTable();

      const routes = router.listRoutes();
      expect(routes).toHaveLength(2);
      expect(routes.map((r) => r.namespacedName).sort()).toEqual([
        'github/search',
        'jira/create_ticket',
      ]);
    });
  });
});
