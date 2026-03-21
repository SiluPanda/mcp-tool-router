import { describe, it, expect, beforeEach } from 'vitest';
import { NamespaceManager } from '../namespace.js';
import { CollisionError } from '../types.js';

describe('NamespaceManager', () => {
  let ns: NamespaceManager;

  beforeEach(() => {
    ns = new NamespaceManager('/');
  });

  describe('qualify', () => {
    it('should create qualified name with prefix and separator', () => {
      expect(ns.qualify('github', 'create_issue')).toBe('github/create_issue');
    });

    it('should return original name when prefix is null', () => {
      expect(ns.qualify(null, 'create_issue')).toBe('create_issue');
    });

    it('should work with dot separator', () => {
      const dotNs = new NamespaceManager('.');
      expect(dotNs.qualify('github', 'create_issue')).toBe('github.create_issue');
    });

    it('should work with underscore separator', () => {
      const underNs = new NamespaceManager('_');
      expect(underNs.qualify('github', 'create_issue')).toBe('github_create_issue');
    });

    it('should work with double underscore separator', () => {
      const dunderNs = new NamespaceManager('__');
      expect(dunderNs.qualify('github', 'create_issue')).toBe('github__create_issue');
    });

    it('should work with :: separator', () => {
      const colonNs = new NamespaceManager('::');
      expect(colonNs.qualify('github', 'create_issue')).toBe('github::create_issue');
    });
  });

  describe('dequalify', () => {
    it('should split on first occurrence of separator', () => {
      ns.addTool('github', { name: 'create_issue' });
      const result = ns.dequalify('github/create_issue');
      expect(result).toEqual({ serverName: 'github', originalName: 'create_issue' });
    });

    it('should handle tool names containing the separator', () => {
      ns.addTool('github', { name: 'create/issue' });
      const result = ns.dequalify('github/create/issue');
      expect(result).toEqual({ serverName: 'github', originalName: 'create/issue' });
    });

    it('should return null for unknown names without separator', () => {
      const result = ns.dequalify('unknown_tool');
      expect(result).toBeNull();
    });

    it('should find entries for names without separator that were registered with null prefix', () => {
      ns.addTool('local', { name: 'my_tool' }, null);
      const result = ns.dequalify('my_tool');
      expect(result).toEqual({ serverName: 'local', originalName: 'my_tool' });
    });
  });

  describe('addTool', () => {
    it('should register a tool under a server namespace', () => {
      ns.addTool('github', { name: 'create_issue' });
      expect(ns.has('github/create_issue')).toBe(true);
    });

    it('should use server name as default prefix', () => {
      ns.addTool('github', { name: 'search' });
      expect(ns.has('github/search')).toBe(true);
    });

    it('should use explicit prefix when provided', () => {
      ns.addTool('github', { name: 'search' }, 'gh');
      expect(ns.has('gh/search')).toBe(true);
      expect(ns.has('github/search')).toBe(false);
    });

    it('should register without prefix when prefix is null', () => {
      ns.addTool('local', { name: 'my_tool' }, null);
      expect(ns.has('my_tool')).toBe(true);
    });

    it('should allow same tool name from different servers with different prefixes', () => {
      ns.addTool('github', { name: 'search' });
      ns.addTool('jira', { name: 'search' });
      expect(ns.has('github/search')).toBe(true);
      expect(ns.has('jira/search')).toBe(true);
    });

    it('should allow multiple tools from the same server', () => {
      ns.addTool('github', { name: 'create_issue' });
      ns.addTool('github', { name: 'search' });
      ns.addTool('github', { name: 'get_repo' });
      expect(ns.size).toBe(3);
    });
  });

  describe('conflict resolution', () => {
    it('should throw CollisionError on conflict with "error" strategy', () => {
      const errorNs = new NamespaceManager('/', 'error');
      errorNs.addTool('server1', { name: 'search' }, null);
      expect(() => errorNs.addTool('server2', { name: 'search' }, null))
        .toThrow(CollisionError);
    });

    it('should keep first entry with "first-wins" strategy', () => {
      const fwNs = new NamespaceManager('/', 'first-wins');
      fwNs.addTool('server1', { name: 'search', description: 'first' }, null);
      fwNs.addTool('server2', { name: 'search', description: 'second' }, null);
      const entry = fwNs.resolveTool('search');
      expect(entry?.serverName).toBe('server1');
      expect(entry?.tool.description).toBe('first');
    });

    it('should throw on collision with "prefix" strategy when names still collide', () => {
      const prefixNs = new NamespaceManager('/', 'prefix');
      prefixNs.addTool('server1', { name: 'search' }, null);
      expect(() => prefixNs.addTool('server2', { name: 'search' }, null))
        .toThrow(CollisionError);
    });

    it('should not throw when same server re-registers same tool', () => {
      ns.addTool('github', { name: 'search' });
      // Same server, same qualified name -- should not throw
      expect(() => ns.addTool('github', { name: 'search' })).not.toThrow();
    });
  });

  describe('resolveTool', () => {
    it('should resolve a registered tool', () => {
      ns.addTool('github', { name: 'create_issue', description: 'Creates an issue' });
      const entry = ns.resolveTool('github/create_issue');
      expect(entry).toBeDefined();
      expect(entry!.serverName).toBe('github');
      expect(entry!.tool.name).toBe('create_issue');
      expect(entry!.tool.description).toBe('Creates an issue');
    });

    it('should return undefined for unregistered tool', () => {
      expect(ns.resolveTool('github/unknown')).toBeUndefined();
    });
  });

  describe('listTools', () => {
    it('should return all registered tools', () => {
      ns.addTool('github', { name: 'create_issue' });
      ns.addTool('github', { name: 'search' });
      ns.addTool('jira', { name: 'create_ticket' });
      const tools = ns.listTools();
      expect(tools).toHaveLength(3);
    });

    it('should return empty array when no tools registered', () => {
      expect(ns.listTools()).toHaveLength(0);
    });
  });

  describe('listToolsForServer', () => {
    it('should return tools for a specific server', () => {
      ns.addTool('github', { name: 'create_issue' });
      ns.addTool('github', { name: 'search' });
      ns.addTool('jira', { name: 'create_ticket' });
      const githubTools = ns.listToolsForServer('github');
      expect(githubTools).toHaveLength(2);
    });

    it('should return empty array for unknown server', () => {
      expect(ns.listToolsForServer('unknown')).toHaveLength(0);
    });
  });

  describe('removeServer', () => {
    it('should remove all tools for a server', () => {
      ns.addTool('github', { name: 'create_issue' });
      ns.addTool('github', { name: 'search' });
      ns.addTool('jira', { name: 'create_ticket' });
      ns.removeServer('github');
      expect(ns.size).toBe(1);
      expect(ns.has('github/create_issue')).toBe(false);
      expect(ns.has('jira/create_ticket')).toBe(true);
    });

    it('should be a no-op for unknown server', () => {
      ns.addTool('github', { name: 'search' });
      ns.removeServer('unknown');
      expect(ns.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      ns.addTool('github', { name: 'create_issue' });
      ns.addTool('jira', { name: 'create_ticket' });
      ns.clear();
      expect(ns.size).toBe(0);
    });
  });

  describe('getSeparator', () => {
    it('should return the configured separator', () => {
      expect(ns.getSeparator()).toBe('/');
      const dotNs = new NamespaceManager('.');
      expect(dotNs.getSeparator()).toBe('.');
    });
  });

  describe('getConflictResolution', () => {
    it('should return the configured conflict resolution strategy', () => {
      expect(ns.getConflictResolution()).toBe('prefix');
      const errorNs = new NamespaceManager('/', 'error');
      expect(errorNs.getConflictResolution()).toBe('error');
    });
  });
});
