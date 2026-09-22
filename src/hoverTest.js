// マス位置計算が正しいか視覚確認するスクリプト
// 各日の中心座標に赤いマーカーを表示する（実際にCanvaを書き換えない）
// 使い方: node src/hoverTest.js [年] [月]
//   省略時: 2026 5

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");
const { cellCenter, getLastDay } = require("./calendarGrid");

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
  const args = process.argv.slice(2);
  const year = parseInt(args[0] || "2026", 10);
  const month = parseInt(args[1] || "5", 10);

  // grid-coords.json を読込
  const gridPath = path.join(__dirname, "..", "output", "grid-coords.json");
  if (!fs.existsSync(gridPath)) {
    console.error(`❌ ${gridPath} が見つかりません`);
    console.error("   先に node src/calibrate.js を実行してください");
    process.exit(1);
  }
  const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));
  console.log(`📐 グリッド: ${grid.gridWidth}×${grid.gridHeight}, セル: ${grid.cellWidth.toFixed(1)}×${grid.cellHeight.toFixed(1)}`);

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
  console.log("📋 手順");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("1. ブラウザで5月テンプレページに移動");
  console.log("2. ⚠️ ズームは calibrate.js 実行時と同じに!");
  console.log("3. このターミナルでEnterを押す");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await waitForEnter("準備OK？Enter: ");

  // 各日の中心にマーカーをオーバーレイ
  const lastDay = getLastDay(year, month);
  const marks = [];
  for (let day = 1; day <= lastDay; day++) {
    const c = cellCenter(grid, year, month, day);
    marks.push({ day, x: c.x, y: c.y });
  }

  await page.evaluate((data) => {
    // 既存マーカー削除
    document.querySelectorAll(".__hoverMark").forEach((el) => el.remove());

    data.forEach(({ day, x, y }) => {
      const m = document.createElement("div");
      m.className = "__hoverMark";
      m.style.cssText = `
        position: fixed;
        left: ${x - 14}px;
        top: ${y - 14}px;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: rgba(255, 0, 0, 0.7);
        border: 2px solid white;
        color: white;
        font-weight: bold;
        font-size: 12px;
        line-height: 24px;
        text-align: center;
        z-index: 2147483647;
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      `;
      m.textContent = day;
      document.body.appendChild(m);
    });
  }, marks);

  console.log("");
  console.log(`✅ ${lastDay}日分のマーカーを表示しました`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 確認してください");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("ブラウザに赤い丸の数字（1〜31）が表示されているはず");
  console.log("各マスの中央付近に正しく配置されているか目視確認");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("確認したらCtrl+Cで終了してください");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
