"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { decodeDockerLogBuffer, decodeExecStream, normalizeContainer } = require("../docker-client.js");

const ALLOWED_ID = "a".repeat(64);
const DENIED_ID = "b".repeat(64);

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

test("decoder aceita exec stream", () => {
  const framed = Buffer.concat([dockerFrame("output\n")]);
  assert.equal(decodeExecStream(framed), "output\n");
  assert.equal(decodeExecStream(Buffer.from("plain")), "plain");
});

test("normalizeContainer filtra por allowlist", () => {
  const allowed = new Set(["allowed-app"]);
  const n1 = normalizeContainer({
    Id: ALLOWED_ID, Names: ["/allowed-app"], Image: "example/app:1",
    State: "running", Status: "Up 1 hour",
    Ports: [{ PrivatePort: 8080, PublicPort: 443, Type: "tcp" }],
  }, allowed);
  assert.equal(n1 !== null, true);
  assert.equal(n1.name, "allowed-app");
  assert.equal(n1.ports[0].privatePort, 8080);

  const n2 = normalizeContainer({
    Id: DENIED_ID, Names: ["/private-db"], Image: "postgres:16",
    State: "running", Status: "Up 1 hour", Ports: [],
  }, allowed);
  assert.equal(n2, null);
});
