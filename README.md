# mcp-tool-router

A programmatic router/aggregator for MCP (Model Context Protocol) servers. Merges tools from multiple upstream servers into a unified namespace, eliminating name collisions and reducing context window bloat.

## Installation

```bash
npm install mcp-tool-router
```

## Quick Start

```typescript
import { ToolRouter } from 'mcp-tool-router';

const router = new ToolRouter({
  name: 'my-router',
  version: '1.0.0',
  separator: '/',           // default
  conflictResolution: 'prefix', // 'prefix' | 'first-wins' | 'error'
});

// Register upstream servers with tool handlers
router.addServer('github', {
  tools: [
    { name: 'create_issue', description: 'Create a GitHub issue', inputSchema: { /* ... */ } },
    { name: 'search', description: 'Search repositories' },
  ],
  handler: async (toolName, args) => {
    // Forward to actual MCP server or implement directly
    return { content: [{ type: 'text', text: `Result from ${toolName}` }] };
  },
});

router.addServer('jira', {
  tools: [
    { name: 'create_ticket', description: 'Create a Jira ticket' },
    { name: 'search', description: 'Search Jira issues' },
  ],
  handler: async (toolName, args) => {
    return { content: [{ type: 'text', text: `Jira: ${toolName}` }] };
  },
});

// Tools are namespaced: github/create_issue, github/search, jira/create_ticket, jira/search
const tools = router.listTools();

// Route calls to the correct server
const result = await router.callTool('github/create_issue', { title: 'Bug report' });
```

## Features

### Namespace Management

Tools from each server are prefixed with the server name (or a custom prefix) to prevent collisions.

```typescript
// Custom prefix
router.addServer('postgres', {
  tools: [{ name: 'query' }],
  handler: myHandler,
}).namespace('pg');
// Tool is exposed as: pg/query

// No prefix (use with caution)
router.addServer('local', {
  tools: [{ name: 'my_tool' }],
  handler: myHandler,
}).namespace(null);
// Tool is exposed as: my_tool
```

### Custom Separators

```typescript
const router = new ToolRouter({ separator: '.' });
// Tools: github.create_issue, github.search

const router2 = new ToolRouter({ separator: '__' });
// Tools: github__create_issue, github__search
```

### Tool Filtering

Control which tools from each server are exposed.

```typescript
// Include only specific tools
router.addServer('github', { tools, handler })
  .include(['create_*', 'search']);

// Exclude specific tools
router.addServer('postgres', { tools, handler })
  .exclude(['drop_*', 'truncate_*']);

// Full filter config with predicate
router.addServer('db', { tools, handler })
  .filter({
    include: ['*'],
    exclude: ['internal_*'],
    predicate: (tool) => !tool.annotations?.destructiveHint,
  });
```

### Tool Aliasing

Rename tools for shorter or clearer names.

```typescript
// Router-level alias
router.alias('search', 'github/search_repositories');

// Server-level alias via builder
router.addServer('github', { tools, handler })
  .alias('find', 'search_repositories');
```

### Middleware

Intercept tool calls for logging, access control, or modification.

```typescript
// Global middleware
router.use(async (ctx, next) => {
  console.log(`Calling ${ctx.namespacedName} on ${ctx.upstreamName}`);
  const result = await next();
  console.log(`Done: ${ctx.namespacedName}`);
  return result;
});

// Server-specific middleware
router.addServer('db', { tools, handler })
  .use(async (ctx, next) => {
    if (ctx.toolDefinition.annotations?.destructiveHint) {
      return { content: [{ type: 'text', text: 'Denied' }], isError: true };
    }
    return next();
  });
```

### Conflict Resolution

Handle name collisions when using null prefixes.

```typescript
// 'prefix' (default) - tools are prefixed, collisions are errors
// 'first-wins' - first registered tool wins
// 'error' - throw CollisionError on any collision

const router = new ToolRouter({ conflictResolution: 'first-wins' });
```

### Metrics

Track per-server call counts, latency, and error rates.

```typescript
const metrics = router.metrics;
// { totalCalls, totalErrors, totalTools, upstreams: { github: { callCount, errorCount, avgLatencyMs, ... } } }
```

### Events

Subscribe to router lifecycle events.

```typescript
router.on('serverConnected', (e) => console.log(`Connected: ${e.name}`));
router.on('serverDisconnected', (e) => console.log(`Disconnected: ${e.name}`));
router.on('toolCall', (e) => console.log(`Tool: ${e.tool}, Duration: ${e.durationMs}ms`));
```

### Dynamic Server Management

Add and remove servers at runtime.

```typescript
router.addServer('new-server', { tools, handler });
router.removeServer('old-server');
router.updateServerTools('github', newToolList);
```

## API

### `createRouter(options?)`

Factory function to create a `ToolRouter` instance.

### `ToolRouter`

| Method | Description |
|--------|-------------|
| `addServer(name, config)` | Register an upstream server. Returns `UpstreamBuilder`. |
| `removeServer(name)` | Unregister a server. |
| `callTool(name, args?)` | Route a tool call to the correct server. |
| `listTools()` | List all available tools with namespaced names. |
| `listServers()` | List all servers with status info. |
| `updateServerTools(name, tools)` | Update a server's tool list. |
| `use(middleware)` | Register global middleware. |
| `alias(from, to)` | Register a router-level tool alias. |
| `start()` | Start the router. |
| `stop()` | Stop the router and clean up. |

### `UpstreamBuilder`

Returned by `addServer()`. Fluent API for per-server configuration.

| Method | Description |
|--------|-------------|
| `namespace(prefix)` | Set namespace prefix (or `null` to disable). |
| `filter(config)` | Set include/exclude/predicate filters. |
| `include(patterns)` | Include only matching tools. |
| `exclude(patterns)` | Exclude matching tools. |
| `alias(from, to)` | Register a server-level tool alias. |
| `use(middleware)` | Register server-specific middleware. |

## Key Design Decisions

- **Zero runtime dependencies** -- uses only `node:events` from Node.js
- **ES2022 target, CommonJS module format**
- **TypeScript strict mode** with full type exports
- **Routing layer only** -- does not implement MCP protocol transport; provides tool dispatch logic that can be integrated with any MCP server framework

## License

MIT
