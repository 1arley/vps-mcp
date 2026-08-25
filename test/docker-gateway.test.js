"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  createGatewayServer,
  decodeDockerLogBuffer,
  loadGatewayConfig,
} = require("../docker-gateway.js");

const ALLOWED_ID = "a".repeat(64);
const DENIED_ID = "b".repeat(64);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function dockerFrame(text, stream = 1) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("decoder aceita logs Docker multiplexados e TTY", () => {
  const framed = Buffer.concat([dockerFrame("stdout\n"), dockerFrame("stderr\n", 2)]);
  assert.equal(decodeDockerLogBuffer(framed), "stdout\nstderr\n");
  assert.equal(decodeDockerLogBuffer(Buffer.from("tty output\n")), "tty output\n");
});

test("gateway aplica allowlist antes de expor containers e logs", async (t) => {
  const proxyRequests = [];
  const dockerProxy = http.createServer((req, res) => {
    proxyRequests.push(req.url);
    if (req.url === "/_ping") return res.end("OK");
    if (req.url === "/containers/json?all=1") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify([
          {
            Id: ALLOWED_ID,
            Names: ["/allowed-app"],
            Image: "example/app:1",
            State: "running",
            Status: "Up 1 hour",
            Ports: [{ PrivatePort: 8080, PublicPort: 443, Type: "tcp" }],
          },
          {
            Id: DENIED_ID,
            Names: ["/private-db"],
            Image: "postgres:16",
            State: "running",
            Status: "Up 1 hour",
            Ports: [],
          },
        ]),
      );
    }
    if (req.url?.startsWith(`/containers/${ALLOWED_ID}/logs?`)) {
      return res.end(dockerFrame("safe log\n"));
    }
    res.statusCode = 404;
    res.end();
  });
  const proxyPort = await listen(dockerProxy);
  t.after(() => close(dockerProxy));

  const config = loadGatewayConfig({
    ALLOWED_CONTAINERS: "allowed-app",
    DOCKER_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    DOCKER_TIMEOUT_MS: "2000",
    ENABLE_DOCKER_LOGS: "true",
  });
  const gateway = createGatewayServer(config);
  const gatewayPort = await listen(gateway);
  t.after(() => close(gateway));

  const containersResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/containers`);
  assert.equal(containersResponse.status, 200);
  const containers = await containersResponse.json();
  assert.deepEqual(containers.containers.map((item) => item.name), ["allowed-app"]);
  assert.equal(JSON.stringify(containers).includes("private-db"), false);
  assert.equal(JSON.stringify(containers).includes(ALLOWED_ID), false);

  const deniedResponse = await fetch(
    `http://127.0.0.1:${gatewayPort}/v1/containers/private-db/logs?tail=10`,
  );
  assert.equal(deniedResponse.status, 404);
  assert.equal(proxyRequests.some((path) => path?.includes(DENIED_ID)), false);

  const logsResponse = await fetch(
    `http://127.0.0.1:${gatewayPort}/v1/containers/allowed-app/logs?tail=10`,
  );
  assert.equal(logsResponse.status, 200);
  const logs = await logsResponse.json();
  assert.equal(logs.container, "allowed-app");
  assert.equal(logs.logs, "safe log\n");
  assert.equal(logs.truncated, false);

  const badTail = await fetch(
    `http://127.0.0.1:${gatewayPort}/v1/containers/allowed-app/logs?tail=1001`,
  );
  assert.equal(badTail.status, 400);

  const mutation = await fetch(`http://127.0.0.1:${gatewayPort}/v1/containers`, {
    method: "POST",
  });
  assert.equal(mutation.status, 405);
});
