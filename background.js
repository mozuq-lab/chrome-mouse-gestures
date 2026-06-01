// ============================================================
// マウスジェスチャ拡張 - service worker (background)
// content script から依頼されたタブ単位の操作を実行する
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 送信元タブの情報（content script からの依頼を想定）
  const tab = sender.tab;

  switch (message.action) {
    case "reloadTab":
      // 現在のタブを再読み込み
      if (tab) chrome.tabs.reload(tab.id);
      break;

    case "closeTab":
      // 現在のタブを閉じる
      if (tab) chrome.tabs.remove(tab.id);
      break;

    case "restoreTab":
      // 最後に閉じたタブ（またはウィンドウ）を復元する
      chrome.sessions.restore();
      break;

    default:
      break;
  }
  // 同期処理のみのため、特に応答は返さない
});
