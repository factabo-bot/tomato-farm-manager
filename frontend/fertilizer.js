"use strict";

// 養液の組成計算エンジン。
// DOMに触れない純粋関数だけを置く（headless Chromeのハーネスでそのままテストできる）。
// 計算はすべてクライアント側で完結させる。GASは呼ばない
// （何もしないAPIでも1.5秒かかる。組成計算にこれを払う理由がない）。
//
// 前提となる知見:
//  - 肥料塩も酸も電気的に中性なので、計算の中では電荷は1個の狂いもなく釣り合う。
//    ズレたら必ず数え漏れか入力ミス。「ほぼ合っている」で済ませない。
//  - 酸は H⁺ を出す。これを数えないと収支が合わない。
//  - リン酸は資料によって PO4³⁻（3価）で me/L 換算される。内部は mmol/L に統一し、
//    表示のときだけ換算する。

// EC推定の係数。Σ陽イオン(meq/L) × この値 ＝ EC(mS/cm)。
// 実測との突き合わせでは 0.099〜0.113 の幅があった（CFアプリ0.1002／達子ファーム0.1105／
// オランダ標準0.0989）。±10%の誤差を持つ近似として扱う。
const EC_COEFFICIENT = 0.10;

// 濃縮原液中のキレートが壊れない下限。これを下回る処方には警告を出す。
const STOCK_PH_FLOOR = 3.0;
const STOCK_PH_CAUTION = 3.5;

// ---------- 小さいヘルパ ----------

function emptyIons() {
  const o = {};
  NUTRIENT_IONS.forEach((k) => (o[k] = 0));
  BALANCE_IONS.forEach((k) => (o[k] = 0));
  return o;
}

function emptyMicro() {
  const o = {};
  MICRO_ELEMENTS.forEach((k) => (o[k] = 0));
  return o;
}

function lookupFertilizer(id) {
  return FERTILIZER_CHEM[id] || FERTILIZER_PRODUCTS[id] || null;
}

// 表示用。少数の桁を揃える
function round(v, digits) {
  const p = Math.pow(10, digits === undefined ? 3 : digits);
  return Math.round(v * p) / p;
}

// ---------- 1つの肥料を溶かす ----------
// タンク容量と希釈倍率から、給液1Lあたりに入る量を出す。
//
//   給液中の濃度(g/L) = 投入量(g) ÷ (タンク容量L × 希釈倍率)
//
// 例: 100Lタンクに5.0kg、120倍希釈 → 5000 ÷ (100×120) = 0.4167 g/L
function dissolveItem(item, tankL, dilution) {
  const chem = lookupFertilizer(item.id);
  const result = { ions: emptyIons(), micro: emptyMicro() };
  if (!chem) return result;

  const kg = Number(item.kg);
  if (!(kg > 0) || !(tankL > 0) || !(dilution > 0)) return result;

  // 給液1Lあたりの mg
  const mgPerL = (kg * 1000 * 1000) / (tankL * dilution);

  if (chem.ions) {
    // 純粋な化合物。分子量で mol に直す
    const purity = chem.purity === undefined ? 1 : chem.purity;
    const mmolPerL = (mgPerL * purity) / chem.mw;
    Object.keys(chem.ions).forEach((ion) => {
      result.ions[ion] = (result.ions[ion] || 0) + mmolPerL * chem.ions[ion];
    });
  }

  if (chem.composition) {
    // 製品（混合物）。成分ごとに重量%と表記の型（酸化物/元素）を持つ
    chem.composition.forEach((c) => {
      const factor = OXIDE_TO_ELEMENT[c.as] === undefined ? 1 : OXIDE_TO_ELEMENT[c.as];
      const elementMgPerL = mgPerL * (c.pct / 100) * factor;
      if (result.micro[c.element] !== undefined) {
        result.micro[c.element] += elementMgPerL;
      } else if (result.ions[c.element] !== undefined) {
        // 多量要素を%で持つ製品（複合肥料）が来た場合。mg/L → mmol/L
        const aw = MICRO_ATOMIC_WEIGHT[c.element];
        if (aw) result.ions[c.element] += elementMgPerL / aw;
      }
    });
  }

  return result;
}

// ---------- タンク1本を計算 ----------
function calcTank(tank, dilution) {
  const ions = emptyIons();
  const micro = emptyMicro();
  (tank.items || []).forEach((item) => {
    const r = dissolveItem(item, tank.tankL, dilution);
    Object.keys(r.ions).forEach((k) => (ions[k] += r.ions[k]));
    Object.keys(r.micro).forEach((k) => (micro[k] += r.micro[k]));
  });
  return { name: tank.name || "", ions, micro, items: tank.items || [], tankL: tank.tankL };
}

// ---------- 電荷バランス ----------
// meq/L = mmol/L × |価数|。陽イオンと陰イオンの合計は必ず一致するはず。
function chargeBalance(ions) {
  let cation = 0;
  let anion = 0;
  Object.keys(ions).forEach((k) => {
    const charge = ION_CHARGE[k];
    if (charge === undefined) return;
    const meq = ions[k] * Math.abs(charge);
    if (charge > 0) cation += meq;
    else anion += meq;
  });
  const diff = cation - anion;
  // 誤差率の分母は「陽イオン合計」。分母の取り方で数字が変わるので定義を固定する
  const errorPct = cation > 0 ? (Math.abs(diff) / cation) * 100 : 0;
  return { cationMeq: cation, anionMeq: anion, diff, errorPct };
}

// ---------- EC推定 ----------
// 係数はイオン組成に依存する。K⁺・Cl⁻・NO3⁻ は移動度が高く、Ca²⁺・Mg²⁺・SO4²⁻ は
// 水和して動きにくいので、同じ meq/L でも中身が違えばECが変わる
// （0.01M KCl標準液は10meq/Lで実測1.41 mS/cm＝式より4割高い）。
// そのため既定値0.10は「4例の実測から採った真ん中の値」でしかない。
//
// 処方ごとにEC計で1回測れば、その処方に固有の係数が決まる。
// 記録アプリなので実測値を処方に紐づけられる＝使うほど精度が上がる。
function estimateEC(cationMeq, coefficient) {
  const c = Number(coefficient) > 0 ? Number(coefficient) : EC_COEFFICIENT;
  return cationMeq * c;
}

// 実測ECから、その処方に固有の係数を逆算する
function deriveEcCoefficient(measuredEc, cationMeq) {
  const ec = Number(measuredEc);
  const meq = Number(cationMeq);
  if (!(ec > 0) || !(meq > 0)) return null;
  return ec / meq;
}

// ---------- 沈殿チェック ----------
// Ca²⁺ と SO4²⁻ → 石膏(CaSO4)、Ca²⁺ と H2PO4⁻ → リン酸カルシウム。
// 濃縮された原液タンクの中では溶解度を超えるので、同じタンクに入れてはいけない。
function checkPrecipitation(tanks) {
  const warnings = [];
  tanks.forEach((t) => {
    const hasCa = t.ions.Ca > 0;
    if (!hasCa) return;
    if (t.ions.SO4 > 0) {
      warnings.push({
        level: "danger",
        tank: t.name,
        message: `${t.name}にカルシウムと硫酸が同居しています。濃縮原液で石膏(CaSO4)が沈殿します。タンクを分けてください`,
      });
    }
    if (t.ions.H2PO4 > 0) {
      warnings.push({
        level: "danger",
        tank: t.name,
        message: `${t.name}にカルシウムとリン酸が同居しています。濃縮原液でリン酸カルシウムが沈殿します。タンクを分けてください`,
      });
    }
  });
  return warnings;
}

// ---------- 原液pHの許容範囲 ----------
// 資材ごとに上限・下限があり、向きが逆になることがある。
//  - キレート鉄（EDTA/DTPA）… 下限。下げすぎると分解する
//  - キレートされていない微量要素 … 上限。上げると水酸化物として沈殿する
// タンクに入っている資材すべての制約を突き合わせ、重なる範囲を出す。
function stockPhRange(tank) {
  let min = null;
  let max = null;
  const sources = [];
  (tank.items || []).forEach((item) => {
    const chem = lookupFertilizer(item.id);
    if (!chem || !chem.stockPh) return;
    sources.push({ name: chem.name, min: chem.stockPh.min, max: chem.stockPh.max });
    if (chem.stockPh.min !== undefined) min = min === null ? chem.stockPh.min : Math.max(min, chem.stockPh.min);
    if (chem.stockPh.max !== undefined) max = max === null ? chem.stockPh.max : Math.min(max, chem.stockPh.max);
  });
  return { min, max, sources, impossible: min !== null && max !== null && min > max };
}

function checkStockPh(tanks) {
  const warnings = [];
  tanks.forEach((t) => {
    const range = stockPhRange(t);
    if (range.impossible) {
      warnings.push({
        level: "danger",
        tank: t.name,
        message: `${t.name}の資材どうしで原液pHの許容範囲が重なりません（下限${range.min} > 上限${range.max}）。同じタンクに入れられない組み合わせです`,
      });
    } else if (range.min !== null && range.min >= STOCK_PH_FLOOR) {
      warnings.push({
        level: "info",
        tank: t.name,
        message: `${t.name}の原液pHは ${range.min}〜${range.max === null ? "—" : range.max} に保つ必要があります（${range.sources.map((s) => s.name).join("・")}）`,
      });
    }
  });
  return warnings;
}

// ---------- 基準との突き合わせ ----------
// 「適正/範囲外」の二値で赤を並べると意味のない警告になるので、参照線として差だけ返す。
function compareToReference(ions, micro) {
  const rows = [];
  NUTRIENT_IONS.forEach((k) => {
    const ref = REFERENCE_RANGES.ions[k];
    if (!ref) return;
    const v = ions[k];
    rows.push({
      ion: k, value: v, min: ref.min, max: ref.max, standard: ref.standard,
      below: v < ref.min, above: v > ref.max,
      ratioToStandard: ref.standard > 0 ? v / ref.standard : null,
    });
  });
  const microRows = MICRO_ELEMENTS.map((k) => {
    const ref = REFERENCE_RANGES.micro[k];
    const v = micro[k];
    return {
      element: k, value: v, standard: ref ? ref.standard : null,
      ratioToStandard: ref && ref.standard > 0 ? v / ref.standard : null,
    };
  });
  return { ions: rows, micro: microRows };
}

// ---------- 中和酸の反映 ----------
// 原水のアルカリ度(HCO3⁻)を酸で中和する。
//   中和量(meq/L) = 原水のアルカリ度 − 目標残留アルカリ度
// 酸を足したら、そのイオン（NO3⁻やH2PO4⁻）とH⁺を加え、同じmeqだけHCO3⁻を引く。
// H⁺を足してHCO3⁻を引かないと、ここで電荷収支が崩れる。
function applyAcidNeutralization(ions, acid) {
  if (!acid || !(acid.meqPerL > 0)) return ions;
  const meq = acid.meqPerL;
  const available = ions.HCO3;
  const neutralized = Math.min(meq, available);

  // 酸のアニオンを足す（1価前提）
  const anion = acid.anion || "NO3";
  ions[anion] = (ions[anion] || 0) + meq;
  // 対になるH⁺
  ions.H = (ions.H || 0) + meq;
  // 中和された分のHCO3⁻とH⁺は水とCO2になって消える
  ions.HCO3 = available - neutralized;
  ions.H = ions.H - neutralized;
  return ions;
}

// ---------- メイン ----------
// input: {
//   tanks: [{ name, tankL, items: [{id, kg}] }],
//   dilution: 120,
//   water: { Ca, Mg, Na, Cl, SO4, HCO3, NO3, K },  // 原水の分析値 mmol/L（省略可）
//   acid: { anion: "NO3", meqPerL: 1.8 },          // 中和酸（省略可）
// }
function calcSolution(input) {
  const dilution = Number(input.dilution) || 1;
  const tanks = (input.tanks || []).map((t) => calcTank(t, dilution));

  const ions = emptyIons();
  const micro = emptyMicro();

  // 各タンクを合算
  tanks.forEach((t) => {
    Object.keys(t.ions).forEach((k) => (ions[k] += t.ions[k]));
    Object.keys(t.micro).forEach((k) => (micro[k] += t.micro[k]));
  });

  // 原水を足す（Ca・Mgだけでなく Na・Cl・HCO3 まで入れないと電荷が合わない）
  const water = input.water || {};
  Object.keys(water).forEach((k) => {
    if (ions[k] !== undefined) ions[k] += Number(water[k]) || 0;
  });

  // 中和酸
  applyAcidNeutralization(ions, input.acid);

  const balance = chargeBalance(ions);

  // 処方に実測から補正した係数があればそれを使う。無ければ既定値
  const coefficient = Number(input.ecCoefficient) > 0 ? Number(input.ecCoefficient) : EC_COEFFICIENT;
  const ec = estimateEC(balance.cationMeq, coefficient);

  const warnings = []
    .concat(checkPrecipitation(tanks))
    .concat(checkStockPh(tanks));

  // 実測ECが渡されていれば、推定とのズレを見て係数の補正を促す
  const measured = Number(input.ecMeasured);
  let derivedCoefficient = null;
  if (measured > 0) {
    derivedCoefficient = deriveEcCoefficient(measured, balance.cationMeq);
    const gapPct = (Math.abs(ec - measured) / measured) * 100;
    if (gapPct > 5) {
      warnings.push({
        level: "info",
        message: `EC推定 ${round(ec, 2)} と実測 ${measured} が ${round(gapPct, 1)}% 離れています。この処方の係数を ${round(derivedCoefficient, 4)} に補正すると合います`,
      });
    }
  }

  // 電荷が合わないのは計算ミスか入力漏れ。0.5%を超えたら知らせる
  if (balance.errorPct > 0.5) {
    warnings.push({
      level: "warn",
      message: `電荷バランスが ${round(balance.errorPct, 2)}% ずれています（陽 ${round(balance.cationMeq, 2)} / 陰 ${round(balance.anionMeq, 2)} meq/L）。原水のNa⁺やHCO3⁻を入れ忘れていないか確認してください`,
    });
  }

  return {
    ions,
    micro,
    // 表示用: リン酸をPO4³⁻(3価)換算した me/L。日本の処方表はこの流儀が多い
    phosphateMeq3: ions.H2PO4 * 3,
    cationMeq: balance.cationMeq,
    anionMeq: balance.anionMeq,
    balanceDiff: balance.diff,
    balanceErrorPct: balance.errorPct,
    ecEstimate: ec,
    ecCoefficient: coefficient,
    ecCoefficientIsDefault: coefficient === EC_COEFFICIENT,
    ecMeasured: measured > 0 ? measured : null,
    ecCoefficientDerived: derivedCoefficient,
    reference: compareToReference(ions, micro),
    tanks,
    warnings,
  };
}

// ---------- 逆算（目標組成 → 単肥の量） ----------
// 連立方程式を一発で解くのではなく、実務者の手計算と同じ順に割り当てる。
// 単肥は1つで複数のイオンを出すので、順番を決めないと解が定まらない。
//
//   Ca → P → NH4 → Mg/SO4 → K → NO3 の順。
//   後ろのイオンほど「前の段階で入った分」を差し引いて残りを埋める。
//
// 目標が達成できない組み合わせ（前段で入る量が目標を超える）は、
// 負の量になる前に警告として返す。

const SOLVE_ORDER_NOTE = "Ca→P→NH4→Mg/SO4→K→NO3 の順に割り当て";

function solveRecipe(target, water) {
  const ions = ["K", "Ca", "Mg", "NH4", "NO3", "H2PO4", "SO4"];
  const need = {};
  ions.forEach((k) => {
    need[k] = Math.max(0, (Number(target[k]) || 0) - (Number((water || {})[k]) || 0));
  });

  const supplied = {};
  ions.forEach((k) => (supplied[k] = 0));
  const picks = [];
  const warnings = [];

  // 入口で目標組成そのものを検証する。
  // 塩は中性なので、陽陰が釣り合っていない目標は塩だけでは作れない。
  // 差は酸（H⁺）か水酸化物で埋めることになり、pHが動く。
  // 公表されている処方（オランダ標準など）も丸めやHCO3の省略で1前後ずれることがある
  const targetBalance = chargeBalance(target);
  if (targetBalance.errorPct > 1) {
    const over = targetBalance.diff > 0 ? "陽イオン" : "陰イオン";
    warnings.push({
      level: "warn",
      message: `目標組成の電荷が ${round(Math.abs(targetBalance.diff), 2)} meq/L ずれています（${over}が多い。陽 ${round(targetBalance.cationMeq, 2)} / 陰 ${round(targetBalance.anionMeq, 2)}）。塩だけでは作れないので、この差は酸か水酸化物で埋めることになります`,
    });
  }

  function add(id, mmol) {
    if (!(mmol > 0.0001)) return;
    const chem = FERTILIZER_CHEM[id];
    if (!chem) return;
    picks.push({ id: id, name: chem.name, mmol: mmol });
    Object.keys(chem.ions).forEach((ion) => {
      if (supplied[ion] === undefined) supplied[ion] = 0;
      supplied[ion] += mmol * chem.ions[ion];
    });
  }

  // 1) カルシウム。Ca源は硝酸カルシウムしかないので最初に決まる
  add("calcium_nitrate_4h", need.Ca);

  // 2) リン酸とアンモニア。
  //    硝酸アンモニウムは販売時に本人確認が要る規制品なので、使わずに済ませたい。
  //    NH4がリン酸の必要量以下なら、その分を第一リン酸アンモニウム(MAP)で入れれば
  //    リン酸とアンモニアを同時に満たせる（愛知県改良処方 NH4 0.5 / P 1.67 はこれで足りる）
  const nh4ByMap = Math.min(need.NH4, need.H2PO4);
  add("mono_ammonium_phosphate", nh4ByMap);
  add("mono_potassium_phosphate", need.H2PO4 - nh4ByMap);

  // 3) MAPで足りなかったアンモニアだけ硝酸アンモニウムで補う
  const nh4Rest = need.NH4 - supplied.NH4;
  if (nh4Rest > 0.0001) {
    add("ammonium_nitrate", nh4Rest);
    warnings.push({
      level: "info",
      message: `アンモニアがリン酸より多いので、${round(nh4Rest, 2)} mmol/L 分に硝酸アンモニウム（販売時に本人確認が要る規制品）を使っています。NH4を ${round(need.H2PO4, 2)} 以下にすれば、第一リン酸アンモニウムだけで足ります`,
    });
  }

  // 4) マグネシウムと硫酸。硫酸マグネシウムで両方を同時に埋め、
  //    足りない側をそれぞれ別の塩で補う
  const mgBySulfate = Math.min(need.Mg, need.SO4);
  add("magnesium_sulfate_7h", mgBySulfate);
  add("magnesium_nitrate_6h", need.Mg - mgBySulfate);

  // 5) 硫酸の残りは硫酸カリで（Kが2倍入る）
  add("potassium_sulfate", need.SO4 - supplied.SO4);

  // 帳尻の許容幅。目標値は小数2桁に丸めて入力されるので、
  // それ以下のズレを警告に出しても意味がない（電荷バランスの判定を1%にしているのと揃える）
  const SLACK = 0.05;

  // 6) カリの残りを硝酸カリで
  const kRest = need.K - supplied.K;
  if (kRest < -SLACK) {
    warnings.push({
      level: "warn",
      message: `カリウムが目標を ${round(-kRest, 2)} mmol/L 超えます。リン酸カリと硫酸カリから入る分だけで足りているので、リン酸か硫酸の目標を下げてください`,
    });
  }
  add("potassium_nitrate", kRest);

  // 7) 硝酸の帳尻。ここまでの塩で入った分と目標を比べる
  const no3Rest = need.NO3 - supplied.NO3;
  if (no3Rest < -SLACK) {
    warnings.push({
      level: "warn",
      message: `硝酸が目標を ${round(-no3Rest, 2)} mmol/L 超えます。Ca・Mg・Kを硝酸塩で入れると避けられないので、硫酸塩の比率を上げるか硝酸の目標を上げてください`,
    });
  } else if (no3Rest > SLACK) {
    // 目標の電荷が合っていれば、ここは0になるはず。
    // 残るということは目標側で陰イオンが余っている＝酸で入れる分にあたる
    warnings.push({
      level: "info",
      message: `硝酸が ${round(no3Rest, 2)} mmol/L 残ります。硝酸（HNO3）で入れることになり、同じ量のH⁺が原水のアルカリ度を中和します`,
    });
  }

  // 電荷の帳尻。塩だけで組んだ結果が目標とどれだけ違うか
  const suppliedBalance = chargeBalance(supplied);

  // 目標との差
  const diff = {};
  ions.forEach((k) => (diff[k] = round(supplied[k] - need[k], 3)));

  return {
    picks: picks, supplied: supplied, need: need, diff: diff,
    targetBalance: targetBalance, suppliedBalance: suppliedBalance,
    acidNeeded: Math.max(0, round(no3Rest, 3)),
    warnings: warnings, note: SOLVE_ORDER_NOTE,
  };
}

// mmol/L → タンクに入れる kg
//   kg = mmol/L × 分子量 × 希釈倍率 × タンク容量L ÷ 1,000,000
// 検算: 硝酸カリ 4.121 mmol/L を 100L・120倍 → 4.121×101.10×120×100÷1e6 = 5.00 kg
function mmolToKg(mmol, id, tankL, dilution) {
  const chem = FERTILIZER_CHEM[id];
  if (!chem || !(mmol > 0)) return 0;
  const purity = chem.purity === undefined ? 1 : chem.purity;
  return (mmol * chem.mw * dilution * tankL) / 1000000 / purity;
}

// ---------- me/L への換算（表示用） ----------
function ionMeq(ions, name) {
  const charge = ION_CHARGE[name];
  if (charge === undefined) return null;
  return ions[name] * Math.abs(charge);
}

// ブラウザとテストハーネスの両方から使えるようにする
if (typeof window !== "undefined") {
  window.FertilizerCalc = {
    calcSolution, dissolveItem, calcTank, chargeBalance, estimateEC,
    deriveEcCoefficient, stockPhRange, ionMeq, round,
    solveRecipe, mmolToKg,
    EC_COEFFICIENT,
  };
}
