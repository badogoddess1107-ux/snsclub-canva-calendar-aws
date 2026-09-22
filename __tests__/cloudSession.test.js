// node --test __tests__/cloudSession.test.js
const test = require("node:test");
const assert = require("node:assert");
const {
  sessionEnabled,
  hasCanvaLogin,
  toPageCoords,
  isAllowedKey,
  loadSessionState,
  saveSessionState,
  SESSION_KEY,
} = require("../src/cloudSession");

test("sessionEnabled: CANVA_SESSION_BUCKET があるときだけ AWS モード", () => {
  assert.strictEqual(sessionEnabled({}), false);
  assert.strictEqual(sessionEnabled({ CANVA_SESSION_BUCKET: "" }), false);
  assert.strictEqual(sessionEnabled({ CANVA_SESSION_BUCKET: "my-bucket" }), true);
});

test("hasCanvaLogin: canva.com の Cookie があれば true", () => {
  assert.strictEqual(hasCanvaLogin(null), false);
  assert.strictEqual(hasCanvaLogin({ cookies: [] }), false);
  assert.strictEqual(hasCanvaLogin({ cookies: [{ domain: "example.com" }] }), false);
  assert.strictEqual(hasCanvaLogin({ cookies: [{ domain: ".canva.com", name: "CID" }] }), true);
  assert.strictEqual(hasCanvaLogin({ cookies: [{ domain: "www.canva.com" }] }), true);
});

test("toPageCoords: devicePixelRatio で割る（Retina 2倍 → 半分）", () => {
  assert.deepStrictEqual(toPageCoords(200, 100, 2), { x: 100, y: 50 });
  assert.deepStrictEqual(toPageCoords(200, 100, 1), { x: 200, y: 100 });
  assert.deepStrictEqual(toPageCoords("30", "40", undefined), { x: 30, y: 40 }, "dpr 未指定は 1 扱い");
});

test("toPageCoords: 不正値・範囲外は null", () => {
  assert.strictEqual(toPageCoords("a", 1, 1), null);
  assert.deepStrictEqual(toPageCoords(1, 1, 0), { x: 1, y: 1 }, "dpr 0 (取得失敗) は 1 扱い");
  assert.strictEqual(toPageCoords(1, 1, -1), null, "負の dpr は不正");
  assert.strictEqual(toPageCoords(-1, 1, 1, { width: 100, height: 100 }), null);
  assert.strictEqual(toPageCoords(101, 1, 1, { width: 100, height: 100 }), null);
  assert.deepStrictEqual(toPageCoords(100, 100, 1, { width: 100, height: 100 }), { x: 100, y: 100 });
});

test("isAllowedKey: 許可リストのキーだけ", () => {
  assert.strictEqual(isAllowedKey("Enter"), true);
  assert.strictEqual(isAllowedKey("Tab"), true);
  assert.strictEqual(isAllowedKey("F12"), false);
  assert.strictEqual(isAllowedKey("Control+A"), false);
  assert.strictEqual(isAllowedKey(""), false);
});

test("loadSessionState / saveSessionState: S3 を差し替えて往復できる（壊れたJSONは null）", async () => {
  const store = new Map();
  const fakeS3 = {
    async get(key) { return store.has(key) ? Buffer.from(store.get(key)) : null; },
    async put(key, body) { store.set(key, String(body)); },
  };
  const env = { CANVA_SESSION_BUCKET: "b" };
  assert.strictEqual(await loadSessionState(env, fakeS3), null);
  await saveSessionState({ cookies: [{ domain: ".canva.com" }], origins: [] }, env, fakeS3);
  assert.ok(store.has(SESSION_KEY));
  assert.deepStrictEqual(await loadSessionState(env, fakeS3), { cookies: [{ domain: ".canva.com" }], origins: [] });
  store.set(SESSION_KEY, "{broken");
  assert.strictEqual(await loadSessionState(env, fakeS3), null);
});

const { shouldExitForIdle, isUserActivity } = require("../src/cloudSession");
const MIN = 60 * 1000;

test("shouldExitForIdle: 無操作が指定分数を超えたら true", () => {
  assert.strictEqual(shouldExitForIdle({ lastActivityAt: 0, now: 60 * MIN, idleMinutes: 60, status: "idle" }), true);
  assert.strictEqual(shouldExitForIdle({ lastActivityAt: 0, now: 59 * MIN, idleMinutes: 60, status: "idle" }), false);
});

test("shouldExitForIdle: 書き込み中・起動中は止めない", () => {
  assert.strictEqual(shouldExitForIdle({ lastActivityAt: 0, now: 999 * MIN, idleMinutes: 60, status: "writing" }), false);
  assert.strictEqual(shouldExitForIdle({ lastActivityAt: 0, now: 999 * MIN, idleMinutes: 60, status: "launching" }), false);
  assert.strictEqual(shouldExitForIdle({ lastActivityAt: 0, now: 999 * MIN, idleMinutes: 60, status: "ready" }), true);
});

test("shouldExitForIdle: 0 以下・不正なら無効", () => {
  assert.strictEqual(shouldExitForIdle({ lastActivityAt: 0, now: 999 * MIN, idleMinutes: 0, status: "idle" }), false);
  assert.strictEqual(shouldExitForIdle({ lastActivityAt: 0, now: 999 * MIN, idleMinutes: "x", status: "idle" }), false);
});

test("isUserActivity: ポーリングとヘルスチェックは操作に数えない", () => {
  assert.strictEqual(isUserActivity("GET", "/api/status"), false);
  assert.strictEqual(isUserActivity("GET", "/healthz"), false);
  assert.strictEqual(isUserActivity("GET", "/"), true);
  assert.strictEqual(isUserActivity("POST", "/api/start"), true);
  assert.strictEqual(isUserActivity("POST", "/api/remote/click"), true);
  assert.strictEqual(isUserActivity("GET", "/api/screenshot"), true);
});
