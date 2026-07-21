// 接続設定
// GAS_URLが空のままなら「お試しモード」で動く（記録はこの端末のブラウザ内にのみ保存される）。
// セットアップが済んだら値を入れる → docs/セットアップ手順.md 参照
const CONFIG = {
  // GASウェブアプリのURL（例: "https://script.google.com/macros/s/XXXX/exec"）
  GAS_URL: "https://script.google.com/macros/s/AKfycbyMGfsQMJ6U-IDtBaqEGru6k4KyI3-BcmyhKWMeGVkbGkK4rnRlFPPkVeqTd-Br_mpM/exec",

  // スタッフ運用に切り替える際の簡易トークン（GAS側スクリプトプロパティのAPP_TOKENと同じ値にする）
  // 空のままなら未使用（誰でも書き込める）
  APP_TOKEN: "",
};
