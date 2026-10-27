#!/usr/bin/env bash
# Exercise the gateway with curl. Assumes `docker compose up` (demo config).
set -euo pipefail
GW=${GATEWAY_URL:-http://localhost:8080}
KEY=${GATEWAY_KEY:-sk-gw-demo}

echo "== OpenAI format -> Claude-backed alias (note the x-gateway-* headers)"
curl -sS -i "$GW/v1/chat/completions" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"smart","temperature":0,"messages":[{"role":"user","content":"What is the capital of France?"}]}'
echo; echo

echo "== Same question, rephrased: semantic cache"
curl -sS -D - -o /dev/null "$GW/v1/chat/completions" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"smart","temperature":0,"messages":[{"role":"user","content":"what is the capital of france"}]}' | grep -i x-gateway-cache
echo

echo "== Anthropic format, streaming, through a fallback chain"
curl -sS -N "$GW/v1/messages" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"fast","max_tokens":128,"stream":true,"messages":[{"role":"user","content":"stream this"}]}'
echo

echo "== Metrics"
curl -sS "$GW/metrics" | grep -E '^llm_gateway_(requests_total|cache_hit_ratio|upstream_attempts_total)'
