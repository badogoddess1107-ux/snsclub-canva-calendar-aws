# ============================================================
# Canva カレンダー自動化 — AWS Fargate 用イメージ
# ============================================================
# ・Web UI (webServer.js) と 月次バッチ (runScheduled.js --auto) を同じイメージで動かす
# ・Canva は headless だと Bot 判定されやすいため、 Xvfb (仮想ディスプレイ) 上で
#   従来通り headless:false のまま動かす
# ・Playwright 公式イメージにブラウザと依存ライブラリが揃っている。
#   タグは package.json の playwright のバージョンと揃えること (ズレると起動しない)
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    CANVA_WEB_PORT=4545 \
    CANVA_PROFILE_DIR=/data/profile

WORKDIR /app

# 依存だけ先に入れてレイヤーキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# アプリ本体 (ブラウザプロファイルや output は .dockerignore で除外)
COPY config.js ./
COPY src ./src
COPY coords ./coords
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data/profile /app/output

EXPOSE 4545

ENTRYPOINT ["docker-entrypoint.sh"]
# 既定は Web UI。 月次バッチ用タスク定義は command を ["node","src/runScheduled.js","--auto"] にしている
CMD ["node", "src/webServer.js"]
