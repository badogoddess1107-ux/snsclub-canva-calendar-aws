// DOM検索ベースのCanva書込みスクリプト
// 各実行時に「段落テキスト」要素を再検出するのでズーム変更に強い
// 使い方:
//   node src/writeCanva.js           # 5月1日だけテスト
//   node src/writeCanva.js --all     # 5月全日

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");
const { toRowCol } = require("./calendarGrid");
const { mergeDays } = require("./buildDayData");

chromium.use(stealth);

const PLACEHOLDER_TEXT = "段落テキスト";
const COLS = 7;

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

/**
 * ページ内の全「段落テキスト」を Y→X でソートして返す
 * 中心座標がビューポート内のもののみ採用 (現在表示中のページ要素だけ拾う)
 */
async function findPlaceholders(page) {
  const found = await page.evaluate((needle) => {
    const all = document.querySelectorAll("*");
    const results = [];
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    for (const el of all) {
      const text = (el.textContent || "").trim();
      if (text === needle && el.children.length === 0) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) {
            results.push({ x: cx, y: cy, width: rect.width, height: rect.height });
          }
        }
      }
    }
    return results;
  }, PLACEHOLDER_TEXT);

  // Y(行)→X(列) でソート。ただし同じ行と判定するゆるめの閾値あり
  found.sort((a, b) => {
    if (Math.abs(a.y - b.y) < 20) return a.x - b.x;
    return a.y - b.y;
  });

  return found;
}

/**
 * 指定座標のマスにテキストを書き込む
 */
async function trySetFontSize(page, size) {
  try {
    const ok = await page.evaluate((targetSize) => {
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const label = (input.getAttribute('aria-label') || '').toLowerCase();
        if (
          label.includes('font size') ||
          label.includes('フォントサイズ') ||
          label.includes('文字サイズ') ||
          (label.includes('font') && label.includes('size'))
        ) {
          input.focus();
          input.select();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, String(targetSize));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, size);
    if (ok) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    return ok;
  } catch {
    return false;
  }
}

async function writeCell(page, pos, day) {
  const lines = day.lines;

  // === Phase 1: 編集モードに入って既存プレースホルダーを置換 ===
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(300);
  await page.mouse.dblclick(pos.x, pos.y);
  await page.waitForTimeout(500);
  await page.keyboard.press("Meta+A");
  await page.waitForTimeout(200);

  // === Phase 2: 全行を入力 ===
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(80);
    }
    await page.keyboard.type(lines[i], { delay: 25 });
  }
  await page.waitForTimeout(400);

  // === Phase 3: 修正8 ─ 全選択 → 7pt ===
  await page.keyboard.press("Meta+A");
  await page.waitForTimeout(200);
  const ok7 = await trySetFontSize(page, 7);
  await page.waitForTimeout(400);

  // === Phase 4: 1行目(日付)を選択 → 19pt ===
  // フォント入力にフォーカスが移っているので再度編集モードへ
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(250);
  await page.mouse.dblclick(pos.x, pos.y);
  await page.waitForTimeout(500);

  await page.keyboard.press("Meta+A");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(150);
  await page.keyboard.press("Shift+Meta+ArrowRight");
  await page.waitForTimeout(200);

  const ok19 = await trySetFontSize(page, 19);
  await page.waitForTimeout(400);

  if (!ok7 || !ok19) {
    console.log(`     ⚠️ ${day.date}日: フォントサイズ設定失敗 (7pt=${ok7}, 19pt=${ok19})`);
  }

  // === Phase 5: 編集モードを抜ける ===
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

async function main() {
  const args = process.argv.slice(2);
  const writeAll = args.includes("--all");
  const year = 2026;
  const month = 5;

  // 日別データJSON
  const jsonPath = path.join(__dirname, "..", "output", `${year}-${String(month).padStart(2, "0")}.json`);
  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ ${jsonPath} がありません。先に node src/index.js ${year} ${month}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  // 既存 JSON が古い形式(マージ前)でも安全のため再マージ
  data.days = mergeDays(data.days);

  console.log(writeAll ? `📅 全${data.days.length}日分書込み` : "📅 5月1日のみテスト書込み");

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
  console.log("1. 5月テンプレページを表示");
  console.log("2. 全マスが「段落テキスト」になってることを確認");
  console.log("3. 何も選択していない状態にする");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await waitForEnter("準備OK？Enter: ");

  console.log("");
  console.log("🔍 段落テキスト要素を検索中...");
  const placeholders = await findPlaceholders(page);
  console.log(`   検出: ${placeholders.length} 個`);

  if (placeholders.length < 42) {
    console.log("⚠️ 期待値42個に達してません。テンプレ確認してください");
    console.log("   Ctrl+Cで終了");
    await new Promise(() => {});
    return;
  }

  // 書込み対象日の抽出
  const targets = writeAll ? data.days : data.days.filter((d) => d.date === 1);

  console.log("");
  console.log(`✏️ ${targets.length}日分の書込み開始`);
  console.log("");

  for (const day of targets) {
    const { row, col } = toRowCol(year, month, day.date);
    const idx = row * COLS + col;
    const pos = placeholders[idx];

    if (!pos) {
      console.log(`  ⚠️ ${day.date}日: index ${idx} のマスが見つかりません(skip)`);
      continue;
    }

    const tag = day.hasMultiple ? ` ★${day.entryCount}行マージ` : "";
    console.log(`  → ${day.date}日(${day.weekday}) row${row}/col${col} idx${idx} (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})${tag}`);
    await writeCell(page, pos, day);
  }

  console.log("");
  console.log("✅ 書込み完了");
  console.log("");
  console.log("ブラウザで結果を確認してください");
  console.log("Ctrl+Cで終了");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
