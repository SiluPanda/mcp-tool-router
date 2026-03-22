# mcp-tool-router

Aggregate tools from multiple MCP servers into a single, unified namespace.

[![npm version](https://img.shields.io/npm/v/mcp-tool-router.svg)](https://www.npmjs.com/package/mcp-tool-router)
[![npm downloads](https://img.shields.io/npm/dt/mcp-tool-router.svg)](https://www.npmjs.com/package/mcp-tool-router)
[![license](https://img.shields.io/npm/l/mcp-tool-router.svg)](https://github.com/SiluPanda/mcp-tool-router/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/mcp-tool-router.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

---

## Description

`mcp-tool-router` is a programmatic router and aggregator for MCP (Model Context Protocol) servers. It connects to multiple upstream MCP servers, merges their tools into a single unified namespace, and routes tool calls to the correct upstream based on namespace prefixes. The downstream client sees one tool list from one router -- it has no knowledge that multiple backends exist.

When an LLM agent or MCP host connects to many MCP servers simultaneously, two problems compound. First, every server's tool list is injected into the context window, consuming tens of thousands of tokens before the user types a single message. Second, tool names collide -- two servers that both expose a `search` tool force ad-hoc disambiguation.

`mcp-tool-router` solves both problems at the routing level. Tools from each upstream are namespaced with a configurable prefix and separator (e.g., `github/create_issue`, `jira/search`), eliminating collisions by construction. Selective forwarding allows the router to expose only a subset of each upstream's tools, reducing context bloat. Middleware intercepts tool calls for logging, access control, or argument injection.

The architecture mirrors patterns proven in adjacent domains: GraphQL federation merges subgraph schemas behind a gateway, Envoy reverse-proxies HTTP microservices behind a single ingress, and `mcp-tool-router` composes MCP servers behind a single virtual server with prefix-based routing.

### Key design decisions

- **Zero runtime dependencies** -- uses only `node:events` from Node.js
- **ES2022 target, CommonJS module format**
- **TypeScript strict mode** with full type exports
- **Routing layer only** -- provides tool dispatch logic that integrates with any MCP server framework

---

## Installation

```bash
npm install mcp-tool-router
```

Requires Node.js >= 18.

---

## Quick Start

```typescript
import { ToolRouter } from 'mcp-tool-router';

const router = new ToolRouter({
  name: 'my-router',
  version: '1.0.0',
  separator: '/',
  conflictResolution: 'prefix',
});

// Register upstream servers with their tools and handlers
router.addServer('github', {
  tools: [
    { name: 'create_issue', description: 'Create a GitHub issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    { name: 'search', description: 'Search repositories' },
  ],
  handler: async (toolName, args) => {
    // Forward to actual MCP server or implement directly
    return { content: [{ type: 'text', text: `GitHub ${toolName}: ${JSON.stringify(args)}` }] };
  },
});

router.addServer('jira', {
  tools: [
    { name: 'create_ticket', description: 'Create a Jira ticket' },
    { name: 'search', description: 'Search Jira issues' },
  ],
  handler: async (toolName, args) => {
    return { content: [{ type: 'text', text: `Jira ${toolName}: ${JSON.stringify(args)}` }] };
  },
});

// Tools are namespaced automatically:
// github/create_issue, github/search, jira/create_ticket, jira/search
const tools = router.listTools();
console.log(tools.map(t => t.namespacedName));

// Route calls to the correct upstream server
const result = await router.callTool('github/create_issue', { title: 'Bug report' });
```

---

## Features

### Namespace Management

Tools from each upstream server are prefixed with the server name (or a custom prefix) and a configurable separator to prevent name collisions.

```typescript
// Default: server name is used as prefix
router.addServer('github', { tools, handler });
// Tool exposed as: github/create_issue

// Custom prefix
router.addServer('postgres', { tools, handler }).namespace('pg');
// Tool exposed as: pg/query

// Disable namespacing (use with caution -- collisions possible)
router.addServer('local', { tools, handler }).namespace(null);
// Tool exposed as: my_tool (original name, no prefix)
```

### Custom Separators

```typescript
const dotRouter = new ToolRouter({ separator: '.' });
// Tools: github.create_issue, github.search

const dunderRouter = new ToolRouter({ separator: '__' });
// Tools: github__create_issue, github__search

const colonRouter = new ToolRouter({ separator: '::' });
// Tools: github::create_issue, github::search
```

### Tool Filtering

Control which tools from each upstream are exposed. Filters support exact names and glob patterns (`*` matches any characters, `?` matches a single character). Include patterns are applied first, then exclude patterns, then predicate functions.

```typescript
// Include only specific tools (glob patterns supported)
router.addServer('github', { tools, handler })
  .include(['create_*', 'search']);

// Exclude dangerous tools
router.addServer('postgres', { tools, handler })
  .exclude(['drop_*', 'truncate_*']);

// Full filter config with predicate function
router.addServer('db', { tools, handler })
  .filter({
    include: ['*'],
    exclude: ['internal_*'],
    predicate: (tool) => !tool.annotations?.destructiveHint,
  });
```

### Tool Aliasing

Rename tools for shorter or clearer names. When a tool is aliased, the original namespaced name is removed from the tool list -- only the alias appears.

```typescript
// Router-level alias: replaces the namespaced name entirely
router.alias('search', 'github/search_repositories');
// "github/search_repositories" is removed, "search" is exposed

// Server-level alias via the builder
router.addServer('github', { tools, handler })
  .alias('find', 'search_repositories');
// "github/search_repositories" is removed, "find" is exposed
```

### Middleware

Intercept tool calls for logging, access control, argument injection, or response modification. Middleware follows the `(context, next) => response` pattern. Server-specific middleware runs before global middleware.

```typescript
// Global middleware: applies to all tool calls
router.use(async (ctx, next) => {
  console.log(`Calling ${ctx.namespacedName} on ${ctx.upstreamName}`);
  const result = await next();
  console.log(`Completed in context of ${ctx.upstreamName}`);
  return result;
});

// Server-specific middleware via the builder
router.addServer('db', { tools, handler })
  .use(async (ctx, next) => {
    if (ctx.toolDefinition.annotations?.destructiveHint) {
      return {
        content: [{ type: 'text', text: 'Denied: destructive operations are blocked' }],
        isError: true,
      };
    }
    return next();
  });

// Short-circuit: return without calling next() to skip the upstream
router.use(async (ctx, next) => {
  if (ctx.namespacedName === 'cached/tool') {
    return { content: [{ type: 'text', text: 'cached result' }] };
  }
  return next();
});
```

### Conflict Resolution

Handle name collisions when tools from different servers share the same qualified name (typically when using `null` prefixes).

```typescript
// 'prefix' (default): tools are namespaced; collision on identical qualified names throws
const router = new ToolRouter({ conflictResolution: 'prefix' });

// 'first-wins': the first registered tool keeps the name, duplicates are silently dropped
const router2 = new ToolRouter({ conflictResolution: 'first-wins' });

// 'error': throw CollisionError immediately on any collision
const router3 = new ToolRouter({ conflictResolution: 'error' });
```

### Metrics

Track per-server call counts, latency, and error rates.

```typescript
const metrics = router.metrics;

console.log(metrics.totalCalls);    // Total calls across all servers
console.log(metrics.totalErrors);   // Total errors across all servers
console.log(metrics.totalTools);    // Number of tools in the route table
console.log(metrics.uptimeMs);      // Router uptime in milliseconds

// Per-upstream metrics
console.log(metrics.upstreams.github.callCount);
console.log(metrics.upstreams.github.errorCount);
console.log(metrics.upstreams.github.avgLatencyMs);
console.log(metrics.upstreams.github.lastCallAt);
```

### Events

Subscribe to router lifecycle and tool call events. `ToolRouter` extends `EventEmitter`.

```typescript
router.on('serverConnected', (e) => console.log(`Connected: ${e.name}`));
router.on('serverDisconnected', (e) => console.log(`Disconnected: ${e.name}`));
router.on('toolCall', (e) => {
  console.log(`Tool: ${e.tool}, Upstream: ${e.upstream}, Duration: ${e.durationMs}ms, Error: ${e.isError}`);
});
```

### Dynamic Server Management

Add, remove, and update servers at runtime. The route table rebuilds automatically after each change.

```typescript
// Add servers dynamically
router.addServer('new-server', { tools, handler });

// Remove a server (its tools are removed from the route table)
router.removeServer('old-server');

// Update a server's tool list without removing it
router.updateServerTools('github', [
  { name: 'search' },
  { name: 'create_issue' },
  { name: 'close_issue' },  // newly added
]);
```

---

## API Reference

### `createRouter(options?)`

Factory function that creates and returns a new `ToolRouter` instance.

```typescript
import { createRouter } from 'mcp-tool-router';

const router = createRouter({ name: 'my-router', version: '1.0.0' });
```

**Parameters:**
- `options` (`RouterOptions`, optional) -- see `RouterOptions` below.

**Returns:** `ToolRouter`

---

### `ToolRouter`

The main class that aggregates tools from multiple upstream servers. Extends `EventEmitter`.

#### Constructor

```typescript
new ToolRouter(options?: RouterOptions)
```

#### `RouterOptions`

| Property | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `'mcp-tool-router'` | Name of the virtual server. |
| `version` | `string` | `'1.0.0'` | Version of the virtual server. |
| `separator` | `string` | `'/'` | Character(s) placed between namespace prefix and tool name. |
| `conflictResolution` | `ConflictResolution` | `'prefix'` | Strategy for handling name collisions: `'prefix'`, `'first-wins'`, or `'error'`. |
| `healthCheck` | `boolean` | `false` | Whether to enable health checking. |
| `connectionStrategy` | `'eager' \| 'lazy'` | `'eager'` | When to connect to upstream servers. |
| `aggregateResources` | `boolean` | `true` | Whether to aggregate resources from upstreams. |
| `aggregatePrompts` | `boolean` | `true` | Whether to aggregate prompts from upstreams. |
| `pageSize` | `number` | `0` | Max tools per page in list responses. `0` disables pagination. |

#### Methods

| Method | Signature | Description |
|---|---|---|
| `addServer` | `(name: string, config: { tools?: ToolDefinition[]; handler?: ToolCallHandler; ... }) => UpstreamBuilder` | Register an upstream server. Returns an `UpstreamBuilder` for fluent configuration. |
| `removeServer` | `(name: string) => boolean` | Unregister a server and remove its tools. Returns `true` if the server existed. |
| `callTool` | `(name: string, args?: Record<string, unknown>) => Promise<ToolCallResponse>` | Route a tool call to the correct upstream by its namespaced name. |
| `listTools` | `() => Array<ToolDefinition & { namespacedName: string; upstream: string }>` | List all available tools with their namespaced names and source upstream. |
| `listServers` | `() => UpstreamInfo[]` | List all registered servers with status and metrics. |
| `updateServerTools` | `(name: string, tools: ToolDefinition[]) => void` | Replace a server's tool list and rebuild the route table. |
| `use` | `(middleware: MiddlewareFn) => ToolRouter` | Register a global middleware function. Returns `this` for chaining. |
| `alias` | `(from: string, to: string) => ToolRouter` | Register a router-level tool alias. `to` is the fully namespaced name. Returns `this`. |
| `start` | `() => Promise<void>` | Start the router. |
| `stop` | `() => Promise<void>` | Stop the router and clear all state. |
| `lookupRoute` | `(qualifiedName: string) => RouteEntry \| undefined` | Look up a route entry by its qualified name. |

#### Properties

| Property | Type | Description |
|---|---|---|
| `tools` | `ReadonlyArray<ToolDefinition & { namespacedName: string; upstream: string }>` | Current aggregated tool list. |
| `upstreams` | `ReadonlyArray<UpstreamInfo>` | Current upstream server info. |
| `metrics` | `RouterMetrics` | Current router metrics snapshot. |
| `routeCount` | `number` | Number of entries in the route table. |
| `separator` | `string` | The configured namespace separator. |

#### Events

| Event | Payload | Description |
|---|---|---|
| `serverConnected` | `{ name: string }` | Emitted when a server is added. |
| `serverDisconnected` | `{ name: string }` | Emitted when a server is removed. |
| `toolCall` | `ToolCallEvent` | Emitted after every tool call with timing and error info. |

---

### `UpstreamBuilder`

Fluent builder returned by `ToolRouter.addServer()`. All methods return `this` for chaining.

| Method | Signature | Description |
|---|---|---|
| `namespace` | `(prefix: string \| null) => UpstreamBuilder` | Set the namespace prefix. Pass `null` to disable namespacing. |
| `filter` | `(config: FilterConfig) => UpstreamBuilder` | Set include/exclude/predicate filters. |
| `include` | `(patterns: string[]) => UpstreamBuilder` | Shorthand: include only tools matching these glob patterns. |
| `exclude` | `(toolNames: string[]) => UpstreamBuilder` | Shorthand: exclude tools matching these glob patterns. |
| `alias` | `(from: string, to: string) => UpstreamBuilder` | Register a server-level alias. `to` is the original tool name (before namespacing). |
| `use` | `(middleware: MiddlewareFn) => UpstreamBuilder` | Register middleware specific to this upstream. |

---

### `NamespaceManager`

Manages namespace prefix application and stripping for tool names.

```typescript
import { NamespaceManager } from 'mcp-tool-router';

const ns = new NamespaceManager('/', 'prefix');
```

#### Constructor

```typescript
new NamespaceManager(separator?: string, conflictResolution?: ConflictResolution)
```

| Method | Signature | Description |
|---|---|---|
| `qualify` | `(prefix: string \| null, toolName: string) => string` | Build a qualified name from prefix and tool name. Returns original name if prefix is `null`. |
| `dequalify` | `(qualifiedName: string) => { serverName: string; originalName: string } \| null` | Strip the prefix, splitting on first separator occurrence. |
| `addTool` | `(serverName: string, tool: ToolDefinition, prefix?: string \| null) => void` | Register a tool under a server's namespace. |
| `resolveTool` | `(qualifiedName: string) => NamespaceEntry \| undefined` | Look up a registered tool by its qualified name. |
| `listTools` | `() => NamespaceEntry[]` | List all registered tools. |
| `listToolsForServer` | `(serverName: string) => NamespaceEntry[]` | List tools for a specific server. |
| `removeServer` | `(serverName: string) => void` | Remove all tools belonging to a server. |
| `has` | `(qualifiedName: string) => boolean` | Check if a qualified name is registered. |
| `clear` | `() => void` | Remove all entries. |
| `getSeparator` | `() => string` | Get the configured separator. |
| `getConflictResolution` | `() => ConflictResolution` | Get the configured conflict resolution strategy. |
| `size` | `number` (getter) | Total number of registered tools. |

---

### `ServerRegistry`

Manages server registrations, tool/resource/prompt lists, status, and call metrics.

```typescript
import { ServerRegistry } from 'mcp-tool-router';

const registry = new ServerRegistry();
```

| Method | Signature | Description |
|---|---|---|
| `registerServer` | `(config, tools, handler, resources?, prompts?) => void` | Register a server with its tools and handler. |
| `unregisterServer` | `(name: string) => boolean` | Remove a server registration. |
| `getServer` | `(name: string) => ServerEntry \| undefined` | Get a server entry by name. |
| `hasServer` | `(name: string) => boolean` | Check if a server is registered. |
| `listServers` | `() => ServerEntry[]` | List all registered servers. |
| `listServerNames` | `() => string[]` | List all server names. |
| `updateTools` | `(name: string, tools: ToolDefinition[]) => void` | Update a server's tool list. |
| `updateResources` | `(name: string, resources: ResourceDefinition[]) => void` | Update a server's resource list. |
| `updatePrompts` | `(name: string, prompts: PromptDefinition[]) => void` | Update a server's prompt list. |
| `updateStatus` | `(name: string, status: UpstreamStatus) => void` | Update a server's connection status. |
| `recordCall` | `(name: string, durationMs: number, isError: boolean) => void` | Record a tool call for metrics tracking. |
| `getUpstreamInfo` | `(name: string) => UpstreamInfo \| undefined` | Get aggregated upstream info with metrics. |
| `clear` | `() => void` | Remove all server registrations. |
| `size` | `number` (getter) | Number of registered servers. |

---

### `RequestRouter`

Handles routing tool calls to the correct upstream server. Builds and maintains the route table, executes middleware chains, and records call metrics.

```typescript
import { RequestRouter } from 'mcp-tool-router';

const router = new RequestRouter(namespaceManager, serverRegistry);
```

| Method | Signature | Description |
|---|---|---|
| `buildRouteTable` | `() => void` | Rebuild the route table from current namespace and registry state. |
| `route` | `(request: ToolCallRequest) => Promise<ToolCallResponse>` | Route a tool call request to the correct upstream. |
| `lookup` | `(qualifiedName: string) => RouteEntry \| undefined` | Look up a route entry by qualified name. |
| `listRoutes` | `() => RouteEntry[]` | Get all route entries. |
| `listTools` | `() => ToolDefinition[]` | Get all tool definitions with namespaced names. |
| `addMiddleware` | `(middleware: MiddlewareFn) => void` | Register a global middleware. |
| `addServerMiddleware` | `(serverName: string, middleware: MiddlewareFn) => void` | Register middleware for a specific server. |
| `addAlias` | `(from: string, to: string) => void` | Register a global alias. |
| `addServerAlias` | `(serverName: string, from: string, to: string) => void` | Register a per-server alias. |
| `size` | `number` (getter) | Number of routes in the table. |

---

### `applyFilter(tools, filter?)`

Standalone function that applies a `FilterConfig` to a list of tool definitions.

```typescript
import { applyFilter } from 'mcp-tool-router';

const filtered = applyFilter(tools, {
  include: ['get_*'],
  exclude: ['get_internal_*'],
  predicate: (tool) => !!tool.description,
});
```

**Parameters:**
- `tools` (`ToolDefinition[]`) -- the tool list to filter.
- `filter` (`FilterConfig`, optional) -- the filter configuration. Returns all tools if omitted.

**Returns:** `ToolDefinition[]`

---

### `CollisionError`

Thrown when two tools from different upstream servers resolve to the same qualified name.

```typescript
import { CollisionError } from 'mcp-tool-router';

try {
  ns.addTool('server2', { name: 'search' }, null);
} catch (err) {
  if (err instanceof CollisionError) {
    console.log(err.conflicts);
    // [{ name: 'search', upstreams: ['server1', 'server2'] }]
  }
}
```

**Properties:**
- `conflicts` (`Array<{ name: string; upstreams: string[] }>`) -- list of conflicting names and the upstreams that produced them.

---

### `ConfigError`

Thrown for invalid configuration (e.g., invalid separator, missing required fields).

```typescript
import { ConfigError } from 'mcp-tool-router';
```

---

### Type Exports

All types are exported from the package entry point:

```typescript
import type {
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
} from 'mcp-tool-router';
```

---

## Configuration

### `ServerConfig`

Configuration for an upstream server registration.

| Property | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | required | Unique identifier for the upstream server. |
| `transport` | `UpstreamTransportConfig` | -- | Transport configuration (`stdio`, `http`, or `sse`). |
| `prefix` | `string \| null` | server name | Namespace prefix. `null` disables namespacing. |
| `separator` | `string` | `'/'` | Override the router-level separator for this server. |
| `filter` | `FilterConfig` | -- | Include/exclude/predicate filter for this server's tools. |
| `aliases` | `AliasConfig[]` | -- | Tool aliases for this server. |
| `connectTimeout` | `number` | `30000` | Connection timeout in milliseconds. |
| `requestTimeout` | `number` | `60000` | Per-request timeout in milliseconds. |
| `reconnect` | `ReconnectConfig` | -- | Reconnection configuration. |
| `env` | `Record<string, string>` | -- | Environment variables (stdio transport). |
| `cwd` | `string` | -- | Working directory (stdio transport). |
| `headers` | `Record<string, string>` | -- | HTTP headers (http/sse transport). |

### `FilterConfig`

| Property | Type | Description |
|---|---|---|
| `include` | `string[]` | Glob patterns. Only tools matching at least one pattern are included. |
| `exclude` | `string[]` | Glob patterns. Tools matching any pattern are excluded. |
| `predicate` | `(tool: ToolDefinition) => boolean` | Function filter. Return `true` to include, `false` to exclude. |

### `ReconnectConfig`

| Property | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Whether to automatically reconnect on disconnect. |
| `maxAttempts` | `number` | `10` | Maximum reconnection attempts before giving up. |
| `initialDelayMs` | `number` | `1000` | Initial delay before first reconnection attempt. |
| `maxDelayMs` | `number` | `30000` | Maximum delay between reconnection attempts. |
| `backoffMultiplier` | `number` | `2` | Multiplier applied to delay after each failed attempt. |

### `UpstreamTransportConfig`

```typescript
type UpstreamTransportConfig =
  | { type: 'stdio'; command: string; args?: string[] }
  | { type: 'http'; url: string }
  | { type: 'sse'; url: string };
```

---

## Error Handling

### Unknown Tool

When `callTool` is called with a tool name that does not exist in the route table, the response has `isError: true` and the content contains `Unknown tool: "<name>"`.

```typescript
const result = await router.callTool('nonexistent/tool', {});
if (result.isError) {
  console.error(result.content[0]); // { type: 'text', text: 'Unknown tool: "nonexistent/tool"' }
}
```

### Upstream Unavailable

When the target upstream server is disconnected or in a non-connected state, the response has `isError: true` and the content describes the server status.

```typescript
const result = await router.callTool('github/search', {});
if (result.isError) {
  console.error(result.content[0]); // { type: 'text', text: 'Server "github" is disconnected' }
}
```

### Handler Errors

If the upstream handler throws an exception, the error is caught and returned as an error response. The error is also recorded in the server's metrics.

```typescript
const result = await router.callTool('flaky/operation', {});
if (result.isError) {
  // { type: 'text', text: 'Error calling tool "operation" on server "flaky": Connection timeout' }
}
```

### Name Collisions

`CollisionError` is thrown when two servers produce the same qualified tool name and the conflict resolution strategy is `'error'` or `'prefix'`.

```typescript
import { CollisionError } from 'mcp-tool-router';

try {
  router.addServer('server2', { tools: [{ name: 'search' }], handler }).namespace(null);
} catch (err) {
  if (err instanceof CollisionError) {
    console.error(err.message);
    // Tool name collision detected: "search" is exposed by both upstream "server1" and upstream "server2"
    console.error(err.conflicts);
  }
}
```

### Duplicate Server Names

Attempting to register a server with a name that is already registered throws an `Error`.

```typescript
router.addServer('github', { tools: [], handler });
router.addServer('github', { tools: [], handler }); // throws: Server "github" is already registered
```

---

## Advanced Usage

### Multi-Server Aggregation with Filtering and Aliases

```typescript
import { ToolRouter } from 'mcp-tool-router';

const router = new ToolRouter({
  name: 'enterprise-router',
  version: '2.0.0',
  separator: '/',
});

// GitHub: expose only read operations
router.addServer('github', {
  tools: [
    { name: 'create_issue', description: 'Create issue', annotations: { readOnlyHint: false } },
    { name: 'search', description: 'Search repos', annotations: { readOnlyHint: true } },
    { name: 'get_repo', description: 'Get repo info', annotations: { readOnlyHint: true } },
    { name: 'delete_repo', description: 'Delete repo', annotations: { destructiveHint: true } },
  ],
  handler: githubHandler,
}).filter({
  predicate: (tool) => !tool.annotations?.destructiveHint,
}).namespace('gh');

// Postgres: hide dangerous DDL operations
router.addServer('postgres', {
  tools: [
    { name: 'query', description: 'Run SQL query' },
    { name: 'list_tables', description: 'List tables' },
    { name: 'drop_table', description: 'Drop table' },
    { name: 'truncate_table', description: 'Truncate table' },
  ],
  handler: pgHandler,
}).exclude(['drop_*', 'truncate_*']).namespace('pg');

// Slack: expose everything, add a short alias
router.addServer('slack', {
  tools: [
    { name: 'send_message', description: 'Send a message' },
    { name: 'list_channels', description: 'List channels' },
  ],
  handler: slackHandler,
});

// Router-level alias for convenience
router.alias('send', 'slack/send_message');

// Final tool list:
// gh/create_issue, gh/search, gh/get_repo, pg/query, pg/list_tables,
// slack/list_channels, send
```

### Access Control Middleware

```typescript
router.use(async (ctx, next) => {
  if (ctx.toolDefinition.annotations?.destructiveHint) {
    return {
      content: [{ type: 'text', text: 'Access denied: destructive operations are not allowed' }],
      isError: true,
    };
  }
  return next();
});
```

### Logging and Audit Middleware

```typescript
router.use(async (ctx, next) => {
  const start = Date.now();
  console.log(`[AUDIT] Calling ${ctx.namespacedName} on ${ctx.upstreamName}`);

  const result = await next();

  console.log(`[AUDIT] ${ctx.namespacedName} completed in ${Date.now() - start}ms, error=${!!result.isError}`);
  return result;
});
```

### Server-Specific Middleware

```typescript
// Add input validation middleware only to the database server
router.addServer('db', { tools, handler })
  .use(async (ctx, next) => {
    // Inject a read-only flag for safety
    if (!ctx.arguments.readOnly) {
      ctx.arguments.readOnly = true;
    }
    return next();
  });
```

### Response Modification Middleware

```typescript
router.use(async (ctx, next) => {
  const result = await next();
  // Redact sensitive data from all responses
  return {
    ...result,
    content: result.content.map(c =>
      c.type === 'text'
        ? { ...c, text: c.text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****') }
        : c
    ),
  };
});
```

### Monitoring with Events and Metrics

```typescript
const router = new ToolRouter({ name: 'monitored-router' });

router.on('serverConnected', ({ name }) => {
  console.log(`[EVENT] Server connected: ${name}`);
});

router.on('serverDisconnected', ({ name }) => {
  console.log(`[EVENT] Server disconnected: ${name}`);
});

router.on('toolCall', (event) => {
  if (event.isError) {
    console.error(`[ERROR] ${event.tool} on ${event.upstream}: ${event.errorMessage}`);
  }
});

// Periodic metrics reporting
setInterval(() => {
  const m = router.metrics;
  console.log(`[METRICS] Tools: ${m.totalTools}, Calls: ${m.totalCalls}, Errors: ${m.totalErrors}, Uptime: ${m.uptimeMs}ms`);
  for (const [name, info] of Object.entries(m.upstreams)) {
    console.log(`  ${name}: calls=${info.callCount}, errors=${info.errorCount}, avg=${info.avgLatencyMs.toFixed(1)}ms`);
  }
}, 60_000);
```

### Lifecycle Management

```typescript
const router = new ToolRouter({ name: 'managed-router' });

// Register servers
router.addServer('github', { tools: githubTools, handler: githubHandler });
router.addServer('slack', { tools: slackTools, handler: slackHandler });

// Start the router
await router.start();

// ... use the router ...

// Dynamically add a new server
router.addServer('jira', { tools: jiraTools, handler: jiraHandler });

// Dynamically update tools when upstream changes
router.updateServerTools('github', updatedGithubTools);

// Remove a server
router.removeServer('slack');

// Stop and clean up
await router.stop();
```

---

## TypeScript

This package is written in TypeScript with strict mode enabled. All public types are exported from the package entry point.

```typescript
import { ToolRouter, createRouter, NamespaceManager, ServerRegistry, RequestRouter, applyFilter, CollisionError, ConfigError } from 'mcp-tool-router';

import type {
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
} from 'mcp-tool-router';
```

Compiled output includes `.d.ts` declaration files and `.d.ts.map` declaration maps for IDE navigation. The package targets ES2022 and emits CommonJS modules.

---

## License

MIT
