// Canvaを開いてログイン状態を確認するスクリプト（ステルス対応版）
// 初回: 手動でログインしてください → セッション情報が .browser-profile/ に保存されます
// 2回目以降: ログイン画面はスキップされて、そのままデザイン画面が開きます
// 使い方: node src/canvaOpen.js

const path = require("node:path");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");

chromium.use(stealth);

async function main() {
  const userDataDir = path.join(__dirname, "..", config.canva.userDataDir);

  console.log("🚀 Chromium(ステルスモード)を起動中...");
  console.log(`   プロファイル保存先: ${userDataDir}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
    ],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log("🌐 Canvaデザインを開きます...");
  await page.goto(config.canva.designUrl, { waitUntil: "domcontentloaded" });

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 このあとの操作");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("1. 開いたブラウザでCanvaにログインしてください（初回のみ）");
  console.log("2. デザイン画面が表示されたら確認OK");
  console.log("3. このターミナルに戻り Ctrl+C を押して終了してください");
  console.log("   → 次回から自動ログインされます");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
