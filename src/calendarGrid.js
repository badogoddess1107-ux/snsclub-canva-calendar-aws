// 月カレンダーの (年,月,日) → グリッド上の (row, col, x, y) 変換ロジック

/**
 * 指定月の1日が週の何番目か (0=日曜 ... 6=土曜)
 */
function getFirstDayOfWeek(year, month) {
  return new Date(year, month - 1, 1).getDay();
}

/**
 * 指定月の最終日 (28〜31)
 */
function getLastDay(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * (year, month, day) → (row, col)
 *  例) 2026年5月1日(金) → row=0, col=5
 *  日曜=col0, 月曜=col1, ..., 土曜=col6
 */
function toRowCol(year, month, day) {
  const first = getFirstDayOfWeek(year, month);
  const pos = day - 1 + first;
  return {
    row: Math.floor(pos / 7),
    col: pos % 7,
  };
}

/**
 * グリッド情報と日付から、そのマスの中心ピクセル座標を返す
 */
function cellCenter(grid, year, month, day) {
  const { row, col } = toRowCol(year, month, day);
  const x = grid.topLeft.x + (col + 0.5) * grid.cellWidth;
  const y = grid.topLeft.y + (row + 0.5) * grid.cellHeight;
  return { row, col, x, y };
}

/**
 * グリッド情報と日付から、そのマスの左上ピクセル座標を返す
 */
function cellTopLeft(grid, year, month, day) {
  const { row, col } = toRowCol(year, month, day);
  const x = grid.topLeft.x + col * grid.cellWidth;
  const y = grid.topLeft.y + row * grid.cellHeight;
  return { row, col, x, y };
}

module.exports = {
  getFirstDayOfWeek,
  getLastDay,
  toRowCol,
  cellCenter,
  cellTopLeft,
};
