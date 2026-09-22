#!/bin/zsh
# ============================================================
# run-webserver.sh — Canva 書込み Web UI を常時起動するラッパー
# ============================================================
# launchd (~/Library/LaunchAgents/com.tabata.canva-webserver.plist) から
# KeepAlive つきで呼ばれる。 落ちても launchd が自動で呼び直す。
#
# 稼働期間: 常時 (日付による制限なし)。
#   2026/08/13 変更: 以前は「毎月15日〜月末」のみ稼働だったが、
#   いつでも使えるように日付判定を廃止した。
#
# 手動で動かす場合:
#   ./scripts/run-webserver.sh
# ============================================================

cd "$(dirname "$0")/.." || exit 1

export CANVA_WEB_PORT="${CANVA_WEB_PORT:-4545}"

# 既に誰かが同じポートを掴んでいたら起動しない (EADDRINUSE で黙って死ぬのを防ぐ)
if lsof -nP -iTCP:"$CANVA_WEB_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ポート $CANVA_WEB_PORT は使用中。 60秒後に再確認します。"
  sleep 60
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') webServer を起動します (port=$CANVA_WEB_PORT)"
exec /usr/bin/env node src/webServer.js
