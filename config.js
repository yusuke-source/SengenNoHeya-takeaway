// 持ち帰りページの設定(CloudKit JS)。
// apiToken は CloudKit Console で発行した「ウェブ用 API トークン」を、公開前にここへ貼る(ブラウザに渡る前提の読み取り用トークン。許可するドメインは GitHub Pages の公開先だけにする)。
// 空のままなら、ページは「準備中です」と出して止まる(例外で白画面にしない)。
window.TAKEAWAY_CONFIG = {
  containerIdentifier: "iCloud.com.gerhard17.SengenNoHeya",
  environment: "production",
  apiToken: "102b14fe3dd832d2be5c435f4610479a3bac48d685e5b6fe4402b4d0bd091a17"
};
