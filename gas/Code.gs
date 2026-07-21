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
 */

var TZ = "Asia/Tokyo";

var SHEET_WORK = "作業記録";
var SHEET_PESTICIDE = "農薬散布記録";
var SHEET_MASTER_BASE = "マスタ_拠点棟";
var SHEET_MASTER_WORKTYPE = "マスタ_作業分類";
var SHEET_MASTER_PESTICIDE = "マスタ_農薬";
var SHEET_MASTER_CROP = "マスタ_品目";

var WORK_HEADERS = [
  "記録ID", "作業日", "記録日時", "拠点", "棟・区画", "作業分類", "作業詳細",
  "開始時刻", "終了時刻", "所要時間分", "数量", "数量単位",
  "天候", "気温", "記録者", "userId", "備考", "状態", "更新日時",
];

var PESTICIDE_HEADERS = [
  "記録ID", "使用年月日", "拠点", "棟・区画", "農作物の種類", "農薬の種類・名称",
  "希釈倍数", "使用量", "使用量単位", "散布液量合計L", "対象病害虫",
  "天候", "気温", "作業者名", "保護具着用", "記録者", "userId", "備考",
  "状態", "取消理由", "取消日時", "更新日時",
];

var MASTER_BASE_HEADERS = ["拠点ID", "拠点名", "棟区画名", "面積a", "デフォルト品目", "有効フラグ", "表示順"];
var MASTER_WORKTYPE_HEADERS = ["作業ID", "作業名", "農薬関連フラグ", "表示順", "有効フラグ"];
var MASTER_PESTICIDE_HEADERS = ["薬剤ID", "薬剤名", "区分", "有効成分", "系統・IRAC/FRACコード", "登録番号", "主な対象病害虫", "希釈倍率目安", "PHI目安", "有機JAS適合", "備考・出典", "有効フラグ"];
var MASTER_CROP_HEADERS = ["品目ID", "品目名", "品種", "備考"];

// ===================================================================
// 初期セットアップ。最初に1回だけエディタから実行する
// ===================================================================
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_WORK, WORK_HEADERS);
  ensureSheet_(ss, SHEET_PESTICIDE, PESTICIDE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_BASE, MASTER_BASE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_WORKTYPE, MASTER_WORKTYPE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_PESTICIDE, MASTER_PESTICIDE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_CROP, MASTER_CROP_HEADERS);
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
      ["定植", "FALSE"], ["誘引", "FALSE"], ["摘葉", "FALSE"], ["芽かき", "FALSE"],
      ["摘果", "FALSE"], ["収穫", "FALSE"], ["防除", "TRUE"], ["灌水", "FALSE"],
      ["整枝", "FALSE"], ["清掃", "FALSE"], ["観察", "FALSE"], ["その他", "FALSE"],
    ];
    var rows = works.map(function (w, i) {
      return ["W" + (i + 1), w[0], w[1], i + 1, "TRUE"];
    });
    workSheet.getRange(2, 1, rows.length, MASTER_WORKTYPE_HEADERS.length).setValues(rows);
  }

  var pestSheet = ss.getSheetByName(SHEET_MASTER_PESTICIDE);
  if (pestSheet.getLastRow() < 2) {
    pestSheet.getRange(2, 1, 3, MASTER_PESTICIDE_HEADERS.length).setValues([
      ["P01", "スミチオン乳剤", "殺虫剤", "MEP（フェニトロチオン）50%", "有機リン系・IRAC 1B", "", "チョウ目・カメムシ・アブラムシ等", "作物ごとにラベル確認", "作物ごとにラベル確認", "FALSE", "農薬・防除メモ.mdより転記", "TRUE"],
      ["P02", "BTゼンターリ顆粒水和剤", "生物殺虫剤（微生物）", "BT（アイザワイ系統）生芽胞＋結晶毒素10%", "BT剤・IRAC 11A", "", "鱗翅目（チョウ目）幼虫", "作物ごとにラベル確認", "作物ごとにラベル確認", "TRUE", "農薬・防除メモ.mdより転記", "TRUE"],
      ["P03", "フーモン", "殺虫剤（気門封鎖剤）", "ポリグリセリン脂肪酸エステル82.5%", "気門封鎖剤（IRAC対象外）", "23741号", "ハダニ類・アブラムシ類・コナジラミ類、うどんこ病", "1000倍", "収穫前日まで", "FALSE", "農薬・防除メモ.mdより転記", "TRUE"],
    ]);
  }

  var cropSheet = ss.getSheetByName(SHEET_MASTER_CROP);
  if (cropSheet.getLastRow() < 2) {
    cropSheet.getRange(2, 1, 1, MASTER_CROP_HEADERS.length).setValues([
      ["C01", "トマト", "", ""],
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
    data.weather || "",
    data.temperature || "",
    data.recorder || "",
    data.userId || "",
    data.note || "",
    "完了",
    nowStr,
  ]);
  return json_({ ok: true, id: id });
}

// 農薬取締法に基づく省令第9条の法定5項目をサーバー側でも検証する
// （クライアント検証だけに頼らない。①使用年月日②使用場所③農作物の種類④農薬の種類・名称⑤使用量or希釈倍数）
function validatePesticide_(data) {
  var missing = [];
  if (!data.useDate) missing.push("使用年月日");
  if (!data.base) missing.push("使用場所（拠点）");
  if (!data.crop) missing.push("農作物の種類");
  if (!data.pesticideName) missing.push("農薬の種類・名称");
  var hasDilution = !!data.dilution;
  var hasAmount = !!(data.amount && data.amountUnit);
  if (!hasDilution && !hasAmount) missing.push("希釈倍数または使用量のいずれか");
  return missing;
}

function savePesticide_(data) {
  var missing = validatePesticide_(data);
  if (missing.length > 0) {
    return json_({ ok: false, error: "必須項目が未入力です: " + missing.join("、") });
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PESTICIDE);
  var now = new Date();
  var nowStr = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");
  var id = Utilities.getUuid();
  sheet.appendRow([
    id,
    data.useDate,
    data.base,
    data.building || "",
    data.crop,
    data.pesticideName,
    data.dilution || "",
    data.amount || "",
    data.amountUnit || "",
    data.totalVolumeL || "",
    data.targetPest || "",
    data.weather || "",
    data.temperature || "",
    data.workerName || "",
    data.ppe || "",
    data.recorder || "",
    data.userId || "",
    data.note || "",
    "完了",
    "",
    "",
    nowStr,
  ]);
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

// 農薬散布記録の取消（法定帳簿のため論理削除のみ。行は物理削除しない）
function cancelPesticide_(data) {
  if (!data.reason) return json_({ ok: false, error: "取消理由を入力してください" });

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PESTICIDE);
  var values = sheet.getDataRange().getValues();
  var idCol = PESTICIDE_HEADERS.indexOf("記録ID");
  var stateCol = PESTICIDE_HEADERS.indexOf("状態");
  var reasonCol = PESTICIDE_HEADERS.indexOf("取消理由");
  var cancelDateCol = PESTICIDE_HEADERS.indexOf("取消日時");
  var updatedCol = PESTICIDE_HEADERS.indexOf("更新日時");

  for (var i = 1; i < values.length; i++) {
    if (values[i][idCol] !== data.id) continue;
    var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
    sheet.getRange(i + 1, stateCol + 1).setValue("取消");
    sheet.getRange(i + 1, reasonCol + 1).setValue(data.reason);
    sheet.getRange(i + 1, cancelDateCol + 1).setValue(nowStr);
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
    records.push(rowToObject_(values[i], PESTICIDE_HEADERS));
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
    pesticide.push(rowToObject_(pestValues[j], PESTICIDE_HEADERS));
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
