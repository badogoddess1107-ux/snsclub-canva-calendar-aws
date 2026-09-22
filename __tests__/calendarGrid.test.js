// node --test __tests__/calendarGrid.test.js
const test = require("node:test");
const assert = require("node:assert");
const { toRowCol, getFirstDayOfWeek, getLastDay } = require("../src/calendarGrid");

test("2026年5月1日は金曜=col5,row0", () => {
  assert.deepStrictEqual(toRowCol(2026, 5, 1), { row: 0, col: 5 });
});

test("2026年5月2日は土曜=col6,row0", () => {
  assert.deepStrictEqual(toRowCol(2026, 5, 2), { row: 0, col: 6 });
});

test("2026年5月3日は日曜=col0,row1", () => {
  assert.deepStrictEqual(toRowCol(2026, 5, 3), { row: 1, col: 0 });
});

test("2026年5月10日は日曜=col0,row2", () => {
  assert.deepStrictEqual(toRowCol(2026, 5, 10), { row: 2, col: 0 });
});

test("2026年5月31日は日曜=col0,row5", () => {
  assert.deepStrictEqual(toRowCol(2026, 5, 31), { row: 5, col: 0 });
});

test("2026年5月の1日目は金曜=5", () => {
  assert.strictEqual(getFirstDayOfWeek(2026, 5), 5);
});

test("2026年5月の最終日は31", () => {
  assert.strictEqual(getLastDay(2026, 5), 31);
});

test("2026年6月の最終日は30", () => {
  assert.strictEqual(getLastDay(2026, 6), 30);
});
