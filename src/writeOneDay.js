// 1マス書込みテスト
// 5月1日マスの「段落テキスト」を本当のデータで上書きする
// 使い方: node src/writeOneDay.js [日]   省略時=1
//   例: node src/writeOneDay.js 1

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");
const { cellCenter } = require("./calendarGrid");

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
  const targetDay = parseInt(process.argv[2] || "1", 10);
  const year = 2026;
  const month = 5;

  // 日別データJSON
  const jsonPath = path.join(__dirname, "..", "output", `${year}-${String(month).padStart(2, "0")}.json`);
  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ ${jsonPath} がありません。先に node src/index.js ${year} ${month}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const dayData = data.days.find((d) => d.date === targetDay);
  if (!dayData) {
    console.error(`❌ ${targetDay}日のデータがありません`);
    process.exit(1);
  }

  console.log(`📅 書き込む内容（${month}/${targetDay} ${dayData.weekday}曜）:`);
  dayData.lines.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));

  // グリッド情報
  const gridPath = path.join(__dirname, "..", "output", "grid-coords.json");
  const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));
  const cell = cellCenter(grid, year, month, targetDay);
  console.log(`📍 マス座標: (${cell.x.toFixed(0)}, ${cell.y.toFixed(0)})`);

  const userDataDir = path.join(__dirname, "..", config.canva.userDataDir);
  console.log("");
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
  console.log("1. 5月テンプレページを表示");
  console.log("2. ⚠️ ズームを前回と同じに!");
  console.log("3. 何も選択していない状態にする");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await waitForEnter("準備OK？Enter: ");

  // ── 書込み処理 ──
  console.log("");
  console.log("✏️ 書き込み開始...");

  // 1. テキストボックスをクリックして選択
  console.log("  1) クリックして選択");
  await page.mouse.click(cell.x, cell.y);
  await page.waitForTimeout(500);

  // 2. ダブルクリックで編集モード
  console.log("  2) ダブルクリックで編集モード");
  await page.mouse.dblclick(cell.x, cell.y);
  await page.waitForTimeout(700);

  // 3. 全選択
  console.log("  3) Cmd+A で全選択");
  await page.keyboard.press("Meta+A");
  await page.waitForTimeout(300);

  // 4. 改行付きで書込み
  console.log("  4) テキスト書込み (改行付き)");
  for (let i = 0; i < dayData.lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
    }
    await page.keyboard.type(dayData.lines[i], { delay: 30 });
    await page.waitForTimeout(150);
  }

  // 5. Escapeで編集終了
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");

  console.log("");
  console.log("✅ 書込み完了");
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 確認してください");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`5月${targetDay}日のマスに以下が入ったはず:`);
  dayData.lines.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  console.log("");
  console.log("結果スクショして次のメッセージで報告してください");
  console.log("Ctrl+Cで終了");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
