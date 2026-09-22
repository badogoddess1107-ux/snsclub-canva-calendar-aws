// ============================================================
// monthTitle.js — カレンダーページ上部の「月タイトル」を書き換える
// ============================================================
// 対象: ページ上部の 「2026.6」 (年月) と 「June」 (英語月名)。
// これらは placeholder (「段落テキスト」) ではなく実テキストなので、
// calibratePage.js の 42個検出には乗らない。 テキスト内容で直接引き当てる。
//
// 設計上の注意 (過去セッションで判明した Canva の罠):
//  - 罠1: 1つのテキスト要素は複数の leaf span に分かれる → 位置で dedupe する
//  - 罠2: mouse.click(50,50) は左サイドバーを開いて canvas を pan させる → 使わない
//  - 罠6: isInTextEditMode は前回の font input を引きずり false-positive を返す
//         → 日付セル書込みの「前」に実行して、 状態が綺麗なうちに終わらせる
//  - 罠7: 円形距離での最近接探索は誤爆する → グリッド上端より上、 という帯で絞る
// ============================================================

const MONTH_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_EN_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ============================================================
// 純粋ロジック (テスト対象)
// ============================================================

/**
 * 「2 0 2 6 . 6」 のように 1文字ごとに空白が入っているかを判定。
 * Canva の字間調整はCSSなので通常 textContent に空白は入らないが、
 * テンプレートによっては実際に空白文字で字間を作っている事がある。
 */
function detectSpacing(raw) {
  const trimmed = String(raw).trim();
  if (!/^\S(\s+\S)+$/.test(trimmed)) return null;
  const sep = trimmed.match(/\s+/)[0];
  return sep;
}

/** 元の大文字小文字スタイルを判定 */
function detectCaseStyle(word) {
  if (word === word.toUpperCase() && word !== word.toLowerCase()) return "upper";
  if (word === word.toLowerCase() && word !== word.toUpperCase()) return "lower";
  return "title";
}

function applyCaseStyle(word, style) {
  if (style === "upper") return word.toUpperCase();
  if (style === "lower") return word.toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * テキストが「月タイトル」かどうかを判定し、 書き換えに必要な形式情報を返す。
 * @returns {null | { kind, sep?, padded?, caseStyle?, abbrev?, spacing }}
 */
function matchMonthTitle(raw) {
  if (raw == null) return null;
  const spacing = detectSpacing(raw);
  const compact = String(raw).replace(/\s+/g, "");
  if (!compact) return null;

  // ① 英語の月名 (フル)
  const fullIdx = MONTH_EN.findIndex((m) => m.toLowerCase() === compact.toLowerCase());
  if (fullIdx >= 0) {
    return { kind: "en", abbrev: false, caseStyle: detectCaseStyle(compact), spacing };
  }

  // ② 英語の月名 (3文字略記 / 末尾ピリオド可)
  const abbrBody = compact.replace(/\.$/, "");
  const abbrIdx = MONTH_EN_ABBR.findIndex((m) => m.toLowerCase() === abbrBody.toLowerCase());
  if (abbrIdx >= 0) {
    return {
      kind: "en",
      abbrev: true,
      trailingDot: compact.endsWith("."),
      caseStyle: detectCaseStyle(abbrBody),
      spacing,
    };
  }

  // ③ 年月 (2026.6 / 2026.06 / 2026/6 / 2026-6)
  const ym = compact.match(/^(\d{4})([./\-])(\d{1,2})$/);
  if (ym) {
    const monthNum = parseInt(ym[3], 10);
    if (monthNum >= 1 && monthNum <= 12) {
      return { kind: "ym", sep: ym[2], padded: isZeroPadded(ym[3]), spacing };
    }
  }

  // ④ 和文年月 (2026年6月)
  const jp = compact.match(/^(\d{4})年(\d{1,2})月$/);
  if (jp) {
    const monthNum = parseInt(jp[2], 10);
    if (monthNum >= 1 && monthNum <= 12) {
      return { kind: "jp", padded: isZeroPadded(jp[2]), spacing };
    }
  }

  // ⑤ 月のみ (6月)
  const jpMonthOnly = compact.match(/^(\d{1,2})月$/);
  if (jpMonthOnly) {
    const monthNum = parseInt(jpMonthOnly[1], 10);
    if (monthNum >= 1 && monthNum <= 12) {
      return { kind: "jpMonthOnly", padded: isZeroPadded(jpMonthOnly[1]), spacing };
    }
  }

  return null;
}

/**
 * 「ゼロ埋め書式か」を判定する。
 * "06" は ゼロ埋め、 "12" は単なる2桁なので ゼロ埋めとはみなさない
 * (でないと 2026.12 → 2027.01 のように翌年1月が誤って0埋めされる)。
 */
function isZeroPadded(monthStr) {
  return /^0\d$/.test(monthStr);
}

/** 空白による字間を元テキストと同じ形で復元 */
function applySpacing(text, spacing) {
  if (!spacing) return text;
  return String(text).split("").join(spacing);
}

/**
 * match 情報を元に、 指定年月の新しいタイトル文字列を生成する。
 * 元の書式 (区切り文字/ゼロ埋め/大文字小文字/字間) を保つ。
 */
function renderMonthTitle(match, year, month) {
  const mm = match.padded ? String(month).padStart(2, "0") : String(month);
  let text;
  switch (match.kind) {
    case "en": {
      const name = match.abbrev ? MONTH_EN_ABBR[month - 1] : MONTH_EN[month - 1];
      text = applyCaseStyle(name, match.caseStyle);
      if (match.abbrev && match.trailingDot) text += ".";
      break;
    }
    case "ym":
      text = `${year}${match.sep}${mm}`;
      break;
    case "jp":
      text = `${year}年${mm}月`;
      break;
    case "jpMonthOnly":
      text = `${mm}月`;
      break;
    default:
      return null;
  }
  return applySpacing(text, match.spacing);
}

/**
 * 検出済み要素のうち、 既に目的の月になっているものを除いた「書き換えが必要な分」を返す。
 * @param {Array<{text:string}>} found
 */
function planTitleUpdates(found, year, month) {
  const updates = [];
  const alreadyOk = [];
  for (const el of found) {
    const match = matchMonthTitle(el.text);
    if (!match) continue;
    const next = renderMonthTitle(match, year, month);
    if (next == null) continue;
    if (next === String(el.text).trim()) {
      alreadyOk.push({ ...el, next });
    } else {
      updates.push({ ...el, next, kind: match.kind });
    }
  }
  return { updates, alreadyOk };
}

/**
 * 罠1 対策: 同一テキスト要素が複数 leaf に分かれて検出されるため、
 * 位置が重なるものを1つに畳む。
 */
function dedupeByPosition(candidates, tolerance = 8) {
  const kept = [];
  for (const c of candidates) {
    const dup = kept.find(
      (k) => k.text === c.text && Math.abs(k.x - c.x) <= tolerance && Math.abs(k.y - c.y) <= tolerance,
    );
    if (dup) {
      // より大きい (= 親に近い) 要素を残す
      if (c.w * c.h > dup.w * dup.h) Object.assign(dup, c);
      continue;
    }
    kept.push({ ...c });
  }
  return kept;
}

module.exports = {
  MONTH_EN,
  MONTH_EN_ABBR,
  detectSpacing,
  isZeroPadded,
  detectCaseStyle,
  applyCaseStyle,
  matchMonthTitle,
  applySpacing,
  renderMonthTitle,
  planTitleUpdates,
  dedupeByPosition,
};
