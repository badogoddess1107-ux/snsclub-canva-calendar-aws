// ============================================================
// webServer.js — Canva 書込みを Web UI から操作する
// ============================================================
// ・あなたの Mac で起動 (Canva ログイン済の Chromium をここで操作)
// ・ブラウザから: ページ番号/月を入力 → 起動 → 次へ/前へ でページ送り
//   → スクショで目視確認 → 「書き込み実行」 で 31日分書込み
// ・パスワード保護あり。 ngrok / cloudflared で外部公開可。
//
// 起動:
//   node src/webServer.js
//   CANVA_WEB_PASSWORD=好きなパス CANVA_WEB_PORT=4545 node src/webServer.js
//
// 外部公開 (どちらか):
//   cloudflared tunnel --url http://localhost:4545
//   ngrok http 4545
// ============================================================

const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const config = require("../config");
const core = require("./canvaCore");
const {
  clearStaleLock,
  releaseProfile,
  isProfileInUseError,
} = require("./browserProfile");
const cloud = require("./cloudSession");

chromium.use(stealth);

const PORT = parseInt(process.env.CANVA_WEB_PORT || "4545", 10);
const PASSWORD = process.env.CANVA_WEB_PASSWORD || crypto.randomBytes(4).toString("hex");
const SESSION_TOKEN = crypto.randomBytes(16).toString("hex");
// AWS (Fargate) ではプロファイルの置き場所とログイン状態の共有先を環境変数で指定する。
// 未指定なら従来通り (Mac 上の .browser-profile)。
const PROFILE_DIR = process.env.CANVA_PROFILE_DIR || path.join(__dirname, "..", config.canva.userDataDir);
const CLOUD_MODE = cloud.sessionEnabled();

// ============================================================
// サーバー状態 (単一セッション)
// ============================================================
const state = {
  context: null,
  page: null,
  targetMap: null,
  pageNumber: null,
  month: null,
  preview: [],        // [{ date, weekday, r, c, lines }]
  status: "idle",     // idle | launching | ready | writing | done | error
  statusMsg: "未起動",
  log: [],            // 進捗ログ (文字列)
  summary: null,      // { ok:[], fail:[], total }
  titleSummary: null, // { ok, updated:[], alreadyOk:[], failed:[], candidates }
};

function pushLog(line) {
  state.log.push(line);
  if (state.log.length > 1000) state.log.shift();
}

function eventToLine(ev) {
  switch (ev.type) {
    case "dayStart": {
      const tag = ev.hasMultiple ? ` (★${ev.entryCount}行マージ)` : "";
      return `→ ${ev.date}日(${ev.weekday})${tag} cell(${ev.r},${ev.c})`;
    }
    case "retry": return `   🔁 リトライ (${ev.reason})`;
    case "daySuccess": return `   ✓ ${ev.date}日 成功 (found="${ev.found}")`;
    case "dayVerifyFail": return `   ⚠️ ${ev.date}日 verify失敗 (found="${ev.found}")`;
    case "dayFail": return `   ❌ ${ev.date}日 失敗 (${ev.reason})`;
    case "titleScan": return `   🔤 タイトル候補 ${ev.candidates}個 [${ev.texts.join(", ")}] → 要更新 ${ev.updates}個`;
    case "titleStart": return `→ タイトル "${ev.before}" → "${ev.after}"`;
    case "titleSuccess": return `   ✓ タイトル更新成功 "${ev.after}"`;
    case "titleSkip": return `   － "${ev.text}" は既に正しいのでスキップ`;
    case "titleFail": return `   ❌ タイトル "${ev.before}" 失敗 (${ev.reason})`;
    case "log": return ev.message;
    default: return JSON.stringify(ev);
  }
}

// ============================================================
// アクション
// ============================================================

/**
 * 指定ページ・月の座標とカレンダーデータを読み込み、 書込み対象 (targetMap) を組み立てる。
 * actionStart と actionWrite の両方から使う (書込み時にページ/月を変更できるようにするため)。
 */
async function prepareTargetMap(pageNumber, month) {
  if (!pageNumber || !/^\d{4}-\d{2}$/.test(month || "")) {
    throw new Error("ページ番号と月 (YYYY-MM) を正しく入力してください。");
  }
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);

  // 座標は無くても動く (書込み直前に実測で再構築されるため)。
  // これにより「ページ番号と月を入れるだけ」で任意の組合せを実行できる。
  const coordResult = core.loadCoordWithFallback(pageNumber, month);
  pushLog(`📐 ${core.describeCoordSource(coordResult, pageNumber, month)}`);
  const coord = coordResult.coord;

  const days = await core.fetchMonthData(year, monthNum);
  const { dayCellMap } = core.assignDays(days, year, monthNum, coord);
  return { dayCellMap, days, year, monthNum };
}

/**
 * Chromium を起動して (context, page) を返す。 actionStart と actionLaunchForLogin の共通部。
 * AWS モードでは S3 に保存したログイン状態 (Cookie 等) をプロファイルへ流し込む。
 */
async function launchBrowser() {
  const userDataDir = PROFILE_DIR;

  // ホスト側に前回の Chromium が残っていると ProcessSingleton エラーで起動できない。
  // リモート利用者には原因が見えないので、 死んだプロセスのロックは黙って片付ける。
  if (clearStaleLock(userDataDir)) {
    pushLog("🧹 前回の残骸 (ロックファイル) を掃除しました。");
  }

  const launch = () =>
    chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

  let context;
  try {
    context = await launch();
  } catch (e) {
    if (!isProfileInUseError(e)) throw e;
    // 生きた Chromium が掴んだままのケース。 開きっぱなしのウィンドウを閉じて再挑戦する。
    // 対象は このプロファイルを使うプロセスのみで、 普段使いの Chrome には触れない。
    pushLog("⚠️ ホストにChromiumが残っていました。 終了させて再試行します...");
    const { killed } = releaseProfile(userDataDir);
    pushLog(`🧹 ${killed.length}個のプロセスを終了しました。`);
    try {
      context = await launch();
    } catch (retryError) {
      if (!isProfileInUseError(retryError)) throw retryError;
      throw new Error(
        "Chromiumが開いたままのため起動できません。 " +
          "「Google Chrome for Testing」 のウィンドウ (確認ダイアログが出ていないか) を閉じてから、 もう一度お試しください。",
      );
    }
  }

  // AWS モード: コンテナのプロファイルは空なので、 S3 のログイン状態を流し込む
  if (CLOUD_MODE) {
    const already = (await context.cookies()).some((c) => String(c.domain).includes("canva.com"));
    if (!already) {
      try {
        const saved = await cloud.loadSessionState();
        if (cloud.hasCanvaLogin(saved)) {
          const r = await cloud.applySessionToContext(context, saved);
          pushLog(`☁️ S3 のログイン状態を復元しました (Cookie ${r.cookies}件)`);
        } else {
          pushLog("☁️ S3 にログイン状態がありません。 下の「Canvaログイン」からログインして保存してください。");
        }
      } catch (e) {
        // S3 が読めなくても起動は続ける (ログインし直せば済む)
        pushLog(`☁️ S3 からの復元に失敗: ${e.message}`);
      }
    }
  }

  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

/** AWS モード: 現在のログイン状態を S3 に保存する (月次バッチとも共有される) */
async function persistCloudSession(reason) {
  if (!CLOUD_MODE || !state.context) return;
  try {
    const st = await state.context.storageState();
    await cloud.saveSessionState(st);
    pushLog(`☁️ ログイン状態を S3 に保存しました (${reason})`);
  } catch (e) {
    pushLog(`☁️ ログイン状態の保存に失敗 (${reason}): ${e.message}`);
  }
}

/**
 * ログイン専用の起動: ページ/月を指定せず Canva のログイン画面を開く。
 * Web UI のリモート操作 (クリック/入力) で人がログインし、「ログイン状態を保存」で S3 へ。
 */
async function actionLaunchForLogin() {
  if (state.context) {
    throw new Error("既に起動済みです。 一度『閉じる』 してから再起動してください。");
  }
  state.status = "launching";
  state.statusMsg = "Chromium 起動中 (ログイン用)...";
  const { context, page } = await launchBrowser();
  await page.goto("https://www.canva.com/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  state.context = context;
  state.page = page;
  state.status = "ready";
  state.statusMsg = "ログイン用に起動しました。 画面をクリック/入力してログインし、 完了したら「ログイン状態を保存」を押してください。";
  pushLog("🔑 ログイン用に Canva を開きました。");
}

async function actionStart(pageNumber, month) {
  if (state.context) {
    throw new Error("既に起動済みです。 一度『閉じる』 してから再起動してください。");
  }
  const { dayCellMap, days, year, monthNum } = await prepareTargetMap(pageNumber, month);

  state.status = "launching";
  state.statusMsg = "Chromium 起動中...";
  pushLog(`📥 ${year}年${monthNum}月: ${days.length}日分取得 / ${dayCellMap.length}日割当`);

  const { context, page } = await launchBrowser();
  await page.goto(config.canva.designUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);

  state.context = context;
  state.page = page;
  state.targetMap = dayCellMap;
  state.pageNumber = pageNumber;
  state.month = month;
  state.preview = dayCellMap.map((x) => ({
    date: x.day.date, weekday: x.day.weekday, r: x.r, c: x.c, lines: x.day.lines,
  }));
  state.status = "ready";
  state.statusMsg = `起動完了。 Canvaを${pageNumber}ページまで送ってください。`;
  pushLog(`🚀 Canva 起動完了。 「次へ/前へ」 で P${pageNumber} まで移動してください。`);
  await persistCloudSession("起動");
}

async function actionNav(dir) {
  if (!state.page) throw new Error("未起動です。");
  if (dir === "next") await core.pageDown(state.page);
  else if (dir === "prev") await core.pageUp(state.page);
  else if (dir === "top") await core.pageTop(state.page);
  else throw new Error("不明な方向: " + dir);
}

async function actionGoto(targetPage) {
  if (!state.page) throw new Error("未起動です。");
  if (!targetPage || targetPage < 1) throw new Error("ページ番号が不正です。");
  pushLog(`📑 ${targetPage}ページへ移動中 (scrollIntoView)...`);
  const nav = await core.gotoPageByScroll(state.page, targetPage);
  pushLog(`   ✓ ${targetPage}ページへ移動 (総ページ数=${nav.total})。 画面で確認してください。`);
}

async function actionWrite(reqPage, reqMonth) {
  if (!state.page) throw new Error("未起動です。");
  if (state.status === "writing") throw new Error("既に書込み中です。");

  state.status = "writing";
  state.statusMsg = "書込み中...";
  state.summary = null;
  state.titleSummary = null;
  state.log = [];

  // ⓪ フォームで指定されたページ/月を優先する。
  //    起動時の値をそのまま使うと、 入力欄を変更しても反映されず
  //    「②は37ページ、④は34ページ」 のような食い違いが起きる。
  const wantPage = reqPage || state.pageNumber;
  const wantMonth = reqMonth || state.month;
  if (wantPage !== state.pageNumber || wantMonth !== state.month) {
    pushLog(`🔄 指定変更: ${state.pageNumber}ページ/${state.month} → ${wantPage}ページ/${wantMonth}`);
    const { dayCellMap, days, year, monthNum } = await prepareTargetMap(wantPage, wantMonth);
    state.targetMap = dayCellMap;
    state.pageNumber = wantPage;
    state.month = wantMonth;
    state.preview = dayCellMap.map((x) => ({
      date: x.day.date, weekday: x.day.weekday, r: x.r, c: x.c, lines: x.day.lines,
    }));
    pushLog(`   ✓ ${year}年${monthNum}月: ${days.length}日分を再取得 / ${dayCellMap.length}日割当`);
  }

  // ① 目的ページへ scrollIntoView 移動 (このCanvaはPageDownが効かないため)
  pushLog(`📑 ${state.pageNumber}ページへ移動中 (scrollIntoView)...`);
  const nav = await core.gotoPageByScroll(state.page, state.pageNumber);
  pushLog(`   ✓ ページ移動 (総ページ数=${nav.total})`);
  await state.page.waitForTimeout(400);

  // ①.5 ロックされていたら自動解除
  const unlock = await core.unlockPageIfLocked(state.page);
  if (unlock.locked) pushLog("🔓 ページのロックを自動解除しました");
  await state.page.waitForTimeout(300);

  // ② ページ矩形内の placeholder を検出 → cells 再構築
  pushLog("🔍 ページ内 placeholder 検出 → cells 再構築...");
  let info;
  try {
    info = await core.rebuildCellsAndAssign(state.page, state.targetMap, state.pageNumber);
  } catch (e) {
    state.status = "error";
    state.statusMsg = "placeholder ≠ 42";
    pushLog(`❌ ${e.message}`);
    pushLog("   → このページが目的ページか / 既に書込み済でないか 確認し、 Cmd+Z でクリーン(42個)に戻してください。");
    return;
  }
  pushLog(`   ✓ placeholder ${info.count}個 / cells 再構築完了 (bbox 幅=${info.bbox.w.toFixed(0)} 高=${info.bbox.h.toFixed(0)})`);

  // ②.5 月タイトル (「2026.6」「June」) を更新 — 日付セルより先 (罠6 対策)
  const [titleYear, titleMonth] = state.month.split("-").map((v) => parseInt(v, 10));
  pushLog(`🔤 月タイトルを ${titleYear}年${titleMonth}月 に更新...`);
  try {
    const titleResult = await core.writeMonthTitle(state.page, {
      year: titleYear,
      month: titleMonth,
      cells: info.cells,
      onEvent: (ev) => pushLog(eventToLine(ev)),
    });
    state.titleSummary = titleResult;
    if (titleResult.candidates === 0) {
      pushLog("   ⚠️ 月タイトルが見つかりません → Canva 上で手動修正してください");
    } else if (!titleResult.ok) {
      pushLog(`   ⚠️ タイトル更新失敗 ${titleResult.failed.length}件 → 手動修正してください`);
    }
  } catch (e) {
    // タイトルは補助機能。 失敗しても日付書込みは続行する
    pushLog(`   ⚠️ 月タイトル更新でエラー: ${e.message} (日付の書込みは続行します)`);
  }

  pushLog(`✏️ ${state.targetMap.length}日分の書込み開始`);

  const results = await core.writeAllDays(state.page, state.targetMap, {
    debug: false,
    onEvent: (ev) => pushLog(eventToLine(ev)),
  });

  const ok = results.filter((r) => r.ok).map((r) => r.day.date);
  const fail = results.filter((r) => !r.ok).map((r) => r.day.date);
  state.summary = { ok, fail, total: results.length };
  state.status = "done";
  state.statusMsg = `完了: 成功 ${ok.length}/${results.length}日`;
  pushLog(`📊 サマリ: 成功 ${ok.length}/${results.length}日`);
  if (fail.length) pushLog(`   ❌ 失敗日: ${fail.join(", ")} → 手動入力推奨`);
  await persistCloudSession("書込み完了");
}

// ------------------------------------------------------------
// リモート操作 (Canva ログイン用)。 スクショ上のクリック・文字入力・キーを実ブラウザへ転送する。
// AWS ではブラウザ画面を直接見られないため、 これでメール認証等の画面を人が操作する。
// ------------------------------------------------------------
async function actionRemoteClick(x, y) {
  if (!state.page) throw new Error("未起動です。");
  const dpr = await state.page.evaluate(() => window.devicePixelRatio).catch(() => 1);
  const pt = cloud.toPageCoords(x, y, dpr);
  if (!pt) throw new Error("座標が不正です。");
  await state.page.mouse.click(pt.x, pt.y);
  await state.page.waitForTimeout(300);
}

async function actionRemoteType(text) {
  if (!state.page) throw new Error("未起動です。");
  const t = String(text || "");
  if (!t) throw new Error("入力する文字がありません。");
  if (t.length > 500) throw new Error("入力が長すぎます。");
  await state.page.keyboard.type(t, { delay: 30 });
}

async function actionRemoteKey(key) {
  if (!state.page) throw new Error("未起動です。");
  if (!cloud.isAllowedKey(key)) throw new Error("そのキーは使えません: " + key);
  await state.page.keyboard.press(key);
  await state.page.waitForTimeout(200);
}

async function actionRemoteOpen(url) {
  if (!state.page) throw new Error("未起動です。");
  const u = String(url || "");
  if (!/^https:\/\/([a-z0-9-]+\.)*canva\.com\//i.test(u)) throw new Error("canva.com のURLのみ開けます。");
  await state.page.goto(u, { waitUntil: "domcontentloaded" });
  await state.page.waitForTimeout(2000);
}

async function actionSaveSession() {
  if (!state.context) throw new Error("未起動です。");
  if (!CLOUD_MODE) throw new Error("AWSモードではありません (CANVA_SESSION_BUCKET 未設定)。");
  const st = await state.context.storageState();
  if (!cloud.hasCanvaLogin(st)) throw new Error("Canva のログイン Cookie が見つかりません。 先にログインしてください。");
  await cloud.saveSessionState(st);
  pushLog("☁️ ログイン状態を S3 に保存しました (手動)");
}

async function actionClose() {
  await persistCloudSession("閉じる");
  if (state.context) {
    try { await state.context.close(); } catch {}
  }
  state.context = null;
  state.page = null;
  state.targetMap = null;
  state.preview = [];
  state.summary = null;
  state.status = "idle";
  state.statusMsg = "未起動";
  pushLog("🛑 Chromium を閉じました。");
}

// ============================================================
// HTTP ヘルパー
// ============================================================

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  return parseCookies(req).auth === SESSION_TOKEN;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendHTML(res, code, html) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ============================================================
// HTML
// ============================================================

function loginPage(error) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログイン — Canva書込み</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;height:100vh;margin:0;align-items:center;justify-content:center}
  .card{background:#1e293b;padding:32px;border-radius:16px;width:300px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:18px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:16px}
  button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:16px;font-weight:bold;cursor:pointer}
  .err{color:#f87171;font-size:13px;margin-top:8px}
</style></head><body>
<form class="card" method="POST" action="/login">
  <h1>🔒 Canva 書込みコントロール</h1>
  <input type="password" name="password" placeholder="パスワード" autofocus>
  <button type="submit">ログイン</button>
  ${error ? `<div class="err">${error}</div>` : ""}
</form></body></html>`;
}

function controlPage() {
  const defaultMonth = state.month || "2026-07";
  const defaultPage = state.pageNumber || 34;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canva 書込みコントロール</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px;max-width:760px;margin:0 auto}
  h1{font-size:18px} h2{font-size:15px;color:#94a3b8;margin:20px 0 8px}
  .card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:14px}
  label{font-size:13px;color:#94a3b8;display:block;margin-bottom:4px}
  input{padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:16px;width:120px}
  button{padding:10px 16px;border:0;border-radius:8px;color:#fff;font-size:15px;font-weight:bold;cursor:pointer;margin:4px}
  .blue{background:#3b82f6}.gray{background:#475569}.green{background:#22c55e}.red{background:#ef4444}
  button:disabled{opacity:.4;cursor:not-allowed}
  #status{padding:10px 14px;border-radius:8px;background:#334155;font-weight:bold;margin-bottom:14px}
  #shot{width:100%;border-radius:8px;border:1px solid #334155;background:#000;min-height:200px}
  #log{background:#0f172a;border-radius:8px;padding:12px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;max-height:280px;overflow:auto;border:1px solid #334155}
  .nav{display:flex;gap:8px;justify-content:center;margin:10px 0}
  .row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
  details{margin-top:8px}summary{cursor:pointer;color:#94a3b8;font-size:13px}
  .day{font-size:12px;border-bottom:1px solid #334155;padding:4px 0}
  .warn{color:#fbbf24;font-size:12px}
</style></head><body>
<h1>📅 Canva カレンダー書込みコントロール</h1>
<div id="status">読込中...</div>
<div id="session" style="font-size:13px;color:#94a3b8;margin:-8px 0 14px 4px">未起動</div>

<div class="card">
  <h2>① 起動</h2>
  <div class="row">
    <div><label>ページ番号</label><input id="page" type="number" value="${defaultPage}"></div>
    <div><label>月 (YYYY-MM)</label><input id="month" type="text" value="${defaultMonth}" style="width:140px"></div>
    <button class="blue" id="btnStart" onclick="start()">🚀 起動</button>
    <button class="gray" id="btnClose" onclick="closeBrowser()">閉じる</button>
  </div>
  <div class="warn">${CLOUD_MODE
    ? "※ AWS上のブラウザでCanvaを開きます。 ログイン状態はS3に保存されたものを使います。"
    : "※ あなたのMacでCanvaがログイン済の状態で起動します。"}</div>
</div>

${CLOUD_MODE ? `
<div class="card">
  <h2>🔑 Canvaログイン (初回・ログイン切れのときだけ)</h2>
  <div class="warn">AWS上のブラウザには画面が無いので、 下のスクショをクリック・文字入力して人がログインします。 完了したら「ログイン状態を保存」。</div>
  <div class="nav">
    <button class="blue" onclick="loginLaunch()">🔑 ログイン画面を開く</button>
    <button class="green" onclick="saveSession()">💾 ログイン状態を保存</button>
  </div>
  <div class="row" style="margin-top:6px">
    <input id="rtext" type="text" placeholder="入力する文字 (メール等)" style="width:260px">
    <button class="gray" onclick="remoteType()">⌨️ 入力</button>
    <button class="gray" onclick="remoteKey('Enter')">Enter</button>
    <button class="gray" onclick="remoteKey('Tab')">Tab</button>
    <button class="gray" onclick="remoteKey('Backspace')">⌫</button>
    <button class="gray" onclick="remoteKey('Escape')">Esc</button>
  </div>
  <div class="warn" style="margin-top:6px">※ 下の「② ページ確認」のスクショをクリックすると、 その位置をブラウザでクリックします。</div>
</div>` : ""}

<div class="card">
  <h2>② ページ確認 (任意)</h2>
  <div class="warn">「④ 書き込み実行」で<b>自動で目的ページへ移動</b>します。 事前に見たい時だけ下を使用。</div>
  <div class="nav">
    <button class="blue" onclick="gotoPage()">📄 目的ページへ移動して確認</button>
    <button class="gray" onclick="refreshShot()">🔄 画面更新</button>
  </div>
  <div class="nav">
    <button class="gray" onclick="nav('top')">⏮ 先頭</button>
    <button class="gray" onclick="nav('prev')">◀ 前へ</button>
    <button class="gray" onclick="nav('next')">次へ ▶</button>
  </div>
  <img id="shot" src="" alt="(起動するとCanva画面が表示されます)" ${CLOUD_MODE ? 'onclick="shotClick(event)" style="cursor:crosshair"' : ""}>
</div>

<div class="card">
  <h2>③ 書込み内容プレビュー</h2>
  <details><summary id="previewSummary">書込み対象の日一覧を表示</summary><div id="preview"></div></details>
</div>

<div class="card">
  <h2>④ 書き込み実行 (完全自動)</h2>
  <div class="warn">このボタン1つで <b>自動で目的ページへ移動 → 書き込み</b> まで行います。</div>
  <button class="green" id="btnWrite" onclick="doWrite()">✅ 自動でページ移動して書き込み実行</button>
  <h2>進捗ログ</h2>
  <div id="log"></div>
</div>

<script>
let shotTimer=null, statusTimer=null;
async function api(path, body){
  const r = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
  return r.json();
}
function setBusy(b){ document.querySelectorAll('button').forEach(x=>x.disabled=b); }
async function start(){
  setBusy(true);
  const page = parseInt(document.getElementById('page').value,10);
  const month = document.getElementById('month').value;
  const r = await api('/api/start',{page,month});
  if(!r.ok) alert('起動失敗: '+r.error);
  setBusy(false); refreshShot();
}
async function closeBrowser(){ setBusy(true); await api('/api/close'); setBusy(false); document.getElementById('shot').src=''; }
async function nav(dir){ setBusy(true); const r=await api('/api/nav',{dir}); if(!r.ok)alert(r.error); setBusy(false); setTimeout(refreshShot,700); }
async function gotoPage(){
  setBusy(true);
  const page=parseInt(document.getElementById('page').value,10);
  const r=await api('/api/goto',{page});
  if(!r.ok)alert(r.error);
  setBusy(false); setTimeout(refreshShot,800);
}
function refreshShot(){ document.getElementById('shot').src='/api/screenshot?'+Date.now(); }
// ---- リモート操作 (AWSモードのみ) ----
async function loginLaunch(){ setBusy(true); const r=await api('/api/login/launch'); if(!r.ok)alert(r.error); setBusy(false); setTimeout(refreshShot,800); }
async function saveSession(){ setBusy(true); const r=await api('/api/session/save'); alert(r.ok?'保存しました。 月次バッチもこのログインで動きます。':'保存失敗: '+r.error); setBusy(false); }
async function shotClick(ev){
  const img=ev.target;
  // 表示サイズ → スクショの実ピクセルに換算 (サーバー側で devicePixelRatio を補正)
  const x=(ev.offsetX/img.clientWidth)*img.naturalWidth, y=(ev.offsetY/img.clientHeight)*img.naturalHeight;
  const r=await api('/api/remote/click',{x:Math.round(x),y:Math.round(y)});
  if(!r.ok)alert(r.error); setTimeout(refreshShot,600);
}
async function remoteType(){ const t=document.getElementById('rtext').value; if(!t)return; const r=await api('/api/remote/type',{text:t}); if(!r.ok)alert(r.error); document.getElementById('rtext').value=''; setTimeout(refreshShot,500); }
async function remoteKey(key){ const r=await api('/api/remote/key',{key}); if(!r.ok)alert(r.error); setTimeout(refreshShot,600); }
async function doWrite(){
  const page=document.getElementById('page').value;
  const month=document.getElementById('month').value;
  if(!confirm(page+'ページ ('+month+') へ自動移動して書き込みを開始します。よろしいですか？')) return;
  setBusy(true);
  // page/month を必ず送る。 送らないと起動時の値が使われ、
  // 入力欄を変更しても反映されない (②と④で別ページに行く原因)
  const r=await api('/api/write',{page,month});
  if(r && r.ok===false) alert('書込み開始に失敗: '+r.error);
  setBusy(false);
}
async function poll(){
  try{
    const r = await fetch('/api/status').then(x=>x.json());
    document.getElementById('status').textContent = statusEmoji(r.status)+' '+r.statusMsg;
    // 起動中セッションと入力欄のズレを可視化する
    const sess=document.getElementById('session');
    if(r.session){
      const p=document.getElementById('page').value, m=document.getElementById('month').value;
      const diff=(String(r.session.page)!==String(p))||(r.session.month!==m);
      sess.textContent='起動中: '+r.session.page+'ページ / '+r.session.month
        +(diff?'  ⚠️ 入力欄('+p+'ページ / '+m+')と違います → 書き込みは入力欄の方を使います':'');
      sess.style.color=diff?'#fbbf24':'#94a3b8';
    } else {
      sess.textContent='未起動';
      sess.style.color='#94a3b8';
    }
    document.getElementById('log').textContent = r.log.join('\\n');
    document.getElementById('log').scrollTop = 9e9;
    // preview
    if(r.preview && r.preview.length){
      document.getElementById('previewSummary').textContent = '書込み対象 '+r.preview.length+'日 (タップで展開)';
      document.getElementById('preview').innerHTML = r.preview.map(d=>
        '<div class="day"><b>'+d.date+'日('+d.weekday+')</b> cell('+d.r+','+d.c+') : '+d.lines.join(' / ')+'</div>').join('');
    }
    // 書込み中はスクショ自動更新
    if(r.status==='writing' && !shotTimer){ shotTimer=setInterval(refreshShot,2000); }
    if(r.status!=='writing' && shotTimer){ clearInterval(shotTimer); shotTimer=null; }
  }catch(e){}
}
function statusEmoji(s){return ({idle:'⚪',launching:'🟡',ready:'🟢',writing:'🔵',done:'✅',error:'🔴'})[s]||'⚪';}
statusTimer=setInterval(poll,1000); poll();
</script>
</body></html>`;
}

// ============================================================
// ルーティング
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // ALB ヘルスチェック (認証不要)
  if (p === "/healthz") {
    return sendJSON(res, 200, { ok: true, status: state.status });
  }

  // ログイン
  if (p === "/login" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    if (params.get("password") === PASSWORD) {
      res.writeHead(302, { "Set-Cookie": `auth=${SESSION_TOKEN}; HttpOnly; Path=/; Max-Age=86400`, "Location": "/" });
      res.end();
    } else {
      sendHTML(res, 401, loginPage("パスワードが違います"));
    }
    return;
  }

  // 認証チェック
  if (!isAuthed(req)) {
    sendHTML(res, 200, loginPage(""));
    return;
  }

  // 認証済ルート
  try {
    if (p === "/" && req.method === "GET") {
      return sendHTML(res, 200, controlPage());
    }
    if (p === "/api/status" && req.method === "GET") {
      return sendJSON(res, 200, {
        status: state.status, statusMsg: state.statusMsg,
        log: state.log, summary: state.summary, preview: state.preview,
        session: state.context ? { page: state.pageNumber, month: state.month } : null,
      });
    }
    if (p === "/api/screenshot" && req.method === "GET") {
      if (!state.page) { res.writeHead(404); return res.end(); }
      const buf = await state.page.screenshot({ type: "jpeg", quality: 55 }).catch(() => null);
      if (!buf) { res.writeHead(503); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
      return res.end(buf);
    }
    if (p === "/api/start" && req.method === "POST") {
      const { page, month } = JSON.parse(await readBody(req) || "{}");
      await actionStart(parseInt(page, 10), month);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/nav" && req.method === "POST") {
      const { dir } = JSON.parse(await readBody(req) || "{}");
      await actionNav(dir);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/goto" && req.method === "POST") {
      const { page } = JSON.parse(await readBody(req) || "{}");
      await actionGoto(parseInt(page, 10));
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/write" && req.method === "POST") {
      const { page, month } = JSON.parse(await readBody(req) || "{}");
      // 非同期で実行 (即返す)。 進捗は /api/status で確認
      actionWrite(page ? parseInt(page, 10) : null, month || null).catch((e) => {
        state.status = "error"; state.statusMsg = e.message; pushLog("❌ " + e.message);
      });
      return sendJSON(res, 200, { ok: true, started: true });
    }
    if (p === "/api/close" && req.method === "POST") {
      await actionClose();
      return sendJSON(res, 200, { ok: true });
    }
    // ---- リモート操作 (Canva ログイン用) ----
    if (p === "/api/login/launch" && req.method === "POST") {
      await actionLaunchForLogin();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/remote/click" && req.method === "POST") {
      const { x, y } = JSON.parse(await readBody(req) || "{}");
      await actionRemoteClick(x, y);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/remote/type" && req.method === "POST") {
      const { text } = JSON.parse(await readBody(req) || "{}");
      await actionRemoteType(text);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/remote/key" && req.method === "POST") {
      const { key } = JSON.parse(await readBody(req) || "{}");
      await actionRemoteKey(key);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/remote/open" && req.method === "POST") {
      const { url: target } = JSON.parse(await readBody(req) || "{}");
      await actionRemoteOpen(target);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === "/api/session/save" && req.method === "POST") {
      await actionSaveSession();
      return sendJSON(res, 200, { ok: true });
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("============================================================");
  console.log("📅 Canva 書込み Web コントロール 起動");
  console.log("============================================================");
  console.log(`  ローカル:     http://localhost:${PORT}`);
  console.log(`  パスワード:   ${PASSWORD}`);
  if (!process.env.CANVA_WEB_PASSWORD) {
    console.log("  ※ パスワードは自動生成。 固定したい場合は CANVA_WEB_PASSWORD=xxx で起動");
  }
  console.log("");
  if (CLOUD_MODE) {
    console.log(`  AWSモード: ログイン状態は s3://${process.env.CANVA_SESSION_BUCKET}/${cloud.SESSION_KEY}`);
    console.log(`  プロファイル: ${PROFILE_DIR}`);
  } else {
    console.log("  外部公開 (別ターミナルで実行):");
    console.log(`    ngrok http ${PORT}`);
    console.log("    → 表示される https://xxxx.ngrok-free.app を相手に共有");
  }
  console.log("============================================================");
});

// コンテナ停止 (SIGTERM) 時はログイン状態を保存してから終了する
process.on("SIGTERM", async () => {
  try { await actionClose(); } catch {}
  process.exit(0);
});
