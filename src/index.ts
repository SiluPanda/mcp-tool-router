// mcp-tool-router - Aggregates tools from multiple MCP servers into one

export { ToolRouter, UpstreamBuilder } from './tool-router.js';
export { NamespaceManager } from './namespace.js';
export { ServerRegistry } from './registry.js';
export { RequestRouter, applyFilter } from './router.js';

export type {
  ToolDefinition,
  ToolAnnotations,
  ResourceDefinition,
  PromptDefinition,
  PromptArgument,
  ServerConfig,
  RouterOptions,
  ConflictResolution,
  ToolCallRequest,
  ToolCallResponse,
  ToolCallHandler,
  ToolCallContext,
  ToolContent,
  MiddlewareFn,
  FilterConfig,
  AliasConfig,
  UpstreamStatus,
  UpstreamInfo,
  RouterMetrics,
  ToolCallEvent,
  UpstreamEvent,
  RouterEvents,
  RouteEntry,
  UpstreamTransportConfig,
  ReconnectConfig,
  ServerRegistration,
} from './types.js';

export { CollisionError, ConfigError } from './types.js';

import { ToolRouter as ToolRouterClass } from './tool-router.js';
import type { RouterOptions } from './types.js';

/**
 * Create a new ToolRouter instance.
 */
export function createRouter(options?: RouterOptions): ToolRouterClass {
  return new ToolRouterClass(options);
}
