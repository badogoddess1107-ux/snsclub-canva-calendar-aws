// ============================================================
// calibratePage.js — Step 1: 座標取得
// ============================================================
// 指定された Canva ページの placeholder 42個 (旧テンプレ) を検出し、
// 6行×7列の cells 構造にグループ化して JSON 保存する。
//
// 使い方:
//   node src/calibratePage.js --page=35 --month=2026-06
//
// 出力:
//   coords/p35-2026-06.json
//
// JSON 構造:
//   {
//     "page": 35,
//     "month": "2026-06",
//     "calibratedAt": "2026-05-26T...",
//     "viewport": { "w": 1368, "h": 691 },
//     "bbox": { "minX":..., "minY":..., "maxX":..., "maxY":... },
//     "cells": [
//       [ {r,c, x,y, w,h, left,top,right,bottom}, ... 7個 ],  // row 0
//       ...
//       [ ... ]  // row 5
//     ]
//   }
// ============================================================

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");

chromium.use(stealth);

const PLACEHOLDER_TEXT = "段落テキスト";
const COLS = 7;
const ROWS = 6;

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function findPlaceholders(page) {
  return await page.evaluate((needle) => {
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
            results.push({
              x: cx, y: cy, w: rect.width, h: rect.height,
              left: rect.x, top: rect.y,
              right: rect.x + rect.width, bottom: rect.y + rect.height,
            });
          }
        }
      }
    }
    return results;
  }, PLACEHOLDER_TEXT);
}

/**
 * 42個の placeholder を 6行×7列にグループ化。
 *  - まず Y軸でソート、 Y_GAP=30px 以内は同一行扱い (X軸でソート)
 *  - 42 = 6×7 を前提に slice する (Y_GAP 判定が崩れたときの保険)
 */
function groupCells(placeholders) {
  if (placeholders.length !== ROWS * COLS) {
    throw new Error(`placeholder 数 ${placeholders.length} ≠ ${ROWS * COLS} (期待値)`);
  }
  // ① Y軸→X軸 で安定ソート
  const sorted = [...placeholders].sort((a, b) => {
    if (Math.abs(a.y - b.y) < 30) return a.x - b.x;
    return a.y - b.y;
  });
  // ② 7個ずつ slice
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const ph = sorted[r * COLS + c];
      row.push({
        r, c,
        x: ph.x, y: ph.y,
        w: ph.w, h: ph.h,
        left: ph.left, top: ph.top,
        right: ph.right, bottom: ph.bottom,
      });
    }
    cells.push(row);
  }
  return cells;
}

/**
 * グループ化の健全性を検証 (各行の Y 平均が単調増加しているか等)
 */
function validateCells(cells) {
  const errors = [];
  // 1) 各行 7個揃っているか
  for (let r = 0; r < ROWS; r++) {
    if (cells[r].length !== COLS) errors.push(`row ${r}: ${cells[r].length}個 (≠7)`);
  }
  // 2) 行間 Y 平均が単調増加 (row 0 < row 1 < ... < row 5)
  const rowYs = cells.map((row) => row.reduce((s, c) => s + c.y, 0) / row.length);
  for (let r = 1; r < ROWS; r++) {
    if (rowYs[r] <= rowYs[r - 1]) {
      errors.push(`row ${r-1} y=${rowYs[r-1].toFixed(0)} ≥ row ${r} y=${rowYs[r].toFixed(0)} (順序逆転)`);
    }
  }
  // 3) 各行内 X が単調増加 (col 0 < col 1 < ... < col 6)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 1; c < COLS; c++) {
      if (cells[r][c].x <= cells[r][c-1].x) {
        errors.push(`row ${r} col ${c-1} x=${cells[r][c-1].x.toFixed(0)} ≥ col ${c} x=${cells[r][c].x.toFixed(0)} (X逆転)`);
      }
    }
  }
  return errors;
}

async function main() {
  const args = parseArgs();
  const pageNumber = parseInt(args.page, 10);
  const month = args.month;

  if (!pageNumber || !month || !/^\d{4}-\d{2}$/.test(month)) {
    console.error("使い方: node src/calibratePage.js --page=35 --month=2026-06");
    process.exit(1);
  }

  console.log(`▶️ calibratePage 開始`);
  console.log(`   📅 月: ${month}`);
  console.log(`   📄 ページ: P${pageNumber}`);
  console.log("");

  const userDataDir = path.join(__dirname, "..", config.canva.userDataDir);
  console.log("🚀 Chromium起動...");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  let exitCode = 1;
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.canva.designUrl, { waitUntil: "domcontentloaded" });
    console.log("⏳ Canva 初期描画待機 (8秒)...");
    await page.waitForTimeout(8000);

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`📋 準備手順 (Canva ブラウザで操作してください):`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  1) P${pageNumber} (${month}) に移動`);
    console.log(`  2) ブラウザウィンドウを 緑ボタンで フルスクリーン化`);
    console.log(`  3) Canva の ズームで「ページに合わせる」 (Cmd+Alt+0) を実行`);
    console.log(`  4) 画面に カレンダー1ページ全体 が表示されている状態にする`);
    console.log(`  5) 「段落テキスト」 が 42個 全部見えている事を確認`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    await waitForEnter("✅ 準備できたら Enter を押してください... ");
    console.log("");

    console.log("🔍 placeholder 検出中...");
    let placeholders = await findPlaceholders(page);
    console.log(`   検出: ${placeholders.length}個`);

    if (placeholders.length !== ROWS * COLS) {
      console.error("");
      console.error(`❌ 検出数が ${ROWS * COLS}個 (= 6×7) ではありません: ${placeholders.length}個`);
      console.error("");
      console.error("対処:");
      console.error("  - 既に書込み済の placeholder があると検出されません (textContent が「段落テキスト」 以外になっているため)");
      console.error("  - Canva 上で Cmd+Z を 50-100回 連打して クリーン状態に戻してください");
      console.error("  - その後 もう一度 スクリプト再実行 (このまま Enter で再検出を試みます)");
      console.error("");
      await waitForEnter("✅ クリーン状態にしたら Enter で再検出... ");
      placeholders = await findPlaceholders(page);
      console.log(`   再検出: ${placeholders.length}個`);
      if (placeholders.length !== ROWS * COLS) {
        throw new Error(`再検出も失敗: ${placeholders.length}個`);
      }
    }

    // 健全性: bbox サイズチェック
    const xs = placeholders.map((p) => p.x);
    const ys = placeholders.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const xSpan = maxX - minX;
    const ySpan = maxY - minY;
    const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

    console.log(`   bbox: 幅=${xSpan.toFixed(0)}px 高=${ySpan.toFixed(0)}px (viewport: ${viewport.w}×${viewport.h})`);
    console.log(`         範囲: X(${minX.toFixed(0)}〜${maxX.toFixed(0)}) Y(${minY.toFixed(0)}〜${maxY.toFixed(0)})`);

    // グループ化
    console.log("📐 6×7 グループ化...");
    const cells = groupCells(placeholders);

    // 検証
    const errors = validateCells(cells);
    if (errors.length > 0) {
      console.error("");
      console.error("❌ グループ化の整合性に問題:");
      errors.forEach((e) => console.error(`   - ${e}`));
      throw new Error("グループ化失敗 — placeholder 配置を再確認してください");
    }
    console.log("   ✓ 各行 7個 / Y単調増加 / X単調増加 OK");

    // セル一覧 (デバッグ用に短く)
    console.log("");
    console.log("📊 セル一覧 (cell(r,c) = (x, y)):");
    for (let r = 0; r < ROWS; r++) {
      const cellsStr = cells[r].map((c) => `(${c.x.toFixed(0)},${c.y.toFixed(0)})`).join(" ");
      console.log(`   row ${r}: ${cellsStr}`);
    }

    // JSON 保存
    const outDir = path.join(__dirname, "..", "coords");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `p${pageNumber}-${month}.json`);
    const json = {
      page: pageNumber,
      month,
      calibratedAt: new Date().toISOString(),
      viewport,
      bbox: { minX, minY, maxX, maxY, xSpan, ySpan },
      cells,
    };
    fs.writeFileSync(outFile, JSON.stringify(json, null, 2), "utf8");
    console.log("");
    console.log(`✅ 座標を保存: ${outFile}`);
    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("次のステップ: simpleWrite.js で書込み実行");
    console.log("  node src/simpleWrite.js --page=" + pageNumber + " --month=" + month);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    exitCode = 0;
  } catch (err) {
    console.error("");
    console.error("❌ エラー:", err.message);
  } finally {
    await context.close().catch(() => {});
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
