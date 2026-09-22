#!/bin/bash
# ============================================================
# docker-entrypoint.sh — Xvfb (仮想ディスプレイ) の上でコマンドを実行する
# ============================================================
# Canva を headless:false で動かすために画面が必要。 1920x1080 の仮想画面を用意する。
# --start-maximized のウィンドウはこの画面いっぱいに開く。
set -e

SCREEN="${XVFB_SCREEN:-1920x1080x24}"

if [ -n "$CANVA_SESSION_BUCKET" ]; then
  echo "☁️ AWSモード: session bucket=$CANVA_SESSION_BUCKET profile=$CANVA_PROFILE_DIR"
else
  echo "⚠️ CANVA_SESSION_BUCKET 未設定: ログイン状態は保存されません (検証用途のみ)"
fi

echo "🖥  Xvfb $SCREEN で起動: $*"
exec xvfb-run --auto-servernum --server-args="-screen 0 $SCREEN -ac -nolisten tcp" "$@"
