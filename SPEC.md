# mcp-tool-router -- Specification

## 1. Overview

`mcp-tool-router` is a programmatic router and aggregator for MCP (Model Context Protocol) servers. It connects to multiple upstream MCP servers as a client, merges their tools, resources, and prompts into a single unified namespace, and exposes the aggregated result as a virtual MCP server that downstream clients connect to. When the downstream client calls a tool, the router resolves which upstream server owns that tool, strips any namespace prefix, forwards the request to the correct upstream, and relays the response back. The downstream client sees one MCP server with one tool list, one resource list, and one prompt list -- it has no knowledge that multiple backends exist.

The gap this package fills is specific and well-validated. When an LLM agent or MCP host application (Claude Desktop, Cursor, Windsurf, custom agent frameworks) connects to many MCP servers simultaneously, two problems compound. First, every server's tool list is injected into the LLM's context window. A single MCP server typically exposes 5-20 tools with descriptions and JSON Schema input definitions. Ten servers produce 50-200 tool definitions consuming 30,000-70,000 tokens of context before the user types a single message. Claude Code issue #3036 documents this directly: users report 66,000+ tokens consumed by tool definitions alone. Second, tool names collide. Two servers that both expose a `search` tool or a `create_issue` tool force the host application to disambiguate, typically by prepending an ad-hoc prefix like `server1___search` -- a convention that is inconsistent across hosts, fragile, and not part of the MCP specification.

`mcp-tool-router` solves both problems at the protocol level. It sits between the LLM client and the upstream servers, acting as a reverse proxy. Tools from each upstream server are namespaced with a user-defined prefix and separator (e.g., `github/create_issue`, `jira/create_ticket`, `slack/send_message`), eliminating collisions by construction. Selective forwarding allows the router to expose only a subset of each upstream's tools -- hiding internal, dangerous, or redundant tools to reduce context bloat. The downstream client makes one connection to the router instead of N connections to N servers, simplifying host implementation and connection management.

The architecture mirrors patterns proven in adjacent domains. GraphQL federation merges multiple GraphQL subgraph schemas into a single supergraph served by a gateway router. Envoy and Kong reverse-proxy HTTP microservices behind a single ingress endpoint with path-based routing. gRPC service mesh proxies route RPCs to the correct backend service based on the fully qualified method name. `mcp-tool-router` applies the same principle to the MCP protocol: multiple MCP servers are composed behind a single virtual server, with prefix-based routing replacing path-based routing.

`mcp-tool-router` provides both a TypeScript/JavaScript API for programmatic use in agent frameworks and MCP host applications, and a CLI for running a standalone router from a declarative JSON configuration file. The API uses a fluent builder pattern for composing upstream servers with per-server namespacing, filtering, aliasing, and middleware. The CLI reads a configuration file that describes the upstream servers and their routing rules, starts the router as a stdio or Streamable HTTP MCP server, and manages upstream connections automatically.

---

## 2. Goals and Non-Goals

### Goals

- Provide a `ToolRouter` class that connects to multiple upstream MCP servers, aggregates their tools, resources, and prompts into a single virtual MCP server, and exposes the aggregated capabilities to a downstream MCP client over any supported transport (stdio, Streamable HTTP, in-memory).
- Support prefix-based namespacing for tools, resources, and prompts, with configurable prefix strings and separator characters, to eliminate name collisions across upstream servers by construction.
- Support selective forwarding: include/exclude patterns, glob matching, and predicate functions that control which tools, resources, and prompts from each upstream are exposed to the downstream client.
- Support tool aliasing: rename specific tools to provide clearer or shorter names without modifying the upstream server.
- Support tool call interception middleware: user-defined functions that can observe, modify, or short-circuit tool call requests before they are forwarded to the upstream server, and observe or modify responses before they are returned to the client.
- Propagate `notifications/tools/list_changed`, `notifications/resources/list_changed`, and `notifications/prompts/list_changed` from upstream servers to the downstream client, triggering the client to re-enumerate the aggregated lists.
- Provide a declarative JSON configuration file format for defining upstream servers and routing rules, suitable for use with the CLI.
- Provide a CLI (`mcp-tool-router`) that reads a configuration file and runs the router as a standalone MCP server, usable from `claude_desktop_config.json` or any MCP host that supports stdio or HTTP server configuration.
- Manage upstream connection lifecycle: connect on startup or lazily on first use, reconnect on failure with configurable backoff, health monitoring, and graceful shutdown.
- Provide per-upstream and per-tool metrics: call counts, latency histograms, error rates, and upstream availability status.
- Keep runtime dependencies minimal: depend only on `@modelcontextprotocol/sdk` for protocol types, client/server classes, and transport implementations.

### Non-Goals

- **Not a load balancer.** The router does not distribute requests for the same tool across multiple upstream servers. Each tool belongs to exactly one upstream. Load balancing across MCP server replicas is a deployment concern handled by infrastructure (e.g., Kubernetes services, HTTP load balancers in front of Streamable HTTP servers).
- **Not a rate limiter.** The router does not enforce request rate limits. Use `mcp-rate-guard` on the router's virtual server or on individual upstream servers for rate limiting.
- **Not a tool execution engine.** The router does not implement tool logic. It proxies tool calls to upstream servers that implement the actual tools. If all upstreams are unavailable, the tool call fails.
- **Not a caching layer.** The router does not cache tool call results. Each call is forwarded to the upstream server. Caching tool responses is application-specific and semantically dangerous for non-idempotent tools.
- **Not a schema transformation layer.** The router does not modify tool input schemas or output formats. It forwards the upstream's schema and response as-is (after prefix/alias transformations on the tool name).
- **Not an authentication proxy.** The router does not handle OAuth flows, API key rotation, or credential management for upstream servers. Transport-level authentication (headers, environment variables for stdio servers) is configured per-upstream and passed through without modification.
- **Not a general-purpose MCP server framework.** Building MCP servers with custom tool implementations belongs to `@modelcontextprotocol/sdk`'s `Server` and `McpServer` classes. The router only aggregates existing servers.

---

## 3. Target Users and Use Cases

### Agent Framework Developers

Developers building agentic systems (LangChain, AutoGen, CrewAI, custom orchestrators) that connect to multiple MCP servers need to present a unified tool list to the LLM. Without a router, the framework must manage N client connections, handle tool name deduplication, and route tool calls to the correct server -- all of which is framework-specific boilerplate. A router provides this as a reusable library with a clean API, allowing the framework to connect to one MCP server and receive all tools from all backends.

### MCP Host Application Developers

Teams building MCP host applications (Claude Desktop plugins, Cursor extensions, VS Code extensions, custom AI interfaces) that support user-configured MCP servers need to aggregate tools from the user's server list. The router provides programmatic aggregation with namespace isolation, reducing the host's implementation complexity from "manage N connections and deduplicate tool names" to "connect to one router."

### Enterprise Platform Teams

Enterprise teams deploying AI assistants connected to internal MCP servers (database access, ticketing systems, monitoring, deployment pipelines) need to control which tools are exposed to which agents. A router with selective forwarding acts as a policy enforcement point: the platform team configures the router to expose only approved tools from each upstream, and agents connect to the router without direct access to internal servers.

### Individual Developers and Power Users

Developers using Claude Desktop or Cursor with many MCP servers experience context window bloat from large tool lists. A router configured in `claude_desktop_config.json` replaces multiple server entries with a single router entry, reducing context consumption by exposing only the tools the user actually needs and hiding internal or rarely used tools.

### CI/CD and Testing Environments

Test harnesses that need to simulate a multi-server environment can use the router to aggregate multiple `mcp-server-mock` instances behind a single connection, simplifying test client setup.

---

## 4. Core Concepts

### Upstream Server

An upstream server is an MCP server that the router connects to as a client. The router maintains one `Client` connection per upstream server. Each upstream is identified by a user-assigned name (e.g., `"github"`, `"jira"`, `"postgres"`), which serves as the namespace prefix for that upstream's tools, resources, and prompts. The upstream can be accessed over any MCP transport: stdio (spawning a subprocess), Streamable HTTP (connecting to a URL), or in-memory (for testing).

### Virtual Server

The virtual server is the MCP server that the router exposes to downstream clients. It is implemented using the SDK's `Server` class and supports all standard MCP capabilities: `tools`, `resources`, and `prompts`, with `listChanged` enabled for all three. The virtual server's tool list is the union of all upstream servers' tool lists, with names transformed according to namespacing and aliasing rules. The virtual server has no tools of its own -- every tool call is forwarded to an upstream.

### Namespace Prefix

A namespace prefix is a string prepended to every tool, resource URI, and prompt name from a specific upstream server. Combined with a separator character, it produces qualified names like `github/create_issue` or `postgres.run_query`. The prefix disambiguates tools that would otherwise collide (e.g., `github/search` vs. `jira/search`). When the router receives a tool call for `github/create_issue`, it strips the prefix to recover the original name `create_issue` and forwards the call to the `github` upstream.

### Separator

The separator is the character placed between the namespace prefix and the original tool name. The default separator is `/` (forward slash), producing names like `github/create_issue`. Alternative separators include `_` (underscore), `.` (dot), and `__` (double underscore). The separator must not appear in any upstream's tool names to avoid ambiguity. The router validates this at connection time and reports a warning if a tool name contains the separator character.

### Selective Forwarding

Selective forwarding controls which tools, resources, and prompts from each upstream are exposed through the virtual server. Each upstream can be configured with:

- **Include filters**: Only tools matching the filter are exposed. Tools not matching are hidden.
- **Exclude filters**: Tools matching the filter are hidden. All others are exposed.
- **Predicate functions**: A function that receives the tool definition and returns `true` to include or `false` to exclude.

Filters support exact name matching and glob patterns (e.g., `"get_*"` matches `get_weather`, `get_forecast`). Include and exclude filters can be combined: include is applied first, then exclude removes from the included set.

### Tool Aliasing

Tool aliasing renames a specific tool without modifying the upstream server. An alias maps a custom name to an upstream tool's namespaced name. For example, aliasing `search` to `github/search_repositories` allows the downstream client to call `search` instead of the longer namespaced name. Aliases are registered on the router and take priority over namespaced names. An aliased tool does not also appear under its namespaced name (to avoid duplicate tool definitions in the context window).

### Interception Middleware

Interception middleware is a function that sits in the tool call pipeline between the downstream client and the upstream server. Middleware can:

- **Observe** requests and responses for logging, metrics, or auditing.
- **Modify** request arguments before forwarding (e.g., inject default parameters, sanitize inputs).
- **Modify** responses before returning to the client (e.g., redact sensitive data).
- **Short-circuit** a request by returning a response without forwarding to the upstream (e.g., cached responses, access control rejections).

Middleware follows the standard `(request, next) => response` pattern, where `next` is a function that forwards the request to the next middleware or the upstream server.

### MCP Protocol Lifecycle

Every MCP session follows a three-phase lifecycle. The router participates in two concurrent lifecycles: as a server for the downstream client, and as a client for each upstream server.

1. **Initialization (downstream)**: The downstream client sends `initialize` to the router's virtual server. The router responds with its aggregated capabilities (derived from upstream capabilities) and server info.

2. **Initialization (upstream)**: The router connects to each upstream server, performing the `initialize` / `notifications/initialized` handshake as an MCP client. The router discovers each upstream's capabilities (tools, resources, prompts) and applies namespacing and filtering rules to build the aggregated tool list.

3. **Operation**: The downstream client enumerates tools (`tools/list`), calls tools (`tools/call`), lists resources (`resources/list`), reads resources (`resources/read`), lists prompts (`prompts/list`), and retrieves prompts (`prompts/get`). The router dispatches each request to the correct upstream based on the namespace prefix.

4. **Shutdown**: The downstream client closes its connection. The router closes all upstream client connections and releases resources.

### MCP Methods Handled

The router handles the following MCP methods from the downstream client:

| Method | Behavior |
|--------|----------|
| `initialize` | Responds with aggregated capabilities and router's server info. |
| `ping` | Responds directly (does not forward to upstreams). |
| `tools/list` | Returns the merged, namespaced, filtered tool list from all upstreams. Supports pagination. |
| `tools/call` | Routes to the correct upstream based on tool name prefix. Strips prefix before forwarding. |
| `resources/list` | Returns the merged, namespaced resource list from all upstreams. Supports pagination. |
| `resources/read` | Routes to the correct upstream based on resource URI prefix. Strips prefix before forwarding. |
| `resources/templates/list` | Returns merged resource templates from all upstreams. |
| `resources/subscribe` | Forwards subscription to the correct upstream. |
| `resources/unsubscribe` | Forwards unsubscription to the correct upstream. |
| `prompts/list` | Returns the merged, namespaced prompt list from all upstreams. Supports pagination. |
| `prompts/get` | Routes to the correct upstream based on prompt name prefix. Strips prefix before forwarding. |
| `completion/complete` | Routes to the correct upstream based on the completion reference. |
| `logging/setLevel` | Forwards to all upstreams. |

### MCP Notifications Propagated

| Upstream Notification | Router Behavior |
|----------------------|-----------------|
| `notifications/tools/list_changed` | Re-fetches the upstream's tool list, rebuilds the aggregated list, sends `notifications/tools/list_changed` to the downstream client. |
| `notifications/resources/list_changed` | Re-fetches the upstream's resource list, rebuilds the aggregated list, sends `notifications/resources/list_changed` to the downstream client. |
| `notifications/resources/updated` | Transforms the resource URI with the namespace prefix and forwards to the downstream client. |
| `notifications/prompts/list_changed` | Re-fetches the upstream's prompt list, rebuilds the aggregated list, sends `notifications/prompts/list_changed` to the downstream client. |
| `notifications/progress` | Forwards to the downstream client with the original progress token. |
| `notifications/message` | Forwards to the downstream client, prepending the upstream name to the logger field. |

---

## 5. Architecture

### System Topology

```
                    ┌───────────────────────────────────────────────┐
                    │               mcp-tool-router                 │
                    │              (Virtual Server)                  │
                    │                                               │
  Downstream        │  ┌─────────────────────────────────────────┐  │
  Client            │  │           Route Table                   │  │
  (LLM/Agent)  ◄───►│  │                                         │  │
                    │  │  github/create_issue  → upstream:github  │  │
                    │  │  github/search        → upstream:github  │  │
                    │  │  jira/create_ticket   → upstream:jira   │  │
                    │  │  postgres/query       → upstream:pg     │  │
                    │  │  slack/send_message   → upstream:slack  │  │
                    │  │                                         │  │
                    │  └─────────────┬───────────────────────────┘  │
                    │                │                               │
                    │      ┌─────────┼─────────┬──────────┐         │
                    │      ▼         ▼         ▼          ▼         │
                    │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
                    │  │ Client │ │ Client │ │ Client │ │ Client │  │
                    │  │(github)│ │ (jira) │ │  (pg)  │ │(slack) │  │
                    │  └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘  │
                    └──────┼──────────┼──────────┼──────────┼───────┘
                           │          │          │          │
                           ▼          ▼          ▼          ▼
                      ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
                      │ GitHub │ │  Jira  │ │Postgres│ │ Slack  │
                      │  MCP   │ │  MCP   │ │  MCP   │ │  MCP   │
                      │ Server │ │ Server │ │ Server │ │ Server │
                      └────────┘ └────────┘ └────────┘ └────────┘
```

### Internal Components

```
ToolRouter
  │
  ├── VirtualServer          SDK Server instance exposed to downstream client
  │     │
  │     ├── ToolsHandler         Handles tools/list, tools/call from downstream
  │     ├── ResourcesHandler     Handles resources/list, resources/read from downstream
  │     ├── PromptsHandler       Handles prompts/list, prompts/get from downstream
  │     └── NotificationRelay    Forwards upstream notifications to downstream
  │
  ├── UpstreamManager        Manages lifecycle of upstream client connections
  │     │
  │     ├── UpstreamConnection   Per-upstream: Client instance, transport, state
  │     │     ├── reconnection backoff
  │     │     ├── health status tracking
  │     │     └── capability cache (tools, resources, prompts)
  │     │
  │     └── ConnectionPool       Lazy or eager connection initialization
  │
  ├── RouteTable             Maps namespaced names to upstream + original name
  │     │
  │     ├── ToolRoute            { namespacedName, upstreamName, originalName }
  │     ├── ResourceRoute        { namespacedUri, upstreamName, originalUri }
  │     └── PromptRoute          { namespacedName, upstreamName, originalName }
  │
  ├── NamespaceTransformer   Applies prefix/separator to names, strips on forward
  │
  ├── FilterEngine           Evaluates include/exclude/predicate rules per upstream
  │
  ├── AliasRegistry          Maps alias names to route table entries
  │
  ├── MiddlewarePipeline     Chains interceptor functions for tool calls
  │
  ├── ConflictDetector       Detects and reports name collisions across upstreams
  │
  └── MetricsCollector       Per-upstream call counts, latency, error tracking
```

### Request Flow: `tools/list`

1. Downstream client sends `tools/list` to the virtual server.
2. The router's `ToolsHandler` iterates over all connected upstreams.
3. For each upstream, it reads the cached tool list (populated at connection time or after a `list_changed` notification).
4. For each tool, the `FilterEngine` evaluates whether the tool passes the upstream's include/exclude/predicate rules.
5. For each passing tool, the `NamespaceTransformer` prepends the upstream's prefix and separator to the tool name.
6. The `AliasRegistry` replaces any namespaced names that have aliases defined.
7. The `ConflictDetector` verifies no two tools share the same final name (this should never happen if namespacing is configured correctly, but is checked defensively).
8. The combined tool list is returned to the downstream client. If pagination is requested (cursor-based), the router paginates the merged list.

### Request Flow: `tools/call`

1. Downstream client sends `tools/call` with `{ name: "github/create_issue", arguments: { ... } }`.
2. The `ToolsHandler` looks up `github/create_issue` in the `RouteTable`.
3. The route entry identifies `upstream: "github"`, `originalName: "create_issue"`.
4. If the `AliasRegistry` has an entry for this name, it resolves the alias to the actual route.
5. The `MiddlewarePipeline` processes the request through all registered interceptors.
6. If no interceptor short-circuits, the handler constructs a `tools/call` request with `{ name: "create_issue", arguments: { ... } }` (prefix stripped).
7. The request is sent to the `github` upstream's `Client` instance via `client.callTool()`.
8. The upstream's response is passed back through the middleware pipeline (in reverse order).
9. The final response is returned to the downstream client.

### Request Flow: `resources/read`

1. Downstream client sends `resources/read` with `{ uri: "github/repo://owner/name" }`.
2. The `ResourcesHandler` looks up the URI in the `RouteTable` by matching the namespace prefix.
3. The route entry identifies the upstream and strips the prefix to recover the original URI `repo://owner/name`.
4. The request is forwarded to the upstream's `Client` via `client.readResource()`.
5. The response is returned to the downstream client with resource URIs re-prefixed for consistency.

### Notification Flow: Upstream `tools/list_changed`

1. An upstream server sends `notifications/tools/list_changed` to the router's client connection for that upstream.
2. The `NotificationRelay` handler triggers a re-fetch: the router calls `client.listTools()` on that upstream.
3. The upstream's cached tool list is replaced with the new list.
4. The `RouteTable` is rebuilt to reflect the updated tools.
5. The `FilterEngine` and `NamespaceTransformer` are re-applied.
6. The virtual server sends `notifications/tools/list_changed` to the downstream client.
7. The downstream client calls `tools/list` again to get the updated aggregated list.

---

## 6. API Surface

### Installation

```bash
npm install mcp-tool-router
```

### Peer Dependency

```json
{
  "peerDependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

### Main Export: `ToolRouter`

The primary API is a class with a fluent builder pattern for configuring upstream servers and routing rules.

```typescript
import { ToolRouter } from 'mcp-tool-router';

const router = new ToolRouter({
  name: 'my-router',
  version: '1.0.0',
});

router
  .addServer('github', {
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
  })
  .namespace('github')
  .filter({ include: ['create_issue', 'search_*', 'get_*'] });

router
  .addServer('postgres', {
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    env: { DATABASE_URL: process.env.DATABASE_URL! },
  })
  .namespace('pg')
  .exclude(['drop_table', 'truncate_table']);

router
  .addServer('slack', {
    transport: { type: 'http', url: 'http://localhost:3001/mcp' },
  })
  .namespace('slack');

await router.start();
// Router is now running as an MCP server on stdio
```

### Type Definitions

```typescript
// ── Router Configuration ─────────────────────────────────────────────

interface ToolRouterOptions {
  /** Name of the virtual server reported in initialize response. */
  name: string;

  /** Version of the virtual server reported in initialize response. */
  version: string;

  /**
   * Separator character placed between namespace prefix and tool name.
   * Default: '/' (forward slash).
   * Common alternatives: '_', '.', '__', '::'.
   */
  separator?: string;

  /**
   * Connection strategy for upstream servers.
   * 'eager': Connect to all upstreams on router.start().
   * 'lazy': Connect to each upstream on first use (first tools/list or tools/call).
   * Default: 'eager'.
   */
  connectionStrategy?: 'eager' | 'lazy';

  /**
   * Whether to enable resource aggregation.
   * If false, the virtual server does not declare the resources capability
   * and does not forward resources/list or resources/read.
   * Default: true.
   */
  aggregateResources?: boolean;

  /**
   * Whether to enable prompt aggregation.
   * If false, the virtual server does not declare the prompts capability
   * and does not forward prompts/list or prompts/get.
   * Default: true.
   */
  aggregatePrompts?: boolean;

  /**
   * Maximum number of tools to return per page in tools/list responses.
   * Set to 0 to disable pagination (return all tools in one response).
   * Default: 0 (no pagination).
   */
  pageSize?: number;

  /**
   * Protocol version to advertise to the downstream client.
   * Default: '2025-11-25' (latest stable).
   */
  protocolVersion?: string;
}

// ── Upstream Server Configuration ────────────────────────────────────

interface UpstreamConfig {
  /** Transport configuration for connecting to the upstream server. */
  transport: UpstreamTransportConfig;

  /**
   * Environment variables to set when spawning the upstream subprocess.
   * Only applicable for stdio transport.
   */
  env?: Record<string, string>;

  /**
   * Working directory for the upstream subprocess.
   * Only applicable for stdio transport.
   */
  cwd?: string;

  /**
   * HTTP headers to include when connecting to the upstream server.
   * Only applicable for http transport.
   */
  headers?: Record<string, string>;

  /**
   * Timeout in milliseconds for the initial connection to the upstream.
   * Default: 30_000 (30 seconds).
   */
  connectTimeout?: number;

  /**
   * Timeout in milliseconds for individual tool call requests forwarded
   * to this upstream.
   * Default: 60_000 (60 seconds).
   */
  requestTimeout?: number;

  /**
   * Reconnection configuration. If the upstream disconnects, the router
   * will attempt to reconnect with exponential backoff.
   */
  reconnect?: ReconnectConfig;
}

type UpstreamTransportConfig =
  | { type: 'stdio'; command: string; args?: string[] }
  | { type: 'http'; url: string }
  | { type: 'sse'; url: string };

interface ReconnectConfig {
  /**
   * Whether to automatically reconnect when the upstream disconnects.
   * Default: true.
   */
  enabled?: boolean;

  /**
   * Maximum number of reconnection attempts before giving up.
   * Set to Infinity for unlimited retries.
   * Default: 10.
   */
  maxAttempts?: number;

  /**
   * Initial delay in milliseconds before the first reconnection attempt.
   * Default: 1_000 (1 second).
   */
  initialDelayMs?: number;

  /**
   * Maximum delay in milliseconds between reconnection attempts.
   * The delay doubles on each attempt up to this maximum.
   * Default: 30_000 (30 seconds).
   */
  maxDelayMs?: number;

  /**
   * Multiplier applied to the delay on each successive attempt.
   * Default: 2.
   */
  backoffMultiplier?: number;
}

// ── Filter Configuration ─────────────────────────────────────────────

interface FilterConfig {
  /**
   * Include only tools matching these patterns. Supports exact names
   * and glob patterns (e.g., 'get_*', '*_query').
   * If specified, only matching tools are exposed.
   */
  include?: string[];

  /**
   * Exclude tools matching these patterns. Applied after include.
   * Tools matching exclude are hidden even if they match include.
   */
  exclude?: string[];

  /**
   * Predicate function for custom filtering logic.
   * Receives the tool definition and returns true to include, false to exclude.
   * Applied after include/exclude patterns.
   */
  predicate?: (tool: ToolDefinition) => boolean;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// ── Alias Configuration ──────────────────────────────────────────────

interface AliasConfig {
  /** The alias name that the downstream client will use. */
  from: string;

  /**
   * The namespaced tool name that this alias maps to.
   * Must be a valid namespaced name (e.g., 'github/create_issue').
   */
  to: string;
}

// ── Middleware ────────────────────────────────────────────────────────

interface ToolCallContext {
  /** The namespaced tool name as seen by the downstream client. */
  namespacedName: string;

  /** The original tool name on the upstream server. */
  originalName: string;

  /** The upstream server name. */
  upstreamName: string;

  /** The tool call arguments. */
  arguments: Record<string, unknown>;

  /** The tool definition from the upstream server. */
  toolDefinition: ToolDefinition;
}

interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

type MiddlewareFn = (
  context: ToolCallContext,
  next: () => Promise<ToolCallResult>,
) => Promise<ToolCallResult>;

// ── Upstream Status ──────────────────────────────────────────────────

type UpstreamStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed';

interface UpstreamInfo {
  /** The user-assigned upstream name. */
  name: string;

  /** Current connection status. */
  status: UpstreamStatus;

  /** Number of tools exposed through the router from this upstream. */
  toolCount: number;

  /** Number of resources exposed from this upstream. */
  resourceCount: number;

  /** Number of prompts exposed from this upstream. */
  promptCount: number;

  /** Server info reported by the upstream during initialization. */
  serverInfo?: { name: string; version: string };

  /** Total number of tool calls forwarded to this upstream. */
  callCount: number;

  /** Total number of tool call errors from this upstream. */
  errorCount: number;

  /** Average tool call latency in milliseconds. */
  avgLatencyMs: number;

  /** Timestamp of last successful tool call. */
  lastCallAt?: string;

  /** Number of reconnection attempts since last successful connection. */
  reconnectAttempts: number;
}

// ── Metrics ──────────────────────────────────────────────────────────

interface RouterMetrics {
  /** Total tool calls routed since router start. */
  totalCalls: number;

  /** Total tool call errors since router start. */
  totalErrors: number;

  /** Total tools currently exposed by the router. */
  totalTools: number;

  /** Total resources currently exposed by the router. */
  totalResources: number;

  /** Total prompts currently exposed by the router. */
  totalPrompts: number;

  /** Per-upstream metrics. */
  upstreams: Record<string, UpstreamInfo>;

  /** Router uptime in milliseconds. */
  uptimeMs: number;
}

// ── Events ───────────────────────────────────────────────────────────

interface ToolCallEvent {
  /** ISO 8601 timestamp. */
  timestamp: string;

  /** The namespaced tool name. */
  tool: string;

  /** The upstream server name. */
  upstream: string;

  /** Duration of the upstream call in milliseconds. */
  durationMs: number;

  /** Whether the call resulted in an error. */
  isError: boolean;

  /** Error message, if isError is true. */
  errorMessage?: string;
}

interface UpstreamEvent {
  /** ISO 8601 timestamp. */
  timestamp: string;

  /** The upstream server name. */
  upstream: string;

  /** The event type. */
  type: 'connected' | 'disconnected' | 'reconnecting' | 'reconnected' | 'failed' | 'tools_changed' | 'resources_changed' | 'prompts_changed';

  /** Human-readable message. */
  message: string;
}
```

### `ToolRouter` Class API

```typescript
class ToolRouter {
  constructor(options: ToolRouterOptions);

  // ── Upstream Registration (fluent) ──────────────────────────────────

  /**
   * Register an upstream MCP server.
   * Returns an UpstreamBuilder for configuring namespace, filters, and aliases.
   */
  addServer(name: string, config: UpstreamConfig): UpstreamBuilder;

  // ── Middleware ──────────────────────────────────────────────────────

  /**
   * Register a global middleware function for all tool calls.
   * Middleware is executed in registration order.
   */
  use(middleware: MiddlewareFn): ToolRouter;

  // ── Aliases ────────────────────────────────────────────────────────

  /**
   * Register a tool alias at the router level.
   * The alias maps a short name to a namespaced tool name.
   */
  alias(from: string, to: string): ToolRouter;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Start the router. Connects to upstream servers (if eager strategy)
   * and starts the virtual server on stdio transport.
   * Returns a promise that resolves when the router is ready.
   */
  start(): Promise<void>;

  /**
   * Start the router and listen on a Streamable HTTP transport.
   * Returns the URL and a close function.
   */
  listen(port?: number): Promise<{ url: string; close: () => Promise<void> }>;

  /**
   * Start the router and connect to a specific transport instance.
   * Useful for in-memory transports in tests.
   */
  connect(transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport): Promise<void>;

  /**
   * Create a pair of linked in-memory transports for testing.
   * Connect the router to serverTransport, the test client to clientTransport.
   */
  createInMemoryTransports(): {
    clientTransport: import('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport;
    serverTransport: import('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport;
  };

  /**
   * Stop the router. Disconnects from all upstream servers,
   * stops the virtual server, and releases all resources.
   */
  stop(): Promise<void>;

  // ── Inspection ─────────────────────────────────────────────────────

  /**
   * Get the current status of all upstream connections.
   */
  get upstreams(): ReadonlyArray<UpstreamInfo>;

  /**
   * Get the current metrics snapshot.
   */
  get metrics(): RouterMetrics;

  /**
   * Get the current aggregated tool list (as it would be returned to the client).
   */
  get tools(): ReadonlyArray<ToolDefinition & { namespacedName: string; upstream: string }>;

  // ── Events ─────────────────────────────────────────────────────────

  /**
   * Subscribe to router events.
   */
  on(event: 'toolCall', listener: (event: ToolCallEvent) => void): void;
  on(event: 'upstream', listener: (event: UpstreamEvent) => void): void;
  on(event: 'error', listener: (error: Error, context?: { upstream?: string; tool?: string }) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;

  // ── Configuration Loading ──────────────────────────────────────────

  /**
   * Create a ToolRouter from a declarative configuration object.
   * Used by the CLI to load config files.
   */
  static fromConfig(config: RouterConfig): ToolRouter;

  /**
   * Create a ToolRouter from a JSON configuration file.
   */
  static fromConfigFile(filePath: string): Promise<ToolRouter>;
}
```

### `UpstreamBuilder` API

```typescript
/**
 * Fluent builder returned by router.addServer().
 * Configures namespace, filters, aliases, and middleware for a single upstream.
 */
interface UpstreamBuilder {
  /**
   * Set the namespace prefix for this upstream's tools.
   * If not called, the upstream name is used as the prefix.
   * Pass null to disable namespacing for this upstream (tools are exposed
   * with their original names). Use with caution -- may cause collisions.
   */
  namespace(prefix: string | null): UpstreamBuilder;

  /**
   * Set include/exclude filters for this upstream's tools.
   */
  filter(config: FilterConfig): UpstreamBuilder;

  /**
   * Convenience: exclude specific tools by name.
   * Equivalent to filter({ exclude: toolNames }).
   */
  exclude(toolNames: string[]): UpstreamBuilder;

  /**
   * Convenience: include only specific tools by name or glob pattern.
   * Equivalent to filter({ include: patterns }).
   */
  include(patterns: string[]): UpstreamBuilder;

  /**
   * Register a tool alias for this upstream.
   * The alias 'from' replaces the namespaced name in the tool list.
   */
  alias(from: string, to: string): UpstreamBuilder;

  /**
   * Register middleware specific to this upstream's tool calls.
   * Upstream-specific middleware runs before global middleware.
   */
  use(middleware: MiddlewareFn): UpstreamBuilder;

  /**
   * Set filter configuration for this upstream's resources.
   * Only effective if aggregateResources is true on the router.
   */
  filterResources(config: FilterConfig): UpstreamBuilder;

  /**
   * Set filter configuration for this upstream's prompts.
   * Only effective if aggregatePrompts is true on the router.
   */
  filterPrompts(config: FilterConfig): UpstreamBuilder;
}
```

### Example: Basic Router with Three Upstreams

```typescript
import { ToolRouter } from 'mcp-tool-router';

const router = new ToolRouter({ name: 'dev-router', version: '1.0.0' });

router.addServer('github', {
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
});

router.addServer('filesystem', {
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/projects'] },
});

router.addServer('postgres', {
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
  env: { DATABASE_URL: process.env.DATABASE_URL! },
});

await router.start();

// Downstream client sees tools like:
//   github/create_issue, github/search_repositories, github/list_commits
//   filesystem/read_file, filesystem/write_file, filesystem/list_directory
//   postgres/query, postgres/list_tables, postgres/describe_table
```

### Example: Selective Forwarding

```typescript
const router = new ToolRouter({ name: 'safe-router', version: '1.0.0' });

router
  .addServer('postgres', {
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    env: { DATABASE_URL: process.env.DATABASE_URL! },
  })
  .namespace('db')
  .include(['query', 'list_tables', 'describe_table'])  // only read operations
  .exclude(['drop_*', 'truncate_*', 'delete_*']);         // extra safety

// Downstream client sees only: db/query, db/list_tables, db/describe_table
// Dangerous tools (drop_table, etc.) are never exposed
```

### Example: Tool Aliasing

```typescript
const router = new ToolRouter({ name: 'aliased-router', version: '1.0.0' });

router
  .addServer('github', {
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
  })
  .alias('search', 'search_repositories')   // downstream calls 'github/search' instead of 'github/search_repositories'
  .alias('create_pr', 'create_pull_request'); // shorter name

// Or router-level aliases that bypass the namespace:
router.alias('search_code', 'github/search_code');
// downstream calls 'search_code' directly without namespace prefix
```

### Example: Middleware

```typescript
const router = new ToolRouter({ name: 'logged-router', version: '1.0.0' });

// Global logging middleware
router.use(async (ctx, next) => {
  const start = Date.now();
  console.log(`[${ctx.upstreamName}] Calling ${ctx.originalName} with`, ctx.arguments);

  try {
    const result = await next();
    console.log(`[${ctx.upstreamName}] ${ctx.originalName} completed in ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.error(`[${ctx.upstreamName}] ${ctx.originalName} failed:`, error);
    throw error;
  }
});

// Access control middleware
router.use(async (ctx, next) => {
  if (ctx.toolDefinition.annotations?.destructiveHint) {
    return {
      content: [{ type: 'text', text: 'Error: Destructive tools are disabled by policy.' }],
      isError: true,
    };
  }
  return next();
});

router.addServer('github', { /* ... */ });
await router.start();
```

### Example: In-Memory Transport for Testing

```typescript
import { ToolRouter } from 'mcp-tool-router';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const router = new ToolRouter({ name: 'test-router', version: '1.0.0' });

router.addServer('mock', {
  transport: { type: 'stdio', command: 'node', args: ['./mock-server.js'] },
}).namespace('mock');

const { clientTransport, serverTransport } = router.createInMemoryTransports();
await router.connect(serverTransport);

const client = new Client({ name: 'test-client', version: '1.0.0' });
await client.connect(clientTransport);

const { tools } = await client.listTools();
// tools contains namespaced tools from all upstreams

const result = await client.callTool({ name: 'mock/some_tool', arguments: { key: 'value' } });
// result is proxied from the mock upstream

await client.close();
await router.stop();
```

---

## 7. Namespacing

### How Prefixes Work

When an upstream server is registered with a namespace prefix (which is the default -- the prefix defaults to the upstream name if `.namespace()` is not called), all of that upstream's tool names, resource URIs, and prompt names are prefixed before being exposed to the downstream client.

**Tool name transformation:**

```
Original name on upstream:  create_issue
Upstream name:              github
Separator:                  /
Namespaced name:            github/create_issue
```

**Resource URI transformation:**

```
Original URI on upstream:   repo://owner/name
Upstream name:              github
Separator:                  /
Namespaced URI:             github/repo://owner/name
```

**Prompt name transformation:**

```
Original name on upstream:  code_review
Upstream name:              github
Separator:                  /
Namespaced name:            github/code_review
```

### De-Namespacing on Forward

When the router receives a `tools/call` request for `github/create_issue`, it strips the prefix:

1. Split the namespaced name on the separator: `["github", "create_issue"]`.
2. The first segment is the upstream name. The remainder (joined by the separator, in case the original name contains the separator) is the original tool name.
3. Forward `tools/call` to the `github` upstream with `name: "create_issue"`.

### Separator Characters

The separator character determines how the namespace prefix is joined to the original name. The separator must be a string of 1-2 characters.

| Separator | Example | Notes |
|-----------|---------|-------|
| `/` (default) | `github/create_issue` | Most readable. Natural "category/action" syntax. |
| `_` | `github_create_issue` | Flat namespace. Risk of ambiguity if tool names contain underscores. |
| `.` | `github.create_issue` | Dot-notation. Clean but can conflict with file extension patterns. |
| `__` | `github__create_issue` | Double underscore. Low collision risk. Used by some MCP hosts. |
| `::` | `github::create_issue` | Scope resolution operator style. Clear but unusual in tool names. |

### Separator Validation

When an upstream connects and its tool list is enumerated, the router checks each tool name for the separator character. If a tool name contains the separator, the router emits a warning via the `error` event and the tool is still exposed, but the de-namespacing logic may produce incorrect results for that tool. The warning message includes the tool name and the suggested action (change the separator or alias the tool).

Example: If the separator is `/` and an upstream has a tool named `create/issue` (containing a slash), the namespaced name would be `github/create/issue`. When de-namespacing, the router splits on the first separator occurrence, producing upstream `github` and original name `create/issue`, which is correct. However, if the separator is `_` and a tool is named `create_issue`, the namespaced name would be `github_create_issue`. De-namespacing splits on the first `_`, producing upstream `github` and original name `create_issue`, which happens to be correct in this case. The router always splits on the first occurrence of the separator to handle these edge cases.

### Collision Detection

After namespacing and filtering are applied to all upstreams, the router checks the combined tool list for duplicate names. If two tools have the same namespaced name (which should not happen with unique prefix names, but can occur if an upstream is registered without a namespace or with an alias that conflicts), the router throws a `CollisionError` during `start()` with a message listing the conflicting names and their source upstreams.

```
CollisionError: Tool name collision detected:
  "search" is exposed by both upstream "github" and upstream "jira"
  Resolution: Use distinct namespace prefixes, or exclude one of the conflicting tools.
```

### Disabling Namespacing

Passing `null` to `.namespace(null)` disables namespacing for an upstream. Its tools are exposed with their original names. This is useful when an upstream has unique tool names that do not conflict with any other upstream. If a collision occurs, the `start()` call throws a `CollisionError`.

---

## 8. Selective Forwarding

### Include Patterns

Include patterns whitelist tools by name or glob pattern. When include patterns are specified, only tools whose original names (before namespacing) match at least one pattern are exposed. All other tools are hidden.

```typescript
router
  .addServer('postgres', config)
  .include(['query', 'list_*', 'describe_*']);
// Exposes: query, list_tables, list_indexes, describe_table
// Hides: drop_table, create_table, insert, update, delete
```

### Exclude Patterns

Exclude patterns blacklist tools. When exclude patterns are specified, tools whose original names match any exclude pattern are hidden. Exclude is applied after include.

```typescript
router
  .addServer('filesystem', config)
  .exclude(['write_*', 'delete_*', 'move_*']);
// Hides: write_file, delete_file, move_file
// Exposes: read_file, list_directory, get_info
```

### Combined Include and Exclude

When both include and exclude are specified, include is applied first to produce a candidate set, then exclude removes from that set.

```typescript
router
  .addServer('postgres', config)
  .filter({
    include: ['*'],         // start with everything
    exclude: ['drop_*', 'truncate_*'],  // remove dangerous operations
  });
```

### Glob Pattern Syntax

Glob patterns use the following syntax:

| Pattern | Matches |
|---------|---------|
| `*` | Any sequence of characters (non-greedy). `get_*` matches `get_weather`, `get_forecast`. |
| `?` | Any single character. `get_?` matches `get_a`, `get_b` but not `get_ab`. |
| `**` | Same as `*` (tool names do not have path separators, so `**` is equivalent to `*`). |

Patterns are matched against the tool's original name (before namespacing), not the namespaced name.

### Predicate Functions

For filtering logic that cannot be expressed as glob patterns, use a predicate function:

```typescript
router
  .addServer('postgres', config)
  .filter({
    predicate: (tool) => {
      // Only expose read-only tools
      if (tool.annotations?.readOnlyHint) return true;
      // Also expose tools whose names start with 'get_' or 'list_'
      if (tool.name.startsWith('get_') || tool.name.startsWith('list_')) return true;
      return false;
    },
  });
```

### Dynamic Filtering

Filters are evaluated each time the tool list is built (on `tools/list` calls and when upstream `list_changed` notifications arrive). This means predicate functions can implement dynamic filtering based on external state (e.g., feature flags, user permissions). However, predicate functions must be synchronous and fast -- they are called once per tool per list build.

### Resource and Prompt Filtering

The `filterResources` and `filterPrompts` methods on `UpstreamBuilder` use the same `FilterConfig` pattern as tool filtering, but applied to resources (matched by URI) and prompts (matched by name) respectively.

```typescript
router
  .addServer('filesystem', config)
  .filterResources({ include: ['file:///config/*'] })
  .filterPrompts({ exclude: ['internal_*'] });
```

---

## 9. Connection Management

### Connection Strategy

The router supports two connection strategies:

**Eager (default):** When `router.start()` is called, the router connects to all registered upstreams concurrently. `start()` resolves when all upstreams have connected and completed their `initialize` handshake. If any upstream fails to connect within its `connectTimeout`, `start()` rejects with an error listing the failed upstreams.

```typescript
const router = new ToolRouter({
  name: 'router',
  version: '1.0.0',
  connectionStrategy: 'eager',  // default
});
```

**Lazy:** Upstreams are connected on first use. When `router.start()` is called, no upstream connections are made. The first `tools/list` call triggers connection to all upstreams (since the tool list must include tools from all upstreams). The first `tools/call` for a specific upstream triggers connection to that upstream (if not already connected). Lazy connection reduces startup time when some upstreams are slow to initialize or may not be needed.

```typescript
const router = new ToolRouter({
  name: 'router',
  version: '1.0.0',
  connectionStrategy: 'lazy',
});
```

### Reconnection

When an upstream disconnects unexpectedly (transport closes, subprocess crashes, HTTP connection drops), the router automatically attempts to reconnect using exponential backoff.

**Reconnection flow:**

1. The upstream's status changes to `'disconnected'`.
2. The router emits an `upstream` event with `type: 'disconnected'`.
3. After `initialDelayMs`, the router attempts to reconnect.
4. If the reconnection succeeds, the upstream's status changes to `'connected'`, the tool list is re-fetched, and the aggregated list is rebuilt. The router emits `upstream` events for `'reconnected'` and potentially `'tools_changed'`.
5. If the reconnection fails, the delay is multiplied by `backoffMultiplier` (capped at `maxDelayMs`) and the next attempt is scheduled.
6. After `maxAttempts` failed reconnection attempts, the upstream's status changes to `'failed'`. The router emits an `upstream` event with `type: 'failed'`. The upstream's tools are removed from the aggregated list. The downstream client receives a `notifications/tools/list_changed`.

**During disconnection**, the upstream's tools remain in the aggregated tool list (the client can still see them in `tools/list`). If the client calls a tool belonging to the disconnected upstream, the router returns a JSON-RPC error with code `-32002` and a message indicating the upstream is unavailable.

### Health Monitoring

The router does not perform active health checks on upstreams (that is the domain of `mcp-healthcheck`). It relies on the transport layer to detect disconnections:

- **stdio**: The subprocess exits or closes stdout. Detected via the `close` event on the child process.
- **HTTP**: The HTTP connection fails or the server stops responding. Detected via transport error events.
- **In-memory**: The linked transport's `close()` is called. Detected via the `close` event on the transport.

### Graceful Shutdown

When `router.stop()` is called:

1. The virtual server stops accepting new requests.
2. In-flight tool calls are allowed to complete (up to a 10-second grace period).
3. All upstream client connections are closed via `client.close()`.
4. For stdio upstreams, the subprocess is sent `SIGTERM`, with `SIGKILL` after a 5-second grace period if still running.
5. The virtual server's transport is closed.
6. All event listeners are removed.

---

## 10. Tool Call Routing

### Route Table Construction

The route table is a map from namespaced tool names to route entries. Each entry contains:

```typescript
interface RouteEntry {
  /** The namespaced name as seen by the downstream client. */
  namespacedName: string;

  /** The upstream server name. */
  upstreamName: string;

  /** The original tool name on the upstream server. */
  originalName: string;

  /** Whether this entry is an alias. */
  isAlias: boolean;

  /** The full tool definition from the upstream. */
  toolDefinition: ToolDefinition;
}
```

The route table is rebuilt whenever:
- An upstream connects and its tool list is fetched.
- An upstream sends a `notifications/tools/list_changed` notification.
- An upstream disconnects or fails (its entries are removed).

### Route Resolution

When a `tools/call` request arrives:

1. Look up the tool name in the route table (O(1) Map lookup).
2. If found, extract the `upstreamName` and `originalName`.
3. If not found, return a JSON-RPC error with code `-32602` (`InvalidParams`) and message `"Unknown tool: <name>"`.

### Alias Resolution

Aliases are stored in the route table alongside namespaced names. An alias entry has `isAlias: true` and its `originalName` is the tool's actual name on the upstream, not the alias name. When a tool has an alias, only the alias appears in the route table -- the namespaced name is removed to avoid duplicate entries.

### Error Handling During Routing

| Failure | Router Behavior |
|---------|-----------------|
| Tool name not found in route table | Return JSON-RPC error `-32602`: "Unknown tool: \<name\>" |
| Upstream is disconnected | Return JSON-RPC error `-32002`: "Upstream '\<name\>' is unavailable" |
| Upstream is in `'connecting'` state | Wait for connection (up to `connectTimeout`), then forward or fail |
| Upstream tool call times out | Return JSON-RPC error `-32001`: "Upstream '\<name\>' timed out after \<ms\>ms" |
| Upstream returns JSON-RPC error | Forward the upstream's error to the downstream client |
| Upstream returns malformed response | Return JSON-RPC error `-32603` (`InternalError`): "Malformed response from upstream '\<name\>'" |

### Progress Token Forwarding

If the downstream client includes a `_meta.progressToken` in the `tools/call` request, the router forwards it to the upstream. When the upstream sends `notifications/progress` with that token, the router relays the notification to the downstream client unchanged. The progress token is opaque to the router.

### Cancellation Forwarding

If the downstream client sends `notifications/cancelled` for a request that was forwarded to an upstream, the router forwards the cancellation to the upstream. The upstream may or may not honor the cancellation.

---

## 11. Resource and Prompt Aggregation

### Resource Aggregation

Resources from each upstream are namespaced by prepending the upstream's prefix and separator to the resource URI. The original URI is preserved within the namespaced URI to allow de-namespacing on `resources/read`.

**Namespacing strategy for URIs:**

```
Original URI:     repo://owner/name
Upstream name:    github
Separator:        /
Namespaced URI:   github/repo://owner/name
```

When the downstream client sends `resources/read` with `uri: "github/repo://owner/name"`, the router strips the prefix to recover `repo://owner/name` and forwards to the `github` upstream.

Resource templates are similarly namespaced:

```
Original template:  file:///{path}
Upstream name:      filesystem
Namespaced:         filesystem/file:///{path}
```

**Subscription forwarding:** When the downstream client subscribes to a namespaced resource URI, the router strips the prefix and forwards the subscription to the correct upstream. When the upstream sends `notifications/resources/updated` for that resource, the router re-prefixes the URI and forwards the notification to the downstream client.

### Prompt Aggregation

Prompts from each upstream are namespaced identically to tools:

```
Original name:    code_review
Upstream name:    github
Separator:        /
Namespaced name:  github/code_review
```

When the downstream client sends `prompts/get` with `name: "github/code_review"`, the router strips the prefix and forwards to the `github` upstream.

### Disabling Aggregation

Resource and prompt aggregation can be disabled independently:

```typescript
const router = new ToolRouter({
  name: 'tools-only',
  version: '1.0.0',
  aggregateResources: false,  // virtual server does not declare resources capability
  aggregatePrompts: false,    // virtual server does not declare prompts capability
});
```

When aggregation is disabled, the virtual server does not declare the corresponding capability, and the downstream client will not attempt to enumerate resources or prompts.

---

## 12. Conflict Resolution

### Tool Name Conflicts

Tool name conflicts occur when two upstreams expose tools that would have the same namespaced name after prefix transformation. With distinct namespace prefixes, this is impossible (the prefixes guarantee uniqueness). Conflicts arise only when:

1. **Namespacing is disabled** for two or more upstreams (`.namespace(null)`) and their tool names overlap.
2. **Aliases** are misconfigured, mapping two different tools to the same alias name.
3. **A single upstream** has tools whose names collide with another upstream's namespaced names (highly unlikely).

### Detection

The router detects conflicts during route table construction. When a conflict is detected:

- During `start()`: The router throws a `CollisionError` listing all conflicting names.
- During dynamic route table rebuild (triggered by `tools/list_changed`): The router emits an `error` event with the `CollisionError` and excludes the conflicting tool from the later-registered upstream.

### Resolution Strategies

The router does not implement automatic conflict resolution. The user must resolve conflicts by:

1. **Using distinct namespace prefixes** (recommended). Each upstream gets a unique prefix.
2. **Excluding conflicting tools** from one upstream using `.exclude()`.
3. **Aliasing conflicting tools** to distinct names.

### Resource URI Conflicts

Resource URI conflicts follow the same pattern as tool name conflicts. With namespace prefixes, conflicts are impossible. Without namespacing, conflicting URIs cause a `CollisionError`.

### Prompt Name Conflicts

Same as tool name conflicts. Resolved the same way.

---

## 13. Notifications

### Upstream to Downstream Propagation

When an upstream server sends a `list_changed` notification, the router must update its aggregated list and notify the downstream client. The flow is:

1. **Receive notification** from upstream's MCP `Client` instance.
2. **Re-fetch the affected list** by calling `listTools()`, `listResources()`, or `listPrompts()` on the upstream's client.
3. **Replace the upstream's cached list** with the new data.
4. **Rebuild the route table** by re-applying namespace prefixes, filters, and aliases across all upstreams.
5. **Send the corresponding `list_changed` notification** to the downstream client via the virtual server.

### Debouncing

If an upstream sends multiple `list_changed` notifications in rapid succession (e.g., during startup when tools are registered one at a time), the router debounces the re-fetch. After receiving a `list_changed` notification, the router waits 100ms before re-fetching. If additional notifications arrive during the wait period, the timer resets. This prevents excessive re-fetching during bulk registration.

### Progress and Log Notifications

`notifications/progress` and `notifications/message` from upstreams are forwarded to the downstream client without modification, except:

- **`notifications/message`**: The `logger` field (if present) is prepended with the upstream name and a separator. For example, if the upstream `github` sends a log message with `logger: "auth"`, the router forwards it with `logger: "github/auth"`. This helps the downstream client identify which upstream produced the log message.

### Client-to-Server Notifications

Notifications sent from the downstream client to the virtual server are handled as follows:

| Client Notification | Router Behavior |
|--------------------|-----------------|
| `notifications/initialized` | Handled by the virtual server's Protocol layer. |
| `notifications/cancelled` | Forwarded to the upstream that is handling the cancelled request (identified by request ID). |
| `notifications/roots/list_changed` | Forwarded to all connected upstreams. |

---

## 14. Configuration

### Declarative Configuration Format

The router supports a JSON configuration file that describes the router options, upstream servers, and routing rules. This format is used by the CLI and can also be loaded programmatically via `ToolRouter.fromConfigFile()`.

```typescript
interface RouterConfig {
  /** Router options. */
  router: {
    name: string;
    version: string;
    separator?: string;
    connectionStrategy?: 'eager' | 'lazy';
    aggregateResources?: boolean;
    aggregatePrompts?: boolean;
    pageSize?: number;
  };

  /** Upstream server definitions. */
  upstreams: RouterConfigUpstream[];

  /** Global aliases. */
  aliases?: Array<{ from: string; to: string }>;
}

interface RouterConfigUpstream {
  /** Unique name for this upstream. */
  name: string;

  /** Transport configuration. */
  transport:
    | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { type: 'http'; url: string; headers?: Record<string, string> }
    | { type: 'sse'; url: string; headers?: Record<string, string> };

  /** Namespace prefix. Defaults to the upstream name. Use null to disable. */
  namespace?: string | null;

  /** Connection timeout in milliseconds. */
  connectTimeout?: number;

  /** Request timeout in milliseconds. */
  requestTimeout?: number;

  /** Reconnection configuration. */
  reconnect?: ReconnectConfig;

  /** Tool filter configuration. */
  tools?: {
    include?: string[];
    exclude?: string[];
  };

  /** Resource filter configuration. */
  resources?: {
    include?: string[];
    exclude?: string[];
  };

  /** Prompt filter configuration. */
  prompts?: {
    include?: string[];
    exclude?: string[];
  };

  /** Per-upstream aliases. Keys are alias names, values are original tool names. */
  aliases?: Record<string, string>;
}
```

### Example Configuration File

```json
{
  "router": {
    "name": "dev-tools",
    "version": "1.0.0",
    "separator": "/",
    "connectionStrategy": "eager"
  },
  "upstreams": [
    {
      "name": "github",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {
          "GITHUB_TOKEN": "${GITHUB_TOKEN}"
        }
      },
      "tools": {
        "include": ["create_issue", "search_*", "get_*", "list_*"],
        "exclude": ["get_secret_*"]
      },
      "aliases": {
        "search": "search_repositories"
      }
    },
    {
      "name": "filesystem",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
      },
      "tools": {
        "exclude": ["write_file", "move_file"]
      }
    },
    {
      "name": "slack",
      "transport": {
        "type": "http",
        "url": "http://localhost:3001/mcp",
        "headers": {
          "Authorization": "Bearer ${SLACK_TOKEN}"
        }
      },
      "namespace": "chat"
    }
  ],
  "aliases": [
    { "from": "send_message", "to": "chat/post_message" }
  ]
}
```

### Environment Variable Interpolation

String values in the configuration file that contain `${VAR_NAME}` are interpolated with the corresponding environment variable. If the environment variable is not set, the router throws a `ConfigError` at startup listing the missing variables. This allows sensitive credentials (tokens, database URLs) to be kept in environment variables rather than committed to configuration files.

### Configuration Validation

When a configuration file is loaded, the following validations are performed:

| Rule | Error |
|------|-------|
| `router.name` is required and non-empty | `ConfigError: router.name is required` |
| `router.version` is required and non-empty | `ConfigError: router.version is required` |
| At least one upstream is required | `ConfigError: at least one upstream is required` |
| Each upstream has a unique name | `ConfigError: duplicate upstream name: "<name>"` |
| Each upstream has a valid transport | `ConfigError: upstream "<name>" has invalid transport` |
| Environment variables in `${VAR}` syntax exist | `ConfigError: missing environment variable: VAR` |
| Alias targets reference valid namespaced names | Warning (not error), validated at connection time when tool lists are known |

---

## 15. CLI

### Installation and Invocation

```bash
# Global install
npm install -g mcp-tool-router
mcp-tool-router --config ./router.json

# npx (no install)
npx mcp-tool-router --config ./router.json

# Package script
# package.json: { "scripts": { "router": "mcp-tool-router --config ./router.json" } }
npm run router
```

### CLI Binary Name

`mcp-tool-router`

### Commands and Flags

```
mcp-tool-router [options]

Required:
  --config <path>            Path to the JSON configuration file.

Transport (how the router exposes itself to the downstream client):
  --transport <type>         Transport for the virtual server.
                             Values: stdio (default), http.
  --port <port>              Port for HTTP transport. Default: 3000.
                             Only applicable when --transport http.

Options:
  --lazy                     Use lazy connection strategy (override config).
  --no-resources             Disable resource aggregation (override config).
  --no-prompts               Disable prompt aggregation (override config).
  --separator <char>         Separator character (override config). Default: '/'.
  --verbose                  Enable verbose logging to stderr.
  --quiet                    Suppress all logging except errors.

Meta:
  --version                  Print version and exit.
  --help                     Print help and exit.
```

### Claude Desktop Integration

The router can be configured as a stdio MCP server in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dev-tools": {
      "command": "npx",
      "args": ["-y", "mcp-tool-router", "--config", "/path/to/router.json"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "DATABASE_URL": "postgresql://...",
        "SLACK_TOKEN": "xoxb-..."
      }
    }
  }
}
```

This replaces multiple server entries with a single router entry. Instead of:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"] },
    "slack": { "command": "npx", "args": ["-y", "mcp-server-slack"] }
  }
}
```

The router consolidates all four servers behind a single entry, reducing context window consumption and providing namespace isolation.

### Logging

The CLI logs to stderr (never stdout, since stdout is used for MCP stdio transport). Log levels:

- **quiet**: Only errors.
- **default**: Startup message, upstream connection status, errors.
- **verbose**: All of the above plus per-tool-call logs, notification propagation, route table rebuilds.

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Normal shutdown (received SIGTERM/SIGINT). |
| `1` | Fatal error (config file not found, config validation failed, all upstreams failed to connect). |
| `2` | Usage error (invalid flags, missing required flags). |

---

## 16. Error Handling

### Error Categories

| Category | Examples | Router Behavior |
|----------|----------|-----------------|
| **Configuration errors** | Invalid config file, missing environment variables, duplicate upstream names | Throw `ConfigError` during `start()` or CLI startup. Fail fast. |
| **Connection errors** | Upstream subprocess crash, HTTP connection refused, DNS failure | For eager strategy: `start()` rejects. For lazy: tool call returns error. Reconnection begins. |
| **Protocol errors** | Upstream rejects `initialize`, version mismatch | Upstream marked as `'failed'`. Its tools are removed from the aggregated list. |
| **Routing errors** | Unknown tool name, tool belongs to disconnected upstream | JSON-RPC error returned to the downstream client. |
| **Upstream errors** | Upstream tool call returns JSON-RPC error | Error forwarded to the downstream client as-is. |
| **Timeout errors** | Upstream tool call exceeds `requestTimeout` | JSON-RPC error `-32001` returned to the downstream client. |
| **Internal errors** | Bug in the router (unexpected exception in routing logic) | JSON-RPC error `-32603` returned. Error emitted via `error` event. |

### Partial Availability

The router supports partial availability: if some upstreams are connected and others are disconnected, the router continues to serve tools from the connected upstreams. The disconnected upstreams' tools remain in the tool list (with their status tracked internally) so the downstream client is aware of their existence, but calls to those tools return errors indicating the upstream is unavailable.

This design choice ensures that the downstream client's tool list is stable. If disconnected tools were removed from the list, the downstream client would receive `tools/list_changed` notifications every time an upstream disconnects and reconnects, causing the LLM to re-process the tool list frequently.

**Alternative (configurable):** A future version may add an option to remove disconnected upstreams' tools from the list entirely, for environments where the LLM should not attempt to call unavailable tools.

### Timeout Cascading

The router enforces timeouts at two levels:

1. **Upstream connection timeout** (`connectTimeout`): Applied during the initial `Client.connect()` call to the upstream. If exceeded, the upstream is marked as failed.
2. **Request timeout** (`requestTimeout`): Applied to each tool call forwarded to the upstream. Implemented using `AbortController` and `Promise.race`. If exceeded, the router returns a timeout error to the downstream client and cancels the upstream request.

The downstream client may also have its own timeout for the `tools/call` request. The router's `requestTimeout` should be shorter than the downstream client's timeout to ensure the router responds with a clean error rather than the downstream client experiencing a raw timeout.

### Error Forwarding

When an upstream returns a JSON-RPC error in response to a `tools/call`, the router forwards the error to the downstream client. The error `code`, `message`, and `data` are preserved. The router does not wrap or transform upstream errors -- the downstream client sees the same error it would see if it were connected directly to the upstream.

---

## 17. Metrics and Observability

### Per-Upstream Metrics

The `UpstreamInfo` object (accessible via `router.upstreams`) provides real-time metrics for each upstream:

- **`callCount`**: Total tool calls forwarded to this upstream since router start.
- **`errorCount`**: Total tool call errors from this upstream.
- **`avgLatencyMs`**: Rolling average latency of tool calls.
- **`lastCallAt`**: ISO 8601 timestamp of the last tool call.
- **`reconnectAttempts`**: Number of reconnection attempts since last successful connection.
- **`status`**: Current connection status.

### Global Metrics

The `router.metrics` property returns a snapshot of global metrics:

- **`totalCalls`**: Sum of all upstreams' call counts.
- **`totalErrors`**: Sum of all upstreams' error counts.
- **`totalTools`**: Number of tools currently exposed by the router.
- **`totalResources`**: Number of resources currently exposed.
- **`totalPrompts`**: Number of prompts currently exposed.
- **`uptimeMs`**: Milliseconds since `router.start()`.

### Events

The router emits events for monitoring integration:

```typescript
// Per-tool-call events
router.on('toolCall', (event) => {
  metrics.histogram('mcp.router.tool_call_duration_ms', event.durationMs, {
    upstream: event.upstream,
    tool: event.tool,
    error: String(event.isError),
  });
});

// Upstream lifecycle events
router.on('upstream', (event) => {
  if (event.type === 'disconnected') {
    alerting.warn(`Upstream ${event.upstream} disconnected: ${event.message}`);
  }
  if (event.type === 'failed') {
    alerting.critical(`Upstream ${event.upstream} failed permanently: ${event.message}`);
  }
});

// Internal errors
router.on('error', (error, context) => {
  logger.error({ error, ...context }, 'Router error');
});
```

### Integration with Monitoring Systems

The event-based API integrates with any monitoring system:

```typescript
// Prometheus
router.on('toolCall', (event) => {
  toolCallCounter.inc({ upstream: event.upstream, tool: event.tool });
  toolCallDuration.observe({ upstream: event.upstream }, event.durationMs);
});

// Structured logging
router.on('toolCall', (event) => {
  logger.info({ event }, 'Tool call routed');
});

// Health check endpoint
app.get('/health', (req, res) => {
  const m = router.metrics;
  const allConnected = router.upstreams.every(u => u.status === 'connected');
  res.status(allConnected ? 200 : 503).json({
    healthy: allConnected,
    upstreams: router.upstreams.map(u => ({ name: u.name, status: u.status })),
    totalTools: m.totalTools,
  });
});
```

---

## 18. Performance

### Routing Overhead

The router's hot path for a `tools/call` request consists of:

1. **Route table lookup**: One `Map.get()` call (~1 microsecond).
2. **Name de-namespacing**: One `String.indexOf()` and `String.slice()` (~1 microsecond).
3. **Middleware pipeline**: Depends on the number and complexity of middleware functions. Zero middleware = zero overhead. Each middleware adds one function call.
4. **Request forwarding**: Constructing the `callTool()` call to the upstream client (~5 microseconds).
5. **Response relay**: Returning the upstream's response to the downstream client (~5 microseconds).

**Total routing overhead (no middleware):** approximately 10-15 microseconds per tool call. This is negligible compared to the upstream tool execution time (typically milliseconds to seconds) and the network round-trip to the upstream (milliseconds for stdio, tens of milliseconds for HTTP).

### Tool List Aggregation

Building the aggregated tool list involves iterating over all upstreams' cached tool lists, applying filters, and transforming names. For a typical deployment (5 upstreams, 10 tools each = 50 tools), this takes under 1 millisecond. For extreme cases (20 upstreams, 100 tools each = 2,000 tools), it takes under 10 milliseconds. The aggregated list is cached and only rebuilt when an upstream's tool list changes.

### Connection Overhead

Each upstream connection maintains one MCP `Client` instance with its associated transport:

- **stdio**: One child process per upstream. Each process consumes OS-level resources (file descriptors, memory for the subprocess). Typical: 20-50 MB per subprocess (depends on the server implementation).
- **HTTP**: One persistent HTTP connection per upstream. Minimal overhead.
- **In-memory**: One pair of linked transports. Negligible overhead.

For deployments with many upstreams (10+), the subprocess count for stdio upstreams should be monitored. HTTP upstreams are more resource-efficient for large deployments.

### Message Passthrough

The router does not deserialize or re-serialize tool call arguments or results. It passes them through as opaque `Record<string, unknown>` objects. This avoids the overhead of deep-cloning large payloads (e.g., tools that return large text blocks or binary data).

### Benchmarks to Target

| Scenario | Target |
|----------|--------|
| Route table lookup for tool call | < 5 microseconds |
| Aggregated tool list build (50 tools, 5 upstreams) | < 1 millisecond |
| Aggregated tool list build (2,000 tools, 20 upstreams) | < 10 milliseconds |
| End-to-end tool call overhead (routing only, no upstream latency) | < 50 microseconds |
| Memory per upstream connection (stdio) | < 5 MB router-side (excludes subprocess) |
| Memory per upstream connection (HTTP) | < 1 MB |
| Startup time (5 eager upstreams, stdio) | < 10 seconds |

---

## 19. Testing Strategy

### Unit Tests

Unit tests cover each internal component in isolation with mock dependencies.

**NamespaceTransformer tests:**
- Tool name with prefix and `/` separator produces correct namespaced name.
- Tool name with prefix and `_` separator produces correct namespaced name.
- Tool name with `null` prefix returns original name unchanged.
- De-namespacing correctly strips prefix and recovers original name.
- De-namespacing handles tool names containing the separator character (splits on first occurrence).
- Resource URI namespacing and de-namespacing.
- Prompt name namespacing and de-namespacing.

**FilterEngine tests:**
- Include with exact name matches only the specified tool.
- Include with glob pattern `get_*` matches `get_weather` but not `set_weather`.
- Exclude with exact name hides the specified tool.
- Exclude with glob pattern `drop_*` hides `drop_table` and `drop_index`.
- Combined include and exclude: include `*`, exclude `drop_*` exposes everything except `drop_*`.
- Predicate function receiving tool definition and returning boolean.
- Empty filter config (no include, no exclude, no predicate) passes all tools.
- Include with no matching tools returns empty list.

**RouteTable tests:**
- Building route table from two upstreams with distinct prefixes produces correct entries.
- Looking up a namespaced name returns the correct upstream and original name.
- Looking up an unknown name returns null.
- Rebuilding the route table after an upstream's tool list changes reflects the new tools.
- Alias entries replace namespaced entries.

**ConflictDetector tests:**
- Two tools with the same namespaced name throws `CollisionError`.
- Two tools with different namespaced names does not throw.
- Alias conflicting with a namespaced name throws `CollisionError`.
- Disabled namespace on two upstreams with overlapping tool names throws `CollisionError`.

**MiddlewarePipeline tests:**
- Single middleware receives context and next, can modify arguments.
- Single middleware can short-circuit by returning without calling next.
- Multiple middleware execute in registration order.
- Middleware error propagates to the caller.
- Upstream-specific middleware runs before global middleware.

**GlobMatcher tests:**
- `*` matches any string.
- `get_*` matches `get_weather`, `get_forecast`, does not match `set_weather`.
- `?` matches single character.
- Literal string matches exactly.

### Integration Tests

Integration tests use real MCP `Server` and `Client` instances with in-memory transports.

**End-to-end routing test:**
- Create two mock upstream MCP servers, each with 2-3 tools.
- Create a `ToolRouter`, add both upstreams with distinct prefixes.
- Start the router on an in-memory transport.
- Connect a client to the router.
- Call `tools/list` and verify the merged, namespaced tool list.
- Call `tools/call` for a tool on upstream A and verify the response.
- Call `tools/call` for a tool on upstream B and verify the response.
- Verify the upstream servers received the de-namespaced tool names.

**Selective forwarding test:**
- Configure an upstream with include filter `['get_*']`.
- Verify `tools/list` only returns tools matching the pattern.
- Verify calling an excluded tool returns an error.

**Alias test:**
- Configure an alias `search` -> `github/search_repositories`.
- Verify `tools/list` contains `search` but not `github/search_repositories`.
- Verify `tools/call` with name `search` is routed to the correct upstream as `search_repositories`.

**Middleware test:**
- Register middleware that modifies tool call arguments.
- Verify the upstream receives the modified arguments.
- Register middleware that short-circuits with a cached response.
- Verify the upstream is not called.

**Notification propagation test:**
- Connect the router to an upstream.
- Dynamically add a tool to the upstream and send `notifications/tools/list_changed`.
- Verify the downstream client receives `notifications/tools/list_changed`.
- Verify the new tool appears in the next `tools/list` call.

**Upstream disconnection test:**
- Connect the router to two upstreams.
- Disconnect one upstream.
- Verify calling a tool on the disconnected upstream returns an error.
- Verify tools from the connected upstream still work.

**Resource aggregation test:**
- Create upstream servers with resources.
- Verify `resources/list` returns namespaced resource URIs.
- Verify `resources/read` with a namespaced URI returns the correct content.

**Prompt aggregation test:**
- Create upstream servers with prompts.
- Verify `prompts/list` returns namespaced prompt names.
- Verify `prompts/get` with a namespaced name returns the correct prompt.

### Edge Cases to Test

- Upstream tool name containing the separator character.
- Upstream with zero tools (should not cause errors, just contributes nothing to the list).
- Router with zero upstreams (should start but have empty tool list).
- Very long tool names (stress test name transformation).
- Concurrent `tools/call` requests to different upstreams (should be independent).
- Concurrent `tools/call` requests to the same upstream (should be serialized by the upstream's protocol layer).
- `tools/list` during an upstream reconnection (should return cached list or exclude reconnecting upstream's tools).
- Upstream that returns paginated tool lists (router should fetch all pages).
- Configuration file with `${VAR}` for a missing environment variable.
- Multiple `list_changed` notifications in rapid succession (debounce verification).

### Test Framework

Tests use Vitest, matching the project's existing configuration. Mock upstream MCP servers for integration tests are created using the `@modelcontextprotocol/sdk`'s `Server` class with in-memory transports.

---

## 20. Dependencies

### Runtime Dependencies

None beyond the peer dependency. The package uses only Node.js built-in modules:

| Module | Purpose |
|--------|---------|
| `node:events` | `EventEmitter` for `toolCall`, `upstream`, and `error` events |
| `node:child_process` | Spawning stdio upstream subprocesses (delegated to SDK's `StdioClientTransport`) |
| `node:path` | Resolving configuration file paths |
| `node:fs/promises` | Reading configuration files |
| `node:util` | `parseArgs` for CLI argument parsing (Node.js 18+) |

### Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | `^1.12.0` | Provides `Client`, `Server`, `StdioClientTransport`, `StdioServerTransport`, `StreamableHTTPClientTransport`, `StreamableHTTPServerTransport`, `SSEClientTransport`, `InMemoryTransport`, and all MCP type definitions |

### Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | `^5.5.0` | Type checking and compilation |
| `vitest` | `^2.0.0` | Test runner |
| `eslint` | `^9.0.0` | Linting |
| `@modelcontextprotocol/sdk` | `^1.12.0` | Used in integration tests to create mock upstream servers and test clients |

### Dependency Philosophy

Zero runtime dependencies beyond Node.js built-ins. This is a deliberate choice:

- **Routers must be reliable.** A router that fails to load because of a transitive dependency conflict prevents access to all upstream servers. Minimizing dependencies minimizes this risk.
- **The routing logic is simple.** Map lookups, string manipulation, and event emission do not require external libraries.
- **Glob matching is simple enough to implement inline.** Tool name glob patterns support only `*` and `?`, which can be implemented with a 20-line function that converts globs to regular expressions. A full `minimatch` or `micromatch` dependency is not justified.
- **The MCP SDK peer dependency is unavoidable.** The router acts as both an MCP client (connecting to upstreams) and an MCP server (serving the downstream client). Both roles require the SDK's `Client`, `Server`, and transport classes. Making it a peer dependency ensures the user controls the SDK version.

---

## 21. File Structure

```
mcp-tool-router/
  package.json
  tsconfig.json
  SPEC.md
  README.md
  src/
    index.ts                    Main entry point. Exports ToolRouter and all types.
    tool-router.ts              ToolRouter class. Fluent API, lifecycle, event emission.
    upstream-manager.ts         Manages upstream Client connections, reconnection, health.
    upstream-connection.ts      Per-upstream: Client instance, transport, state, cached lists.
    route-table.ts              Maps namespaced names to upstream + original name.
    namespace-transformer.ts    Applies/strips namespace prefix and separator.
    filter-engine.ts            Evaluates include/exclude/predicate rules.
    glob-matcher.ts             Converts glob patterns to RegExp for tool name matching.
    alias-registry.ts           Stores and resolves tool aliases.
    middleware-pipeline.ts      Chains interceptor functions for tool calls.
    conflict-detector.ts        Detects name collisions across upstreams.
    metrics-collector.ts        Per-upstream call counts, latency, error tracking.
    notification-relay.ts       Forwards upstream notifications to downstream.
    virtual-server.ts           Configures the SDK Server with aggregated handlers.
    config-loader.ts            Loads and validates JSON config files, env var interpolation.
    cli.ts                      Parses CLI args, loads config, starts the router.
    types.ts                    All TypeScript interfaces and type definitions.
  src/__tests__/
    namespace-transformer.test.ts
    filter-engine.test.ts
    glob-matcher.test.ts
    route-table.test.ts
    conflict-detector.test.ts
    middleware-pipeline.test.ts
    alias-registry.test.ts
    config-loader.test.ts
    integration.test.ts         End-to-end tests with real MCP servers and clients.
```

---

## 22. Implementation Roadmap

### Phase 1: Core Routing (v0.1.0)

Deliver the minimum viable router with tool aggregation and namespacing.

- `ToolRouter` class with `addServer()`, `namespace()`, `start()`, `stop()`.
- `UpstreamManager` with eager connection strategy.
- `NamespaceTransformer` with configurable separator.
- `RouteTable` construction from upstream tool lists.
- `tools/list` handler returning merged, namespaced tool list.
- `tools/call` handler with route lookup, prefix stripping, and upstream forwarding.
- `ConflictDetector` throwing `CollisionError` on duplicate names.
- Basic `FilterEngine` with include/exclude exact name matching.
- In-memory transport support via `createInMemoryTransports()`.
- stdio transport for the virtual server via `start()`.
- Full unit and integration test suite for core routing.
- README with basic usage examples.

### Phase 2: Filtering, Aliasing, and Middleware (v0.2.0)

Add selective forwarding, aliases, and middleware.

- Glob pattern support in `FilterEngine`.
- Predicate function support in `FilterEngine`.
- `AliasRegistry` with per-upstream and router-level aliases.
- `MiddlewarePipeline` with `(context, next) => result` pattern.
- `UpstreamBuilder` fluent API: `.filter()`, `.exclude()`, `.include()`, `.alias()`, `.use()`.
- Resource aggregation: `resources/list`, `resources/read` with namespacing.
- Prompt aggregation: `prompts/list`, `prompts/get` with namespacing.
- Resource and prompt filtering via `filterResources()` and `filterPrompts()`.

### Phase 3: Notifications and Reconnection (v0.3.0)

Add dynamic list updates, reconnection, and notification propagation.

- Upstream `notifications/tools/list_changed` handling with re-fetch and route table rebuild.
- Upstream `notifications/resources/list_changed` and `notifications/prompts/list_changed` handling.
- Notification debouncing (100ms).
- Progress and log notification forwarding.
- Cancellation forwarding.
- Automatic reconnection with exponential backoff.
- Lazy connection strategy.
- Upstream status tracking and `UpstreamInfo` reporting.

### Phase 4: CLI and Configuration (v0.4.0)

Add the CLI and declarative configuration file support.

- `RouterConfig` JSON format.
- `ToolRouter.fromConfig()` and `ToolRouter.fromConfigFile()`.
- Environment variable interpolation in config files.
- Configuration validation.
- CLI with `--config`, `--transport`, `--port`, `--verbose`, `--quiet` flags.
- Claude Desktop integration documentation.
- Streamable HTTP transport for the virtual server via `listen()`.

### Phase 5: Metrics, Observability, and Polish (v0.5.0)

Add production-readiness features.

- `MetricsCollector` with per-upstream call counts, latency, error rates.
- `router.metrics` property.
- `toolCall`, `upstream`, and `error` events.
- Pagination support for aggregated `tools/list`.
- Subscription forwarding for resources.
- Completion forwarding.
- Performance benchmarks and optimization.
- Comprehensive edge case tests.

---

## 23. Example Use Cases

### 23.1 Claude Desktop Power User

A developer uses Claude Desktop with five MCP servers: GitHub, filesystem, PostgreSQL, Slack, and a custom internal API. Without the router, all five servers are listed separately in `claude_desktop_config.json`, and all their tools (60+ combined) are injected into the context window.

**Before (claude_desktop_config.json):**
```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"] },
    "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"] },
    "slack": { "command": "npx", "args": ["-y", "mcp-server-slack"] },
    "internal": { "command": "node", "args": ["./internal-api-server.js"] }
  }
}
```

**After (claude_desktop_config.json):**
```json
{
  "mcpServers": {
    "tools": {
      "command": "npx",
      "args": ["-y", "mcp-tool-router", "--config", "/home/user/.config/mcp-router.json"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "DATABASE_URL": "postgresql://...",
        "SLACK_TOKEN": "xoxb-..."
      }
    }
  }
}
```

**Router config (/home/user/.config/mcp-router.json):**
```json
{
  "router": { "name": "dev-tools", "version": "1.0.0" },
  "upstreams": [
    {
      "name": "gh",
      "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
      "tools": { "include": ["create_issue", "search_repositories", "get_file_contents", "list_commits"] }
    },
    {
      "name": "fs",
      "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"] },
      "tools": { "exclude": ["move_file"] }
    },
    {
      "name": "db",
      "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"], "env": { "DATABASE_URL": "${DATABASE_URL}" } },
      "tools": { "include": ["query", "list_tables", "describe_table"] }
    },
    {
      "name": "chat",
      "transport": { "type": "stdio", "command": "npx", "args": ["-y", "mcp-server-slack"], "env": { "SLACK_TOKEN": "${SLACK_TOKEN}" } },
      "tools": { "include": ["send_message", "list_channels"] }
    }
  ]
}
```

Result: The tool list drops from 60+ tools to ~15 curated tools, each namespaced (`gh/create_issue`, `fs/read_file`, `db/query`, `chat/send_message`). Context usage drops proportionally.

### 23.2 Enterprise Agent Platform

An enterprise platform team deploys an AI assistant connected to internal services. Different teams own different MCP servers. The platform team uses the router as a policy enforcement point.

```typescript
import { ToolRouter } from 'mcp-tool-router';

const router = new ToolRouter({ name: 'enterprise-router', version: '2.0.0' });

// Engineering tools -- full access
router
  .addServer('jira', {
    transport: { type: 'http', url: 'https://jira-mcp.internal:3000/mcp' },
  })
  .namespace('jira');

// Database -- read-only access
router
  .addServer('warehouse', {
    transport: { type: 'http', url: 'https://warehouse-mcp.internal:3000/mcp' },
  })
  .namespace('warehouse')
  .filter({
    predicate: (tool) => tool.annotations?.readOnlyHint === true,
  });

// Deployment pipeline -- restricted tools
router
  .addServer('deploy', {
    transport: { type: 'http', url: 'https://deploy-mcp.internal:3000/mcp' },
  })
  .namespace('deploy')
  .include(['get_status', 'list_deployments', 'get_logs']);
  // deploy/rollback, deploy/promote are deliberately excluded

// Global audit middleware
router.use(async (ctx, next) => {
  auditLog.write({
    timestamp: new Date().toISOString(),
    tool: ctx.namespacedName,
    upstream: ctx.upstreamName,
    arguments: ctx.arguments,
    user: getCurrentUser(),
  });
  return next();
});

await router.listen(8080);
```

### 23.3 Testing Multi-Server Agent Behavior

An agent framework test creates multiple mock servers behind a router to test tool selection behavior.

```typescript
import { ToolRouter } from 'mcp-tool-router';
import { MockMCPServer } from 'mcp-server-mock';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Create mock upstreams
const weatherMock = new MockMCPServer({ name: 'weather', version: '1.0.0' });
weatherMock.tool('get_forecast', {
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}).returns({
  content: [{ type: 'text', text: '72F, sunny' }],
});

const calendarMock = new MockMCPServer({ name: 'calendar', version: '1.0.0' });
calendarMock.tool('get_events', {
  inputSchema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
}).returns({
  content: [{ type: 'text', text: 'Meeting at 2pm' }],
});

// Create router with mock upstreams (using in-memory transports)
const router = new ToolRouter({ name: 'test-router', version: '1.0.0' });

// Wire up mock servers to the router via in-memory transports
const weatherTransports = weatherMock.createInMemoryTransports();
await weatherMock.connect(weatherTransports.serverTransport);
router.addServer('weather', {
  transport: weatherTransports.clientTransport,
});

const calendarTransports = calendarMock.createInMemoryTransports();
await calendarMock.connect(calendarTransports.serverTransport);
router.addServer('calendar', {
  transport: calendarTransports.clientTransport,
});

// Connect test client to router
const { clientTransport, serverTransport } = router.createInMemoryTransports();
await router.connect(serverTransport);

const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(clientTransport);

// Verify aggregated tool list
const { tools } = await client.listTools();
assert(tools.some(t => t.name === 'weather/get_forecast'));
assert(tools.some(t => t.name === 'calendar/get_events'));

// Verify routing
const forecast = await client.callTool({ name: 'weather/get_forecast', arguments: { city: 'NYC' } });
assert.deepEqual(forecast.content, [{ type: 'text', text: '72F, sunny' }]);

// Verify upstream received the correct de-namespaced call
weatherMock.assertToolCalled('get_forecast', 1);
weatherMock.assertToolCalledWith('get_forecast', { city: 'NYC' });

await client.close();
await router.stop();
await weatherMock.close();
await calendarMock.close();
```

### 23.4 Dynamic Tool Availability with Notifications

A router monitors upstream server availability and dynamically updates the tool list.

```typescript
import { ToolRouter } from 'mcp-tool-router';

const router = new ToolRouter({
  name: 'dynamic-router',
  version: '1.0.0',
  connectionStrategy: 'eager',
});

router.addServer('primary-db', {
  transport: { type: 'stdio', command: 'node', args: ['./db-server.js'] },
  reconnect: {
    enabled: true,
    maxAttempts: Infinity,
    initialDelayMs: 2_000,
    maxDelayMs: 60_000,
  },
}).namespace('db');

router.addServer('search', {
  transport: { type: 'http', url: 'http://search-mcp:3000/mcp' },
  reconnect: { enabled: true, maxAttempts: 5 },
}).namespace('search');

// Monitor upstream health
router.on('upstream', (event) => {
  console.log(`[${event.timestamp}] ${event.upstream}: ${event.type} - ${event.message}`);
  if (event.type === 'failed') {
    // Alert on permanent failure
    pagerDuty.alert(`MCP upstream ${event.upstream} permanently failed`);
  }
});

// Track tool call latency
router.on('toolCall', (event) => {
  if (event.durationMs > 5_000) {
    console.warn(`Slow tool call: ${event.tool} on ${event.upstream} took ${event.durationMs}ms`);
  }
});

await router.start();
```
