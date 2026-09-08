"use strict";

const http = require("node:http");

const GATEWAY_SERVICE_NAME = process.env.SERVICE_NAME || "docker-read-gateway";

class GatewayConfigurationError extends Error {}
class DockerProxyError extends Error {}

function parseInteger(value, fallback, min, max, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new GatewayConfigurationError(`${name} deve ser um inteiro entre ${min} e ${max}`);
  }
  return parsed;
}

function parseBoolean(value, fallback, name) {
  const normalized = value === undefined || value === "" ? String(fallback) : value.toLowerCase();
  if (normalized !== "true" && normalized !== "false") {
    throw new GatewayConfigurationError(`${name} deve ser true ou false`);
  }
  return normalized === "true";
}

function loadGatewayConfig(env = process.env) {
  const allowedContainers = [
    ...new Set(
      (env.ALLOWED_CONTAINERS || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (
    allowedContainers.length === 0 ||
    allowedContainers.some(
      (name) => name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name),
    )
  ) {
    throw new GatewayConfigurationError(
      "ALLOWED_CONTAINERS deve conter nomes Docker explicitos e validos",
    );
  }

  let dockerProxyUrl;
  try {
    dockerProxyUrl = new URL(env.DOCKER_PROXY_URL || "http://docker-proxy:2375");
  } catch {
    throw new GatewayConfigurationError("DOCKER_PROXY_URL invalida");
  }
  if (dockerProxyUrl.protocol !== "http:" || dockerProxyUrl.username || dockerProxyUrl.password) {
    throw new GatewayConfigurationError("DOCKER_PROXY_URL deve ser HTTP e nao pode conter credenciais");
  }

  return Object.freeze({
    port: parseInteger(env.GATEWAY_PORT, 8080, 1, 65535, "GATEWAY_PORT"),
    allowedContainers: new Set(allowedContainers),
    dockerProxyUrl,
    dockerTimeoutMs: parseInteger(env.DOCKER_TIMEOUT_MS, 8_000, 500, 30_000, "DOCKER_TIMEOUT_MS"),
    maxDockerJsonBytes: parseInteger(
      env.MAX_DOCKER_JSON_BYTES,
      1024 * 1024,
      16 * 1024,
      4 * 1024 * 1024,
      "MAX_DOCKER_JSON_BYTES",
    ),
    maxLogBytes: parseInteger(
      env.MAX_LOG_BYTES,
      128 * 1024,
      4 * 1024,
      1024 * 1024,
      "MAX_LOG_BYTES",
    ),
    enableDockerLogs: parseBoolean(env.ENABLE_DOCKER_LOGS, false, "ENABLE_DOCKER_LOGS"),
  });
}

function gatewayLog(level, event, fields = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: GATEWAY_SERVICE_NAME,
    event,
    ...fields,
  });
  if (level === "error" || level === "fatal") console.error(line);
  else console.log(line);
}

async function readLimited(response, limitBytes, truncate = false) {
  if (!response.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let wasTruncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limitBytes - total;
      if (value.byteLength > remaining) {
        if (!truncate) throw new DockerProxyError("Resposta Docker excedeu o limite");
        if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
        total = limitBytes;
        wasTruncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { body: Buffer.concat(chunks, total), truncated: wasTruncated };
}

async function readBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new DockerProxyError("Request body excedeu o limite");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function dockerRequest(config, pathname, { logStream = false } = {}) {
  const url = new URL(pathname, config.dockerProxyUrl);
  if (url.origin !== config.dockerProxyUrl.origin) throw new DockerProxyError("Destino Docker invalido");
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(config.dockerTimeoutMs),
    });
  } catch {
    throw new DockerProxyError("Proxy Docker indisponivel");
  }
  if (!response.ok) throw new DockerProxyError(`Proxy Docker retornou ${response.status}`);
  return readLimited(
    response,
    logStream ? config.maxLogBytes : config.maxDockerJsonBytes,
    logStream,
  );
}

async function dockerPostRequest(config, pathname, body) {
  const url = new URL(pathname, config.dockerProxyUrl);
  if (url.origin !== config.dockerProxyUrl.origin) throw new DockerProxyError("Destino Docker invalido");
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(config.dockerTimeoutMs),
    });
  } catch {
    throw new DockerProxyError("Proxy Docker indisponivel");
  }
  if (response.status === 204) return { body: Buffer.alloc(0), truncated: false };
  if (!response.ok) throw new DockerProxyError(`Proxy Docker retornou ${response.status}`);
  return readLimited(response, config.maxDockerJsonBytes, false);
}

function safeDockerString(value, maxLength = 256) {
  return String(value ?? "")
    .replace(/[^\x20-\x7E\u00A0-\u{10FFFF}]/gu, "�")
    .slice(0, maxLength);
}

function normalizeContainer(container, allowedContainers) {
  const names = Array.isArray(container.Names)
    ? container.Names.map((name) => String(name).replace(/^\//, ""))
    : [];
  const name = names.find((candidate) => allowedContainers.has(candidate));
  if (!name) return null;
  return {
    id: /^[a-f0-9]{64}$/i.test(container.Id || "") ? container.Id : null,
    public: {
      name,
      image: safeDockerString(container.Image),
      state: safeDockerString(container.State, 32),
      status: safeDockerString(container.Status),
      ports: Array.isArray(container.Ports)
        ? container.Ports
            .slice(0, 64)
            .filter((port) => Number.isInteger(Number(port.PrivatePort)))
            .map((port) => ({
              privatePort: Number(port.PrivatePort),
              ...(Number.isInteger(Number(port.PublicPort))
                ? { publicPort: Number(port.PublicPort) }
                : {}),
              type: port.Type === "udp" ? "udp" : "tcp",
            }))
        : [],
    },
  };
}

function decodeDockerLogBuffer(buffer) {
  if (buffer.length < 8) return buffer.toString("utf8");
  const looksFramed =
    buffer[0] >= 0 &&
    buffer[0] <= 3 &&
    buffer[1] === 0 &&
    buffer[2] === 0 &&
    buffer[3] === 0;
  if (!looksFramed) return buffer.toString("utf8");

  const payloads = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    if (buffer[offset] > 3 || buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
      return buffer.toString("utf8");
    }
    const length = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = Math.min(payloadStart + length, buffer.length);
    payloads.push(buffer.subarray(payloadStart, payloadEnd));
    offset = payloadStart + length;
    if (payloadEnd < payloadStart + length) break;
  }
  return Buffer.concat(payloads).toString("utf8");
}

function decodeExecStream(buffer) {
  if (buffer.length < 8) return buffer.toString("utf8");

  const streamType = buffer[0];
  if (streamType !== 1 && streamType !== 2) return buffer.toString("utf8");
  if (buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) return buffer.toString("utf8");

  const payloads = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset];
    if (type !== 1 && type !== 2) break;
    if (buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) break;

    const size = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = Math.min(payloadStart + size, buffer.length);
    payloads.push(buffer.subarray(payloadStart, payloadEnd));
    offset = payloadEnd;
  }

  return Buffer.concat(payloads).toString("utf8");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function parseContainerName(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function createGatewayServer(config) {
  return http.createServer(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      gatewayLog("info", "gateway_request", {
        method: req.method,
        path: req.url?.split("?", 1)[0],
        status: res.statusCode,
        durationMs: Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100,
      });
    });

    let requestUrl;
    try {
      requestUrl = new URL(req.url, "http://docker-gateway.internal");
    } catch {
      return sendJson(res, 400, { error: "Bad Request" });
    }

    try {
      if (req.method === "GET") {
        if (requestUrl.pathname === "/healthz") {
          const { body } = await dockerRequest(config, "/_ping");
          const healthy = body.toString("utf8").trim() === "OK";
          return sendJson(res, healthy ? 200 : 503, {
            status: healthy ? "ok" : "unavailable",
          });
        }

        if (requestUrl.pathname === "/v1/containers") {
          const { body } = await dockerRequest(config, "/containers/json?all=1");
          const rawContainers = JSON.parse(body.toString("utf8"));
          if (!Array.isArray(rawContainers)) throw new DockerProxyError("Resposta Docker invalida");
          const containers = rawContainers
            .map((container) => normalizeContainer(container, config.allowedContainers))
            .filter(Boolean)
            .map((container) => container.public)
            .sort((left, right) => left.name.localeCompare(right.name));
          return sendJson(res, 200, { containers });
        }

        const logsMatch = /^\/v1\/containers\/([^/]+)\/logs$/.exec(requestUrl.pathname);
        if (logsMatch) {
          if (!config.enableDockerLogs) return sendJson(res, 404, { error: "Not Found" });
          const name = parseContainerName(logsMatch[1]);
          if (!name) return sendJson(res, 400, { error: "Bad Request" });
          if (!config.allowedContainers.has(name)) return sendJson(res, 404, { error: "Not Found" });
          const tail = Number(requestUrl.searchParams.get("tail") || "100");
          if (!Number.isSafeInteger(tail) || tail < 1 || tail > 1000) {
            return sendJson(res, 400, { error: "Bad Request" });
          }

          const { body: listBody } = await dockerRequest(config, "/containers/json?all=1");
          const rawContainers = JSON.parse(listBody.toString("utf8"));
          const container = Array.isArray(rawContainers)
            ? rawContainers
                .map((item) => normalizeContainer(item, config.allowedContainers))
                .find((item) => item?.public.name === name)
            : null;
          if (!container?.id) return sendJson(res, 404, { error: "Not Found" });

          const query = new URLSearchParams({
            stdout: "1",
            stderr: "1",
            timestamps: "1",
            tail: String(tail),
          });
          const { body, truncated } = await dockerRequest(
            config,
            `/containers/${container.id}/logs?${query}`,
            { logStream: true },
          );
          return sendJson(res, 200, {
            container: name,
            logs: decodeDockerLogBuffer(body),
            truncated,
          });
        }

        return sendJson(res, 404, { error: "Not Found" });
      }

      if (req.method === "POST") {
        const startMatch = /^\/v1\/containers\/([^/]+)\/start$/.exec(requestUrl.pathname);
        if (startMatch) {
          const name = parseContainerName(startMatch[1]);
          if (!name) return sendJson(res, 400, { error: "Bad Request" });
          if (!config.allowedContainers.has(name)) return sendJson(res, 404, { error: "Not Found" });

          const { body: listBody } = await dockerRequest(config, "/containers/json?all=1");
          const rawContainers = JSON.parse(listBody.toString("utf8"));
          const container = Array.isArray(rawContainers)
            ? rawContainers
                .map((item) => normalizeContainer(item, config.allowedContainers))
                .find((item) => item?.public.name === name)
            : null;
          if (!container?.id) return sendJson(res, 404, { error: "Not Found" });

          await dockerPostRequest(config, `/containers/${container.id}/start`, {});
          return sendJson(res, 200, { ok: true });
        }

        const stopMatch = /^\/v1\/containers\/([^/]+)\/stop$/.exec(requestUrl.pathname);
        if (stopMatch) {
          const name = parseContainerName(stopMatch[1]);
          if (!name) return sendJson(res, 400, { error: "Bad Request" });
          if (!config.allowedContainers.has(name)) return sendJson(res, 404, { error: "Not Found" });

          const { body: listBody } = await dockerRequest(config, "/containers/json?all=1");
          const rawContainers = JSON.parse(listBody.toString("utf8"));
          const container = Array.isArray(rawContainers)
            ? rawContainers
                .map((item) => normalizeContainer(item, config.allowedContainers))
                .find((item) => item?.public.name === name)
            : null;
          if (!container?.id) return sendJson(res, 404, { error: "Not Found" });

          await dockerPostRequest(config, `/containers/${container.id}/stop`, {});
          return sendJson(res, 200, { ok: true });
        }

        const restartMatch = /^\/v1\/containers\/([^/]+)\/restart$/.exec(requestUrl.pathname);
        if (restartMatch) {
          const name = parseContainerName(restartMatch[1]);
          if (!name) return sendJson(res, 400, { error: "Bad Request" });
          if (!config.allowedContainers.has(name)) return sendJson(res, 404, { error: "Not Found" });

          const { body: listBody } = await dockerRequest(config, "/containers/json?all=1");
          const rawContainers = JSON.parse(listBody.toString("utf8"));
          const container = Array.isArray(rawContainers)
            ? rawContainers
                .map((item) => normalizeContainer(item, config.allowedContainers))
                .find((item) => item?.public.name === name)
            : null;
          if (!container?.id) return sendJson(res, 404, { error: "Not Found" });

          await dockerPostRequest(config, `/containers/${container.id}/restart`, {});
          return sendJson(res, 200, { ok: true });
        }

        const execMatch = /^\/v1\/containers\/([^/]+)\/exec$/.exec(requestUrl.pathname);
        if (execMatch) {
          const name = parseContainerName(execMatch[1]);
          if (!name) return sendJson(res, 400, { error: "Bad Request" });
          if (!config.allowedContainers.has(name)) return sendJson(res, 404, { error: "Not Found" });

          const reqBodyRaw = await readBody(req, 64 * 1024);
          let reqBody;
          try {
            reqBody = JSON.parse(reqBodyRaw.toString("utf8"));
          } catch {
            return sendJson(res, 400, { error: "Invalid JSON" });
          }
          if (!reqBody.cmd || typeof reqBody.cmd !== "string") {
            return sendJson(res, 400, { error: "cmd e obrigatorio" });
          }

          const { body: listBody } = await dockerRequest(config, "/containers/json?all=1");
          const rawContainers = JSON.parse(listBody.toString("utf8"));
          const container = Array.isArray(rawContainers)
            ? rawContainers
                .map((item) => normalizeContainer(item, config.allowedContainers))
                .find((item) => item?.public.name === name)
            : null;
          if (!container?.id) return sendJson(res, 404, { error: "Not Found" });

          const { body: createBody } = await dockerPostRequest(
            config,
            `/containers/${container.id}/exec`,
            {
              AttachStdout: true,
              AttachStderr: true,
              Tty: false,
              Cmd: ["sh", "-c", reqBody.cmd],
            },
          );
          const execId = JSON.parse(createBody.toString("utf8")).Id;

          const { body: startBody, truncated } = await dockerPostRequest(
            config,
            `/exec/${execId}/start`,
            { Detach: false, Tty: false },
          );
          const output = decodeExecStream(startBody);

          return sendJson(res, 200, { output, truncated });
        }

        res.setHeader("Allow", "GET");
        return sendJson(res, 405, { error: "Method Not Allowed" });
      }

      res.setHeader("Allow", "GET, POST");
      return sendJson(res, 405, { error: "Method Not Allowed" });
    } catch (error) {
      gatewayLog("error", "docker_proxy_error", { kind: error.constructor.name });
      return sendJson(res, 502, { error: "Docker backend unavailable" });
    }
  });
}

function startGateway() {
  let config;
  try {
    config = loadGatewayConfig();
  } catch (error) {
    gatewayLog("fatal", "configuration_error", { message: error.message });
    process.exitCode = 1;
    return;
  }
  const server = createGatewayServer(config);
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 3_000;
  server.maxRequestsPerSocket = 100;
  server.listen(config.port, "0.0.0.0", () => {
    gatewayLog("info", "gateway_started", { port: config.port });
  });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    gatewayLog("info", "shutdown_started", { signal });
    const timer = setTimeout(() => server.closeAllConnections(), 5_000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      gatewayLog("info", "shutdown_complete");
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) startGateway();

module.exports = {
  DockerProxyError,
  GatewayConfigurationError,
  createGatewayServer,
  decodeDockerLogBuffer,
  decodeExecStream,
  loadGatewayConfig,
  normalizeContainer,
  readLimited,
  startGateway,
};
