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
 * コードを更新した後は、Apps Scriptエディタで関数を実行するだけでなく、
 * 「デプロイ」→「デプロイを管理」→ 既存デプロイの編集 →
 * バージョン「新バージョン」を選んで再デプロイしないと、公開URL（/exec）は
 * 古いコードのまま動き続ける（エディタでの実行と公開URLは別物）。
 *
 * clientId 列を追加したので、このコードに更新したら setup を1回実行すること。
 * ensureSheet_ が既存シートの末尾に clientId 列を足す。列が無い間は重複の
 * 照合が効かない（findByClientId_ が空を返す）だけで、記録自体は従来どおり動く。
 *
 * 旧「防除記録」構成から移行する場合は、setup より先に migrateToSpray を
 * 1回だけ実行する（シート名を散布記録系へ改名する）。
 *
 * スタッフ運用に切り替える際は、プロジェクトの設定 > スクリプトプロパティに
 * APP_TOKEN を設定し、frontend/config.js の APP_TOKEN に同じ値を入れると
 * 簡易トークン認証が有効になる（未設定の間は誰でも書き込める）。
 *
 * 気象データの自動更新を使うには、setup実行後に setupWeatherTrigger を
 * 1回だけエディタから実行する（毎日の自動取得トリガーを登録する）。
 *
 * このアプリの散布記録は「日々の記録を気軽に残す簡易帳簿」として設計している。
 * 正式な法定帳簿（農薬取締法省令9条）としてそのまま提出する場合は、
 * action=legalLedger で農薬登録のある資材だけを抽出し、内容を確認のうえ
 * 正式な様式へ転記することを想定している。
 *
 * データの読み書きはすべて「シートの実際のヘッダー行を都度読んで列名で対応させる」
 * 方式にしている（ensureSheet_が既存シートに新しい列を追加するとき「末尾」に
 * 追加するため、コード側のヘッダー定義の並び順とシートの物理的な列順は一致しない
 * ことがある。列インデックスを決め打ちすると値がズレるので、必ず名前で引く）。
 */

var TZ = "Asia/Tokyo";

// 気象データの取得地点（千葉市緑区の代表座標。拠点ごとの個別座標は使わず全体で統一）
var WEATHER_LAT = 35.5605;
var WEATHER_LON = 140.1762;

var SHEET_WORK = "作業記録";
var SHEET_SPRAY = "散布記録";
var SHEET_SPRAY_ITEMS = "散布記録明細";
var SHEET_MASTER_BASE = "マスタ_拠点棟";
var SHEET_MASTER_WORKTYPE = "マスタ_作業分類";
var SHEET_MASTER_MATERIAL = "マスタ_資材";
var SHEET_MASTER_CROP = "マスタ_品目";
var SHEET_MASTER_PURPOSE = "マスタ_散布目的";
var SHEET_RECIPE = "マスタ_散布レシピ";
var SHEET_RECIPE_ITEMS = "マスタ_散布レシピ明細";
var SHEET_GROWTH = "生育調査";
var SHEET_GROWTH_ITEMS = "生育調査明細";
var SHEET_WEATHER = "気象データ";

// 目的タグを1つの列にまとめるときの区切り文字。マスタの目的名にこの文字は使わない
var PURPOSE_SEPARATOR = "、";

// clientId は端末側が採番する送信の識別子。
// 送信が失敗したように見えて実際は保存されていることがあり（GASのリダイレクトが
// 不安定なため）、押し直しで同じ記録が何件も入る事故が起きた。同じ clientId が
// 既にあれば書き込まずに既存の記録IDを返すことで、何度送っても1件にする
var WORK_HEADERS = [
  "記録ID", "作業日", "記録日時", "拠点", "棟・区画", "作業分類", "作業詳細",
  "開始時刻", "終了時刻", "所要時間分", "数量", "数量単位",
  "記録者", "userId", "備考", "状態", "更新日時", "clientId",
];

// 散布記録（親）: 1回の散布イベント。農薬・葉面散布肥料・展着剤をまとめて1回として扱う
var SPRAY_HEADERS = [
  "記録ID", "使用年月日", "拠点", "棟・区画", "農作物の種類", "散布区分",
  "目的タグ", "目的自由入力", "レシピ名",
  "開始時刻", "終了時刻", "所要時間分",
  "記録者", "userId", "備考", "状態", "更新日時", "clientId",
];

// 散布記録明細（子）: 親1件に対して資材ごとに複数行。
// 区分・農薬登録の有無は保存時点のマスタ値をコピーして固定する
// （後からマスタを直しても、過去の帳簿の抽出結果が遡って変わらないようにするため）
var SPRAY_ITEM_HEADERS = [
  "記録ID", "資材名", "区分", "農薬登録の有無", "希釈倍数", "使用量", "使用量単位", "散布液量L",
];

var MASTER_BASE_HEADERS = ["拠点ID", "拠点名", "棟区画名", "面積a", "デフォルト品目", "有効フラグ", "表示順"];
var MASTER_WORKTYPE_HEADERS = ["作業ID", "作業名", "農薬関連フラグ", "表示順", "有効フラグ"];
var MASTER_MATERIAL_HEADERS = [
  "薬剤ID", "薬剤名", "区分", "有効成分", "系統・IRAC/FRACコード", "登録番号",
  "主な対象病害虫", "希釈倍率目安", "PHI目安", "有機JAS適合", "必要な保護具",
  "農薬登録の有無", "備考・出典", "有効フラグ",
];
var MASTER_CROP_HEADERS = ["品目ID", "品目名", "品種", "備考"];
var MASTER_PURPOSE_HEADERS = ["目的ID", "目的名", "分類", "表示順", "有効フラグ"];

// 散布レシピ（親）: 事前に決めた処方。散布時はレシピを選ぶだけで明細が自動入力される
var RECIPE_HEADERS = ["レシピID", "レシピ名", "対象病害虫", "使用時期の目安", "備考", "有効フラグ"];
// 散布レシピ明細（子）: レシピに紐づく資材の組み合わせ
var RECIPE_ITEM_HEADERS = ["レシピID", "表示順", "薬剤名", "希釈倍数", "使用量", "使用量単位"];

// 生育調査（親）: 1回の調査。週1回・中庸な株を4〜8株みるのが公的資料の標準
var GROWTH_HEADERS = [
  "記録ID", "調査日", "拠点", "棟・区画", "農作物の種類",
  "記録者", "userId", "所感", "状態", "更新日時", "clientId",
];

// 生育調査明細（子）: 株ごとの測定値。株ラベルを毎回そろえると同じ株の推移を追える。
// 茎径は測る位置で値が変わるので「生長点から15cm下」に固定する（熊本県の検証で
// 12〜18cmの範囲なら位置を統一すればばらつきが小さいと報告されている）。
// 花房下葉数は摘葉の判断（適正12枚）、開花段位と収穫段位の差（6段目安）は
// 草勢が続くかの判断に使う（いずれも岩手県の資料）
var GROWTH_ITEM_HEADERS = [
  "記録ID", "株ラベル",
  "茎径mm", "生長点花房距離cm", "草丈cm", "節間長cm",
  "開花段位", "収穫段位", "花房下葉数", "着果数", "葉数",
  "葉長cm", "果径mm",
  "尻腐れ果数", "裂果数", "その他障害果数", "障害果メモ",
  "成長点の形", "葉の角度", "葉の色", "花房", "メモ",
];

var WEATHER_HEADERS = ["日付", "取得区分", "最高気温", "最低気温", "天気概況", "天気コード", "降水確率", "取得日時", "更新日時"];

// 散布区分の判定に使う区分の分類。
// 展着剤は農薬登録があっても「防除をした」根拠にはしない（他の資材の効きを助けるだけのため）
var KUBUN_PEST_CONTROL = ["殺虫剤", "殺菌剤", "殺虫殺菌剤", "除草剤", "殺ダニ剤", "生物殺虫剤（微生物）", "殺虫剤（気門封鎖剤）"];
var KUBUN_FOLIAR = ["葉面散布肥料", "液体肥料", "葉面散布剤"];

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
// 旧「防除記録」構成からの移行。setup より先に1回だけ実行する
// ===================================================================
function migrateToSpray() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var renames = [
    ["防除記録", SHEET_SPRAY],
    ["防除記録明細", SHEET_SPRAY_ITEMS],
    ["マスタ_農薬", SHEET_MASTER_MATERIAL],
    ["マスタ_防除レシピ", SHEET_RECIPE],
    ["マスタ_防除レシピ明細", SHEET_RECIPE_ITEMS],
  ];
  var done = [];
  renames.forEach(function (pair) {
    var oldName = pair[0];
    var newName = pair[1];
    if (ss.getSheetByName(newName)) return;      // 既に新しい名前になっている
    var sheet = ss.getSheetByName(oldName);
    if (!sheet) return;                           // 旧シートがない（新規構築時）
    sheet.setName(newName);
    done.push(oldName + " → " + newName);
  });

  // 散布記録・明細は0件運用からの移行を前提に、ヘッダー行を新定義で置き直す。
  // データが入っている場合は列名の対応が崩れるため、ヘッダーの置き換えは行わない
  resetHeadersIfEmpty_(ss, SHEET_SPRAY, SPRAY_HEADERS, done);
  resetHeadersIfEmpty_(ss, SHEET_SPRAY_ITEMS, SPRAY_ITEM_HEADERS, done);

  Logger.log(done.length > 0 ? done.join("\n") : "移行対象はありませんでした");
  return done;
}

function resetHeadersIfEmpty_(ss, name, headers, done) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) return;
  if (sheet.getLastRow() >= 2) {
    done.push("⚠ " + name + " にデータがあるためヘッダーは置き換えませんでした（不足列は末尾に追加されます）");
    return;
  }
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  done.push(name + " のヘッダーを新構成に置き換えました");
}

// ===================================================================
// 初期セットアップ。最初に1回だけエディタから実行する
// ===================================================================
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_WORK, WORK_HEADERS);
  ensureSheet_(ss, SHEET_SPRAY, SPRAY_HEADERS);
  ensureSheet_(ss, SHEET_SPRAY_ITEMS, SPRAY_ITEM_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_BASE, MASTER_BASE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_WORKTYPE, MASTER_WORKTYPE_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_MATERIAL, MASTER_MATERIAL_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_CROP, MASTER_CROP_HEADERS);
  ensureSheet_(ss, SHEET_MASTER_PURPOSE, MASTER_PURPOSE_HEADERS);
  ensureSheet_(ss, SHEET_RECIPE, RECIPE_HEADERS);
  ensureSheet_(ss, SHEET_RECIPE_ITEMS, RECIPE_ITEM_HEADERS);
  ensureSheet_(ss, SHEET_GROWTH, GROWTH_HEADERS);
  ensureSheet_(ss, SHEET_GROWTH_ITEMS, GROWTH_ITEM_HEADERS);
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
  // 既存シートに不足列があれば末尾に追加（後からの機能追加に対応）。
  // 追加位置は末尾固定＝物理的な列順はコードのヘッダー定義と一致しなくなるため、
  // 値の読み書きは必ずヘッダー名で行う（headerMap_ / rowToObjectBySheet_ / objectToRowBySheet_）
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

// 実際のシートのヘッダー行を読み取り、ヘッダー名→列インデックス(0-based)のマップを返す
function headerMap_(sheet) {
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headerRow.forEach(function (h, i) { if (h) map[h] = i; });
  return map;
}

// {ヘッダー名: 値} のオブジェクトを、シートの実際の列順に並べた配列に変換する（appendRow/setValues用）
function objectToRowBySheet_(sheet, obj) {
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return headerRow.map(function (h) { return obj[h] !== undefined ? obj[h] : ""; });
}

// headerMap_ で得た列位置に従い、1行分の配列を {ヘッダー名: 値} に変換する（Date型は文字列化）
function rowToObjectBySheet_(headerMap, row) {
  var obj = {};
  Object.keys(headerMap).forEach(function (h) {
    var v = row[headerMap[h]];
    obj[h] = v instanceof Date ? Utilities.formatDate(v, TZ, "yyyy-MM-dd HH:mm:ss") : v;
  });
  return obj;
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

  // 防除・葉面散布は散布記録側で扱うため、作業分類には置かない。
  // トーン処理（トマトトーン＝植物成長調整剤）は着果の作業として作業分類に置いている。
  // 薬剤名・希釈倍数は残らないので、農薬の使用記録として必要なら散布記録側にも入れる
  var workSheet = ss.getSheetByName(SHEET_MASTER_WORKTYPE);
  if (workSheet.getLastRow() < 2) {
    var works = [
      ["定植", "FALSE"], ["誘引", "FALSE"], ["葉かき", "FALSE"], ["芽かき", "FALSE"],
      ["トーン処理", "TRUE"], ["摘果", "FALSE"], ["収穫", "FALSE"], ["灌水", "FALSE"],
      ["清掃", "FALSE"], ["観察", "FALSE"], ["その他", "FALSE"],
    ];
    var rows = works.map(function (w, i) {
      return ["W" + (i + 1), w[0], w[1], i + 1, "TRUE"];
    });
    workSheet.getRange(2, 1, rows.length, MASTER_WORKTYPE_HEADERS.length).setValues(rows);
  }

  // 保護具は資材ラベルの記載が正であり、ここは一般的な目安。使用前に必ずラベル・登録情報を確認する
  var matSheet = ss.getSheetByName(SHEET_MASTER_MATERIAL);
  if (matSheet.getLastRow() < 2) {
    matSheet.getRange(2, 1, 3, MASTER_MATERIAL_HEADERS.length).setValues([
      ["P01", "スミチオン乳剤", "殺虫剤", "MEP（フェニトロチオン）50%", "有機リン系・IRAC 1B", "",
        "チョウ目・カメムシ・アブラムシ等", "作物ごとにラベル確認", "作物ごとにラベル確認", "FALSE",
        "保護メガネ・防除用マスク・不浸透性手袋・長袖長ズボン（目安。ラベル要確認）", "TRUE",
        "農薬・防除メモ.mdより転記", "TRUE"],
      ["P02", "BTゼンターリ顆粒水和剤", "生物殺虫剤（微生物）", "BT（アイザワイ系統）生芽胞＋結晶毒素10%", "BT剤・IRAC 11A", "",
        "鱗翅目（チョウ目）幼虫", "作物ごとにラベル確認", "作物ごとにラベル確認", "TRUE",
        "マスク・手袋（目安。ラベル要確認）", "TRUE",
        "農薬・防除メモ.mdより転記", "TRUE"],
      ["P03", "フーモン", "殺虫剤（気門封鎖剤）", "ポリグリセリン脂肪酸エステル82.5%", "気門封鎖剤（IRAC対象外）", "23741号",
        "ハダニ類・アブラムシ類・コナジラミ類、うどんこ病", "1000倍", "収穫前日まで", "FALSE",
        "マスク・手袋（目安。ラベル要確認）", "TRUE",
        "農薬・防除メモ.mdより転記", "TRUE"],
    ]);
  }

  var cropSheet = ss.getSheetByName(SHEET_MASTER_CROP);
  if (cropSheet.getLastRow() < 2) {
    cropSheet.getRange(2, 1, 1, MASTER_CROP_HEADERS.length).setValues([
      ["C01", "トマト", "", ""],
    ]);
  }

  // 散布の目的。防除は病害虫名、葉面散布は生理症状・生育目的の言葉になる
  var purposeSheet = ss.getSheetByName(SHEET_MASTER_PURPOSE);
  if (purposeSheet.getLastRow() < 2) {
    var purposes = [
      ["コナジラミ類", "防除"], ["アザミウマ類", "防除"], ["ハモグリバエ類", "防除"],
      ["オオタバコガ", "防除"], ["ハスモンヨトウ", "防除"], ["トマトサビダニ", "防除"],
      ["葉かび病", "防除"], ["疫病", "防除"], ["うどんこ病", "防除"], ["灰色かび病", "防除"],
      ["尻腐れ予防", "生育・生理"], ["葉の黄化・微量要素補給", "生育・生理"],
      ["樹勢回復", "生育・生理"], ["新葉の伸長促進", "生育・生理"],
      ["徒長対策", "生育・生理"], ["軟果対策", "生育・生理"],
      ["着色改善", "生育・生理"], ["高温ストレス対策", "生育・生理"],
      ["根の酸欠対策", "生育・生理"],
    ];
    var prows = purposes.map(function (p, i) {
      return ["U" + (i + 1), p[0], p[1], i + 1, "TRUE"];
    });
    purposeSheet.getRange(2, 1, prows.length, MASTER_PURPOSE_HEADERS.length).setValues(prows);
  }

  // サンプルレシピ（使い方の見本。実際の資材選定は防除基準・登録情報の確認が前提）
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

    // "pesticide"/"cancelPesticide" は旧フロント互換のため残す
    if (data.type === "spray" || data.type === "pesticide") return saveSpray_(data);
    if (data.type === "updateRecord") return updateRecord_(data);
    if (data.type === "cancelRecord") return cancelRecord_(data);
    if (data.type === "cancelSpray" || data.type === "cancelPesticide") return cancelSpray_(data);
    if (data.type === "growth") return saveGrowth_(data);
    if (data.type === "cancelGrowth") return cancelGrowth_(data);
    if (data.type === "upsertMaster") return upsertMaster_(data);
    return saveWork_(data); // 無指定 or "record"
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 同じ clientId の記録が既にあれば、その記録IDを返す（無ければ空文字）。
// 端末が同じ送信を繰り返しても1件しか入らないようにするための照合
function findByClientId_(sheetName, clientId) {
  if (!clientId) return "";
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return "";
  var hm = headerMap_(sheet);
  if (hm["clientId"] === undefined || hm["記録ID"] === undefined) return ""; // 列が無い＝古いシート
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][hm["clientId"]]) === String(clientId)) return values[i][hm["記録ID"]];
  }
  return "";
}

function saveWork_(data) {
  if (!data.base) return json_({ ok: false, error: "拠点を選択してください" });
  if (!data.workType) return json_({ ok: false, error: "作業分類を選択してください" });

  var dup = findByClientId_(SHEET_WORK, data.clientId);
  if (dup) return json_({ ok: true, id: dup, duplicate: true });

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var now = new Date();
  var nowStr = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");
  var id = Utilities.getUuid();
  var obj = {
    "記録ID": id,
    "作業日": data.workDate || Utilities.formatDate(now, TZ, "yyyy-MM-dd"),
    "記録日時": nowStr,
    "拠点": data.base,
    "棟・区画": data.building || "",
    "作業分類": data.workType,
    "作業詳細": data.workDetail || "",
    "開始時刻": data.startTime || "",
    "終了時刻": data.endTime || "",
    "所要時間分": data.durationMin || "",
    "数量": data.quantity || "",
    "数量単位": data.quantityUnit || "",
    "記録者": data.recorder || "",
    "userId": data.userId || "",
    "備考": data.note || "",
    "状態": "完了",
    "更新日時": nowStr,
    "clientId": data.clientId || "",
  };
  sheet.appendRow(objectToRowBySheet_(sheet, obj));
  return json_({ ok: true, id: id });
}

// 散布記録は「気軽に残す簡易帳簿」という位置づけ。
// 農薬に限らず葉面散布肥料だけの散布も記録できるようにしている
function validateSpray_(data) {
  var missing = [];
  if (!data.useDate) missing.push("使用年月日");
  if (!data.base) missing.push("使用場所（拠点）");
  if (!data.crop) missing.push("農作物の種類");
  var items = data.items || [];
  if (items.length === 0) {
    missing.push("散布する資材（少なくとも1件）");
  } else {
    items.forEach(function (it, idx) {
      var n = idx + 1;
      if (!it.materialName && !it.pesticideName) missing.push(n + "件目の資材名");
      var hasDilution = !!it.dilution;
      var hasAmount = !!(it.amount && it.amountUnit);
      if (!hasDilution && !hasAmount) missing.push(n + "件目の希釈倍数または使用量");
    });
  }
  return missing;
}

// 資材名から、マスタの区分と農薬登録の有無を引く（見つからなければ空で返す）
function lookupMaterial_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MASTER_MATERIAL);
  if (!sheet || sheet.getLastRow() < 2) return { 区分: "", 農薬登録の有無: "" };
  var hm = headerMap_(sheet);
  var nameCol = hm["薬剤名"];
  if (nameCol === undefined) return { 区分: "", 農薬登録の有無: "" };
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][nameCol]) !== String(name)) continue;
    return {
      区分: hm["区分"] !== undefined ? values[i][hm["区分"]] : "",
      農薬登録の有無: hm["農薬登録の有無"] !== undefined ? values[i][hm["農薬登録の有無"]] : "",
    };
  }
  return { 区分: "", 農薬登録の有無: "" };
}

// 明細の区分から散布区分（防除／葉面散布／防除・葉面散布）を決める。
// 展着剤は農薬登録があっても判定に影響させない（他の資材の効きを助けるだけのため）
function decideSprayType_(itemRows) {
  var hasPest = false;
  var hasFoliar = false;
  itemRows.forEach(function (it) {
    var kubun = String(it["区分"] || "");
    if (KUBUN_PEST_CONTROL.indexOf(kubun) >= 0) hasPest = true;
    if (KUBUN_FOLIAR.indexOf(kubun) >= 0) hasFoliar = true;
  });
  if (hasPest && hasFoliar) return "防除・葉面散布";
  if (hasPest) return "防除";
  if (hasFoliar) return "葉面散布";
  return "その他";
}

function saveSpray_(data) {
  var missing = validateSpray_(data);
  if (missing.length > 0) {
    return json_({ ok: false, error: "必須項目が未入力です: " + missing.join("、") });
  }

  var dup = findByClientId_(SHEET_SPRAY, data.clientId);
  if (dup) return json_({ ok: true, id: dup, duplicate: true });

  var now = new Date();
  var nowStr = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");
  var id = Utilities.getUuid();

  // 先に明細を組み立てて、マスタから区分・農薬登録をスナップショットする
  var itemRows = data.items.map(function (it) {
    var name = it.materialName || it.pesticideName;
    var master = lookupMaterial_(name);
    return {
      "記録ID": id,
      "資材名": name,
      "区分": master.区分,
      "農薬登録の有無": master.農薬登録の有無,
      "希釈倍数": it.dilution || "",
      "使用量": it.amount || "",
      "使用量単位": it.amountUnit || "",
      "散布液量L": it.totalVolumeL || "",
    };
  });

  var purposeTags = (data.purposeTags || []).join(PURPOSE_SEPARATOR);

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SPRAY);
  var obj = {
    "記録ID": id,
    "使用年月日": data.useDate,
    "拠点": data.base,
    "棟・区画": data.building || "",
    "農作物の種類": data.crop,
    "散布区分": decideSprayType_(itemRows),
    "目的タグ": purposeTags,
    "目的自由入力": data.purposeFree || data.targetPest || "",
    "レシピ名": data.recipeName || "",
    "開始時刻": data.startTime || "",
    "終了時刻": data.endTime || "",
    "所要時間分": data.durationMin || "",
    "記録者": data.recorder || "",
    "userId": data.userId || "",
    "備考": data.note || "",
    "状態": "完了",
    "更新日時": nowStr,
    "clientId": data.clientId || "",
  };
  sheet.appendRow(objectToRowBySheet_(sheet, obj));

  var itemSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SPRAY_ITEMS);
  itemRows.forEach(function (row) {
    itemSheet.appendRow(objectToRowBySheet_(itemSheet, row));
  });

  return json_({ ok: true, id: id });
}

// 生育調査の保存。株ごとの測定値を明細として持つ。
// 数値は入っているものだけ記録する（器具がない日は目視だけでも残せるようにするため）
function validateGrowth_(data) {
  var missing = [];
  if (!data.surveyDate) missing.push("調査日");
  if (!data.base) missing.push("拠点");
  var items = data.items || [];
  if (items.length === 0) {
    missing.push("調査した株（少なくとも1株）");
  } else {
    items.forEach(function (it, idx) {
      if (!it.label) missing.push((idx + 1) + "件目の株ラベル");
    });
  }
  return missing;
}

function saveGrowth_(data) {
  var missing = validateGrowth_(data);
  if (missing.length > 0) {
    return json_({ ok: false, error: "必須項目が未入力です: " + missing.join("、") });
  }

  var dup = findByClientId_(SHEET_GROWTH, data.clientId);
  if (dup) return json_({ ok: true, id: dup, duplicate: true });

  var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  var id = Utilities.getUuid();

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GROWTH);
  sheet.appendRow(objectToRowBySheet_(sheet, {
    "記録ID": id,
    "調査日": data.surveyDate,
    "拠点": data.base,
    "棟・区画": data.building || "",
    "農作物の種類": data.crop || "",
    "記録者": data.recorder || "",
    "userId": data.userId || "",
    "所感": data.note || "",
    "状態": "完了",
    "更新日時": nowStr,
    "clientId": data.clientId || "",
  }));

  // 「0個だった」という記録にも意味があるので、0を空欄に潰さないようにする
  // （障害果が0だった週と、そもそも数えなかった週は区別したい）
  function keep_(v) {
    return (v === undefined || v === null || v === "") ? "" : v;
  }

  var itemSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GROWTH_ITEMS);
  data.items.forEach(function (it) {
    itemSheet.appendRow(objectToRowBySheet_(itemSheet, {
      "記録ID": id,
      "株ラベル": it.label,
      "茎径mm": keep_(it.stemDiameter),
      "生長点花房距離cm": keep_(it.trussDistance),
      "草丈cm": keep_(it.plantHeight),
      "節間長cm": keep_(it.internodeLength),
      "開花段位": keep_(it.floweringTruss),
      "収穫段位": keep_(it.harvestTruss),
      "花房下葉数": keep_(it.leavesBelowTruss),
      "着果数": keep_(it.fruitSet),
      "葉数": keep_(it.leafCount),
      "葉長cm": keep_(it.leafLength),
      "果径mm": keep_(it.fruitDiameter),
      "尻腐れ果数": keep_(it.blossomEndRot),
      "裂果数": keep_(it.cracking),
      "その他障害果数": keep_(it.otherDisorder),
      "障害果メモ": keep_(it.disorderMemo),
      "成長点の形": keep_(it.growingPoint),
      "葉の角度": keep_(it.leafAngle),
      "葉の色": keep_(it.leafColor),
      "花房": keep_(it.truss),
      "メモ": keep_(it.memo),
    }));
  });

  return json_({ ok: true, id: id });
}

function cancelGrowth_(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GROWTH);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  for (var i = 1; i < values.length; i++) {
    if (values[i][hm["記録ID"]] !== data.id) continue;
    if (values[i][hm["userId"]] !== (data.userId || "")) {
      return json_({ ok: false, error: "本人の記録のみ取消できます" });
    }
    var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
    sheet.getRange(i + 1, hm["状態"] + 1).setValue("取消");
    sheet.getRange(i + 1, hm["更新日時"] + 1).setValue(nowStr);
    return json_({ ok: true });
  }
  return json_({ ok: false, error: "対象の記録が見つかりません" });
}

// マスタへの行の追加・更新。
// 資材やレシピを手入力せずに登録できるようにするための窓口で、記録系シートは対象外。
// data = { sheet: "マスタ_資材", key: "薬剤ID"（複数列で照合するなら配列）, rows: [{列名: 値, ...}, ...] }
// key が一致する行があれば渡された列だけ上書きし、なければ新しい行として追加する。
function upsertMaster_(data) {
  var allowed = [
    SHEET_MASTER_BASE, SHEET_MASTER_WORKTYPE, SHEET_MASTER_MATERIAL,
    SHEET_MASTER_CROP, SHEET_MASTER_PURPOSE, SHEET_RECIPE, SHEET_RECIPE_ITEMS,
  ];
  if (allowed.indexOf(data.sheet) < 0) {
    return json_({ ok: false, error: "このシートは書き換えられません: " + data.sheet });
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(data.sheet);
  if (!sheet) return json_({ ok: false, error: "シートが見つかりません: " + data.sheet });

  var rows = data.rows || [];
  if (rows.length === 0) return json_({ ok: false, error: "rows が空です" });

  var keys = [].concat(data.key || []);
  if (keys.length === 0) return json_({ ok: false, error: "key（照合に使う列名）を指定してください" });

  var hm = headerMap_(sheet);
  for (var k = 0; k < keys.length; k++) {
    if (hm[keys[k]] === undefined) {
      return json_({ ok: false, error: "指定された列がシートにありません: " + keys[k] });
    }
  }

  // 目的名に区切り文字が入ると、目的タグを分解できなくなるので弾く
  if (data.sheet === SHEET_MASTER_PURPOSE) {
    for (var r = 0; r < rows.length; r++) {
      var nm = String(rows[r]["目的名"] || "");
      if (nm.indexOf(PURPOSE_SEPARATOR) >= 0) {
        return json_({ ok: false, error: "目的名に「" + PURPOSE_SEPARATOR + "」は使えません: " + nm });
      }
    }
  }

  var values = sheet.getDataRange().getValues();
  var added = 0;
  var updated = 0;

  rows.forEach(function (obj) {
    var found = -1;
    for (var i = 1; i < values.length; i++) {
      var matched = true;
      for (var j = 0; j < keys.length; j++) {
        if (String(values[i][hm[keys[j]]]) !== String(obj[keys[j]])) { matched = false; break; }
      }
      if (matched) { found = i; break; }
    }
    if (found >= 0) {
      // 渡された列だけ上書きする（既存の他の列を空にしないため）
      var merged = values[found].slice();
      Object.keys(obj).forEach(function (h) {
        if (hm[h] !== undefined) merged[hm[h]] = obj[h];
      });
      sheet.getRange(found + 1, 1, 1, merged.length).setValues([merged]);
      values[found] = merged;
      updated++;
    } else {
      var newRow = objectToRowBySheet_(sheet, obj);
      sheet.appendRow(newRow);
      values.push(newRow);
      added++;
    }
  });

  return json_({ ok: true, sheet: data.sheet, added: added, updated: updated });
}

// 作業記録の編集。当日分・本人の記録のみ許可
function updateRecord_(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  var idCol = hm["記録ID"];
  var dateCol = hm["作業日"];
  var uidCol = hm["userId"];
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
    setIfDefinedByMap_(updated, hm, "拠点", data.base);
    setIfDefinedByMap_(updated, hm, "棟・区画", data.building);
    setIfDefinedByMap_(updated, hm, "作業分類", data.workType);
    setIfDefinedByMap_(updated, hm, "作業詳細", data.workDetail);
    setIfDefinedByMap_(updated, hm, "開始時刻", data.startTime);
    setIfDefinedByMap_(updated, hm, "終了時刻", data.endTime);
    setIfDefinedByMap_(updated, hm, "所要時間分", data.durationMin);
    setIfDefinedByMap_(updated, hm, "数量", data.quantity);
    setIfDefinedByMap_(updated, hm, "数量単位", data.quantityUnit);
    setIfDefinedByMap_(updated, hm, "備考", data.note);
    updated[hm["更新日時"]] = nowStr;
    sheet.getRange(i + 1, 1, 1, updated.length).setValues([updated]);
    return json_({ ok: true });
  }
  return json_({ ok: false, error: "対象の記録が見つかりません" });
}

function setIfDefinedByMap_(rowArray, headerMap, headerName, value) {
  if (value === undefined) return;
  var idx = headerMap[headerName];
  if (idx !== undefined) rowArray[idx] = value;
}

// 作業記録の取消（論理削除）。当日・本人のみ
function cancelRecord_(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  var idCol = hm["記録ID"];
  var dateCol = hm["作業日"];
  var uidCol = hm["userId"];
  var stateCol = hm["状態"];
  var updatedCol = hm["更新日時"];
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

// 散布記録の取消（簡易帳簿として運用するため理由入力は求めない。論理削除で明細は残す）
function cancelSpray_(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SPRAY);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  var idCol = hm["記録ID"];
  var uidCol = hm["userId"];
  var stateCol = hm["状態"];
  var updatedCol = hm["更新日時"];

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
  if (action === "sprays" || action === "pesticides") return getSprays_(params);
  if (action === "mytoday") return getMyToday_(params);
  if (action === "history") return getHistory_(params);
  if (action === "growths") return getGrowths_(params);
  if (action === "lastGrowth") return getLastGrowth_(params);
  if (action === "legalLedger") return getLegalLedger_(params);
  if (action === "weather") return getWeather_(params);
  if (action === "weatherRange") return getWeatherRange_(params);
  if (action === "debug") return getDebug_();

  return json_({ ok: true, message: "tomato-farm-manager API" });
}

function getMasters_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var materials = sheetToObjects_(ss, SHEET_MASTER_MATERIAL);
  return json_({
    ok: true,
    bases: sheetToObjects_(ss, SHEET_MASTER_BASE),
    workTypes: sheetToObjects_(ss, SHEET_MASTER_WORKTYPE),
    materials: materials,
    pesticides: materials, // 旧フロント互換
    crops: sheetToObjects_(ss, SHEET_MASTER_CROP),
    purposes: sheetToObjects_(ss, SHEET_MASTER_PURPOSE),
    recipes: sheetToObjects_(ss, SHEET_RECIPE),
    recipeItems: sheetToObjects_(ss, SHEET_RECIPE_ITEMS),
  });
}

function sheetToObjects_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var hm = headerMap_(sheet);
  var lastCol = Math.max(1, sheet.getLastColumn());
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  return values.map(function (row) { return rowToObjectBySheet_(hm, row); });
}

function getRecords_(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WORK);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var base = params.base || "";
  var dateCol = hm["作業日"];
  var baseCol = hm["拠点"];
  var records = [];
  for (var i = 1; i < values.length; i++) {
    var d = dateKey_(values[i][dateCol]);
    if (d < from || d > to) continue;
    if (base && values[i][baseCol] !== base) continue;
    records.push(rowToObjectBySheet_(hm, values[i]));
  }
  records.reverse(); // 新しい記録から
  return json_({ ok: true, records: records });
}

// 明細シートを1回だけ読んで、記録IDごとにまとめた辞書を返す。
// 以前は親1件ごとに明細シート全体を読み直しており、記録が増えるほど
// 二乗で重くなっていた。一覧を作るときは必ずこれを1回呼んで使い回す
function itemsByRecordId_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  var hm = headerMap_(sheet);
  var idCol = hm["記録ID"];
  if (idCol === undefined) return map;
  var lastCol = Math.max(1, sheet.getLastColumn());
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  values.forEach(function (row) {
    var id = row[idCol];
    if (!id) return;
    if (!map[id]) map[id] = [];
    map[id].push(rowToObjectBySheet_(hm, row));
  });
  return map;
}

// 記録IDに紐づく散布記録明細（資材ごとの実績）を取得する。1件だけ要るとき用
function getSprayItems_(recordId) {
  return itemsByRecordId_(SHEET_SPRAY_ITEMS)[recordId] || [];
}

function getSprays_(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SPRAY);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var base = params.base || "";
  var dateCol = hm["使用年月日"];
  var baseCol = hm["拠点"];
  var itemMap = itemsByRecordId_(SHEET_SPRAY_ITEMS);
  var records = [];
  for (var i = 1; i < values.length; i++) {
    var d = dateKey_(values[i][dateCol]);
    if (d < from || d > to) continue;
    if (base && values[i][baseCol] !== base) continue;
    var rec = rowToObjectBySheet_(hm, values[i]);
    rec.items = itemMap[rec["記録ID"]] || [];
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
  var whm = headerMap_(workSheet);
  var work = [];
  for (var i = 1; i < workValues.length; i++) {
    if (dateKey_(workValues[i][whm["作業日"]]) !== today) continue;
    if (workValues[i][whm["userId"]] !== uid) continue;
    if (workValues[i][whm["状態"]] === "取消") continue;
    work.push(rowToObjectBySheet_(whm, workValues[i]));
  }

  var spraySheet = ss.getSheetByName(SHEET_SPRAY);
  var sprayValues = spraySheet.getDataRange().getValues();
  var shm = headerMap_(spraySheet);
  var sprayItemMap = itemsByRecordId_(SHEET_SPRAY_ITEMS);
  var spray = [];
  for (var j = 1; j < sprayValues.length; j++) {
    if (dateKey_(sprayValues[j][shm["使用年月日"]]) !== today) continue;
    if (sprayValues[j][shm["userId"]] !== uid) continue;
    if (sprayValues[j][shm["状態"]] === "取消") continue;
    var rec = rowToObjectBySheet_(shm, sprayValues[j]);
    rec.items = sprayItemMap[rec["記録ID"]] || [];
    spray.push(rec);
  }

  var growthSheet = ss.getSheetByName(SHEET_GROWTH);
  var growth = [];
  if (growthSheet) {
    var growthValues = growthSheet.getDataRange().getValues();
    var ghm = headerMap_(growthSheet);
    var growthItemMap = itemsByRecordId_(SHEET_GROWTH_ITEMS);
    for (var k = 1; k < growthValues.length; k++) {
      if (dateKey_(growthValues[k][ghm["調査日"]]) !== today) continue;
      if (growthValues[k][ghm["userId"]] !== uid) continue;
      if (growthValues[k][ghm["状態"]] === "取消") continue;
      var g = rowToObjectBySheet_(ghm, growthValues[k]);
      g.items = growthItemMap[g["記録ID"]] || [];
      growth.push(g);
    }
  }

  return json_({ ok: true, work: work, spray: spray, pesticide: spray, growth: growth });
}

// 作業記録と散布記録をまとめて日付の新しい順に返す。
// 散布記録は _type:"spray" と散布区分（防除／葉面散布）を持たせ、
// その日の作業一覧・作業時間の中に散布も現れるようにしている
function getHistory_(params) {
  var days = Math.max(1, Math.min(90, Number(params.days) || 14));
  var since = new Date();
  since.setDate(since.getDate() - days);
  var sinceKey = Utilities.formatDate(since, TZ, "yyyy-MM-dd");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var items = [];

  var workSheet = ss.getSheetByName(SHEET_WORK);
  var workValues = workSheet.getDataRange().getValues();
  var whm = headerMap_(workSheet);
  for (var i = 1; i < workValues.length; i++) {
    var d = dateKey_(workValues[i][whm["作業日"]]);
    if (d < sinceKey) continue;
    if (workValues[i][whm["状態"]] === "取消") continue;
    var o = rowToObjectBySheet_(whm, workValues[i]);
    o._type = "work";
    items.push(o);
  }

  var spraySheet = ss.getSheetByName(SHEET_SPRAY);
  var sprayValues = spraySheet.getDataRange().getValues();
  var shm = headerMap_(spraySheet);
  var sprayItemMap = itemsByRecordId_(SHEET_SPRAY_ITEMS);
  for (var j = 1; j < sprayValues.length; j++) {
    var d2 = dateKey_(sprayValues[j][shm["使用年月日"]]);
    if (d2 < sinceKey) continue;
    if (sprayValues[j][shm["状態"]] === "取消") continue;
    var o2 = rowToObjectBySheet_(shm, sprayValues[j]);
    o2._type = "spray";
    o2.items = sprayItemMap[o2["記録ID"]] || [];
    items.push(o2);
  }

  var growthSheet = ss.getSheetByName(SHEET_GROWTH);
  if (growthSheet) {
    var growthValues = growthSheet.getDataRange().getValues();
    var ghm = headerMap_(growthSheet);
    var growthItemMap = itemsByRecordId_(SHEET_GROWTH_ITEMS);
    for (var k = 1; k < growthValues.length; k++) {
      var d3 = dateKey_(growthValues[k][ghm["調査日"]]);
      if (d3 < sinceKey) continue;
      if (growthValues[k][ghm["状態"]] === "取消") continue;
      var o3 = rowToObjectBySheet_(ghm, growthValues[k]);
      o3._type = "growth";
      o3.items = growthItemMap[o3["記録ID"]] || [];
      items.push(o3);
    }
  }

  items.sort(function (a, b) {
    var da = historyDate_(a);
    var db = historyDate_(b);
    if (da < db) return 1;
    if (da > db) return -1;
    return 0;
  });

  return json_({ ok: true, items: items });
}

// 履歴で並べ替えるときの日付。記録の種類ごとに日付の列名が違う
function historyDate_(o) {
  if (o._type === "work") return o["作業日"];
  if (o._type === "growth") return o["調査日"];
  return o["使用年月日"];
}

// 記録IDに紐づく生育調査明細（株ごとの測定値）を取得する。1件だけ要るとき用
function getGrowthItems_(recordId) {
  return itemsByRecordId_(SHEET_GROWTH_ITEMS)[recordId] || [];
}

function getGrowths_(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GROWTH);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var base = params.base || "";
  var itemMap = itemsByRecordId_(SHEET_GROWTH_ITEMS);
  var records = [];
  for (var i = 1; i < values.length; i++) {
    var d = dateKey_(values[i][hm["調査日"]]);
    if (d < from || d > to) continue;
    if (base && values[i][hm["拠点"]] !== base) continue;
    var rec = rowToObjectBySheet_(hm, values[i]);
    rec.items = itemMap[rec["記録ID"]] || [];
    records.push(rec);
  }
  records.reverse();
  return json_({ ok: true, records: records });
}

// 同じ場所の直近の調査を1件返す。入力画面で前回値を並べて見せ、伸長量を出すために使う
function getLastGrowth_(params) {
  var base = params.base || "";
  var building = params.building || "";
  var before = params.before || "9999-99-99"; // この日より前の調査を探す
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GROWTH);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);

  var best = null;
  var bestDate = "";
  for (var i = 1; i < values.length; i++) {
    if (values[i][hm["状態"]] === "取消") continue;
    if (base && values[i][hm["拠点"]] !== base) continue;
    if (building && values[i][hm["棟・区画"]] !== building) continue;
    var d = dateKey_(values[i][hm["調査日"]]);
    if (d >= before) continue;
    if (d > bestDate) {
      bestDate = d;
      best = rowToObjectBySheet_(hm, values[i]);
    }
  }
  if (best) best.items = getGrowthItems_(best["記録ID"]);
  return json_({ ok: true, growth: best });
}

// 法定帳簿用の抽出。農薬登録のある資材の行だけを、親の情報と結合して平らに返す。
// 展着剤も農薬登録があれば対象に含まれ、肥料（クロロゲン等）は除外される
function getLegalLedger_(params) {
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var spraySheet = ss.getSheetByName(SHEET_SPRAY);
  var sprayValues = spraySheet.getDataRange().getValues();
  var shm = headerMap_(spraySheet);

  var itemMap = itemsByRecordId_(SHEET_SPRAY_ITEMS);
  var rows = [];
  for (var i = 1; i < sprayValues.length; i++) {
    var d = dateKey_(sprayValues[i][shm["使用年月日"]]);
    if (d < from || d > to) continue;
    if (sprayValues[i][shm["状態"]] === "取消") continue;
    var parent = rowToObjectBySheet_(shm, sprayValues[i]);
    (itemMap[parent["記録ID"]] || []).forEach(function (it) {
      if (String(it["農薬登録の有無"]).toUpperCase() !== "TRUE") return;
      rows.push({
        "使用年月日": parent["使用年月日"],
        "使用場所": parent["拠点"] + (parent["棟・区画"] ? " / " + parent["棟・区画"] : ""),
        "農作物の種類": parent["農作物の種類"],
        "農薬の名称": it["資材名"],
        "希釈倍数": it["希釈倍数"],
        "使用量": it["使用量"],
        "使用量単位": it["使用量単位"],
        "散布液量L": it["散布液量L"],
        "対象病害虫・目的": [parent["目的タグ"], parent["目的自由入力"]].filter(String).join(PURPOSE_SEPARATOR),
        "作業者": parent["記録者"],
        "記録ID": parent["記録ID"],
      });
    });
  }
  return json_({ ok: true, rows: rows });
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
  var hm = headerMap_(sheet);
  var dateCol = hm["日付"];
  for (var i = 1; i < values.length; i++) {
    if (dateKey_(values[i][dateCol]) === date) {
      return json_({ ok: true, weather: rowToObjectBySheet_(hm, values[i]) });
    }
  }
  return json_({ ok: true, weather: null });
}

function getWeatherRange_(params) {
  var from = params.from || "0000-00-00";
  var to = params.to || "9999-99-99";
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WEATHER);
  var values = sheet.getDataRange().getValues();
  var hm = headerMap_(sheet);
  var dateCol = hm["日付"];
  var items = [];
  for (var i = 1; i < values.length; i++) {
    var d = dateKey_(values[i][dateCol]);
    if (d < from || d > to) continue;
    items.push(rowToObjectBySheet_(hm, values[i]));
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
  var hm = headerMap_(sheet);
  var nowStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  var dateCol = hm["日付"];
  var fetchedCol = hm["取得日時"];

  daily.time.forEach(function (dateStr) {
    var idx = daily.time.indexOf(dateStr);
    var kubun = dateStr < today ? "実績" : "予報"; // past_days分＝実績、当日分＝予報
    var obj = {
      "日付": dateStr,
      "取得区分": kubun,
      "最高気温": daily.temperature_2m_max[idx],
      "最低気温": daily.temperature_2m_min[idx],
      "天気概況": weatherCodeToLabel_(daily.weather_code[idx]),
      "天気コード": daily.weather_code[idx],
      "降水確率": daily.precipitation_probability_max ? daily.precipitation_probability_max[idx] : "",
      "取得日時": nowStr,
      "更新日時": nowStr,
    };
    var found = -1;
    for (var i = 1; i < values.length; i++) {
      if (dateKey_(values[i][dateCol]) === dateStr) { found = i; break; }
    }
    if (found >= 0) {
      obj["取得日時"] = values[found][fetchedCol]; // 取得日時（初回）は保持
      var row = objectToRowBySheet_(sheet, obj);
      sheet.getRange(found + 1, 1, 1, row.length).setValues([row]);
      values[found] = row;
    } else {
      var newRow = objectToRowBySheet_(sheet, obj);
      sheet.appendRow(newRow);
      values.push(newRow);
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
