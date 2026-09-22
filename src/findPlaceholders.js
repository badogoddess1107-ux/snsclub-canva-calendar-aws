// テンプレ内の「段落テキスト」要素を全部見つけて、視覚位置(座標)を取得する
// 使い方: node src/findPlaceholders.js

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
  console.log("2. ズームは何でもOK（DOM方式は座標依存しない）");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await waitForEnter("準備OK？Enter: ");

  console.log("🔍 「段落テキスト」要素を探索中...");

  const found = await page.evaluate(() => {
    const all = document.querySelectorAll("*");
    const results = [];
    for (const el of all) {
      const text = (el.textContent || "").trim();
      if (text === "段落テキスト" && el.children.length === 0) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            width: rect.width,
            height: rect.height,
            tagName: el.tagName,
            className: el.className?.toString?.()?.slice(0, 60) || "",
          });
        }
      }
    }
    return results;
  });

  console.log("");
  console.log(`📊 検出数: ${found.length} 個`);

  if (found.length === 0) {
    console.log("⚠️ ひとつも検出できませんでした。");
    console.log("   → Canvaのテキストはcanvas描画でDOMに無いかも");
  } else {
    // Y→Xでソート
    found.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    console.log("");
    console.log("=== 検出位置（Y→Xでソート） ===");
    found.slice(0, 60).forEach((f, i) => {
      console.log(`  [${i.toString().padStart(2, "0")}] (${f.x.toFixed(0)}, ${f.y.toFixed(0)})  ${f.width.toFixed(0)}×${f.height.toFixed(0)}  <${f.tagName}>`);
    });

    // 結果保存
    const outPath = path.join(__dirname, "..", "output", "placeholders.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(found, null, 2), "utf8");
    console.log("");
    console.log(`✅ 保存: ${outPath}`);
  }

  console.log("");
  console.log("Ctrl+Cで終了");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
