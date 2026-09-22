// ============================================================
// simpleWrite.js — Canva にテキスト書込み (CLI)
// ============================================================
// 共有ロジックは canvaCore.js にある。 ここは CLI のラッパー。
//
// 使い方:
//   node src/simpleWrite.js --page=34 --month=2026-07
//   node src/simpleWrite.js --page=34 --month=2026-07 --only=1     # 1日だけテスト
//   node src/simpleWrite.js --page=34 --month=2026-07 --dry-run    # データ確認のみ
//   node src/simpleWrite.js --page=34 --month=2026-07 --skip-title # 月タイトルを更新しない
//
// 月タイトル (「2026.6」「June」) は日付セルより先に自動更新される。
//
// Web UI から操作したい場合は webServer.js を使う:
//   node src/webServer.js
// ============================================================

const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");
const core = require("./canvaCore");

chromium.use(stealth);

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.+))?$/);
    if (m) args[m[1]] = m[2] ?? true;
  }
  return args;
}

/** writeAllDays の進捗イベントを CLI ログに変換 */
function cliEventLogger(ev) {
  switch (ev.type) {
    case "dayStart": {
      const tag = ev.hasMultiple ? ` (★${ev.entryCount}行マージ)` : "";
      console.log(`   → ${ev.date}日(${ev.weekday})${tag} cell(${ev.r},${ev.c})`);
      break;
    }
    case "retry":
      console.log(`      🔁 リトライ (理由: ${ev.reason})`);
      break;
    case "daySuccess":
      console.log(`      ✓ ${ev.date}日 書込み成功 (found="${ev.found}")`);
      break;
    case "dayVerifyFail":
      console.log(`      ⚠️ ${ev.date}日 verify 失敗 (found="${ev.found}")`);
      break;
    case "dayFail":
      console.log(`      ❌ ${ev.date}日 書込み失敗 (理由: ${ev.reason})`);
      break;
    case "titleScan":
      console.log(`   🔤 月タイトル候補 ${ev.candidates}個 [${ev.texts.join(", ")}] → 要更新 ${ev.updates}個`);
      break;
    case "titleStart":
      console.log(`   → タイトル "${ev.before}" → "${ev.after}"`);
      break;
    case "titleSuccess":
      console.log(`      ✓ タイトル更新成功 "${ev.after}"`);
      break;
    case "titleSkip":
      console.log(`      － "${ev.text}" は既に正しいのでスキップ`);
      break;
    case "titleFail":
      console.log(`      ❌ タイトル "${ev.before}" 更新失敗 (理由: ${ev.reason})`);
      break;
    case "log":
      console.log(ev.message);
      break;
  }
}

async function main() {
  const args = parseArgs();
  const pageNumber = parseInt(args.page, 10);
  const month = args.month;
  const onlyDate = args.only ? parseInt(args.only, 10) : null;
  const dryRun = !!args["dry-run"];
  const skipTitle = !!args["skip-title"];

  if (!pageNumber || !month || !/^\d{4}-\d{2}$/.test(month)) {
    console.error("使い方: node src/simpleWrite.js --page=34 --month=2026-07 [--only=1] [--dry-run] [--skip-title]");
    process.exit(1);
  }

  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);

  // ① 座標 JSON 読込み (無ければフォールバック。 書込み直前に実測で再構築される)
  const coordResult = core.loadCoordWithFallback(pageNumber, month);
  const coord = coordResult.coord;
  console.log(`📐 ${core.describeCoordSource(coordResult, pageNumber, month)}`);

  // ② データ取得
  console.log(`📥 ${year}年${monthNum}月 データ取得...`);
  const days = await core.fetchMonthData(year, monthNum);
  console.log(`   ${days.length}日分取得`);

  // ③ 各日に cell (r, c) を割当
  const { dayCellMap, skipped } = core.assignDays(days, year, monthNum, coord);
  for (const s of skipped) {
    console.log(`   ⚠️ ${s.day.date}日(${s.day.weekday}) row=${s.r} col=${s.c} は範囲外 → スキップ`);
  }
  console.log(`   ${dayCellMap.length}日 を セルに割当`);

  // フィルタ: --only=N
  let targetMap = dayCellMap;
  if (onlyDate) {
    targetMap = dayCellMap.filter((x) => x.day.date === onlyDate);
    if (targetMap.length === 0) {
      console.error(`❌ --only=${onlyDate} に該当日無し`);
      process.exit(1);
    }
    console.log(`   --only=${onlyDate} 指定 → 1日だけテスト`);
  }

  // ④ データ確認 (dry-run)
  console.log("");
  console.log("📋 書込み対象:");
  for (const { day, r, c, cellTop } of targetMap) {
    const xy = cellTop ? `(${cellTop.x.toFixed(0)},${cellTop.y.toFixed(0)})` : "(座標は実行時に再取得)";
    console.log(`   ${day.date}日(${day.weekday}) row=${r} col=${c} ${xy}`);
    for (const line of day.lines) console.log(`       "${line}"`);
  }
  if (dryRun) {
    console.log("\n✅ --dry-run 指定: Canva 起動せず終了");
    process.exit(0);
  }

  // ⑤ Canva 起動
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

    console.log(`\n📑 P${pageNumber} に移動します`);
    console.log(`   ※ Canva を最大化して、 移動完了まで他の操作をしないでください`);
    await waitForEnter("✅ 準備できたら Enter ... ");
    console.log("");
    console.log(`📑 ページ${pageNumber}に移動中...`);
    await core.navigateToPage(page, pageNumber);

    console.log("🔄 focus リセット...");
    await core.resetFocus(page);
    await page.waitForTimeout(300);

    // ⑥ placeholder 再検出 → cells 再構築
    console.log("🔍 現在の placeholder を再取得 → cells 再構築...");
    let info;
    try {
      info = await core.rebuildCellsAndAssign(page, targetMap);
    } catch (e) {
      console.error(`❌ ${e.message}。 Cmd+Z でクリーン状態 (42個=段落テキスト) に戻してください。`);
      throw e;
    }
    console.log(`   現在の placeholder 検出: ${info.count}個`);
    console.log(`   ✓ cells 再構築完了 / bbox: 幅=${info.bbox.w.toFixed(0)}px 高=${info.bbox.h.toFixed(0)}px`);
    console.log(`   ✓ 各日の cellTop を更新`);

    // ⑦ 月タイトル更新 (日付セルより先に実行 — 罠6 対策)
    if (skipTitle) {
      console.log("\n🔤 月タイトル更新: --skip-title 指定によりスキップ");
    } else {
      console.log(`\n🔤 月タイトルを ${year}年${monthNum}月 に更新...`);
      const titleResult = await core.writeMonthTitle(page, {
        year, month: monthNum, cells: info.cells,
        onEvent: cliEventLogger, debug: !!onlyDate,
      });
      if (titleResult.candidates === 0) {
        console.log("   ⚠️ 月タイトルが見つかりませんでした (グリッド上部を確認してください)");
      } else if (!titleResult.ok) {
        console.log(`   ⚠️ タイトル更新に失敗が ${titleResult.failed.length}件 → 手動修正推奨`);
      }
    }

    // ⑧ 書込みループ
    console.log(`\n✏️ ${targetMap.length}日分の書込み開始`);
    const results = await core.writeAllDays(page, targetMap, { debug: !!onlyDate, onEvent: cliEventLogger });

    // ⑨ サマリ
    const ok = results.filter((r) => r.ok).map((r) => r.day.date);
    const fail = results.filter((r) => !r.ok).map((r) => r.day.date);
    console.log(`\n📊 サマリ: 成功 ${ok.length}/${results.length}日`);
    if (ok.length > 0) console.log(`   ✅ 成功日: ${ok.join(", ")}`);
    if (fail.length > 0) console.log(`   ❌ 失敗日: ${fail.join(", ")} → 手動入力推奨`);
    console.log("\n✅ 書込み完了");
    exitCode = ok.length === results.length ? 0 : 2;
  } catch (err) {
    console.error("\n❌ エラー:", err.message);
  } finally {
    console.log("\nChromium は手動で閉じてください (結果を Canva 上で確認後)");
    process.exit(exitCode);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("致命的エラー:", err);
    process.exit(1);
  });
}

module.exports = { main, cliEventLogger };
