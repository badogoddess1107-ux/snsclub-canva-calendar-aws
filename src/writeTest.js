// 1マスだけテキスト書込みテスト
// 5月1日のマスに「1」を書き込めるか試す
// 使い方: node src/writeTest.js

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");
const { cellCenter, cellTopLeft } = require("./calendarGrid");

chromium.use(stealth);

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const gridPath = path.join(__dirname, "..", "output", "grid-coords.json");
  const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));

  const userDataDir = path.join(__dirname, "..", config.canva.userDataDir);
  console.log("🚀 Chromiumを起動中...");

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(config.canva.designUrl, { waitUntil: "domcontentloaded" });

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 準備");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("1. ブラウザで5月テンプレページに移動");
  console.log("2. ⚠️ ズームを前回と同じに!");
  console.log("3. 何も選択していない状態にする(空白部分をクリック)");
  console.log("4. ターミナルでEnter");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await waitForEnter("準備OK？Enter: ");

  // 5月1日のマス中心座標
  const cell = cellCenter(grid, 2026, 5, 1);
  console.log(`📍 5月1日マスの中心: (${cell.x.toFixed(0)}, ${cell.y.toFixed(0)})`);

  // ── テスト1: ダブルクリック → 文字入力 ──
  console.log("");
  console.log("=== テスト1: ダブルクリック→文字入力 ===");
  console.log("マスをダブルクリックしてテキスト入力モードを試みます...");

  await page.mouse.move(cell.x, cell.y);
  await page.waitForTimeout(300);
  await page.mouse.dblclick(cell.x, cell.y);
  await page.waitForTimeout(800);
  await page.keyboard.type("テスト1", { delay: 100 });
  await page.waitForTimeout(500);

  console.log("→ ブラウザを確認: 「テスト1」が表示されましたか?");
  await waitForEnter("確認したらEnter: ");

  // 何も書き込まれてない場合、Tキーで追加 ──
  console.log("");
  console.log("=== テスト2: T(新規テキスト)→文字入力 ===");
  console.log("Escを押してから T を押します...");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // マスの座標にマウスを置く
  await page.mouse.move(cell.x, cell.y);
  await page.waitForTimeout(300);

  await page.keyboard.press("t");
  await page.waitForTimeout(1500);

  await page.keyboard.type("テスト2", { delay: 100 });
  await page.waitForTimeout(500);

  console.log("→ ブラウザを確認: 「テスト2」というテキストボックスが追加されましたか?");
  console.log("   どこに表示されてますか?");
  await waitForEnter("確認したらEnter: ");

  console.log("");
  console.log("=== 結果のヒアリング ===");
  console.log("結果を教えてください（Ctrl+Cで終了してから次のメッセージで報告）:");
  console.log("  Q1. 「テスト1」は表示された? どこに?");
  console.log("  Q2. 「テスト2」は表示された? どこに?");
  console.log("  Q3. 5月1日のマスに何か入った?");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
