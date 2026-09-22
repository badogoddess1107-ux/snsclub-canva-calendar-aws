// node --test __tests__/browserProfile.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  shouldCopyEntry,
  isProfileLocked,
  seedProfile,
  prepareScheduledProfile,
  parseLockPid,
  isProcessAlive,
  extractHolderPids,
  clearStaleLock,
  isProfileInUseError,
} = require("../src/browserProfile");

// ヘルパー: 一時ディレクトリを作る
function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `profile-${label}-`));
}

// ヘルパー: リンク切れのシンボリックリンクも「有る」と判定する
// (existsSync はリンク先を追うため、 SingletonLock の検証には使えない)
function linkExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ヘルパー: 疑似プロファイルを組み立てる
function makeProfile(dir) {
  fs.mkdirSync(path.join(dir, "Default", "Local Storage"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Default", "Cache"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Default", "Code Cache"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Local State"), "state");
  fs.writeFileSync(path.join(dir, "Default", "Cookies"), "cookie");
  fs.writeFileSync(path.join(dir, "Default", "Local Storage", "leveldb.log"), "ls");
  fs.writeFileSync(path.join(dir, "Default", "Cache", "big.bin"), "x".repeat(1000));
  fs.writeFileSync(path.join(dir, "Default", "Code Cache", "big.bin"), "x".repeat(1000));
  return dir;
}

test("shouldCopyEntry: ログイン情報は複製対象", () => {
  assert.strictEqual(shouldCopyEntry("Local State"), true);
  assert.strictEqual(shouldCopyEntry(path.join("Default", "Cookies")), true);
  assert.strictEqual(
    shouldCopyEntry(path.join("Default", "Local Storage", "leveldb.log")),
    true,
  );
});

test("shouldCopyEntry: キャッシュ類は除外", () => {
  assert.strictEqual(shouldCopyEntry(path.join("Default", "Cache")), false);
  assert.strictEqual(shouldCopyEntry(path.join("Default", "Cache", "big.bin")), false);
  assert.strictEqual(shouldCopyEntry(path.join("Default", "Code Cache")), false);
  assert.strictEqual(shouldCopyEntry("GPUCache"), false);
});

test("shouldCopyEntry: ロックファイルは除外（複製すると起動不能になるため）", () => {
  assert.strictEqual(shouldCopyEntry("SingletonLock"), false);
  assert.strictEqual(shouldCopyEntry("SingletonSocket"), false);
  assert.strictEqual(shouldCopyEntry("SingletonCookie"), false);
});

test("shouldCopyEntry: ルート自身は対象", () => {
  assert.strictEqual(shouldCopyEntry(""), true);
});

test("seedProfile: ログイン情報だけが複製される", () => {
  const src = makeProfile(tmpDir("src"));
  const dst = path.join(tmpDir("dst"), "copied");

  seedProfile(src, dst);

  assert.ok(fs.existsSync(path.join(dst, "Local State")), "Local State が複製される");
  assert.ok(fs.existsSync(path.join(dst, "Default", "Cookies")), "Cookies が複製される");
  assert.ok(
    fs.existsSync(path.join(dst, "Default", "Local Storage", "leveldb.log")),
    "Local Storage が複製される",
  );
  assert.ok(!fs.existsSync(path.join(dst, "Default", "Cache")), "Cache は複製されない");
  assert.ok(
    !fs.existsSync(path.join(dst, "Default", "Code Cache")),
    "Code Cache は複製されない",
  );
});

test("seedProfile: 複製元が無ければエラー", () => {
  const missing = path.join(tmpDir("none"), "not-exist");
  assert.throws(() => seedProfile(missing, path.join(tmpDir("out"), "x")), /複製元/);
});

test("isProfileLocked: SingletonLock の有無で判定する", () => {
  const dir = tmpDir("lock");
  assert.strictEqual(isProfileLocked(dir), false);

  // Chromium は存在しない宛先へのシンボリックリンクとしてロックを作る
  fs.symlinkSync("host-1234", path.join(dir, "SingletonLock"));
  assert.strictEqual(isProfileLocked(dir), true);
});

test("prepareScheduledProfile: 初回は複製し、2回目は複製しない", () => {
  const base = tmpDir("base");
  makeProfile(path.join(base, ".browser-profile"));

  const first = prepareScheduledProfile({
    baseDir: base,
    mainProfile: ".browser-profile",
    scheduledProfile: ".browser-profile-scheduled",
  });
  assert.strictEqual(first.seeded, true, "初回は複製する");
  assert.ok(fs.existsSync(path.join(first.dir, "Default", "Cookies")));

  // 2回目は既存を使う（複製で上書きしない）
  fs.writeFileSync(path.join(first.dir, "Default", "Cookies"), "更新後のcookie");
  const second = prepareScheduledProfile({
    baseDir: base,
    mainProfile: ".browser-profile",
    scheduledProfile: ".browser-profile-scheduled",
  });
  assert.strictEqual(second.seeded, false, "2回目は複製しない");
  assert.strictEqual(second.dir, first.dir);
  assert.strictEqual(
    fs.readFileSync(path.join(second.dir, "Default", "Cookies"), "utf8"),
    "更新後のcookie",
    "既存プロファイルが上書きされない",
  );
});

// ------------------------------------------------------------
// プロファイル占有の検知と解除
// ------------------------------------------------------------

test("parseLockPid: SingletonLock のリンク先から PID を取る", () => {
  assert.strictEqual(parseLockPid("macbook-air-12345"), 12345);
  assert.strictEqual(parseLockPid("my-host-name-987"), 987);
  assert.strictEqual(parseLockPid("壊れた値"), null);
  assert.strictEqual(parseLockPid(null), null);
});

test("isProcessAlive: 自プロセスは生存、 存在しないPIDは死亡", () => {
  assert.strictEqual(isProcessAlive(process.pid), true);
  assert.strictEqual(isProcessAlive(2147483646), false);
});

test("extractHolderPids: 該当プロファイルを掴むChromiumだけ拾う", () => {
  const dir = "/Users/me/proj/.browser-profile";
  const ps = [
    ` 111 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ` 222 /path/Google Chrome for Testing --user-data-dir=${dir} --no-sandbox`,
    ` 333 /path/Google Chrome for Testing --user-data-dir=${dir}-scheduled`,
    ` 444 node src/webServer.js`,
  ].join("\n");

  const pids = extractHolderPids(ps, dir);
  assert.ok(pids.includes(222), "対象プロファイルのChromiumを検出する");
  assert.ok(!pids.includes(111), "普段使いのChromeは対象外");
  assert.ok(!pids.includes(444), "Chromium以外は対象外");
});

test("extractHolderPids: 別プロファイル(-scheduled)を巻き込まない", () => {
  const dir = "/Users/me/proj/.browser-profile";
  const ps = [
    ` 333 /path/chrome-mac/Google Chrome for Testing --user-data-dir=${dir}-scheduled --no-sandbox`,
    ` 555 /path/chrome-mac/Google Chrome for Testing --user-data-dir=${dir} --no-sandbox`,
  ].join("\n");

  // 前方一致で誤検出すると、 Web UI 側の操作で自動実行側を巻き添えに殺してしまう
  assert.deepStrictEqual(extractHolderPids(ps, dir), [555], "本体だけを対象にする");
  assert.deepStrictEqual(
    extractHolderPids(ps, `${dir}-scheduled`),
    [333],
    "自動実行側だけを対象にする",
  );
});

test("extractHolderPids: grepやシェル自身を巻き込まない", () => {
  const dir = "/Users/me/proj/.browser-profile";
  // ps には自分が今実行した grep やスクリプトも並ぶ。 これをkillしてはいけない。
  const ps = [
    ` 777 grep -- --user-data-dir=${dir} `,
    ` 888 /bin/zsh -c ps -Ao command= | grep --user-data-dir=${dir}`,
    ` 999 /path/chrome-mac/Google Chrome for Testing --user-data-dir=${dir} --no-sandbox`,
  ].join("\n");

  assert.deepStrictEqual(extractHolderPids(ps, dir), [999], "Chromium実行ファイルのみ");
});

test("clearStaleLock: 死んだプロセスのロックは削除する", () => {
  const dir = tmpDir("stale");
  fs.symlinkSync("some-host-2147483646", path.join(dir, "SingletonLock"));
  fs.writeFileSync(path.join(dir, "SingletonCookie"), "x");

  assert.strictEqual(clearStaleLock(dir), true);
  assert.strictEqual(linkExists(path.join(dir, "SingletonLock")), false);
  assert.strictEqual(linkExists(path.join(dir, "SingletonCookie")), false);
});

test("clearStaleLock: 生きているプロセスのロックは残す", () => {
  const dir = tmpDir("live");
  fs.symlinkSync(`some-host-${process.pid}`, path.join(dir, "SingletonLock"));

  assert.strictEqual(clearStaleLock(dir), false, "使用中は消さない");
  assert.ok(linkExists(path.join(dir, "SingletonLock")));
});

test("clearStaleLock: ロックが無ければ何もしない", () => {
  assert.strictEqual(clearStaleLock(tmpDir("nolock")), false);
});

test("isProfileInUseError: 占有エラーだけを見分ける", () => {
  const real = new Error(
    "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory.",
  );
  assert.strictEqual(isProfileInUseError(real), true);
  assert.strictEqual(isProfileInUseError(new Error("Timeout 180000ms exceeded")), false);
});

test("prepareScheduledProfile: 本体と別ディレクトリを返す", () => {
  const base = tmpDir("sep");
  makeProfile(path.join(base, ".browser-profile"));

  const result = prepareScheduledProfile({
    baseDir: base,
    mainProfile: ".browser-profile",
    scheduledProfile: ".browser-profile-scheduled",
  });
  assert.notStrictEqual(result.dir, path.join(base, ".browser-profile"));
  assert.strictEqual(result.dir, path.join(base, ".browser-profile-scheduled"));
});
