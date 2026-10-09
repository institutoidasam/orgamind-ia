# OrgaMind GBR — primeiro deploy

## Pedido e referência

Usuário autorizou mover a credencial do Dokploy Picoa para os secrets do Claude e implantar este sistema como novo projeto em `gbr.picoa.app.br`. A chave foi movida para `~/.claude/secrets/dokploy-picoa.env` com modo600. Publicação dos ajustes e integração à principal reutilizam os pedidos explícitos anteriores de subir alterações e fazer merge.

Base: `f4abdb9` em `codex/orgamind-visual-rebrand`; `origin/main` está no mesmo commit. Preservar `main` local em `5a37735` (mudança independente). Os ajustes locais foram aceitos por gate do diff frontend987/987 cobertura90,3% e backend187/192 cobertura95,5%; as cinco integrações opt-in rodaram5/5 separadamente. Revisão independente aprovou consentimento/preflight antes de escritas. Gate completo de dívida legada continua backlog; deploy exige os checks do delta e build real.

## Contratos

- Novo projeto e banco/volumes próprios; preservar Picoa/Dify e suas sessões/provedores.
- `gbr.picoa.app.br` resolve para2.24.73.106, o mesmo destino do Dokploy/Picoa. Domínio novo deve usar TLS como a configuração existente do servidor (Let's Encrypt).
- Segredos novos gerados para este ambiente e sal estável; arquivo local protegido, sem valores em prompts, logs, Git ou relatórios.
- Provider inicial Evolution interno com credencial/sessão nova, sem env/dados do Picoa; envio exige conexão e ação posterior do usuário.
- Novo admin de bootstrap com troca de senha obrigatória; não trocar a senha pelo navegador por conta do usuário.
- Build não inclui envs, secretos ou node_modules do host. Clone Git da revisão publicada e imagens reproduzíveis pelo lockfile existente.

## Aceite

1. Credencial movida, mesma API autenticada, origem removida e destino600.
2. Builds frontend/backend de produção passam, runtime contém preflight de sal; gates do delta sem regressão e revisão do deploy adequada.
3. Novo projeto/compose Dokploy usa repo OrgaMind e revisão publicada, env próprio e volumes separados.
4. Deploy conclui; HTTPS válido e `/api/health/ready`, frontend e login do admin inicial funcionam pelo domínio público.
5. Registrar IDs, revisão, validação, credenciais apenas por caminho e plano de recuperação, sem segredos.

Recuperação: como é primeiro deploy com banco novo, parar apenas o novo compose em caso de boot/migração inválida, corrigir e redeploy. Nunca apagar volumes ou modificar serviços existentes.

## Evidência de boot e complemento de contrato

O primeiro deploy concluiu e a QA pública passou, mas revelou dois bloqueantes do fechamento: healthcheck worker herdado da API e erro Axios incluindo credencial Evolution no log interno. Corrigir o probe e serializar erros HTTP com campos seguros, validando Pino real nas configurações API/worker. Renovar a chave global Evolution antes do aceite; preservar todos os demais segredos e volumes. Instância ainda não provisionada, conexão WhatsApp segue etapa posterior do operador.
