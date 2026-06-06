#!/usr/bin/env bash
# Déploiement du worker d'import vidéo sur son Space Hugging Face
# (m-aurelion/yummap-worker, privé). Le Space rebuild son Docker à chaque push.
#
# Usage :
#   ./scripts/deploy-worker.sh "message de commit"
#   ./scripts/deploy-worker.sh "message de commit" --push-api   # pousse aussi api main (déploie Deno)
#
# Optionnel : exporter HF_TOKEN pour attendre la fin du rebuild du Space.
set -euo pipefail

API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HF_DIR="/tmp/hf-worker"
SPACE="m-aurelion/yummap-worker"

MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "Usage: $0 \"message de commit\" [--push-api]" >&2
  exit 1
fi
PUSH_API=false
[ "${2:-}" = "--push-api" ] && PUSH_API=true

if [ ! -d "$HF_DIR/.git" ]; then
  echo "✗ Clone HF absent ($HF_DIR). Re-clone d'abord :" >&2
  echo "  git clone https://huggingface.co/spaces/$SPACE $HF_DIR" >&2
  exit 1
fi

# 1. Push api main (optionnel) → déploie l'API sur Deno Deploy.
if $PUSH_API; then
  echo "→ push api main (Deno Deploy)"
  git -C "$API_DIR" push origin main
fi

# 2. Sync du code vers le clone HF. src/ en entier + les fichiers racine
#    dont le Dockerfile/serveur dépendent (cf. handoff : config.ts, Dockerfile).
echo "→ sync $API_DIR → $HF_DIR"
rm -rf "$HF_DIR/src"
cp -R "$API_DIR/src" "$HF_DIR/src"
for f in config.ts Dockerfile deno.json deno.lock deps.ts server.ts; do
  [ -f "$API_DIR/$f" ] && cp "$API_DIR/$f" "$HF_DIR/$f"
done

# 3. Commit + push → HF rebuild automatiquement le Docker Space.
cd "$HF_DIR"
git add -A
if git diff --cached --quiet; then
  echo "✓ Rien à déployer (clone HF déjà à jour)."
  exit 0
fi
git commit -m "$MSG"
git push
echo "✓ Poussé sur HF — rebuild du Space en cours."

# 4. Attente du rebuild si HF_TOKEN est dispo (sinon, lien de contrôle).
RUNTIME_URL="https://huggingface.co/api/spaces/$SPACE/runtime"
if [ -n "${HF_TOKEN:-}" ]; then
  echo "→ attente du rebuild (stage RUNNING)…"
  for _ in $(seq 1 60); do
    stage=$(curl -sf -H "Authorization: Bearer $HF_TOKEN" "$RUNTIME_URL" \
      | sed -n 's/.*"stage":"\([A-Z_]*\)".*/\1/p')
    echo "  stage=$stage"
    [ "$stage" = "RUNNING" ] && { echo "✓ Space RUNNING — déployé."; exit 0; }
    [ "$stage" = "BUILD_ERROR" ] || [ "$stage" = "RUNTIME_ERROR" ] && { echo "✗ Échec du build/runtime HF." >&2; exit 1; }
    sleep 10
  done
  echo "✗ Timeout (10 min) — vérifier https://huggingface.co/spaces/$SPACE" >&2
  exit 1
else
  echo "ℹ HF_TOKEN absent — surveiller manuellement : https://huggingface.co/spaces/$SPACE (ou GET $RUNTIME_URL)"
fi
