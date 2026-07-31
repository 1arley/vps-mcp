const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;

const execp = promisify(exec);
const app = express();

const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

app.use(express.json());

if (AUTH_TOKEN) {
  app.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/") return next();
    const auth = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "") || req.query.token;
    if (token !== AUTH_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });
}

function run(cmd) {
  return execp(cmd, { timeout: 60000 })
    .then(r => (r.stdout || "") + (r.stderr ? "\n" + r.stderr : ""))
    .catch(e => e.message);
}

function createMcpServer() {
  const server = new McpServer({ name: "vps-mcp", version: "1.0.0" });

  server.tool("docker_ps", "Lista containers Docker", async () => ({
    content: [{ type: "text", text: await run("docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}'") }]
  }));

  server.tool("docker_logs", "Logs de um container",
    { name: z.string(), tail: z.number().default(100).describe("Quantidade de linhas") },
    async ({ name, tail = 100 }) => ({
      content: [{ type: "text", text: await run(`docker logs --tail ${tail} ${name} 2>&1`) }]
    })
  );

  server.tool("docker_restart", "Reinicia container",
    { name: z.string() },
    async ({ name }) => ({
      content: [{ type: "text", text: await run(`docker restart ${name}`) }]
    })
  );

  server.tool("docker_start", "Inicia container",
    { name: z.string() },
    async ({ name }) => ({
      content: [{ type: "text", text: await run(`docker start ${name}`) }]
    })
  );

  server.tool("docker_stop", "Para container",
    { name: z.string() },
    async ({ name }) => ({
      content: [{ type: "text", text: await run(`docker stop ${name}`) }]
    })
  );

  server.tool("docker_exec", "Executa comando dentro de container",
    { name: z.string(), cmd: z.string() },
    async ({ name, cmd }) => ({
      content: [{ type: "text", text: await run(`docker exec ${name} ${cmd} 2>&1`) }]
    })
  );

  server.tool("docker_compose", "Executa docker compose no diretorio",
    { dir: z.string(), args: z.string() },
    async ({ dir, args }) => ({
      content: [{ type: "text", text: await run(`cd ${dir} && docker compose ${args} 2>&1`) }]
    })
  );

  server.tool("shell", "Executa comando shell na VPS",
    { cmd: z.string() },
    async ({ cmd }) => ({
      content: [{ type: "text", text: await run(cmd) }]
    })
  );

  server.tool("read_file", "Le arquivo",
    { path: z.string() },
    async ({ path }) => {
      try {
        const c = await fs.readFile(path, "utf-8");
        return { content: [{ type: "text", text: c }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    }
  );

  server.tool("write_file", "Escreve arquivo",
    { path: z.string(), content: z.string() },
    async ({ path, content }) => {
      try {
        await fs.writeFile(path, content);
        return { content: [{ type: "text", text: `OK: ${path}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    }
  );

  server.tool("list_dir", "Lista diretorio",
    { path: z.string().default("/") },
    async ({ path = "/" }) => {
      try {
        const items = await fs.readdir(path, { withFileTypes: true });
        const list = items.map(i => `${i.isDirectory() ? "d" : "-"} ${i.name}`).join("\n");
        return { content: [{ type: "text", text: list }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    }
  );

  server.tool("system_info", "Info da VPS (OS, disk, mem, uptime, docker)", async () => {
    const os = await run("uname -a");
    const disk = await run("df -h");
    const mem = await run("cat /proc/meminfo | grep -E 'MemTotal|MemFree|MemAvailable'");
    const cpu = await run("nproc");
    const uptime = await run("cat /proc/uptime");
    const docker = await run("docker info | head -15");
    
    return {
      content: [{
        type: "text",
        text: `=== OS ===\n${os}\n=== DISK ===\n${disk}\n=== MEM ===\n${mem}\n=== CPU ===\n${cpu}\n=== UPTIME ===\n${uptime}\n=== DOCKER ===\n${docker}`
      }]
    };
  });

  server.tool("pg_query", "Executa query SQL no Postgres",
    { database: z.string().default("symphonytel"), query: z.string() },
    async ({ database = "symphonytel", query }) => {
      const host = process.env.PG_HOST || "postgres";
      const user = process.env.PG_USER || "symphonytel";
      const pass = process.env.PGPASSWORD || "";
      const env = { ...process.env, PGPASSWORD: pass };
      try {
        const { stdout } = await execp(`psql -h ${host} -U ${user} -d ${database} -c "${query.replace(/"/g, '\\"')}"`, { timeout: 30000, env });
        return { content: [{ type: "text", text: stdout }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    }
  );

  server.tool("deploy", "Git pull + restart de servico",
    { dir: z.string(), action: z.string() },
    async ({ dir, action }) => {
      const out = [];
      out.push(await run(`cd ${dir} && git pull 2>&1`));
      out.push(await run(`cd ${dir} && ${action} 2>&1`));
      return { content: [{ type: "text", text: out.join("\n---\n") }] };
    }
  );

  return server;
}

// === HEALTH ===
app.get("/health", (_, res) => res.send("ok"));
app.get("/", (_, res) => res.send("VPS MCP running"));

// === STREAMABLE HTTP MCP ENDPOINT ===
app.post("/mcp", async (req, res) => {
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  transport.onerror = (e) => console.error("MCP transport error:", e);
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  transport.onerror = (e) => console.error("MCP transport error:", e);
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MCP VPS rodando em :${PORT}/mcp`));