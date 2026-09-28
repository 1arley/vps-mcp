# Modelo de segurança

## Escopo e premissas

O MCP é um observador single-tenant. Assume-se que:

- o Traefik termina TLS com certificado válido e não publica as redes internas;
- o host Docker e os administradores da VPS são confiáveis;
- o token do cliente é aleatório, armazenado com segurança e rotacionado;
- somente o mínimo necessário é mantido em `ops-allowlist.json` quando a allowlist é restrita;
- imagens de produção são implantadas por digest após o pipeline aprovado.

Se alguma dessas premissas não for verdadeira, a implantação não deve ser considerada pronta para produção.

## Controles por ameaça

| Ameaça | Controle aplicado |
|---|---|
| Execução de comando/injeção | Entradas passam por schema (zod); `shell` só executa o que casa `shell.patterns` e `docker_exec` exige `{ name, command }` na allowlist. |
| Escape via Docker socket | Socket montado `:ro`, rootfs read-only, `cap_drop: ALL`, `no-new-privileges` e toda operação autorizada pela allowlist por ferramenta. |
| Exposição entre containers | Listagem, logs e start/stop/restart filtrados por `docker.containers`. |
| DNS rebinding/CORS abusivo | Host obrigatório e Origin exata; Origin ausente é aceito para clientes nativos. |
| Roubo do `.env` | Servidor armazena somente SHA-256 de token com alta entropia; comparação é constant-time. |
| Brute force/DoS básico | Dois rate limits, limites de body/output/logs, timeouts, modo stateless e limites de CPU/memória/PIDs. |
| Vazamento por erro/log da aplicação | Erros externos são genéricos; logs são estruturados e não registram headers nem bodies. |
| Supply chain | Lockfile, `npm audit`, Trivy no gate (HIGH/CRITICAL com correção disponível), ações fixadas por commit, base fixada por digest, SBOM e proveniência. |
| Prompt injection em logs | `docker_logs` restrito a `docker.containers`, aviso de conteúdo não confiável, sanitização de ANSI/controles e limite de tamanho. |

## Riscos residuais aceitos

1. **Bearer single-tenant não é identidade por usuário.** Ele não oferece expiração, scopes ou atribuição individual. Para múltiplos usuários, terceiros ou requisitos corporativos, substitua-o por OAuth 2.1/OIDC com validação de issuer, audience, expiração e scopes, conforme a especificação MCP.
2. **Leitura de logs pode revelar dados que a própria aplicação registrou.** A sanitização reduz formatos comuns, mas não prova ausência de segredos. Mantenha `docker_containers`/`docker_logs` restritos aos containers necessários salvo necessidade aprovada e corrija aplicações que escrevam credenciais em logs.
3. **O socket Docker é o vetor principal.** O mount `:ro` protege o arquivo, não a API: ele não impede chamadas de escrita. A contenção vem da allowlist por ferramenta, do rootfs read-only e das capabilities dropadas — e a allowlist padrão do repositório é `*` (totalmente liberada). Restrinja por volume antes de expor o MCP a qualquer outro usuário.
4. **Rate limit em memória é por réplica.** A composição executa uma réplica. Se houver escala horizontal, use um store compartilhado e preserve a cadeia confiável de proxies.
5. **Vulnerabilidades desconhecidas existem.** Scanners cobrem apenas falhas publicadas. Revisão, patching, monitoramento e resposta a incidentes continuam necessários.

## Checklist de liberação

- [ ] `npm audit --omit=dev --audit-level=low` sem achados.
- [ ] Todos os testes e builds passam no commit exato implantado.
- [ ] Imagem do MCP referenciada por digest.
- [ ] `AUTH_TOKEN_SHA256` não é placeholder e o token tem pelo menos 256 bits aleatórios.
- [ ] `MCP_ALLOWED_HOSTS` e Origins refletem apenas destinos reais.
- [ ] `ops-allowlist.json` contém somente o mínimo necessário (o padrão do repositório é `*`).
- [ ] `docker_logs` limitado aos containers necessários.
- [ ] Porta 3000 não está publicada diretamente; somente Traefik alcança o MCP.
- [ ] Container com rootfs read-only, `cap_drop: ALL` e limites de CPU/memória/PIDs ativos.
- [ ] Backups, restauração e rotação do token foram testados.
- [ ] Logs de autenticação/429 são monitorados sem coletar o bearer.

## Relato de vulnerabilidade

Não abra uma issue pública com token, logs, domínio interno ou detalhes exploráveis. Envie o relato pelo canal privado de segurança da organização, incluindo commit, configuração sem segredos, impacto e passos mínimos de reprodução.
