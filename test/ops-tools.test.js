"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  execRuleMatches,
  globToRegExp,
  isAllowed,
  loadOpsAllowlist,
  registerOpsTools,
  sanitizeOutput,
} = require("../ops-tools.js");

test("globToRegExp casa padroes com * e **", () => {
  assert.equal(globToRegExp("*").test("qualquercoisa"), true);
  assert.equal(globToRegExp("*").test("/srv/coisa"), false);
  assert.equal(globToRegExp("/srv/**").test("/srv/apps/api"), true);
  assert.equal(globToRegExp("/srv/*").test("/srv/apps"), true);
  assert.equal(globToRegExp("/srv/*").test("/srv/apps/api"), false);
  assert.equal(globToRegExp("web-*").test("web-1"), true);
  assert.equal(globToRegExp("web-*").test("worker-2"), false);
  assert.equal(globToRegExp("/app/*").test("/app/script.sh"), true);
  assert.equal(globToRegExp("/app/*").test("/app/outro/script.sh"), false);
});

test("isAllowed respeita lista vazia (fail closed)", () => {
  assert.equal(isAllowed([], "qualquer"), false);
  assert.equal(isAllowed(["*"], "qualquer"), true);
  assert.equal(isAllowed(["/srv/**"], "/srv/infra/mcp/.env"), true);
  assert.equal(isAllowed(["/srv/**"], "/etc/passwd"), false);
});

test("execRuleMatches exige container E comando", () => {
  const rules = [{ name: "web-*", command: "/app/*" }];
  assert.equal(execRuleMatches(rules, "web-1", "/app/main.py"), true);
  assert.equal(execRuleMatches(rules, "web-1", "bash"), false);
  assert.equal(execRuleMatches(rules, "worker-2", "/app/main.py"), false);
  assert.equal(execRuleMatches([], "web-1", "/app/main.py"), false);
});

test("loadOpsAllowlist normaliza estrutura ausente", () => {
  const tmp = "/tmp/ops-allowlist-test.json";
  require("node:fs").writeFileSync(tmp, JSON.stringify({ shell: { patterns: ["*"] } }));
  const allowlist = loadOpsAllowlist(tmp);
  assert.deepEqual(allowlist.shell.patterns, ["*"]);
  assert.deepEqual(allowlist.docker.containers, []);
  assert.deepEqual(allowlist.pg.hosts, []);
  require("node:fs").rmSync(tmp);
});

test("sanitizeOutput remove controles e limita tamanho", () => {
  assert.equal(sanitizeOutput("\u001b[31mred\u001b[0m\x00"), "red\uFFFD");
  assert.equal(sanitizeOutput("abc", 2), "ab");
});

function serverWith(allowlist) {
  const server = new McpServer({ name: "ops-test", version: "1.0.0" });
  const mockGateway = {
    listContainers: async () => ({ containers: [] }),
    containerLogs: async () => { throw new Error("gateway offline"); },
    startContainer: async () => { throw new Error("gateway offline"); },
    stopContainer: async () => { throw new Error("gateway offline"); },
    restartContainer: async () => { throw new Error("gateway offline"); },
    execInContainer: async () => { throw new Error("gateway offline"); },
  };
  registerOpsTools(server, { allowlist, log: () => {}, pgEnv: { host: "postgres", user: "ops", password: "" }, gateway: mockGateway });
  return server;
}

test("tools de operacao negam fora da allowlist", async () => {
  const server = serverWith({
    shell: { patterns: ["echo *"] },
    docker: { containers: ["web-1"], exec: [] },
    files: { read: ["/srv/**"], write: [], list: [] },
    pg: { hosts: ["postgres"], databases: ["vpsdb"] },
    compose: { dirs: ["/srv/**"] },
    deploy: { dirs: [] },
  });

  const deniedShell = await server._registeredTools.shell.handler({ cmd: "rm -rf /" });
  assert.equal(deniedShell.isError, true);
  assert.match(deniedShell.content[0].text, /Negado pela allowlist/);

  const allowedShell = await server._registeredTools.shell.handler({ cmd: "echo ok" });
  assert.equal(allowedShell.isError, undefined);
  assert.match(allowedShell.content[0].text, /ok/);

  const deniedRestart = await server._registeredTools.docker_restart.handler({ name: "worker-2" });
  assert.match(deniedRestart.content[0].text, /Negado pela allowlist/);

  const allowedRestart = await server._registeredTools.docker_restart.handler({ name: "web-1" });
  assert.match(allowedRestart.content[0].text, /Negado|no such container|Error|denied|not found|Falha/i);

  const deniedExec = await server._registeredTools.docker_exec.handler({ name: "web-1", cmd: "cat /etc/passwd" });
  assert.match(deniedExec.content[0].text, /Negado pela allowlist/);

  const deniedRead = await server._registeredTools.read_file.handler({ path: "/etc/passwd" });
  assert.match(deniedRead.content[0].text, /Negado pela allowlist/);

  const allowedRead = await server._registeredTools.read_file.handler({ path: "/srv/ops-test-file" });
  assert.match(allowedRead.content[0].text, /no such file|Negado/i);

  const deniedPg = await server._registeredTools.pg_query.handler({ database: "outra-base", query: "select 1" });
  assert.match(deniedPg.content[0].text, /Negado pela allowlist/);
});
