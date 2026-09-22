// スケジュール実行用ブラウザプロファイルの管理
//
// 背景:
//   webServer.js (常時稼働のWeb UI) と runScheduled.js (毎月25日の自動実行) が
//   同じ .browser-profile を使っていた。 Chromium はプロファイルを1プロセスしか
//   掴めないため、 Web UI 側でブラウザを開いたまま自動実行の時刻を迎えると
//   launchPersistentContext が Timeout 180000ms exceeded で落ちる。
//
// 対策:
//   自動実行には専用プロファイル (.browser-profile-scheduled) を与える。
//   初回だけ本体プロファイルからログイン情報を複製し、 以降は独立して動く。
//   キャッシュ類 (900MB超) は複製しないので、 コピーは数MBで済む。

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// 複製から除外するエントリ。
//   キャッシュ類: 再生成されるので不要。 これを外さないと約950MBの複製になる。
//   Singleton*  : 起動中のプロセスが作るロック。 複製すると新プロファイルが起動できない。
const EXCLUDED_ENTRIES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "component_crx_cache",
  "extensions_crx_cache",
  "BrowserMetrics",
  "Safe Browsing",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
];

// 複製対象かどうか。 プロファイルルートからの相対パスを受け取る。
function shouldCopyEntry(relativePath) {
  if (!relativePath) return true; // ルート自身
  return !relativePath
    .split(path.sep)
    .some((segment) => EXCLUDED_ENTRIES.includes(segment));
}

// Chromium が起動中かどうか。 起動中は SingletonLock (シンボリックリンク) が存在する。
// 参照先は切れていることがあるため、 lstat で リンク自体の有無を見る。
function isProfileLocked(profileDir) {
  try {
    fs.lstatSync(path.join(profileDir, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}

// 本体プロファイルから複製する（キャッシュ・ロックは除く）。
function seedProfile(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`複製元のプロファイルが見つかりません: ${sourceDir}`);
  }
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => shouldCopyEntry(path.relative(sourceDir, src)),
  });
}

// 自動実行用プロファイルを用意する。 無ければ初回複製する。
// 戻り値: { dir: 使用するプロファイルパス, seeded: 今回複製したか }
function prepareScheduledProfile({ baseDir, mainProfile, scheduledProfile }) {
  const source = path.resolve(baseDir, mainProfile);
  const target = path.resolve(baseDir, scheduledProfile);
  const seeded = !fs.existsSync(target);
  if (seeded) {
    seedProfile(source, target);
  }
  return { dir: target, seeded };
}

// ------------------------------------------------------------
// プロファイルの占有解除
//
// 背景:
//   ホストのMacに Chromium が開いたまま残っていると (ダイアログ待ちで放置された等)、
//   次の起動が "Failed to create a ProcessSingleton for your profile directory" で
//   失敗する。 リモートから操作している人には原因が分からないため、
//   起動前に自動で後始末する。
// ------------------------------------------------------------

// SingletonLock のリンク先 "ホスト名-12345" から PID を取り出す。
function parseLockPid(linkTarget) {
  if (typeof linkTarget !== "string") return null;
  const m = linkTarget.trim().match(/-(\d+)$/);
  if (!m) return null;
  const pid = parseInt(m[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// プロセスが生きているか。 シグナル0は存在確認のみで、 相手に影響を与えない。
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 権限が無いだけなら生きている
  }
}

// Chromium 実行ファイルの目印。 単に "chrome" を含むだけの行 (grep や
// シェルスクリプト自身) を巻き込んで kill しないよう、 実行パスの形で判定する。
const CHROMIUM_BINARY_PATTERN =
  /(Google Chrome for Testing|Chromium\.app|chrome-mac|\/(chrome|chromium)\b)/i;

// ps の出力から、 該当プロファイルを掴んでいる Chromium の PID を抜き出す。
// 文字列処理として切り出してあるのでテストしやすい。
function extractHolderPids(psOutput, profileDir) {
  // 末尾に区切りを要求し、 ".browser-profile" が ".browser-profile-scheduled" に
  // 前方一致してしまう事故を防ぐ。
  const needle = `--user-data-dir=${profileDir}`;
  return String(psOutput)
    .split("\n")
    .filter((line) => {
      const at = line.indexOf(needle);
      if (at === -1) return false;
      const nextChar = line[at + needle.length];
      if (nextChar !== undefined && !/[\s"']/.test(nextChar)) return false;
      return CHROMIUM_BINARY_PATTERN.test(line);
    })
    .map((line) => parseInt(line.trim().split(/\s+/)[0], 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

// 実際に ps を叩いて占有プロセスを探す。
function findProfileHolders(profileDir) {
  try {
    const out = execFileSync("/bin/ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return extractHolderPids(out, path.resolve(profileDir));
  } catch {
    return [];
  }
}

// 死んだプロセスが残したロックファイルを削除する。 生きている場合は触らない。
// 戻り値: 削除したら true
function clearStaleLock(profileDir) {
  const lockPath = path.join(profileDir, "SingletonLock");
  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return false; // ロックが無い、 またはシンボリックリンクでない
  }
  const pid = parseLockPid(target);
  if (pid !== null && isProcessAlive(pid)) {
    return false; // 使用中なので残す
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.unlinkSync(path.join(profileDir, name));
    } catch {
      /* 無ければ無視 */
    }
  }
  return true;
}

// プロファイルを掴んでいる Chromium を終了させ、 ロックも片付ける。
// 対象は --user-data-dir がこのプロファイルを指すプロセスだけなので、
// 利用者が普段使っている Chrome や他のブラウザには影響しない。
// 戻り値: { killed: PID配列, clearedLock: boolean }
function releaseProfile(profileDir, { waitMs = 2000 } = {}) {
  const dir = path.resolve(profileDir);
  const killed = [];
  for (const pid of findProfileHolders(dir)) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      /* 既に終了している */
    }
  }
  if (killed.length > 0) {
    // SIGTERM で落ちきらないものに備えて少し待ってから SIGKILL
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && killed.some((pid) => isProcessAlive(pid))) {
      try {
        execFileSync("/bin/sleep", ["0.2"]);
      } catch {
        break;
      }
    }
    for (const pid of killed.filter((p) => isProcessAlive(p))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 既に終了している */
      }
    }
  }
  return { killed, clearedLock: clearStaleLock(dir) };
}

// 起動失敗がプロファイル占有によるものか判定する。
function isProfileInUseError(error) {
  const msg = String(error && error.message ? error.message : error);
  return (
    msg.includes("ProcessSingleton") ||
    msg.includes("profile is already in use") ||
    msg.includes("Failed to create a ProcessSingleton")
  );
}

module.exports = {
  EXCLUDED_ENTRIES,
  shouldCopyEntry,
  isProfileLocked,
  seedProfile,
  prepareScheduledProfile,
  parseLockPid,
  isProcessAlive,
  extractHolderPids,
  findProfileHolders,
  clearStaleLock,
  releaseProfile,
  isProfileInUseError,
};
