#!/usr/bin/env bash
# Teste do proxy do nginx do frontend, contra um nginx DE VERDADE em contêiner.
#
#   bash frontend/scripts/nginx-proxy.test.sh frontend/nginx.conf
#
# Não roda no CI (precisa de Docker com rede definida pelo usuário); rode à mão
# ao mexer no `frontend/nginx.conf`. Leva ~90s e limpa tudo que cria.
#
# Foi escrito para reproduzir o INCIDENTE 2026-08-12 — 20h de produção fora,
# todo /api/ em 502, porque o nginx cacheou para sempre o IP da api resolvido
# no boot. Contra a config anterior (hostname literal em `proxy_pass`) o teste
# B falha com 502; contra a atual (variável + `resolver`) passa.
#
# Três testes:
#   A) ROTEAMENTO — /api/x chega no upstream como /x, e a query sobrevive.
#      (característico: tem de valer igual antes e depois da mudança)
#   B) RE-RESOLUÇÃO — o upstream é recriado com IP NOVO e o nginx tem de
#      segui-lo. É ESTE que reproduz o apagão de 20h.
#   C) SEGREDO FORA DO LOG — o token do webhook do GoZap viaja em `?t=` (o
#      painel do SaaS tem essa URL gravada), e o formato `combined` gravava a
#      linha de requisição inteira: 74 linhas de produção com o segredo em
#      texto claro. Contra a config anterior este teste FALHA; contra a atual
#      (log_format sem a query no `location /api/webhooks/`) passa. Confere as
#      DUAS metades: o segredo sumiu do log E continua chegando no backend
#      (senão a "correção" seria só quebrar a autenticação do webhook).
set -u
CONF="${1:?uso: nginx-test.sh <nginx.conf>}"
NET=picoa-nginxtest-net
UP=picoa-nginxtest-api
PROXY=picoa-nginxtest-web
FALHAS=0

limpa() { docker rm -f $UP $PROXY >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
trap limpa EXIT
limpa

# Upstream: ecoa o caminho exato que recebeu.
cat > /tmp/echo-srv.py <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def eco(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n: self.rfile.read(n)
        self.send_response(200); self.send_header('Content-Type','text/plain'); self.end_headers()
        self.wfile.write(self.path.encode())
    do_GET = eco
    do_POST = eco
    def log_message(self, *a): pass
HTTPServer(('0.0.0.0', 3000), H).serve_forever()
PY

sobe_upstream() {
  docker run -d --rm --name $UP --network $NET --network-alias api \
    -v /tmp/echo-srv.py:/srv.py:ro python:3.12-alpine python /srv.py >/dev/null
  for _ in $(seq 1 30); do
    docker run --rm --network $NET curlimages/curl:latest -s --max-time 2 http://api:3000/ping >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

pede() { docker run --rm --network $NET curlimages/curl:latest -s --max-time 5 "http://$PROXY$1" 2>/dev/null; }
posta() { docker run --rm --network $NET curlimages/curl:latest -s --max-time 5 -X POST \
  -H 'Content-Type: application/json' -d '{"event":"messages_update"}' "http://$PROXY$1" 2>/dev/null; }

confere() { # <rótulo> <obtido> <esperado>
  if [ "$2" = "$3" ]; then printf '  OK   %s -> %s\n' "$1" "$2"
  else printf '  FALHA %s -> obtido "%s", esperado "%s"\n' "$1" "$2" "$3"; FALHAS=$((FALHAS+1)); fi
}

docker network create $NET >/dev/null 2>&1
sobe_upstream || { echo "não subiu o upstream"; exit 1; }
docker run -d --rm --name $PROXY --network $NET \
  -v "$(realpath "$CONF")":/etc/nginx/conf.d/default.conf:ro nginx:alpine >/dev/null
sleep 2

echo "A) roteamento"
confere "/api/auth/login"            "$(pede /api/auth/login)"            "/auth/login"
confere "/api/campaigns?limit=5"     "$(pede '/api/campaigns?limit=5')"   "/campaigns?limit=5"
confere "/api/chat/stream"           "$(pede /api/chat/stream)"           "/chat/stream"

echo "C) segredo do webhook fora do access log (achado C20)"
# Valor FALSO, com o mesmo formato do real (48 hex) — nunca use o segredo de
# produção aqui: este script imprime a linha ofensora quando falha.
SEGREDO=deadbeefcafe0123456789abcdef0123456789abcdef0123
confere "?t=<segredo> ainda chega inteiro no backend" \
        "$(posta "/api/webhooks/gozap?t=$SEGREDO")" "/webhooks/gozap?t=$SEGREDO"
sleep 1
LOG=$(docker logs $PROXY 2>&1)
if printf '%s' "$LOG" | grep -q "$SEGREDO"; then
  printf '  FALHA o segredo aparece no access log: %s\n' \
    "$(printf '%s' "$LOG" | grep "$SEGREDO" | head -1)"
  FALHAS=$((FALHAS+1))
else
  printf '  OK   o segredo NAO aparece no access log\n'
fi
# A outra metade: silenciar o log inteiro também passaria no teste acima, e
# apagaria a única prova de que o GoZap chama mesmo. A linha tem de existir,
# com o caminho ORIGINAL (/api/... , não o reescrito).
if printf '%s' "$LOG" | grep -q 'POST /api/webhooks/gozap '; then
  printf '  OK   a linha de log continua existindo, com o caminho completo\n'
else
  printf '  FALHA nao ha linha de access log "POST /api/webhooks/gozap"\n'
  FALHAS=$((FALHAS+1))
fi

echo "B) re-resolução (o apagão): upstream recriado com IP novo"
IP_ANTES=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $UP)
docker rm -f $UP >/dev/null 2>&1
# queima um IP para garantir que o novo contêiner receba outro endereço
docker run -d --rm --name ${UP}-tmp --network $NET alpine sleep 60 >/dev/null
sobe_upstream || { echo "não subiu o upstream de novo"; exit 1; }
docker rm -f ${UP}-tmp >/dev/null 2>&1
IP_DEPOIS=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $UP)
echo "  IP antes=$IP_ANTES  depois=$IP_DEPOIS"
[ "$IP_ANTES" = "$IP_DEPOIS" ] && echo "  (IP não mudou — teste inconclusivo)" && exit 2
sleep 12   # dá tempo do valid= expirar
confere "/api/auth/login apos troca de IP" "$(pede /api/auth/login)" "/auth/login"

echo "D) segredo fora do ERROR log quando o upstream cai (o cenário do apagão)"
# O access log foi consertado pelo teste C — mas o ERROR log do nginx grava a
# LINHA DE REQUISIÇÃO INTEIRA e não é formatável. No apagão de 2026-08-12 foram
# 20h com TODA requisição em erro: 20h gravando o segredo em texto claro no
# stdout do contêiner `web`, que é o log que o Dokploy expõe. O teste C só
# exercita o caminho feliz e por isso não vê esse vazamento.
docker rm -f $UP >/dev/null 2>&1
sleep 11   # deixa o `valid=` expirar para o nginx tentar resolver de novo
SEGREDO2=feedfacecafe0123456789abcdef0123456789abcdef4242
posta "/api/webhooks/gozap?t=$SEGREDO2" >/dev/null
sleep 1
LOG2=$(docker logs $PROXY 2>&1)
if printf '%s' "$LOG2" | grep -q "$SEGREDO2"; then
  printf '  FALHA o segredo aparece no log com o upstream fora: %s\n' \
    "$(printf '%s' "$LOG2" | grep "$SEGREDO2" | head -1)"
  FALHAS=$((FALHAS+1))
else
  printf '  OK   o segredo NAO aparece em log nenhum com o upstream fora\n'
fi
# E o diagnóstico não pode sumir junto: a falha continua visível no access log
# (mesma linha do teste C, agora com status 5xx). É o que garante que um
# apagão de 20h continue detectável.
if printf '%s' "$LOG2" | grep -qE 'POST /api/webhooks/gozap HTTP/1\.1" 5'; then
  printf '  OK   a falha continua visivel no access log (status 5xx)\n'
else
  printf '  FALHA o apagao nao aparece no access log da rota de webhook\n'
  FALHAS=$((FALHAS+1))
fi

echo
[ $FALHAS -eq 0 ] && echo "RESULTADO: verde" || echo "RESULTADO: $FALHAS falha(s)"
exit $FALHAS
