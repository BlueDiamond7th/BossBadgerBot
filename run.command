#!/bin/sh
set -eu
cd "$(dirname "$0")"
task_node=$(command -v node || true)
if [ -z "$task_node" ]; then
  task_node="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ ! -x "$task_node" ]; then
  echo "Node.js 24 이상을 설치한 뒤 다시 실행해 주세요."
  exit 1
fi
if ! "$task_node" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'; then
  echo "Node.js 24 이상이 필요해요."
  exit 1
fi
task_action=${1:-start}
case "$task_action" in
  install)
    task_pnpm="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.cjs"
    if [ -f "$task_pnpm" ]; then
      exec "$task_node" "$task_pnpm" install --frozen-lockfile
    elif command -v corepack >/dev/null 2>&1; then
      exec corepack pnpm install --frozen-lockfile
    else
      echo "pnpm을 설치한 뒤 pnpm install --frozen-lockfile을 실행해 주세요."
      exit 1
    fi
    ;;
  start) exec "$task_node" --env-file-if-exists=.env src/bot.js ;;
  register) exec "$task_node" --env-file-if-exists=.env scripts/register.js ;;
  invite) exec "$task_node" --env-file-if-exists=.env scripts/register.js --invite-only ;;
  check) exec "$task_node" --env-file-if-exists=.env scripts/check.js ;;
  test) exec "$task_node" --test tests/*.test.js ;;
  backup) exec "$task_node" --env-file-if-exists=.env scripts/backup.js ;;
  *) echo "사용법: ./run.command [install|check|test|invite|register|start|backup]"; exit 1 ;;
esac
