// ============================================================
// canvaCore.js — Canva 書込みの共有ロジック
// ============================================================
// simpleWrite.js (CLI) と webServer.js (Web UI) の両方から使う。
// Playwright の page を受け取って操作する純粋なヘルパー群 +
// 高レベル関数 (データ準備 / placeholder 再検出 / 書込みループ)。
// ============================================================

const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");
const { parseIcs } = require("./icsParser");
const { buildDay, mergeDays } = require("./buildDayData");
const monthTitle = require("./monthTitle");

// キーボードショートカットの修飾キー。 Mac は Meta(⌘)、 Linux(AWS コンテナ) は Control。
// Meta+A を Linux で送っても全選択にならず、 上書きが「追記」になって壊れるため必ずこれを使う。
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const PLACEHOLDER_TEXT = "段落テキスト";
const WEEKDAY_TO_COL = { "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6 };

// ============================================================
// データ準備
// ============================================================

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * カレンダーにイベントが無い日を「日付だけ」の要素として補完する。
 * これをしないとイベントの無い日のマスに placeholder (「段落テキスト」) が残り、
 * 書き出したカレンダーに日付が入らない。
 */
function fillMissingDays(days, year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const filled = [];
  for (let date = 1; date <= lastDay; date++) {
    const existing = byDate.get(date);
    if (existing) {
      filled.push(existing);
      continue;
    }
    filled.push({
      date,
      weekday: WEEKDAYS[new Date(year, month - 1, date).getDay()],
      isSpecial: false,
      specials: [],
      lines: [String(date)],   // 日付のみ (本文なし)
      isEmpty: true,           // 予定が無い日の目印
    });
  }
  return filled;
}

async function fetchMonthData(year, month) {
  const res = await fetch(config.calendar.icsUrl);
  if (!res.ok) throw new Error(`カレンダー取得失敗 HTTP ${res.status}`);
  const text = await res.text();
  const events = parseIcs(text);
  const rawDays = events.map((ev) => buildDay(ev, year, month)).filter(Boolean).sort((a, b) => a.date - b.date);
  return fillMissingDays(mergeDays(rawDays), year, month);
}

/** coords/pNN-YYYY-MM.json を読込む (存在しなければ throw) */
function loadCoord(pageNumber, month) {
  const coordFile = path.join(__dirname, "..", "coords", `p${pageNumber}-${month}.json`);
  if (!fs.existsSync(coordFile)) {
    throw new Error(`座標ファイル無し: ${coordFile} (先に calibratePage.js で生成してください)`);
  }
  return { coord: JSON.parse(fs.readFileSync(coordFile, "utf8")), coordFile };
}

/**
 * 座標ファイルを「無くても動く」形で読込む。
 *
 * coord は cellTop の初期値にしか使われず、 書込み直前に rebuildCellsAndAssign が
 * live placeholder の実測値で必ず上書きする (canvaCore 内 dayCellMap の cellTop 再代入)。
 * さらにグリッド形状は「ページ」に依存し「月」には依存しない (月は assignDays が計算する)。
 * よって月ごとの較正は必須ではないため、 次の順に緩やかにフォールバックする。
 *
 *   1. exact     … p{page}-{month}.json         (完全一致)
 *   2. samePage  … 同じページの別月               (形状が同じなので流用可)
 *   3. otherPage … 別ページ                      (実測で作り直されるので暫定値として可)
 *   4. stub      … 空の 6×7                      (較正ファイルが1つも無い場合)
 *
 * @returns {{ coord, source, file: string|null }}
 */
function loadCoordWithFallback(pageNumber, month) {
  const dir = path.join(__dirname, "..", "coords");
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));

  const exact = `p${pageNumber}-${month}.json`;
  if (fs.existsSync(path.join(dir, exact))) {
    return { coord: read(exact), source: "exact", file: exact };
  }

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^p\d+-\d{4}-\d{2}\.json$/.test(f)).sort();
  } catch { /* coords ディレクトリが無い */ }

  const samePage = files.filter((f) => f.startsWith(`p${pageNumber}-`));
  if (samePage.length > 0) {
    const file = samePage[samePage.length - 1];
    return { coord: read(file), source: "samePage", file };
  }

  if (files.length > 0) {
    const file = files[files.length - 1];
    return { coord: read(file), source: "otherPage", file };
  }

  const cells = Array.from({ length: 6 }, () => Array(7).fill(null));
  return { coord: { cells, synthesized: true }, source: "stub", file: null };
}

/** フォールバック内容を人間向けに説明する1行 */
function describeCoordSource(result, pageNumber, month) {
  switch (result.source) {
    case "exact":
      return `較正済み座標を使用 (${result.file})`;
    case "samePage":
      return `${pageNumber}ページの別月の座標を流用 (${result.file}) — 形状はページ依存のため問題なし`;
    case "otherPage":
      return `別ページの座標を暫定使用 (${result.file}) — 書込み直前に実測で再構築します`;
    default:
      return `較正ファイル無し → 空グリッドで開始 — 書込み直前に実測で再構築します`;
  }
}

/**
 * 月 + 日付 → cells の (r, c) を計算
 * 例: 2026/6/1 (月曜) → row=0, col=1 (SUN=0, MON=1, ...)
 */
function dayToCellRC(year, month, date, firstWeekdayOfMonth) {
  const dayIndexFromMonthStart = (firstWeekdayOfMonth + (date - 1));
  const r = Math.floor(dayIndexFromMonthStart / 7);
  const c = dayIndexFromMonthStart % 7;
  return { r, c };
}

/**
 * days を 6×7 セルに割当てて dayCellMap を返す。
 * cellTop は coord.cells[r][c] (JSON値) で初期化。 実書込み前に live placeholder で上書きされる。
 * @returns {{ dayCellMap, skipped }}
 */
function assignDays(days, year, monthNum, coord) {
  const firstWeekday = new Date(year, monthNum - 1, 1).getDay();
  const dayCellMap = [];
  const skipped = [];
  for (const day of days) {
    const { r, c } = dayToCellRC(year, monthNum, day.date, firstWeekday);
    if (r < 0 || r > 5 || c < 0 || c > 6) {
      skipped.push({ day, r, c });
      continue;
    }
    const cellTop = coord.cells?.[r]?.[c] || null;
    dayCellMap.push({ day, r, c, cellTop });
  }
  return { dayCellMap, skipped };
}

// ============================================================
// Playwright ナビゲーション
// ============================================================

async function navigateToPage(page, targetPage) {
  const viewport = await page.viewportSize();
  if (viewport) await page.mouse.click(viewport.width / 2, viewport.height / 2);
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press(`${MOD}+ArrowUp`);
  await page.waitForTimeout(800);
  for (let i = 1; i < targetPage; i++) {
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);
}

// ★重要 (2026-05-30 実機デバッグで判明):
//  この Canva では PageDown/PageUp/Meta+Arrow が「効かない」(総当たり検証済)。
//  効くのは (a) マウスホイールスクロール、 (b) DOM の scrollIntoView。
//  ページは data-page-id を持つ 37個の要素として全て DOM に存在し、 縦に等間隔配置。
//  → 目的ページへは「N番目の data-page-id 要素を scrollIntoView(center)」 が最も確実。

/** N番目のページ要素へ scrollIntoView で移動 (キーボード不要・ズーム不問で確実) */
async function gotoPageByScroll(page, pageNum) {
  const r = await page.evaluate((n) => {
    let pages = Array.from(document.querySelectorAll("[data-page-id]"));
    if (pages.length < 2) {
      pages = Array.from(document.querySelectorAll("div")).filter((el) => {
        const h = el.getBoundingClientRect().height;
        return h > 460 && h < 580;
      });
    }
    pages.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const uniq = [];
    let lastY = -1e9;
    for (const el of pages) {
      const y = el.getBoundingClientRect().top;
      if (Math.abs(y - lastY) > 100) { uniq.push(el); lastY = y; }
    }
    if (n < 1 || n > uniq.length) return { ok: false, total: uniq.length };
    uniq[n - 1].scrollIntoView({ block: "center", inline: "nearest" });
    return { ok: true, total: uniq.length };
  }, pageNum);
  await page.waitForTimeout(1600);
  return r;
}

/** マウスホイールで下へ (手動 次へ) */
async function pageDown(page) {
  const d = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.move(Math.floor(d.w * 0.6), Math.floor(d.h * 0.5));
  await page.waitForTimeout(80);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(700);
}

/** マウスホイールで上へ (手動 前へ) */
async function pageUp(page) {
  const d = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.move(Math.floor(d.w * 0.6), Math.floor(d.h * 0.5));
  await page.waitForTimeout(80);
  await page.mouse.wheel(0, -700);
  await page.waitForTimeout(700);
}

/** 先頭ページへ */
async function pageTop(page) {
  await gotoPageByScroll(page, 1);
}

/** 指定ページへ (scrollIntoView 方式) */
async function gotoPage(page, targetPage) {
  return await gotoPageByScroll(page, targetPage);
}

/**
 * 目的ページがロックされていれば解除する。
 *  Why: ロックされたページは編集モードに入れず「ページがロックされています」で書込み全失敗する
 *       (2026-05-30 ページ37で観測)。 ロック中は「ページをロック解除する」ボタンが存在するので
 *       画面内に見えている(=中央付近の目的ページの) 解除ボタンをクリックする。
 *  前提: 事前に gotoPageByScroll で目的ページを中央に表示しておくこと。
 */
async function unlockPageIfLocked(page) {
  const found = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button[aria-label]"))
      .filter((b) => /ロック解除|ロックを解除|unlock/i.test(b.getAttribute("aria-label") || ""));
    let best = null;
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.y > 0 && r.y < window.innerHeight) {
        if (!best || r.y < best.rawY) best = { x: r.x + r.width / 2, y: r.y + r.height / 2, rawY: r.y, label: b.getAttribute("aria-label") };
      }
    }
    return best;
  });
  if (!found) return { locked: false };
  await page.mouse.click(found.x, found.y);
  await page.waitForTimeout(700);
  return { locked: true, unlocked: true };
}

/** ページ N の矩形内にある「段落テキスト」placeholder を取得 (ズーム非依存・隣ページ混入なし) */
async function detectPlaceholdersInPage(page, pageNum) {
  return await page.evaluate((n) => {
    let pages = Array.from(document.querySelectorAll("[data-page-id]"));
    if (pages.length < 2) {
      pages = Array.from(document.querySelectorAll("div")).filter((el) => {
        const h = el.getBoundingClientRect().height;
        return h > 460 && h < 580;
      });
    }
    pages.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const uniq = [];
    let lastY = -1e9;
    for (const el of pages) {
      const y = el.getBoundingClientRect().top;
      if (Math.abs(y - lastY) > 100) { uniq.push(el); lastY = y; }
    }
    const target = uniq[n - 1];
    if (!target) return [];
    const pr = target.getBoundingClientRect();
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length !== 0) continue;
      if ((el.textContent || "").trim() !== "段落テキスト") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) {
        out.push({ x: cx, y: cy, w: r.width, h: r.height, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
      }
    }
    return out;
  }, pageNum);
}

/**
 * focus を強制的にリセット。 ページタイトル INPUT 等から focus を外す。
 */
async function resetFocus(page) {
  await page.evaluate(() => {
    try {
      const ae = document.activeElement;
      if (ae && ae.blur) ae.blur();
      if (document.body && document.body.focus) document.body.focus();
    } catch {}
  });
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(120);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
}

// ============================================================
// placeholder 再検出 + cells 再構築
// ============================================================

/** 現在画面内の「段落テキスト」 placeholder を全取得 */
async function detectLivePlaceholders(page) {
  return await page.evaluate((needle) => {
    const all = document.querySelectorAll("*");
    const out = [];
    const vh = window.innerHeight, vw = window.innerWidth;
    for (const el of all) {
      const text = (el.textContent || "").trim();
      if (text === needle && el.children.length === 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
          if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) {
            out.push({
              x: cx, y: cy, w: r.width, h: r.height,
              left: r.x, top: r.y,
              right: r.x + r.width, bottom: r.y + r.height,
            });
          }
        }
      }
    }
    return out;
  }, PLACEHOLDER_TEXT);
}

/** 42個の placeholder を Y→X ソートして 6×7 cells に組み立てる */
function buildCellsFromPlaceholders(currentPhs) {
  const sortedPhs = [...currentPhs].sort((a, b) => {
    if (Math.abs(a.y - b.y) < 30) return a.x - b.x;
    return a.y - b.y;
  });
  const freshCells = [];
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      const ph = sortedPhs[r * 7 + c];
      row.push({ r, c, ...ph });
    }
    freshCells.push(row);
  }
  const allX = currentPhs.map((p) => p.x), allY = currentPhs.map((p) => p.y);
  const bbox = {
    minX: Math.min(...allX), maxX: Math.max(...allX),
    minY: Math.min(...allY), maxY: Math.max(...allY),
  };
  bbox.w = bbox.maxX - bbox.minX;
  bbox.h = bbox.maxY - bbox.minY;
  return { cells: freshCells, bbox };
}

/**
 * 現在ページの live placeholder を再検出 → 42個チェック → cells 再構築 → dayCellMap.cellTop 更新。
 * @returns {{ count, cells, bbox }}
 * @throws 検出数 ≠ 42 のとき
 */
// 1次元の値を k 個のクラスタ中心に分割 (最大 k-1 個のギャップで分割してグループ平均)
function clusterCenters(values, k) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length <= k) return sorted.slice();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push({ gap: sorted[i] - sorted[i - 1], i });
  gaps.sort((a, b) => b.gap - a.gap);
  const splits = gaps.slice(0, k - 1).map((g) => g.i).sort((a, b) => a - b);
  const centers = [];
  let start = 0;
  for (const s of [...splits, sorted.length]) {
    const grp = sorted.slice(start, s);
    centers.push(grp.reduce((a, b) => a + b, 0) / grp.length);
    start = s;
  }
  return centers;
}

function nearestIdx(centers, v) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < centers.length; i++) { const d = Math.abs(centers[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}

/**
 * placeholder 群から 6行×7列グリッドを「幾何学的に」再構築。
 *  Why: 一部セルが記入済/空ボックス化して placeholder が 42未満でも、 残りから列X・行Yを推定し
 *       欠損セルの中心座標を補完できる → 再実行可能 (2026-05-30 ページ37の1セル記入済状態で必要)。
 */
function buildCellsGeometric(phs) {
  const rowY = clusterCenters(phs.map((p) => p.y), 6);
  const colX = clusterCenters(phs.map((p) => p.x), 7);
  const cells = [];
  for (let r = 0; r < 6; r++) { cells.push([]); for (let c = 0; c < 7; c++) cells[r].push(null); }
  for (const p of phs) {
    const r = nearestIdx(rowY, p.y), c = nearestIdx(colX, p.x);
    if (!cells[r][c]) cells[r][c] = { ...p, r, c };
  }
  let synthetic = 0;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    if (!cells[r][c]) {
      cells[r][c] = { x: colX[c], y: rowY[r], w: 0, h: 0, left: colX[c], top: rowY[r], r, c, synthetic: true };
      synthetic++;
    }
  }
  const allX = phs.map((p) => p.x), allY = phs.map((p) => p.y);
  const bbox = { w: Math.max(...allX) - Math.min(...allX), h: Math.max(...allY) - Math.min(...allY) };
  return { cells, bbox, synthetic };
}

async function rebuildCellsAndAssign(page, dayCellMap, pageNum = null) {
  if (pageNum) {
    // ページ矩形スコープ + 幾何再構築 (記入済/空セルがあっても 6×7 を復元、 再実行可能)
    const phs = await detectPlaceholdersInPage(page, pageNum);
    if (phs.length < 30) {
      const err = new Error(`placeholder 検出数 ${phs.length}個 (少なすぎ・グリッド再構築不可)`);
      err.count = phs.length;
      throw err;
    }
    const { cells, bbox, synthetic } = buildCellsGeometric(phs);
    for (const item of dayCellMap) item.cellTop = cells[item.r][item.c];
    return { count: phs.length, cells, bbox, synthetic };
  }
  // CLI (viewport) 従来方式: 厳密42
  const currentPhs = await detectLivePlaceholders(page);
  if (currentPhs.length !== 42) {
    const err = new Error(`placeholder 検出数 ${currentPhs.length} ≠ 42`);
    err.count = currentPhs.length;
    throw err;
  }
  const { cells, bbox } = buildCellsFromPlaceholders(currentPhs);
  for (const item of dayCellMap) item.cellTop = cells[item.r][item.c];
  return { count: currentPhs.length, cells, bbox };
}

// ============================================================
// 編集モード突入
// ============================================================

async function isInTextEditMode(page) {
  try {
    return await page.evaluate(() => {
      const ae = document.activeElement;
      if (ae) {
        const aria = (ae.getAttribute("aria-label") || "") + " " + (ae.getAttribute("data-testid") || "");
        if (/線のテキストエディター|Line text|LineText|line-text/i.test(aria)) return false;
      }
      const inputs = Array.from(document.querySelectorAll('input[aria-label*="フォントサイズ"], input[aria-label*="文字サイズ"], input[aria-label*="Font size" i]'));
      const hasFontInput = inputs.some((el) => el.offsetParent !== null);
      if (!hasFontInput) return false;
      if (ae && ae.getAttribute && (ae.getAttribute("contenteditable") === "true" || ae.getAttribute("role") === "textbox")) {
        const aria = ae.getAttribute("aria-label") || "";
        if (/線のテキストエディター|Line text|LineText|line-text/i.test(aria)) return false;
        return true;
      }
      return false;
    });
  } catch { return false; }
}

async function describeActiveEditor(page) {
  try {
    return await page.evaluate(() => {
      const ae = document.activeElement;
      if (!ae) return "(no activeElement)";
      const tag = ae.tagName;
      const aria = ae.getAttribute("aria-label") || "";
      const role = ae.getAttribute("role") || "";
      const ce = ae.getAttribute("contenteditable") || "";
      const isLine = /線のテキストエディター|Line text/i.test(aria);
      const isParagraph = /段落テキストエディター|Paragraph text/i.test(aria);
      const type = isLine ? "❌LINE" : (isParagraph ? "✅PARA" : "?UNK");
      return `${type} tag=${tag} aria="${aria}" role="${role}" ce="${ce}"`;
    });
  } catch { return "(error)"; }
}

async function enterEditMode(page, cellTop, debug = false, logFn = console.log) {
  await resetFocus(page);

  const clickResult = await page.evaluate(({ tx, ty, maxDist }) => {
    const all = document.querySelectorAll("*");
    let target = null;
    let minDist = Infinity;
    for (const el of all) {
      if (el.children.length !== 0) continue;
      const txt = (el.textContent || "").trim();
      if (txt !== "段落テキスト") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const dist = Math.hypot(cx - tx, cy - ty);
      if (dist < minDist) {
        minDist = dist;
        target = el;
      }
    }
    if (!target || minDist > maxDist) {
      return { ok: false, dist: minDist, error: target ? `dist ${minDist} > ${maxDist}` : "no placeholder" };
    }
    const r = target.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const makeEvent = (type) => new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, button: 0, buttons: 1,
    });
    target.dispatchEvent(makeEvent("pointerdown"));
    target.dispatchEvent(makeEvent("mousedown"));
    target.dispatchEvent(makeEvent("pointerup"));
    target.dispatchEvent(makeEvent("mouseup"));
    target.dispatchEvent(makeEvent("click"));
    return { ok: true, dist: minDist, tag: target.tagName, bbox: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }, { tx: cellTop.x, ty: cellTop.y, maxDist: 50 });

  if (debug) logFn(`        [debug] JS click dispatch: ${JSON.stringify(clickResult)}`);

  if (!clickResult.ok) {
    // 段落テキストが無い (記入済/空ボックスのセル) → 座標クリックで選択して上書き編集
    if (debug) logFn(`        [debug] 段落テキスト無し → 座標クリック (${Math.round(cellTop.x)},${Math.round(cellTop.y)})`);
    try {
      await page.mouse.move(cellTop.x, cellTop.y, { steps: 3 });
      await page.waitForTimeout(60);
      await page.mouse.click(cellTop.x, cellTop.y, { delay: 30 });
    } catch {}
  }

  await page.waitForTimeout(400);
  if (debug) logFn(`        [debug] after JS click: ${await describeActiveEditor(page)}`);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  if (debug) logFn(`        [debug] after Enter: ${await describeActiveEditor(page)}`);

  let entered = false;
  for (let w = 0; w < 5; w++) {
    await page.waitForTimeout(200);
    if (await isInTextEditMode(page)) { entered = true; break; }
  }
  if (entered) return { ok: true, label: "JS_dispatch" };

  if (debug) logFn(`        [debug] JS click 失敗 → mouse click fallback`);
  await resetFocus(page);
  try {
    await page.mouse.move(cellTop.x, cellTop.y, { steps: 3 });
    await page.waitForTimeout(60);
    await page.mouse.click(cellTop.x, cellTop.y, { delay: 30 });
  } catch {}
  await page.waitForTimeout(350);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  for (let w = 0; w < 5; w++) {
    await page.waitForTimeout(200);
    if (await isInTextEditMode(page)) {
      if (debug) logFn(`        [debug] mouse fallback success: ${await describeActiveEditor(page)}`);
      return { ok: true, label: "mouse_fallback" };
    }
  }
  return { ok: false, reason: "JS dispatch + mouse fallback 両方失敗" };
}

// ============================================================
// フォント / 折返し / 1セル書込み
// ============================================================

async function trySetFontSize(page, size) {
  const selectors = [
    'input[aria-label*="フォントサイズ"]',
    'input[aria-label*="文字サイズ"]',
    'input[aria-label*="Font size" i]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count())) continue;
    try {
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;
      await loc.click({ clickCount: 3, timeout: 1500 });
      await page.waitForTimeout(80);
      await page.keyboard.type(String(size), { delay: 30 });
      await page.waitForTimeout(80);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      return { ok: true, selector: sel };
    } catch {}
  }
  return { ok: false };
}

/**
 * 1行を cell 幅に収まる長さで segments に分割。 maxUnits=7 (全角7文字相当)。
 */
function wrapLineForCell(line, maxUnits = 7) {
  const isHalfWidth = (c) => /[\x00-\x7F｡-ￜ￨-￮]/.test(c);
  const segments = [];
  let current = "";
  let width = 0;
  for (const ch of String(line)) {
    const w = isHalfWidth(ch) ? 0.5 : 1;
    if (width + w > maxUnits && current.length > 0) {
      segments.push(current);
      current = ch;
      width = w;
    } else {
      current += ch;
      width += w;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * 1セルに書込み。 lines[0]=日付 (例: "1"), lines[1..]=本文
 * 本文 6pt / 日付 19pt。
 */
async function writeOneCell(page, cellTop, day, debug = false, logFn = console.log) {
  const enter = await enterEditMode(page, cellTop, debug, logFn);
  if (!enter.ok) {
    return { ok: false, reason: "編集モード突入失敗 (段落テキストエディターに入れなかった)" };
  }
  if (debug) logFn(`        [debug] ✓ enter SUCCESS at label=${enter.label}`);

  // ② 全選択 → 直接 type で上書き (Delete は使わない)
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(200);

  for (let i = 0; i < day.lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(60);
    }
    const segments = i === 0 ? [day.lines[i]] : wrapLineForCell(day.lines[i]);
    for (let s = 0; s < segments.length; s++) {
      if (s > 0) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(40);
      }
      await page.keyboard.type(segments[s], { delay: 25 });
    }
  }
  await page.waitForTimeout(300);

  // ③ 全選択 → 6pt (本文)
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(150);
  await trySetFontSize(page, 6);
  await page.waitForTimeout(300);

  // ④ 日付行を 19pt
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(120);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(120);
  const dateStr = String(day.date);
  for (let k = 0; k < dateStr.length; k++) {
    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(150);
  await trySetFontSize(page, 19);
  await page.waitForTimeout(300);

  // ⑤ Escape×2
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  return { ok: true, label: enter.label };
}

/** 書込み後、 cell 周辺に「期待日付」 が含まれる leaf があるか確認 */
async function verifyDate(page, cellTop, expectedDate, hasMultiple) {
  return await page.evaluate(({ tx, ty, expected, halfW, yRange, yUpper }) => {
    const all = document.querySelectorAll("*");
    const candidates = [];
    for (const el of all) {
      if (el.children.length !== 0) continue;
      const txt = (el.textContent || "").trim();
      if (!txt || txt === "段落テキスト") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const dx = cx - tx;
      const dy = cy - ty;
      if (Math.abs(dx) > halfW) continue;
      if (dy < -yUpper || dy > yRange) continue;
      candidates.push({ txt: txt.slice(0, 30), dist: Math.sqrt(dx * dx + dy * dy) });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    for (let i = 0; i < Math.min(10, candidates.length); i++) {
      const m = candidates[i].txt.match(/^(\d+)/);
      if (m && m[1] === expected) return { ok: true, found: candidates[i].txt };
    }
    return { ok: false, found: candidates.length > 0 ? candidates[0].txt : "(no text)" };
  }, {
    tx: cellTop.x, ty: cellTop.y, expected: String(expectedDate),
    halfW: 22, yRange: hasMultiple ? 130 : 80, yUpper: 10,
  });
}

// ============================================================
// 月タイトル (「2026.6」「June」) の書換え
// ============================================================

/**
 * cells (実座標) から、 タイトルが存在する帯を算出する。
 * グリッド上端より上・同じ X 範囲、 という枠で絞ることで
 * 隣ページや曜日ヘッダーの混入を防ぐ (罠7 対策: 円形距離を使わない)。
 */
function buildTitleBand(cells, marginAbove = 220) {
  const flat = cells.flat().filter(Boolean);
  if (flat.length === 0) throw new Error("cells が空のため タイトル帯を算出できません");
  const tops = flat.map((c) => c.top ?? c.y);
  const lefts = flat.map((c) => c.left ?? c.x);
  const rights = flat.map((c) => c.right ?? c.x);
  const gridTop = Math.min(...tops);
  return {
    top: gridTop - marginAbove,
    bottom: gridTop - 4,
    left: Math.min(...lefts) - 60,
    right: Math.max(...rights) + 60,
  };
}

/** タイトル帯の中にある短いテキスト leaf を全部拾う */
async function detectTitleCandidates(page, band) {
  return await page.evaluate((b) => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length !== 0) continue;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 24) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < b.left || cx > b.right) continue;
      if (cy < b.top || cy > b.bottom) continue;
      out.push({
        text, x: cx, y: cy, w: r.width, h: r.height,
        left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height,
      });
    }
    return out;
  }, band);
}

/** 指定テキスト・指定座標の leaf にマウスイベントを直接 dispatch (罠2 回避) */
async function clickTitleElement(page, target, tolerance = 12) {
  return await page.evaluate(({ text, tx, ty, tol }) => {
    let hit = null;
    let best = Infinity;
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length !== 0) continue;
      if ((el.textContent || "").trim() !== text) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (Math.abs(cx - tx) > tol || Math.abs(cy - ty) > tol) continue;
      const d = Math.abs(cx - tx) + Math.abs(cy - ty);
      if (d < best) { best = d; hit = el; }
    }
    if (!hit) return { ok: false, error: "対象要素が見つかりません" };
    const r = hit.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const ev = (type) => new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, button: 0, buttons: 1,
    });
    hit.dispatchEvent(ev("pointerdown"));
    hit.dispatchEvent(ev("mousedown"));
    hit.dispatchEvent(ev("pointerup"));
    hit.dispatchEvent(ev("mouseup"));
    hit.dispatchEvent(ev("click"));
    return { ok: true, x: cx, y: cy };
  }, { text: target.text, tx: target.x, ty: target.y, tol: tolerance });
}

/**
 * 月タイトルを指定年月に書き換える。
 * 日付セル書込みの「前」に呼ぶこと (罠6: font input の状態を引きずらないため)。
 *
 * @param {object} opts { year, month, cells, onEvent, debug }
 * @returns {{ ok, updated, alreadyOk, failed, candidates }}
 */
async function writeMonthTitle(page, opts = {}) {
  const { year, month, cells, onEvent = () => {}, debug = false } = opts;
  const band = buildTitleBand(cells);
  if (debug) {
    onEvent({
      type: "log",
      message: `        [debug] タイトル帯: x(${band.left.toFixed(0)}〜${band.right.toFixed(0)}) y(${band.top.toFixed(0)}〜${band.bottom.toFixed(0)})`,
    });
  }

  const raw = await detectTitleCandidates(page, band);
  const candidates = monthTitle.dedupeByPosition(raw);
  const { updates, alreadyOk } = monthTitle.planTitleUpdates(candidates, year, month);

  onEvent({
    type: "titleScan",
    candidates: candidates.length,
    updates: updates.length,
    alreadyOk: alreadyOk.length,
    texts: candidates.map((c) => c.text),
  });

  const updated = [];
  const failed = [];

  for (const target of updates) {
    onEvent({ type: "titleStart", before: target.text, after: target.next });

    await resetFocus(page);
    const clicked = await clickTitleElement(page, target);
    if (!clicked.ok) {
      failed.push({ ...target, reason: clicked.error });
      onEvent({ type: "titleFail", before: target.text, reason: clicked.error });
      continue;
    }

    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    let entered = false;
    for (let w = 0; w < 5; w++) {
      await page.waitForTimeout(200);
      if (await isInTextEditMode(page)) { entered = true; break; }
    }
    if (!entered) {
      failed.push({ ...target, reason: "編集モードに入れませんでした" });
      onEvent({ type: "titleFail", before: target.text, reason: "編集モードに入れませんでした" });
      await resetFocus(page);
      continue;
    }

    // 全選択 → 上書き。 フォントサイズは触らない (元の書式を保つ)
    await page.keyboard.press(`${MOD}+A`);
    await page.waitForTimeout(200);
    await page.keyboard.type(target.next, { delay: 35 });
    await page.waitForTimeout(300);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
    });
    await page.waitForTimeout(150);

    // 検証: 帯の中に新しいテキストが現れたか
    const after = await detectTitleCandidates(page, band);
    const hit = after.find((c) => c.text === target.next);
    if (hit) {
      updated.push({ before: target.text, after: target.next });
      onEvent({ type: "titleSuccess", before: target.text, after: target.next });
    } else {
      failed.push({ ...target, reason: `書込み後に "${target.next}" を確認できません` });
      onEvent({ type: "titleFail", before: target.text, reason: "書込み後の検証に失敗" });
    }
  }

  for (const a of alreadyOk) {
    onEvent({ type: "titleSkip", text: a.text });
  }

  return {
    ok: failed.length === 0,
    updated,
    alreadyOk: alreadyOk.map((a) => a.text),
    failed,
    candidates: candidates.length,
  };
}

// ============================================================
// 書込みループ
// ============================================================

/**
 * targetMap 全日を順に書込む。
 * @param {object} opts
 * @param {boolean} opts.debug
 * @param {(ev:object)=>void} opts.onEvent 進捗イベントコールバック
 * @returns 結果配列 [{ day, ok, label, found }]
 */
async function writeAllDays(page, targetMap, opts = {}) {
  const { debug = false, onEvent = () => {} } = opts;
  const logFn = (msg) => onEvent({ type: "log", message: msg });
  const results = [];
  for (let i = 0; i < targetMap.length; i++) {
    const { day, r, c, cellTop } = targetMap[i];
    onEvent({
      type: "dayStart", index: i, total: targetMap.length,
      date: day.date, weekday: day.weekday, r, c,
      hasMultiple: !!day.hasMultiple, entryCount: day.entryCount || 1,
    });

    let result = await writeOneCell(page, cellTop, day, debug, logFn);
    if (!result.ok) {
      onEvent({ type: "retry", date: day.date, reason: result.reason });
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      result = await writeOneCell(page, cellTop, day, debug, logFn);
    }

    let verifyResult = { ok: false };
    if (result.ok) {
      verifyResult = await verifyDate(page, cellTop, day.date, day.hasMultiple);
      if (verifyResult.ok) {
        onEvent({ type: "daySuccess", date: day.date, found: verifyResult.found });
      } else {
        onEvent({ type: "dayVerifyFail", date: day.date, found: verifyResult.found });
      }
    } else {
      onEvent({ type: "dayFail", date: day.date, reason: result.reason });
    }
    results.push({ day, ok: result.ok && verifyResult.ok, label: result.label, found: verifyResult.found });

    // セル間 Escape + blur
    try {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      await page.evaluate(() => {
        try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
      });
      await page.waitForTimeout(60);
    } catch {}
  }
  return results;
}

module.exports = {
  PLACEHOLDER_TEXT,
  WEEKDAY_TO_COL,
  WEEKDAYS,
  fillMissingDays,
  fetchMonthData,
  loadCoord,
  loadCoordWithFallback,
  describeCoordSource,
  dayToCellRC,
  assignDays,
  navigateToPage,
  gotoPage,
  gotoPageByScroll,
  unlockPageIfLocked,
  pageDown,
  pageUp,
  pageTop,
  resetFocus,
  detectLivePlaceholders,
  detectPlaceholdersInPage,
  buildCellsFromPlaceholders,
  rebuildCellsAndAssign,
  isInTextEditMode,
  describeActiveEditor,
  enterEditMode,
  trySetFontSize,
  wrapLineForCell,
  writeOneCell,
  verifyDate,
  writeAllDays,
  buildTitleBand,
  detectTitleCandidates,
  clickTitleElement,
  writeMonthTitle,
};
