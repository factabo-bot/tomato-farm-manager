"use strict";

// 養液の化学定数テーブル。
// 分子量や価数は変わらないので、スプレッドシート（マスタ）には置かずコードに持つ。
// マスタ取得は実測で8〜11秒かかるので、変わらない値をそこに乗せる理由がない。
//
// 銘柄・価格・在庫は マスタ_肥料（スプレッドシート側）で持つ。ここは「化学」だけ。

// ---------- イオンの価数 ----------
// 電荷バランスの計算に使う。陽イオンは正、陰イオンは負。
// meq/L = mmol/L × |価数|
const ION_CHARGE = {
  // 陽イオン
  K: 1, Ca: 2, Mg: 2, NH4: 1, Na: 1, H: 1,
  // 陰イオン
  NO3: -1, H2PO4: -1, SO4: -2, Cl: -1, HCO3: -1,
};

// 養分として画面に出すイオン
const NUTRIENT_IONS = ["K", "Ca", "Mg", "NH4", "NO3", "H2PO4", "SO4", "Cl"];

// 養分ではないが電荷収支に必要なイオン。
// これを数えないと収支が合わない（CFアプリの誤差7.77%はNa⁺を数えていないのが原因だった）
const BALANCE_IONS = ["Na", "HCO3", "H"];

// ---------- 酸化物 → 元素 の換算係数 ----------
// 日本の肥料の保証成分は酸化物換算で書かれることが多い。
// しかも「オリエントミックス」のように1つの製品の中で酸化物表記と元素表記が混在する。
// そのため成分ごとに as: を持たせて、ここで引く。
const OXIDE_TO_ELEMENT = {
  element: 1.0,      // 元素そのまま
  B2O3: 0.3106,      // B 10.81×2 = 21.62 ÷ 69.62
  MnO: 0.7744,       // Mn 54.94 ÷ 70.94
  P2O5: 0.4364,      // P 30.97×2 = 61.94 ÷ 141.94
  K2O: 0.8301,       // K 39.10×2 = 78.20 ÷ 94.20
  MgO: 0.6030,       // Mg 24.31 ÷ 40.31
  CaO: 0.7147,       // Ca 40.08 ÷ 56.08
  Fe2O3: 0.6994,     // Fe 55.85×2 = 111.70 ÷ 159.69
};

// ---------- 微量要素の原子量 ----------
// 微量要素は mg/L（ppm）で扱うのが実務の慣習なので、mol に直さず重量のまま持つ。
// μmol/L の一次資料と比べるときだけこの原子量で換算する。
const MICRO_ATOMIC_WEIGHT = {
  Fe: 55.85, Mn: 54.94, Zn: 65.38, B: 10.81, Cu: 63.55, Mo: 95.95,
};

const MICRO_ELEMENTS = ["Fe", "Mn", "Zn", "B", "Cu", "Mo"];

// ---------- 単肥（純粋な化合物） ----------
// mw: 分子量。ions: 1molが解離して出すイオンのmol比。
// 「1 mmol/L 作るのに必要な g/1000L」＝ 分子量 になる。
//
// 酸は H⁺ も出す。これを数えないと電荷収支が合わない
// （達子ファーム処方の検算で、リン酸由来のH⁺ 0.145 mmol/L がちょうど誤差と一致した）。
const FERTILIZER_CHEM = {
  // --- 硝酸塩 ---
  potassium_nitrate: {
    name: "硝酸カリ", formula: "KNO3", mw: 101.10,
    ions: { K: 1, NO3: 1 },
  },
  calcium_nitrate_4h: {
    name: "硝酸石灰4水塩", formula: "Ca(NO3)2·4H2O", mw: 236.15,
    ions: { Ca: 1, NO3: 2 },
  },
  calcium_nitrate_5ca: {
    name: "硝酸石灰（アンモニア含有型）", formula: "5Ca(NO3)2·NH4NO3·10H2O", mw: 1080.50,
    ions: { Ca: 5, NO3: 11, NH4: 1 },
    note: "農業用「硝酸石灰」で流通する形。NH4を含むので低アンモニア処方では避ける",
  },
  magnesium_nitrate_6h: {
    name: "硝酸マグネシウム", formula: "Mg(NO3)2·6H2O", mw: 256.41,
    ions: { Mg: 1, NO3: 2 },
  },
  ammonium_nitrate: {
    name: "硝酸アンモニウム", formula: "NH4NO3", mw: 80.04,
    ions: { NH4: 1, NO3: 1 },
    restricted: true,
    note: "販売時に本人確認が要る規制品。トマトはNH4を1.5mmol/L以下に抑えるので必須ではない",
  },

  // --- リン酸塩 ---
  mono_potassium_phosphate: {
    name: "第一リン酸カリ", formula: "KH2PO4", mw: 136.09,
    ions: { K: 1, H2PO4: 1 },
  },
  mono_ammonium_phosphate: {
    name: "第一リン酸アンモニウム(MAP)", formula: "NH4H2PO4", mw: 115.03,
    ions: { NH4: 1, H2PO4: 1 },
  },

  // --- 硫酸塩 ---
  potassium_sulfate: {
    name: "硫酸カリウム", formula: "K2SO4", mw: 174.26,
    ions: { K: 2, SO4: 1 },
    note: "NO3を増やさずにKだけ上げたいときに使う（窒素を絞る処方）",
  },
  magnesium_sulfate_7h: {
    name: "硫酸マグネシウム", formula: "MgSO4·7H2O", mw: 246.47,
    ions: { Mg: 1, SO4: 1 },
  },

  // --- 酸（pH調整・アルカリ度中和） ---
  // 濃度は purity で持つ（リン酸85%なら purity: 0.85）
  phosphoric_acid: {
    name: "リン酸(85%)", formula: "H3PO4", mw: 98.00,
    ions: { H2PO4: 1, H: 1 },
    purity: 0.85,
    isAcid: true,
  },
  nitric_acid: {
    name: "硝酸(62%)", formula: "HNO3", mw: 63.01,
    ions: { NO3: 1, H: 1 },
    purity: 0.62,
    isAcid: true,
  },
  sulfuric_acid: {
    name: "硫酸(62%)", formula: "H2SO4", mw: 98.08,
    ions: { SO4: 1, H: 2 },
    purity: 0.62,
    isAcid: true,
  },
};

// ---------- 製品（混合物・微量要素） ----------
// 成分表示の重量%で定義する。as に酸化物か元素かを成分ごとに持たせる
// （オリエントミックスはホウ素とマンガンだけ酸化物表記で、他は元素表記）。
const FERTILIZER_PRODUCTS = {
  orient_mix: {
    name: "オリエントミックス",
    kind: "micro",
    composition: [
      { element: "B", pct: 10.5, as: "B2O3" },
      { element: "Mn", pct: 8.2, as: "MnO" },
      { element: "Cu", pct: 0.75, as: "element" },
      { element: "Zn", pct: 3.45, as: "element" },
      { element: "Mo", pct: 0.64, as: "element" },
    ],
    stockPh: { min: 3.0, max: 6.5 },
    note: "鉄を含まない。別途キレート鉄を添加する。アルカリ性資材との混用不可",
  },
  chelated_iron_dtpa_11: {
    name: "キレート鉄B DTPA-Fe 粉状11%",
    kind: "micro",
    composition: [
      { element: "Fe", pct: 11.0, as: "element" },
    ],
    stockPh: { min: 3.0, max: 7.0 },
    note: "DTPAキレート。原液pHを3.0未満に下げるとキレートが分解する",
  },
  chelated_iron_edta_13: {
    name: "キレート鉄 EDTA-Fe 13%",
    kind: "micro",
    composition: [
      { element: "Fe", pct: 13.0, as: "element" },
    ],
    stockPh: { min: 3.0, max: 6.0 },
    note: "EDTAキレート。DTPAより高pH側に弱い",
  },
};

// ---------- 参考価格 ----------
// 単位は 円/kg（税別）。2026-09-03 時点の通販掲載価格から換算した概算。
// いずれも個人・小規模向けの通販価格で、大口取引価格ではない。
// 銘柄・荷姿・仕入れ先で大きく変わるので、処方どうしのコスト差を見る用途に留める。
// 就農後は実際の仕入れ価格を スプレッドシートの銘柄マスタ に入れて差し替える。
//
// 荷姿で単価が数倍変わる。例：硫酸マグネシウムは800g袋だと445円/kg、
// 20kg袋なら149円/kg。ここでは実際に使う想定の大袋価格を採る
const FERTILIZER_PRICE_REF = {
  calcium_nitrate_4h: { yenPerKg: 245, note: "硝酸カルシウム2水塩 20〜25kg 5,520円" },
  potassium_nitrate: { yenPerKg: 675, note: "粒状13-0-45 20kg 13,500円" },
  potassium_sulfate: { yenPerKg: 551, note: "水溶性 20〜25kg 12,400円" },
  mono_ammonium_phosphate: { yenPerKg: 600, note: "第一燐酸アンモン特撰 25kg 15,000円" },
  magnesium_sulfate_7h: { yenPerKg: 149, note: "硫酸マグネシウム25（水溶性苦土25%）20kg 2,986円" },
  magnesium_nitrate_6h: { yenPerKg: 203, note: "硝酸マグネシウム6水塩 25kg 5,071円（税込表示のみ）" },
  phosphoric_acid: { yenPerKg: 742, note: "りん酸液85% 35kg 25,980円（税込表示のみ）。20kgだと870円/kg" },
  chelated_iron_dtpa_11: { yenPerKg: 1872, note: "DTPAキレート鉄11% 25kg 46,800円。500g小袋だと2,700円/kg" },
  chelated_iron_edta_13: { yenPerKg: 2088, note: "EDTA鉄13% 800g 1,670円（小口価格のみ）" },
  // 第一リン酸カリは農業用単肥としての掲載価格が見つからず、
  // 食品添加物グレード25kgで1,687円/kg。用途が違うため参考にせず未設定のままにする。
  // mono_potassium_phosphate
  //
  // オリエントミックスの単独価格は確認できず。同等品の「微量要素8」は約1,000円/kg
  // だが、成分が違うので当てはめない。
  // orient_mix / nitric_acid / sulfuric_acid / ammonium_nitrate
};

// ---------- 原液タンクを分ける理由 ----------
// 同じタンクに入れてはいけない組み合わせ。
// 役割（role）は肥料ごとに手で書かず、ions と stockPh から導出する
// （fertilizer.js の fertilizerTankRoles）。新しい肥料を足したときの書き忘れを防ぐため。
//
// タンク名で判定しないこと。研修先はB液が硝酸カルシウム側、CFアプリはA液が酸性側で、
// 「A液＝カルシウム側」という決まりは存在しない
const TANK_CONFLICTS = [
  { a: "calcium", b: "sulfate", label: "石膏(CaSO4)が沈殿します" },
  { a: "calcium", b: "phosphate", label: "リン酸カルシウムが沈殿します" },
  { a: "acid", b: "chelate", label: "原液pHが下限を割ってキレートが分解します" },
];

// 役割の表示名。選択肢のバッジに使う
const TANK_ROLE_LABEL = {
  calcium: "Ca側",
  sulfate: "硫酸側",
  phosphate: "リン酸側",
  acid: "酸",
  chelate: "キレート",
};

// ---------- 判定基準 ----------
// 出典: Nutrient Solutions for Greenhouse Crops (AkzoNobel/Eurofins/Yara/SQM, 2016) p.56
//       原典 De Kreij, Voogt, van den Bos, Baas (1999)
// 作型・季節・原水で適正は動くので、固定値として扱わず「参照線」として薄く出す。
const REFERENCE_RANGES = {
  // 単位 mmol/L
  ions: {
    K:     { min: 6,   max: 10,  standard: 9.5 },
    Ca:    { min: 4,   max: 8,   standard: 5.4 },
    Mg:    { min: 1.5, max: 3,   standard: 2.4 },
    NH4:   { min: 0,   max: 1.5, standard: 1.2 },
    NO3:   { min: 12,  max: 18,  standard: 15 },
    H2PO4: { min: 1,   max: 2.5, standard: 1.5 },
    SO4:   { min: 1,   max: 4,   standard: 4.4 },
    Cl:    { min: 0,   max: 3,   standard: 1 },
  },
  // 単位 mg/L。オランダ標準のμmol/Lを原子量で換算した値
  micro: {
    Fe: { standard: 0.84 },  // 15 μmol/L
    Mn: { standard: 0.55 },  // 10 μmol/L
    Zn: { standard: 0.33 },  // 5 μmol/L
    B:  { standard: 0.32 },  // 30 μmol/L
    Cu: { standard: 0.048 }, // 0.75 μmol/L
    Mo: { standard: 0.048 }, // 0.5 μmol/L
  },
};

// 月別の給液量の実測値（mL/日/株）。
// 出典: 大野栄子・大竹敏也「夏秋作ミニトマトのヤシがら培地耕栽培における給液量指針の策定」
//       愛知県農業総合試験場研究報告 53:251-254 (2021) 表4
//
// 注意が2つある。
//  ・「給液量指針」は吸水量より2〜5割多い。排液率30〜35%を確保するため、
//    作物が吸う量そのままではなく、余分に与えて流す。費用は給液量で決まる
//  ・この試験は夏秋作ミニトマト（5月定植・7〜10月）で、8月定植の越冬長期どり
//    とは作型が違う。7〜10月の重なる期間の参考として使う
const FEED_VOLUME_AICHI = [
  { month: 7, uptakeMl: 1220.6, feedMl: 1600, drainPct: 35 },
  { month: 8, uptakeMl: 1695.6, feedMl: 2500, drainPct: 35 },
  { month: 9, uptakeMl: 927.9, feedMl: 1300, drainPct: 35 },
  { month: 10, uptakeMl: 737.5, feedMl: 900, drainPct: 30 },
];

// 越冬長期どりの吸水量カーブ（L/株/日）。
// 愛知県ガイドライン 図I-12 の目視読み取り値で、実測表ではない。
// 9月中旬定植・大玉・養液土耕・3,000株/10a の別試験のグラフなので、
// おおよその形（冬に沈み、2月から急に増える）を掴む用途に留める
const UPTAKE_CURVE_ROUGH = [
  { month: 9, uptakeL: 0.25 }, { month: 10, uptakeL: 0.5 }, { month: 11, uptakeL: 0.5 },
  { month: 12, uptakeL: 0.5 }, { month: 1, uptakeL: 0.5 }, { month: 2, uptakeL: 0.65 },
  { month: 3, uptakeL: 0.83 }, { month: 4, uptakeL: 0.88 }, { month: 5, uptakeL: 1.2 },
];

// 生育ステージ別の給液EC。
// 出典: 愛知県農業総合試験場「トマト・ミニトマトにおける環境制御ガイドライン」
//       実証栽培は 8月定植・10月収穫開始・翌年6〜7月終了の越冬長期どり、
//       ヤシガラ（ココバッグ）、中玉「りんか409」。
// 培地・作型・果実サイズが自分の計画と一致する唯一の一次資料なので既定に採る。
const EC_STAGE_PRESET_AICHI = [
  { stage: "定植〜生育期", ec: 0.7 },
  { stage: "第1〜2花房開花", ec: 0.8 },
  { stage: "第3〜4花房開花", ec: 0.9 },
  { stage: "第5〜6花房開花・収穫開始", ec: 1.2 },
  { stage: "第7〜11花房開花", ec: 1.4 },
  { stage: "第12〜14花房開花", ec: 1.4 },
  { stage: "第15〜17花房開花", ec: 1.4 },
  { stage: "以降摘心まで", ec: 1.1, note: "1.2から1.0へ徐々に下げる" },
];
