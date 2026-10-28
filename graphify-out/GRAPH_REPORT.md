# Graph Report - vps-mcp  (2026-10-28)

## Corpus Check
- 11 files · ~9,345 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 5 file(s) not represented in the graph (top: (none) 4, .example 1)

## Summary
- 176 nodes · 254 edges · 8 communities
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 18 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5b434148`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ops-tools.ts
- server.ts
- package.json
- ops-tools.test.js
- server.test.js
- DockerClient
- VPS Observer MCP
- compilerOptions

## God Nodes (most connected - your core abstractions)
1. `DockerClient` - 12 edges
2. `registerOpsTools()` - 12 edges
3. `createApp()` - 11 edges
4. `compilerOptions` - 10 edges
5. `VPS Observer MCP` - 9 edges
6. `DockerClientError` - 8 edges
7. `loadConfig()` - 7 edges
8. `scripts` - 6 edges
9. `ConfigurationError` - 6 edges
10. `log()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `createApp()` --calls--> `DockerClient`  [EXTRACTED]
  server.ts → docker-client.ts
- `createMcpServer()` --calls--> `registerOpsTools()`  [EXTRACTED]
  server.ts → ops-tools.ts
- `createApp()` --calls--> `loadOpsAllowlist()`  [EXTRACTED]
  server.ts → ops-tools.ts

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "ops-tools.ts"
Cohesion: 0.16
Nodes (18): appendCapped(), containerAllowedInError(), denied(), execRuleMatches(), formatContainersTable(), fs, fsPromises, globToRegExp() (+10 more)

### Community 1 - "server.ts"
Cohesion: 0.13
Nodes (27): loadOpsAllowlist(), ConfigurationError, createApp(), createAuthMiddleware(), createMcpServer(), createTrustBoundaryMiddleware(), crypto, { DockerClient } (+19 more)

### Community 2 - "package.json"
Cohesion: 0.07
Nodes (29): dependencies, express, express-rate-limit, @modelcontextprotocol/sdk, zod, description, devDependencies, @types/express (+21 more)

### Community 3 - "ops-tools.test.js"
Cohesion: 0.08
Nodes (12): @modelcontextprotocol/sdk, ALLOWED_ID, assert, { decodeDockerLogBuffer, decodeExecStream, normalizeContainer }, DENIED_ID, test, assert, {
  execRuleMatches,
  globToRegExp,
  isAllowed,
  loadOpsAllowlist,
  registerOpsTools,
  sanitizeOutput,
} (+4 more)

### Community 4 - "server.test.js"
Cohesion: 0.10
Nodes (10): assert, close(), {
  ConfigurationError,
  createApp,
  createMcpServer,
  loadConfig,
  sanitizeUntrustedText,
}, crypto, defaultAllowlist, http, listen(), request() (+2 more)

### Community 5 - "DockerClient"
Cohesion: 0.26
Nodes (7): decodeDockerLogBuffer(), decodeExecStream(), DockerClient, DockerClientError, http, normalizeContainer(), socketRequest()

### Community 6 - "VPS Observer MCP"
Cohesion: 0.12
Nodes (15): Arquitetura, Ferramentas expostas, Link para o agente MCP, Restringir permissões na VPS (opcional), Resumo para apresentação, Rotação do token, Subida local/na VPS, Validação (+7 more)

### Community 7 - "compilerOptions"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, module, moduleResolution, outDir, rootDir, skipLibCheck, strict (+3 more)

## Knowledge Gaps
- **76 isolated node(s):** `http`, `{ spawn }`, `fs`, `fsPromises`, `path` (+71 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 101 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@modelcontextprotocol/sdk` connect `ops-tools.test.js` to `server.ts`, `package.json`?**
  _High betweenness centrality (0.179) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `createApp()` (e.g. with `server.ts` and `securityHeaders()`) actually correct?**
  _`createApp()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `http`, `{ spawn }`, `fs` to the rest of the system?**
  _76 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.13054187192118227 - nodes in this community are weakly interconnected._
- **Why does `DockerClient` connect `DockerClient` to `server.ts`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Why does `zod` connect `ops-tools.ts` to `server.ts`, `package.json`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._