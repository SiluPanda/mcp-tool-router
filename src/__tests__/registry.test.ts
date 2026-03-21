import { describe, it, expect, beforeEach } from 'vitest';
import { ServerRegistry } from '../registry.js';
import type { ServerConfig, ToolDefinition, ToolCallResponse } from '../types.js';

const mockHandler = async (name: string, args: Record<string, unknown>): Promise<ToolCallResponse> => ({
  content: [{ type: 'text', text: `Called ${name}` }],
});

function makeConfig(name: string): ServerConfig {
  return { name };
}

function makeTools(...names: string[]): ToolDefinition[] {
  return names.map((n) => ({ name: n }));
}

describe('ServerRegistry', () => {
  let registry: ServerRegistry;

  beforeEach(() => {
    registry = new ServerRegistry();
  });

  describe('registerServer', () => {
    it('should register a server with tools and handler', () => {
      registry.registerServer(
        makeConfig('github'),
        makeTools('create_issue', 'search'),
        mockHandler,
      );
      expect(registry.hasServer('github')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('should throw when registering a server with duplicate name', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      expect(() => registry.registerServer(makeConfig('github'), [], mockHandler))
        .toThrow('Server "github" is already registered');
    });

    it('should register multiple servers', () => {
      registry.registerServer(makeConfig('github'), makeTools('search'), mockHandler);
      registry.registerServer(makeConfig('jira'), makeTools('create_ticket'), mockHandler);
      registry.registerServer(makeConfig('slack'), makeTools('send_message'), mockHandler);
      expect(registry.size).toBe(3);
    });
  });

  describe('unregisterServer', () => {
    it('should remove a registered server', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      expect(registry.unregisterServer('github')).toBe(true);
      expect(registry.hasServer('github')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('should return false for unknown server', () => {
      expect(registry.unregisterServer('unknown')).toBe(false);
    });
  });

  describe('getServer', () => {
    it('should return the server entry', () => {
      registry.registerServer(
        makeConfig('github'),
        makeTools('search', 'create_issue'),
        mockHandler,
      );
      const server = registry.getServer('github');
      expect(server).toBeDefined();
      expect(server!.config.name).toBe('github');
      expect(server!.tools).toHaveLength(2);
      expect(server!.status).toBe('connected');
    });

    it('should return undefined for unknown server', () => {
      expect(registry.getServer('unknown')).toBeUndefined();
    });
  });

  describe('listServers', () => {
    it('should return all registered servers', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      registry.registerServer(makeConfig('jira'), [], mockHandler);
      const servers = registry.listServers();
      expect(servers).toHaveLength(2);
    });

    it('should return empty array when no servers registered', () => {
      expect(registry.listServers()).toHaveLength(0);
    });
  });

  describe('listServerNames', () => {
    it('should return all server names', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      registry.registerServer(makeConfig('jira'), [], mockHandler);
      expect(registry.listServerNames()).toEqual(['github', 'jira']);
    });
  });

  describe('updateTools', () => {
    it('should update a server tools list', () => {
      registry.registerServer(makeConfig('github'), makeTools('search'), mockHandler);
      registry.updateTools('github', makeTools('search', 'create_issue', 'get_repo'));
      const server = registry.getServer('github');
      expect(server!.tools).toHaveLength(3);
    });

    it('should throw for unknown server', () => {
      expect(() => registry.updateTools('unknown', []))
        .toThrow('Server "unknown" is not registered');
    });
  });

  describe('updateResources', () => {
    it('should update a server resources list', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      registry.updateResources('github', [{ uri: 'repo://test', name: 'test' }]);
      const server = registry.getServer('github');
      expect(server!.resources).toHaveLength(1);
    });

    it('should throw for unknown server', () => {
      expect(() => registry.updateResources('unknown', []))
        .toThrow('Server "unknown" is not registered');
    });
  });

  describe('updatePrompts', () => {
    it('should update a server prompts list', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      registry.updatePrompts('github', [{ name: 'summarize' }]);
      const server = registry.getServer('github');
      expect(server!.prompts).toHaveLength(1);
    });

    it('should throw for unknown server', () => {
      expect(() => registry.updatePrompts('unknown', []))
        .toThrow('Server "unknown" is not registered');
    });
  });

  describe('updateStatus', () => {
    it('should update server status', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      registry.updateStatus('github', 'disconnected');
      expect(registry.getServer('github')!.status).toBe('disconnected');
    });

    it('should be a no-op for unknown server', () => {
      expect(() => registry.updateStatus('unknown', 'disconnected')).not.toThrow();
    });
  });

  describe('recordCall', () => {
    it('should record call metrics', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      registry.recordCall('github', 100, false);
      registry.recordCall('github', 200, false);
      registry.recordCall('github', 50, true);

      const server = registry.getServer('github')!;
      expect(server.callCount).toBe(3);
      expect(server.errorCount).toBe(1);
      expect(server.totalLatencyMs).toBe(350);
      expect(server.lastCallAt).toBeDefined();
    });

    it('should be a no-op for unknown server', () => {
      expect(() => registry.recordCall('unknown', 100, false)).not.toThrow();
    });
  });

  describe('getUpstreamInfo', () => {
    it('should return upstream info with metrics', () => {
      registry.registerServer(
        makeConfig('github'),
        makeTools('search', 'create_issue'),
        mockHandler,
        [{ uri: 'repo://test', name: 'test' }],
        [{ name: 'summarize' }],
      );
      registry.recordCall('github', 100, false);
      registry.recordCall('github', 200, false);

      const info = registry.getUpstreamInfo('github');
      expect(info).toBeDefined();
      expect(info!.name).toBe('github');
      expect(info!.status).toBe('connected');
      expect(info!.toolCount).toBe(2);
      expect(info!.resourceCount).toBe(1);
      expect(info!.promptCount).toBe(1);
      expect(info!.callCount).toBe(2);
      expect(info!.errorCount).toBe(0);
      expect(info!.avgLatencyMs).toBe(150);
    });

    it('should return undefined for unknown server', () => {
      expect(registry.getUpstreamInfo('unknown')).toBeUndefined();
    });

    it('should return 0 avgLatencyMs when no calls made', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      const info = registry.getUpstreamInfo('github')!;
      expect(info.avgLatencyMs).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all servers', () => {
      registry.registerServer(makeConfig('github'), [], mockHandler);
      registry.registerServer(makeConfig('jira'), [], mockHandler);
      registry.clear();
      expect(registry.size).toBe(0);
    });
  });
});
