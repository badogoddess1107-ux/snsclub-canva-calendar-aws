// プロジェクト設定
module.exports = {
  calendar: {
    // Googleカレンダー: 公開ICS URL
    icsUrl:
      "https://calendar.google.com/calendar/ical/c_4143a7ed518b1386d698a8a9276cded9ab71af25b39bed86e6f089e5ddb04464%40group.calendar.google.com/public/basic.ics",
  },
  canva: {
    // AWS では環境変数 CANVA_DESIGN_URL で上書きできる（テンプレを差し替えたとき用）
    designUrl:
      process.env.CANVA_DESIGN_URL ||
      "https://www.canva.com/design/DAGQg0RmDos/Z8BGD7ToSA7XpA_6a1zxyw/edit",
    // ブラウザプロファイル保存先（ログイン情報をここに保持）
    userDataDir: ".browser-profile",
    // 自動実行(runScheduled.js)専用のプロファイル。
    // Web UI と同じプロファイルだと Chromium のロックが衝突して起動できないため分離する。
    // 初回実行時に userDataDir から自動で複製される（キャッシュは除外）。
    userDataDirScheduled: ".browser-profile-scheduled",
    // ベースページ: この年月のテンプレが何ページ目にあるか
    // 翌月分は basePage.pageNumber + 1, さらに翌月は +2 と自動計算
    // 2026/05/04 更新: 2026年6月=P34 を起点に。7月=P35, 8月=P36...
    // 2026/05/26 更新: 6月テンプレを P35 に移動した運用変更に追従。 7月=P36, 8月=P37...
    //   ※ 自動計算が合わない月は --page=N で明示指定して上書きする運用 (推奨)
    basePage: { year: 2026, month: 6, pageNumber: 35 },
  },
};
