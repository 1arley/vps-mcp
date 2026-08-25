"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const {
  ConfigurationError,
  createApp,
  createMcpServer,
  loadConfig,
  sanitizeUntrustedText,
} = require("../server.js");

const TOKEN = "test-token-with-at-least-thirty-two-random-characters-123456";
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");

function validEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    PORT: "3000",
    AUTH_TOKEN_SHA256: TOKEN_HASH,
    MCP_ALLOWED_HOSTS: "mcp.example.test",
    MCP_ALLOWED_ORIGINS: "https://client.example.test",
    TRUST_PROXY_HOPS: "0",
    RATE_LIMIT_PER_MINUTE: "1000",
    ...overrides,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : String(options.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path || "/healthz",
        method: options.method || "GET",
        headers: {
          Host: "mcp.example.test",
          ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.once("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("configuracao falha fechada para segredo em texto puro e hosts ausentes", () => {
  assert.throws(
    () => loadConfig({ AUTH_TOKEN: TOKEN, MCP_ALLOWED_HOSTS: "mcp.example.test" }),
    ConfigurationError,
  );
  assert.throws(
    () => loadConfig({ AUTH_TOKEN_SHA256: TOKEN_HASH }),
    ConfigurationError,
  );
  assert.throws(
    () => loadConfig(validEnvironment({ MCP_ALLOWED_ORIGINS: "http://client.example.test" })),
    ConfigurationError,
  );
});

test("sanitizacao remove controles e mascara formatos comuns de segredo", () => {
  const sanitized = sanitizeUntrustedText(
    "\u001b[31merror\u001b[0m token=abc123 Authorization: Bearer super-secret\u0000",
  );
  assert.equal(sanitized.includes("\u001b"), false);
  assert.equal(sanitized.includes("abc123"), false);
  assert.equal(sanitized.includes("super-secret"), false);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("logs Docker permanecem fora da superficie MCP por padrao", () => {
  const gateway = {};
  const secureDefault = createMcpServer(gateway, { enableDockerLogs: false });
  const explicitOptIn = createMcpServer(gateway, { enableDockerLogs: true });
  assert.deepEqual(Object.keys(secureDefault._registeredTools), [
    "docker_containers",
    "runtime_info",
  ]);
  assert.equal("docker_logs" in explicitOptIn._registeredTools, true);
});

test("fronteiras HTTP validam host, origin e bearer antes do MCP", async (t) => {
  const gateway = {
    listContainers: async () => ({ containers: [] }),
    containerLogs: async () => ({ container: "app", logs: "ok", truncated: false }),
  };
  const app = createApp(loadConfig(validEnvironment()), { gateway });
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => close(server));

  const health = await request(port);
  assert.equal(health.status, 200);
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.equal(health.headers["x-powered-by"], undefined);

  const badHost = await request(port, { headers: { Host: "evil.example.test" } });
  assert.equal(badHost.status, 403);

  const badOrigin = await request(port, {
    path: "/mcp",
    method: "POST",
    headers: {
      Origin: "https://evil.example.test",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(badOrigin.status, 403);

  const missingAuth = await request(port, {
    path: "/mcp",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingAuth.status, 401);
  assert.match(missingAuth.headers["www-authenticate"], /^Bearer /);

  const wrongAuth = await request(port, {
    path: "/mcp",
    method: "POST",
    headers: {
      Authorization: `Bearer ${"x".repeat(64)}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(wrongAuth.status, 401);

  const getWithAuth = await request(port, {
    path: "/mcp",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(getWithAuth.status, 405);
  assert.equal(getWithAuth.headers.allow, "POST");

  const preflight = await request(port, {
    path: "/mcp",
    method: "OPTIONS",
    headers: { Origin: "https://client.example.test" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://client.example.test");
});

test("endpoint MCP completa o handshake stateless autenticado", async (t) => {
  const gateway = {
    listContainers: async () => ({ containers: [] }),
    containerLogs: async () => ({ container: "app", logs: "ok", truncated: false }),
  };
  const app = createApp(loadConfig(validEnvironment()), { gateway });
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => close(server));

  const response = await request(port, {
    path: "/mcp",
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "security-test", version: "1.0.0" },
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /vps-observer-mcp/);
  assert.equal(response.headers["mcp-session-id"], undefined);
});
