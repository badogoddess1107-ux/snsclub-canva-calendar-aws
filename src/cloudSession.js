// ============================================================
// cloudSession.js — AWS で動かすためのセッション共有とリモート操作の補助
// ============================================================
// Mac で動かしていた頃は .browser-profile (Chromium プロファイル) にログイン状態が
// 残っていた。 AWS (Fargate) ではコンテナが入れ替わるたびにプロファイルが消えるため、
// Cookie / localStorage (Playwright の storageState) を S3 に保存して復元する。
//
//   CANVA_SESSION_BUCKET が設定されているときだけ有効。 未設定なら従来通り (Mac 運用)。
//
// また、 Canva のログイン (メール認証など) を Web UI の画面越しに人が行えるよう、
// スクショ上のクリック座標を実画面座標に変換する純粋関数も置く。
const SESSION_KEY = "session/canva-storageState.json";
const CANVA_DOMAIN = "canva.com";

function sessionEnabled(env = process.env) {
  return Boolean(env.CANVA_SESSION_BUCKET);
}

function makeS3(env = process.env) {
  // 遅延 require: Mac 運用では aws-sdk を読み込まない
  const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client({});
  const bucket = env.CANVA_SESSION_BUCKET;
  return {
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) {
        if (e.name === "NoSuchKey" || (e.$metadata && e.$metadata.httpStatusCode === 404)) return null;
        throw e;
      }
    },
    async put(key, body, contentType = "application/octet-stream") {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
  };
}

/** S3 から storageState を読む。 無ければ null */
async function loadSessionState(env = process.env, s3 = makeS3(env)) {
  const buf = await s3.get(SESSION_KEY);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/** storageState を S3 に保存する */
async function saveSessionState(state, env = process.env, s3 = makeS3(env)) {
  await s3.put(SESSION_KEY, JSON.stringify(state), "application/json");
}

/** storageState に Canva のログイン Cookie が含まれているか（純粋関数） */
function hasCanvaLogin(state) {
  if (!state || !Array.isArray(state.cookies)) return false;
  return state.cookies.some((c) => String(c.domain || "").includes(CANVA_DOMAIN));
}

/**
 * 永続コンテキストに storageState を流し込む。
 * launchPersistentContext は storageState オプションを受け付けないため、
 * Cookie は addCookies、 localStorage は各 origin を開いて書き込む。
 */
async function applySessionToContext(context, state) {
  if (!state) return { cookies: 0, origins: 0 };
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  if (cookies.length) await context.addCookies(cookies);
  const origins = Array.isArray(state.origins) ? state.origins : [];
  let applied = 0;
  for (const o of origins) {
    if (!o.origin || !Array.isArray(o.localStorage) || o.localStorage.length === 0) continue;
    const page = await context.newPage();
    try {
      await page.goto(o.origin, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.evaluate((items) => {
        for (const { name, value } of items) localStorage.setItem(name, value);
      }, o.localStorage);
      applied++;
    } catch {
      /* origin が開けなくても Cookie だけで足りることが多いので続行 */
    } finally {
      await page.close().catch(() => {});
    }
  }
  return { cookies: cookies.length, origins: applied };
}

/**
 * スクショ上の座標を実画面(CSS px)座標に変換する（純粋関数）。
 * Retina Mac ではスクショが 2 倍解像度になるため devicePixelRatio で割る。
 * 範囲外・不正値は null。
 */
function toPageCoords(x, y, dpr, shot) {
  const nx = Number(x), ny = Number(y), r = Number(dpr) || 1;
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || r <= 0) return null;
  if (shot && (nx < 0 || ny < 0 || nx > shot.width || ny > shot.height)) return null;
  return { x: nx / r, y: ny / r };
}

/** リモート操作で許可するキー（任意の文字列を keyboard.press に流さない） */
const ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Space",
]);
function isAllowedKey(key) {
  return ALLOWED_KEYS.has(String(key));
}

module.exports = {
  SESSION_KEY,
  sessionEnabled,
  makeS3,
  loadSessionState,
  saveSessionState,
  hasCanvaLogin,
  applySessionToContext,
  toPageCoords,
  isAllowedKey,
  ALLOWED_KEYS,
};
