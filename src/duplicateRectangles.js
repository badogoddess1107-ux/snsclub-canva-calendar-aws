/**
 * P33 矩形量産スクリプト (ハイブリッド方式)
 *
 * 目的:
 *  ユーザが手動で cell(0,0) に1個 cream色矩形を配置 → スクリプトが残り41個を
 *  Cmd+D + ドラッグで全セルに量産する。
 *
 * 前提:
 *  ・P33 が画面いっぱいに表示されている
 *  ・cell(0,0) の中心付近に source 矩形が1個配置済 (top z-order)
 *  ・矩形のサイズは cell サイズに近い (50〜250px)
 *  ・矩形の塗りつぶしは "none" / transparent ではない
 *
 * 完了後:
 *  ・全42セルに cream色矩形が配置される (top z-order, テキストを覆う状態)
 *  ・ユーザが手動でz-orderを調整するか、color script を即座に実行できる
 */
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");

chromium.use(stealth);

const PLACEHOLDER_TEXT = "段落テキスト";

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

/**
 * 段落テキスト要素 126個 を検出 (runScheduled.js と同等)
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
  found.sort((a, b) => {
    if (Math.abs(a.y - b.y) < 20) return a.x - b.x;
    return a.y - b.y;
  });
  return found;
}

function groupIntoCells(placeholders) {
  if (placeholders.length !== 126) {
    throw new Error(`プレースホルダー数が${placeholders.length}個 (期待:126個)`);
  }
  const sorted = [...placeholders].sort((a, b) => a.y - b.y);
  const visualRows = [];
  for (let i = 0; i < 18; i++) {
    const row = sorted.slice(i * 7, (i + 1) * 7);
    row.sort((a, b) => a.x - b.x);
    visualRows.push(row);
  }
  const cells = [];
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      row.push({
        top: visualRows[r * 3 + 0][c],
        middle: visualRows[r * 3 + 1][c],
        bottom: visualRows[r * 3 + 2][c],
      });
    }
    cells.push(row);
  }
  return cells;
}

/**
 * 塗りつぶし指定の矩形を全件取得 (cellサイズらしい範囲のみ)
 *  検出対象:
 *    - SVG: rect / path / polygon / ellipse / circle (fill属性 or computed style fill)
 *    - HTML: div (computed style background-color)
 *  ホワイト/ブラック等の典型背景色は除外
 */
async function findAllFilledRects(page, opts = {}) {
  const includeAll = !!opts.includeAll; // サイズ・色フィルタを緩めるか
  return await page.evaluate(({ includeAll }) => {
    const out = [];
    const minDim = includeAll ? 20 : 30;
    const maxDim = includeAll ? 400 : 250;

    const isMeaningfulFill = (s) => {
      if (!s) return false;
      const t = s.trim().toLowerCase();
      if (!t) return false;
      if (t === 'none' || t === 'transparent' || t === 'currentcolor') return false;
      if (t.startsWith('rgba(0, 0, 0, 0)') || t.startsWith('rgba(0,0,0,0)')) return false;
      if (t.startsWith('url(')) return false; // SVGグラデーション/パターン参照は対象外
      // 真っ白・真っ黒もスキップ (矩形ではないと仮定)
      if (t === '#fff' || t === '#ffffff' || t === 'white' || t === 'rgb(255, 255, 255)') return false;
      if (t === '#000' || t === '#000000' || t === 'black' || t === 'rgb(0, 0, 0)') return false;
      return true;
    };

    // SVG shapes
    document.querySelectorAll('rect, path, polygon, ellipse, circle').forEach((el) => {
      let fill = (el.getAttribute('fill') || '').trim();
      if (!fill || fill === 'currentColor') {
        try {
          fill = window.getComputedStyle(el).fill || '';
        } catch {}
      }
      if (!isMeaningfulFill(fill)) return;
      const bb = el.getBoundingClientRect();
      if (bb.width < minDim || bb.height < minDim) return;
      if (bb.width > maxDim || bb.height > maxDim) return;
      out.push({
        tag: el.tagName,
        fill,
        x: bb.x + bb.width / 2,
        y: bb.y + bb.height / 2,
        w: bb.width,
        h: bb.height,
        source: 'svg-fill',
      });
    });

    // HTML divs with background-color
    document.querySelectorAll('div').forEach((el) => {
      let bg = '';
      try { bg = window.getComputedStyle(el).backgroundColor || ''; } catch {}
      if (!isMeaningfulFill(bg)) return;
      const bb = el.getBoundingClientRect();
      if (bb.width < minDim || bb.height < minDim) return;
      if (bb.width > maxDim || bb.height > maxDim) return;
      out.push({
        tag: 'DIV',
        fill: bg,
        x: bb.x + bb.width / 2,
        y: bb.y + bb.height / 2,
        w: bb.width,
        h: bb.height,
        source: 'div-bg',
      });
    });

    return out;
  }, { includeAll });
}

/**
 * 期待位置近くの cell-sized 矩形を探す
 */
async function findShapeNear(page, ex, ey, tolerance = 80) {
  const all = await findAllFilledRects(page);
  const candidates = all
    .map((r) => ({ ...r, dist: Math.hypot(r.x - ex, r.y - ey) }))
    .filter((r) => r.dist <= tolerance)
    .sort((a, b) => a.dist - b.dist);
  return candidates;
}

/**
 * 既存の矩形に対して "新しく追加された" 矩形を識別する
 *  - source位置から 5〜80px の距離 (Cmd+Dの典型オフセット範囲)
 *  - 既知の placedTargets のいずれにも近接していない
 */
async function findNewDuplicate(page, sourceX, sourceY, placedTargets) {
  const all = await findAllFilledRects(page);
  let best = null;
  let bestDist = Infinity;
  for (const r of all) {
    const d = Math.hypot(r.x - sourceX, r.y - sourceY);
    if (d < 3) continue; // ソースそのもの
    if (d > 80) continue; // 遠すぎ (既存配置済みの可能性)
    // 既配置ターゲットに近すぎないか
    let nearPlaced = false;
    for (const t of placedTargets) {
      if (Math.hypot(r.x - t.x, r.y - t.y) < 30) { nearPlaced = true; break; }
    }
    if (nearPlaced) continue;
    if (d < bestDist) { best = r; bestDist = d; }
  }
  return best;
}

/**
 * シェイプドラッグ: from → to へ滑らかに移動
 */
async function dragShape(page, fromX, fromY, toX, toY) {
  await page.mouse.move(fromX, fromY);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(toX, toY, { steps: 20 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function main() {
  console.log("📋 P33 矩形量産スクリプト (ハイブリッド方式)");
  console.log("");
  console.log("⚙️ 事前準備 (Canvaで手動):");
  console.log("   1. デザインを開く → P33 を画面いっぱいに表示");
  console.log("   2. 「素材」→「四角形」→ シンプルな四角形を1個追加");
  console.log("   3. cell(0,0) = 一番左上のセル (日曜・1行目) に配置");
  console.log("   4. cell サイズに合わせてリサイズ (高さ・幅とも cell 全体を覆う)");
  console.log("   5. 塗りつぶしを cream 色 (#FFE9C8 推奨) に設定");
  console.log("   ⚠️ 最背面に送らないでください (top z-order のまま)");
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

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(config.canva.designUrl, { waitUntil: "domcontentloaded" });
  console.log("⏳ Canva初期描画待機...");
  await page.waitForTimeout(8000);

  console.log("👀 P33 を画面いっぱいに表示し、cell(0,0)に矩形を1個配置してから Enter");
  await waitForEnter("✅ 準備できたら Enter ");
  console.log("");

  // 段落テキスト検出 (42=legacy / 126=new 両対応)
  console.log("🔍 プレースホルダー検出中...");
  const placeholders = await findPlaceholders(page);
  let cellAnchors = []; // 各セルの代表 placeholder (legacy=唯一/new=top) を 42個

  if (placeholders.length === 126) {
    const cells = groupIntoCells(placeholders);
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 7; c++) {
        cellAnchors.push({ row: r, col: c, x: cells[r][c].top.x, y: cells[r][c].top.y });
      }
    }
    console.log(`   ✓ 新テンプレ判定 (126個 / 1マス3プレースホルダー)`);
  } else if (placeholders.length === 42) {
    // row-major ソート
    const sorted = [...placeholders].sort((a, b) => {
      if (Math.abs(a.y - b.y) < 30) return a.x - b.x;
      return a.y - b.y;
    });
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 7; c++) {
        const ph = sorted[r * 7 + c];
        cellAnchors.push({ row: r, col: c, x: ph.x, y: ph.y });
      }
    }
    console.log(`   ✓ 旧テンプレ判定 (42個 / 1マス1プレースホルダー)`);
  } else {
    console.error(`❌ ${placeholders.length}個 検出 (期待: 42 or 126)`);
    console.error("   P33 が画面いっぱいに表示されているか、placeholderが「段落テキスト」のまま (未編集) か確認");
    await context.close();
    process.exit(1);
  }

  // source 矩形を cell(0,0) placeholder anchor 付近で探索
  // ★fix: tolerance を 250→80 に厳格化。 250だと別ページ (P31/P32) の既存色付き矩形
  //       (Y=1 = 画面上端 等) を source として誤検出する事故が発生した (2026-06実行で確認)。
  //       cell(0,0) の本来のセル中心は anchor から ±50px 圏内のはずなので 80px で十分。
  const anchor00 = cellAnchors[0];
  console.log(`   cell(0,0) placeholder anchor: (${Math.round(anchor00.x)},${Math.round(anchor00.y)})`);
  const found = await findShapeNear(page, anchor00.x, anchor00.y, 80);
  if (found.length === 0) {
    console.error(`❌ cell(0,0) 付近に塗りつぶし済み矩形が見つかりません`);
    console.error("   矩形の位置・サイズ・塗りつぶし設定を確認してください");

    // 通常フィルタの全件
    const allNormal = await findAllFilledRects(page);
    console.error(`   📋 通常フィルタ (size 50-250): 全${allNormal.length}件`);
    allNormal.slice(0, 20).forEach((r) =>
      console.error(`     - <${r.tag} fill=${r.fill} src=${r.source}> ${Math.round(r.w)}×${Math.round(r.h)} @(${Math.round(r.x)},${Math.round(r.y)})`)
    );

    // 緩めフィルタ (size 20-400) で再検索
    const allWide = await findAllFilledRects(page, { includeAll: true });
    console.error(`   📋 緩いフィルタ (size 20-400): 全${allWide.length}件 (cell(0,0)近傍順):`);
    const sorted = allWide
      .map((r) => ({ ...r, dist: Math.hypot(r.x - anchor00.x, r.y - anchor00.y) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 30);
    sorted.forEach((r) =>
      console.error(`     - <${r.tag} fill=${r.fill} src=${r.source}> ${Math.round(r.w)}×${Math.round(r.h)} @(${Math.round(r.x)},${Math.round(r.y)}) dist=${Math.round(r.dist)}`)
    );

    await context.close();
    process.exit(1);
  }
  const src = found[0];
  console.log(`   ✓ source 矩形検出: <${src.tag} fill=${src.fill}> ${Math.round(src.w)}×${Math.round(src.h)} @(${Math.round(src.x)},${Math.round(src.y)})`);

  // ★fix: 妥当性チェック — source が anchor から大幅に離れていたら別ページ矩形を誤検出した可能性
  //   オフセットが ±60px を超えたら停止。 cell(0,0) の placeholder と セル中心の差は通常 ±30px 程度。
  const dx0 = Math.abs(src.x - anchor00.x);
  const dy0 = Math.abs(src.y - anchor00.y);
  if (dx0 > 60 || dy0 > 60) {
    console.error("");
    console.error(`❌ source 矩形が cell(0,0) から大幅に離れています (dx=${Math.round(dx0)}, dy=${Math.round(dy0)}px)`);
    console.error(`   anchor(0,0): (${Math.round(anchor00.x)}, ${Math.round(anchor00.y)})`);
    console.error(`   source     : (${Math.round(src.x)}, ${Math.round(src.y)})`);
    console.error("");
    console.error("   原因の可能性:");
    console.error("   1. P33 (6月) の cell(0,0) に矩形を配置していない");
    console.error("   2. 別ページ (P31, P32等) の既存色付き矩形を誤検出した");
    console.error("   3. 矩形は配置したが、 サイズ・位置が cell(0,0) と全く違う");
    console.error("");
    console.error("   📋 対処手順:");
    console.error("   1. Canva ブラウザで P33 (June表示) を画面いっぱいに表示");
    console.error("   2. 左サイドバー「素材」→「四角形」→ シンプル四角を1つ追加");
    console.error("   3. その矩形を SUN列最上段の空セル (cell(0,0)) にドラッグ");
    console.error("   4. セル全体を覆うようにリサイズ");
    console.error("   5. 矩形を選択した状態で「カラー」→「+」→ #FFE9C8 を入力 → Enter");
    console.error("   6. 余白クリックで選択解除 → スクリプト再実行");
    console.error("");
    await context.close();
    process.exit(1);
  }

  // 自動キャリブレーション:
  //   source center は cell(0,0) の geometric center にユーザが置いた前提。
  //   anchor (placeholder) からの offset を計算 → 全 41セルに同じ offset を適用すれば
  //   各セルの geometric center が target になる。
  const offsetX = src.x - anchor00.x;
  const offsetY = src.y - anchor00.y;
  console.log(`   キャリブレーション: anchor → source center オフセット = (${Math.round(offsetX)},${Math.round(offsetY)})`);

  const cellCenters = cellAnchors.map((a) => ({
    row: a.row, col: a.col,
    x: a.x + offsetX,
    y: a.y + offsetY,
  }));

  const source = { x: cellCenters[0].x, y: cellCenters[0].y };
  const targets = cellCenters.slice(1); // 残り41セル

  // 既配置リスト (重複検出のため source と placed を覚えておく)
  const placed = [{ x: source.x, y: source.y }];

  // ウォームアップ: source 矩形をクリックしてフォーカスを確実にキャンバスへ
  //   Why: 初回数回の Cmd+D が "no-duplicate-detected" で失敗するのは、
  //        Chromium がブラウザショートカット (Cmd+D=ブックマーク) として
  //        取り込んでしまうことが原因。最初に Cmd+D を1回 "ハズレ" で打ち、
  //        Canva 側にフォーカスが定着してから本番ループに入る。
  //   注意: ウォームアップで複製が生まれていても source と完全重畳して
  //        findNewDuplicate が見抜けないことがある (実害=cell(0,0)に余剰矩形)。
  //        そのため反応有無に関わらず必ず Cmd+Z を1回打って消す。
  console.log("");
  console.log(`🔥 ウォームアップ (Canvaにフォーカスを定着)`);
  await page.mouse.click(source.x, source.y);
  await page.waitForTimeout(800);
  await page.keyboard.press("Meta+D");
  await page.waitForTimeout(900);
  const warmDup = await findNewDuplicate(page, source.x, source.y, placed);
  if (warmDup) {
    console.log(`   ウォームアップで複製を検出 → Cmd+Z で戻します`);
  } else {
    console.log(`   ウォームアップ Cmd+D は反応無 (もしくは隠れ複製) → 念のため Cmd+Z`);
  }
  // 反応有無に関わらず Cmd+Z (隠れ複製の保険)
  await page.keyboard.press("Meta+Z");
  await page.waitForTimeout(600);

  /**
   * 1セル分の処理: source選択 → Cmd+D (リトライ含む) → ドラッグ → 検証
   *  Cmd+D が反応しないことがあるので最大3回までリトライ
   */
  async function placeOneCell(label, t) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      // 1) source を選択
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(150);
      await page.mouse.click(source.x, source.y);
      await page.waitForTimeout(450);

      // 2) Cmd+D で複製
      await page.keyboard.press("Meta+D");
      await page.waitForTimeout(700 + attempt * 200);

      // 3) 新しい複製の位置を DOM から検出
      const dup = await findNewDuplicate(page, source.x, source.y, placed);
      if (!dup) {
        if (attempt < 3) {
          console.log(`   …${label}: 複製検出失敗 (attempt ${attempt}/3) → リトライ`);
          await page.waitForTimeout(400);
          continue;
        }
        return { ok: false, reason: "no-duplicate-detected" };
      }

      // 4) 複製を target にドラッグ
      await dragShape(page, dup.x, dup.y, t.x, t.y);

      // 5) 配置成功を検証
      const verifyShapes = await findShapeNear(page, t.x, t.y, 60);
      if (verifyShapes.length === 0) {
        if (attempt < 3) {
          console.log(`   …${label}: 配置後検証NG (attempt ${attempt}/3) → リトライ`);
          // 失敗した dup を Cmd+Z で戻して再試行
          await page.keyboard.press("Meta+Z");
          await page.waitForTimeout(500);
          continue;
        }
        return { ok: false, reason: "post-drag-not-found" };
      }

      return { ok: true };
    }
    return { ok: false, reason: "max-attempts-exceeded" };
  }

  console.log("");
  console.log(`📋 41個の複製と配置を開始`);
  let successCount = 0;
  let failedTargets = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const idx = i + 2; // 1-based + source
    const label = `${idx}/42 cell(${t.row},${t.col})`;

    const r = await placeOneCell(label, t);
    if (r.ok) {
      placed.push({ x: t.x, y: t.y });
      successCount++;
      console.log(`   ✓ ${label} → (${Math.round(t.x)},${Math.round(t.y)})`);
    } else {
      console.log(`   ⚠️ ${label}: ${r.reason}`);
      failedTargets.push({ idx, t, reason: r.reason });
    }
  }

  // 失敗した分があれば最後に再試行 (フォーカス・タイミング差で復活する可能性)
  if (failedTargets.length > 0) {
    console.log("");
    console.log(`🔁 失敗 ${failedTargets.length}件 を最後に再試行`);
    const stillFailed = [];
    for (const f of failedTargets) {
      const label = `${f.idx}/42 cell(${f.t.row},${f.t.col})`;
      const r = await placeOneCell(label, f.t);
      if (r.ok) {
        placed.push({ x: f.t.x, y: f.t.y });
        successCount++;
        console.log(`   ✓ 復活 ${label} → (${Math.round(f.t.x)},${Math.round(f.t.y)})`);
      } else {
        console.log(`   ⚠️ ${label}: 再試行も失敗 (${r.reason})`);
        stillFailed.push(f);
      }
    }
    failedTargets = stillFailed;
  }

  console.log("");
  console.log(`✅ 配置完了: 成功 ${successCount}/41 件 (source含めて ${successCount + 1}/42)`);
  if (failedTargets.length > 0) {
    console.log(`⚠️ 失敗 ${failedTargets.length}件:`);
    failedTargets.forEach((f) =>
      console.log(`   - ${f.idx}/42 cell(${f.t.row},${f.t.col}) [${f.reason}]`)
    );
  }

  // 余剰矩形チェック: 1セルに2個以上 cream矩形があれば余剰を削除
  //   ウォームアップ等で生まれた "隠れ複製" を最終クリーンアップ
  console.log("");
  console.log(`🧹 余剰矩形チェック中...`);
  const allMatching = (await findAllFilledRects(page)).filter((r) => r.fill === src.fill);
  console.log(`   配置後の cream矩形 総数: ${allMatching.length} (期待: 42)`);

  if (allMatching.length > 42) {
    // 各矩形を「最も近いセル」に1つだけ割り当て (重複カウント防止)
    //   Why: 旧ロジックは for(cell)×filter(dist<50) だったので、
    //        セル間隔(~44px)より tolerance(50px) が広く、1つの矩形が
    //        複数セルに二重三重に紐づいて、余剰件数が爆増していた。
    //        修正: rect → 最寄りセル をユニークに決め、各セル内で
    //              最寄り1個を残し、それ以外を余剰とする。
    const cellBuckets = new Map(); // key = "r,c" → [{rect, dist}, ...]
    for (const r of allMatching) {
      let bestCell = null;
      let bestDist = Infinity;
      for (const cc of cellCenters) {
        const d = Math.hypot(r.x - cc.x, r.y - cc.y);
        if (d < bestDist) { bestDist = d; bestCell = cc; }
      }
      if (!bestCell) continue;
      const key = `${bestCell.row},${bestCell.col}`;
      if (!cellBuckets.has(key)) cellBuckets.set(key, { cell: bestCell, items: [] });
      cellBuckets.get(key).items.push({ rect: r, dist: bestDist });
    }

    const overflow = [];
    for (const { cell, items } of cellBuckets.values()) {
      items.sort((a, b) => a.dist - b.dist);
      // 1個目 (一番近い) は残す。2個目以降は削除対象
      for (let i = 1; i < items.length; i++) {
        overflow.push({ cell, extra: items[i].rect });
      }
    }

    if (overflow.length > 0) {
      // 安全装置: 余剰削除数が多すぎる(=判定ミス)場合は中断
      const wouldRemain = allMatching.length - overflow.length;
      if (wouldRemain < 30) {
        console.log(`   ⚠️ 削除すると残${wouldRemain}個になるため中止 (overflow=${overflow.length} 想定外)`);
        console.log(`     ※ 手動で余剰を削除するか、Cmd+Z で戻して再実行してください`);
      } else {
        console.log(`   余剰 ${overflow.length}件 を削除します:`);
        for (const o of overflow) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(150);
          await page.mouse.click(o.extra.x, o.extra.y);
          await page.waitForTimeout(400);
          await page.keyboard.press("Delete");
          await page.waitForTimeout(400);
          console.log(`     削除: cell(${o.cell.row},${o.cell.col}) の余剰 @(${Math.round(o.extra.x)},${Math.round(o.extra.y)})`);
        }

        // 削除後の総数を再確認
        const finalMatching = (await findAllFilledRects(page)).filter((r) => r.fill === src.fill);
        console.log(`   削除後の cream矩形 総数: ${finalMatching.length} (期待: 42)`);
      }
    } else {
      console.log(`   ※ 総数は多いが 1セル1個構造のため削除対象なし (位置ずれの可能性)`);
    }
  } else if (allMatching.length === 42) {
    console.log(`   ✓ 期待通り 42個。余剰なし。`);
  } else {
    console.log(`   ⚠️ ${allMatching.length}個 のみ (42個に達していない可能性)`);
  }
  console.log("");
  console.log("👀 ブラウザで配置を確認してください:");
  console.log("   ・全42セルに cream矩形が配置されているか");
  console.log("   ・配置がずれていないか (大きくずれてたら Cmd+Z で戻して再実行)");
  console.log("");
  console.log("🎨 確認OKなら、color script を実行できます:");
  console.log("   node src/runScheduled.js --target=2026-05 --page=33");
  console.log("");

  await waitForEnter("確認後 Enter で終了 ");
  await context.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ エラー:", err.message);
  console.error(err.stack);
  process.exit(1);
});
