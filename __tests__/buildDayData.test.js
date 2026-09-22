// node --test __tests__/buildDayData.test.js
const test = require("node:test");
const assert = require("node:assert");
const {
  buildDay,
  extractGenre,
  extractInstructor,
  mergeDays,
  COLOR_MAP,
  getColorBand,
  getEventColorKey,
} = require("../src/buildDayData");

// ヘルパー: ICSイベント形式オブジェクトを作る
function ev(summary, year, month, day, hour, minute) {
  return {
    summary,
    start: { year, month, day, hour, minute, allDay: false },
  };
}

// =========================================
// 修正1: ジャンル特化グルコン (フル表記)
// =========================================
test("ジャンル特化グルコン 通常日(月): D=ジャンル特化グルコン", () => {
  const e = ev(
    "【ジャンル特化グルコン】 きよ/富山おでかけ(スポット)",
    2026, 5, 4, 10, 0
  );
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "ジャンル特化グルコン");
  assert.deepStrictEqual(result.lines, [
    "4",
    "ジャンル特化グルコン",
    "スポット",
    "きよ",
    "10:00",
  ]);
});

test("ジャンル特化グルコン 1日(金): 成果報告が2番目", () => {
  const e = ev(
    "【ジャンル特化グルコン】 かな/17キロ痩せた韓国レシピ(レシピ)",
    2026, 5, 1, 12, 0
  );
  const result = buildDay(e, 2026, 5);
  assert.deepStrictEqual(result.lines, [
    "1",
    "成果報告",
    "ジャンル特化グルコン",
    "レシピ",
    "かな",
    "12:00",
  ]);
});

test("ジャンル特化グルコン 日曜(5/10): 週報提出が2番目", () => {
  const e = ev(
    "【ジャンル特化グルコン】 ひなた/薬剤師が作る食べ痩せレシピ(レシピ)",
    2026, 5, 10, 14, 0
  );
  const result = buildDay(e, 2026, 5);
  assert.deepStrictEqual(result.lines, [
    "10",
    "週報提出",
    "ジャンル特化グルコン",
    "レシピ",
    "ひなた",
    "14:00",
  ]);
});

test("ジャンル特化グルコン 1〜3日かつ日曜(5/3): 成果+週報両方", () => {
  const e = ev(
    "【ジャンル特化グルコン】 望月 涼介/居酒屋大将(レシピ)",
    2026, 5, 3, 21, 0
  );
  const result = buildDay(e, 2026, 5);
  assert.deepStrictEqual(result.lines, [
    "3",
    "成果報告",
    "週報提出",
    "ジャンル特化グルコン",
    "レシピ",
    "望月 涼介",
    "21:00",
  ]);
});

test("ジャンル特化グルコン 講師未記入は instructorMissing=true", () => {
  const e = ev("【ジャンル特化グルコン】富山おでかけ（スポット）", 2026, 5, 4, 21, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.instructorMissing, true);
});

// =========================================
// 修正2: 生徒対談
// =========================================
test("生徒対談: 日付/生徒対談/ゲスト/名前/時間", () => {
  const e = ev(
    "【生徒対談】イナ夫婦⌇元英語教員のリアル英会話",
    2026, 5, 30, 21, 0
  );
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "生徒対談");
  assert.deepStrictEqual(result.lines, [
    "30",
    "生徒対談",
    "ゲスト",
    "イナ夫婦",
    "21:00",
  ]);
});

test("生徒対談: 半角パイプ区切り", () => {
  const e = ev(
    "【生徒対談】ちゅん | 1食200円以下の冷凍ストック弁当",
    2026, 5, 31, 14, 0
  );
  const result = buildDay(e, 2026, 5);
  assert.deepStrictEqual(result.lines, [
    "31",
    "週報提出",
    "生徒対談",
    "ゲスト",
    "ちゅん",
    "14:00",
  ]);
});

// =========================================
// 修正3: 万垢生限定オン会
// =========================================
test("万垢生限定オン会: 日付/万垢生限定オン会/【in Zoom】/時間", () => {
  const e = ev("👑万垢生限定オン会", 2026, 5, 28, 21, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "万垢生限定オン会");
  assert.deepStrictEqual(result.lines, [
    "28",
    "万垢生限定オン会",
    "【in Zoom】",
    "21:00",
  ]);
});

// =========================================
// 修正4: SnsClub卒業生交流会
// =========================================
test("SnsClub卒業生交流会: 日付/イベント名/エリア/時間", () => {
  const e = ev("【SnsClub卒業生交流会】@東京", 2026, 5, 23, 18, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "SnsClub卒業生交流会");
  assert.deepStrictEqual(result.lines, [
    "23",
    "SnsClub卒業生交流会",
    "東京",
    "18:00",
  ]);
});

// =========================================
// 修正5: SnsClubオン会
// =========================================
test("SnsClubオン会: 日付/SnsClubオン会/【Zoom】/時間", () => {
  const e = ev("【SnsClubオン会】in Zoom", 2026, 5, 23, 21, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "SnsClubオン会");
  assert.deepStrictEqual(result.lines, [
    "23",
    "SnsClubオン会",
    "【Zoom】",
    "21:00",
  ]);
});

// =========================================
// 修正6: SnsClubオフ会
// =========================================
test("SnsClubオフ会: 日付/SnsClubオフ会/エリア/時間 (5/17は日曜なので週報提出も入る)", () => {
  const e = ev("【SnsClubオフ会】@名古屋", 2026, 5, 17, 14, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "SnsClubオフ会");
  assert.deepStrictEqual(result.lines, [
    "17",
    "週報提出",
    "SnsClubオフ会",
    "名古屋",
    "14:00",
  ]);
});

// =========================================
// 修正7: カイシャインさんスペシャルグルコン
// =========================================
test("カイシャインさんスペシャルグルコン: 6行+特別講義/ゲスト自動", () => {
  const e = ev("カイシャインさんスペシャルグルコン", 2026, 5, 13, 21, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "スペシャルグルコン");
  assert.deepStrictEqual(result.lines, [
    "13",
    "スペシャルグルコン",
    "【特別講義】",
    "ゲスト",
    "カイシャインさん",
    "21:00",
  ]);
});

// =========================================
// extractGenre / extractInstructor
// =========================================
test("extractGenre: 全角括弧最後", () => {
  assert.strictEqual(
    extractGenre("【ジャンル特化グルコン】タイトル（レシピ）"),
    "レシピ"
  );
});

test("extractInstructor: 講師キーワード優先", () => {
  assert.strictEqual(
    extractInstructor("【ジャンル特化グルコン】東京デートグルメ：ゆうと講師（スポット）"),
    "ゆうと講師"
  );
});

test("extractInstructor: 区切り無し+講師なし → 空", () => {
  assert.strictEqual(
    extractInstructor("【ジャンル特化グルコン】富山おでかけ（スポット）"),
    ""
  );
});

// =========================================
// 対象外イベント / エッジケース
// =========================================
// =========================================
// 修正9: 講師対談
// =========================================
test("講師対談: 日付/講師対談/ゲスト/名前/時間", () => {
  const e = ev("【講師対談】たつみ | 資産1000万を目指す26歳", 2026, 5, 21, 21, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "講師対談");
  assert.deepStrictEqual(result.lines, [
    "21",
    "講師対談",
    "ゲスト",
    "たつみ",
    "21:00",
  ]);
});

// =========================================
// 修正10: アイレポート講義
// =========================================
test("アイレポート講義: 日付/特別講義/アイレポート講義/時間", () => {
  const e = ev("【アイレポート講義】", 2026, 5, 29, 21, 0);
  const result = buildDay(e, 2026, 5);
  assert.strictEqual(result.eventType, "アイレポート講義");
  assert.deepStrictEqual(result.lines, [
    "29",
    "特別講義",
    "アイレポート講義",
    "21:00",
  ]);
});

test("空イベントはnull", () => {
  assert.strictEqual(buildDay(null, 2026, 5), null);
  assert.strictEqual(buildDay({}, 2026, 5), null);
});

test("対象外の月はnull", () => {
  const e = ev("【ジャンル特化グルコン】 講師/タイトル(レシピ)", 2026, 6, 1, 10, 0);
  assert.strictEqual(buildDay(e, 2026, 5), null);
});

test("終日イベントはnull", () => {
  const e = {
    summary: "【ジャンル特化グルコン】 講師/タイトル(レシピ)",
    start: { year: 2026, month: 5, day: 1, hour: 0, minute: 0, allDay: true },
  };
  assert.strictEqual(buildDay(e, 2026, 5), null);
});

// =========================================
// mergeDays: 異種混在
// =========================================
test("mergeDays: ジャンル特化 + 生徒対談 同日(5/30 土)", () => {
  // 5/30(土) ジャンル特化 14:00 + 生徒対談 21:00
  const r1 = buildDay(
    ev("【ジャンル特化グルコン】 たろう/サブ(レシピ)", 2026, 5, 30, 14, 0),
    2026, 5
  );
  const r2 = buildDay(
    ev("【生徒対談】イナ夫婦⌇英会話", 2026, 5, 30, 21, 0),
    2026, 5
  );
  const result = mergeDays([r1, r2]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].hasMultiple, true);
  assert.deepStrictEqual(result[0].lines, [
    "30",
    "ジャンル特化グルコン", "レシピ", "たろう", "14:00",
    "生徒対談", "ゲスト", "イナ夫婦", "21:00",
  ]);
});

test("mergeDays: 1日に1件ならそのまま (フル表記)", () => {
  const day1 = buildDay(
    ev("【ジャンル特化グルコン】 きよ/富山(スポット)", 2026, 5, 4, 10, 0),
    2026, 5
  );
  const result = mergeDays([day1]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].hasMultiple, false);
  assert.deepStrictEqual(result[0].lines, [
    "4", "ジャンル特化グルコン", "スポット", "きよ", "10:00",
  ]);
});

// =========================================
// 修正11: 色マップ
// =========================================
test("色: ジャンル特化グルコン (通常ジャンル) → solid orange", () => {
  const day = buildDay(
    ev("【ジャンル特化グルコン】 きよ/タイトル(レシピ)", 2026, 5, 4, 10, 0),
    2026, 5
  );
  assert.strictEqual(getEventColorKey(day), "ジャンル特化グルコン");
  const merged = mergeDays([day]);
  assert.deepStrictEqual(merged[0].colorBands, [
    { kind: "solid", color: "#ffc259", label: "ジャンル特化グルコン" },
  ]);
});

test("色: ジャンル特化グルコン (台本特化) → gradient", () => {
  const day = buildDay(
    ev("【ジャンル特化グルコン】 ひなたく/夫婦(台本特化)", 2026, 5, 5, 12, 0),
    2026, 5
  );
  assert.strictEqual(getEventColorKey(day), "ジャンル特化グルコン_台本");
  const merged = mergeDays([day]);
  assert.strictEqual(merged[0].colorBands[0].kind, "gradient");
  assert.deepStrictEqual(merged[0].colorBands[0].colors, ["#fe8356", "#ffee22", "#a4f402"]);
});

test("色: ジャンル特化グルコン (ストーリー特化) → gradient", () => {
  const day = buildDay(
    ev("【ジャンル特化グルコン】 あみり|ストーリー(ストーリー特化)", 2026, 5, 12, 12, 0),
    2026, 5
  );
  assert.strictEqual(getEventColorKey(day), "ジャンル特化グルコン_ストーリー");
});

test("色: 1日(金)は 成果報告(red) + ジャンル特化グルコン(orange)", () => {
  const day = buildDay(
    ev("【ジャンル特化グルコン】 かな/タイトル(レシピ)", 2026, 5, 1, 12, 0),
    2026, 5
  );
  const merged = mergeDays([day]);
  assert.deepStrictEqual(
    merged[0].colorBands.map((b) => ({ label: b.label, color: b.color })),
    [
      { label: "成果報告", color: "#ff5757" },
      { label: "ジャンル特化グルコン", color: "#ffc259" },
    ]
  );
});

test("色: 5/3(日,1-3日) は 成果報告 + 週報提出 + イベント色 (3バンド)", () => {
  const day = buildDay(
    ev("【ジャンル特化グルコン】 講師/タイトル(レシピ)", 2026, 5, 3, 12, 0),
    2026, 5
  );
  const merged = mergeDays([day]);
  assert.strictEqual(merged[0].colorBands.length, 3);
  assert.strictEqual(merged[0].colorBands[0].label, "成果報告");
  assert.strictEqual(merged[0].colorBands[1].label, "週報提出");
  assert.strictEqual(merged[0].colorBands[2].label, "ジャンル特化グルコン");
});

test("色: 万垢生限定オン会 → gradient ffe500→ddac17", () => {
  const day = buildDay(ev("👑万垢生限定オン会", 2026, 5, 28, 21, 0), 2026, 5);
  const merged = mergeDays([day]);
  assert.deepStrictEqual(merged[0].colorBands[0].colors, ["#ffe500", "#ddac17"]);
});

test("色: 同日2イベントマージで色バンドも2つ追加 (5/23)", () => {
  const r1 = buildDay(ev("【SnsClub卒業生交流会】@東京", 2026, 5, 23, 18, 0), 2026, 5);
  const r2 = buildDay(ev("【SnsClubオン会】in Zoom", 2026, 5, 23, 21, 0), 2026, 5);
  const merged = mergeDays([r1, r2]);
  // 5/23 は土曜日なので special なし。卒業生交流会 + オン会 の2バンド
  assert.deepStrictEqual(
    merged[0].colorBands.map((b) => b.label),
    ["SnsClub卒業生交流会", "SnsClubオン会"]
  );
});

test("mergeDays: 同日2件は時間順", () => {
  const rLate = buildDay(
    ev("【ジャンル特化グルコン】 きよ/(スポット)", 2026, 5, 4, 21, 0),
    2026, 5
  );
  const rEarly = buildDay(
    ev("【ジャンル特化グルコン】 あさん/(レシピ)", 2026, 5, 4, 12, 0),
    2026, 5
  );
  const result = mergeDays([rLate, rEarly]);
  assert.deepStrictEqual(result[0].lines, [
    "4",
    "ジャンル特化グルコン", "レシピ", "あさん", "12:00",
    "ジャンル特化グルコン", "スポット", "きよ", "21:00",
  ]);
});
