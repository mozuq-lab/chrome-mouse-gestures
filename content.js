// ============================================================
// マウスジェスチャ拡張 - content script
// 右ボタンドラッグでジェスチャを行い、ページ操作を実行する
// ============================================================

// ------------------------------------------------------------
// ジェスチャ定義
// キー: 確定した方向シーケンスをカンマ区切りにした文字列 (U=上 D=下 L=左 R=右)
// 値  : 実行する動作の識別子
// ここを編集するだけでジェスチャを追加・変更できる
// ------------------------------------------------------------
const GESTURES = {
  "R,U": "scrollBottom",   // →↑ : ページ最下部へスクロール
  "R,D": "scrollTop",      // →↓ : ページ最上部へスクロール
  "U,D": "reloadTab",      // ↑↓ : タブを更新（リロード）
  "L,U": "closeTab",       // ←↑ : タブを閉じる
  "L,D": "restoreTab",     // ←↓ : 最後に閉じたタブを復元
  "R":   "historyBack",    // →   : 1つ前の履歴に戻る
  "L":   "historyForward", // ←   : 1つ先の履歴に進む
};

// ------------------------------------------------------------
// 設定値
// ------------------------------------------------------------
const THRESHOLD = 30;   // 方向を確定するための最小移動距離(px)
const TRAIL_COLOR = "rgba(0, 130, 255, 0.85)";
const TRAIL_WIDTH = 4;

// macOS 判定
// macOS の Chrome は右ボタンを「押した瞬間(mousedown)」に contextmenu を発火する。
// メニューが開くと以降の mousemove/mouseup がページに届かずジェスチャが成立しないため、
// macOS では右ボタントラッキング中の contextmenu を常に抑制する（プレーンな
// 右クリックメニューも出なくなるが、ジェスチャを成立させるには不可避）。
// Windows / Linux は contextmenu が mouseup 時に発火するため、移動を伴うジェスチャ
// のときだけ抑制し、単なる右クリックでは通常どおりメニューを表示する。
const IS_MAC =
  (navigator.userAgentData && navigator.userAgentData.platform === "macOS") ||
  /Mac|iPhone|iPad/.test(navigator.platform || "") ||
  /Mac OS X/.test(navigator.userAgent || "");

// ------------------------------------------------------------
// 状態変数
// ------------------------------------------------------------
let tracking = false;       // ジェスチャトラッキング中か
let moved = false;          // しきい値を超える移動があったか
let lastX = 0, lastY = 0;   // 直近の起点座標（方向確定の基準）
let directions = [];        // 確定した方向のシーケンス
let canvas = null;          // 軌跡描画用 canvas
let ctx = null;             // canvas の 2D コンテキスト
let trailPoints = [];       // 軌跡の点列
let suppressContextMenu = false; // 直後の contextmenu を抑制するか

// ============================================================
// 軌跡表示用 canvas の生成・破棄・描画
// ============================================================

// ビューポート全体を覆う canvas を生成する
function createCanvas() {
  canvas = document.createElement("canvas");
  canvas.id = "__mouse_gesture_canvas__";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // 全画面・最前面・クリックを透過する固定配置
  canvas.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100vh;" +
    "z-index:2147483647;pointer-events:none;margin:0;padding:0;";
  (document.body || document.documentElement).appendChild(canvas);
  ctx = canvas.getContext("2d");
  ctx.strokeStyle = TRAIL_COLOR;
  ctx.lineWidth = TRAIL_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

// canvas を消去して破棄する
function destroyCanvas() {
  if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
  canvas = null;
  ctx = null;
  trailPoints = [];
}

// 軌跡を再描画する
function drawTrail() {
  if (!ctx || trailPoints.length < 2) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.moveTo(trailPoints[0].x, trailPoints[0].y);
  for (let i = 1; i < trailPoints.length; i++) {
    ctx.lineTo(trailPoints[i].x, trailPoints[i].y);
  }
  ctx.stroke();
}

// ============================================================
// 方向判定
// ============================================================

// dx, dy の主軸と符号から方向 (U/D/L/R) を返す
function getDirection(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? "R" : "L"; // 水平方向が主軸
  } else {
    return dy > 0 ? "D" : "U"; // 垂直方向が主軸（画面座標は下が正）
  }
}

// ============================================================
// 動作の実行
// ============================================================

// ページ内で完結する動作はここで実行し、
// タブ単位の動作は background へメッセージで依頼する
function executeAction(action) {
  switch (action) {
    case "scrollBottom":
      // ページ最下部へスムーズスクロール
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      break;
    case "scrollTop":
      // ページ最上部へスムーズスクロール
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "historyBack":
      history.back();
      break;
    case "historyForward":
      history.forward();
      break;
    case "reloadTab":
    case "closeTab":
    case "restoreTab":
      // タブ操作は service worker に委譲する
      try {
        chrome.runtime.sendMessage({ action });
      } catch (e) {
        // 拡張のコンテキストが無効化された場合などは黙って無視
      }
      break;
    default:
      break;
  }
}

// ============================================================
// マウスイベントハンドラ
// ============================================================

// 右ボタン押下でトラッキング開始
function onMouseDown(e) {
  if (e.button !== 2) return; // 右ボタン以外は無視
  // Command(⌘) + 右クリックはジェスチャを開始せず、コンテキストメニューを許可する
  // （特に macOS でメニューを表示したいときのエスケープハッチ。⌘ は metaKey）
  if (e.metaKey) {
    tracking = false;
    moved = false;
    return;
  }
  tracking = true;
  moved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  directions = [];
  createCanvas();
  trailPoints = [{ x: e.clientX, y: e.clientY }];
}

// 移動を追跡し、しきい値を超えたら方向を確定する
function onMouseMove(e) {
  if (!tracking) return;

  // 軌跡に現在位置を追加して再描画
  trailPoints.push({ x: e.clientX, y: e.clientY });
  drawTrail();

  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  // 起点からの距離がしきい値を超えたら方向を確定
  if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;

  moved = true;
  const dir = getDirection(dx, dy);
  // 直前と異なる方向のときだけシーケンスに追加（連続同方向はまとめる）
  if (directions.length === 0 || directions[directions.length - 1] !== dir) {
    directions.push(dir);
  }
  // 次の方向判定の基準を現在位置に更新
  lastX = e.clientX;
  lastY = e.clientY;
}

// 右ボタンを離したらシーケンスを照合し動作を実行
function onMouseUp(e) {
  if (e.button !== 2 || !tracking) return;
  tracking = false;
  destroyCanvas();

  if (moved && directions.length > 0) {
    const key = directions.join(",");
    const action = GESTURES[key];
    if (action) {
      executeAction(action);
    }
  }

  // Win/Linux 用: mouseup の後に発火する contextmenu を抑制するか決める。
  // 移動を伴うジェスチャのときだけ抑制し、単なる右クリックは通常どおり表示する。
  suppressContextMenu = moved;
  moved = false;
}

// contextmenu の抑制判定
function onContextMenu(e) {
  // Command(⌘) + 右クリックのときは常にメニューを表示する（抑制しない）
  if (e.metaKey) {
    suppressContextMenu = false;
    return;
  }
  // macOS: 右ボタントラッキング中なら常に抑制（mousedown 時点で発火するため、
  //        この時点ではジェスチャか単なるクリックか判別できない）。
  // 全OS共通: mouseup 後に発火するケース(suppressContextMenu)や、mouseup より先に
  //          発火するケース(tracking && moved)も抑制する。
  if (suppressContextMenu || (tracking && moved) || (IS_MAC && tracking)) {
    e.preventDefault();
  }
  suppressContextMenu = false;
}

// ============================================================
// イベント登録
// capture フェーズで先取りし、ページ側のハンドラより前に処理する
// ============================================================
document.addEventListener("mousedown", onMouseDown, true);
document.addEventListener("mousemove", onMouseMove, true);
document.addEventListener("mouseup", onMouseUp, true);
document.addEventListener("contextmenu", onContextMenu, true);

// ウィンドウリサイズ時は canvas サイズを追従させる
window.addEventListener("resize", () => {
  if (canvas) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // サイズ変更で描画設定がリセットされるため再設定
    ctx.strokeStyle = TRAIL_COLOR;
    ctx.lineWidth = TRAIL_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }
});
