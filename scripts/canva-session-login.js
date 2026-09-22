// ============================================================
// canva-session-login.js — 手元PCで Canva にログインし、 ログイン状態を S3 に保存する
// ============================================================
// AWS 上のブラウザには画面が無いため、 Canva のログイン (メール認証など) は
// 人が手元のブラウザで行い、 その Cookie を S3 に保存して AWS 側で再利用する。
// (Web UI の「🔑 Canvaログイン」でも同じことができる。 こちらは手元で操作したい人向け)
//
// 使い方 (AWS 認証情報が設定済みであること):
//   npm install && npx playwright install chromium
//   CANVA_SESSION_BUCKET=<バケット名> npm run session:login
//     または  npm run session:login -- --bucket <バケット名>
//   ローカル検証:  npm run session:login -- --file ./canva-session.json
//
// このスクリプトはパスワードを一切扱わない (ブラウザで人が入力するだけ)。
const fs = require("node:fs");
const { chromium } = require("playwright");
const cloud = require("../src/cloudSession");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const bucket = arg("--bucket") || process.env.CANVA_SESSION_BUCKET;
  const file = arg("--file");
  if (!bucket && !file) {
    console.error("❌ 保存先が未指定です。 --bucket <S3バケット名> か --file <path> を指定してください。");
    console.error("   バケット名は CloudFormation の出力 SessionBucketName に表示されます。");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto("https://www.canva.com/login", { waitUntil: "domcontentloaded" });
    console.log("🔐 開いたブラウザで Canva にログインしてください。 ログイン後、 ホーム画面が表示されるまで待ちます (最大10分)…");
    // ログイン完了 = /login を離れて canva.com 内の別ページに到達
    await page.waitForURL((u) => /canva\.com/.test(u.href) && !/\/login/.test(u.pathname), { timeout: 600000 });
    await page.waitForTimeout(3000);

    const state = await context.storageState();
    if (!cloud.hasCanvaLogin(state)) {
      throw new Error("Canva のログイン Cookie が取れませんでした。 もう一度お試しください。");
    }
    if (file) {
      fs.writeFileSync(file, JSON.stringify(state));
      console.log(`💾 保存完了: ${file}`);
    } else {
      await cloud.saveSessionState(state, { CANVA_SESSION_BUCKET: bucket });
      console.log(`💾 保存完了: s3://${bucket}/${cloud.SESSION_KEY}`);
      console.log("   AWS 上の Web UI と 月次バッチがこのログインで動きます。");
    }
  } catch (e) {
    console.error("❌ 失敗: " + e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
