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
    EC_COEFFICIENT,
  };
}
