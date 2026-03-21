import type {
  ToolDefinition,
  RouteEntry,
  ConflictResolution,
  CollisionError as CollisionErrorType,
} from './types.js';
import { CollisionError } from './types.js';

export interface NamespaceEntry {
  serverName: string;
  tool: ToolDefinition;
  qualifiedName: string;
}

export class NamespaceManager {
  private readonly entries: Map<string, NamespaceEntry> = new Map();
  private readonly serverTools: Map<string, NamespaceEntry[]> = new Map();
  private readonly separator: string;
  private readonly conflictResolution: ConflictResolution;

  constructor(separator = '/', conflictResolution: ConflictResolution = 'prefix') {
    this.separator = separator;
    this.conflictResolution = conflictResolution;
  }

  /**
   * Build a qualified name from server prefix and tool name.
   * If prefix is null, the original name is returned unchanged.
   */
  qualify(prefix: string | null, toolName: string): string {
    if (prefix === null) {
      return toolName;
    }
    return `${prefix}${this.separator}${toolName}`;
  }

  /**
   * Strip the namespace prefix from a qualified name, returning
   * the upstream name and the original tool name.
   * Splits on the first occurrence of the separator.
   */
  dequalify(qualifiedName: string): { serverName: string; originalName: string } | null {
    const sepIndex = qualifiedName.indexOf(this.separator);
    if (sepIndex === -1) {
      // No separator found -- check if this is a direct (no-prefix) entry
      const entry = this.entries.get(qualifiedName);
      if (entry) {
        return { serverName: entry.serverName, originalName: entry.tool.name };
      }
      return null;
    }
    const serverName = qualifiedName.substring(0, sepIndex);
    const originalName = qualifiedName.substring(sepIndex + this.separator.length);
    return { serverName, originalName };
  }

  /**
   * Register a tool under a server's namespace.
   * prefix can be null to register without namespacing.
   */
  addTool(serverName: string, tool: ToolDefinition, prefix?: string | null): void {
    const effectivePrefix = prefix === undefined ? serverName : prefix;
    const qualifiedName = this.qualify(effectivePrefix, tool.name);

    const existing = this.entries.get(qualifiedName);
    if (existing && existing.serverName !== serverName) {
      switch (this.conflictResolution) {
        case 'error':
          throw new CollisionError([{
            name: qualifiedName,
            upstreams: [existing.serverName, serverName],
          }]);
        case 'first-wins':
          // Keep the existing entry, ignore the new one
          return;
        case 'prefix':
          // Both should have been prefixed already if using 'prefix' strategy.
          // If collision still happens, throw.
          throw new CollisionError([{
            name: qualifiedName,
            upstreams: [existing.serverName, serverName],
          }]);
      }
    }

    const entry: NamespaceEntry = {
      serverName,
      tool,
      qualifiedName,
    };

    this.entries.set(qualifiedName, entry);

    if (!this.serverTools.has(serverName)) {
      this.serverTools.set(serverName, []);
    }
    this.serverTools.get(serverName)!.push(entry);
  }

  /**
   * Resolve a qualified name to its namespace entry.
   */
  resolveTool(qualifiedName: string): NamespaceEntry | undefined {
    return this.entries.get(qualifiedName);
  }

  /**
   * List all tools with their qualified names.
   */
  listTools(): NamespaceEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * List tools for a specific server.
   */
  listToolsForServer(serverName: string): NamespaceEntry[] {
    return this.serverTools.get(serverName) ?? [];
  }

  /**
   * Remove all tools belonging to a server.
   */
  removeServer(serverName: string): void {
    const tools = this.serverTools.get(serverName);
    if (tools) {
      for (const entry of tools) {
        this.entries.delete(entry.qualifiedName);
      }
      this.serverTools.delete(serverName);
    }
  }

  /**
   * Check if a qualified name exists.
   */
  has(qualifiedName: string): boolean {
    return this.entries.has(qualifiedName);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
    this.serverTools.clear();
  }

  /**
   * Get the separator character.
   */
  getSeparator(): string {
    return this.separator;
  }

  /**
   * Get the conflict resolution strategy.
   */
  getConflictResolution(): ConflictResolution {
    return this.conflictResolution;
  }

  /**
   * Get total number of registered tools.
   */
  get size(): number {
    return this.entries.size;
  }
}
