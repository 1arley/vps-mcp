# Modelo de segurança

## Escopo e premissas

O MCP é um observador single-tenant. Assume-se que:

- o Traefik termina TLS com certificado válido e não publica as redes internas;
- o host Docker e os administradores da VPS são confiáveis;
- o token do cliente é aleatório, armazenado com segurança e rotacionado;
- somente nomes não sensíveis são adicionados a `ALLOWED_CONTAINERS`;
- imagens de produção são implantadas por digest após o pipeline aprovado.

Se alguma dessas premissas não for verdadeira, a implantação não deve ser considerada pronta para produção.

## Controles por ameaça

| Ameaça | Controle aplicado |
|---|---|
| Execução de comando/injeção | Nenhuma entrada chega a shell; APIs são estruturadas e ferramentas mutáveis foram removidas. |
| Escape via Docker socket | MCP não monta o socket; redes separam MCP, gateway e proxy; proxy aceita apenas GET/HEAD. |
| Exposição entre containers | Gateway filtra respostas e logs por nomes exatos em allowlist. |
| DNS rebinding/CORS abusivo | Host obrigatório e Origin exata; Origin ausente é aceito para clientes nativos. |
| Roubo do `.env` | Servidor armazena somente SHA-256 de token com alta entropia; comparação é constant-time. |
| Brute force/DoS básico | Dois rate limits, limites de body/output/logs, timeouts, modo stateless e limites de CPU/memória/PIDs. |
| Vazamento por erro/log da aplicação | Erros externos são genéricos; logs são estruturados e não registram headers nem bodies. |
| Supply chain | Lockfile, `npm audit`, scanner de imagem, ações fixadas por commit, proxy e bases fixados, SBOM e proveniência. |
| Prompt injection em logs | Ferramenta desativada por padrão; opt-in, aviso de conteúdo não confiável, sanitização e limite de tamanho. |

## Riscos residuais aceitos

1. **Bearer single-tenant não é identidade por usuário.** Ele não oferece expiração, scopes ou atribuição individual. Para múltiplos usuários, terceiros ou requisitos corporativos, substitua-o por OAuth 2.1/OIDC com validação de issuer, audience, expiração e scopes, conforme a especificação MCP.
2. **Leitura de logs pode revelar dados que a própria aplicação registrou.** A sanitização reduz formatos comuns, mas não prova ausência de segredos. Mantenha `ENABLE_DOCKER_LOGS=false` salvo necessidade aprovada e corrija aplicações que escrevam credenciais em logs.
3. **O proxy Docker continua sendo um componente privilegiado.** Ele é isolado, fixado por digest e não recebe tráfego externo; ainda assim, uma vulnerabilidade no próprio proxy pode afetar o host. Atualizações devem passar novamente pelo pipeline e revisão.
4. **Rate limit em memória é por réplica.** A composição executa uma réplica. Se houver escala horizontal, use um store compartilhado e preserve a cadeia confiável de proxies.
5. **Vulnerabilidades desconhecidas existem.** Scanners cobrem apenas falhas publicadas. Revisão, patching, monitoramento e resposta a incidentes continuam necessários.

## Checklist de liberação

- [ ] `npm audit --omit=dev --audit-level=low` sem achados.
- [ ] Todos os testes e builds passam no commit exato implantado.
- [ ] Imagens do MCP, gateway e aplicação referenciadas por digest.
- [ ] `AUTH_TOKEN_SHA256` não é placeholder e o token tem pelo menos 256 bits aleatórios.
- [ ] `MCP_ALLOWED_HOSTS` e Origins refletem apenas destinos reais.
- [ ] `ALLOWED_CONTAINERS` contém somente o mínimo necessário.
- [ ] `ENABLE_DOCKER_LOGS=false`, ou exceção documentada e aprovada.
- [ ] Porta 3000 não está publicada diretamente; somente Traefik alcança o MCP.
- [ ] Redes `docker-raw` e `docker-observe` estão marcadas como internas.
- [ ] Backups, restauração e rotação do token foram testados.
- [ ] Logs de autenticação/429 são monitorados sem coletar o bearer.

## Relato de vulnerabilidade

Não abra uma issue pública com token, logs, domínio interno ou detalhes exploráveis. Envie o relato pelo canal privado de segurança da organização, incluindo commit, configuração sem segredos, impacto e passos mínimos de reprodução.
