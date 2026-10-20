/* 持ち帰りページ。?id=<参加の UUID> から CloudKit の公開 DB の WallItem(レコード名 "item-<UUID>")を読んで、
 * 絵(wallpaper)・待受(lockscreen)・動画(video)・名前・所属・宣言を見せる。ビルド不要の素の JS。
 * 追跡・外部送信なし(通信先は CloudKit JS の配信元と CloudKit だけ)。画面は DOM の textContent で組む(文字を HTML として解釈しない)。
 * 描画(render)と読み込み(load)を分けてあり、test.html は CloudKit を呼ばずに模擬レコードで render だけ確かめる。 */
(function () {
  "use strict";

  var CLOUDKIT_JS = "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js";
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var TIMEOUT_MS = 20000;
  // リンクの有効期間 = 作品(WallItem)の createdAt から 24 時間。iPad 側の実削除(Core の WallItemExpiry.defaultLifetime)と同じ値。
  var LIFETIME_MS = 24 * 60 * 60 * 1000;

  var MESSAGES = {
    loading: "読み込んでいます…",
    preparing: "ただいま準備中です。しばらくしてから、もう一度開いてください。",
    badId: "リンクが正しくありません。会場の画面のQRコードを、もう一度読み取ってください。",
    expired: "このリンクの期限(24 時間)は切れました",
    notFound: "作品が見つかりません。完成した直後は、表示までに少し時間がかかります。1分ほど待って、もう一度開いてください。",
    network: "通信できませんでした。電波のよい場所で、もう一度開いてください。",
    imageError: "画像を読み込めませんでした。もう一度開いてください。",
    videoError: "動画を再生できませんでした。通信のよい場所で、もう一度開いてください。",
    retry: "もう一度読み込む",
    saveHint: "画像は、長押しすると写真に保存できます。"
  };

  // ---- 純粋な関数(テストしやすいもの) ----

  /** ?id= の UUID を大文字にそろえて返す。形が正しくなければ null。 */
  function parseId(search) {
    var value = null;
    try { value = new URLSearchParams(search || "").get("id"); } catch (e) { return null; }
    if (typeof value !== "string") return null;
    value = value.trim();
    return UUID_RE.test(value) ? value.toUpperCase() : null;
  }

  /** CloudKit のレコード名。Kiosk は "item-" + UUID(大文字)で保存している(CloudWallStore.itemID)。 */
  function recordNameFor(id) { return "item-" + String(id).toUpperCase(); }

  /** アセット(CKAsset)の取得 URL。downloadURL の ${f} はファイル名に置き換える。https(試験時のみ data:/blob:/file: も可)でなければ null。 */
  function assetUrl(field, fileName) {
    var asset = field && field.value;
    var url = asset && typeof asset.downloadURL === "string" ? asset.downloadURL : null;
    if (!url) return null;
    url = url.split("${f}").join(encodeURIComponent(fileName || "file"));
    if (/^https:\/\//i.test(url)) return url;
    if (window.TAKEAWAY_TEST && /^(data:|blob:|file:)/i.test(url)) return url;
    return null;
  }

  function text(fields, key) {
    var f = fields && fields[key];
    return f && typeof f.value === "string" ? f.value.trim() : "";
  }

  /** createdAt(CloudKit JS の TIMESTAMP はミリ秒の数)を読む。無い・読めなければ null。 */
  function createdAtMs(fields) {
    var f = fields && fields.createdAt;
    var v = f && f.value;
    if (v instanceof Date) v = v.getTime();
    else if (typeof v === "string" && /^\d+$/.test(v.trim())) v = Number(v.trim());
    return (typeof v === "number" && isFinite(v) && v > 0) ? v : null;
  }

  /** 期限切れか(作ってから 24 時間を過ぎた)。createdAt が無い・読めないときも期限切れとして扱う(何も見せない)。 */
  function isExpired(createdAt, nowMs) {
    if (createdAt == null) return true;
    return (nowMs - createdAt) > LIFETIME_MS;
  }

  /** CloudKit のレコード(JS の形: { recordName, fields: { key: { value } } })を、画面用の値にする。
   *  期限切れなら { expired: true } だけを返す(絵・動画・文の値は一切持たせない)。 */
  function toView(record, nowMs) {
    var fields = (record && record.fields) || {};
    if (isExpired(createdAtMs(fields), typeof nowMs === "number" ? nowMs : Date.now())) return { expired: true };
    return {
      expired: false,
      displayName: text(fields, "displayName"),
      deptName: text(fields, "deptName"),
      declarationText: text(fields, "declarationText"),
      wallpaperUrl: assetUrl(fields.wallpaper, "wallpaper.jpg"),
      lockscreenUrl: assetUrl(fields.lockscreen, "lockscreen.jpg"),
      videoUrl: assetUrl(fields.video, "video.mp4")
    };
  }

  // ---- 描画 ----

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function clear(root) { while (root.firstChild) root.removeChild(root.firstChild); }

  function eyebrow() { return el("p", "eyebrow", "宣言の部屋"); }

  /** 1 行のお知らせ(読み込み中・エラー)。isError のときは「もう一度読み込む」を添える。 */
  function showMessage(root, message, isError) {
    clear(root);
    root.appendChild(eyebrow());
    var box = el("p", "message" + (isError ? " is-error" : ""), message);
    box.id = "status";
    if (isError) box.setAttribute("role", "alert");
    root.appendChild(box);
    if (isError) {
      var button = el("button", "retry", MESSAGES.retry);
      button.type = "button";
      button.addEventListener("click", function () { window.location.reload(); });
      root.appendChild(button);
    }
  }

  function mediaError(parent, message) {
    if (parent.querySelector(".media-error")) return;
    parent.appendChild(el("p", "media-error", message));
  }

  function imageBlock(title, url, kind, alt) {
    var block = el("section", "block");
    block.appendChild(el("h2", null, title));
    var img = el("img", "media is-" + kind);
    img.alt = alt;
    img.decoding = "async";
    img.setAttribute("referrerpolicy", "no-referrer");
    img.addEventListener("error", function () { img.hidden = true; mediaError(block, MESSAGES.imageError); });
    img.src = url;
    block.appendChild(img);
    return block;
  }

  function videoBlock(url, posterUrl) {
    var block = el("section", "block");
    block.appendChild(el("h2", null, "動画"));
    var video = el("video", "media");
    video.controls = true;
    video.setAttribute("playsinline", "");
    video.preload = "metadata";
    video.setAttribute("referrerpolicy", "no-referrer");
    if (posterUrl) video.poster = posterUrl;
    var source = el("source");
    source.type = "video/mp4";
    source.addEventListener("error", function () { mediaError(block, MESSAGES.videoError); });
    source.src = url;
    video.appendChild(source);
    video.addEventListener("error", function () { mediaError(block, MESSAGES.videoError); });
    block.appendChild(video);
    return block;
  }

  /** 期限切れ: 1 行だけ(名前・絵・動画・宣言・再読み込みボタンは出さない)。 */
  function showExpired(root) {
    clear(root);
    var box = el("p", "message is-error", MESSAGES.expired);
    box.id = "status";
    root.appendChild(box);
  }

  /** 画面全体を描く。view = toView(record) の結果。 */
  function render(root, view) {
    if (!view || view.expired) { showExpired(root); return; }
    clear(root);
    root.appendChild(eyebrow());

    var who = el("section", "who");
    if (view.deptName) who.appendChild(el("p", "dept", view.deptName));
    if (view.displayName) who.appendChild(el("h1", "name", view.displayName));
    else who.appendChild(el("h1", "sr-only", "あなたの作品"));
    if (view.declarationText) who.appendChild(el("p", "declaration", view.declarationText));
    root.appendChild(who);

    var hasMedia = !!(view.videoUrl || view.wallpaperUrl || view.lockscreenUrl);
    if (view.videoUrl) root.appendChild(videoBlock(view.videoUrl, view.wallpaperUrl));
    if (view.wallpaperUrl) root.appendChild(imageBlock("絵(壁紙・横)", view.wallpaperUrl, "wallpaper", "あなたの絵(横長)"));
    if (view.lockscreenUrl) root.appendChild(imageBlock("絵(待受・縦)", view.lockscreenUrl, "lockscreen", "あなたの絵(縦長)"));
    if (view.wallpaperUrl || view.lockscreenUrl) root.appendChild(el("p", "hint", MESSAGES.saveHint));
    if (!hasMedia) root.appendChild(el("p", "message is-error", MESSAGES.notFound));

    root.appendChild(el("footer", null, "このリンクは、作品ができてから 24 時間だけ見られます。保存はお早めに。あなただけのリンクなので、共有しないでください。"));
  }

  // ---- 読み込み(CloudKit JS) ----

  function loadCloudKit() {
    return new Promise(function (resolve, reject) {
      if (window.CloudKit) { resolve(window.CloudKit); return; }
      var script = document.createElement("script");
      script.src = CLOUDKIT_JS;
      script.async = true;
      script.onload = function () { window.CloudKit ? resolve(window.CloudKit) : reject({ kind: "network" }); };
      script.onerror = function () { reject({ kind: "network" }); };
      document.head.appendChild(script);
    });
  }

  function withTimeout(promise) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject({ kind: "network" }); }, TIMEOUT_MS);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function errorCode(error) {
    return String((error && (error.serverErrorCode || error.ckErrorCode || error.code)) || "").toUpperCase();
  }

  /** 失敗の分類: "notFound"(レコード無し)/ "preparing"(トークンの不備など、来館者にはどうにもならない)/ "network"。 */
  function classify(error) {
    if (error && error.kind) return error.kind;
    var code = errorCode(error);
    if (code === "NOT_FOUND" || code === "UNKNOWN_ITEM") return "notFound";
    if (code === "AUTHENTICATION_FAILED" || code === "ACCESS_DENIED" || code === "BAD_REQUEST") return "preparing";
    return "network";
  }

  /** fetchRecords の応答から、レコードか失敗かを取り出す(レコード無しは応答の中の失敗で返ることも、例外になることもある)。 */
  function pickRecord(response) {
    var first = response && response.records && response.records[0];
    if (first && first.recordName && first.fields) return first;
    var error = first && (first.serverErrorCode || first.ckErrorCode) ? first : (response && response.errors && response.errors[0]);
    throw error || { serverErrorCode: "NOT_FOUND" };
  }

  function fetchItem(recordName) {
    var config = window.TAKEAWAY_CONFIG || {};
    if (!config.apiToken || !config.containerIdentifier) return Promise.reject({ kind: "preparing" });
    return loadCloudKit().then(function (CloudKit) {
      CloudKit.configure({
        containers: [{
          containerIdentifier: config.containerIdentifier,
          apiTokenAuth: { apiToken: config.apiToken, persist: false },
          environment: config.environment || "production"
        }]
      });
      var database = CloudKit.getDefaultContainer().publicCloudDatabase;
      return database.fetchRecords([recordName]);
    }).then(pickRecord);
  }

  function init() {
    var root = document.getElementById("app");
    if (!root) return;
    try {
      var id = parseId(window.location.search);
      if (!id) { showMessage(root, MESSAGES.badId, true); return; }
      showMessage(root, MESSAGES.loading, false);
      withTimeout(fetchItem(recordNameFor(id))).then(function (record) {
        render(root, toView(record));
      }).catch(function (error) {
        var kind = classify(error);
        showMessage(root, MESSAGES[kind] || MESSAGES.network, true);
      });
    } catch (e) {
      showMessage(root, MESSAGES.network, true);      // 想定外でも白画面にしない
    }
  }

  window.Takeaway = {
    MESSAGES: MESSAGES, parseId: parseId, recordNameFor: recordNameFor, assetUrl: assetUrl, toView: toView,
    isExpired: isExpired, createdAtMs: createdAtMs, LIFETIME_MS: LIFETIME_MS,
    render: render, showMessage: showMessage, showExpired: showExpired, classify: classify, pickRecord: pickRecord, init: init
  };

  if (!window.TAKEAWAY_NO_AUTORUN) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }
})();
