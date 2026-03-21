// ── Tool Definition ──────────────────────────────────────────────────

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

// ── Resource Definition ─────────────────────────────────────────────

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ── Prompt Definition ───────────────────────────────────────────────

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}

// ── Filter Configuration ────────────────────────────────────────────

export interface FilterConfig {
  include?: string[];
  exclude?: string[];
  predicate?: (tool: ToolDefinition) => boolean;
}

// ── Alias Configuration ─────────────────────────────────────────────

export interface AliasConfig {
  from: string;
  to: string;
}

// ── Server Configuration ────────────────────────────────────────────

export type ConflictResolution = 'prefix' | 'first-wins' | 'error';

export type UpstreamTransportConfig =
  | { type: 'stdio'; command: string; args?: string[] }
  | { type: 'http'; url: string }
  | { type: 'sse'; url: string };

export interface ReconnectConfig {
  enabled?: boolean;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

export interface ServerConfig {
  name: string;
  transport?: UpstreamTransportConfig;
  prefix?: string | null;
  separator?: string;
  filter?: FilterConfig;
  aliases?: AliasConfig[];
  connectTimeout?: number;
  requestTimeout?: number;
  reconnect?: ReconnectConfig;
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
}

// ── Tool Call Handler ───────────────────────────────────────────────

export type ToolCallHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolCallResponse>;

// ── Internal Server Registration ────────────────────────────────────

export interface ServerRegistration {
  config: ServerConfig;
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  handler: ToolCallHandler;
  status: UpstreamStatus;
}

// ── Router Options ──────────────────────────────────────────────────

export interface RouterOptions {
  name?: string;
  version?: string;
  separator?: string;
  conflictResolution?: ConflictResolution;
  healthCheck?: boolean;
  connectionStrategy?: 'eager' | 'lazy';
  aggregateResources?: boolean;
  aggregatePrompts?: boolean;
  pageSize?: number;
}

// ── Tool Call Request/Response ───────────────────────────────────────

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface ToolCallResponse {
  content: ToolContent[];
  isError?: boolean;
}

// ── Middleware ───────────────────────────────────────────────────────

export interface ToolCallContext {
  namespacedName: string;
  originalName: string;
  upstreamName: string;
  arguments: Record<string, unknown>;
  toolDefinition: ToolDefinition;
}

export type MiddlewareFn = (
  context: ToolCallContext,
  next: () => Promise<ToolCallResponse>,
) => Promise<ToolCallResponse>;

// ── Upstream Status ─────────────────────────────────────────────────

export type UpstreamStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed';

export interface UpstreamInfo {
  name: string;
  status: UpstreamStatus;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  serverInfo?: { name: string; version: string };
  callCount: number;
  errorCount: number;
  avgLatencyMs: number;
  lastCallAt?: string;
  reconnectAttempts: number;
}

// ── Metrics ─────────────────────────────────────────────────────────

export interface RouterMetrics {
  totalCalls: number;
  totalErrors: number;
  totalTools: number;
  totalResources: number;
  totalPrompts: number;
  upstreams: Record<string, UpstreamInfo>;
  uptimeMs: number;
}

// ── Events ──────────────────────────────────────────────────────────

export interface ToolCallEvent {
  timestamp: string;
  tool: string;
  upstream: string;
  durationMs: number;
  isError: boolean;
  errorMessage?: string;
}

export interface UpstreamEvent {
  timestamp: string;
  upstream: string;
  type: 'connected' | 'disconnected' | 'reconnecting' | 'reconnected' | 'failed' | 'tools_changed' | 'resources_changed' | 'prompts_changed';
  message: string;
}

export type RouterEvents = 'toolRegistered' | 'serverConnected' | 'serverDisconnected' | 'error' | 'toolCall' | 'upstream';

// ── Route Entry ─────────────────────────────────────────────────────

export interface RouteEntry {
  namespacedName: string;
  upstreamName: string;
  originalName: string;
  isAlias: boolean;
  toolDefinition: ToolDefinition;
}

// ── Collision Error ─────────────────────────────────────────────────

export class CollisionError extends Error {
  public readonly conflicts: Array<{ name: string; upstreams: string[] }>;

  constructor(conflicts: Array<{ name: string; upstreams: string[] }>) {
    const details = conflicts
      .map((c) => `"${c.name}" is exposed by both upstream "${c.upstreams[0]}" and upstream "${c.upstreams[1]}"`)
      .join('; ');
    super(`Tool name collision detected: ${details}`);
    this.name = 'CollisionError';
    this.conflicts = conflicts;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
