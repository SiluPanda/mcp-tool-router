import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRouter } from '../tool-router.js';
import { createRouter } from '../index.js';
import type { ToolCallResponse, ToolDefinition, MiddlewareFn } from '../types.js';

function makeHandler(
  responses?: Record<string, ToolCallResponse>,
): (name: string, args: Record<string, unknown>) => Promise<ToolCallResponse> {
  return async (name, args) => {
    if (responses && responses[name]) {
      return responses[name];
    }
    return {
      content: [{ type: 'text', text: `${name}(${JSON.stringify(args)})` }],
    };
  };
}

describe('Integration Tests', () => {
  describe('multi-server aggregation', () => {
    it('should aggregate tools from three servers', () => {
      const router = new ToolRouter({ name: 'multi', version: '1.0.0' });

      router.addServer('github', {
        tools: [
          { name: 'create_issue', description: 'Create a GitHub issue' },
          { name: 'search', description: 'Search repositories' },
          { name: 'get_repo', description: 'Get repo details' },
        ],
        handler: makeHandler(),
      });

      router.addServer('jira', {
        tools: [
          { name: 'create_ticket', description: 'Create a Jira ticket' },
          { name: 'search', description: 'Search Jira issues' },
        ],
        handler: makeHandler(),
      });

      router.addServer('slack', {
        tools: [
          { name: 'send_message', description: 'Send a Slack message' },
          { name: 'list_channels', description: 'List Slack channels' },
        ],
        handler: makeHandler(),
      });

      const tools = router.listTools();
      expect(tools).toHaveLength(7);

      const names = tools.map((t) => t.namespacedName).sort();
      expect(names).toEqual([
        'github/create_issue',
        'github/get_repo',
        'github/search',
        'jira/create_ticket',
        'jira/search',
        'slack/list_channels',
        'slack/send_message',
      ]);
    });

    it('should route calls to the correct server when tools have same name', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: async () => ({
          content: [{ type: 'text', text: 'github-search-result' }],
        }),
      });

      router.addServer('jira', {
        tools: [{ name: 'search' }],
        handler: async () => ({
          content: [{ type: 'text', text: 'jira-search-result' }],
        }),
      });

      const githubResult = await router.callTool('github/search', { query: 'test' });
      const jiraResult = await router.callTool('jira/search', { query: 'test' });

      expect((githubResult.content[0] as { type: 'text'; text: string }).text).toBe('github-search-result');
      expect((jiraResult.content[0] as { type: 'text'; text: string }).text).toBe('jira-search-result');
    });
  });

  describe('dynamic server management', () => {
    it('should add servers dynamically after initialization', async () => {
      const router = new ToolRouter();
      await router.start();

      expect(router.listTools()).toHaveLength(0);

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(1);

      router.addServer('jira', {
        tools: [{ name: 'create_ticket' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(2);

      await router.stop();
    });

    it('should remove servers dynamically', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      router.addServer('jira', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(2);

      router.removeServer('github');
      expect(router.listTools()).toHaveLength(1);
      expect(router.listTools()[0].namespacedName).toBe('jira/search');

      // Should not be able to call removed server's tools
      const result = await router.callTool('github/search', {});
      expect(result.isError).toBe(true);
    });

    it('should handle add/remove/add cycle', () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(1);

      router.removeServer('github');
      expect(router.listTools()).toHaveLength(0);

      // Re-add with different tools
      router.addServer('github', {
        tools: [{ name: 'create_issue' }, { name: 'get_repo' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(2);
    });
  });

  describe('tool update scenarios', () => {
    it('should reflect tool list changes after updateServerTools', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(1);

      router.updateServerTools('github', [
        { name: 'search' },
        { name: 'create_issue' },
        { name: 'close_issue' },
      ]);

      expect(router.listTools()).toHaveLength(3);

      // New tool should be callable
      const result = await router.callTool('github/create_issue', { title: 'test' });
      expect(result.isError).toBeUndefined();
    });

    it('should handle tools being removed from a server', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }, { name: 'create_issue' }],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(2);

      // Remove create_issue from the server
      router.updateServerTools('github', [{ name: 'search' }]);

      expect(router.listTools()).toHaveLength(1);

      // Removed tool should not be callable
      const result = await router.callTool('github/create_issue', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('complex filter scenarios', () => {
    it('should combine include and exclude filters across servers', () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [
          { name: 'create_issue' },
          { name: 'delete_issue' },
          { name: 'search' },
          { name: 'get_repo' },
        ],
        handler: makeHandler(),
      }).filter({
        include: ['*_issue', 'search'],
        exclude: ['delete_*'],
      });

      router.addServer('postgres', {
        tools: [
          { name: 'query' },
          { name: 'drop_table' },
          { name: 'truncate_table' },
          { name: 'list_tables' },
        ],
        handler: makeHandler(),
      }).exclude(['drop_*', 'truncate_*']);

      const tools = router.listTools();
      const names = tools.map((t) => t.namespacedName).sort();

      expect(names).toEqual([
        'github/create_issue',
        'github/search',
        'postgres/list_tables',
        'postgres/query',
      ]);
    });

    it('should support predicate-based filtering with annotations', () => {
      const router = new ToolRouter();

      router.addServer('db', {
        tools: [
          { name: 'query', annotations: { readOnlyHint: true } },
          { name: 'insert', annotations: { readOnlyHint: false } },
          { name: 'delete', annotations: { destructiveHint: true } },
        ],
        handler: makeHandler(),
      }).filter({
        predicate: (tool) => {
          if (tool.annotations?.destructiveHint) return false;
          return true;
        },
      });

      const tools = router.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.namespacedName).sort()).toEqual([
        'db/insert',
        'db/query',
      ]);
    });
  });

  describe('complex alias scenarios', () => {
    it('should support multiple aliases across servers', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search_repositories' }],
        handler: async (name) => ({
          content: [{ type: 'text', text: `gh:${name}` }],
        }),
      });

      router.addServer('jira', {
        tools: [{ name: 'search_issues' }],
        handler: async (name) => ({
          content: [{ type: 'text', text: `jira:${name}` }],
        }),
      });

      router.alias('search_repos', 'github/search_repositories');
      router.alias('search_tickets', 'jira/search_issues');

      const tools = router.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.namespacedName).sort()).toEqual([
        'search_repos',
        'search_tickets',
      ]);

      const githubResult = await router.callTool('search_repos', {});
      expect((githubResult.content[0] as { type: 'text'; text: string }).text).toBe('gh:search_repositories');

      const jiraResult = await router.callTool('search_tickets', {});
      expect((jiraResult.content[0] as { type: 'text'; text: string }).text).toBe('jira:search_issues');
    });
  });

  describe('middleware chain scenarios', () => {
    it('should support logging middleware across all servers', async () => {
      const log: string[] = [];
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      router.addServer('jira', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      router.use(async (ctx, next) => {
        log.push(`start:${ctx.namespacedName}`);
        const result = await next();
        log.push(`end:${ctx.namespacedName}`);
        return result;
      });

      await router.callTool('github/search', {});
      await router.callTool('jira/search', {});

      expect(log).toEqual([
        'start:github/search',
        'end:github/search',
        'start:jira/search',
        'end:jira/search',
      ]);
    });

    it('should support middleware that modifies responses', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: async () => ({
          content: [{ type: 'text', text: 'original' }],
        }),
      });

      router.use(async (ctx, next) => {
        const result = await next();
        return {
          ...result,
          content: [{ type: 'text', text: `modified: ${(result.content[0] as { type: 'text'; text: string }).text}` }],
        };
      });

      const result = await router.callTool('github/search', {});
      expect((result.content[0] as { type: 'text'; text: string }).text).toBe('modified: original');
    });

    it('should support access control middleware', async () => {
      const router = new ToolRouter();

      router.addServer('db', {
        tools: [
          { name: 'query', annotations: { readOnlyHint: true } },
          { name: 'drop_table', annotations: { destructiveHint: true } },
        ],
        handler: makeHandler(),
      });

      router.use(async (ctx, next) => {
        if (ctx.toolDefinition.annotations?.destructiveHint) {
          return {
            content: [{ type: 'text', text: 'Access denied: destructive operations are not allowed' }],
            isError: true,
          };
        }
        return next();
      });

      const queryResult = await router.callTool('db/query', { sql: 'SELECT 1' });
      expect(queryResult.isError).toBeUndefined();

      const dropResult = await router.callTool('db/drop_table', { table: 'users' });
      expect(dropResult.isError).toBe(true);
      expect((dropResult.content[0] as { type: 'text'; text: string }).text).toContain('Access denied');
    });
  });

  describe('metrics tracking across servers', () => {
    it('should track per-server call counts and latency', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      router.addServer('jira', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      await router.callTool('github/search', {});
      await router.callTool('github/search', {});
      await router.callTool('jira/search', {});

      const metrics = router.metrics;
      expect(metrics.totalCalls).toBe(3);
      expect(metrics.upstreams.github.callCount).toBe(2);
      expect(metrics.upstreams.jira).toBeDefined();
      expect(metrics.upstreams.jira.callCount).toBe(1);
    });

    it('should track errors per server', async () => {
      const router = new ToolRouter();

      router.addServer('stable', {
        tools: [{ name: 'ok' }],
        handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      });

      router.addServer('flaky', {
        tools: [{ name: 'fail' }],
        handler: async () => { throw new Error('Timeout'); },
      });

      await router.callTool('stable/ok', {});
      await router.callTool('flaky/fail', {});

      const metrics = router.metrics;
      expect(metrics.upstreams.stable.errorCount).toBe(0);
      expect(metrics.upstreams.flaky.errorCount).toBe(1);
    });
  });

  describe('createRouter factory function', () => {
    it('should create a ToolRouter instance', () => {
      const router = createRouter({ name: 'factory', version: '1.0.0' });
      expect(router).toBeInstanceOf(ToolRouter);
    });

    it('should work with default options', () => {
      const router = createRouter();
      expect(router).toBeInstanceOf(ToolRouter);
    });
  });

  describe('edge cases', () => {
    it('should handle empty tool lists', () => {
      const router = new ToolRouter();
      router.addServer('empty', { tools: [], handler: makeHandler() });
      expect(router.listTools()).toHaveLength(0);
    });

    it('should handle tools with complex input schemas', async () => {
      const router = new ToolRouter();

      const toolDef: ToolDefinition = {
        name: 'create_issue',
        description: 'Create a GitHub issue',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body' },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      };

      router.addServer('github', {
        tools: [toolDef],
        handler: makeHandler(),
      });

      const tools = router.listTools();
      expect(tools[0].inputSchema).toEqual(toolDef.inputSchema);
    });

    it('should handle calling tool with empty arguments', async () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'list_repos' }],
        handler: async (name, args) => ({
          content: [{ type: 'text', text: `args: ${JSON.stringify(args)}` }],
        }),
      });

      const result = await router.callTool('github/list_repos');
      expect(result.isError).toBeUndefined();
    });

    it('should handle server with many tools', () => {
      const router = new ToolRouter();
      const tools: ToolDefinition[] = [];
      for (let i = 0; i < 100; i++) {
        tools.push({ name: `tool_${i}`, description: `Tool ${i}` });
      }

      router.addServer('big', { tools, handler: makeHandler() });

      expect(router.listTools()).toHaveLength(100);
    });

    it('should handle rapid add/remove cycles', () => {
      const router = new ToolRouter();

      for (let i = 0; i < 10; i++) {
        router.addServer('temp', {
          tools: [{ name: 'search' }],
          handler: makeHandler(),
        });
        router.removeServer('temp');
      }

      expect(router.listTools()).toHaveLength(0);
      expect(router.listServers()).toHaveLength(0);
    });

    it('should preserve tool description and annotations through namespacing', () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{
          name: 'search',
          description: 'Search GitHub',
          annotations: {
            readOnlyHint: true,
            title: 'GitHub Search',
          },
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        }],
        handler: makeHandler(),
      });

      const tool = router.listTools()[0];
      expect(tool.description).toBe('Search GitHub');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.title).toBe('GitHub Search');
      expect(tool.inputSchema).toBeDefined();
    });

    it('should handle concurrent tool calls', async () => {
      const router = new ToolRouter();

      router.addServer('slow', {
        tools: [{ name: 'compute' }],
        handler: async (name, args) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { content: [{ type: 'text', text: `result-${args.id}` }] };
        },
      });

      const results = await Promise.all([
        router.callTool('slow/compute', { id: 1 }),
        router.callTool('slow/compute', { id: 2 }),
        router.callTool('slow/compute', { id: 3 }),
      ]);

      expect(results).toHaveLength(3);
      expect(results.every((r) => !r.isError)).toBe(true);
    });

    it('should handle tools with special characters in names', () => {
      const router = new ToolRouter();

      router.addServer('special', {
        tools: [
          { name: 'get-items' },
          { name: 'create_v2_issue' },
          { name: 'my.tool' },
        ],
        handler: makeHandler(),
      });

      expect(router.listTools()).toHaveLength(3);
      expect(router.listTools().map((t) => t.namespacedName).sort()).toEqual([
        'special/create_v2_issue',
        'special/get-items',
        'special/my.tool',
      ]);
    });
  });

  describe('full lifecycle test', () => {
    it('should handle a complete router lifecycle', async () => {
      // 1. Create router
      const router = new ToolRouter({ name: 'lifecycle', version: '1.0.0' });

      // 2. Add servers
      router.addServer('github', {
        tools: [
          { name: 'create_issue', description: 'Create issue' },
          { name: 'search', description: 'Search repos' },
        ],
        handler: async (name, args) => ({
          content: [{ type: 'text', text: `github:${name}` }],
        }),
      }).namespace('gh');

      router.addServer('slack', {
        tools: [
          { name: 'send_message', description: 'Send message' },
          { name: 'list_channels', description: 'List channels' },
        ],
        handler: async (name, args) => ({
          content: [{ type: 'text', text: `slack:${name}` }],
        }),
      });

      // 3. Add middleware
      const callLog: string[] = [];
      router.use(async (ctx, next) => {
        callLog.push(ctx.namespacedName);
        return next();
      });

      // 4. Start
      await router.start();

      // 5. Verify tools
      const tools = router.listTools();
      expect(tools).toHaveLength(4);

      // 6. Make calls
      const r1 = await router.callTool('gh/create_issue', { title: 'test' });
      expect((r1.content[0] as { type: 'text'; text: string }).text).toBe('github:create_issue');

      const r2 = await router.callTool('slack/send_message', { text: 'hello' });
      expect((r2.content[0] as { type: 'text'; text: string }).text).toBe('slack:send_message');

      // 7. Verify middleware ran
      expect(callLog).toEqual(['gh/create_issue', 'slack/send_message']);

      // 8. Check metrics
      expect(router.metrics.totalCalls).toBe(2);

      // 9. Remove a server
      router.removeServer('slack');
      expect(router.listTools()).toHaveLength(2);

      // 10. Stop
      await router.stop();
    });
  });

  describe('conflict resolution integration', () => {
    it('should prevent collisions with prefix strategy (default)', () => {
      const router = new ToolRouter();

      router.addServer('github', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      router.addServer('jira', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      });

      // Both should be accessible via their prefixed names
      const tools = router.listTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.namespacedName).sort()).toEqual([
        'github/search',
        'jira/search',
      ]);
    });

    it('should throw with error strategy when null prefix causes collision', () => {
      const router = new ToolRouter({ conflictResolution: 'error' });

      router.addServer('server1', {
        tools: [{ name: 'search' }],
        handler: makeHandler(),
      }).namespace(null);

      expect(() => {
        router.addServer('server2', {
          tools: [{ name: 'search' }],
          handler: makeHandler(),
        }).namespace(null);
      }).toThrow(/collision/i);
    });

    it('should keep first entry with first-wins strategy', () => {
      const router = new ToolRouter({ conflictResolution: 'first-wins' });

      router.addServer('server1', {
        tools: [{ name: 'search', description: 'First' }],
        handler: makeHandler(),
      }).namespace(null);

      router.addServer('server2', {
        tools: [{ name: 'search', description: 'Second' }],
        handler: makeHandler(),
      }).namespace(null);

      const tools = router.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].description).toBe('First');
    });
  });
});
