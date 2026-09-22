"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod");

const OPS_MAX_OUTPUT = Number(process.env.OPS_MAX_OUTPUT_BYTES) || 1024 * 1024;

function globToRegExp(glob) {
  let re = "";
  let i = 0;
  const source = String(glob);
  const length = source.length;
  while (i < length) {
    const char = source[i];
    if (char === "*") {
      if (source[i + 1] === "*") { re += ".*"; i += 2; }
      else { re += "[^/]*"; i += 1; }
    } else if (char === "?") { re += "[^/]"; i += 1; }
    else if (char === "[") {
      const close = source.indexOf("]", i + 1);
      if (close === -1) { re += "\\["; i += 1; }
      else { re += source.slice(i + 1, close); i = close + 1; }
    } else { re += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
  }
  return new RegExp(`^${re}$`);
}

function isAllowed(patterns, value) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  if (patterns.includes("*")) return true;
  return patterns.some((p) => globToRegExp(p).test(String(value)));
}

function execRuleMatches(rules, name, command) {
  if (!Array.isArray(rules) || rules.length === 0) return false;
  return rules.some(
    (r) =>
      r && typeof r.name === "string" && globToRegExp(r.name).test(String(name)) &&
      typeof r.command === "string" && globToRegExp(r.command).test(String(command)),
  );
}

function sanitizeOutput(value, maxLength = OPS_MAX_OUTPUT) {
  return String(value ?? "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u{10FFFF}]/gu, "�")
    .slice(0, maxLength);
}

function appendCapped(bucket, chunk, maxLength) {
  if (bucket.length >= maxLength) return bucket;
  const merged = bucket + chunk;
  return merged.length > maxLength ? merged.slice(0, maxLength) : merged;
}

function runCommand(cmd, { cwd, timeout = 120000, maxOutput = OPS_MAX_OUTPUT } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", cmd], { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk.toString("utf8"), maxOutput); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk.toString("utf8"), maxOutput); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ stdout, stderr, code: -1, killed, error: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, killed, error: undefined }); });
  });
}

function textResult(text, isError = false) {
  const result = { content: [{ type: "text", text: sanitizeOutput(text) }] };
  if (isError) result.isError = true;
  return result;
}

function denied(tool, detail) {
  return textResult(`Negado: ${detail}.\nAdicione ao ops-allowlist.json e reinicie o MCP.`, true);
}

function loadOpsAllowlist(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    shell: { patterns: Array.isArray(parsed.shell?.patterns) ? parsed.shell.patterns : [] },
    docker: {
      containers: Array.isArray(parsed.docker?.containers) ? parsed.docker.containers : [],
      exec: Array.isArray(parsed.docker?.exec) ? parsed.docker.exec : [],
    },
    files: {
      read: Array.isArray(parsed.files?.read) ? parsed.files.read : [],
      write: Array.isArray(parsed.files?.write) ? parsed.files.write : [],
      list: Array.isArray(parsed.files?.list) ? parsed.files.list : [],
    },
    pg: {
      hosts: Array.isArray(parsed.pg?.hosts) ? parsed.pg.hosts : [],
      databases: Array.isArray(parsed.pg?.databases) ? parsed.pg.databases : [],
    },
    compose: { dirs: Array.isArray(parsed.compose?.dirs) ? parsed.compose.dirs : [] },
    deploy: { dirs: Array.isArray(parsed.deploy?.dirs) ? parsed.deploy.dirs : [] },
  };
}

function formatContainersTable(containers) {
  const header = "NAMES\tSTATUS\tIMAGE";
  const body = containers.map((c) => `${c.name}\t${c.status}\t${c.image}`);
  return header + (body.length ? "\n" + body.join("\n") : "\n(sem containers)");
}

function containerAllowedInError(name, allowed) {
  if (allowed.includes("*")) return `container "${name}" (allowlist: * — todos permitidos)`;
  return `container "${name}" não está em docker.containers. Permitidos: [${allowed.join(", ")}]`;
}

const SAFE_SHELL_FREE = /^[A-Za-z0-9 _./:=@%+,\-]+$/;

function registerOpsTools(server, deps) {
  const allowlist = deps.allowlist;
  const log = deps.log || (() => {});
  const pg = deps.pgEnv || { host: "postgres", user: "postgres", password: "" };
  const docker = deps.docker;
  const allowedContainers = allowlist.docker.containers;
  const opsAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    "shell",
    {
      title: "Executar comando shell na VPS",
      description: "Executa um comando shell arbitrário. O comando precisa casar com um padrão de shell.patterns no ops-allowlist.json.",
      inputSchema: { cmd: z.string().min(1).max(8192) },
      annotations: opsAnnotations,
    },
    async ({ cmd }) => {
      if (!isAllowed(allowlist.shell.patterns, cmd)) return denied("shell", `comando não permitido. Patterns: [${allowlist.shell.patterns.join(", ")}]`);
      log("info", "ops_shell", { cmd: sanitizeOutput(cmd, 256) });
      const result = await runCommand(cmd);
      return textResult(
        `${sanitizeOutput(result.stdout)}${result.stderr ? `\n[stderr]\n${sanitizeOutput(result.stderr)}` : ""}${result.error ? `\n[erro] ${result.error}` : ""}${result.killed ? "\n[timeout: processo encerrado]" : ""}`,
      );
    },
  );

  server.registerTool(
    "docker_ps",
    {
      title: "Lista containers Docker",
      description: "Lista containers Docker filtrados por docker.containers no ops-allowlist.json.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const result = await docker.listContainers({ allowedContainers });
        return textResult(formatContainersTable(result.containers));
      } catch (error) {
        log("error", "ops_docker_ps_error", { kind: error.constructor.name });
        return textResult(`Falha ao listar containers: ${error.message}`, true);
      }
    },
  );

  for (const action of ["docker_restart", "docker_start", "docker_stop"]) {
    const verb = action.replace("docker_", "");
    server.registerTool(
      action,
      {
        title: `${verb.charAt(0).toUpperCase() + verb.slice(1)} container`,
        description: `Executa \`${verb}\` em um container. Container precisa estar em docker.containers.`,
        inputSchema: { name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/) },
        annotations: opsAnnotations,
      },
      async ({ name }) => {
        if (!isAllowed(allowedContainers, name)) return denied(action, containerAllowedInError(name, allowedContainers));
        try {
          if (action === "docker_restart") await docker.restartContainer(name, { allowedContainers });
          else if (action === "docker_start") await docker.startContainer(name, { allowedContainers });
          else if (action === "docker_stop") await docker.stopContainer(name, { allowedContainers });
          return textResult(`OK: ${verb} ${name}`);
        } catch (error) {
          log("error", `ops_${action}_error`, { container: name, kind: error.constructor.name });
          return textResult(`Falha ao ${verb} "${name}": ${error.message}`, true);
        }
      },
    );
  }

  server.registerTool(
    "docker_exec",
    {
      title: "Executa comando dentro de container",
      description: "Executa um comando dentro de um container. Container e comando precisam casar com docker.exec no ops-allowlist.json.",
      inputSchema: {
        name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
        cmd: z.string().min(1).max(4096),
      },
      annotations: opsAnnotations,
    },
    async ({ name, cmd }) => {
      if (!execRuleMatches(allowlist.docker.exec, name, cmd)) {
        return denied("docker_exec", `container "${name}" + comando não permitidos. Rules: ${JSON.stringify(allowlist.docker.exec)}`);
      }
      log("info", "ops_docker_exec", { container: name, cmd: sanitizeOutput(cmd, 256) });
      try {
        const result = await docker.execInContainer(name, cmd, { allowedContainers });
        return textResult(result.output || "");
      } catch (error) {
        log("error", "ops_docker_exec_error", { container: name, kind: error.constructor.name });
        return textResult(`Falha ao executar em "${name}": ${error.message}`, true);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Lê arquivo",
      description: "Lê um arquivo cujo caminho casa com files.read no ops-allowlist.json.",
      inputSchema: { path: z.string().min(1).max(2048) },
      annotations: readOnlyAnnotations,
    },
    async ({ path: filePath }) => {
      if (!isAllowed(allowlist.files.read, filePath)) {
        return denied("read_file", `caminho "${filePath}" não permitido. Patterns: [${allowlist.files.read.join(", ")}]`);
      }
      try {
        const content = await fsPromises.readFile(filePath, "utf8");
        return textResult(sanitizeOutput(content, 512 * 1024));
      } catch (error) {
        return textResult(error.message, true);
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Escreve arquivo",
      description: "Escreve um arquivo cujo caminho casa com files.write no ops-allowlist.json.",
      inputSchema: { path: z.string().min(1).max(2048), content: z.string().max(1024 * 1024) },
      annotations: opsAnnotations,
    },
    async ({ path: filePath, content }) => {
      if (!isAllowed(allowlist.files.write, filePath)) {
        return denied("write_file", `caminho "${filePath}" não permitido. Patterns: [${allowlist.files.write.join(", ")}]`);
      }
      try {
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, content, "utf8");
        return textResult(`OK: ${filePath}`);
      } catch (error) {
        return textResult(error.message, true);
      }
    },
  );

  server.registerTool(
    "list_dir",
    {
      title: "Lista diretório",
      description: "Lista um diretório cujo caminho casa com files.list no ops-allowlist.json.",
      inputSchema: { path: z.string().min(1).max(2048) },
      annotations: readOnlyAnnotations,
    },
    async ({ path: dirPath }) => {
      if (!isAllowed(allowlist.files.list, dirPath)) {
        return denied("list_dir", `caminho "${dirPath}" não permitido. Patterns: [${allowlist.files.list.join(", ")}]`);
      }
      try {
        const items = await fsPromises.readdir(dirPath, { withFileTypes: true });
        const lines = items.map((item) => `${item.isDirectory() ? "d" : "-"} ${item.name}`);
        return textResult(lines.join("\n") || "(vazio)");
      } catch (error) {
        return textResult(error.message, true);
      }
    },
  );

  server.registerTool(
    "system_info",
    {
      title: "Info da VPS",
      description: "OS, disco, memória, CPU, uptime e resumo do Docker. Somente leitura.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const sections = [];
      const osResult = await runCommand("uname -a 2>&1", { timeout: 10000 });
      sections.push(`=== OS ===\n${osResult.stdout.trim()}`);
      const disk = await runCommand("df -h 2>&1", { timeout: 10000 });
      sections.push(`=== DISK ===\n${disk.stdout.trim()}`);
      const mem = await runCommand("grep -E 'MemTotal|MemFree|MemAvailable' /proc/meminfo 2>&1", { timeout: 10000 });
      sections.push(`=== MEM ===\n${mem.stdout.trim()}`);
      const cpu = await runCommand("nproc 2>&1", { timeout: 10000 });
      sections.push(`=== CPU ===\n${cpu.stdout.trim()}`);
      const uptime = await runCommand("cat /proc/uptime 2>&1", { timeout: 10000 });
      sections.push(`=== UPTIME ===\n${uptime.stdout.trim()}`);
      const dockerInfo = await runCommand("docker info 2>&1 | head -15", { timeout: 15000 });
      sections.push(`=== DOCKER ===\n${dockerInfo.stdout.trim()}`);
      return textResult(sections.join("\n\n"));
    },
  );

  server.registerTool(
    "pg_query",
    {
      title: "Executa query SQL no Postgres",
      description: "Executa uma query SQL. Host e banco precisam estar em pg.hosts e pg.databases do ops-allowlist.json.",
      inputSchema: { database: z.string().min(1).max(128), query: z.string().min(1).max(65536) },
      annotations: opsAnnotations,
    },
    async ({ database, query }) => {
      if (!isAllowed(allowlist.pg.databases, database)) {
        return denied("pg_query", `database "${database}" não permitido. Patterns: [${allowlist.pg.databases.join(", ")}]`);
      }
      if (!isAllowed(allowlist.pg.hosts, pg.host)) {
        return denied("pg_query", `host "${pg.host}" não permitido. Patterns: [${allowlist.pg.hosts.join(", ")}]`);
      }
      log("info", "ops_pg_query", { database, query: sanitizeOutput(query, 256) });
      const { stdout, stderr, code, error, killed } = await runPsql(pg, database, query);
      if (error) return textResult(`psql indisponível: ${error}`, true);
      if (code === 0) return textResult(stdout);
      return textResult(sanitizeOutput(stdout + (stderr ? "\n" + stderr : "")), true);
    },
  );

  server.registerTool(
    "deploy",
    {
      title: "Git pull + restart de serviço",
      description: "Executa `git pull` e uma ação no diretório. Diretório precisa estar em deploy.dirs do ops-allowlist.json.",
      inputSchema: { dir: z.string().min(1).max(512), action: z.string().min(1).max(512) },
      annotations: opsAnnotations,
    },
    async ({ dir, action }) => {
      if (!isAllowed(allowlist.deploy.dirs, dir)) {
        return denied("deploy", `diretório "${dir}" não permitido. Patterns: [${allowlist.deploy.dirs.join(", ")}]`);
      }
      if (!SAFE_SHELL_FREE.test(action)) {
        return textResult("Ação do deploy contém caracteres proibidos.", true);
      }
      log("info", "ops_deploy", { dir, action: sanitizeOutput(action, 128) });
      const pull = await runCommand(`cd ${JSON.stringify(dir)} && git pull 2>&1`, { timeout: 60000 });
      const run = await runCommand(`cd ${JSON.stringify(dir)} && ${action} 2>&1`, { timeout: 180000 });
      const pieces = [`--- git pull ---\n${sanitizeOutput(pull.stdout)}`];
      if (pull.error || pull.killed) pieces.push(`[erro] ${pull.error || "timeout"}`);
      pieces.push(`--- ${action} ---\n${sanitizeOutput(run.stdout)}`);
      if (run.error || run.killed) pieces.push(`[erro] ${run.error || "timeout"}`);
      return textResult(pieces.join("\n"));
    },
  );
}

function runPsql(pg, database, query) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let killedFlag = false;
    const timer = setTimeout(() => { killedFlag = true; proc.kill("SIGKILL"); }, 30000);
    const proc = spawn("psql", ["-h", pg.host, "-U", pg.user, "-d", database, "-c", query], {
      env: { ...process.env, PGPASSWORD: pg.password, PGCLIENTENCODING: "UTF8" },
    });
    proc.stdout.on("data", (chunk) => { out = appendCapped(out, chunk.toString("utf8"), OPS_MAX_OUTPUT); });
    proc.stderr.on("data", (chunk) => { err = appendCapped(err, chunk.toString("utf8"), OPS_MAX_OUTPUT); });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code: -1, error: e.message, killed: killedFlag }); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code, killed: killedFlag, error: undefined }); });
  });
}

module.exports = {
  execRuleMatches,
  globToRegExp,
  isAllowed,
  loadOpsAllowlist,
  registerOpsTools,
  runCommand,
  sanitizeOutput,
};
