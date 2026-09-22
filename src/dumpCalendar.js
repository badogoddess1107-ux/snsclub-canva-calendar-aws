// カレンダーICSの中身を確認するための最小スクリプト
// 使い方: node src/dumpCalendar.js
const config = require("../config");
const { parseIcs } = require("./icsParser");

async function main() {
  console.log("=== 取得URL ===");
  console.log(config.calendar.icsUrl);
  console.log("");

  const res = await fetch(config.calendar.icsUrl);
  if (!res.ok) {
    console.error(`取得失敗: HTTP ${res.status}`);
    console.error("→ ICS URLが「公開URL」になっているか確認してください");
    process.exit(1);
  }

  const text = await res.text();
  console.log("=== 生ICS（先頭500文字） ===");
  console.log(text.slice(0, 500));
  console.log("");

  const events = parseIcs(text);
  console.log(`=== イベント数: ${events.length} ===`);
  console.log("");

  console.log("=== 先頭10件 ===");
  events.slice(0, 10).forEach((ev, i) => {
    const s = ev.start;
    const dt = s
      ? `${s.year}/${String(s.month).padStart(2, "0")}/${String(s.day).padStart(2, "0")} ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}${s.allDay ? " (終日)" : ""}`
      : "(start未取得)";
    console.log(`[${i + 1}] ${dt}`);
    console.log(`    ${ev.summary || "(SUMMARY無し)"}`);
  });
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
