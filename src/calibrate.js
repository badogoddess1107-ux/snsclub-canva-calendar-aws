// 座標キャリブレーションスクリプト
// Canvaテンプレページを開いて、Shift+クリックで座標を取得する
// 使い方: node src/calibrate.js

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");

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
  const userDataDir = path.join(__dirname, "..", config.canva.userDataDir);

  console.log("🚀 Chromiumを起動中...");
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
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 手順1: テンプレページを表示");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("1. ブラウザで5月(May)のテンプレページまで移動");
  console.log("2. 右下のズーム調整で月カレンダー全体が画面に入るように");
  console.log("3. 調整完了したらこのターミナルでEnterを押す");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  await waitForEnter("準備OK？Enter押してください: ");

  console.log("");
  console.log("🎯 クリック座標取得モードを有効化...");

  await page.evaluate(() => {
    window.__coords = [];
    const handler = (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const point = { x: e.clientX, y: e.clientY };
        window.__coords.push(point);

        const marker = document.createElement("div");
        const n = window.__coords.length;
        marker.style.cssText = `
          position: fixed;
          left: ${e.clientX - 12}px;
          top: ${e.clientY - 12}px;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: red;
          border: 2px solid white;
          color: white;
          font-weight: bold;
          font-size: 14px;
          line-height: 20px;
          text-align: center;
          z-index: 2147483647;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        `;
        marker.textContent = n;
        document.body.appendChild(marker);
      }
    };
    document.addEventListener("click", handler, true);
    window.__clickHandler = handler;
  });

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 手順2: Shift+クリックで2点指定");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("① [Shift]を押しながら [1週目・日曜マス] の左上角をクリック");
  console.log("② [Shift]を押しながら [最下段・土曜マス] の右下角をクリック");
  console.log("");
  console.log("⚠️ 必ず [Shift] キーを押しながらクリック！");
  console.log("    （押さないとCanvaが反応してしまいます）");
  console.log("");
  console.log("赤い丸1,2が表示されたら2点取得完了です");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("2点クリックしたらこのターミナルに戻り、Enterを押してください");
  await waitForEnter("2点クリック完了？Enter: ");

  const rawCoords = await page.evaluate(() => window.__coords || []);

  // 近接重複（±5px以内）を除去
  const coords = [];
  for (const c of rawCoords) {
    const dup = coords.some((p) => Math.abs(p.x - c.x) <= 5 && Math.abs(p.y - c.y) <= 5);
    if (!dup) coords.push(c);
  }

  console.log("");
  console.log("=== 取得した座標（重複除去後） ===");
  coords.forEach((c, i) => {
    console.log(`  点${i + 1}: (${c.x}, ${c.y})`);
  });

  if (coords.length < 2) {
    console.log("");
    console.log("⚠️ 2点未満しか取得できませんでした。もう一度やり直してください。");
    console.log("   Ctrl+Cで終了して、node src/calibrate.js を再実行");
    await new Promise(() => {});
    return;
  }

  // 最後の2点を採用（途中で間違えて追加クリックしても最終2点が正解扱い）
  const topLeft = coords[coords.length - 2];
  const bottomRight = coords[coords.length - 1];
  const gridWidth = bottomRight.x - topLeft.x;
  const gridHeight = bottomRight.y - topLeft.y;
  const cellWidth = gridWidth / 7;
  const cellHeight = gridHeight / 6;

  console.log("");
  console.log("=== 計算したグリッド情報 ===");
  console.log(`  グリッド全体: ${gridWidth} × ${gridHeight} px`);
  console.log(`  1マスのサイズ: ${cellWidth.toFixed(1)} × ${cellHeight.toFixed(1)} px`);

  const viewport = page.viewportSize();
  const gridInfo = {
    capturedAt: new Date().toISOString(),
    viewport,
    topLeft,
    bottomRight,
    gridWidth,
    gridHeight,
    cellWidth,
    cellHeight,
    cols: 7,
    rows: 6,
  };

  const outPath = path.join(__dirname, "..", "output", "grid-coords.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(gridInfo, null, 2), "utf8");

  console.log("");
  console.log(`✅ 保存: ${outPath}`);
  console.log("");
  console.log("📸 スクリーンショット保存中...");
  const shotPath = path.join(__dirname, "..", "output", "template-view.png");
  await page.screenshot({ path: shotPath, fullPage: false });
  console.log(`   ${shotPath}`);
  console.log("");
  console.log("次のステップ: 1マスだけテキスト書込みテスト");
  console.log("ブラウザは開いたまま、Ctrl+Cで終了してください");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
