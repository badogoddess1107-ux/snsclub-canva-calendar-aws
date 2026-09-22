// 無人スケジュール実行スクリプト
// 毎月25日9時実行を想定: 翌月分のデータをCanvaに自動書込み
// 使い方:
//   node src/runScheduled.js                              # 翌月分 (本番、 text-only)
//   node src/runScheduled.js --target=2026-06             # 指定月 (テスト用、 text-only)
//   node src/runScheduled.js --target=2026-06 --page=33   # 指定月をP33に書込み (自動でP33に遷移)
//   node src/runScheduled.js --target=2026-06 --page=33 --with-color  # 色付けも適用
//
// フラグ:
//   --target=YYYY-MM : 対象月を上書き
//   --page=N         : 書込み先 Canva ページを上書き (指定すると必ず自動遷移)
//   --with-color     : 色付けを有効化 (default は text-only)
//   --auto           : page 未指定時に計算ページへ自動遷移
//   --no-color       : 後方互換 (今は default OFF なので no-op)

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { exec } = require("node:child_process");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");
const { parseIcs } = require("./icsParser");
const { buildDay, mergeDays } = require("./buildDayData");
const { toRowCol } = require("./calendarGrid");
const {
  prepareScheduledProfile,
  clearStaleLock,
  releaseProfile,
  isProfileInUseError,
} = require("./browserProfile");
const cloud = require("./cloudSession");
const os = require("node:os");

chromium.use(stealth);

const PLACEHOLDER_TEXT = "段落テキスト";
// Mac は Meta(⌘)、 Linux(AWS コンテナ) は Control。 Linux で Meta+A は全選択にならない。
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const COLS = 7;
// 新テンプレ: 1マス3プレースホルダー (上=テキスト用, 中=色2, 下=色3) / 42マス × 3 = 126
const EXPECTED_PLACEHOLDERS_NEW = 126;
// 旧テンプレ: 1マス1プレースホルダー (5月分まで使用)
const EXPECTED_PLACEHOLDERS_LEGACY = 42;
const PLACEHOLDERS_PER_CELL_NEW = 3;

function notify(title, message, isError = false) {
  // Discord Webhook が設定されていればそちらへ (AWS では Mac の通知が届かないため)
  const webhook = process.env.DISCORD_NOTIFY_WEBHOOK_URL;
  if (webhook) {
    const content = `${isError ? "❌" : "✅"} ${title}\n${message}`.slice(0, 1900);
    fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    }).catch(() => {});
  }
  if (process.platform !== "darwin") return; // コンテナには macOS 通知が無い
  const sound = isError ? "Basso" : "Glass";
  const safe = (s) => String(s).replace(/"/g, '\\"').replace(/'/g, "");
  const cmd = `osascript -e 'display notification "${safe(message)}" with title "${safe(title)}" sound name "${sound}"'`;
  exec(cmd, () => {});
}

function getTargetMonth() {
  const arg = process.argv.find((a) => a.startsWith("--target="));
  if (arg) {
    const value = arg.slice(9);
    const m = value.match(/^(\d{4})-(\d{1,2})$/);
    if (!m) throw new Error(`--target の形式が不正: ${value} (例: --target=2026-06)`);
    return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
  }
  // 翌月
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { year: next.getFullYear(), month: next.getMonth() + 1 };
}

/**
 * 対象年月から、Canva内のページ番号を計算
 * (basePage の年月から経過月数を加算する)
 */
function calculatePageNumber(year, month) {
  const base = config.canva.basePage;
  const monthsSince = (year - base.year) * 12 + (month - base.month);
  return base.pageNumber + monthsSince;
}

/**
 * --page=N が指定されていればそのページ番号を返す (テスト用上書き)
 * 未指定ならnull
 */
function getPageOverride() {
  const arg = process.argv.find((a) => a.startsWith("--page="));
  if (!arg) return null;
  const n = parseInt(arg.slice(7), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--page の値が不正: ${arg.slice(7)} (正の整数を指定)`);
  }
  return n;
}

/**
 * 手動モード判定: デフォルトは true (常に手動でページ表示してEnter)
 * 自動ページ遷移を使いたい場合のみ --auto を渡す
 */
function isManualMode() {
  return !process.argv.includes("--auto");
}

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

/**
 * Canva編集画面で指定ページに移動
 * PageDownキーを押して順送りする方式
 */
async function navigateToPage(page, targetPage) {
  console.log(`📑 ページ${targetPage}に移動中...`);

  // キャンバス領域をクリックしてフォーカス
  // (左サイドバーや上部メニューにフォーカスがあるとPageDownが効かない)
  const viewport = await page.viewportSize();
  if (viewport) {
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
  }
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 一旦先頭へ
  await page.keyboard.press(`${MOD}+ArrowUp`);
  await page.waitForTimeout(800);

  // PageDownを (targetPage - 1) 回押す
  for (let i = 1; i < targetPage; i++) {
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(120);
  }

  // ページ描画安定待ち
  await page.waitForTimeout(2500);
}

async function fetchData(year, month) {
  const res = await fetch(config.calendar.icsUrl);
  if (!res.ok) throw new Error(`カレンダー取得失敗 HTTP ${res.status}`);
  const text = await res.text();
  const events = parseIcs(text);
  const rawDays = events
    .map((ev) => buildDay(ev, year, month))
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  // 講師名が記載されていないイベントを警告
  const missing = rawDays.filter((d) => d.instructorMissing);
  if (missing.length > 0) {
    console.log("");
    console.log(`⚠️ 講師記載なし (${missing.length}件):`);
    for (const d of missing) {
      console.log(`   - ${month}/${d.date}(${d.weekday}) ${d.summary}`);
    }
    console.log("");
  }

  const merged = mergeDays(rawDays);

  // 🎨 色マップを出力 (Canva側で参照)
  console.log("");
  console.log("🎨 色マップ (各マスの色バンド ─ 上から下の順):");
  for (const d of merged) {
    const bands = (d.colorBands || []).map((b) => {
      if (b.kind === "solid") return `${b.label}=${b.color}`;
      if (b.kind === "gradient") return `${b.label}=grad[${b.colors.join("→")}]`;
      return `${b.label}=??`;
    });
    console.log(`   ${String(d.date).padStart(2)}日(${d.weekday}): ${bands.join(" / ")}`);
  }
  console.log("");

  return merged;
}

/**
 * Canvaのフォントサイズ入力欄を探してサイズを設定 (Playwright Locator版)
 * 実際のユーザーと同じ「クリック→入力→Enter」を行うことで、
 * CanvaのReactコンポーネントがイベントを正しく拾うようにする
 *
 * 戻り値: { ok: boolean, selector?: string, reason?: string }
 */
async function trySetFontSize(page, size) {
  const selectors = [
    'input[aria-label*="フォントサイズ"]',
    'input[aria-label*="文字サイズ"]',
    'input[aria-label*="Font size" i]',
    'input[aria-label*="font_size" i]',
    'input[data-testid*="font-size" i]',
    'input[data-testid*="fontSize" i]',
    // フォントサイズらしい数字input(英数字のaria-labelが見つからない場合の保険)
    'input[type="number"][aria-label*="size" i]',
  ];

  // Why retry: フォーカス遷移途中でCanvaがUIを再描画し、フォントサイズinputが
  // 一瞬消える。即時に見つからなくても 200ms 後には現れていることが多い。
  let element = null;
  let usedSelector = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el && (await el.isVisible())) {
          element = el;
          usedSelector = sel;
          break;
        }
      } catch {}
    }
    if (element) break;
    await page.waitForTimeout(250);
  }

  if (!element) {
    return { ok: false, reason: "フォントサイズ入力欄が見つからない" };
  }

  try {
    await element.click({ clickCount: 3 }); // 既存値を全選択
    await page.waitForTimeout(150);
    await page.keyboard.type(String(size), { delay: 30 });
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    return { ok: true, selector: usedSelector };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 指定座標のDOM要素スタックをダンプ (elementsFromPoint)
 *  - 表示中の何が積まれているかを diagnose 用に取得
 *  - shape っぽい要素 (svg/rect/path/use 等) を優先表示
 */
async function dumpElementsAtPoint(page, x, y) {
  return await page.evaluate(({ x, y }) => {
    const els = document.elementsFromPoint(x, y);
    return els.slice(0, 12).map((e) => {
      const r = e.getBoundingClientRect();
      const cls = (e.getAttribute && e.getAttribute("class")) || "";
      const aria = (e.getAttribute && e.getAttribute("aria-label")) || "";
      const role = (e.getAttribute && e.getAttribute("role")) || "";
      const dt = (e.getAttribute && e.getAttribute("data-testid")) || "";
      const fillAttr = (e.getAttribute && e.getAttribute("fill")) || "";
      return {
        tag: e.tagName,
        cls: typeof cls === "string" ? cls.slice(0, 60) : "",
        aria: aria.slice(0, 50),
        role,
        dt,
        fillAttr,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
  }, { x, y });
}

/**
 * Canvaのセル背景シェイプ (cream色) に塗りつぶしの色を設定
 *  問題: 新テンプレでもプレースホルダーやセル境界線(<line>)が前面にあり、
 *        単純クリックでは背後のcreamシェイプに到達できない。
 *  対策: placeholder 間のギャップ (top↔middle, middle↔bottom) を狙ってクリック
 *        + elementsFromPoint で何があるかDOM側から特定
 *
 * 引数:
 *   - slot: 着色対象 placeholder ({x,y,w,h,top,bottom,...})
 *   - hexColor: 設定したい色
 *   - cellContext: { top, middle, bottom } 同セルの全プレースホルダー (ギャップ計算用)
 *   - opts.diagnose: 診断モードで詳細ログ出力
 */
async function setShapeFillColor(page, slot, hexColor, cellContext = null, opts = {}) {
  try {
    // 0) 前回状態をクリーンに (Escape × 2 で frame select も edit mode も解除)
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);

    // 塗りつぶしの色ボタン探索ヘルパー
    //   優先順位:
    //     1. "塗りつぶしの色" "Fill color" "Background color" など明確なフィル色キーワード
    //     2. "色" "Color" "シェイプ" を含む単独ボタン (ただし "テキストの色" "枠線" 等は除外)
    const findFillButton = async () => {
      return await page.evaluate(() => {
        const strongKeywords = [
          "カラー",
          "塗りつぶしの色",
          "塗りつぶし",
          "背景色",
          "Background color",
          "Fill color",
          "シェイプの色",
          "シェイプ色",
        ];
        // 単独「色」「Color」ボタンは fallback として 2 周目で拾う
        const fallbackKeywords = ["色", "Color"];
        // 除外条件 (テキスト色/枠線/ストローク/ロック/字体 等)
        const isExcluded = (label) => {
          const l = label.toLowerCase();
          if (label.includes("テキストの色") || label.includes("文字色")) return true;
          if (label.includes("テキストの背景")) return true;
          if (label.includes("枠線") || l.includes("border")) return true;
          if (label.includes("ストローク") || l.includes("stroke")) return true;
          if (label.includes("ロック") || l.includes("lock")) return true;
          if (label.includes("透明度") || l.includes("transparency") || l.includes("opacity")) return true;
          if (label.includes("アニメーション") || l.includes("animation")) return true;
          if (label.includes("フォント") || l.includes("font")) return true;
          if (label.includes("配置") || l.includes("position") || l.includes("arrange")) return true;
          if (label.includes("削除") || l.includes("delete")) return true;
          return false;
        };
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        // Step 1: strong keywords
        for (const btn of buttons) {
          const label = btn.getAttribute("aria-label") || "";
          if (!label || isExcluded(label)) continue;
          if (!strongKeywords.some((k) => label.toLowerCase().includes(k.toLowerCase()))) continue;
          const r = btn.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, label, matched: "strong" };
        }
        // Step 2: fallback keywords ("色"/"Color" 単独)
        for (const btn of buttons) {
          const label = btn.getAttribute("aria-label") || "";
          if (!label || isExcluded(label)) continue;
          if (!fallbackKeywords.some((k) => label.toLowerCase().includes(k.toLowerCase()))) continue;
          const r = btn.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, label, matched: "fallback" };
        }
        return null;
      });
    };

    // 診断モード: 現在画面に出ているツールバー系ボタンの aria-label を全件ダンプ
    const dumpToolbarLabels = async () => {
      return await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label]'));
        const visible = all.filter((b) => {
          if (b.offsetParent === null) return false;
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          // 画面外を除外
          if (r.top < 0 || r.left < 0) return false;
          if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
          return true;
        });
        // 上部ツールバー領域 (y < 200) を優先抽出
        const top = visible.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.top < 200;
        });
        return top.map((b) => b.getAttribute("aria-label")).filter(Boolean);
      });
    };

    let buttonInfo = null;
    let strategy = "";
    const tries = []; // 診断用 (どこをクリックして何があったか)

    // クリック候補位置を構築
    //   - placeholder bbox 外周の各方向 (right/left/above/below)
    //   - cellContext がある場合: top↔middle, middle↔bottom のギャップ中心 (★線を避けて命中する可能性大)
    //   - cellContext がある場合: cell全体のbbox(top.top〜bottom.bottom)から下方/上方の余白
    //   - フォールバック: 中心
    const halfW = slot.w ? slot.w / 2 : 30;
    const halfH = slot.h ? slot.h / 2 : 10;
    const candidatePositions = [];

    // ── cream矩形の中心1点だけクリック (旧テンプレ + duplicateRectangles.js で配置済) ──
    //   多数のクリック+Escapeを撃つと Canva のテキスト書込み状態を壊すので、矩形中心1点のみ。
    //   ボタン名は「カラー」(Canvaの正式名) で findFillButton が拾う。
    if (cellContext && cellContext.rect) {
      candidatePositions.push(
        { name: "rect_center", x: cellContext.rect.x, y: cellContext.rect.y }
      );
    }
    // フォールバック: cellContext.rect が無い場合のみ slot中心
    if (candidatePositions.length === 0) {
      candidatePositions.push({ name: "slot_center", x: slot.x, y: slot.y });
    }

    for (const c of candidatePositions) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(120);
      // canvaClick: hover→move→down→up で React のイベントを確実に発火
      await canvaClick(page, c.x, c.y);
      await page.waitForTimeout(550);
      let info = await findFillButton();
      // 1回目で反応しない場合、もう一度クリック (Canvaは初回クリックを fokus 設定だけに
      // 使って次のクリックで選択するパターンがある)
      if (!info) {
        await canvaClick(page, c.x, c.y);
        await page.waitForTimeout(550);
        info = await findFillButton();
      }
      if (opts.diagnose) {
        const stack = await dumpElementsAtPoint(page, c.x, c.y);
        const top3 = stack.slice(0, 3).map((e) => `<${e.tag}${e.aria ? ` "${e.aria}"` : ""}${e.fillAttr ? ` fill=${e.fillAttr}` : ""}>`).join(" → ");
        tries.push(`${c.name}(${Math.round(c.x)},${Math.round(c.y)}) ${info ? "✓FILL" : "✗"} stack:[${top3}]`);
      }
      if (info) {
        buttonInfo = info;
        strategy = `${c.name}(${Math.round(c.x)},${Math.round(c.y)})`;
        break;
      }
    }

    if (!buttonInfo) {
      let diag = "";
      if (opts.diagnose) {
        // rect_center を再度クリックしてツールバー全件ダンプ (シェイプを選択した状態で)
        if (cellContext && cellContext.rect) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(150);
          await page.mouse.click(cellContext.rect.x, cellContext.rect.y);
          await page.waitForTimeout(600);
        }
        const allLabels = await dumpToolbarLabels();
        diag = `tries:\n          ${tries.join("\n          ")}\n        toolbar全ボタン (rect_center選択時, y<200):\n          ${allLabels.length ? allLabels.map((l, i) => `[${i}] ${l}`).join("\n          ") : "(空)"}`;
      }
      await page.keyboard.press("Escape").catch(() => {});
      return { ok: false, reason: "塗りつぶしの色ボタンが見つからない", diag };
    }

    if (opts.diagnose) {
      console.log(`         [diag] ✓ fill button found via ${strategy}: aria="${buttonInfo.label}" (matched=${buttonInfo.matched || "?"})`);
    }

    // 3) 塗りつぶしの色ボタンをクリック → サイドパネルが開く (canvaClick で確実に発火)
    await canvaClick(page, buttonInfo.x, buttonInfo.y);
    await page.waitForTimeout(800);

    // 4) Hex 入力欄を探索
    const hex = hexColor.replace(/^#/, "").toUpperCase();
    const findHexInput = async () => {
      const hexInputSelectors = [
        'input[aria-label*="Hex" i]',
        'input[aria-label*="16進" i]',
        'input[placeholder*="Hex" i]',
        'input[placeholder*="#" i]',
        'input[maxlength="6"]',
        'input[maxlength="7"]',
      ];
      for (const sel of hexInputSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) return el;
        } catch {}
      }
      // フォールバック: パネル内の text input
      try {
        const fb = await page.$('div[role="dialog"] input[type="text"], aside input[type="text"]');
        if (fb && (await fb.isVisible())) return fb;
      } catch {}
      return null;
    };

    let hexInput = await findHexInput();

    // 出ていなければ「+ 新しい色を追加」系ボタンを踏んで再探索
    if (!hexInput) {
      const addColorSelectors = [
        'button[aria-label*="新しい色"]',
        'button[aria-label*="カスタム"]',
        'button[aria-label*="色を追加"]',
        'button[aria-label*="Add" i]',
        'button[aria-label*="Custom" i]',
        'button[aria-label*="New color" i]',
      ];
      for (const sel of addColorSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && (await btn.isVisible())) {
            await btn.click();
            await page.waitForTimeout(400);
            break;
          }
        } catch {}
      }
      hexInput = await findHexInput();
    }

    if (!hexInput) {
      let diag = "";
      if (opts.diagnose) {
        try {
          const info = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'))
              .filter((el) => el.offsetParent !== null)
              .map((el) => ({
                aria: el.getAttribute('aria-label') || '',
                placeholder: el.getAttribute('placeholder') || '',
                maxlength: el.getAttribute('maxlength') || '',
                type: el.type || '',
              }))
              .slice(0, 30);
            const buttons = Array.from(document.querySelectorAll('button[aria-label]'))
              .filter((b) => b.offsetParent !== null)
              .map((b) => b.getAttribute('aria-label'))
              .slice(0, 40);
            return { inputs, buttons };
          });
          diag = `inputs=${JSON.stringify(info.inputs)} buttons=${JSON.stringify(info.buttons)}`;
        } catch {}
      }
      await page.keyboard.press("Escape").catch(() => {});
      return { ok: false, reason: "Hex入力欄が見つからない", diag };
    }

    // 5) Hex 入力 (React controlled input 対応: keyboard.type + native setter 両方)
    await hexInput.click();
    await page.waitForTimeout(120);
    try { await hexInput.focus(); } catch {}
    await page.waitForTimeout(80);

    // 既存値クリア
    await page.keyboard.press(`${MOD}+A`);
    await page.waitForTimeout(80);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);

    await page.keyboard.type(hex, { delay: 50 });
    await page.waitForTimeout(250);

    let typedValue = null;
    try {
      typedValue = await hexInput.evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (setter) setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      }, hex);
    } catch {}
    await page.waitForTimeout(200);

    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);

    // 6) パネル閉じ + frame select 解除
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    // 7) 念のため画面の中立位置 (左上の余白) をクリックして完全に選択解除
    //    Why: Escape だけでは色サイドパネルや矩形選択が残ることがあり、
    //         次のセル処理で誤クリックの原因になる
    try {
      const vp = page.viewportSize();
      if (vp) {
        await page.mouse.click(20, 80);
        await page.waitForTimeout(150);
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(150);
      }
    } catch {}

    // 反映確認は一旦撤回 (cream矩形が前面に残って読み取られ、誤って失敗判定する問題があった)
    return { ok: true, typedValue };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * デバッグ: ページ内のフォント関連UI要素をダンプ
 */
async function dumpFontControls(page) {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("input").forEach((el) => {
      const label = el.getAttribute("aria-label") || "";
      const testid = el.getAttribute("data-testid") || "";
      if (
        label.toLowerCase().includes("font") ||
        label.includes("フォント") || label.includes("文字") ||
        testid.toLowerCase().includes("font")
      ) {
        out.push({
          tag: el.tagName,
          type: el.type,
          label,
          testid,
          value: el.value,
          visible: !!el.offsetParent,
        });
      }
    });
    return out;
  });
}

/**
 * デバッグ: 色 / 塗りつぶし関連の可視UI要素をダンプ
 *  クリック直後のツールバーを調査するため、button や role=button の要素を広く拾う
 */
async function dumpColorControls(page) {
  return await page.evaluate(() => {
    const out = [];
    const targets = document.querySelectorAll(
      'button, [role="button"], [aria-label]'
    );
    targets.forEach((el) => {
      if (!el.offsetParent) return; // 非表示はスキップ
      const label = el.getAttribute("aria-label") || "";
      const testid = el.getAttribute("data-testid") || "";
      const title = el.getAttribute("title") || "";
      const text = (el.textContent || "").trim().slice(0, 30);
      const tag = el.tagName;
      // 色 / fill / 塗 / background が含まれる物 (大小文字・日英混在対応)
      const hay = (label + " " + testid + " " + title + " " + text).toLowerCase();
      if (
        hay.includes("color") ||
        hay.includes("fill") ||
        label.includes("色") ||
        label.includes("塗") ||
        label.includes("背景") ||
        testid.toLowerCase().includes("color") ||
        testid.toLowerCase().includes("fill")
      ) {
        out.push({ tag, label, testid, title, text });
      }
    });
    return out;
  });
}

/**
 * 背景シェイプ選択方法のプローブ (1日のみ実行する診断モード)
 *  ・cell { top, middle, bottom } の各 placeholder bbox を活用してクリック位置を計算
 *  ・特に top↔middle / middle↔bottom のギャップ位置 (line/text を回避できる候補)
 *  ・各位置で elementsFromPoint してDOM上の積層状態を可視化
 *  ・「塗りつぶしの色」が出る位置を特定する
 */
async function runShapeProbe(page, cell) {
  const top = cell.top;
  const middle = cell.middle;
  const bottom = cell.bottom;
  console.log(`     [probe] 背景シェイプ探索プローブ開始 (cell.top=${top.x.toFixed(0)},${top.y.toFixed(0)} bbox=${top.w?.toFixed(0)}×${top.h?.toFixed(0)})`);
  if (middle) console.log(`     [probe] cell.middle=${middle.x.toFixed(0)},${middle.y.toFixed(0)} bbox=${middle.w?.toFixed(0)}×${middle.h?.toFixed(0)}`);
  if (bottom) console.log(`     [probe] cell.bottom=${bottom.x.toFixed(0)},${bottom.y.toFixed(0)} bbox=${bottom.w?.toFixed(0)}×${bottom.h?.toFixed(0)}`);

  let vp = null;
  try { vp = page.viewportSize(); } catch {}
  if (vp) console.log(`     [probe] viewport: ${vp.width}×${vp.height}`);

  const KEYWORDS = ["色", "塗", "画像", "写真", "border", "枠", "フォント", "テキスト",
                    "color", "fill", "image", "photo", "background", "stroke", "transparency", "透明"];

  const dumpToolbar = async () => {
    return await page.evaluate((kw) => {
      const isMatch = (s) => kw.some((k) => s.toLowerCase().includes(k.toLowerCase()));
      return Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label]'))
        .filter((b) => b.offsetParent !== null)
        .map((b) => b.getAttribute('aria-label'))
        .filter((l) => l && isMatch(l))
        .slice(0, 20);
    }, KEYWORDS);
  };

  // クリック位置を構築 (cell.top/middle/bottom の bbox から計算)
  const offsets = [];
  // ── 中心 (テキスト要素ヒット確認用) ──
  offsets.push({ name: "top_center", x: top.x, y: top.y });
  // ── 各方向 (placeholder bbox の外周) ──
  const hW = top.w ? top.w / 2 : 30;
  const hH = top.h ? top.h / 2 : 10;
  offsets.push(
    { name: "above_top",       x: top.x, y: top.y - hH - 6 },
    { name: "above_top_xl",    x: top.x, y: top.y - hH - 18 },
    { name: "right_top_xl",    x: top.x + hW + 18, y: top.y },
    { name: "left_top_xl",     x: top.x - hW - 18, y: top.y },
  );
  // ── ギャップ位置 (line を回避する命中候補) ──
  if (middle) {
    const gapTM = (top.bottom + middle.top) / 2;
    offsets.push(
      { name: "gap_TM_center",   x: top.x, y: gapTM },
      { name: "gap_TM_right",    x: top.x + hW + 6, y: gapTM },
      { name: "gap_TM_left",     x: top.x - hW - 6, y: gapTM }
    );
  }
  if (middle && bottom) {
    const gapMB = (middle.bottom + bottom.top) / 2;
    offsets.push(
      { name: "gap_MB_center",   x: top.x, y: gapMB }
    );
  }
  if (bottom) {
    offsets.push(
      { name: "below_bottom",    x: top.x, y: bottom.bottom + 6 },
      { name: "below_bottom_xl", x: top.x, y: bottom.bottom + 20 }
    );
  }

  // 各位置でクリック → ツールバー観察 + elementsFromPoint
  for (const o of offsets) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(120);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
    await page.mouse.click(o.x, o.y);
    await page.waitForTimeout(550);

    const labels = await dumpToolbar();
    const stack = await dumpElementsAtPoint(page, o.x, o.y);
    const xy = `(${o.x.toFixed(0)},${o.y.toFixed(0)})`;
    const top3 = stack.slice(0, 3).map((e) =>
      `<${e.tag}${e.aria ? ` "${e.aria.slice(0, 20)}"` : ""}${e.fillAttr ? ` fill=${e.fillAttr}` : ""} ${e.w}×${e.h}>`
    ).join(" → ");
    console.log(`       [probe:${o.name}] ${xy} tools=[${labels.slice(0, 4).join(" | ")}] DOM=[${top3}]`);
  }

  // クリーンアップ
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  console.log(`     [probe] 探索完了`);
}

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
          // 中心座標がビューポート内のものだけ採用 (現在表示中のページのみ拾う)
          if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) {
            results.push({
              x: cx,
              y: cy,
              w: rect.width,
              h: rect.height,
              left: rect.x,
              top: rect.y,
              right: rect.x + rect.width,
              bottom: rect.y + rect.height,
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

async function waitForPlaceholders(page, expected, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const arr = await findPlaceholders(page);
    if (arr.length >= expected) return arr;
    await page.waitForTimeout(2000);
  }
  return await findPlaceholders(page);
}

/**
 * 配置済み cream色矩形 (DIV background-color) をDOMから検出
 *  duplicateRectangles.js の findAllFilledRects と同じロジック (size 30〜250 / 真白真黒除外 / url(grad)除外)
 *  目的: 旧テンプレに事前配置した cream矩形42個の正確な中心座標を得て、色付け時のクリック対象にする。
 */
async function findFilledRectShapes(page) {
  return await page.evaluate(() => {
    const out = [];
    const minDim = 30;
    const maxDim = 250;
    const isMeaningfulFill = (s) => {
      if (!s) return false;
      const t = s.trim().toLowerCase();
      if (!t || t === 'none' || t === 'transparent' || t === 'currentcolor') return false;
      if (t.startsWith('rgba(0, 0, 0, 0)') || t.startsWith('rgba(0,0,0,0)')) return false;
      if (t.startsWith('url(')) return false;
      if (t === '#fff' || t === '#ffffff' || t === 'white' || t === 'rgb(255, 255, 255)') return false;
      if (t === '#000' || t === '#000000' || t === 'black' || t === 'rgb(0, 0, 0)') return false;
      return true;
    };
    document.querySelectorAll('rect, path, polygon, ellipse, circle').forEach((el) => {
      let fill = (el.getAttribute('fill') || '').trim();
      if (!fill || fill === 'currentColor') {
        try { fill = window.getComputedStyle(el).fill || ''; } catch {}
      }
      if (!isMeaningfulFill(fill)) return;
      const bb = el.getBoundingClientRect();
      if (bb.width < minDim || bb.height < minDim) return;
      if (bb.width > maxDim || bb.height > maxDim) return;
      out.push({ tag: el.tagName, fill, x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, w: bb.width, h: bb.height });
    });
    document.querySelectorAll('div').forEach((el) => {
      let bg = '';
      try { bg = window.getComputedStyle(el).backgroundColor || ''; } catch {}
      if (!isMeaningfulFill(bg)) return;
      const bb = el.getBoundingClientRect();
      if (bb.width < minDim || bb.height < minDim) return;
      if (bb.width > maxDim || bb.height > maxDim) return;
      out.push({ tag: 'DIV', fill: bg, x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, w: bb.width, h: bb.height });
    });
    return out;
  });
}

/**
 * Pass 2 のテキスト書込み中、cells に割当済の cream矩形 ONLY を「クリック透過」化する。
 * 前回実装の hideFilledRectShapes は判定条件が広すぎて Canva 内部の UI 要素 (139個)
 * まで透過化してしまい、placeholder クリックすら届かない事故になった。
 *
 * Why 割当済 ONLY: attachRectsToCells で各セルに 42個ピッタリ割り当てた rect だけが
 *   placeholder と衝突する対象。それ以外の DIV (Canva UI など) は触らない。
 *
 * cells: groupIntoCells / legacy 構築済の cells (cell.rect が設定されている)
 */
async function hideAssignedRects(page, cells) {
  // ★重要: cell.rect (cream矩形の実寸 44×64) を基準にする。
  //   過去 cell.top (placeholder 33×8) を基準にしたため、TOL=16 で
  //   placeholder のテキストラッパー DIV (43×9 等) が253個マッチして
  //   placeholder 自体が display:none になっていた (= 編集モード突入失敗)。
  const targets = [];
  let totalRectCount = 0;
  for (const row of cells) {
    for (const cell of row) {
      if (cell && cell.rect) {
        totalRectCount++;
        targets.push({
          x: cell.rect.x,
          y: cell.rect.y,
          w: cell.rect.w,
          h: cell.rect.h,
        });
      }
    }
  }
  // ★fix41: 中途半端な rect 配置時 (例: 25/42) は hide をスキップ。
  //   Why: 実機検証 (2026-05-25 fix40 実行) で、 cream rect 25個を hide した結果
  //        Pass 2 が 0/28 全失敗。 一方 fix38 (cream 0個・透過化 0個) では 18/28 達成。
  //        部分配置時の rect hide は Canva の internal layout を破壊して click ターゲットが
  //        ずれる副作用がある。 30個未満なら hide をスキップして fix38 同等動作を維持。
  //        過去 fix26 = 31/31 達成時は rect 42個 (= 30以上) で hide が機能した実績あり。
  if (totalRectCount > 0 && totalRectCount < 30) {
    return { count: 0, overlayCount: 0, rectCount: totalRectCount, skippedDueToPartial: true };
  }
  // ★fix40: cream矩形 0個 fallback (6月P33 等 duplicateRectangles.js 未実行テンプレ対応)
  //   Why: cream矩形が無いと cell.rect が null → targets 空 → 透過化 0個 → Canva の
  //        click intercept overlay (透明 DIV) が dblclick を吸収 → 編集モード突入失敗 →
  //        isInTextEditMode が前セル font input 残存で false-positive ok=true →
  //        typing 空打ち → 1-9日 全失敗 (2026-06 実行で観測)。
  //   対策: cell.top (placeholder 中心) + cell下方 30/60px の 3点プローブで
  //        elementsFromPoint で stack を取得、 半透明な要素 (= click intercept overlay)
  //        を hide する。 cream色矩形は元々無いので rectCount=0 のままで OK。
  //   fix40 強化点 (fix39 は overlay 検出 0個 で失敗していた):
  //     - 検索点を cell.top に加え、 cell 中央 (top.y + 30px), cell下部 (top.y + 60px) も追加
  //     - サイズフィルタを 25-250 → 15-350 に緩和
  //     - DIV 限定 → DIV/BUTTON/A/SECTION/ARTICLE 含める
  //     - 半透明 (alpha < 0.1) も overlay とみなす
  //     - 1セル目で elementsFromPoint の全要素を診断ダンプ
  if (targets.length === 0) {
    const phPoints = [];
    let firstCell = null;
    for (const row of cells) {
      for (const cell of row) {
        if (cell && cell.top) {
          if (!firstCell) firstCell = cell.top;
          // 3点プローブ: 上部 (placeholder中心) / 中央 / 下部
          phPoints.push({ x: cell.top.x, y: cell.top.y });
          phPoints.push({ x: cell.top.x, y: cell.top.y + 30 });
          phPoints.push({ x: cell.top.x, y: cell.top.y + 60 });
        }
      }
    }
    if (phPoints.length === 0) return { count: 0, overlayCount: 0, rectCount: 0, fallback: true };

    // fix40-診断: 1セル目の elementsFromPoint 全要素をダンプ (overlay 構造把握用)
    // ★fix41: 毎セル diag が出ると ログが爆発するため、 グローバルフラグで初回のみ出力
    if (firstCell && !hideAssignedRects._diagPrinted) {
      hideAssignedRects._diagPrinted = true;
      try {
        const diag = await page.evaluate(({ x, y }) => {
          const probes = [
            { x, y, label: 'top' },
            { x, y: y + 30, label: 'mid' },
            { x, y: y + 60, label: 'btm' },
          ];
          const out = [];
          for (const p of probes) {
            const stack = document.elementsFromPoint(p.x, p.y);
            for (let i = 0; i < Math.min(8, stack.length); i++) {
              const el = stack[i];
              const bb = el.getBoundingClientRect();
              let bg = '';
              try { bg = window.getComputedStyle(el).backgroundColor || ''; } catch {}
              out.push({
                probe: p.label,
                idx: i,
                tag: el.tagName,
                w: Math.round(bb.width),
                h: Math.round(bb.height),
                bg: bg.slice(0, 30),
              });
            }
          }
          return out;
        }, { x: firstCell.x, y: firstCell.y });
        console.log(`     [fix40-diag] cell(0,0) elementsFromPoint stack (3点プローブ):`);
        diag.forEach((d) =>
          console.log(`        [${d.probe}#${d.idx}] <${d.tag}> ${d.w}×${d.h} bg="${d.bg}"`)
        );
      } catch (e) {
        console.log(`     [fix40-diag] 診断ダンプ失敗: ${e.message}`);
      }
    }

    return await page.evaluate((points) => {
      const markClickThrough = (el) => {
        el.setAttribute('data-canva-clickthrough', '1');
        el.setAttribute('data-orig-display', el.style.display ?? '');
        el.setAttribute('data-orig-visibility', el.style.visibility ?? '');
        el.setAttribute('data-orig-opacity', el.style.opacity ?? '');
        el.setAttribute('data-orig-pe', el.style.pointerEvents ?? '');
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
      };
      // bg が「半透明 or 透明」 か判定 (alpha < 0.1 含む)
      const isTransparentish = (bg) => {
        if (!bg) return true;
        if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return true;
        const m = bg.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+))?\s*\)/);
        if (m) {
          const alpha = m[1] !== undefined ? parseFloat(m[1]) : 1;
          if (alpha < 0.1) return true;
        }
        return false;
      };
      let count = 0;
      let overlayCount = 0;
      const ALLOW_TAGS = new Set(['DIV', 'BUTTON', 'A', 'SECTION', 'ARTICLE']);
      for (const p of points) {
        const stack = document.elementsFromPoint(p.x, p.y);
        for (const el of stack) {
          if (el.hasAttribute('data-canva-clickthrough')) continue;
          const tag = el.tagName || '';
          if (tag === 'SPAN' || tag === 'P' || tag === 'TEXT') continue;
          if (!ALLOW_TAGS.has(tag)) continue;
          const bb = el.getBoundingClientRect();
          // fix40: 緩めたサイズフィルタ 15-350px
          if (bb.width < 15 || bb.height < 15) continue;
          if (bb.width > 350 || bb.height > 350) continue;
          let bg = '';
          try { bg = window.getComputedStyle(el).backgroundColor || ''; } catch {}
          // 半透明 or 透明 のみ hide (色付き要素はテンプレ本体なので触らない)
          if (!isTransparentish(bg)) continue;
          markClickThrough(el);
          count++;
          overlayCount++;
        }
      }
      return { count, overlayCount, rectCount: 0, fallback: true };
    }, phPoints);
  }
  return await page.evaluate((targets) => {
    // ★v6: v3挙動を完全復元 (位置チェック削除)
    //   v3 の hide 数 168個 (cream矩形42 + 透明オーバーレイ126) で
    //   全31日が編集モード突入していた事実を尊重する。
    //   elementsFromPoint(rect中心) + サイズフィルタ(44×64±tol) だけで十分絞り込める。
    const TOL_W = 8;
    const TOL_H = 12;
    const markClickThrough = (el) => {
      el.setAttribute('data-canva-clickthrough', '1');
      el.setAttribute('data-orig-display', el.style.display ?? '');
      el.setAttribute('data-orig-visibility', el.style.visibility ?? '');
      el.setAttribute('data-orig-opacity', el.style.opacity ?? '');
      el.setAttribute('data-orig-pe', el.style.pointerEvents ?? '');
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    };
    let count = 0;
    let overlayCount = 0;
    let rectCount = 0;
    for (const t of targets) {
      const stack = document.elementsFromPoint(t.x, t.y);
      for (const el of stack) {
        if (el.hasAttribute('data-canva-clickthrough')) continue;
        const bb = el.getBoundingClientRect();
        if (Math.abs(bb.width - t.w) > TOL_W) continue;
        if (Math.abs(bb.height - t.h) > TOL_H) continue;

        const tag = el.tagName || '';
        // テキスト系は絶対に除外
        if (tag === 'SPAN' || tag === 'P' || tag === 'TEXT') continue;

        let bg = '';
        try { bg = window.getComputedStyle(el).backgroundColor || ''; } catch {}
        const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';

        const SVG_TAGS = ['RECT', 'PATH', 'POLYGON', 'ELLIPSE', 'CIRCLE'];
        let hasFill = false;
        if (SVG_TAGS.includes(tag)) {
          let fillAttr = '';
          try { fillAttr = (el.getAttribute && el.getAttribute('fill')) || ''; } catch {}
          let fillCss = '';
          try { fillCss = window.getComputedStyle(el).fill || ''; } catch {}
          const fill = fillAttr || fillCss;
          hasFill = fill && fill !== 'none' && fill !== 'transparent' && fill !== 'rgb(0, 0, 0)';
        }

        // 透明な 44×64 DIV は Canva の「クリックオーバーレイ」として hide 対象
        const isCanvaClickOverlay = (tag === 'DIV' && !hasBg && !hasFill);
        if (!hasBg && !hasFill && !isCanvaClickOverlay) continue;

        markClickThrough(el);
        count++;
        if (hasBg || hasFill) rectCount++;
        else overlayCount++;
      }
    }
    return { count, overlayCount, rectCount };
  }, targets);
}

async function restoreFilledRectShapes(page) {
  return await page.evaluate(() => {
    const all = document.querySelectorAll('[data-canva-clickthrough="1"]');
    all.forEach((el) => {
      // display と visibility も復元 (新規追加)
      const origDisplay = el.getAttribute('data-orig-display') || '';
      const origVisibility = el.getAttribute('data-orig-visibility') || '';
      const origOpacity = el.getAttribute('data-orig-opacity') || '';
      const origPe = el.getAttribute('data-orig-pe') || '';
      // setProperty で !important を解除して元の状態に戻す
      if (origDisplay === '') el.style.removeProperty('display'); else el.style.display = origDisplay;
      if (origVisibility === '') el.style.removeProperty('visibility'); else el.style.visibility = origVisibility;
      if (origOpacity === '') el.style.removeProperty('opacity'); else el.style.opacity = origOpacity;
      if (origPe === '') el.style.removeProperty('pointer-events'); else el.style.pointerEvents = origPe;
      el.removeAttribute('data-canva-clickthrough');
      el.removeAttribute('data-orig-display');
      el.removeAttribute('data-orig-visibility');
      el.removeAttribute('data-orig-opacity');
      el.removeAttribute('data-orig-pe');
    });
    return all.length;
  });
}

/**
 * 各セルの placeholder anchor から最寄りの cream矩形を割り当て
 *  返り値: cells (引数オブジェクトに `cell.rect = {x,y,w,h,fill}` を追加した配列)
 *  Why: 旧テンプレで事前配置した42矩形を「自動色付けのクリック対象」として活用するため。
 */
function attachRectsToCells(cells, rectShapes) {
  // 各矩形を「最寄りセル」へユニーク割当 (重複を防ぐ)
  const cellList = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r].length; c++) {
      const cell = cells[r][c];
      if (!cell || !cell.top) continue;
      cellList.push({ cell, anchor: { x: cell.top.x, y: cell.top.y }, key: `${r},${c}` });
    }
  }
  const buckets = new Map();
  for (const rect of rectShapes) {
    let best = null;
    let bestDist = Infinity;
    for (const e of cellList) {
      const d = Math.hypot(rect.x - e.anchor.x, rect.y - e.anchor.y);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    if (!best) continue;
    if (!buckets.has(best.key)) buckets.set(best.key, []);
    buckets.get(best.key).push({ rect, dist: bestDist });
  }
  let assigned = 0;
  for (const e of cellList) {
    const list = buckets.get(e.key);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => a.dist - b.dist);
    e.cell.rect = list[0].rect; // 最も近い矩形を採用
    assigned++;
  }
  return assigned;
}

/**
 * 126個のプレースホルダーを 42マス × 3プレースホルダー(上/中/下) にグループ化
 *  方式:
 *   1) 全部Yでソート (ソート後は visual row 順)
 *   2) 7個ずつスライスして 18 visual row を取り出す
 *   3) 各 visual row 内で X ソート → 7曜日列確定
 *   4) cells[r][c] = { top, middle, bottom }  ※ r*3+0/+1/+2 が top/middle/bottom
 *
 * Note: Y近接クラスタリングだと within-cell と between-cell の間隔が近くて
 *  6行に縮約されてしまうことがあるため、126=18×7 を前提にスライスする方式にした
 */
function groupIntoCells(placeholders) {
  if (placeholders.length !== 126) {
    throw new Error(`プレースホルダー数が${placeholders.length}個 (期待:126個)。`);
  }

  const sorted = [...placeholders].sort((a, b) => a.y - b.y);

  // 7個ずつ 18行 にスライス
  const visualRows = [];
  for (let i = 0; i < 18; i++) {
    const row = sorted.slice(i * 7, (i + 1) * 7);
    row.sort((a, b) => a.x - b.x);
    visualRows.push(row);
  }

  // 健全性チェック: 各visual行のY範囲が小さいか (全7個が同じ視覚行か)
  for (let i = 0; i < 18; i++) {
    const ys = visualRows[i].map((p) => p.y);
    const span = Math.max(...ys) - Math.min(...ys);
    if (span > 30) {
      console.log(
        `   ⚠️ visual行${i}のYスパンが${span.toFixed(1)}px (大きい場合は誤グルーピングかも)`
      );
    }
  }

  // 6 grid rows × 7 cols のセルを構築
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
 * Canva 向けの「確実に反応するクリック」シーケンス
 *  Why: 単純な page.mouse.click() だと Canva の React 合成イベントが反応しない
 *       ことがある(クリックしても何も選択されないツールバーが空のまま等)。
 *       hover→move→down→up→up の自然な手順で操作すると認識される。
 *  count: 1=single click, 2=double click
 */
async function canvaClick(page, x, y, count = 1) {
  try {
    // まず少し離れた位置にマウスを移動 (hover イベント発火準備)
    await page.mouse.move(x - 40, y - 40, { steps: 3 });
    await page.waitForTimeout(40);
    // 対象座標へ移動 (move イベント発火)
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(60);
    // クリック
    await page.mouse.down();
    await page.waitForTimeout(20);
    await page.mouse.up();
    if (count >= 2) {
      await page.waitForTimeout(60);
      await page.mouse.down();
      await page.waitForTimeout(20);
      await page.mouse.up();
    }
  } catch {}
}

/**
 * テキスト編集モードに入っているか判定
 *  Why: Pass 1 で配置した cream 矩形が placeholder の上に重なっており、
 *       単純なクリック+dblclick では矩形が選択されてしまうことがある。
 *       編集モードに入っていれば「フォントサイズ」入力が可視になっているはず。
 */
async function isInTextEditMode(page) {
  try {
    return await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[aria-label*="フォントサイズ"], input[aria-label*="文字サイズ"], input[aria-label*="Font size" i]'));
      return inputs.some((el) => el.offsetParent !== null);
    });
  } catch {
    return false;
  }
}

/**
 * placeholder bbox 内で cream矩形を回避できる候補位置を生成
 *  Why: cream矩形(中央配置)が placeholder 中心を覆って編集モードに入れない。
 *  placeholder の bbox 内(=隣セルに絶対飛ばない安全範囲)で、矩形外の余白を狙う。
 *  実機結果: 9/19/30/21日は端 (ph_right/left/TL) で成功、 center 単独成功は不安定。
 *  → 端優先に並べ替え、 center は最後の保険にする。
 */
function buildClickCandidates(pos) {
  // bbox 情報が無ければ center のみ
  if (pos.top == null || pos.bottom == null || pos.left == null || pos.right == null) {
    return [{ x: pos.x, y: pos.y, label: "center" }];
  }
  const innerPad = 4;
  return [
    // 端を最初に試す (cream矩形が中央配置なので端は確実に矩形外)
    { x: pos.left + innerPad, y: pos.top + innerPad, label: "ph_TL" },
    { x: pos.right - innerPad, y: pos.top + innerPad, label: "ph_TR" },
    { x: pos.x, y: pos.top + innerPad, label: "ph_top_inner" },
    { x: pos.x, y: pos.bottom - innerPad, label: "ph_bottom_inner" },
    { x: pos.left + innerPad, y: pos.y, label: "ph_left_inner" },
    { x: pos.right - innerPad, y: pos.y, label: "ph_right_inner" },
    // center は最後の保険
    { x: pos.x, y: pos.y, label: "center" },
  ];
}

/**
 * placeholder bbox 内の候補位置でテキスト編集モードへの突入を試行
 *  bbox 内に限定しているので隣セルに飛ぶ事故は起こらない。
 */
async function enterTextEditAtCell(page, pos, opts = {}) {
  const candidates = buildClickCandidates(pos);
  const tryOne = async (c) => {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
    // ★クリック直前に cream矩形を再 hide (Canva の React 再描画で復活した直後にクリック)
    if (opts.cells) {
      try { await hideAssignedRects(page, opts.cells); } catch {}
    }
    // Native double-click (Playwright内部で正しいmousedown/up/dblclickイベント発火)
    //   過去 canvaClick(single) → wait → canvaClick(double) の手順だったが、
    //   single click で rect 選択 → そのまま double-click で rect の color picker に
    //   入る事故があった。native dblclick の方がテキスト編集モードに入りやすい。
    try {
      await page.mouse.move(c.x, c.y, { steps: 3 });
      await page.waitForTimeout(60);
      await page.mouse.dblclick(c.x, c.y, { delay: 60 });
    } catch {}
    // 編集モード遷移待ち (最大 5×220ms = 1.1s)
    for (let w = 0; w < 5; w++) {
      await page.waitForTimeout(220);
      if (await isInTextEditMode(page)) return true;
    }
    return false;
  };
  for (const c of candidates) {
    if (await tryOne(c)) {
      return { ok: true, where: c.label, x: c.x, y: c.y };
    }
  }
  return { ok: false, where: null, x: pos.x, y: pos.y };
}

/**
 * 1行を cell 幅 (44px / 7pt) に収まる長さでセグメント化。
 *  Why: ジャンル特化グルコン (10字) や SnsClub卒業生交流会 等の長い行は
 *       Canva の text element が auto-width で右に伸び、隣セルに被って表示される。
 *       全角=1.0unit / 半角=0.5unit の重みで maxUnits で切る。
 *  fix30-B: maxUnits 6 → 5 に下げる。 6units = ~48px は cell width 44px を超えて
 *       隣セルに侵入する (画像目視で「いけちゃ」「ル特化」等の overflow を確認)。
 *       5units = ~40px なら確実に cell 内に収まる。
 *  日付行 (lines[0]) には適用しないこと (Phase 4 の 19pt 選択が1行目=日付前提のため)。
 */
function wrapLineForCell(line, maxUnits = 5) {
  const isHalfWidth = (c) => /[\x00-\x7F｡-ￜ￨-￮]/.test(c);
  const segments = [];
  let current = '';
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

async function writeCell(page, pos, day, cells = null) {
  const lines = day.lines;

  // === Phase 1: 編集モードに入る試行 ===
  const enter = await enterTextEditAtCell(page, pos, { cells });
  if (!enter.ok) {
    // ★重要: 編集モードに入れないまま Meta+A → typing → trySetFontSize を実行すると、
    //   Canva の全テキスト要素を選択して 19pt に変更 → 全 placeholder が巨大化 する
    //   暴走事故が発生する (2026-05-17 セッションのスクショ症状)。
    //   よって編集モード未突入のセルは **完全スキップ** する。
    console.log(`      ❌ ${day.date}日 編集モード突入失敗 → スキップ (テキスト書込み無し / 暴走防止)`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    return { ok: false, reason: "edit mode entry failed" };
  }
  if (enter.where !== "center") {
    console.log(`      [edit] ${day.date}日 編集モード突入: ${enter.where}`);
  }
  // Phase 4 で再クリックする時、center が矩形に取られる場合に備え、
  // Phase 1 で成功した位置を再利用する
  const clickPos = { x: enter.x, y: enter.y };
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(200);

  // === Phase 2: 全行を入力 (cell 幅に収まるよう自動改行) ===
  //   - lines[0] (日付) は分割しない: Phase 4 の Shift+Cmd+→ で1行目=日付を選択して
  //     19pt に上書きする前提。日付を改行すると 19pt が「1\n0」のように1の数字部分にしか
  //     かからない暴走になるため絶対に分割不可。
  //   - lines[1..] (内容) は wrapLineForCell で全角6unit ごとに改行 → 隣セル overflow 防止。
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(80);
    }
    const segments = i === 0 ? [lines[i]] : wrapLineForCell(lines[i]);
    for (let s = 0; s < segments.length; s++) {
      if (s > 0) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(50);
      }
      await page.keyboard.type(segments[s], { delay: 25 });
    }
  }
  await page.waitForTimeout(400);

  // === Phase 3: 修正8 ─ 全選択 → 7pt (まず全部小さく) ===
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(200);

  // 初日(1日)はツールバーのフォント関連UIをダンプして可視化
  if (day.date === 1) {
    const controls = await dumpFontControls(page);
    console.log(`     [debug] フォント関連input一覧:`);
    if (controls.length === 0) {
      console.log(`        (該当input無し → トレーラーを再描画してから検索が必要かも)`);
    } else {
      controls.forEach((c) =>
        console.log(`        - aria="${c.label}" testid="${c.testid}" value="${c.value}" visible=${c.visible}`)
      );
    }
  }

  const r7 = await trySetFontSize(page, 7);
  await page.waitForTimeout(400);

  // === Phase 4: 1行目(日付)を選択 → 19pt に上書き ===
  // ★重要修正: trySetFontSize(7) 中に Canva が再描画して cream矩形が復活している
  //   可能性が高い。Phase 4 クリック前に必ず再 hide。
  //   さらに、clickPos を Phase 1 成功位置のままにすると、 7pt で text が縮んで
  //   bbox が変わっているため位置ズレ → re-enter 失敗 → Cmd+A が全要素選択 →
  //   19pt が全 placeholder に適用される暴走が起きる (rows 0, 4, 5 の症状)。
  //   再 hide + 再度 enterTextEditAtCell で安全に再入域する。
  if (cells) {
    try { await hideAssignedRects(page, cells); } catch {}
  }
  const reenter = await enterTextEditAtCell(page, pos, { cells });
  if (!reenter.ok) {
    // 再入域失敗時は 19pt 設定をスキップ (全文 7pt のまま完了)
    // 暴走防止のため絶対に Cmd+A を打たない
    console.log(`      ⚠️ ${day.date}日 Phase4 再入域失敗 → 19pt スキップ (全文 7pt のまま)`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    return { ok: true, where: enter.where, font19skipped: true };
  }

  // 確実に先頭にカーソルを置く: Cmd+A → ← で「全選択 → 選択解除して開始位置」
  await page.keyboard.press(`${MOD}+A`);
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(150);

  // ★fix31-A: 1行目(日付)選択を Shift+ArrowRight × 文字数 に変更。
  //   旧: Shift+Meta+ArrowRight (Mac の「行末まで」) は Canva text editor では
  //   実装が独自で、 結果として全テキストが選択され 19pt が body 全体に適用される
  //   事故が観測された (実機画像で body も 16-18px ≈ 14-19pt サイズで表示)。
  //   日付は必ず 1〜2 桁 (1〜31) なので、 文字数分だけ Shift+→ で確実に選択する。
  const dateStr = String(day.date);
  for (let k = 0; k < dateStr.length; k++) {
    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(180);

  const r19 = await trySetFontSize(page, 19);
  await page.waitForTimeout(400);

  // 1セル目のみ詳細ログ (毎セル出すとうるさいので)
  if (day.date === 1 || !r7.ok || !r19.ok) {
    console.log(`     [font] 7pt=${JSON.stringify(r7)}  19pt=${JSON.stringify(r19)}`);
  }

  // === Phase 5: 編集モードを抜ける ===
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  return { ok: true, where: enter.where };
}

/**
 * 全ドキュメント内に残っている「段落テキスト」placeholder の総数を返す。
 *  Why: 位置ベース検証 (inspectPlaceholderResidue) は cell.top 座標が
 *       実 placeholder と微妙にズレている場合に false positive/negative を
 *       起こす。1日のように「verification は通ったが実際は空のまま」だった
 *       事例を確実に検出するため、全体カウントの差分で書込み成否を判定する。
 *  fix10: 書込み前後で差分=1 なら成功、差分=0 なら失敗 (placeholder未消費)。
 */
async function countPlaceholders(page) {
  return await page.evaluate(() => {
    let count = 0;
    const all = document.querySelectorAll("*");
    for (const el of all) {
      if (el.children.length !== 0) continue;
      const txt = (el.textContent || "").trim();
      if (txt === "段落テキスト") count++;
    }
    return count;
  });
}

/**
 * 指定座標近傍に実在する「段落テキスト」placeholder要素の中心座標を返す。
 *  Why: cells[r][c].top.x/y は初期検出時の placeholder 座標 だが、Canva の
 *       再描画で実 placeholder 要素が数 px ズレることがある。書込み直前に
 *       実位置を再取得することで「クリック先が空白に当たる」事故を防ぐ。
 *  fix10: 8日 などで 8px のズレを観測 → 実位置クリックに変更で改善期待。
 */
async function findPlaceholderNear(page, x, y, maxDist = 25) {
  return await page.evaluate(({ tx, ty, max }) => {
    let best = null;
    let bestDist = Infinity;
    const all = document.querySelectorAll("*");
    for (const el of all) {
      if (el.children.length !== 0) continue;
      const txt = (el.textContent || "").trim();
      if (txt !== "段落テキスト") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const dx = cx - tx;
      const dy = cy - ty;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > max) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = {
          x: cx, y: cy, w: r.width, h: r.height,
          left: r.x, top: r.y,
          right: r.x + r.width, bottom: r.y + r.height,
          dist,
        };
      }
    }
    return best;
  }, { tx: x, ty: y, max: maxDist });
}

/**
 * cell.top 近傍で「段落テキスト」がまだ残っている placeholder 要素を検索。
 *  Why: 旧 verification は elementsFromPoint(cell.top.x, cell.top.y) の
 *       stack の中で最初に非空テキストを持つ要素で判定していたが、
 *       書込み後は新テキスト要素が同じ位置に重なるため誤判定があった。
 *       新方式: 「textContent==='段落テキスト' かつ children.length===0」の
 *       要素を全走査し、cell.top の近傍 (15px 以内) にいるか確認する。
 *  fix8: NEAR_PX を 40 → 15 に縮小。cell 幅 44px の中で隣セル中心は
 *       dist~39-44px に出るので、40px では隣セル placeholder を「自分の残存」
 *       と誤判定してリトライ暴走していた (17,19,21,24,26,29,31日 全部 false positive)。
 *       placeholder 本体サイズが 33×8px なので、中心±15px なら確実に自分自身。
 *  fix21: NEAR_PX を 15 → 22 に緩和。 24-26日が ph_TR (cell.top.x+12付近) で
 *       edit 突入後、 dist=14px の placeholder が残存して 3回リトライ全失敗
 *       していた症状を解消。 隣セル中心は 44px 先なので 22px なら安全マージン。
 *  返り値: { stillPlaceholder: bool, near: bool, x?, y?, dist? }
 */
async function inspectPlaceholderResidue(page, cellTop) {
  return await page.evaluate(({ tx, ty }) => {
    const NEEDLE = "段落テキスト";
    const NEAR_PX = 22;
    const found = [];
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const text = (el.textContent || "").trim();
      if (text !== NEEDLE) continue;
      if (el.children.length !== 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const dx = cx - tx;
      const dy = cy - ty;
      const dist = Math.sqrt(dx * dx + dy * dy);
      found.push({ x: cx, y: cy, dist });
    }
    if (found.length === 0) return { stillPlaceholder: false, near: false };
    found.sort((a, b) => a.dist - b.dist);
    const nearest = found[0];
    return {
      stillPlaceholder: true,
      near: nearest.dist <= NEAR_PX,
      x: nearest.x,
      y: nearest.y,
      dist: nearest.dist,
    };
  }, { tx: cellTop.x, ty: cellTop.y });
}

// ★fix26: グローバル canvas pan を median-based で検出
//   Pass 2 中盤 (24日付近) で Canva canvas が累積 pan して stored cell.top が
//   ~20px ズレる現象が複数回観測された。 単一 nearest placeholder (fix23) は
//   隣セル誤掴み (44px間隔) で暴走するため不採用。代わりに残 placeholder 全部の
//   (dx, dy) shift を median で集約 → 外れ値除去 + 多数決で確実な pan 推定。
//   リトライ時のみ呼んで通常コスト無し。
async function detectCanvasPan(page, cells) {
  let currentPhs;
  try {
    currentPhs = await findPlaceholders(page);
  } catch {
    return null;
  }
  if (currentPhs.length < 3) return null;

  const shifts = [];
  for (const ph of currentPhs) {
    // stored cell.top のうち最も近いものを採用
    let bestDx = 0, bestDy = 0, bestDist = Infinity;
    for (const row of cells) {
      for (const cell of row) {
        if (!cell || !cell.top) continue;
        const dx = ph.x - cell.top.x;
        const dy = ph.y - cell.top.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
    // 30px 以内 = 同セル placeholder と判定。 隣セル (44px間隔) は弾かれる。
    if (bestDist <= 30) {
      shifts.push({ dx: bestDx, dy: bestDy });
    }
  }

  if (shifts.length < 3) return null;

  // median dx, dy (外れ値除去)
  const sortedDx = shifts.map((s) => s.dx).sort((a, b) => a - b);
  const sortedDy = shifts.map((s) => s.dy).sort((a, b) => a - b);
  const dx = sortedDx[Math.floor(sortedDx.length / 2)];
  const dy = sortedDy[Math.floor(sortedDy.length / 2)];
  return { dx, dy, count: shifts.length };
}

// バージョンマーカー (新コード実行確認用)
const SCRIPT_VERSION = "v2026-05-26-fix41-B (rect部分配置(<30個)時hide skip + diag log抑制 + 初回pan補正 + sortedPh等分割)";

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`▶️ 開始 ${startedAt}`);
  console.log(`🔖 ${SCRIPT_VERSION}`);

  const { year, month } = getTargetMonth();
  const override = getPageOverride();
  const pageNumber = override ?? calculatePageNumber(year, month);
  const pageNote = override ? ` ※ --page=${override} で上書き` : "";
  console.log(`📅 ターゲット: ${year}年${month}月 (Canva ${pageNumber}ページ目)${pageNote}`);

  let context = null;
  let exitCode = 1;

  try {
    console.log("📥 カレンダー読込み...");
    const days = await fetchData(year, month);
    if (days.length === 0) {
      throw new Error(`${year}/${month} のデータが0件です`);
    }
    console.log(`   ${days.length}日分取得`);

    // Web UI (webServer.js) とプロファイルを共有すると Chromium のロックが衝突するため、
    // 自動実行は専用プロファイルを使う。
    //   Mac: 初回のみ本体からログイン情報を複製する。
    //   AWS: コンテナは毎回まっさらなので、 起動後に S3 のログイン状態 (Cookie) を流し込む。
    let userDataDir;
    if (cloud.sessionEnabled()) {
      userDataDir = process.env.CANVA_PROFILE_DIR
        ? process.env.CANVA_PROFILE_DIR + "-scheduled"
        : path.join(os.tmpdir(), "canva-profile-scheduled");
      fs.mkdirSync(userDataDir, { recursive: true });
      console.log(`☁️ AWSモード: プロファイル ${userDataDir}`);
    } else {
      const prepared = prepareScheduledProfile({
        baseDir: path.join(__dirname, ".."),
        mainProfile: config.canva.userDataDir,
        scheduledProfile: config.canva.userDataDirScheduled,
      });
      userDataDir = prepared.dir;
      if (prepared.seeded) {
        console.log(`📋 自動実行用プロファイルを新規作成しました: ${path.basename(userDataDir)}`);
      }
    }
    // 前回の残骸 (死んだプロセスのロック) は片付けてから起動する。
    if (clearStaleLock(userDataDir)) {
      console.log("🧹 前回の残骸 (ロックファイル) を掃除しました");
    }

    const launchBrowser = () =>
      chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: null,
        args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });

    console.log("🚀 Chromium起動...");
    try {
      context = await launchBrowser();
    } catch (e) {
      if (!isProfileInUseError(e)) throw e;
      // 無人実行なので、 掴んだままのプロセスを終了させて自力で復帰する。
      console.log("⚠️ プロファイルが使用中。 該当プロセスを終了して再試行します...");
      const { killed } = releaseProfile(userDataDir);
      console.log(`🧹 ${killed.length}個のプロセスを終了しました`);
      context = await launchBrowser();
    }

    if (cloud.sessionEnabled()) {
      const saved = await cloud.loadSessionState();
      if (!cloud.hasCanvaLogin(saved)) {
        throw new Error(
          "S3 に Canva のログイン状態がありません。 Web UI の「🔑 Canvaログイン」でログインして保存してください",
        );
      }
      const applied = await cloud.applySessionToContext(context, saved);
      console.log(`☁️ S3 のログイン状態を復元 (Cookie ${applied.cookies}件)`);
    }

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.canva.designUrl, { waitUntil: "domcontentloaded" });
    console.log("⏳ Canva初期描画待機...");
    await page.waitForTimeout(8000);
    if (/\/login/.test(page.url())) {
      throw new Error(
        "Canva のログインが切れています (ログイン画面に飛ばされました)。 Web UI の「🔑 Canvaログイン」でログインし直して保存してください",
      );
    }

    // ★fix36-A: --page=N が指定された場合は manual mode でも必ず自動ページ遷移
    //   理由: 過去に「P33 指定 → 実際は P32 (5月) に書込み」 という事故があった。
    //   --page を明示するときは「そのページに書込む」 ことが意図なので、
    //   ユーザーの現在表示と乖離していると致命的。 自動移動でズレを根絶。
    if (override) {
      console.log("");
      console.log(`📑 --page=${pageNumber} 指定: 自動でページ${pageNumber}に移動します`);
      console.log("   ※ Canva を最大化して、 移動完了まで他の操作をしないでください");
      if (isManualMode()) {
        await waitForEnter("✅ 準備できたら Enter キーを押してください (ページ遷移を開始します)... ");
      }
      console.log("");
      await navigateToPage(page, pageNumber);
    } else if (isManualMode()) {
      console.log("");
      console.log("👀 手動モード");
      console.log(`📑 ブラウザのCanvaを書き込みたいページに移動してください`);
      console.log(`   (今回の対象月の推奨ページ: ${pageNumber}ページ目)`);
      console.log("   ※ ページ全体が画面に収まるよう調整推奨");
      console.log("");
      await waitForEnter("✅ 準備できたら Enter キーを押してください... ");
      console.log("");
    } else {
      // --auto 指定時 (page 未指定): 計算したページ番号で自動遷移
      await navigateToPage(page, pageNumber);
    }

    console.log("🔍 段落テキスト要素を待機...");
    const placeholders = await waitForPlaceholders(page, EXPECTED_PLACEHOLDERS_NEW);
    console.log(`   検出: ${placeholders.length}個`);

    // テンプレ判定: 126=新テンプレ(3プレースホルダー/マス), 42=旧テンプレ
    let cells = null;
    let templateMode = null;
    if (placeholders.length === EXPECTED_PLACEHOLDERS_NEW) {
      templateMode = "new";
      cells = groupIntoCells(placeholders);
      console.log(`   モード: 新テンプレ (1マス3プレースホルダー、色付き対応)`);
    } else if (placeholders.length === EXPECTED_PLACEHOLDERS_LEGACY) {
      templateMode = "legacy";
      // 旧テンプレ: 1次元配列 → 各セル top のみ
      // row-major 確定のため Y/X ソート (findPlaceholders は既にソート済みだが念のため)
      const sortedPh = [...placeholders].sort((a, b) => {
        if (Math.abs(a.y - b.y) < 30) return a.x - b.x;
        return a.y - b.y;
      });
      cells = [];
      for (let r = 0; r < 6; r++) {
        const row = [];
        for (let c = 0; c < 7; c++) {
          row.push({ top: sortedPh[r * COLS + c], middle: null, bottom: null });
        }
        cells.push(row);
      }
      console.log(`   モード: 旧テンプレ (1マス1プレースホルダー)`);
    } else {
      throw new Error(
        `段落テキストが${placeholders.length}個検出されました(期待: 42 or 126)。\n` +
          `Canva側で対象ページが画面いっぱいに表示されているか確認`
      );
    }

    // ★fix36-B: 色付けポリシーをデフォルト OFF に変更 (テキストのみが基本動作)
    //   将来「色付けも欲しい」 と言われた時は --with-color フラグで復活できる。
    //   --no-color は後方互換のため受付続行 (no-op)。
    //   旧仕様 (色付けON が default): --no-color で明示的に OFF
    //   新仕様 (色付けOFF が default): --with-color で明示的に ON
    const enableColors = process.argv.includes("--with-color");
    const colorOptOut = process.argv.includes("--no-color");  // 後方互換のため受付
    if (colorOptOut && !enableColors) {
      // 旧フラグ通りに OFF (default と同じ)
    }

    let legacyHasRects = false;
    if (enableColors && templateMode === "legacy") {
      // cream矩形検出は色付け ON 時のみ実行 (text-only モードでは不要)
      const rectShapes = await findFilledRectShapes(page);
      const phYs = placeholders.map((p) => p.y);
      const yMin = Math.min(...phYs) - 100;
      const yMax = Math.max(...phYs) + 100;
      const inPage = rectShapes.filter((r) => r.y >= yMin && r.y <= yMax);
      const assigned = attachRectsToCells(cells, inPage);
      legacyHasRects = assigned >= 30;
      console.log(`   cream矩形検出: ${inPage.length}個 / セル割当: ${assigned}/42 → ${legacyHasRects ? "色付けON" : "色付けOFF"}`);
    }

    const useColors = enableColors && (templateMode === "new" || legacyHasRects);
    if (!enableColors) {
      console.log(`   色付け: OFF (text-only モード / --with-color で有効化)`);
    } else if (templateMode === "legacy" && !legacyHasRects) {
      console.log(`   色付け: 自動スキップ (cream矩形未配置 / 手動着色用色マップは下記)`);
    } else {
      console.log(`   色付け: ON (${templateMode}${legacyHasRects ? " + 矩形配置済" : ""})`);
    }

    // 色マップを冒頭にダンプ (色付け ON 時のフォールバック用に表示)
    if (enableColors) {
      console.log("");
      console.log("🎨 色マップ (自動着色失敗時はこれを参照して手動で着色してください):");
      for (const day of days) {
        const bands = day.colorBands || [];
        if (bands.length === 0) continue;
        const desc = bands.map((b) => {
          if (b.kind === "solid") return `${b.label}=${b.color}`;
          if (b.kind === "gradient") return `${b.label}=${b.colors.join("→")}`;
          return b.label;
        }).join(" / ");
        console.log(`   ${String(day.date).padStart(2)}日(${day.weekday}): ${desc}`);
      }
      console.log("");
    }

    // 各日の cell を準備
    const dayCellMap = [];
    for (const day of days) {
      const { row, col } = toRowCol(year, month, day.date);
      const cell = cells[row]?.[col];
      if (!cell || !cell.top) {
        console.log(`   ⚠️ ${day.date}日: row=${row} col=${col} のセル見つからず(skip)`);
        continue;
      }
      dayCellMap.push({ day, cell });
    }

    // ─── Pass 1: 全日色付け (cream矩形がまだ無傷の状態で実行) ───
    // Why 順序逆転: テキスト書込みを先にやると、Cmd+A や typing 操作で cream矩形が
    //   動いたり消えたりして、その後の cell.rect 座標が SPAN/P/DIV (テキスト要素)
    //   になってしまっていた。色付けを先にやれば、矩形は無傷の最初の状態でクリック
    //   できる。色付け後 → テキスト書込みでテキストが矩形の上に乗る形になる。
    if (useColors) {
      // Pass 1 開始直前の事前診断: cells[0][5] (= 5/1 FRI) の cell.rect 座標で
      // 何が elementsFromPoint で取れるかを出す (cream矩形がそこに本当にいるか確認)
      if (templateMode === "legacy") {
        try {
          const firstRect = cells[0]?.[5]?.rect;
          if (firstRect) {
            const diag = await page.evaluate(({ x, y, w, h }) => {
              const els = document.elementsFromPoint(x, y);
              return els.slice(0, 6).map((e) => {
                const r = e.getBoundingClientRect();
                let bg = '';
                try { bg = window.getComputedStyle(e).backgroundColor || ''; } catch {}
                return `<${e.tagName} w=${Math.round(r.width)} h=${Math.round(r.height)} bg=${bg.slice(0, 25)}>`;
              }).join(' / ');
            }, firstRect);
            console.log(`   [pre-diag] cells[0][5].rect=(${firstRect.x.toFixed(0)},${firstRect.y.toFixed(0)} ${firstRect.w.toFixed(0)}×${firstRect.h.toFixed(0)}) stack: ${diag}`);
          }
        } catch {}
      }
      console.log(`🎨 Pass 1: ${dayCellMap.length}日分の色付け開始`);
      let colorAutoDisabled = false;
      let firstDaySucceeded = false;
      let firstDayAttempted = 0;

      // 各セル処理前の rect 再検出間隔 (毎セルだと重いので5セルごと)
      const RECT_REFRESH_EVERY = 5;
      let rectRefreshCounter = 0;

      for (const { day, cell } of dayCellMap) {
        if (colorAutoDisabled) break;

        // 定期的に cream矩形を再検出して cells に再割当 (キャンバス pan 対策)
        if (rectRefreshCounter % RECT_REFRESH_EVERY === 0 && templateMode === "legacy") {
          try {
            const refreshed = await findFilledRectShapes(page);
            const refreshedPhNow = await findPlaceholders(page);
            if (refreshedPhNow.length === EXPECTED_PLACEHOLDERS_LEGACY) {
              const phYs = refreshedPhNow.map((p) => p.y);
              const yMin = Math.min(...phYs) - 100;
              const yMax = Math.max(...phYs) + 100;
              const inPage = refreshed.filter((rs) => rs.y >= yMin && rs.y <= yMax);
              attachRectsToCells(cells, inPage);
            }
          } catch {}
        }
        rectRefreshCounter++;

        const slots = [cell.top, cell.middle, cell.bottom];
        const bands = day.colorBands || [];

        // バンド配分
        let slotBands = [];
        if (templateMode === "legacy") {
          slotBands = [bands[0], null, null];
        } else if (bands.length === 1) {
          slotBands = [bands[0], bands[0], bands[0]];
        } else if (bands.length === 2) {
          slotBands = [bands[0], bands[0], bands[1]];
        } else {
          slotBands = [bands[0], bands[1], bands[2]];
        }

        let attempted = 0;
        let succeeded = 0;
        let dayHadFailure = false;
        for (let bi = 0; bi < 3; bi++) {
          const slot = slots[bi];
          const band = slotBands[bi];
          if (!slot || !band) continue;
          const hex = band.kind === "solid" ? band.color
                     : band.kind === "gradient" ? band.colors[0]
                     : null;
          if (!hex) continue;

          // 初回 (1日 band1) のみ診断モード
          const isFirst = day.date === 1 && bi === 0;
          const r = await setShapeFillColor(page, slot, hex, cell, { diagnose: isFirst });
          const slotName = ["top", "middle", "bottom"][bi];
          attempted++;
          if (day.date === 1) firstDayAttempted++;
          if (!r.ok) {
            dayHadFailure = true;
            console.log(`      ⚠️ ${day.date}日 色設定失敗 [${slotName} ${band.label}=${hex}]: ${r.reason}`);
            if (r.diag) console.log(`         [diag] ${r.diag}`);
          } else {
            succeeded++;
            if (day.date === 1) firstDaySucceeded = true;
            if (isFirst && r.typedValue !== undefined) {
              console.log(`      ✅ ${day.date}日 ${slotName} 適用: 期待=${hex} 実値=${r.typedValue}`);
            }
          }
        }

        // 全日の進捗ログを必ず出す (静かに進めると沈黙失敗が見えなくなる)
        const mark = dayHadFailure ? "⚠️" : (succeeded > 0 ? "✓" : "・");
        console.log(`      ${mark} ${day.date}日(${day.weekday}) 色付け ${succeeded}/${attempted}`);

        // 1日目で全失敗 → このテンプレでは色付け不可として残りスキップ
        if (day.date === 1 && firstDayAttempted > 0 && !firstDaySucceeded) {
          colorAutoDisabled = true;
          console.log("");
          console.log("   ⚠️ 1日目の全色付けが失敗しました。このテンプレには");
          console.log("      塗りつぶし可能シェイプが無いと判定。残り全日の自動着色をスキップします。");
          console.log("      → 冒頭の🎨色マップを参照してCanva上で手動着色してください。");
          console.log("");
        }
      }
      // Pass 1 完了後、Canva の選択状態とサイドパネルを完全クリア
      //   fix13: (50,50) クリックは Canva 左サイドバーを開いて canvas を pan
      //   させる致命的副作用が判明したため撤回。Escape 連打 + DOM blur で対処。
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(150);
      }
      await page.evaluate(() => {
        try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
      });
      await page.waitForTimeout(600);
      console.log("✅ Pass 1: 色付け完了 (UI状態リセット済)");
    }

    // ─── Pass 2 直前: placeholder 座標を再検出 ───
    // Why: Pass 1 の色付け処理 (多数のクリック+Escape+サイドパネル開閉) で
    //   Canva のキャンバス表示が pan/zoom してしまい、初回検出時の cell.top.x,y が
    //   現在の placeholder の実位置と乖離する。古い座標で書き込むと別セルや表頭領域
    //   に書き込まれる事故が発生する (5/31の text が SUN列row0 に書かれた等)。
    // 対策: Pass 2 開始直前に再検出し、cell.top を最新座標に更新する。
    console.log(`🔄 Pass 2 直前: placeholder 座標を再検出...`);
    const refreshedPh = await findPlaceholders(page);
    console.log(`   検出: ${refreshedPh.length}個 (Pass 1 開始時: ${placeholders.length}個)`);

    if (refreshedPh.length === placeholders.length) {
      let maxYShift = 0;
      let maxXShift = 0;
      if (templateMode === "legacy") {
        // ★fix41-B: 旧テンプレ 42個 = 6行×7列 確定 → 「Y軸ソート → 7個ずつ 6行に等分割」 方式
        //   旧ロジックの Y近接30pxルールは、 ズーム条件 (行間 < 30px) で破綻する可能性。
        //   等分割なら placeholder の Y バラツキに関係なく確実に 6行×7列 に分けられる。
        //   さらに max X shift も計測してログ出力 → X軸 pan も気付ける。
        const sortedByY = [...refreshedPh].sort((a, b) => a.y - b.y);
        const rows = [];
        for (let r = 0; r < 6; r++) {
          const rowPhs = sortedByY.slice(r * 7, (r + 1) * 7);
          rowPhs.sort((a, b) => a.x - b.x);
          rows.push(rowPhs);
        }
        // 行内Y範囲 (デバッグ) — 各行のYバラツキが小さければ等分割は妥当
        const rowYRanges = rows.map((row) => {
          const ys = row.map((p) => p.y);
          return Math.max(...ys) - Math.min(...ys);
        });
        const maxRowYRange = Math.max(...rowYRanges);
        if (maxRowYRange > 50) {
          console.log(`   ⚠️ 行内Yバラツキが大きい (max=${maxRowYRange.toFixed(0)}px) — テンプレが歪んでいる可能性`);
        }
        for (let r = 0; r < 6; r++) {
          for (let c = 0; c < 7; c++) {
            const oldTop = cells[r][c].top;
            const newTop = rows[r][c];
            if (oldTop && newTop) {
              const dy = Math.abs(oldTop.y - newTop.y);
              const dx = Math.abs(oldTop.x - newTop.x);
              if (dy > maxYShift) maxYShift = dy;
              if (dx > maxXShift) maxXShift = dx;
              cells[r][c].top = newTop;
            }
          }
        }
      } else if (templateMode === "new") {
        // 新テンプレ: 126個 → groupIntoCells で再構築
        try {
          const newCells = groupIntoCells(refreshedPh);
          for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 7; c++) {
              const oldTop = cells[r][c].top;
              const newTop = newCells[r][c].top;
              if (oldTop && newTop) {
                const dy = Math.abs(oldTop.y - newTop.y);
                if (dy > maxYShift) maxYShift = dy;
              }
              cells[r][c].top = newCells[r][c].top;
              cells[r][c].middle = newCells[r][c].middle;
              cells[r][c].bottom = newCells[r][c].bottom;
            }
          }
        } catch (e) {
          console.log(`   ⚠️ 再構築失敗: ${e.message} → 古い座標で続行`);
        }
      }
      if (maxYShift > 30 || maxXShift > 30) {
        console.log(`   ⚠️ 座標が最大 X=${maxXShift.toFixed(0)}px Y=${maxYShift.toFixed(0)}px ズレていました → 最新座標に更新済`);
      } else {
        console.log(`   ✓ 大きなズレ無し (max X shift = ${maxXShift.toFixed(0)}px / max Y shift = ${maxYShift.toFixed(0)}px)`);
      }
    } else {
      console.log(`   ⚠️ placeholder数が変化 (${placeholders.length}→${refreshedPh.length}) → 古い座標で続行`);
    }

    // ★fix35-B / fix37 / fix40: Pass 2 直前 canvas 健全性チェック (fix26 = 31/31 成功時の値で校正)
    //   過去ベスト到達時 (fix26): placeholder bbox = 294×448px
    //   fix35 (緩い閾値 250×300): bbox 269×320 でも通過したが書込み失敗多発
    //   fix37: 閾値を 280×400 に引き上げ、 fix26 と同等の zoom レベルを要求
    //   ★fix40: abort 閾値を緩和 (致命的のみ 220×320 abort)、 280×400 未満は警告のみ続行
    //           fix40 fallback (cream矩形不要モード) があるので、 ある程度小さい canvas でも
    //           overlay 透過化が機能すれば書込み可能。 abort で実行不可になるより警告で試す方が良い。
    if (refreshedPh.length > 0) {
      const xs = refreshedPh.map((p) => p.x);
      const ys = refreshedPh.map((p) => p.y);
      const xSpan = Math.max(...xs) - Math.min(...xs);
      const ySpan = Math.max(...ys) - Math.min(...ys);
      const ABORT_W = 220;  // ★fix40: 致命的閾値 (これ未満なら abort)
      const ABORT_H = 320;
      const WARN_W = 280;   // 警告閾値 (これ未満なら警告だが続行)
      const WARN_H = 400;
      const IDEAL_W = 290;  // 理想閾値 (fix26 同条件)
      const IDEAL_H = 420;
      console.log(`   [health] placeholder bbox: 幅=${xSpan.toFixed(0)}px 高=${ySpan.toFixed(0)}px (理想: 幅≧${IDEAL_W} 高≧${IDEAL_H})`);
      console.log(`            ※ 過去 31/31 全成功時の実測値 = 幅 294px 高 448px`);
      if (xSpan < ABORT_W || ySpan < ABORT_H) {
        console.log("");
        console.log(`   🚨 Canva canvas のズームが致命的に小さすぎます (bbox ${xSpan.toFixed(0)}×${ySpan.toFixed(0)} < ${ABORT_W}×${ABORT_H})`);
        console.log(`      これでは大半のセル書込みが失敗します。`);
        console.log("");
        console.log(`   📋 対処手順 (Canva ブラウザで操作してください):`);
        console.log(`      1) Cmd+Z を 50-100回 連打 → 破壊された P33 を初期化`);
        console.log(`      2) ブラウザウィンドウを 緑ボタンで フルスクリーン化`);
        console.log(`      3) Canva 内で Cmd++ (Cmd と +) を 2〜3回 押す → ズームイン`);
        console.log(`      4) カレンダー ページが画面ぎりぎりに大きく収まるよう調整`);
        console.log(`      5) スクリプト再実行 (同じコマンドで OK)`);
        console.log("");
        console.log(`   💡 Hint: bbox 290px×420px 以上 になれば理想 (fix26 と同条件)`);
        throw new Error(`canvas ズーム致命的不足: bbox ${xSpan.toFixed(0)}×${ySpan.toFixed(0)} (致命的閾値 ${ABORT_W}×${ABORT_H}) — Pass 2 中止。`);
      } else if (xSpan < WARN_W || ySpan < WARN_H) {
        console.log(`   ⚠️ canvas 健全性: 小さめ (推奨は 幅≧${WARN_W} 高≧${WARN_H} / 理想 幅≧${IDEAL_W} 高≧${IDEAL_H})`);
        console.log(`      → fix40 fallback で続行を試みます。 書込み失敗が増える可能性あり。`);
        console.log(`      → 結果が悪ければ Canva で Cmd++ で 2-3回ズームインしてから再実行を推奨。`);
      } else if (xSpan < IDEAL_W || ySpan < IDEAL_H) {
        console.log(`   ⚠️ canvas 健全性: ぎりぎり許容範囲 (理想は 幅≧${IDEAL_W} 高≧${IDEAL_H})`);
      } else {
        console.log(`   ✓ canvas 健全性: 良好 (fix26 同等以上)`);
      }
    }

    // ★fix41-A: 初回 pan 補正 — Pass 2 開始時に detectCanvasPan を呼んで cells 全体に適用
    //   Why: 従来は リトライ時のみ pan 補正を実行 → 1日目で初回失敗が多発する原因。
    //        Pass 1 終了時 (色付け処理 / Escape 等) で canvas が累積 pan しており、
    //        Pass 2 直前 refresh で cell.top.x,y は更新されているが、 全 cells に
    //        一括補正は行われていない。 1日目 (リトライ前) は補正なしで失敗確実。
    //   対策: Pass 2 開始時に 1回 detectCanvasPan を呼び、 cells 全体に補正適用。
    //        これで 1日目から正しい座標で書込み可能。
    try {
      const initialPan = await detectCanvasPan(page, cells);
      if (initialPan && (Math.abs(initialPan.dx) > 3 || Math.abs(initialPan.dy) > 3)) {
        if (Math.abs(initialPan.dx) > 30 || Math.abs(initialPan.dy) > 30) {
          console.log(`   ⚠️ [init-pan] 異常な pan 検出 dx=${initialPan.dx.toFixed(0)} dy=${initialPan.dy.toFixed(0)} samples=${initialPan.count} — 補正 SKIP (canvas 環境不安定)`);
        } else {
          console.log(`   🔧 [init-pan] dx=${initialPan.dx.toFixed(0)} dy=${initialPan.dy.toFixed(0)} samples=${initialPan.count} — 全 cells に補正適用`);
          let applied = 0;
          for (const row of cells) {
            for (const cell of row) {
              if (cell && cell.top) {
                cell.top.x += initialPan.dx;
                cell.top.y += initialPan.dy;
                if (cell.top.left != null) cell.top.left += initialPan.dx;
                if (cell.top.right != null) cell.top.right += initialPan.dx;
                if (cell.top.top != null) cell.top.top += initialPan.dy;
                if (cell.top.bottom != null) cell.top.bottom += initialPan.dy;
                applied++;
              }
            }
          }
          console.log(`             ${applied}個の cell.top を更新`);
        }
      } else if (initialPan) {
        console.log(`   ✓ [init-pan] pan 微小 dx=${initialPan.dx.toFixed(0)} dy=${initialPan.dy.toFixed(0)} samples=${initialPan.count} — 補正不要`);
      }
    } catch (e) {
      console.log(`   ⚠️ [init-pan] 検出失敗: ${e.message}`);
    }

    // ─── Pass 2 直前: cream矩形 座標も再検出 ───
    // Why: Pass 1 中にキャンバスが pan して矩形位置も変動している可能性がある。
    //   cell.rect は Pass 1 中5セルごとに refresh しているが、最後の更新から
    //   数日経過した状態で Pass 2 に入る可能性があるため、ここで最新化する。
    if (useColors && templateMode === "legacy") {
      try {
        const freshRects = await findFilledRectShapes(page);
        const phYs = refreshedPh.map((p) => p.y);
        const yMin = Math.min(...phYs) - 100;
        const yMax = Math.max(...phYs) + 100;
        const inPage = freshRects.filter((rs) => rs.y >= yMin && rs.y <= yMax);
        const reassigned = attachRectsToCells(cells, inPage);
        console.log(`🔄 Pass 2 直前: rect 再検出 ${inPage.length}個 / 再割当 ${reassigned}/42`);
      } catch (e) {
        console.log(`   ⚠️ rect 再検出失敗: ${e.message}`);
      }
    }

    // ─── Pass 2: 全日テキスト書込み ───
    // cream矩形 + Canvaのクリックオーバーレイ (同サイズ・同位置の透明DIV) を透過化
    let hideStats = { count: 0, overlayCount: 0, rectCount: 0 };
    try {
      hideStats = await hideAssignedRects(page, cells);
      if (hideStats.skippedDueToPartial) {
        // ★fix41: 部分配置時の hide スキップ (rectCount < 30 で hide が逆効果なケース)
        console.log(`🫥 [fix41 skip] 部分配置 rect ${hideStats.rectCount}個 (<30) → hide スキップ (内部 layout 破壊回避 / fix38 同等動作)`);
        console.log(`   ℹ️ 全 42 セルに cream rect が配置されていません。 hide すると Pass 2 全失敗する症状を回避します。`);
      } else if (hideStats.fallback) {
        // ★fix40: cream矩形 0個 fallback (3点プローブ + 緩いフィルタ + 半透明検知)
        console.log(`🫥 [fix40 fallback] 透過化 ${hideStats.count}個 (cream矩形無 / overlay ${hideStats.overlayCount})`);
        if (hideStats.count === 0) {
          console.log(`   ℹ️ overlay 0個 = このテンプレに per-cell overlay は存在しないため fallback hide 不要。`);
        } else {
          console.log(`   ✓ overlay ${hideStats.count}個 透過化成功 (fix40 fallback)`);
        }
      } else {
        console.log(`🫥 透過化 ${hideStats.count}個 (cream矩形 ${hideStats.rectCount} + クリックオーバーレイ ${hideStats.overlayCount}) [rect基準 TOL_W=8/TOL_H=12/POS=6]`);
        if (hideStats.rectCount < 42) {
          console.log(`   ℹ️ cream矩形 ${hideStats.rectCount}/42 個。 完全配置で過去 fix26 (31/31達成) と同条件。`);
        }
      }
    } catch (e) {
      console.log(`   ⚠️ クリック透過化失敗: ${e.message}`);
    }

    console.log(`✏️ Pass 2: ${dayCellMap.length}日分のテキスト書込み開始`);
    const writeResults = [];
    try {
      for (let i = 0; i < dayCellMap.length; i++) {
        const { day, cell } = dayCellMap[i];
        const tag = day.hasMultiple ? ` (★${day.entryCount}行マージ)` : "";
        console.log(`   → ${day.date}日(${day.weekday})${tag}`);

        // ★fix11: fix9 と同じ inspectPlaceholderResidue (NEAR_PX=15) 検証に戻す。
        //   fix10 で導入した countPlaceholders と findPlaceholderNear は、
        //   Canva の dynamic 再描画でカウント値が乱高下 (-4〜+10)、placeholder 位置も
        //   drift (-18〜+22px) して隣セルを誤って上書きするため revert。
        let wr = null;
        let attempt = 0;
        const MAX_ATTEMPTS = 3;
        while (attempt < MAX_ATTEMPTS) {
          attempt++;
          if (attempt > 1) {
            console.log(`      🔁 ${day.date}日 リトライ ${attempt}/${MAX_ATTEMPTS}`);
            // ★fix13: mouse.click(50,50) は canvas pan 副作用があるため撤回。
            //   Escape×3 + DOM blur で deselect。
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(150);
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(150);
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(200);
            await page.evaluate(() => {
              try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
            });
            await page.waitForTimeout(300);

            // ★fix26: グローバル canvas pan を median-based で検出して cell.top 補正
            //   Pass 2 中盤で canvas が pan して 24-31日が全失敗する問題に対処。
            //   median を使うため、1セル分の隣セル誤掴みは多数決で吸収される。
            //   shift 適用先は CURRENT セルのみ (残りセルは次のリトライで個別補正)。
            // ★fix34: 極端な pan 値 (|dx|>30 or |dy|>30) は外部ディスプレー切替
            //   などで canvas が viewport 外に出た異常事象 — 補正すると更に隣セル
            //   侵食を加速するため SKIP して stored 座標で続行。 ユーザーに環境
            //   不安定の警告を出す。
            // ★fix35: 閾値を 30→15px に厳格化。 実測で ±15-20px の pan が書込み失敗
            //   多発帯と判明したため、 真の small drift (canva 通常 pan は ±5px 程度)
            //   のみ補正し、 それ以上は環境異常として SKIP する。
            try {
              const pan = await detectCanvasPan(page, cells);
              if (pan && (Math.abs(pan.dx) > 3 || Math.abs(pan.dy) > 3)) {
                if (Math.abs(pan.dx) > 15 || Math.abs(pan.dy) > 15) {
                  console.log(`      ⚠️ [pan] ${day.date}日 異常な pan 検出 dx=${pan.dx.toFixed(0)} dy=${pan.dy.toFixed(0)} (samples=${pan.count}) — 補正 SKIP (canvas 環境不安定: ディスプレー接続/ウィンドウサイズ変更/Cmd+Tab デスクトップ切替 等を疑ってください)`);
                } else {
                  cell.top.x += pan.dx;
                  cell.top.y += pan.dy;
                  if (cell.top.left != null) cell.top.left += pan.dx;
                  if (cell.top.right != null) cell.top.right += pan.dx;
                  if (cell.top.top != null) cell.top.top += pan.dy;
                  if (cell.top.bottom != null) cell.top.bottom += pan.dy;
                  console.log(`      [pan] ${day.date}日 グローバル pan 検出 dx=${pan.dx.toFixed(0)} dy=${pan.dy.toFixed(0)} (samples=${pan.count}) — cell.top 補正`);
                }
              }
            } catch (e) {
              console.log(`      [pan] ${day.date}日 検出失敗: ${e.message}`);
            }
          }

          // ★fix24: fix23 で導入した per-cell cell.top refresh は撤回。
          //   findPlaceholders が 1 placeholder = 3 leaves spans を全部返す (5/23 罠1)
          //   ため、 60px 半径内に左右隣セル(44px 間隔) の leaf が混在 → 「nearest」が
          //   隣セルを掴み、 cell.top が隣セル位置に上書きされ → ph_TL クリックも
          //   隣セル着弾 → 隣セルに書込み → 24-27日が MON-FRI 列に 1セルずれて侵食
          //   する大事故が発生 (fix23 実測: 27日が FRI 列、26日が WED 列、etc)。
          //   refresh せず stored cell.top をそのまま使う fix22 の挙動に戻す。
          try { await hideAssignedRects(page, cells); } catch {}
          wr = await writeCell(page, cell.top, day, cells);

          // 書込み後の要素ベース検証 (cell.top 近傍に「段落テキスト」が残っていないか)
          let residue = null;
          try {
            residue = await inspectPlaceholderResidue(page, cell.top);
          } catch {}
          const placeholderRemaining = residue && residue.stillPlaceholder && residue.near;

          // ★fix22: 正の検証 — cell.top 周辺に「期待した日付」が書込まれているか確認
          //   fix21 の NEAR_PX 22 緩和で ph_TR 空打ち が「成功」誤判定された問題を解消。
          // ★fix24: 円形半径 (fix23 の 80px) は隣列セル content (44px間隔) を巻き込み
          //   「6日の verify で隣の 5日の "5" を拾う」誤判定が発生したため、
          //   cell-bound (|dx|≤22, |dy|≤80) の長方形範囲に変更。
          //   - |dx| ≤ 22 = 半セル幅 (44/2): 左右隣列の text を確実に弾く
          //   - |dy| ≤ 80: 13日のような縦伸び 7行 (~60px) コンテンツも余裕で捕捉
          //   さらに上位5件→10件に拡大 (leaf 数が多いセルで「13」が埋もれる対策)。
          // ★fix25: hasMultiple (★2行マージ=2エントリ) は ~10行で text block が
          //   ~85-100px に伸びる。 fix24 の Y_RANGE=80 では「23」leaf が dy=+82 程度で
          //   外側に出て verify 失敗 (23日のみ 30/31 サマリで残失敗)。
          //   merge セルのみ Y_RANGE=130 に拡大 (2行分の縦領域カバー)。
          //   日付番号での厳密マッチ (/^(\d+)/ === expectedDate) なので
          //   隣行 30日の "30" leaf 等は textが一致せず誤マッチしない。
          const HALF_W = 22;
          const Y_RANGE = day.hasMultiple ? 130 : 80;
          const Y_UPPER_LIMIT = 10;  // ★fix38: cell.top より上は 10px までしか見ない (ヘッダー行の "MON" "TUE" 等を除外)
          let positiveOk = false;
          let foundText = "";
          try {
            const result = await page.evaluate(({ tx, ty, expectedDate, halfW, yRange, yUpper }) => {
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
                // ★fix24: 長方形 cell-bound — 隣列侵入を弾きつつ 縦伸びは許容
                // ★fix38: 上方は 10px までに制限 (header 行の SUN/MON/TUE 等を除外)
                if (Math.abs(dx) > halfW) continue;
                if (dy < -yUpper || dy > yRange) continue;
                const dist = Math.sqrt(dx * dx + dy * dy);
                candidates.push({ txt: txt.slice(0, 30), dist });
              }
              candidates.sort((a, b) => a.dist - b.dist);
              // 上位10件で期待日付が含まれているか確認 (fix23: 5→10)
              for (let i = 0; i < Math.min(10, candidates.length); i++) {
                const t = candidates[i].txt;
                // 先頭が expectedDate ちょうど (例: "1" → "1", "13" → "13") を厳密マッチ
                // "1" が "13" に偶然マッチしないよう、 後続が数字でないことを確認
                const m = t.match(/^(\d+)/);
                if (m && m[1] === expectedDate) {
                  return { ok: true, foundText: t };
                }
              }
              return {
                ok: false,
                foundText: candidates.length > 0 ? candidates[0].txt : "(no text near)",
              };
            }, { tx: cell.top.x, ty: cell.top.y, expectedDate: String(day.date), halfW: HALF_W, yRange: Y_RANGE, yUpper: Y_UPPER_LIMIT });
            positiveOk = result.ok;
            foundText = result.foundText;
          } catch (e) {
            positiveOk = false;
            foundText = "(verify error: " + e.message + ")";
          }

          const failed = placeholderRemaining || !positiveOk;
          if (failed) {
            if (placeholderRemaining) {
              console.log(`      ⚠️ ${day.date}日 書込み後も近傍に「段落テキスト」残存 dist=${residue.dist?.toFixed(0)}px → 書込み失敗`);
            }
            if (!positiveOk) {
              console.log(`      ⚠️ ${day.date}日 期待日付「${day.date}」が cell-bound (|dx|≤${HALF_W}, -${Y_UPPER_LIMIT}≤dy≤${Y_RANGE}) 内に未発見 (found="${foundText}") → 書込み失敗`);
            }
            if (attempt < MAX_ATTEMPTS) continue;
            if (wr) wr.suspectMisplaced = true;
          } else {
            // ★fix39: 全成功日で verify ✓ ログ出力 (何が書込まれたか可視化 / overlay 吸収による偽陽性を発見しやすく)
            console.log(`      [verify] ${day.date}日 ✓ "${foundText}"`);
          }
          break;
        }

        // ★fix13: fix12 で導入した mouse.click(50,50) は Canva 左サイドバーを
        //   開いて canvas を pan させ、24日以降の cell.top 座標を 14px ズラす
        //   壊滅的副作用を起こしたため**撤回**。Escape×2 と DOM blur のみで deselect。
        try {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(100);
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(100);
          // DOM レベルで activeElement を blur (focus 残存を確実に除去)
          await page.evaluate(() => {
            try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
          });
          await page.waitForTimeout(80);
        } catch {}

        // ★fix21: マージセル(★2行マージ等の hasMultiple)直後は text element が
        //   大きく生成されており、 次セル click が セレクションハンドルに当たって
        //   隣セル侵食する事故が起こる (23日→24-26日全失敗の事例)。
        //   500ms の追加待機 + Escape×2 で Canva の選択枠を確実に消す。
        if (day.hasMultiple) {
          try {
            await page.waitForTimeout(500);
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(150);
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(200);
            console.log(`      ⏸️ ${day.date}日 (マージ) 後の追加待機 500ms + Escape`);
          } catch {}
        }

        writeResults.push({ day, result: wr || { ok: false, reason: "no return" } });
      }
      console.log("✅ Pass 2: テキスト書込み完了");
    } finally {
      // 必ず矩形を復元 (途中エラーでも実行)
      try {
        const restored = await restoreFilledRectShapes(page);
        console.log(`🔄 cream矩形 ${restored}個を復元`);
      } catch (e) {
        console.log(`   ⚠️ 矩形復元失敗: ${e.message}`);
      }

      // ─── Pass 3: 空セル placeholder のみ厳格に CSS hide ───
      //   fix18: 対象を「空セル(dayCellMap に含まれない cell) の cell.top 近傍15px」に
      //   厳格化。bbox 全域 (fix16/17) は cream restore 直後の **transient placeholder
      //   表示中の data cell** も巻き込んで hide → 24-30日が完全消失する事故 (fix17 で発生)。
      //   空セル位置にのみ hide することで data cell は絶対に touch しない。
      //   トレードオフ: テンプレ装飾用 placeholder (空セル近傍にない) は残るが、
      //   data cell content が消えるよりは遥かにマシ。
      try {
        const usedKeys = new Set(dayCellMap.map(({ cell }) => `${cell.top.x.toFixed(0)},${cell.top.y.toFixed(0)}`));
        const emptyCellPositions = [];
        for (const row of cells) {
          for (const cell of row) {
            if (!cell || !cell.top) continue;
            const key = `${cell.top.x.toFixed(0)},${cell.top.y.toFixed(0)}`;
            if (!usedKeys.has(key)) {
              emptyCellPositions.push({ x: cell.top.x, y: cell.top.y });
            }
          }
        }

        // ★fix29: per-cell dist 判定 (fix28 60px) でも canvas pan が更に進行して
        //   sample dist=59 / 200px内=144 / 近傍60px=40 / hide=5個 という散発残存。
        //   個別 cell からの距離 を諦め、 calendar grid 全体の bbox (cells から min/max)
        //   + 200px margin 内の「段落テキスト」leaf を一律 hide する方式に変更。
        //   サイドバー/ツールバーの "段落テキスト" は bbox 外なので size filter と
        //   合わせて UI 要素を誤 hide することはない。
        let bboxMinX = Infinity, bboxMaxX = -Infinity, bboxMinY = Infinity, bboxMaxY = -Infinity;
        for (const row of cells) {
          for (const cell of row) {
            if (!cell || !cell.top) continue;
            if (cell.top.x < bboxMinX) bboxMinX = cell.top.x;
            if (cell.top.x > bboxMaxX) bboxMaxX = cell.top.x;
            if (cell.top.y < bboxMinY) bboxMinY = cell.top.y;
            if (cell.top.y > bboxMaxY) bboxMaxY = cell.top.y;
          }
        }
        const BBOX_MARGIN = 200;
        const calendarBbox = {
          minX: bboxMinX - BBOX_MARGIN,
          maxX: bboxMaxX + BBOX_MARGIN,
          minY: bboxMinY - BBOX_MARGIN,
          maxY: bboxMaxY + BBOX_MARGIN,
        };

        if (emptyCellPositions.length > 0) {
          // restore後 Canva 描画が落ち着くまで少し待機
          await page.waitForTimeout(500);

          console.log(`🧹 Pass 3 (restore後): 空セル ${emptyCellPositions.length}個`);
          console.log(`   [bbox] カレンダー全体 hide 範囲: (${calendarBbox.minX.toFixed(0)},${calendarBbox.minY.toFixed(0)}) - (${calendarBbox.maxX.toFixed(0)},${calendarBbox.maxY.toFixed(0)})`);

          // fix19/fix29: 診断 — bbox 内の "段落テキスト" 数を確認
          const diag = await page.evaluate((bbox) => {
            let total = 0, leafCount = 0, inBbox = 0, leafInBbox = 0;
            const samples = [];
            const all = document.querySelectorAll("*");
            for (const el of all) {
              const txt = (el.textContent || "").trim();
              if (txt !== "段落テキスト") continue;
              total++;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              const isLeaf = el.children.length === 0;
              if (isLeaf) leafCount++;
              const cx = r.x + r.width / 2;
              const cy = r.y + r.height / 2;
              const within = cx >= bbox.minX && cx <= bbox.maxX && cy >= bbox.minY && cy <= bbox.maxY;
              if (within) inBbox++;
              if (within && isLeaf) leafInBbox++;
              if (samples.length < 5) {
                samples.push(`<${el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} pos=${Math.round(cx)},${Math.round(cy)} inBbox=${within} leaf=${isLeaf}>`);
              }
            }
            return { total, leafCount, inBbox, leafInBbox, samples };
          }, calendarBbox);
          console.log(`   [diag] DOM内 "段落テキスト" 完全一致: 計${diag.total}個 / leaf=${diag.leafCount} / bbox内=${diag.inBbox} (leaf=${diag.leafInBbox})`);
          for (const s of diag.samples) console.log(`   [sample] ${s}`);

          // ★fix31-B: hide で textContent="" される前に placeholder leaves 位置を
          //   先に取得してクラスタリングしておく (旧 Pass 3.5 は hide 後だったため
          //   常に 0 leaves になっていた)。 cluster は後で ZWS 書込みに使用。
          const livePositionsForZws = await page.evaluate((bbox) => {
            const results = [];
            const all = document.querySelectorAll("*");
            for (const el of all) {
              if (el.children.length !== 0) continue; // leaf のみ
              const txt = (el.textContent || "").trim();
              if (txt !== "段落テキスト") continue;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              if (r.width > 200 || r.height > 100) continue;
              const cx = r.x + r.width / 2;
              const cy = r.y + r.height / 2;
              if (cx < bbox.minX || cx > bbox.maxX || cy < bbox.minY || cy > bbox.maxY) continue;
              results.push({ x: cx, y: cy });
            }
            return results;
          }, calendarBbox);

          // 25px 以内の近接 leaves を 1 cluster にまとめる (1セル=3leaves 罠1対応)
          const zwsClusters = [];
          for (const p of livePositionsForZws) {
            let added = false;
            for (const c of zwsClusters) {
              if (Math.abs(c.x - p.x) < 25 && Math.abs(c.y - p.y) < 25) {
                c.x = (c.x * c.count + p.x) / (c.count + 1);
                c.y = (c.y * c.count + p.y) / (c.count + 1);
                c.count++;
                added = true;
                break;
              }
            }
            if (!added) zwsClusters.push({ x: p.x, y: p.y, count: 1 });
          }
          console.log(`   [cluster] hide 前検出: ${livePositionsForZws.length} leaves → ${zwsClusters.length} clusters (空セル想定 ${emptyCellPositions.length})`);

          // ★fix32-B: cluster を empty/data に分類
          //   Pass 2 で書込み失敗した data cells (例: SUN列スキップ 3,10,17,24,31) の
          //   placeholder も cluster に含まれてしまう。 これらに ZWS書込みすると
          //   「データセルなのに空文字 (ZWS) が入った」 状態になり、 ユーザーの手動
          //   入力時に上書きしにくくなる。 emptyCellPositions の 100px 以内のみを
          //   ZWS書込み対象にして data cells は手付かずで残す (Pass 2 サマリで「完全
          //   スキップ日」として既に通知済なので、 ユーザーは手動入力で対応する)。
          //   100px = canvas pan 影響 (実測 dx,dy ~ -20 ~ +30) と placeholder bbox
          //   ばらつき (~10-20px) の合算を吸収する margin。
          for (const cluster of zwsClusters) {
            let isEmpty = false;
            for (const ep of emptyCellPositions) {
              if (Math.abs(cluster.x - ep.x) < 100 && Math.abs(cluster.y - ep.y) < 100) {
                isEmpty = true;
                break;
              }
            }
            cluster.isEmpty = isEmpty;
          }
          const emptyClustersToProcess = zwsClusters.filter((c) => c.isEmpty);
          const dataClustersSkipped = zwsClusters.filter((c) => !c.isEmpty);
          if (dataClustersSkipped.length > 0) {
            console.log(`   [分類] 空セル候補 ${emptyClustersToProcess.length} / データセル失敗(ZWS対象外) ${dataClustersSkipped.length}`);
          } else {
            console.log(`   [分類] 全 ${emptyClustersToProcess.length} clusters が空セル候補`);
          }

          // ★fix32-A: Pass 3.5 ZWS書込みを DOM hide より「先に」 実行
          //   旧: hide 後に Pass 3.5 → Canva が display:none 要素を click できず 0/15 全失敗
          //   新: cluster 検出直後 (placeholder が visible なまま) で dblclick 可能
          //   ZWS (U+200B) は trim されず invisible、 Canva の placeholder 判定を
          //   「テキストあり」 に変更して visual に消える。
          if (emptyClustersToProcess.length > 0) {
            try {
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(200);
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(200);

              console.log(`🖋️ Pass 3.5: ZWS書込み (hide 前 / 対象 ${emptyClustersToProcess.length} clusters)`);
              // ★fix33: Pass 3.5 で enterTextEditAtCell を再利用。
              //   旧: page.mouse.dblclick 生コール → cream 矩形 (Pass 2 後 restore済)
              //   が overlay して click が placeholder に届かず 0/12 全失敗。
              //   新: enterTextEditAtCell は内部で hideAssignedRects + 多候補
              //   (ph_TL, ph_TR, ph_top_inner, ...) + isInTextEditMode 待機を
              //   実装しているので、 Pass 2 writeCell と同じ堅牢ロジックを再利用。
              //   cluster 中心から typical placeholder bbox (33×8) を擬似的に
              //   構築して pos に渡す。
              let zwsOk = 0, zwsFail = 0;
              for (let i = 0; i < emptyClustersToProcess.length; i++) {
                const cluster = emptyClustersToProcess[i];
                try {
                  const fakePos = {
                    x: cluster.x,
                    y: cluster.y,
                    left: cluster.x - 16,
                    right: cluster.x + 16,
                    top: cluster.y - 4,
                    bottom: cluster.y + 4,
                    w: 33,
                    h: 8,
                  };
                  const enter = await enterTextEditAtCell(page, fakePos, { cells });
                  if (enter.ok) {
                    await page.keyboard.press(`${MOD}+A`);
                    await page.waitForTimeout(120);
                    await page.keyboard.type("​");
                    await page.waitForTimeout(180);
                    await page.keyboard.press("Escape");
                    await page.waitForTimeout(100);
                    await page.keyboard.press("Escape");
                    await page.waitForTimeout(150);
                    zwsOk++;
                  } else {
                    zwsFail++;
                  }
                } catch {
                  zwsFail++;
                }
              }
              console.log(`✅ Pass 3.5 完了: ZWS書込み 成功 ${zwsOk}/${emptyClustersToProcess.length} (失敗 ${zwsFail})`);
            } catch (e) {
              console.log(`   ⚠️ Pass 3.5 失敗: ${e.message}`);
            }
          }

          // ★fix20: 多重防御 ─ CSS stylesheet + inline style + textContent="" + MutationObserver(attributes付)
          //   理由: fix19 で 11個 hide したが視覚的には残った。
          //   解明: Canva の React が `el.style.cssText` で inline style を全上書きするため
          //          私の visibility:hidden が消される。MutationObserver も attributes 観測なし
          //          で style 変化を検知できず再 hide 不可だった。
          //   対策:
          //     A) <style> tag 注入で [data-canva-empty-placeholder-hidden] に CSS rule 適用
          //        → React の cssText 上書きと無関係に display:none が効く
          //     B) textContent="" で text 自体を削除 (二重防御)
          //     C) MutationObserver で attributes:true (style/class) を観測、変更時に再hide+text空
          const hideResult = await page.evaluate((bbox) => {
            // A) stylesheet 注入 (1度だけ)
            if (!document.getElementById("canva-empty-placeholder-hide-style")) {
              const style = document.createElement("style");
              style.id = "canva-empty-placeholder-hide-style";
              style.textContent = `
                [data-canva-empty-placeholder-hidden="1"] {
                  visibility: hidden !important;
                  display: none !important;
                  opacity: 0 !important;
                  pointer-events: none !important;
                }
              `;
              document.head.appendChild(style);
            }

            // ★fix29: bbox 内判定 (per-cell dist 廃止)
            const isInBbox = (cx, cy) => (
              cx >= bbox.minX && cx <= bbox.maxX &&
              cy >= bbox.minY && cy <= bbox.maxY
            );

            const processEl = (el) => {
              if (!el || el.nodeType !== 1) return false;
              if (el.hasAttribute && el.hasAttribute("data-canva-empty-placeholder-hidden")) return false;
              const txt = (el.textContent || "").trim();
              if (txt !== "段落テキスト") return false;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              if (r.width > 200 || r.height > 100) return false; // size filter で UI 要素除外
              const cx = r.x + r.width / 2;
              const cy = r.y + r.height / 2;
              if (!isInBbox(cx, cy)) return false;
              // B) text 内容を空に (Canva の re-render で復元される可能性あるが、 一旦消す)
              try { el.textContent = ""; } catch {}
              // inline style + 属性 (stylesheet と二重防御)
              try {
                el.style.setProperty("visibility", "hidden", "important");
                el.style.setProperty("display", "none", "important");
                el.style.setProperty("opacity", "0", "important");
                el.style.setProperty("pointer-events", "none", "important");
              } catch {}
              el.setAttribute("data-canva-empty-placeholder-hidden", "1");
              return true;
            };

            // 全要素を走査
            let count = 0;
            const all = document.querySelectorAll("*");
            for (const el of all) {
              if (processEl(el)) count++;
            }
            return { count };
          }, calendarBbox);
          console.log(`   → 初回 hide: ${hideResult.count}個`);

          // C) MutationObserver で連続防御 (attributes 観測追加)
          await page.evaluate((bbox) => {
            if (window.__canvaPlaceholderHideObserver) {
              window.__canvaPlaceholderHideObserver.disconnect();
            }
            const isInBbox = (cx, cy) => (
              cx >= bbox.minX && cx <= bbox.maxX &&
              cy >= bbox.minY && cy <= bbox.maxY
            );
            const processEl = (el) => {
              if (!el || el.nodeType !== 1) return;
              const isAlreadyMarked = el.hasAttribute && el.hasAttribute("data-canva-empty-placeholder-hidden");
              const txt = (el.textContent || "").trim();
              if (txt !== "段落テキスト" && !isAlreadyMarked) return;
              const r = el.getBoundingClientRect();
              const cx = r.x + r.width / 2;
              const cy = r.y + r.height / 2;
              if (!isInBbox(cx, cy)) return;
              if (r.width > 200 || r.height > 100) return;
              try { if (el.textContent === "段落テキスト") el.textContent = ""; } catch {}
              try {
                el.style.setProperty("visibility", "hidden", "important");
                el.style.setProperty("display", "none", "important");
                el.style.setProperty("opacity", "0", "important");
                el.style.setProperty("pointer-events", "none", "important");
              } catch {}
              if (!isAlreadyMarked) el.setAttribute("data-canva-empty-placeholder-hidden", "1");
            };
            const observer = new MutationObserver((mutations) => {
              for (const m of mutations) {
                // childList: 新規追加要素
                for (const node of m.addedNodes) {
                  if (node.nodeType !== 1) continue;
                  processEl(node);
                  if (node.querySelectorAll) node.querySelectorAll("*").forEach(processEl);
                }
                // attributes: style/class が変更された (= React が上書き)
                if (m.type === "attributes") {
                  processEl(m.target);
                }
                // characterData: text 内容変更
                if (m.type === "characterData" && m.target.parentElement) {
                  let p = m.target.parentElement;
                  for (let i = 0; i < 3 && p; i++) { processEl(p); p = p.parentElement; }
                }
              }
            });
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
              attributeFilter: ["style", "class"],
            });
            window.__canvaPlaceholderHideObserver = observer;
          }, calendarBbox);
          console.log(`   🛡️ MutationObserver 起動 (attributes+childList+characterData 全観測)`);

          // 反復で再描画後の取りこぼし回収
          let extraHidden = 0;
          for (let iter = 1; iter <= 5; iter++) {
            await page.waitForTimeout(500);
            const stats = await page.evaluate((bbox) => {
              const isInBbox = (cx, cy) => (
                cx >= bbox.minX && cx <= bbox.maxX &&
                cy >= bbox.minY && cy <= bbox.maxY
              );
              let count = 0;
              const all = document.querySelectorAll("*");
              for (const el of all) {
                if (el.hasAttribute("data-canva-empty-placeholder-hidden")) continue;
                const txt = (el.textContent || "").trim();
                if (txt !== "段落テキスト") continue;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                if (r.width > 200 || r.height > 100) continue;
                const cx = r.x + r.width / 2;
                const cy = r.y + r.height / 2;
                if (!isInBbox(cx, cy)) continue;
                try { el.textContent = ""; } catch {}
                try {
                  el.style.setProperty("visibility", "hidden", "important");
                  el.style.setProperty("display", "none", "important");
                  el.style.setProperty("opacity", "0", "important");
                  el.style.setProperty("pointer-events", "none", "important");
                } catch {}
                el.setAttribute("data-canva-empty-placeholder-hidden", "1");
                count++;
              }
              return { count };
            }, calendarBbox);
            console.log(`   → iter ${iter} 追加 hide: ${stats.count}個`);
            extraHidden += stats.count;
            if (stats.count === 0) break;
          }

          await page.waitForTimeout(800);
          const finalCheck = await page.evaluate((bbox) => {
            const isInBbox = (cx, cy) => (
              cx >= bbox.minX && cx <= bbox.maxX &&
              cy >= bbox.minY && cy <= bbox.maxY
            );
            let visibleRemaining = 0;
            const all = document.querySelectorAll("*");
            for (const el of all) {
              const txt = (el.textContent || "").trim();
              if (txt !== "段落テキスト") continue;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              const cx = r.x + r.width / 2;
              const cy = r.y + r.height / 2;
              if (!isInBbox(cx, cy)) continue;
              // 実際に visible か (computed style で確認)
              const cs = window.getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
              visibleRemaining++;
            }
            return { visibleRemaining };
          }, calendarBbox);
          console.log(`✅ Pass 3 完了: 初回${hideResult.count}+反復${extraHidden}個 hide / 視覚残存 ${finalCheck.visibleRemaining}個`);
          // ★fix32: 旧 Pass 3.5 (hide 後の ZWS書込み) は撤去。 上で hide 前に実行済。
        }
      } catch (e) {
        console.log(`   ⚠️ Pass 3 失敗: ${e.message}`);
      }

      // ★fix33: Pass 3.5 の enterTextEditAtCell で cream を hide したため、
      //   全 Pass 完了後に cream を再 restore する (色付きセルが視認できるよう)。
      try {
        const restoredAgain = await restoreFilledRectShapes(page);
        console.log(`🔄 Pass 3 後 cream矩形 再復元 ${restoredAgain}個`);
      } catch (e) {
        console.log(`   ⚠️ cream 再復元失敗: ${e.message}`);
      }
    }

    // ─── 最終サマリ ───
    const okList = writeResults.filter((r) => r.result.ok && !r.result.suspectMisplaced).map((r) => r.day.date);
    const ngList = writeResults.filter((r) => !r.result.ok).map((r) => r.day.date);
    const susList = writeResults.filter((r) => r.result.ok && r.result.suspectMisplaced).map((r) => r.day.date);
    const skipFont19List = writeResults.filter((r) => r.result.ok && r.result.font19skipped).map((r) => r.day.date);
    console.log("");
    console.log(`📊 Pass 2 サマリ: 成功 ${okList.length}/${writeResults.length}日`);
    if (okList.length > 0) console.log(`   ✅ 成功日: ${okList.join(", ")}`);
    if (susList.length > 0) {
      console.log(`   ⚠️ ズレ疑い日 (placeholder残存): ${susList.join(", ")}`);
      console.log(`      → 該当セルが実際に書き込まれたか目視確認してください。`);
    }
    if (skipFont19List.length > 0) {
      console.log(`   📝 19pt(日付)スキップ日: ${skipFont19List.join(", ")}`);
      console.log(`      → テキストは入っていますが日付の大文字化を Canva 上で手動実施してください。`);
    }
    if (ngList.length > 0) {
      console.log(`   ❌ 完全スキップ日: ${ngList.join(", ")}`);
      console.log(`      → Canva 上で手動入力してください。`);
    }
    console.log("");

    console.log("✅ 書込み完了");
    notify(
      "Canvaカレンダー同期完了",
      `${year}年${month}月 ${days.length}日分を書き込みました`
    );
    exitCode = 0;
  } catch (err) {
    console.error("❌ エラー:", err.message);
    notify(
      "Canvaカレンダー同期失敗",
      `${err.message}`.slice(0, 200),
      true
    );
  } finally {
    if (context) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        await context.close();
      } catch {}
    }
    console.log(`⏹ 終了 ${new Date().toISOString()}`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  notify("Canvaカレンダー同期失敗", String(err.message || err).slice(0, 200), true);
  process.exit(1);
});
