# mcp-tool-router — Implementation Tasks

This document breaks down all work described in SPEC.md into granular, actionable tasks organized by implementation phase.

---

## Phase 0: Project Scaffolding and Setup

- [ ] **Install peer and dev dependencies** — Add `@modelcontextprotocol/sdk` as a peer dependency (`^1.12.0`). Add `typescript` (`^5.5.0`), `vitest` (`^2.0.0`), `eslint` (`^9.0.0`), and `@modelcontextprotocol/sdk` as dev dependencies. Run `npm install` and verify lockfile is generated. | Status: not_done

- [ ] **Update package.json metadata** — Add `peerDependencies` for `@modelcontextprotocol/sdk`. Add `bin` field pointing to `dist/cli.js` for the `mcp-tool-router` CLI binary. Add `keywords` (mcp, tool-router, aggregator, etc.). Set `author` and `description` fields. | Status: not_done

- [ ] **Create src/types.ts with all type definitions** — Define all TypeScript interfaces and types from the spec: `ToolRouterOptions`, `UpstreamConfig`, `UpstreamTransportConfig`, `ReconnectConfig`, `FilterConfig`, `ToolDefinition`, `ToolAnnotations`, `AliasConfig`, `ToolCallContext`, `ToolCallResult`, `ToolContent`, `MiddlewareFn`, `UpstreamStatus`, `UpstreamInfo`, `RouterMetrics`, `ToolCallEvent`, `UpstreamEvent`, `RouteEntry`, `RouterConfig`, `RouterConfigUpstream`, `CollisionError`, `ConfigError`. | Status: not_done

- [ ] **Create src/index.ts as main entry point** — Export `ToolRouter` class and all public types from `types.ts`. This is the package's main entry point referenced by `package.json`. | Status: not_done

- [ ] **Create src/__tests__/ directory** — Create the test directory structure for unit and integration tests. | Status: not_done

- [ ] **Verify build pipeline** — Run `npm run build` (tsc) and confirm the project compiles with no errors. Verify `dist/` output is generated with `.js`, `.d.ts`, and `.d.ts.map` files. | Status: not_done

- [ ] **Verify test pipeline** — Run `npm run test` (vitest) and confirm the test runner executes (even if no tests exist yet, it should not crash). | Status: not_done

---

## Phase 1: Core Routing (v0.1.0)

### 1.1 Namespace Transformer

- [ ] **Implement src/namespace-transformer.ts** — Create a `NamespaceTransformer` class (or set of functions) that applies and strips namespace prefixes. Must support: applying a prefix + separator to a tool name (e.g., `"github"` + `"/"` + `"create_issue"` = `"github/create_issue"`), stripping the prefix to recover the original name (splitting on the first occurrence of the separator), namespacing resource URIs, namespacing prompt names, and returning the original name unchanged when prefix is `null`. | Status: not_done

- [ ] **Handle separator edge cases in namespace-transformer** — When stripping a prefix, always split on the first occurrence of the separator to correctly handle tool names that contain the separator character (e.g., `"github/create/issue"` splits into upstream `"github"` and original name `"create/issue"`). | Status: not_done

- [ ] **Write src/__tests__/namespace-transformer.test.ts** — Test cases per spec: tool name with prefix and `/` separator; tool name with prefix and `_` separator; tool name with `null` prefix returns original; de-namespacing correctly strips prefix; de-namespacing handles tool names containing the separator character (splits on first occurrence); resource URI namespacing and de-namespacing; prompt name namespacing and de-namespacing. | Status: not_done

### 1.2 Glob Matcher

- [ ] **Implement src/glob-matcher.ts** — Create a function `globToRegExp(pattern: string): RegExp` that converts simple glob patterns to regular expressions. Support `*` (any sequence of characters), `?` (any single character), and `**` (treated same as `*` since tool names have no path separators). Literal characters must be regex-escaped. Keep it to ~20 lines as spec suggests. | Status: not_done

- [ ] **Implement `matchesGlob(name: string, pattern: string): boolean`** — Convenience function that compiles the glob to RegExp and tests against the name. Cache compiled RegExps for repeated patterns. | Status: not_done

- [ ] **Write src/__tests__/glob-matcher.test.ts** — Test cases per spec: `*` matches any string; `get_*` matches `get_weather`, `get_forecast`, does not match `set_weather`; `?` matches single character; literal string matches exactly; `**` behaves like `*`. | Status: not_done

### 1.3 Filter Engine

- [ ] **Implement src/filter-engine.ts** — Create a `FilterEngine` class or function that evaluates `FilterConfig` rules against a list of tool/resource/prompt definitions. Logic: if `include` is specified, only items matching at least one include pattern pass; then if `exclude` is specified, items matching any exclude pattern are removed; then if `predicate` is specified, items are further filtered by the predicate function. Use `glob-matcher.ts` for pattern matching. | Status: not_done

- [ ] **Write src/__tests__/filter-engine.test.ts** — Test cases per spec: include with exact name matches only the specified tool; include with glob `get_*` matches `get_weather` but not `set_weather`; exclude with exact name hides the specified tool; exclude with glob `drop_*` hides `drop_table` and `drop_index`; combined include and exclude (include `*`, exclude `drop_*`); predicate function receiving tool definition and returning boolean; empty filter config passes all tools; include with no matching tools returns empty list. | Status: not_done

### 1.4 Conflict Detector

- [ ] **Implement src/conflict-detector.ts** — Create a `ConflictDetector` that checks a combined list of namespaced names for duplicates. If two items share the same namespaced name, throw a `CollisionError` listing the conflicting names and their source upstreams. Also check aliases for conflicts with namespaced names. | Status: not_done

- [ ] **Define `CollisionError` class** — Extend `Error` with a `conflicts` property listing all conflicting names and their upstreams. Format the message as specified: `'Tool name collision detected: "search" is exposed by both upstream "github" and upstream "jira"'`. | Status: not_done

- [ ] **Write src/__tests__/conflict-detector.test.ts** — Test cases per spec: two tools with same namespaced name throws `CollisionError`; two tools with different namespaced names does not throw; alias conflicting with a namespaced name throws; disabled namespace on two upstreams with overlapping tool names throws. | Status: not_done

### 1.5 Route Table

- [ ] **Implement src/route-table.ts** — Create a `RouteTable` class backed by a `Map<string, RouteEntry>`. Provide methods: `build(upstreams)` to construct entries from all upstreams' tool lists after namespacing and filtering; `lookup(namespacedName): RouteEntry | null` for O(1) lookup; `rebuild()` to reconstruct after upstream changes; `addAlias(from, to)` to register alias entries; `getAll()` to return all route entries for `tools/list`. | Status: not_done

- [ ] **Implement `RouteEntry` interface** — Per spec: `namespacedName`, `upstreamName`, `originalName`, `isAlias`, `toolDefinition`. Alias entries have `isAlias: true` and the namespaced name they replace is removed from the table. | Status: not_done

- [ ] **Write src/__tests__/route-table.test.ts** — Test cases per spec: building from two upstreams with distinct prefixes produces correct entries; looking up a namespaced name returns correct upstream and original name; looking up unknown name returns null; rebuilding after upstream tool list change reflects new tools; alias entries replace namespaced entries. | Status: not_done

### 1.6 Alias Registry

- [ ] **Implement src/alias-registry.ts** — Create an `AliasRegistry` class that stores mappings from alias names to namespaced tool names. Support per-upstream aliases (added via `UpstreamBuilder.alias()`) and router-level aliases (added via `ToolRouter.alias()`). When the route table is built, aliases replace their target's namespaced name so only the alias appears in the tool list. | Status: not_done

- [ ] **Write src/__tests__/alias-registry.test.ts** — Test: registering an alias maps from-name to to-name; per-upstream alias prepends the upstream namespace to the target; router-level alias bypasses namespace; attempting to register two aliases to the same from-name throws an error. | Status: not_done

### 1.7 Upstream Connection

- [ ] **Implement src/upstream-connection.ts** — Create an `UpstreamConnection` class that wraps a single MCP `Client` instance for one upstream server. Manages: creating the transport (stdio via `StdioClientTransport`, HTTP via `StreamableHTTPClientTransport`, SSE via `SSEClientTransport`), connecting with `client.connect(transport)`, performing the `initialize` handshake, fetching and caching the tool list (`client.listTools()`), tracking connection status (`UpstreamStatus`), and closing the connection. | Status: not_done

- [ ] **Implement stdio transport creation** — For `{ type: 'stdio' }` config, use SDK's `StdioClientTransport` with `command`, `args`, `env`, and `cwd` from the upstream config. | Status: not_done

- [ ] **Implement HTTP transport creation** — For `{ type: 'http' }` config, use SDK's `StreamableHTTPClientTransport` with the `url` and optional `headers`. | Status: not_done

- [ ] **Implement SSE transport creation** — For `{ type: 'sse' }` config, use SDK's `SSEClientTransport` with the `url` and optional `headers`. | Status: not_done

- [ ] **Implement connect timeout** — Apply `connectTimeout` (default 30s) to the `client.connect()` call using `AbortController` and `Promise.race`. If exceeded, mark the upstream as failed. | Status: not_done

- [ ] **Implement tool list fetching and caching** — After connecting, call `client.listTools()` (handling pagination if upstream returns paginated results) and cache the full list. Provide a method to re-fetch and update the cache. | Status: not_done

- [ ] **Implement resource list fetching and caching** — After connecting, call `client.listResources()` (handling pagination) and cache the list. Only fetch if router has `aggregateResources: true`. | Status: not_done

- [ ] **Implement prompt list fetching and caching** — After connecting, call `client.listPrompts()` (handling pagination) and cache the list. Only fetch if router has `aggregatePrompts: true`. | Status: not_done

### 1.8 Upstream Manager

- [ ] **Implement src/upstream-manager.ts** — Create an `UpstreamManager` class that manages all `UpstreamConnection` instances. Provides: registering upstreams, connecting all upstreams concurrently (eager strategy), connecting individual upstreams on demand (lazy strategy), disconnecting all upstreams, and iterating over connected upstreams to build the aggregated lists. | Status: not_done

- [ ] **Implement eager connection strategy** — On `start()`, connect to all registered upstreams concurrently using `Promise.all()`. If any upstream fails to connect within its timeout, reject with an error listing the failed upstreams. | Status: not_done

- [ ] **Implement lazy connection strategy** — On `start()`, do not connect to any upstream. On first `tools/list`, connect to all upstreams. On first `tools/call` targeting a specific upstream, connect to that upstream if not already connected. | Status: not_done

### 1.9 Virtual Server

- [ ] **Implement src/virtual-server.ts** — Create a `VirtualServer` class that wraps the SDK's `Server` instance. Configure it with capabilities: `tools` (with `listChanged: true`), optionally `resources` (with `listChanged: true`, `subscribe: true`), and optionally `prompts` (with `listChanged: true`). Register request handlers for all MCP methods the router handles. | Status: not_done

- [ ] **Implement `tools/list` handler** — Iterate over all connected upstreams, read cached tool lists, apply filter engine, apply namespace transformer, apply alias registry, run conflict detector, and return the merged tool list. Support cursor-based pagination if `pageSize` is configured. | Status: not_done

- [ ] **Implement `tools/call` handler** — Look up the tool name in the route table. If not found, return JSON-RPC error `-32602` ("Unknown tool"). If the upstream is disconnected, return error `-32002` ("Upstream unavailable"). If connecting, wait up to `connectTimeout`. Strip the namespace prefix, forward `callTool()` to the upstream, and return the response. Apply `requestTimeout` using `AbortController`. | Status: not_done

- [ ] **Implement `ping` handler** — Respond directly without forwarding to upstreams. | Status: not_done

- [ ] **Implement `initialize` handler** — Respond with aggregated capabilities (tools always, resources and prompts conditionally) and router server info (name, version from `ToolRouterOptions`). | Status: not_done

### 1.10 ToolRouter Class

- [ ] **Implement src/tool-router.ts — constructor** — Accept `ToolRouterOptions`, store configuration, create internal instances of `UpstreamManager`, `RouteTable`, `NamespaceTransformer`, `FilterEngine`, `AliasRegistry`, `ConflictDetector`, `VirtualServer`. Default `separator` to `"/"`, `connectionStrategy` to `"eager"`, `aggregateResources` to `true`, `aggregatePrompts` to `true`, `pageSize` to `0`. | Status: not_done

- [ ] **Implement `addServer()` method** — Accept upstream name and `UpstreamConfig`. Register the upstream with `UpstreamManager`. Return an `UpstreamBuilder` instance for fluent configuration. Validate that the upstream name is unique. | Status: not_done

- [ ] **Implement `UpstreamBuilder` class** — Fluent builder returned by `addServer()`. Methods: `namespace(prefix)`, `filter(config)`, `exclude(toolNames)`, `include(patterns)`, `alias(from, to)`, `use(middleware)`, `filterResources(config)`, `filterPrompts(config)`. Each method stores configuration and returns `this` for chaining. If `namespace()` is not called, default prefix = upstream name. | Status: not_done

- [ ] **Implement `start()` method** — Connect to upstreams (eager or lazy), build the route table, check for collisions, start the virtual server on stdio transport (`StdioServerTransport`). Return a promise that resolves when the router is ready. | Status: not_done

- [ ] **Implement `stop()` method** — Stop accepting new requests, allow in-flight calls to complete (up to 10s grace period), close all upstream connections, send SIGTERM to stdio subprocesses (SIGKILL after 5s), close the virtual server transport, remove all event listeners. | Status: not_done

- [ ] **Implement `connect()` method** — Start the router and connect the virtual server to a specific transport instance (for in-memory transport in tests). | Status: not_done

- [ ] **Implement `createInMemoryTransports()` method** — Create a pair of linked `InMemoryTransport` instances from the SDK. Return `{ clientTransport, serverTransport }`. | Status: not_done

- [ ] **Implement `use()` method (global middleware)** — Register a global `MiddlewareFn` that applies to all tool calls. Store in registration order. | Status: not_done

- [ ] **Implement `alias()` method (router-level)** — Register a router-level alias mapping a short name to a namespaced tool name. | Status: not_done

- [ ] **Implement `tools` getter** — Return the current aggregated tool list as `ReadonlyArray<ToolDefinition & { namespacedName: string; upstream: string }>`. | Status: not_done

### 1.11 Separator Validation

- [ ] **Implement separator validation on upstream connect** — When an upstream connects and its tool list is enumerated, check each tool name for the separator character. If a tool name contains the separator, emit a warning via the `error` event with the tool name and a suggested action (change separator or alias the tool). The tool is still exposed. | Status: not_done

- [ ] **Validate separator length** — Ensure the separator is 1-2 characters. Reject invalid separators at construction time. | Status: not_done

### 1.12 Core Integration Tests

- [ ] **Write src/__tests__/integration.test.ts — end-to-end routing** — Create two mock upstream MCP servers with in-memory transports, each with 2-3 tools. Create a `ToolRouter`, add both upstreams with distinct prefixes. Start the router on in-memory transport. Connect a test client. Call `tools/list` and verify the merged, namespaced tool list. Call `tools/call` for tools on each upstream and verify responses. Verify upstream servers received de-namespaced tool names. | Status: not_done

- [ ] **Write integration test — unknown tool error** — Call `tools/call` with a tool name not in the route table. Verify JSON-RPC error `-32602` is returned with message "Unknown tool: <name>". | Status: not_done

- [ ] **Write integration test — upstream with zero tools** — Register an upstream that has no tools. Verify it does not cause errors and contributes nothing to the tool list. | Status: not_done

- [ ] **Write integration test — separator validation warning** — Register an upstream with a tool whose name contains the separator character. Verify a warning is emitted but the tool is still exposed. | Status: not_done

---

## Phase 2: Filtering, Aliasing, and Middleware (v0.2.0)

### 2.1 Advanced Filtering

- [ ] **Integrate filter engine into route table build** — When building the route table, apply each upstream's `FilterConfig` to its tool list before namespacing. Include patterns first, then exclude patterns, then predicate functions. | Status: not_done

- [ ] **Write integration test — selective forwarding** — Configure an upstream with include filter `['get_*']`. Verify `tools/list` only returns matching tools. Verify calling an excluded tool returns an error. | Status: not_done

- [ ] **Write integration test — combined include and exclude** — Configure include `['*']` and exclude `['drop_*', 'truncate_*']`. Verify dangerous tools are hidden, others exposed. | Status: not_done

- [ ] **Write integration test — predicate function filtering** — Configure a predicate that filters based on `tool.annotations?.readOnlyHint`. Verify only read-only tools are exposed. | Status: not_done

### 2.2 Aliasing Integration

- [ ] **Integrate alias registry into tool list and route table** — When building the aggregated tool list, replace namespaced names with their aliases. Ensure an aliased tool does not appear under both its alias and namespaced name. | Status: not_done

- [ ] **Implement per-upstream alias via UpstreamBuilder** — `UpstreamBuilder.alias(from, to)` registers an alias where `to` is the tool's original name on the upstream (before namespacing). The alias replaces the namespaced name. For example, `.alias('search', 'search_repositories')` on upstream `github` replaces `github/search_repositories` with `github/search`. | Status: not_done

- [ ] **Implement router-level alias** — `ToolRouter.alias(from, to)` where `to` is a fully namespaced name. The alias `from` replaces the namespaced name entirely (no prefix). | Status: not_done

- [ ] **Write integration test — per-upstream alias** — Configure `.alias('search', 'search_repositories')` on upstream `github`. Verify `tools/list` contains `github/search` but not `github/search_repositories`. Verify `tools/call` with `github/search` routes correctly. | Status: not_done

- [ ] **Write integration test — router-level alias** — Configure `router.alias('search_code', 'github/search_code')`. Verify `tools/list` contains `search_code` but not `github/search_code`. Verify routing works. | Status: not_done

### 2.3 Middleware Pipeline

- [ ] **Implement src/middleware-pipeline.ts** — Create a `MiddlewarePipeline` class that chains `MiddlewareFn` functions. Execute in registration order. Each middleware receives `(context, next)` where `next` calls the next middleware or the upstream. Support short-circuiting (returning without calling `next`). Support per-upstream middleware (runs before global middleware). | Status: not_done

- [ ] **Integrate middleware into tools/call handler** — Before forwarding a tool call to the upstream, pass the request through the middleware pipeline. After the upstream responds, pass the response back through the pipeline in reverse order. | Status: not_done

- [ ] **Write src/__tests__/middleware-pipeline.test.ts** — Test cases per spec: single middleware receives context and next, can modify arguments; single middleware can short-circuit by returning without calling next; multiple middleware execute in registration order; middleware error propagates to the caller; upstream-specific middleware runs before global middleware. | Status: not_done

- [ ] **Write integration test — middleware modifies arguments** — Register middleware that adds a default parameter. Verify the upstream receives the modified arguments. | Status: not_done

- [ ] **Write integration test — middleware short-circuits** — Register middleware that returns a cached response without calling `next()`. Verify the upstream is not called. | Status: not_done

### 2.4 Resource Aggregation

- [ ] **Implement `resources/list` handler in virtual server** — Iterate over all connected upstreams, read cached resource lists, apply resource filters, apply namespace transformer to resource URIs, and return the merged resource list. Support pagination. | Status: not_done

- [ ] **Implement `resources/read` handler** — Look up the namespaced URI, strip the prefix, forward `readResource()` to the correct upstream, and return the response with URIs re-prefixed. | Status: not_done

- [ ] **Implement `resources/templates/list` handler** — Return merged resource templates from all upstreams with namespaced URIs. | Status: not_done

- [ ] **Implement resource URI namespacing** — Apply prefix + separator to resource URIs (e.g., `repo://owner/name` becomes `github/repo://owner/name`). De-namespace on `resources/read`. | Status: not_done

- [ ] **Implement `aggregateResources: false` option** — When disabled, the virtual server does not declare the resources capability and does not register resources handlers. | Status: not_done

- [ ] **Implement `filterResources()` on UpstreamBuilder** — Apply `FilterConfig` to resource URIs using the same filter engine pattern as tools. | Status: not_done

- [ ] **Write integration test — resource aggregation** — Create upstream servers with resources. Verify `resources/list` returns namespaced URIs. Verify `resources/read` with a namespaced URI returns correct content. | Status: not_done

### 2.5 Prompt Aggregation

- [ ] **Implement `prompts/list` handler in virtual server** — Iterate over all connected upstreams, read cached prompt lists, apply prompt filters, apply namespace transformer to prompt names, and return the merged prompt list. Support pagination. | Status: not_done

- [ ] **Implement `prompts/get` handler** — Look up the namespaced prompt name, strip the prefix, forward `getPrompt()` to the correct upstream, and return the response. | Status: not_done

- [ ] **Implement `aggregatePrompts: false` option** — When disabled, the virtual server does not declare the prompts capability and does not register prompts handlers. | Status: not_done

- [ ] **Implement `filterPrompts()` on UpstreamBuilder** — Apply `FilterConfig` to prompt names using the same filter engine pattern as tools. | Status: not_done

- [ ] **Write integration test — prompt aggregation** — Create upstream servers with prompts. Verify `prompts/list` returns namespaced prompt names. Verify `prompts/get` with a namespaced name returns the correct prompt. | Status: not_done

---

## Phase 3: Notifications and Reconnection (v0.3.0)

### 3.1 Notification Relay

- [ ] **Implement src/notification-relay.ts** — Create a `NotificationRelay` that listens for upstream notifications and forwards them to the downstream client via the virtual server. | Status: not_done

- [ ] **Handle `notifications/tools/list_changed` from upstream** — Re-fetch the upstream's tool list via `client.listTools()`, replace the cached list, rebuild the route table, and send `notifications/tools/list_changed` to the downstream client. | Status: not_done

- [ ] **Handle `notifications/resources/list_changed` from upstream** — Re-fetch the upstream's resource list, replace cached list, rebuild the aggregated resource list, send `notifications/resources/list_changed` to downstream. | Status: not_done

- [ ] **Handle `notifications/resources/updated` from upstream** — Transform the resource URI with the namespace prefix and forward to the downstream client. | Status: not_done

- [ ] **Handle `notifications/prompts/list_changed` from upstream** — Re-fetch the upstream's prompt list, replace cached list, rebuild the aggregated prompt list, send `notifications/prompts/list_changed` to downstream. | Status: not_done

- [ ] **Forward `notifications/progress` from upstream** — Forward to the downstream client with the original progress token unchanged. | Status: not_done

- [ ] **Forward `notifications/message` from upstream** — Prepend the upstream name to the `logger` field (e.g., `"auth"` becomes `"github/auth"`) and forward to the downstream client. | Status: not_done

### 3.2 Notification Debouncing

- [ ] **Implement debouncing for list_changed notifications** — After receiving a `list_changed` notification from an upstream, wait 100ms before re-fetching. If additional notifications arrive during the wait, reset the timer. This prevents excessive re-fetching during bulk tool registration. | Status: not_done

- [ ] **Write test for debounce behavior** — Send multiple `list_changed` notifications in rapid succession (e.g., 5 within 50ms). Verify only one re-fetch occurs. | Status: not_done

### 3.3 Client-to-Server Notifications

- [ ] **Forward `notifications/cancelled` to correct upstream** — When the downstream client cancels a request, identify which upstream is handling that request (by request ID) and forward the cancellation. | Status: not_done

- [ ] **Forward `notifications/roots/list_changed` to all upstreams** — When the downstream client sends roots changed notification, forward it to all connected upstreams. | Status: not_done

### 3.4 Reconnection Logic

- [ ] **Implement automatic reconnection with exponential backoff** — When an upstream disconnects unexpectedly, change status to `'disconnected'`, emit upstream event, wait `initialDelayMs`, attempt reconnect. On success, change status to `'connected'`, re-fetch tool list, rebuild route table. On failure, multiply delay by `backoffMultiplier` (capped at `maxDelayMs`), schedule next attempt. After `maxAttempts` failures, change status to `'failed'`, remove tools from aggregated list, send `notifications/tools/list_changed` to downstream. | Status: not_done

- [ ] **Implement ReconnectConfig defaults** — Default: `enabled: true`, `maxAttempts: 10`, `initialDelayMs: 1000`, `maxDelayMs: 30000`, `backoffMultiplier: 2`. | Status: not_done

- [ ] **Handle tool calls during disconnection** — While an upstream is disconnected, its tools remain in the tool list. If a tool call targets a disconnected upstream, return JSON-RPC error `-32002` with message "Upstream '<name>' is unavailable". | Status: not_done

- [ ] **Handle tool calls during reconnection** — If the upstream status is `'connecting'` or `'reconnecting'`, wait for the connection to complete (up to `connectTimeout`), then forward the call or return an error. | Status: not_done

- [ ] **Emit upstream lifecycle events** — Emit `UpstreamEvent` for `connected`, `disconnected`, `reconnecting`, `reconnected`, `failed`, `tools_changed`, `resources_changed`, `prompts_changed`. | Status: not_done

### 3.5 Lazy Connection Strategy

- [ ] **Implement lazy connection for tools/list** — On first `tools/list` call, connect to all upstreams that are not yet connected. Wait for all connections to complete before returning the tool list. | Status: not_done

- [ ] **Implement lazy connection for tools/call** — On `tools/call` targeting an unconnected upstream, connect to that upstream before forwarding the call. | Status: not_done

- [ ] **Write integration test — lazy connection** — Configure router with `connectionStrategy: 'lazy'`. Verify no connections are made on `start()`. Verify first `tools/list` triggers connections. | Status: not_done

### 3.6 Notification Integration Tests

- [ ] **Write integration test — notification propagation** — Connect router to an upstream. Dynamically add a tool to the upstream, send `notifications/tools/list_changed`. Verify downstream receives `notifications/tools/list_changed`. Verify new tool appears in next `tools/list` call. | Status: not_done

- [ ] **Write integration test — upstream disconnection** — Connect router to two upstreams. Disconnect one. Verify calling a tool on the disconnected upstream returns an error. Verify tools from the connected upstream still work. | Status: not_done

- [ ] **Write integration test — reconnection** — Connect router to an upstream, disconnect it, verify reconnection is attempted and succeeds when upstream becomes available again. | Status: not_done

### 3.7 Progress and Cancellation

- [ ] **Implement progress token forwarding** — When downstream includes `_meta.progressToken` in `tools/call`, forward it to the upstream. When upstream sends `notifications/progress` with that token, relay to downstream unchanged. | Status: not_done

- [ ] **Implement cancellation forwarding** — When downstream sends `notifications/cancelled`, forward to the upstream handling that request. | Status: not_done

### 3.8 Additional MCP Method Handlers

- [ ] **Implement `resources/subscribe` handler** — Strip namespace prefix from resource URI and forward subscription to the correct upstream. | Status: not_done

- [ ] **Implement `resources/unsubscribe` handler** — Strip namespace prefix and forward unsubscription to the correct upstream. | Status: not_done

- [ ] **Implement `completion/complete` handler** — Route to the correct upstream based on the completion reference. | Status: not_done

- [ ] **Implement `logging/setLevel` handler** — Forward to all connected upstreams. | Status: not_done

---

## Phase 4: CLI and Configuration (v0.4.0)

### 4.1 Config Loader

- [ ] **Implement src/config-loader.ts** — Create a `ConfigLoader` that reads a JSON file from disk (`fs/promises.readFile`), parses it, validates it against the `RouterConfig` schema, and returns a validated config object. | Status: not_done

- [ ] **Implement environment variable interpolation** — Scan all string values in the config for `${VAR_NAME}` patterns. Replace with the corresponding `process.env` value. If the env var is not set, throw `ConfigError` listing the missing variable names. | Status: not_done

- [ ] **Implement configuration validation** — Validate all rules from spec: `router.name` is required and non-empty; `router.version` is required and non-empty; at least one upstream is required; each upstream has a unique name; each upstream has a valid transport; env vars exist. Throw `ConfigError` with descriptive messages. | Status: not_done

- [ ] **Define `ConfigError` class** — Extend `Error` with properties for the specific validation failures. | Status: not_done

- [ ] **Implement `ToolRouter.fromConfig(config)` static method** — Accept a `RouterConfig` object, create and configure a `ToolRouter` instance with all upstreams, filters, aliases, etc. Return the configured router. | Status: not_done

- [ ] **Implement `ToolRouter.fromConfigFile(filePath)` static method** — Load the config file using `ConfigLoader`, then call `fromConfig()`. | Status: not_done

- [ ] **Write src/__tests__/config-loader.test.ts** — Test: valid config parses correctly; missing `router.name` throws `ConfigError`; missing `router.version` throws; no upstreams throws; duplicate upstream name throws; invalid transport throws; `${VAR}` interpolation with existing env var works; `${VAR}` with missing env var throws; alias targets are stored (validated later at connection time). | Status: not_done

### 4.2 CLI

- [ ] **Implement src/cli.ts** — Parse CLI arguments using `node:util.parseArgs`. Support: `--config <path>` (required), `--transport <type>` (stdio|http, default stdio), `--port <port>` (default 3000), `--lazy`, `--no-resources`, `--no-prompts`, `--separator <char>`, `--verbose`, `--quiet`, `--version`, `--help`. | Status: not_done

- [ ] **Implement CLI --help output** — Print usage information matching the spec's CLI documentation. | Status: not_done

- [ ] **Implement CLI --version output** — Read version from package.json and print it. | Status: not_done

- [ ] **Implement CLI config loading and router startup** — Load the config file, apply CLI flag overrides (--lazy, --no-resources, --no-prompts, --separator), create the router via `ToolRouter.fromConfig()`, and start it. | Status: not_done

- [ ] **Implement CLI logging to stderr** — Log startup messages, upstream connection status, and errors to stderr (never stdout, since stdout is used for MCP stdio transport). Respect `--verbose` and `--quiet` flags. | Status: not_done

- [ ] **Implement CLI signal handling** — Handle SIGTERM and SIGINT by calling `router.stop()` and exiting with code 0. | Status: not_done

- [ ] **Implement CLI exit codes** — Code 0 for normal shutdown; code 1 for fatal errors (config not found, validation failed, all upstreams failed); code 2 for usage errors (invalid flags, missing --config). | Status: not_done

- [ ] **Add hashbang to cli.ts** — Add `#!/usr/bin/env node` to the top of `cli.ts` so it can be run directly as a binary. | Status: not_done

### 4.3 HTTP Transport for Virtual Server

- [ ] **Implement `listen(port?)` method on ToolRouter** — Start the virtual server on a Streamable HTTP transport. Use the SDK's `StreamableHTTPServerTransport`. Return `{ url: string, close: () => Promise<void> }`. Default port 3000. | Status: not_done

- [ ] **Implement CLI --transport http mode** — When `--transport http` is specified, call `router.listen(port)` instead of `router.start()`. Log the URL to stderr. | Status: not_done

### 4.4 Claude Desktop Integration

- [ ] **Write integration test — config file round-trip** — Write a JSON config file to a temp path. Load it with `ToolRouter.fromConfigFile()`. Verify the router is configured correctly (correct upstreams, namespaces, filters). | Status: not_done

---

## Phase 5: Metrics, Observability, and Polish (v0.5.0)

### 5.1 Metrics Collector

- [ ] **Implement src/metrics-collector.ts** — Create a `MetricsCollector` class that tracks per-upstream metrics: `callCount`, `errorCount`, rolling `avgLatencyMs`, `lastCallAt` timestamp, `reconnectAttempts`. Also track global metrics: `totalCalls`, `totalErrors`, `totalTools`, `totalResources`, `totalPrompts`, `uptimeMs`. | Status: not_done

- [ ] **Integrate metrics into tools/call handler** — Before forwarding, increment call count. After response, record latency and update average. On error, increment error count. Update `lastCallAt`. | Status: not_done

- [ ] **Implement `router.metrics` getter** — Return a `RouterMetrics` snapshot with all current metric values. | Status: not_done

- [ ] **Implement `router.upstreams` getter** — Return `ReadonlyArray<UpstreamInfo>` with per-upstream status, tool/resource/prompt counts, server info, and metrics. | Status: not_done

### 5.2 Events

- [ ] **Implement EventEmitter integration in ToolRouter** — Extend or compose `EventEmitter`. Implement `on(event, listener)` and `off(event, listener)` for `toolCall`, `upstream`, and `error` events. | Status: not_done

- [ ] **Emit `toolCall` events** — After each tool call completes (success or error), emit a `ToolCallEvent` with timestamp, tool name, upstream name, duration, isError, and optional error message. | Status: not_done

- [ ] **Emit `upstream` events** — Emit `UpstreamEvent` on state transitions: connected, disconnected, reconnecting, reconnected, failed, tools_changed, resources_changed, prompts_changed. | Status: not_done

- [ ] **Emit `error` events** — Emit on internal errors, collision detections during dynamic rebuild, and other unexpected failures. Include context (upstream name, tool name) when available. | Status: not_done

### 5.3 Pagination

- [ ] **Implement cursor-based pagination for tools/list** — When `pageSize > 0`, return at most `pageSize` tools per response with a cursor for the next page. The cursor is an opaque string encoding the offset. Subsequent `tools/list` calls with the cursor return the next page. | Status: not_done

- [ ] **Implement pagination for resources/list** — Same cursor-based pagination pattern as tools/list. | Status: not_done

- [ ] **Implement pagination for prompts/list** — Same cursor-based pagination pattern as tools/list. | Status: not_done

- [ ] **Write test for pagination** — Configure router with `pageSize: 2` and 5 tools. Verify first page returns 2 tools with a cursor. Verify second page returns 2 tools with another cursor. Verify third page returns 1 tool with no cursor. | Status: not_done

### 5.4 Subscription Forwarding

- [ ] **Implement resource subscription tracking** — Track which downstream subscriptions map to which upstream resources. When downstream subscribes, strip prefix and forward. When upstream sends `resources/updated`, re-prefix URI and forward. When downstream unsubscribes, strip prefix and forward. | Status: not_done

### 5.5 Request Timeout Handling

- [ ] **Implement request timeout with AbortController** — Apply `requestTimeout` (default 60s) to each `callTool()` request using `AbortController` and `Promise.race`. On timeout, return JSON-RPC error `-32001` ("Upstream '<name>' timed out after <ms>ms") and cancel the upstream request. | Status: not_done

- [ ] **Write test for request timeout** — Configure a short `requestTimeout`. Call a tool on an upstream that delays its response beyond the timeout. Verify the timeout error is returned. | Status: not_done

### 5.6 Error Forwarding

- [ ] **Forward upstream JSON-RPC errors to downstream** — When an upstream returns a JSON-RPC error in response to `tools/call`, forward the error (code, message, data) to the downstream client unchanged. | Status: not_done

- [ ] **Handle malformed upstream responses** — If the upstream returns a response that cannot be parsed, return JSON-RPC error `-32603` ("Malformed response from upstream '<name>'"). | Status: not_done

- [ ] **Write test for error forwarding** — Configure an upstream that returns a JSON-RPC error. Verify the downstream client receives the same error code and message. | Status: not_done

### 5.7 Graceful Shutdown

- [ ] **Implement in-flight request tracking** — Track currently in-flight tool call requests so `stop()` can wait for them to complete. | Status: not_done

- [ ] **Implement graceful shutdown with grace period** — On `stop()`, stop accepting new requests, wait for in-flight calls (up to 10s), close upstreams, send SIGTERM to stdio subprocesses (SIGKILL after 5s), close virtual server transport, remove listeners. | Status: not_done

- [ ] **Write test for graceful shutdown** — Start a tool call, call `stop()` concurrently. Verify the tool call completes before shutdown. | Status: not_done

---

## Phase 6: Edge Cases and Hardening

- [ ] **Write test — upstream tool name containing separator** — Register upstream with a tool named `"create/issue"` when separator is `"/"`. Verify namespacing produces `"github/create/issue"` and de-namespacing recovers `"create/issue"` correctly. | Status: not_done

- [ ] **Write test — router with zero upstreams** — Create a router with no upstreams. Verify `start()` succeeds and `tools/list` returns an empty list. | Status: not_done

- [ ] **Write test — very long tool names** — Register tools with very long names (1000+ characters). Verify namespace transformation works correctly. | Status: not_done

- [ ] **Write test — concurrent tool calls to different upstreams** — Issue multiple concurrent `tools/call` requests to different upstreams. Verify they execute independently and return correct results. | Status: not_done

- [ ] **Write test — concurrent tool calls to same upstream** — Issue multiple concurrent `tools/call` requests to the same upstream. Verify they are handled correctly. | Status: not_done

- [ ] **Write test — tools/list during upstream reconnection** — Trigger a reconnection, call `tools/list` during the reconnection. Verify the response uses the cached list or excludes the reconnecting upstream's tools. | Status: not_done

- [ ] **Write test — upstream with paginated tool lists** — Create a mock upstream that returns paginated `tools/list` responses. Verify the router fetches all pages. | Status: not_done

- [ ] **Write test — config file with missing env var** — Write a config with `${NONEXISTENT_VAR}`. Verify `ConfigError` is thrown listing the missing variable. | Status: not_done

- [ ] **Write test — multiple list_changed in rapid succession (debounce)** — Send 5 `list_changed` notifications within 50ms. Verify only one re-fetch occurs (debounce at 100ms). | Status: not_done

- [ ] **Write test — collision during dynamic rebuild** — After start, an upstream changes its tools in a way that creates a collision with another upstream. Verify the `error` event is emitted and the later upstream's conflicting tool is excluded. | Status: not_done

---

## Phase 7: Documentation and Publishing

- [ ] **Write README.md** — Cover: overview, installation, quick start with programmatic API, quick start with CLI, configuration file format, namespace and separator options, selective forwarding (include/exclude/predicate), tool aliasing, middleware, resource and prompt aggregation, connection management (eager/lazy/reconnection), metrics and events, Claude Desktop integration, API reference, examples from spec sections 23.1-23.4. | Status: not_done

- [ ] **Add JSDoc comments to all public API surfaces** — Document `ToolRouter`, `UpstreamBuilder`, all public methods, all exported types and interfaces with JSDoc comments. | Status: not_done

- [ ] **Bump version to target phase version** — Update `package.json` version according to the current implementation phase (0.1.0, 0.2.0, etc.). | Status: not_done

- [ ] **Verify full build and test suite passes** — Run `npm run build`, `npm run lint`, `npm run test`. All must pass before publishing. | Status: not_done

- [ ] **Verify package exports** — Confirm that `dist/index.js` exports `ToolRouter` and all public types. Confirm `dist/cli.js` is executable. Confirm `package.json` `bin` field points to `dist/cli.js`. | Status: not_done

- [ ] **Verify package contents** — Run `npm pack --dry-run` and confirm only `dist/` files are included (per `"files": ["dist"]` in package.json). No source files, test files, or spec files are included. | Status: not_done
