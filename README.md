# VPS Observer MCP

MCP remoto e somente leitura para observar containers Docker explicitamente autorizados. O desenho prioriza redução de privilégio: o processo exposto à rede não recebe shell, filesystem da VPS, credenciais de banco nem acesso ao socket Docker.

> Segurança absoluta não pode ser garantida por nenhum projeto. Esta versão elimina as falhas críticas identificadas, adota defaults fechados e registra em [SECURITY.md](SECURITY.md) as premissas e os riscos residuais que precisam ser operados.

## Arquitetura

```mermaid
flowchart LR
    C[Cliente MCP] -->|HTTPS + Bearer| T[Traefik]
    T -->|rede web| M[MCP não-root<br/>somente leitura]
    M -->|API interna restrita| G[Gateway com allowlist]
    G -->|rede docker-raw isolada| P[Proxy Docker<br/>somente GET/HEAD]
    P -->|socket local| D[Docker Engine]
```

As redes `docker-observe` e `docker-raw` são internas e distintas. O MCP não consegue alcançar o proxy do socket. O gateway só oferece listagem filtrada e, quando habilitado explicitamente, logs limitados. O proxy bloqueia todos os métodos mutáveis mesmo se o gateway for comprometido.

## Ferramentas expostas

- `docker_containers`: estado dos containers presentes em `ALLOWED_CONTAINERS`.
- `runtime_info`: métricas não sensíveis do runtime isolado do MCP.
- `docker_logs`: opt-in com `ENABLE_DOCKER_LOGS=true`; desativada por padrão porque logs podem conter segredos e prompt injection.

Não existem ferramentas de shell, `docker exec`, start/stop/restart, deploy, escrita/leitura arbitrária de arquivos ou SQL livre.

## Subida local/na VPS

Pré-requisitos: Docker com Compose e uma rede externa `web` já usada pelo Traefik.

1. Gere um token com pelo menos 256 bits de entropia:

   ```bash
   openssl rand -base64 48
   ```

2. Guarde o token somente no cliente MCP. Calcule seu hash sem adicionar quebra de linha:

   ```bash
   printf '%s' 'COLE_AQUI_O_TOKEN' | sha256sum
   ```

3. Copie `.env.example` para `.env` e preencha:

   - `AUTH_TOKEN_SHA256`: apenas os 64 caracteres hexadecimais do hash;
   - `MCP_DOMAIN`: domínio exato servido pelo Traefik;
   - `ops-allowlist.json`: embutido na imagem no build (padrão liberado, `*`); para limitar as permissões na VPS monte seu próprio arquivo por cima — veja [Restringir permissões na VPS](#restringir-permissões-na-vps-opcional);
   - `MCP_ALLOWED_ORIGINS`: vazio para rejeitar todos os Origins, ou Origins HTTPS exatos para clientes web.

4. Valide, autentique no GHCR e suba:

   ```bash
   docker compose config --quiet
   printf '%s' 'SEU_PAT_READ_PACKAGES' | docker login ghcr.io -u SEU_USER --password-stdin
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

   O pacote `vps-mcp` no GHCR é privado por padrão; sem login o `pull` falha. Se preferir
   pular o login, marque o pacote como público em
   `https://github.com/users/SEU_USER/packages/container/vps-mcp`.

Na VPS de produção o diretório fica enxuto — só o Compose e o `.env`:

```
/opt/vps-mcp/
├── docker-compose.yml
└── .env
```

O código vive no GitHub, o GitHub Actions constrói e publica a imagem e a VPS apenas
faz `docker compose pull`. Em desenvolvimento local, construa a imagem no host e
aponte `MCP_IMAGE=vps-observer-mcp:local` no `.env`.

O endpoint remoto é `https://SEU_DOMINIO/mcp` e cada chamada deve enviar `Authorization: Bearer SEU_TOKEN`. O Traefik publica somente `/mcp`; os healthchecks ficam internos.

Para releases imutáveis, fixe em `.env` a referência por digest gerada após o pipeline, por exemplo `MCP_IMAGE=ghcr.io/1arley/vps-mcp@sha256:...` (o workflow publica tags por SHA e `latest`, com SBOM e proveniência).

## Restringir permissões na VPS (opcional)

A allowlist embutida na imagem (`ops-allowlist.json`) é propositalmente liberada
(`"*"` em shell, docker, files e pg) — feita para um único operador que confia na
própria VPS. Se você quiser limitar o que o MCP pode fazer, **não é preciso
rebuildar a imagem**: monte seu próprio arquivo por cima do embutido.

1. Crie o arquivo ao lado do Compose:

   `/opt/vps-mcp/ops-allowlist.json`

   ```json
   {
     "shell": { "patterns": ["docker ps*", "docker logs*"] },
     "docker": {
       "containers": ["meu-app", "postgres-1"],
       "exec": [{ "name": "postgres-1", "command": "pg_isready*" }]
     },
     "files": { "read": ["/srv/**"], "write": [], "list": ["/srv"] },
     "pg": { "hosts": ["postgres"], "databases": ["app"] },
     "compose": { "dirs": ["/srv/meu-projeto"] },
     "deploy": { "dirs": ["/srv/meu-projeto"] }
   }
   ```

2. Monte no serviço `mcp` do `docker-compose.yml` (o caminho precisa ser o de
   `OPS_ALLOWLIST_PATH`, default `/app/ops-allowlist.json`):

   ```yaml
   services:
     mcp:
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock:ro
         - ./ops-allowlist.json:/app/ops-allowlist.json:ro
         - /srv:/srv:ro
   ```

3. Recrie o serviço e pronto:

   ```bash
   docker compose up -d
   ```

   Depois disso, editar o arquivo exige só `docker compose restart mcp` — a
   allowlist é lida uma vez na subida do processo.

Semântica de cada chave (glob simples com `*`):

| Chave | O que libera |
| --- | --- |
| `shell.patterns` | comandos bash passados à tool `shell` |
| `docker.containers` | containers visíveis em `docker_containers`, `docker_ps` e `docker_logs`, e alvos de `docker_start` / `docker_stop` / `docker_restart` |
| `docker.exec` | regras `{ "name", "command" }` para `docker_exec` (ambos glob) |
| `files.read` / `files.write` / `files.list` | caminhos de `read_file` / `write_file` / `list_dir` |
| `pg.hosts` / `pg.databases` | destinos de `pg_query` |
| `deploy.dirs` | diretórios do `deploy` (`git pull` + ação) |
| `compose.dirs` | reservado — carregado, mas ainda sem tool correspondente |

Tudo é **negado por padrão**: chave ausente ou array vazio nega; `"*"` libera tudo;
qualquer permissão nova negada pelo servidor vem com o texto `Adicione ao
ops-allowlist.json e reinicie o MCP`. Com o volume montado a VPS passa a ter 3
arquivos (`docker-compose.yml`, `.env` e `ops-allowlist.json`).

## Rotação do token

`AUTH_TOKEN_SHA256` aceita hashes separados por vírgula. Adicione o hash novo, recrie somente o serviço MCP, migre o cliente e depois remova o hash antigo. Essa sobreposição evita indisponibilidade sem manter o token em texto puro no servidor.

## Validação

```bash
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=low
npm run check
npm test
docker compose config --quiet
docker build --target mcp-runtime -t vps-observer-mcp:test .
```

O CI repete testes e auditoria, constrói a imagem do MCP, bloqueia vulnerabilidades
altas/críticas com correção disponível (as sem correção no base bookworm são
ignoradas pelo gate) e publica a imagem no GHCR com SBOM e proveniência. As ações
do GitHub e a imagem base Node estão fixadas por SHA/digest.

## Resumo para apresentação

O ponto principal é a contenção de impacto. Antes, um único token liberava comandos arbitrários e o socket Docker, equivalentes a root na VPS. Agora o serviço externo é somente leitura, roda sem privilégios e atravessa duas barreiras internas: uma allowlist por container e um proxy que bloqueia mutações. Entradas, Host, Origin, autenticação, taxa, payloads, timeouts e outputs são limitados; dependências e imagens passam por verificação automatizada.
