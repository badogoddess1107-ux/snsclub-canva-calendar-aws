// Googleカレンダーの1イベントから、Canva1マスに書く行リストを組み立てる
// イベントタイプ別ハンドラ:
//   - 【ジャンル特化グルコン】...
//   - 【生徒対談】...
//   - 👑万垢生限定オン会
//   - 【SnsClub卒業生交流会】@東京
//   - 【SnsClubオン会】in Zoom
//   - 【SnsClubオフ会】@名古屋
//   - カイシャインさんスペシャルグルコン
// 上記以外 (【講師対談】、【アイレポート講義】等) は null (スキップ)

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const PREFIX_GENRE = "【ジャンル特化グルコン】";
const PREFIX_STUDENT_TALK = "【生徒対談】";
const PREFIX_LECTURER_TALK = "【講師対談】";
const PREFIX_EYE_REPORT = "【アイレポート講義】";
const PREFIX_GRAD = "【SnsClub卒業生交流会】";
const PREFIX_ONLINE = "【SnsClubオン会】";
const PREFIX_OFFLINE = "【SnsClubオフ会】";
const KEYWORD_BANGAKU = "万垢生限定オン会";
const KEYWORD_KAISHAIN = "カイシャイン";
const KEYWORD_SPECIAL = "スペシャルグルコン";
const KEYWORD_TOKUBETSU_KOUGI = "特別講義";
const KEYWORD_MONETIZE_SEMINAR = "マネタイズセミナー";

// ジャンル特化グルコンの講師抽出で使う区切り文字
//  標準: / ｜ | ⌇ / 非標準(カレンダー実データで出現): ┊ 〻 ︴ ╎
//  いずれも「講師名 [区切り] 説明」 の形で名前が区切りより前にある前提
const INSTRUCTOR_SEPARATORS = /[\/｜|⌇┊〻︴╎]/;

// 講師名オーバーライド: 絵文字/装飾文字/逆順区切り 等で自動抽出できない特殊表記。
//  summary に match が含まれていれば name を講師名として採用する。
//  (まつこ🍵 / ハイブリッド子育て/アローラ は 2026年6月にも同表記で出現する recurring パターン)
const INSTRUCTOR_OVERRIDES = [
  { match: "ᴋᴜʀᴜᴍɪ", name: "kurumi" },     // 装飾文字に埋もれた名前
  { match: "アローラ", name: "アローラ" },   // ...子育て/アローラ (名前が / の後ろ)
  { match: "まつこ", name: "まつこ" },       // まつこ🍵... (絵文字区切り)
];

// =====================================
// 色マップ (修正11)
// =====================================
// kind: "solid" → 単色、"gradient" → グラデーション
const COLOR_MAP = {
  // 特別行 (自動付与)
  "成果報告":          { kind: "solid",    color: "#ff5757" },
  "週報提出":          { kind: "solid",    color: "#59ff65" },
  // イベントタイプ
  "ジャンル特化グルコン":          { kind: "solid",    color: "#ffc259" },
  "ジャンル特化グルコン_台本":      { kind: "gradient", colors: ["#fe8356", "#ffee22", "#a4f402"] },
  "ジャンル特化グルコン_ストーリー": { kind: "gradient", colors: ["#fe8356", "#ffee22", "#a4f402"] },
  "生徒対談":            { kind: "solid",    color: "#5998ff" },
  "講師対談":            { kind: "solid",    color: "#0038ff" },
  "アイレポート講義":     { kind: "solid",    color: "#0038ff" },
  "スペシャルグルコン":   { kind: "solid",    color: "#0038ff" }, // 【特別講義】系
  "万垢生限定オン会":     { kind: "gradient", colors: ["#ffe500", "#ddac17"] },
  "SnsClubオン会":       { kind: "solid",    color: "#ffee59" },
  "SnsClub卒業生交流会":  { kind: "solid",    color: "#faf01a" },
  "SnsClubオフ会":       { kind: "solid",    color: "#ffee59" },
};

/**
 * 1イベントを色マップのキーに変換
 *  ジャンル特化グルコンはジャンルが台本/ストーリーの場合だけグラデ
 */
function getEventColorKey(day) {
  if (day.eventType === "ジャンル特化グルコン") {
    const genre = day._comp?.fields?.[1] || "";
    if (genre.includes("台本"))   return "ジャンル特化グルコン_台本";
    if (genre.includes("ストーリー")) return "ジャンル特化グルコン_ストーリー";
    return "ジャンル特化グルコン";
  }
  return day.eventType;
}

function getColorBand(key) {
  const band = COLOR_MAP[key];
  if (!band) return { kind: "unknown", label: key };
  return { ...band, label: key };
}

// =====================================
// ユーティリティ
// =====================================
function pad2(n) {
  return String(n).padStart(2, "0");
}

function stripTrailingParens(text) {
  // 末尾の (...) または （...） を取り除く (ジャンル等)
  return text.replace(/[（(][^（）()]*[）)]\s*$/, "").trim();
}

// 末尾の括弧内（ジャンル）抽出
function extractGenre(f) {
  if (!f) return "";
  if (f.startsWith(PREFIX_GENRE)) {
    const matches = [...f.matchAll(/[（(]([^（）()]*)[）)]/g)];
    if (matches.length > 0) return matches[matches.length - 1][1];
    return "";
  }
  const bracketMatch = f.match(/^【([^】]*)】/);
  if (bracketMatch) return bracketMatch[1];
  return f;
}

// SUMMARY から講師名を抽出 (ジャンル特化グルコン専用)
//  優先順位:
//   (1) "...講師" パターンがあればそれを返す
//   (2) 区切り文字 (/ ｜ | ⌇) があれば、最初の区切り前を講師名とする
//   (3) 区切りも講師キーワードも無し → 講師記載なし扱い (空文字)
function extractInstructor(summary) {
  if (!summary) return "";
  if (!summary.startsWith(PREFIX_GENRE)) return "";

  // 特殊表記 (絵文字/装飾/逆順区切り) の講師名オーバーライド
  for (const o of INSTRUCTOR_OVERRIDES) {
    if (summary.includes(o.match)) return o.name;
  }

  let body = summary.slice(PREFIX_GENRE.length).trim();
  body = stripTrailingParens(body);
  if (!body) return "";

  // (1) "...講師"
  const sensei = body.match(/(?:^|[\/｜|⌇:：])([^\/｜|⌇:：]+?講師)/);
  if (sensei) return sensei[1].trim();

  // (2) 区切り文字
  const sepIdx = body.search(INSTRUCTOR_SEPARATORS);
  if (sepIdx >= 0) return body.slice(0, sepIdx).trim();

  // (3) 講師記載なし
  return "";
}

// プレフィックス除去 + 末尾括弧除去 + 区切り前を返す (生徒対談用の名前抽出)
function extractNameAfterPrefix(summary, prefix) {
  if (!summary || !summary.startsWith(prefix)) return "";
  let body = summary.slice(prefix.length).trim();
  body = stripTrailingParens(body);
  if (!body) return "";
  const sepIdx = body.search(INSTRUCTOR_SEPARATORS);
  if (sepIdx >= 0) return body.slice(0, sepIdx).trim();
  return body.trim();
}

// "@東京" や "@名古屋" からエリア名を抽出
function extractAreaAfterPrefix(summary, prefix) {
  if (!summary || !summary.startsWith(prefix)) return "";
  const body = summary.slice(prefix.length).trim();
  const m = body.match(/^@(.+?)\s*$/);
  if (m) return m[1].trim();
  return "";
}

// 共通: 日付/曜日/時刻 と 1〜3日/日曜の特別行を組み立て
function buildHeaderLines(start) {
  const date = start.day;
  const weekday = WEEKDAYS[new Date(start.year, start.month - 1, start.day).getDay()];
  const time = `${pad2(start.hour)}:${pad2(start.minute)}`;
  const isFirst3 = date >= 1 && date <= 3;
  const isSunday = weekday === "日";

  const specials = [];
  if (isFirst3 && isSunday) {
    specials.push("成果報告", "週報提出");
  } else if (isFirst3) {
    specials.push("成果報告");
  } else if (isSunday) {
    specials.push("週報提出");
  }
  return { date, weekday, time, isFirst3, isSunday, specials };
}

// =====================================
// イベントタイプ別ビルダー
// =====================================

// 【ジャンル特化グルコン】 (修正1: D列を「ジャンル特化グルコン」フル表記に変更)
function buildGenreGrucon(event, header) {
  const { date, weekday, time, specials } = header;
  const dType = "ジャンル特化グルコン";
  const instructor = extractInstructor(event.summary);
  const genre = extractGenre(event.summary);

  const lines = [String(date), ...specials, dType, genre, instructor, time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "ジャンル特化グルコン",
    summary: event.summary,
    instructorMissing: !instructor,
    _comp: { c: time, fields: [dType, genre, instructor, time] },
  };
}

// 【生徒対談】 (修正2): 日付 / 生徒対談 / ゲスト / 名前 / 時間
function buildStudentTalk(event, header) {
  const { date, weekday, time, specials } = header;
  const name = extractNameAfterPrefix(event.summary, PREFIX_STUDENT_TALK);
  const lines = [String(date), ...specials, "生徒対談", "ゲスト", name, time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "生徒対談",
    summary: event.summary,
    _comp: { c: time, fields: ["生徒対談", "ゲスト", name, time] },
  };
}

// 【講師対談】 (修正9): 日付 / 講師対談 / ゲスト / 名前 / 時間
function buildLecturerTalk(event, header) {
  const { date, weekday, time, specials } = header;
  const name = extractNameAfterPrefix(event.summary, PREFIX_LECTURER_TALK);
  const lines = [String(date), ...specials, "講師対談", "ゲスト", name, time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "講師対談",
    summary: event.summary,
    _comp: { c: time, fields: ["講師対談", "ゲスト", name, time] },
  };
}

// 【アイレポート講義】 (修正10): 日付 / 特別講義 / アイレポート講義 / 時間
//   "特別講義" は固定で自動記載
function buildEyeReport(event, header) {
  const { date, weekday, time, specials } = header;
  const lines = [String(date), ...specials, "特別講義", "アイレポート講義", time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "アイレポート講義",
    summary: event.summary,
    _comp: { c: time, fields: ["特別講義", "アイレポート講義", time] },
  };
}

// 万垢生限定オン会 (修正3): 日付 / 万垢生限定オン会 / 【in Zoom】 / 時間
function buildBangakusei(event, header) {
  const { date, weekday, time, specials } = header;
  const lines = [String(date), ...specials, "万垢生限定オン会", "【in Zoom】", time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "万垢生限定オン会",
    summary: event.summary,
    _comp: { c: time, fields: ["万垢生限定オン会", "【in Zoom】", time] },
  };
}

// 【SnsClub卒業生交流会】 (修正4): 日付 / SnsClub卒業生交流会 / エリア / 時間
function buildSnsclubGrad(event, header) {
  const { date, weekday, time, specials } = header;
  const area = extractAreaAfterPrefix(event.summary, PREFIX_GRAD);
  const lines = [String(date), ...specials, "SnsClub卒業生交流会", area, time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "SnsClub卒業生交流会",
    summary: event.summary,
    _comp: { c: time, fields: ["SnsClub卒業生交流会", area, time] },
  };
}

// 【SnsClubオン会】 (修正5): 日付 / SnsClubオン会 / 【Zoom】 / 時間
function buildSnsclubOnline(event, header) {
  const { date, weekday, time, specials } = header;
  const lines = [String(date), ...specials, "SnsClubオン会", "【Zoom】", time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "SnsClubオン会",
    summary: event.summary,
    _comp: { c: time, fields: ["SnsClubオン会", "【Zoom】", time] },
  };
}

// 【SnsClubオフ会】 (修正6): 日付 / SnsClubオフ会 / エリア / 時間
function buildSnsclubOffline(event, header) {
  const { date, weekday, time, specials } = header;
  const area = extractAreaAfterPrefix(event.summary, PREFIX_OFFLINE);
  const lines = [String(date), ...specials, "SnsClubオフ会", area, time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "SnsClubオフ会",
    summary: event.summary,
    _comp: { c: time, fields: ["SnsClubオフ会", area, time] },
  };
}

// カイシャインさんスペシャルグルコン (修正7):
//   日付 / スペシャルグルコン / 【特別講義】 / ゲスト / カイシャインさん / 時間
function buildSpecialGrucon(event, header) {
  const { date, weekday, time, specials } = header;
  const lines = [
    String(date), ...specials,
    "スペシャルグルコン",
    "【特別講義】",
    "ゲスト",
    "カイシャインさん",
    time,
  ];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "スペシャルグルコン",
    summary: event.summary,
    _comp: {
      c: time,
      fields: ["スペシャルグルコン", "【特別講義】", "ゲスト", "カイシャインさん", time],
    },
  };
}

// 【○○】スペシャル特別講義 等の特別講義系:
//   日付 / 特別講義 / [【】内ジャンル] / 時間
//   例: 【お金・税金】スペシャル特別講義 → 特別講義 / お金・税金 / 21:00
function buildTokubetsuKougi(event, header) {
  const { date, weekday, time, specials } = header;
  const genre = extractGenre(event.summary);
  const lines = [String(date), ...specials, "特別講義", genre, time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "特別講義",
    summary: event.summary,
    _comp: { c: time, fields: ["特別講義", genre, time] },
  };
}

// マネタイズセミナー(ゲスト名):
//   日付 / 特別講義 / ゲスト / 名前 / 時間
//   例: マネタイズセミナー(陸さん) → 特別講義 / ゲスト / 陸さん / 21:00
function buildMonetizeSeminar(event, header) {
  const { date, weekday, time, specials } = header;
  const m = event.summary.match(/[（(]([^）)]+)[）)]/);
  const name = m ? m[1].trim() : "";
  const lines = [String(date), ...specials, "特別講義", "ゲスト", name, time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "特別講義",
    summary: event.summary,
    _comp: { c: time, fields: ["特別講義", "ゲスト", name, time] },
  };
}

// スペシャルグルコン (カイシャイン無し・ゲスト記載無しの単独表記):
//   日付 / スペシャルグルコン / 時間
//   例: スペシャルグルコン → スペシャルグルコン / 21:00
//   ※ カイシャイン版は buildSpecialGrucon が先に判定するので、 ここには来ない
function buildSpecialGruconSimple(event, header) {
  const { date, weekday, time, specials } = header;
  const lines = [String(date), ...specials, "スペシャルグルコン", time];
  return {
    date, weekday, isSpecial: specials.length > 0, specials, lines,
    eventType: "スペシャルグルコン",
    summary: event.summary,
    _comp: { c: time, fields: ["スペシャルグルコン", time] },
  };
}

// =====================================
// メイン
// =====================================
function buildDay(event, year, month) {
  if (!event || !event.summary || !event.start) return null;
  const summary = event.summary.trim();
  const s = event.start;
  if (s.allDay) return null;
  if (s.year !== year || s.month !== month) return null;

  // ハンドラには trim 済みの summary を渡す (ICSに前後空白があるケース対策)
  const trimmedEvent = { ...event, summary };
  const header = buildHeaderLines(s);

  // タイプ判定 (順序が重要: 「カイシャイン スペシャルグルコン」を先に判定)
  if (summary.includes(KEYWORD_KAISHAIN) && summary.includes(KEYWORD_SPECIAL)) {
    return buildSpecialGrucon(trimmedEvent, header);
  }
  if (summary.startsWith(PREFIX_GENRE)) {
    return buildGenreGrucon(trimmedEvent, header);
  }
  if (summary.startsWith(PREFIX_STUDENT_TALK)) {
    return buildStudentTalk(trimmedEvent, header);
  }
  if (summary.startsWith(PREFIX_LECTURER_TALK)) {
    return buildLecturerTalk(trimmedEvent, header);
  }
  if (summary.startsWith(PREFIX_EYE_REPORT)) {
    return buildEyeReport(trimmedEvent, header);
  }
  if (summary.startsWith(PREFIX_GRAD)) {
    return buildSnsclubGrad(trimmedEvent, header);
  }
  if (summary.startsWith(PREFIX_ONLINE)) {
    return buildSnsclubOnline(trimmedEvent, header);
  }
  if (summary.startsWith(PREFIX_OFFLINE)) {
    return buildSnsclubOffline(trimmedEvent, header);
  }
  if (summary.includes(KEYWORD_BANGAKU)) {
    return buildBangakusei(trimmedEvent, header);
  }
  // マネタイズセミナー は「マネタイズ講座オフ会」(スキップ対象) と別物なので先に判定
  if (summary.includes(KEYWORD_MONETIZE_SEMINAR)) {
    return buildMonetizeSeminar(trimmedEvent, header);
  }
  if (summary.includes(KEYWORD_TOKUBETSU_KOUGI)) {
    return buildTokubetsuKougi(trimmedEvent, header);
  }
  // スペシャルグルコン 単独 (カイシャイン版は冒頭で判定済)
  if (summary.includes(KEYWORD_SPECIAL)) {
    return buildSpecialGruconSimple(trimmedEvent, header);
  }

  // 上記いずれでもないイベント (講師対談、アイレポート講義 等) はスキップ
  return null;
}

/**
 * "HH:MM" 形式の時刻文字列を分単位の数値に変換 (空文字は無限大として後ろに送る)
 */
function timeToMinutes(t) {
  if (!t) return Number.POSITIVE_INFINITY;
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  if (!m) return Number.POSITIVE_INFINITY;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * 同じ日付に複数イベントある場合、1つのマス用にマージする
 *  - 同日のエントリは時間順に並べる (早い順)
 *  - 1件目: そのままlines
 *  - 2件目以降: _comp.fields を続けて連結
 *  - 空欄("")は最終結果から除外
 *  - hasMultiple フラグを true にする
 */
function mergeDays(days) {
  const groups = new Map();
  for (const day of days) {
    const list = groups.get(day.date) || [];
    list.push(day);
    groups.set(day.date, list);
  }

  const merged = [];
  const dates = [...groups.keys()].sort((a, b) => a - b);
  for (const date of dates) {
    const list = groups.get(date);
    list.sort((a, b) => timeToMinutes(a._comp?.c) - timeToMinutes(b._comp?.c));

    // 色バンド構築: 特別行 → 各イベント (時間順)
    const first = list[0];
    const colorBands = [];
    for (const sp of first.specials || []) {
      colorBands.push(getColorBand(sp));
    }
    for (const ev of list) {
      colorBands.push(getColorBand(getEventColorKey(ev)));
    }

    if (list.length === 1) {
      const cleaned = first.lines.filter((l) => l && String(l).trim());
      merged.push({ ...first, lines: cleaned, hasMultiple: false, colorBands });
      continue;
    }

    const allLines = [...first.lines];
    for (let i = 1; i < list.length; i++) {
      const fields = list[i]._comp?.fields || [];
      for (const val of fields) {
        allLines.push(val);
      }
    }
    const cleaned = allLines.filter((l) => l && String(l).trim());
    merged.push({
      ...first,
      lines: cleaned,
      hasMultiple: true,
      entryCount: list.length,
      colorBands,
    });
  }
  return merged;
}

module.exports = {
  buildDay,
  extractGenre,
  extractInstructor,
  mergeDays,
  COLOR_MAP,
  getColorBand,
  getEventColorKey,
};
