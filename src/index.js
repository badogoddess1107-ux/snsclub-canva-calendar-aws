// メインスクリプト: Googleカレンダー(ICS)から指定年月のデータを取得してJSON出力
// 使い方: node src/index.js <年> <月>
// 例:     node src/index.js 2026 5

const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");
const { parseIcs } = require("./icsParser");
const { buildDay, mergeDays } = require("./buildDayData");

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("使い方: node src/index.js <年> <月>");
    console.error("例:     node src/index.js 2026 5");
    process.exit(1);
  }

  const year = parseInt(args[0], 10);
  const month = parseInt(args[1], 10);

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    console.error("年月は数値で指定してください");
    process.exit(1);
  }

  const res = await fetch(config.calendar.icsUrl);
  if (!res.ok) {
    console.error(`取得失敗: HTTP ${res.status}`);
    console.error("→ ICS URLが「公開URL」になっているか確認してください");
    process.exit(1);
  }

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

  const days = mergeDays(rawDays);

  const output = {
    year,
    month,
    generatedAt: new Date().toISOString(),
    dayCount: days.length,
    days,
  };

  const outDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${year}-${String(month).padStart(2, "0")}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`✅ 出力: ${outPath}`);
  console.log(`  - ${days.length}日分のデータを生成 (イベント総数: ${events.length})`);
  console.log("");
  console.log("=== 先頭5日分のサンプル ===");
  days.slice(0, 5).forEach((d) => {
    console.log(`[${d.date}日(${d.weekday})] ${d.isSpecial ? "★特別日" : ""}`);
    d.lines.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
    console.log("");
  });

  // 🎨 色マップ
  console.log("");
  console.log("🎨 色マップ (各マスの色バンド ─ 上から下の順):");
  for (const d of days) {
    const bands = (d.colorBands || []).map((b) => {
      if (b.kind === "solid") return `${b.label}=${b.color}`;
      if (b.kind === "gradient") return `${b.label}=grad[${b.colors.join("→")}]`;
      return `${b.label}=??`;
    });
    console.log(`  ${String(d.date).padStart(2)}日(${d.weekday}): ${bands.join(" / ")}`);
  }
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
