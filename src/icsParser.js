// ICS (iCalendar) パーサー: VEVENT を { summary, start } 配列で返す
// 仕様: RFC 5545 の最小実装 (DTSTART, SUMMARY のみ)
//  - 行折りたたみ (CRLF + 半角スペース/タブ) を解除
//  - DTSTART は TZID=Asia/Tokyo / UTC(Z) / DATE のいずれも JST の年月日時分に正規化
//  - SUMMARY のエスケープ (\\n, \\,, \\;, \\\\) を解除
//  - RRULE 等の繰り返しは展開しない (現状カレンダーは単発イベント前提)

function unescapeText(s) {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseDtStart(value, params) {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/;
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

  const m1 = value.match(dateOnly);
  if (m1) {
    return {
      year: parseInt(m1[1], 10),
      month: parseInt(m1[2], 10),
      day: parseInt(m1[3], 10),
      hour: 0,
      minute: 0,
      allDay: true,
    };
  }

  const m2 = value.match(dateTime);
  if (!m2) return null;

  let y = parseInt(m2[1], 10);
  let mo = parseInt(m2[2], 10);
  let d = parseInt(m2[3], 10);
  let h = parseInt(m2[4], 10);
  let mi = parseInt(m2[5], 10);
  const isUtc = m2[7] === "Z";

  if (isUtc) {
    // UTC → JST (+9h)
    const dt = new Date(Date.UTC(y, mo - 1, d, h + 9, mi));
    y = dt.getUTCFullYear();
    mo = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
    h = dt.getUTCHours();
    mi = dt.getUTCMinutes();
  }
  // TZID=Asia/Tokyo or floating → コンポーネントをそのまま JST として扱う

  return { year: y, month: mo, day: d, hour: h, minute: mi, allDay: false };
}

function parseIcs(text) {
  // 行折りたたみを解除 (CRLF/LF + 半角スペース or タブ → 連結)
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let current = null;

  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (raw === "END:VEVENT") {
      if (current && current.summary && current.start) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const left = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    const [name, ...params] = left.split(";");

    if (name === "SUMMARY") {
      current.summary = unescapeText(value);
    } else if (name === "DTSTART") {
      current.start = parseDtStart(value, params);
    }
  }

  return events;
}

module.exports = { parseIcs, parseDtStart, unescapeText };
