"use strict";

const http = require("node:http");

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_LOG_BYTES = 128 * 1024;

class DockerClientError extends Error {}

function socketRequest(socketPath, method, pathname, { body = null, timeoutMs, maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new DockerClientError("Docker socket timeout"));
    }, timeoutMs);

    const req = http.request(
      {
        socketPath,
        path: pathname,
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        clearTimeout(timer);
        if (res.statusCode === 204) {
          res.resume();
          return resolve({ body: Buffer.alloc(0), truncated: false });
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new DockerClientError(`Docker returned ${res.statusCode}`));
        }
        const chunks = [];
        let total = 0;
        let truncated = false;
        res.on("data", (chunk) => {
          if (truncated) return;
          if (total + chunk.length > maxBytes) {
            const remaining = maxBytes - total;
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            total = maxBytes;
            truncated = true;
            res.resume();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks, total), truncated }));
        res.on("error", reject);
      },
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new DockerClientError("Docker socket unavailable: " + err.message));
    });
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

function decodeDockerLogBuffer(buffer) {
  if (buffer.length < 8) return buffer.toString("utf8");
  if (buffer[0] > 3 || buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) {
    return buffer.toString("utf8");
  }
  const payloads = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    if (buffer[offset] > 3 || buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) break;
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + length, buffer.length);
    payloads.push(buffer.subarray(start, end));
    offset = end;
    if (end < start + length) break;
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
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);
    payloads.push(buffer.subarray(start, end));
    offset = end;
  }
  return Buffer.concat(payloads).toString("utf8");
}

function normalizeContainer(container, allowedContainers) {
  const names = Array.isArray(container.Names)
    ? container.Names.map((n) => String(n).replace(/^\//, ""))
    : [];
  const name = names.find((n) => allowedContainers.has(n));
  if (!name) return null;
  return {
    id: /^[a-f0-9]{64}$/i.test(container.Id || "") ? container.Id : null,
    name,
    image: String(container.Image || ""),
    state: String(container.State || ""),
    status: String(container.Status || ""),
    ports: Array.isArray(container.Ports)
      ? container.Ports
          .slice(0, 64)
          .filter((p) => Number.isInteger(Number(p.PrivatePort)))
          .map((p) => ({
            privatePort: Number(p.PrivatePort),
            ...(Number.isInteger(Number(p.PublicPort)) ? { publicPort: Number(p.PublicPort) } : {}),
            type: p.Type === "udp" ? "udp" : "tcp",
          }))
      : [],
  };
}

class DockerClient {
  constructor({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, maxLogBytes = DEFAULT_MAX_LOG_BYTES }) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxLogBytes = maxLogBytes;
  }

  async _get(pathname, { maxBytes = this.maxBytes } = {}) {
    return socketRequest(this.socketPath, "GET", pathname, { timeoutMs: this.timeoutMs, maxBytes });
  }

  async _post(pathname, body = {}) {
    return socketRequest(this.socketPath, "POST", pathname, { body, timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
  }

  async listContainers({ allowedContainers } = {}) {
    const { body } = await this._get("/containers/json?all=1");
    const raw = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(raw)) throw new DockerClientError("Invalid Docker response");
    let containers = raw.map((c) => normalizeContainer(c, allowedContainers)).filter(Boolean);
    containers.sort((a, b) => a.name.localeCompare(b.name));
    return { containers };
  }

  async containerLogs(name, tail, { allowedContainers } = {}) {
    const list = await this.listContainers({ allowedContainers });
    const container = list.containers.find((c) => c.name === name);
    if (!container?.id) throw new DockerClientError(`Container "${name}" not found`);
    const query = new URLSearchParams({ stdout: "1", stderr: "1", timestamps: "1", tail: String(tail) });
    const { body, truncated } = await this._get(`/containers/${container.id}/logs?${query}`, { maxBytes: this.maxLogBytes });
    return { container: name, logs: decodeDockerLogBuffer(body), truncated };
  }

  async startContainer(name, { allowedContainers } = {}) {
    const list = await this.listContainers({ allowedContainers });
    const container = list.containers.find((c) => c.name === name);
    if (!container?.id) throw new DockerClientError(`Container "${name}" not found`);
    await this._post(`/containers/${container.id}/start`);
  }

  async stopContainer(name, { allowedContainers } = {}) {
    const list = await this.listContainers({ allowedContainers });
    const container = list.containers.find((c) => c.name === name);
    if (!container?.id) throw new DockerClientError(`Container "${name}" not found`);
    await this._post(`/containers/${container.id}/stop`);
  }

  async restartContainer(name, { allowedContainers } = {}) {
    const list = await this.listContainers({ allowedContainers });
    const container = list.containers.find((c) => c.name === name);
    if (!container?.id) throw new DockerClientError(`Container "${name}" not found`);
    await this._post(`/containers/${container.id}/restart`);
  }

  async execInContainer(name, cmd, { allowedContainers } = {}) {
    const list = await this.listContainers({ allowedContainers });
    const container = list.containers.find((c) => c.name === name);
    if (!container?.id) throw new DockerClientError(`Container "${name}" not found`);
    const { body: createBody } = await this._post(`/containers/${container.id}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["sh", "-c", cmd],
    });
    const execId = JSON.parse(createBody.toString("utf8")).Id;
    const { body: startBody, truncated } = await this._post(`/exec/${execId}/start`, { Detach: false, Tty: false });
    return { output: decodeExecStream(startBody), truncated };
  }
}

module.exports = { DockerClient, DockerClientError, decodeDockerLogBuffer, decodeExecStream, normalizeContainer };
