import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRouter } from '../tool-router.js';
import type { ToolCallResponse, ToolDefinition, ToolCallEvent } from '../types.js';

function makeHandler(
  responses?: Record<string, ToolCallResponse>,
): (name: string, args: Record<string, unknown>) => Promise<ToolCallResponse> {
  return async (name, args) => {
    if (responses && responses[name]) {
      return responses[name];
    }
    return {
      content: [{ type: 'text', text: `${name}: ${JSON.stringify(args)}` }],
    };
  };
}

describe('ToolRouter', () => {
  let router: ToolRouter;

  beforeEach(() => {
    router = new ToolRouter({
      name: 'test-router',
      version: '1.0.0',
      separator: '/',
    });
  });

  describe('constructor', () => {
    it('should create a router with default options', () => {
      const r = new ToolRouter();
      expect(r.separator).toBe('/');
    });

    it('should accept custom options', () => {
      const r = new ToolRouter({
        name: 'custom',
        version: '2.0.0',
        separator: '.',
      });
      expect(r.separator).toBe('.');
    });
  });

  describe('addServer', () => {
    it('should register a server and its tools', () => {
      router.addServer('github', {
        tools: [
          { name: 'create_issue', description: 'Create an issue' },
          { name: 'search', description: 'Search repos' },
        ],
        handler: makeHandler(),
      });

      const tools = router.listTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].namespacedName).toBe('github/create_issue');
      expect(tools[1].namespacedName).toBe('github/search');
    });

    it('should return an UpstreamBuilder', () => {
      const builder = router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });
      expect(builder).toBeDefined();
      expect(typeof builder.namespace).toBe('function');
      expect(typeof builder.filter).toBe('function');
      expect(typeof builder.alias).toBe('function');
    });

    it('should throw when adding duplicate server name', () => {
      router.addServer('github', { tools: [], handler: makeHandler() });
      expect(() => router.addServer('github', { tools: [], handler: makeHandler() }))
        .toThrow('already registered');
    });
  });

  describe('removeServer', () => {
    it('should remove a server and its tools', () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });
      expect(router.listTools()).toHaveLength(1);

      router.removeServer('github');
      expect(router.listTools()).toHaveLength(0);
    });

    it('should return false for unknown server', () => {
      expect(router.removeServer('unknown')).toBe(false);
    });

    it('should emit serverDisconnected event', () => {
      const listener = vi.fn();
      router.on('serverDisconnected', listener);

      router.addServer('github', { tools: [], handler: makeHandler() });
      router.removeServer('github');

      expect(listener).toHaveBeenCalledWith({ name: 'github' });
    });
  });

  describe('callTool', () => {
    it('should route a tool call to the correct server', async () => {
      router.addServer('github', {
        tools: [{ name: 'create_issue' }],
        handler: async (name, args) => ({
          content: [{ type: 'text', text: `Created: ${args.title}` }],
        }),
      });

      const response = await router.callTool('github/create_issue', { title: 'Bug' });

      expect(response.isError).toBeUndefined();
      expect(response.content[0]).toEqual({
        type: 'text',
        text: 'Created: Bug',
      });
    });

    it('should return error for unknown tool', async () => {
      const response = await router.callTool('unknown/tool', {});
      expect(response.isError).toBe(true);
    });

    it('should route to different servers correctly', async () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: async () => ({
          content: [{ type: 'text', text: 'github-result' }],
        }),
      });

      router.addServer('jira', {
        tools: [{ name: 'search' }],
        handler: async () => ({
          content: [{ type: 'text', text: 'jira-result' }],
        }),
      });

      const githubResult = await router.callTool('github/search', {});
      const jiraResult = await router.callTool('jira/search', {});

      expect((githubResult.content[0] as { type: 'text'; text: string }).text).toBe('github-result');
      expect((jiraResult.content[0] as { type: 'text'; text: string }).text).toBe('jira-result');
    });

    it('should emit toolCall event', async () => {
      const events: ToolCallEvent[] = [];
      router.on('toolCall', (event: ToolCallEvent) => events.push(event));

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      await router.callTool('github/search', { query: 'test' });

      expect(events).toHaveLength(1);
      expect(events[0].tool).toBe('github/search');
      expect(events[0].upstream).toBe('github');
      expect(events[0].isError).toBe(false);
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle handler errors and emit error event', async () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: async () => { throw new Error('Timeout'); },
      });

      const response = await router.callTool('github/search', {});

      expect(response.isError).toBe(true);
      expect((response.content[0] as { type: 'text'; text: string }).text).toContain('Timeout');
    });
  });

  describe('listTools', () => {
    it('should return all tools across all servers', () => {
      router.addServer('github', {
        tools: [{ name: 'create_issue' }, { name: 'search' }],
        handler: makeHandler(),
      });

      router.addServer('jira', {
        tools: [{ name: 'create_ticket' }],
        handler: makeHandler(),
      });

      const tools = router.listTools();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.namespacedName).sort()).toEqual([
        'github/create_issue',
        'github/search',
        'jira/create_ticket',
      ]);
    });

    it('should include upstream info in tool entries', () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      const tools = router.listTools();
      expect(tools[0].upstream).toBe('github');
    });
  });

  describe('listServers', () => {
    it('should return server status info', () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      router.addServer('jira', {
        tools: [{ name: 'create_ticket' }],
        handler: makeHandler(),
      });

      const servers = router.listServers();
      expect(servers).toHaveLength(2);
      expect(servers[0].name).toBe('github');
      expect(servers[0].status).toBe('connected');
      expect(servers[0].toolCount).toBe(1);
    });
  });

  describe('namespace configuration', () => {
    it('should use server name as default prefix', () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.listTools()[0].namespacedName).toBe('github/search');
    });

    it('should allow custom prefix via builder', () => {
      router.addServer('postgres', {
        tools: [{ name: 'query' }],
        handler: makeHandler(),
      }).namespace('pg');

      expect(router.listTools()[0].namespacedName).toBe('pg/query');
    });

    it('should allow null prefix to disable namespacing', () => {
      router.addServer('local', {
        tools: [{ name: 'my_tool' }],
        handler: makeHandler(),
      }).namespace(null);

      expect(router.listTools()[0].namespacedName).toBe('my_tool');
    });
  });

  describe('filter configuration', () => {
    it('should filter tools via include patterns', () => {
      router.addServer('github', {
        tools: [
          { name: 'create_issue' },
          { name: 'search' },
          { name: 'delete_issue' },
        ],
        handler: makeHandler(),
      }).include(['create_*', 'search']);

      const tools = router.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.namespacedName).sort()).toEqual([
        'github/create_issue',
        'github/search',
      ]);
    });

    it('should filter tools via exclude patterns', () => {
      router.addServer('github', {
        tools: [
          { name: 'create_issue' },
          { name: 'delete_issue' },
          { name: 'search' },
        ],
        handler: makeHandler(),
      }).exclude(['delete_*']);

      const tools = router.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.namespacedName).sort()).toEqual([
        'github/create_issue',
        'github/search',
      ]);
    });

    it('should filter with predicate via filter()', () => {
      router.addServer('github', {
        tools: [
          { name: 'create_issue', description: 'safe' },
          { name: 'drop_table', description: 'dangerous' },
        ],
        handler: makeHandler(),
      }).filter({
        predicate: (tool) => tool.description !== 'dangerous',
      });

      expect(router.listTools()).toHaveLength(1);
      expect(router.listTools()[0].namespacedName).toBe('github/create_issue');
    });
  });

  describe('alias configuration', () => {
    it('should allow router-level alias', async () => {
      router.addServer('github', {
        tools: [{ name: 'search_repositories' }],
        handler: async (name) => ({
          content: [{ type: 'text', text: `called: ${name}` }],
        }),
      });

      router.alias('search', 'github/search_repositories');

      const tools = router.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].namespacedName).toBe('search');

      const response = await router.callTool('search', {});
      expect((response.content[0] as { type: 'text'; text: string }).text).toBe('called: search_repositories');
    });

    it('should allow server-level alias via builder', async () => {
      router.addServer('github', {
        tools: [{ name: 'search_repositories' }],
        handler: async (name) => ({
          content: [{ type: 'text', text: `called: ${name}` }],
        }),
      }).alias('find', 'search_repositories');

      const tools = router.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].namespacedName).toBe('find');

      const response = await router.callTool('find', {});
      expect((response.content[0] as { type: 'text'; text: string }).text).toBe('called: search_repositories');
    });
  });

  describe('middleware', () => {
    it('should support global middleware via use()', async () => {
      const log: string[] = [];

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: async () => ({ content: [{ type: 'text', text: 'result' }] }),
      });

      router.use(async (ctx, next) => {
        log.push('before');
        const result = await next();
        log.push('after');
        return result;
      });

      await router.callTool('github/search', {});

      expect(log).toEqual(['before', 'after']);
    });

    it('should support server-specific middleware via builder', async () => {
      const log: string[] = [];

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: async () => ({ content: [{ type: 'text', text: 'result' }] }),
      }).use(async (ctx, next) => {
        log.push('server-mw');
        return next();
      });

      router.use(async (ctx, next) => {
        log.push('global-mw');
        return next();
      });

      await router.callTool('github/search', {});

      expect(log).toEqual(['server-mw', 'global-mw']);
    });
  });

  describe('updateServerTools', () => {
    it('should update tools and rebuild route table', () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(1);

      router.updateServerTools('github', [
        { name: 'search' },
        { name: 'create_issue' },
        { name: 'get_repo' },
      ]);

      expect(router.listTools()).toHaveLength(3);
    });
  });

  describe('metrics', () => {
    it('should track tool call metrics', async () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      await router.callTool('github/search', {});
      await router.callTool('github/search', {});

      const metrics = router.metrics;
      expect(metrics.totalCalls).toBe(2);
      expect(metrics.totalErrors).toBe(0);
      expect(metrics.totalTools).toBe(1);
      expect(metrics.upstreams.github.callCount).toBe(2);
    });

    it('should track error metrics', async () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: async () => { throw new Error('fail'); },
      });

      await router.callTool('github/search', {});

      const metrics = router.metrics;
      expect(metrics.totalErrors).toBe(1);
      expect(metrics.upstreams.github.errorCount).toBe(1);
    });

    it('should include uptime', () => {
      const metrics = router.metrics;
      expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('events', () => {
    it('should emit serverConnected on addServer', () => {
      const listener = vi.fn();
      router.on('serverConnected', listener);

      router.addServer('github', { tools: [], handler: makeHandler() });

      expect(listener).toHaveBeenCalledWith({ name: 'github' });
    });

    it('should emit serverDisconnected on removeServer', () => {
      const listener = vi.fn();
      router.on('serverDisconnected', listener);

      router.addServer('github', { tools: [], handler: makeHandler() });
      router.removeServer('github');

      expect(listener).toHaveBeenCalledWith({ name: 'github' });
    });

    it('should emit toolCall events', async () => {
      const events: ToolCallEvent[] = [];
      router.on('toolCall', (e: ToolCallEvent) => events.push(e));

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      await router.callTool('github/search', {});

      expect(events).toHaveLength(1);
      expect(events[0].tool).toBe('github/search');
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop without errors', async () => {
      router.addServer('github', { tools: [], handler: makeHandler() });
      await router.start();
      await router.stop();
    });

    it('should clear state on stop', async () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });
      await router.start();
      await router.stop();

      expect(router.listTools()).toHaveLength(0);
      expect(router.listServers()).toHaveLength(0);
    });
  });

  describe('tools getter', () => {
    it('should return the same as listTools()', () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.tools).toEqual(router.listTools());
    });
  });

  describe('upstreams getter', () => {
    it('should return the same as listServers()', () => {
      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.upstreams).toEqual(router.listServers());
    });
  });

  describe('custom separator', () => {
    it('should use dot separator', () => {
      const dotRouter = new ToolRouter({ separator: '.' });
      dotRouter.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(dotRouter.listTools()[0].namespacedName).toBe('github.search');
    });

    it('should use double underscore separator', () => {
      const dunderRouter = new ToolRouter({ separator: '__' });
      dunderRouter.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(dunderRouter.listTools()[0].namespacedName).toBe('github__search');
    });
  });
});
