/**
 * トマト栽培管理アプリ バックエンド（Google Apps Script）
 *
 * 使い方:
 * 1. 新しいスプレッドシートを作り、拡張機能 > Apps Script を開く
 * 2. このコードを貼り付けて保存
 * 3. エディタ上で setup 関数を1回実行（シートが自動作成され、初期マスタが入る）
 * 4. デプロイ > 新しいデプロイ > ウェブアプリ
 *    - 次のユーザーとして実行: 自分
 *    - アクセスできるユーザー: 全員
 * 5. 発行されたURL（…/exec）を frontend/config.js の GAS_URL に設定
 *
 * スタッフ運用に切り替える際は、プロジェクトの設定 > スクリプトプロパティに
 * APP_TOKEN を設定し、frontend/config.js の APP_TOKEN に同じ値を入れると
 * 簡易トークン認証が有効になる（未設定の間は誰でも書き込める）。
 *
 * 気象データの自動更新を使うには、setup実行後に setupWeatherTrigger を
 * 1回だけエディタから実行する（毎日の自動取得トリガーを登録する）。
 *
 * このアプリの防除記録は「日々の記録を気軽に残す簡易帳簿」として設計している。
 * 正式な法定帳簿（農薬取締法省令9条）としてそのまま提出する場合は、
 * 別途、内容を確認のうえ正式な様式へ転記することを想定している。
 */

var TZ = "Asia/Tokyo";

// 気象データの取得地点（千葉市緑区の代表座標。拠点ごとの個別座標は使わず全体で統一）
var WEATHER_LAT = 35.5605;
var WEATHER_LON = 140.1762;

var SHEET_WORK = "作業記録";
var SHEET_PESTICIDE = "防除記録";
var SHEET_PESTICIDE_ITEMS = "防除記録明細";
var SHEET_MASTER_BASE = "マスタ_拠点棟";
var SHEET_MASTER_WORKTYPE = "マスタ_作業分類";
var SHEET_MASTER_PESTICIDE = "マスタ_農薬";
var SHEET_MASTER_CROP = "マスタ_品目";
var SHEET_RECIPE = "マスタ_防除レシピ";
var SHEET_RECIPE_ITEMS = "マスタ_防除レシピ明細";
var SHEET_WEATHER = "気象データ";

var WORK_HEADERS = [
  "記録ID", "作業日", "記録日時", "拠点", "棟・区画", "作業分類", "作業詳細",
  "開始時刻", "終了時刻", "所要時間分", "数量", "数量単位",
  "記録者", "userId", "備考", "状態", "更新日時",
];

// 防除記録（親）: 1回の散布イベント。法定5項目のうち日付・場所・作物はここに1つ持つ
var PESTICIDE_HEADERS = [
  "記録ID", "使用年月日", "拠点", "棟・区画", "農作物の種類", "対象病害虫",
  "レシピ名", "記録者", "userId", "備考", "状態", "更新日時",
];

// 防除記録明細（子）: 親1件に対して薬剤ごとに複数行。法定5項目のうち農薬名・使用量/希釈倍数はここ
var PESTICIDE_ITEM_HEADERS = [
  "記録ID", "薬剤名", "希釈倍数", "使用量", "使用量単位", "散布液量L",
];

var MASTER_BASE_HEADERS = ["拠点ID", "拠点名", "棟区画名", "面積a", "デフォルト品目", "有効フラグ", "表示順"];
var MASTER_WORKTYPE_HEADERS = ["作業ID", "作業名", "農薬関連フラグ", "表示順", "有効フラグ"];
var MASTER_PESTICIDE_HEADERS = [
  "薬剤ID", "薬剤名", "区分", "有効成分", "系統・IRAC/FRACコード", "登録番号",
  "主な対象病害虫", "希釈倍率目安", "PHI目安", "有機JAS適合", "必要な保護具", "備考・出典", "有効フラグ",
];
var MASTER_CROP_HEADERS = ["品目ID", "品目名", "品種", "備考"];

// 防除レシピ（親）: 事前に決めた処方。散布時はレシピを選ぶだけで明細が自動入力される
var RECIPE_HEADERS = ["レシピID", "レシピ名", "対象病害虫", "使用時期の目安", "備考", "有効フラグ"];
// 防除レシピ明細（子）: レシピに紐づく薬剤の組み合わせ
var RECIPE_ITEM_HEADERS = ["レシピID", "表示順", "薬剤名", "希釈倍数", "使用量", "使用量単位"];

var WEATHER_HEADERS = ["日付", "取得区分", "最高気温", "最低気温", "天気概況", "天気コード", "降水確率", "取得日時", "更新日時"];

// WMO Weather interpretation codes → 日本語ラベル（Open-Meteo公式の分類に準拠）
var WEATHER_CODE_LABELS = {
  0: "快晴", 1: "ほぼ晴れ", 2: "一部曇り", 3: "曇り",
  45: "霧", 48: "霧（着氷）",
  51: "霧雨（弱）", 53: "霧雨（並）", 55: "霧雨（強）",
  56: "着氷性の霧雨（弱）", 57: "着氷性の霧雨（強）",
  61: "雨（弱）", 63: "雨（並）", 65: "雨（強）",
  66: "着氷性の雨（弱）", 67: "着氷性の雨（強）",
  71: "雪（弱）", 73: "雪（並）", 75: "雪（強）", 77: "細氷",
  80: "にわか雨（弱）", 81: "にわか雨（並）", 82: "にわか雨（激しい）",
  85: "にわか雪（弱）", 86: "にわか雪（強）",
  95: "雷雨", 96: "雷雨（雹弱）", 99: "雷雨（雹強）",
};

function weatherCodeToLabel_(code) {
  return WEATHER_CODE_LABELS[code] || ("不明(" + code + ")");
}

// ===================================================================
// 初期セットアップ。最初に1回だけエディタから実行する
// ===================================================================
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_WORK, WORK_HEADERS);
  ensureSheet_(ss, SHEET_PESTICIDE, PESTICIDE_HEADERS);
  ensureSheet_(ss, SHEET_PESTICIDE_ITEMS, PESTICIDE_ITEM_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_BASE, MASTER_BASE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_WORKTYPE, MASTER_WORKTYPE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_PESTICIDE, MASTER_PESTICIDE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_CROP, MASTER_CROP_HEADERS);
  ensureSheet_(ss, SHEET_RECIPE, RECIPE_HEADERS);
  ensureSheet_(ss, SHEET_RECIPE_ITEMS, RECIPE_ITEM_HEADERS);
  ensureSheet_(ss, SHEET_WEATHER, WEATHER_HEADERS);
  seedMastersIfEmpty_(ss);
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // 既存シートに不足列があれば末尾に追加（後からの機能追加に対応）
  var lastCol = Math.max(1, sheet.getLastColumn());
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  headers.forEach(function (h) {
    if (existing.indexOf(h) < 0) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
      existing.push(h);
    }
  });
  return sheet;
}

// マスタが空のときだけ初期データを投入する（2回目以降のsetup実行では上書きしない）
function seedMastersIfEmpty_(ss) {
  var baseSheet = ss.getSheetByName(SHEET_MASTER_BASE);
  if (baseSheet.getLastRow() < 2) {
    baseSheet.getRange(2, 1, 5, MASTER_BASE_HEADERS.length).setValues([
      ["B01", "研修先(平川)", "ハウス", "", "トマト", "TRUE", 1],
      ["B02", "研修先(野呂)", "1号棟", "", "トマト", "TRUE", 2],
      ["B03", "研修先(野呂)", "2号棟", "", "トマト", "TRUE", 3],
      ["B04", "研修先(野呂)", "3号棟", "", "トマト", "TRUE", 4],
      ["B05", "農政センター", "ハウス1棟", "", "トマト", "FALSE", 5],
    ]);
  }

  var workSheet = ss.getSheetByName(SHEET_MASTER_WORKTYPE);
  if (workSheet.getLastRow() < 2) {
    var works = [
      ["定植", "FALSE"], ["誘引", "FALSE"], ["葉かき", "FALSE"], ["芽かき", "FALSE"],
      ["摘果", "FALSE"], ["収穫", "FALSE"], ["防除", "TRUE"], ["灌水", "FALSE"],
      ["清掃", "FALSE"], ["観察", "FALSE"], ["その他", "FALSE"],
    ];
    var rows = works.map(function (w, i) {
      return ["W" + (i + 1), w[0], w[1], i + 1, "TRUE"];
    });
    workSheet.getRange(2, 1, rows.length, MASTER_WORKTYPE_HEADERS.length).setValues(rows);
  }

  // 保護具は薬剤ラベルの記載が正であり、ここは一般的な目安。使用前に必ずラベル・登録情報を確認する
  var pestSheet = ss.getSheetByName(SHEET_MASTER_PESTICIDE);
  if (pestSheet.getLastRow() < 2) {
    pestSheet.getRange(2, 1, 3, MASTER_PESTICIDE_HEADERS.length).setValues([
      ["P01", "スミチオン乳剤", "殺虫剤", "MEP（フェニトロチオン）50%", "有機リン系・IRAC 1B", "",
        "チョウ目・カメムシ・アブラムシ等", "作物ごとにラベル確認", "作物ごとにラベル確認", "FALSE",
        "保護メガネ・防除用マスク・不浸透性手袋・長袖長ズボン（目安。ラベル要確認）", "農薬・防除メモ.mdより転記", "TRUE"],
      ["P02", "BTゼンターリ顆粒水和剤", "生物殺虫剤（微生物）", "BT（アイザワイ系統）生芽胞＋結晶毒素10%", "BT剤・IRAC 11A", "",
        "鱗翅目（チョウ目）幼虫", "作物ごとにラベル確認", "作物ごとにラベル確認", "TRUE",
        "マスク・手袋（目安。ラベル要確認）", "農薬・防除メモ.mdより転記", "TRUE"],
      ["P03", "フーモン", "殺虫剤（気門封鎖剤）", "ポリグリセリン脂肪酸エステル82.5%", "気門封鎖剤（IRAC対象外）", "23741号",
        "ハダニ類・アブラムシ類・コナジラミ類、うどんこ病", "1000倍", "収穫前日まで", "FALSE",
        "マスク・手袋（目安。ラベル要確認）", "農薬・防除メモ.mdより転記", "TRUE"],
    ]);
  }

  var cropSheet = ss.getSheetByName(SHEET_MASTER_CROP);
  if (cropSheet.getLastRow() < 2) {
    cropSheet.getRange(2, 1, 1, MASTER_CROP_HEADERS.length).setValues([
      ["C01", "トマト", "", ""],
    ]);
  }

  // サンプルレシピ（使い方の見本。実際の薬剤選定は防除基準・登録情報の確認が前提）
  var recipeSheet = ss.getSheetByName(SHEET_RECIPE);
  if (recipeSheet.getLastRow() < 2) {
    recipeSheet.getRange(2, 1, 1, RECIPE_HEADERS.length).setValues([
      ["R01", "コナジラミ対策（フーモン単剤）", "コナジラミ類・ハダニ類", "発生初期", "サンプルレシピ。使う前に登録情報・防除基準を確認", "TRUE"],
    ]);
  }
  var recipeItemSheet = ss.getSheetByName(SHEET_RECIPE_ITEMS);
  if (recipeItemSheet.getLastRow() < 2) {
    recipeItemSheet.getRange(2, 1, 1, RECIPE_ITEM_HEADERS.length).setValues([
      ["R01", 1, "フーモン", "1000倍", "", ""],
    ]);
  }
}

// ===================================================================
// 簡易トークン認証（APP_TOKEN未設定の間は無効＝誰でも書き込める）
// ===================================================================
function checkToken_(data) {
  var token = PropertiesService.getScriptProperties().getProperty("APP_TOKEN");
  if (!token) return true;
  return data.token === token;
}

// ===================================================================
// doPost（type分岐）
// ===================================================================
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (!checkToken_(data)) return json_({ ok: false, error: "unauthorized" });

    if (data.type === "pesticide") return savePesticide_(data);
    if (data.type === "updateRecord") return updateRecord_(data);
    if (data.type === "cancelRecord") return cancelRecord_(data);
    if (data.type === "cancelPesticide") return cancelPesticide_(data);
    return saveWork_(data); // 無指定 or "record"
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function saveWork_(data) {
  if (!data.base) return json_({ ok: false, error: "拠点を選択してください" });
  if (!data.workType) return json_({ ok: false, error: "作業分類を選択してください" });

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var now = new Date();
  var nowStr = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");
  var id = Utilities.getUuid();
  sheet.appendRow([
    id,
    data.workDate || Utilities.formatDate(now, TZ, "yyyy-MM-dd"),
    nowStr,
    data.base,
    data.building || "",
    data.workType,
    data.workDetail || "",
    data.startTime || "",
    data.endTime || "",
    data.durationMin || "",
    data.quantity || "",
    data.quantityUnit || "",
    data.recorder || "",
    data.userId || "",
    data.note || "",
    "完了",
    nowStr,
  ]);
  return json_({ ok: true, id: id });
}

// 防除記録は「気軽に残す簡易帳簿」という位置づけ。法定5項目のうち
// 農薬名・使用量/希釈倍数は明細（items）側でチェックする
function validatePesticide_(data) {
  var missing = [];
  if (!data.useDate) missing.push("使用年月日");
  if (!data.base) missing.push("使用場所（拠点）");
  if (!data.crop) missing.push("農作物の種類");
  var items = data.items || [];
  if (items.length === 0) {
    missing.push("農薬（少なくとも1件）");
  } else {
    items.forEach(function (it, idx) {
      var n = idx + 1;
      if (!it.pesticideName) missing.push(n + "件目の農薬名");
      var hasDilution = !!it.dilution;
      var hasAmount = !!(it.amount && it.amountUnit);
      if (!hasDilution && !hasAmount) missing.push(n + "件目の希釈倍数または使用量");
    });
  }
  return missing;
}

function savePesticide_(data) {
  var missing = validatePesticide_(data);
  if (missing.length > 0) {
    return json_({ ok: false, error: "必須項目が未入力です: " + missing.join("、") });
  }

  var now = new Date();
  var nowStr = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");
  var id = Utilities.getUuid();

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PESTICIDE);
  sheet.appendRow([
    id,
    data.useDate,
    data.base,
    data.building || "",
    data.crop,
    data.targetPest || "",
    data.recipeName || "",
    data.recorder || "",
    data.userId || "",
    data.note || "",
    "完了",
    nowStr,
  ]);

  var itemSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PESTICIDE_ITEMS);
  var itemRows = data.items.map(function (it) {
    return [id, it.pesticideName, it.dilution || "", it.amount || "", it.amountUnit || "", it.totalVolumeL || ""];
  });
  itemSheet.getRange(itemSheet.getLastRow() + 1, 1, itemRows.length, PESTICIDE_ITEM_HEADERS.length).setValues(itemRows);

  return json_({ ok: true, id: id });
}

// 作業記録の編集。当日分・本人の記録のみ許可
function updateRecord_(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var values = sheet.getDataRange().getValues();
  var idCol = WORK_HEADERS.indexOf("記録ID");
  var dateCol = WORK_HEADERS.indexOf("作業日");
  var uidCol = WORK_HEADERS.indexOf("userId");
  var todayStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");

  for (var i = 1; i < values.length; i++) {
    if (values[i][idCol] !== data.id) continue;
    if (values[i][uidCol] !== (data.userId || "")) {
      return json_({ ok: false, error: "本人の記録のみ編集できます" });
    }
    if (dateKey_(values[i][dateCol]) !== todayStr) {
      return json_({ ok: false, error: "当日分のみ編集できます" });
    }
    var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
    var updated = values[i].slice();
    setIfDefined_(updated, WORK_HEADERS, "拠点", data.base);
    setIfDefined_(updated, WORK_HEADERS, "棟・区画", data.building);
    setIfDefined_(updated, WORK_HEADERS, "作業分類", data.workType);
    setIfDefined_(updated, WORK_HEADERS, "作業詳細", data.workDetail);
    setIfDefined_(updated, WORK_HEADERS, "開始時刻", data.startTime);
    setIfDefined_(updated, WORK_HEADERS, "終了時刻", data.endTime);
    setIfDefined_(updated, WORK_HEADERS, "所要時間分", data.durationMin);
    setIfDefined_(updated, WORK_HEADERS, "数量", data.quantity);
    setIfDefined_(updated, WORK_HEADERS, "数量単位", data.quantityUnit);
    setIfDefined_(updated, WORK_HEADERS, "備考", data.note);
    updated[WORK_HEADERS.indexOf("更新日時")] = nowStr;
    sheet.getRange(i + 1, 1, 1, WORK_HEADERS.length).setValues([updated]);
    return json_({ ok: true });
  }
  return json_({ ok: false, error: "対象の記録が見つかりません" });
}

function setIfDefined_(rowArray, headers, headerName, value) {
  if (value === undefined) return;
  rowArray[headers.indexOf(headerName)] = value;
}

// 作業記録の取消（論理削除）。当日・本人のみ
function cancelRecord_(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var values = sheet.getDataRange().getValues();
  var idCol = WORK_HEADERS.indexOf("記録ID");
  var dateCol = WORK_HEADERS.indexOf("作業日");
  var uidCol = WORK_HEADERS.indexOf("userId");
  var stateCol = WORK_HEADERS.indexOf("状態");
  var updatedCol = WORK_HEADERS.indexOf("更新日時");
  var todayStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");

  for (var i = 1; i < values.length; i++) {
    if (values[i][idCol] !== data.id) continue;
    if (values[i][uidCol] !== (data.userId || "")) {
      return json_({ ok: false, error: "本人の記録のみ取消できます" });
    }
    if (dateKey_(values[i][dateCol]) !== todayStr) {
      return json_({ ok: false, error: "当日分のみ取消できます" });
    }
    var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
    sheet.getRange(i + 1, stateCol + 1).setValue("取消");
    sheet.getRange(i + 1, updatedCol + 1).setValue(nowStr);
    return json_({ ok: true });
  }
  return json_({ ok: false, error: "対象の記録が見つかりません" });
}

// 防除記録の取消（簡易帳簿として運用するため理由入力は求めない。論理削除で明細は残す）
function cancelPesticide_(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PESTICIDE);
  var values = sheet.getDataRange().getValues();
  var idCol = PESTICIDE_HEADERS.indexOf("記録ID");
  var uidCol = PESTICIDE_HEADERS.indexOf("userId");
  var stateCol = PESTICIDE_HEADERS.indexOf("状態");
  var updatedCol = PESTICIDE_HEADERS.indexOf("更新日時");

  for (var i = 1; i < values.length; i++) {
    if (values[i][idCol] !== data.id) continue;
    if (values[i][uidCol] !== (data.userId || "")) {
      return json_({ ok: false, error: "本人の記録のみ取消できます" });
    }
    var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
    sheet.getRange(i + 1, stateCol + 1).setValue("取消");
    sheet.getRange(i + 1, updatedCol + 1).setValue(nowStr);
    return json_({ ok: true });
  }
  return json_({ ok: false, error: "対象の記録が見つかりません" });
}

// ===================================================================
// doGet（action分岐）
// ===================================================================
function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || "";

  if (action === "masters") return getMasters_();
  if (action === "records") return getRecords_(params);
  if (action === "pesticides") return getPesticides_(params);
  if (action === "mytoday") return getMyToday_(params);
  if (action === "history") return getHistory_(params);
  if (action === "weather") return getWeather_(params);
  if (action === "weatherRange") return getWeatherRange_(params);
  if (action === "debug") return getDebug_();

  return json_({ ok: true, message: "tomato-farm-manager API" });
}

function getMasters_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return json_({
    ok: true,
    bases: sheetToObjects_(ss, SHEET_MASTER_BASE, MASTER_BASE_HEADERS),
    workTypes: sheetToObjects_(ss, SHEET_MASTER_WORKTYPE, MASTER_WORKTYPE_HEADERS),
    pesticides: sheetToObjects_(ss, SHEET_MASTER_PESTICIDE, MASTER_PESTICIDE_HEADERS),
    crops: sheetToObjects_(ss, SHEET_MASTER_CROP, MASTER_CROP_HEADERS),
    recipes: sheetToObjects_(ss, SHEET_RECIPE, RECIPE_HEADERS),
    recipeItems: sheetToObjects_(ss, SHEET_RECIPE_ITEMS, RECIPE_ITEM_HEADERS),
  });
}

function sheetToObjects_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function rowToObject_(row, headers) {
  var obj = {};
  headers.forEach(function (h, i) {
    var v = row[i];
    obj[h] = v instanceof Date ? Utilities.formatDate(v, TZ, "yyyy-MM-dd HH:mm:ss") : v;
  });
  return obj;
}

function getRecords_(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var values = sheet.getDataRange().getValues();
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var base = params.base || "";
  var dateCol = WORK_HEADERS.indexOf("作業日");
  var baseCol = WORK_HEADERS.indexOf("拠点");
  var records = [];
  for (var i = 1; i < values.length; i++) {
    var d = dateKey_(values[i][dateCol]);
    if (d < from || d > to) continue;
    if (base && values[i][baseCol] !== base) continue;
    records.push(rowToObject_(values[i], WORK_HEADERS));
  }
  records.reverse(); // 新しい記録から
  return json_({ ok: true, records: records });
}

// 記録IDに紐づく防除記録明細（薬剤ごとの実績）を取得する
function getPesticideItems_(recordId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PESTICIDE_ITEMS);
  var values = sheet.getDataRange().getValues();
  var idCol = PESTICIDE_ITEM_HEADERS.indexOf("記録ID");
  var items = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][idCol] === recordId) items.push(rowToObject_(values[i], PESTICIDE_ITEM_HEADERS));
  }
  return items;
}

function getPesticides_(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PESTICIDE);
  var values = sheet.getDataRange().getValues();
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var base = params.base || "";
  var dateCol = PESTICIDE_HEADERS.indexOf("使用年月日");
  var baseCol = PESTICIDE_HEADERS.indexOf("拠点");
  var records = [];
  for (var i = 1; i < values.length; i++) {
    var d = dateKey_(values[i][dateCol]);
    if (d < from || d > to) continue;
    if (base && values[i][baseCol] !== base) continue;
    var rec = rowToObject_(values[i], PESTICIDE_HEADERS);
    rec.items = getPesticideItems_(rec["記録ID"]);
    records.push(rec);
  }
  records.reverse();
  return json_({ ok: true, records: records });
}

function getMyToday_(params) {
  var uid = String(params.userId || "");
  var today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var workSheet = ss.getSheetByName(SHEET_WORK);
  var workValues = workSheet.getDataRange().getValues();
  var wDateCol = WORK_HEADERS.indexOf("作業日");
  var wUidCol = WORK_HEADERS.indexOf("userId");
  var wStateCol = WORK_HEADERS.indexOf("状態");
  var work = [];
  for (var i = 1; i < workValues.length; i++) {
    if (dateKey_(workValues[i][wDateCol]) !== today) continue;
    if (workValues[i][wUidCol] !== uid) continue;
    if (workValues[i][wStateCol] === "取消") continue;
    work.push(rowToObject_(workValues[i], WORK_HEADERS));
  }

  var pestSheet = ss.getSheetByName(SHEET_PESTICIDE);
  var pestValues = pestSheet.getDataRange().getValues();
  var pDateCol = PESTICIDE_HEADERS.indexOf("使用年月日");
  var pUidCol = PESTICIDE_HEADERS.indexOf("userId");
  var pStateCol = PESTICIDE_HEADERS.indexOf("状態");
  var pesticide = [];
  for (var j = 1; j < pestValues.length; j++) {
    if (dateKey_(pestValues[j][pDateCol]) !== today) continue;
    if (pestValues[j][pUidCol] !== uid) continue;
    if (pestValues[j][pStateCol] === "取消") continue;
    var rec = rowToObject_(pestValues[j], PESTICIDE_HEADERS);
    rec.items = getPesticideItems_(rec["記録ID"]);
    pesticide.push(rec);
  }

  return json_({ ok: true, work: work, pesticide: pesticide });
}

function getHistory_(params) {
  var days = Math.max(1, Math.min(90, Number(params.days) || 14));
  var since = new Date();
  since.setDate(since.getDate() - days);
  var sinceKey = Utilities.formatDate(since, TZ, "yyyy-MM-dd");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var items = [];

  var workSheet = ss.getSheetByName(SHEET_WORK);
  var workValues = workSheet.getDataRange().getValues();
  var wDateCol = WORK_HEADERS.indexOf("作業日");
  var wStateCol = WORK_HEADERS.indexOf("状態");
  for (var i = 1; i < workValues.length; i++) {
    var d = dateKey_(workValues[i][wDateCol]);
    if (d < sinceKey) continue;
    if (workValues[i][wStateCol] === "取消") continue;
    var o = rowToObject_(workValues[i], WORK_HEADERS);
    o._type = "work";
    items.push(o);
  }

  var pestSheet = ss.getSheetByName(SHEET_PESTICIDE);
  var pestValues = pestSheet.getDataRange().getValues();
  var pDateCol = PESTICIDE_HEADERS.indexOf("使用年月日");
  var pStateCol = PESTICIDE_HEADERS.indexOf("状態");
  for (var j = 1; j < pestValues.length; j++) {
    var d2 = dateKey_(pestValues[j][pDateCol]);
    if (d2 < sinceKey) continue;
    if (pestValues[j][pStateCol] === "取消") continue;
    var o2 = rowToObject_(pestValues[j], PESTICIDE_HEADERS);
    o2._type = "pesticide";
    o2.items = getPesticideItems_(o2["記録ID"]);
    items.push(o2);
  }

  items.sort(function (a, b) {
    var da = a._type === "work" ? a["作業日"] : a["使用年月日"];
    var db = b._type === "work" ? b["作業日"] : b["使用年月日"];
    if (da < db) return 1;
    if (da > db) return -1;
    return 0;
  });

  return json_({ ok: true, items: items });
}

// 動作診断用。問題が解決したら消してよい
function getDebug_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return json_({
    ok: true,
    today: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"),
    sheetTimeZone: ss.getSpreadsheetTimeZone(),
    scriptTimeZone: Session.getScriptTimeZone(),
    sheets: ss.getSheets().map(function (s) { return s.getName(); }),
  });
}

// ===================================================================
// 気象データ（Open-Meteo。キー不要・無料枠で利用）
// ===================================================================

function getWeather_(params) {
  var date = params.date || Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WEATHER);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (dateKey_(values[i][0]) === date) {
      return json_({ ok: true, weather: rowToObject_(values[i], WEATHER_HEADERS) });
    }
  }
  return json_({ ok: true, weather: null });
}

function getWeatherRange_(params) {
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WEATHER);
  var values = sheet.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < values.length; i++) {
    var d = dateKey_(values[i][0]);
    if (d < from || d > to) continue;
    items.push(rowToObject_(values[i], WEATHER_HEADERS));
  }
  return json_({ ok: true, items: items });
}

// Open-Meteoから「今日の予報」と「昨日の実況に近い値（past_days）」をまとめて取得し、
// 気象データシートに保存/更新する（1日1回のトリガーで両方を同時に処理する）。
// 注意：past_daysで返る値はモデルの解析値ベースで、気象庁の観測実況そのものではないが、
// 翌日更新の用途としては十分な精度として扱う（詳細はセットアップ手順.md参照）
function fetchAndSaveWeather_() {
  var url = "https://api.open-meteo.com/v1/forecast?latitude=" + WEATHER_LAT + "&longitude=" + WEATHER_LON +
    "&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max" +
    "&timezone=Asia%2FTokyo&past_days=1&forecast_days=1";
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log("weather fetch failed: " + res.getResponseCode() + " " + res.getContentText());
    return;
  }
  var data = JSON.parse(res.getContentText());
  var daily = data.daily;
  if (!daily || !daily.time) return;

  var today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WEATHER);
  var values = sheet.getDataRange().getValues();
  var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  var dateCol = WEATHER_HEADERS.indexOf("日付");
  var fetchedCol = WEATHER_HEADERS.indexOf("取得日時");

  daily.time.forEach(function (dateStr) {
    var idx = daily.time.indexOf(dateStr);
    var kubun = dateStr < today ? "実績" : "予報"; // past_days分＝実績、当日分＝予報
    var row = [
      dateStr, kubun,
      daily.temperature_2m_max[idx], daily.temperature_2m_min[idx],
      weatherCodeToLabel_(daily.weather_code[idx]), daily.weather_code[idx],
      daily.precipitation_probability_max ? daily.precipitation_probability_max[idx] : "",
      nowStr, nowStr,
    ];
    var found = -1;
    for (var i = 1; i < values.length; i++) {
      if (dateKey_(values[i][dateCol]) === dateStr) { found = i; break; }
    }
    if (found >= 0) {
      row[fetchedCol] = values[found][fetchedCol]; // 取得日時（初回）は保持
      sheet.getRange(found + 1, 1, 1, WEATHER_HEADERS.length).setValues([row]);
      values[found] = row;
    } else {
      sheet.appendRow(row);
      values.push(row);
    }
  });
}

// 時間主導型トリガーから毎日呼ばれる本体
function dailyWeatherUpdate_() {
  fetchAndSaveWeather_();
}

// 気象データの自動更新（毎日1回・昨日分を実績に更新＋今日分の予報を取得）を設定する。
// setup実行後、エディタから1回だけ手動実行する（トリガーはコードpushだけでは有効化されない）
function setupWeatherTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "dailyWeatherUpdate_") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dailyWeatherUpdate_").timeBased().everyDays(1).atHour(5).create();
  fetchAndSaveWeather_(); // 登録と同時に初回分を取得しておく
}

// セルの値を "yyyy-MM-dd" 形式の文字列にそろえる
// （シートが文字列をDate型に自動変換しても、"2026/06/12"表記でも照合できるように）
function dateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  return String(v).trim().replace(/\//g, "-");
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
