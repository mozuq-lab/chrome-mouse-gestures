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

// ミドルクリック（ホイールクリック）オートスクロールの設定
const AUTOSCROLL_DEADZONE = 12;      // 起点からこの距離まではスクロールしない(px)
const AUTOSCROLL_SPEED = 0.18;       // 起点からの距離に対するスクロール速度係数
const AUTOSCROLL_DRAG_THRESHOLD = 8; // この距離を超えて押したまま動かすとドラッグ扱い(px)
// 起点に表示する丸いインジケータ（上下左右の矢印つき）
const AUTOSCROLL_ICON_SVG =
  '<svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="15" cy="15" r="14" fill="rgba(255,255,255,0.85)" stroke="rgba(0,0,0,0.45)" stroke-width="1"/>' +
  '<circle cx="15" cy="15" r="2.5" fill="rgba(0,0,0,0.6)"/>' +
  '<path d="M15 3 l4 5 h-8 z" fill="rgba(0,0,0,0.55)"/>' +
  '<path d="M15 27 l4 -5 h-8 z" fill="rgba(0,0,0,0.55)"/>' +
  '<path d="M3 15 l5 -4 v8 z" fill="rgba(0,0,0,0.55)"/>' +
  '<path d="M27 15 l-5 -4 v8 z" fill="rgba(0,0,0,0.55)"/>' +
  '</svg>';

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

// オートスクロール用の状態
let autoScrolling = false;        // オートスクロール中か
let autoAnchorX = 0, autoAnchorY = 0; // 起点（基準点）
let autoCurX = 0, autoCurY = 0;   // 現在のカーソル位置
let autoBtnDown = false;          // ミドルボタンを押下中か（ドラッグ判定用）
let autoDragMode = false;         // 押したまま動かした(ドラッグ)モードか
let autoOverlay = null;           // 全画面オーバーレイ（カーソル変更・イベント捕捉）
let autoRafId = 0;                // requestAnimationFrame のID
let autoScrollTarget = null;      // スクロール対象要素（null なら window）
let autoMiddleHandled = false;    // 直後の auxclick(中クリック既定動作)を抑制するか

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
// ミドルクリック（ホイールクリック）オートスクロール
// macOS は OS レベルでミドルクリックの自動スクロールを持たないため拡張側で実装する
// ============================================================

// 指定座標の下にある縦スクロール可能な祖先要素を探す（無ければ null = window をスクロール）
function findScrollable(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.body && el !== document.documentElement) {
    const style = getComputedStyle(el);
    const canScrollY =
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight;
    const canScrollX =
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      el.scrollWidth > el.clientWidth;
    if (canScrollY || canScrollX) return el;
    el = el.parentElement;
  }
  return null;
}

// 対象（要素 or window）を相対スクロールする
function scrollTargetBy(dx, dy) {
  if (autoScrollTarget) {
    autoScrollTarget.scrollBy(dx, dy);
  } else {
    window.scrollBy(dx, dy);
  }
}

// オートスクロールを開始する
function startAutoScroll(x, y) {
  autoScrolling = true;
  autoAnchorX = autoCurX = x;
  autoAnchorY = autoCurY = y;
  autoDragMode = false;
  // オーバーレイを追加する前にスクロール対象を確定する
  autoScrollTarget = findScrollable(x, y);

  // 全画面オーバーレイ：カーソルを変更し、マウス操作を確実に捕捉する
  autoOverlay = document.createElement("div");
  autoOverlay.id = "__mg_autoscroll_overlay__";
  autoOverlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;cursor:all-scroll;" +
    "background:transparent;margin:0;padding:0;user-select:none;";

  // 起点インジケータ（丸＋矢印）を起点位置に配置
  const indicator = document.createElement("div");
  indicator.style.cssText =
    "position:fixed;left:" + x + "px;top:" + y + "px;" +
    "transform:translate(-50%,-50%);width:30px;height:30px;" +
    "pointer-events:none;z-index:2147483647;";
  indicator.innerHTML = AUTOSCROLL_ICON_SVG;
  autoOverlay.appendChild(indicator);
  (document.body || document.documentElement).appendChild(autoOverlay);

  autoLoop();
}

// オートスクロールを停止する
function stopAutoScroll() {
  autoScrolling = false;
  autoBtnDown = false;
  autoDragMode = false;
  if (autoRafId) cancelAnimationFrame(autoRafId);
  autoRafId = 0;
  if (autoOverlay && autoOverlay.parentNode) {
    autoOverlay.parentNode.removeChild(autoOverlay);
  }
  autoOverlay = null;
  autoScrollTarget = null;
}

// 毎フレーム、起点と現在位置の差に応じてスクロールする
function autoLoop() {
  if (!autoScrolling) return;
  const dx = autoCurX - autoAnchorX;
  const dy = autoCurY - autoAnchorY;
  const dist = Math.hypot(dx, dy);
  if (dist > AUTOSCROLL_DEADZONE) {
    // デッドゾーン分を差し引いた量に比例した速度でスクロール
    const scale = ((dist - AUTOSCROLL_DEADZONE) / dist) * AUTOSCROLL_SPEED;
    scrollTargetBy(dx * scale, dy * scale);
  }
  autoRafId = requestAnimationFrame(autoLoop);
}

// ============================================================
// マウスイベントハンドラ
// ============================================================

// 右ボタン押下でトラッキング開始
function onMouseDown(e) {
  // オートスクロール中はどのボタンでクリックしても解除する
  if (autoScrolling) {
    autoMiddleHandled = e.button === 1; // 中クリックで解除した場合は auxclick を抑制
    stopAutoScroll();
    e.preventDefault();
    return;
  }

  // ミドルボタン（ホイールクリック）：オートスクロール開始
  if (e.button === 1) {
    // リンクやフォーム部品の上では既定動作（新規タブで開く等）を優先する
    const interactive =
      e.target.closest &&
      e.target.closest('a[href],button,input,textarea,select,[role="button"]');
    if (interactive) {
      autoMiddleHandled = false;
      return;
    }
    e.preventDefault();
    autoMiddleHandled = true;
    autoBtnDown = true;
    startAutoScroll(e.clientX, e.clientY);
    return;
  }

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
  // オートスクロール中はカーソル位置を更新する（実際のスクロールは rAF ループが行う）
  if (autoScrolling) {
    autoCurX = e.clientX;
    autoCurY = e.clientY;
    // 押したまま一定距離動いたらドラッグモード（離したら停止する方式）にする
    if (
      autoBtnDown &&
      Math.hypot(e.clientX - autoAnchorX, e.clientY - autoAnchorY) >
        AUTOSCROLL_DRAG_THRESHOLD
    ) {
      autoDragMode = true;
    }
    return;
  }

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
  // ミドルボタンを離したとき：
  //  - ドラッグして動かしていた → ここで停止（押し続けスクロール方式）
  //  - ほぼ動かさずクリックしただけ → 継続モード（次のクリックまでスクロール）
  if (autoScrolling && e.button === 1 && autoBtnDown) {
    autoBtnDown = false;
    autoMiddleHandled = true; // 直後の auxclick を抑制
    if (autoDragMode) stopAutoScroll();
    e.preventDefault();
    return;
  }

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

// ミドルクリックの既定動作（新規タブで開く等）を、オートスクロールに使った
// ときだけ抑制する。リンク上などで使った場合は抑制せず通常どおり開く。
function onAuxClick(e) {
  if (e.button === 1 && autoMiddleHandled) {
    e.preventDefault();
    e.stopPropagation();
  }
  autoMiddleHandled = false;
}

// Esc キーでオートスクロールを解除できるようにする
function onKeyDown(e) {
  if (autoScrolling && e.key === "Escape") {
    stopAutoScroll();
  }
}

// ============================================================
// イベント登録
// capture フェーズで先取りし、ページ側のハンドラより前に処理する
// ============================================================
document.addEventListener("mousedown", onMouseDown, true);
document.addEventListener("mousemove", onMouseMove, true);
document.addEventListener("mouseup", onMouseUp, true);
document.addEventListener("contextmenu", onContextMenu, true);
document.addEventListener("auxclick", onAuxClick, true);
document.addEventListener("keydown", onKeyDown, true);

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
