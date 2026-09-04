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

// ---------- タンクの相性 ----------
// 肥料が「タンクを分ける理由」をどれだけ持っているかを、定義から導出する。
// 肥料ごとに属性を手書きしないので、新しい肥料を足しても書き忘れが起きない
function fertilizerTankRoles(id) {
  const chem = lookupFertilizer(id);
  if (!chem) return [];
  const roles = [];
  if (chem.ions) {
    if (chem.ions.Ca) roles.push("calcium");
    if (chem.ions.SO4) roles.push("sulfate");
    if (chem.ions.H2PO4) roles.push("phosphate");
  }
  if (chem.isAcid) roles.push("acid");
  // 原液pHに下限がある＝キレート剤。酸と同居させられない
  if (chem.stockPh && chem.stockPh.min !== undefined) roles.push("chelate");
  return roles;
}

// タンクの中身が持っている役割を集める
function tankRoles(tank) {
  const set = {};
  (tank.items || []).forEach((it) => {
    if (!(Number(it.kg) > 0) && it.kg !== "") {
      // 量が0でも「入れるつもり」なので役割は数える（空欄も同様）
    }
    fertilizerTankRoles(it.id).forEach((r) => (set[r] = true));
  });
  return set;
}

// この肥料をこのタンクに足したら衝突するか。選択肢の可否判定に使う
function conflictsWithTank(tank, id) {
  const incoming = fertilizerTankRoles(id);
  if (incoming.length === 0) return [];
  const existing = tankRoles(tank);
  const hits = [];
  TANK_CONFLICTS.forEach((c) => {
    if (incoming.indexOf(c.a) >= 0 && existing[c.b]) hits.push(c);
    else if (incoming.indexOf(c.b) >= 0 && existing[c.a]) hits.push(c);
  });
  return hits;
}

// タンクの中で既に起きている衝突。警告表示に使う
function tankConflicts(tank) {
  const roles = tankRoles(tank);
  return TANK_CONFLICTS.filter((c) => roles[c.a] && roles[c.b]);
}

// 濃縮原液の中では溶解度を超えるので、沈殿する組み合わせは分けなければならない。
// 判定は tankConflicts に一本化してある
function checkPrecipitation(tanks) {
  const warnings = [];
  tanks.forEach((t) => {
    tankConflicts(t).forEach((c) => {
      warnings.push({
        level: "danger",
        tank: t.name,
        message: `${t.name}：${TANK_ROLE_LABEL[c.a]}と${TANK_ROLE_LABEL[c.b]}が同居しています。${c.label}。タンクを分けてください`,
      });
    });
  });
  return warnings;
}

// ---------- 2本のタンクへの自動振り分け ----------
// 制約のあるものから先に置き場所を決め、どちらでもよいものは
// 合計重量が軽い方へ入れて量を揃える
function splitIntoTwoTanks(items) {
  const g1 = [];  // カルシウム側
  const g2 = [];  // 硫酸・リン酸側
  const neutral = [];
  const roleOf = {};

  (items || []).forEach((it) => {
    const roles = fertilizerTankRoles(it.id);
    roleOf[it.id] = roles;
    if (roles.indexOf("calcium") >= 0) g1.push(it);
    else if (roles.indexOf("sulfate") >= 0 || roles.indexOf("phosphate") >= 0) g2.push(it);
    else neutral.push(it);
  });

  // 酸とキレート剤は、互いに居ない方へ寄せる。
  // 既にリン酸系としてg2に入っている酸（リン酸85%など）はそのまま
  const has = (g, role) => g.some((it) => (roleOf[it.id] || []).indexOf(role) >= 0);

  const rest = [];
  neutral.forEach((it) => {
    const roles = roleOf[it.id] || [];
    if (roles.indexOf("acid") >= 0) {
      (has(g1, "chelate") ? g2 : g1).push(it);
    } else if (roles.indexOf("chelate") >= 0) {
      (has(g1, "acid") ? g2 : g1).push(it);
    } else {
      rest.push(it);
    }
  });

  // どちらでもよいものは軽い方へ
  const weight = (g) => g.reduce((s, it) => s + (Number(it.kg) || 0), 0);
  rest.sort((a, b) => (Number(b.kg) || 0) - (Number(a.kg) || 0));
  rest.forEach((it) => {
    (weight(g1) <= weight(g2) ? g1 : g2).push(it);
  });

  return { calciumSide: g1, sulfateSide: g2 };
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

function checkStockPh(tanks, dilution) {
  const warnings = [];
  tanks.forEach((t) => {
    const range = stockPhRange(t);
    const est = tankStockPh(t, dilution);

    if (range.impossible) {
      warnings.push({
        level: "danger",
        tank: t.name,
        message: `${t.name}の資材どうしで原液pHの許容範囲が重なりません（下限${range.min} > 上限${range.max}）。同じタンクに入れられない組み合わせです`,
      });
      return;
    }

    // 制約のある資材（キレート剤など）が入っていて、かつ酸も入っている場合だけ突き合わせる。
    // 酸とキレート剤を別タンクに分けてあれば、ここは何も出ない
    if (range.min !== null && est !== null && est.ph < range.min) {
      warnings.push({
        level: "danger",
        tank: t.name,
        message: `${t.name}は酸を入れると原液pHが ${round(est.ph, 1)} 相当になり、${range.sources.map((s) => s.name).join("・")}の下限 ${range.min} を割ります。酸は別のタンクに入れてください`,
      });
    } else if (range.min !== null) {
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
// meq → mmol は価数で割る。硫酸は H2SO4 なので H⁺ 2 meq に対して SO4²⁻ が 1 mmol、
// つまり H⁺ 1 meq あたり SO4 は 0.5 mmol しか入らない。
// ここを1価扱いにすると硫酸を選んだときだけSO4を2倍積む（2026-09-04に修正）。
// 硝酸(HNO3)とリン酸は1価。リン酸は3価の酸だが、養液のpH域(5.5〜6.5)では
// 1段階目しか解離しないので H2PO4⁻ として1価で数える。
function applyAcidNeutralization(ions, acid) {
  if (!acid || !(acid.meqPerL > 0)) return ions;
  const meq = acid.meqPerL;
  const available = ions.HCO3;
  const neutralized = Math.min(meq, available);

  const anion = acid.anion || "NO3";
  const charge = Math.abs(ION_CHARGE[anion] || 1);
  ions[anion] = (ions[anion] || 0) + meq / charge;
  // 対になるH⁺（H⁺は1価なので meq = mmol）
  ions.H = (ions.H || 0) + meq;
  // 中和された分のHCO3⁻とH⁺は水とCO2になって消える
  ions.HCO3 = available - neutralized;
  ions.H = ions.H - neutralized;
  return ions;
}

// ---------- 中和に必要な酸の量 ----------
// 原水のアルカリ度(HCO3⁻)から、必要な中和量と、酸が持ち込むイオン量を返す。
// 残留アルカリ度は0にしない。pHを支えるものが無くなって下振れしやすくなるため、
// 実務では 0.5〜1.0 meq/L 残す（アーカンソー大学の実務教材は1.0前後）。
function acidRequirement(waterHCO3, opts) {
  const hco3 = Number(waterHCO3) || 0;
  const o = opts || {};
  const residual = o.residualMeq === undefined ? 1.0 : Number(o.residualMeq) || 0;
  const anion = o.anion || "NO3";
  const meq = Math.max(0, hco3 - residual);
  const charge = Math.abs(ION_CHARGE[anion] || 1);

  // 原液に入れる実重量。市販の酸は水溶液なので purity で割り戻す
  const chem = FERTILIZER_CHEM[o.fertilizerId || ""] || null;
  let gPer1000L = null;
  if (chem) {
    // 酸1molあたりのH⁺の数で meq を mol に直す
    const hPerMol = (chem.ions && chem.ions.H) || 1;
    const mol = meq / hPerMol;              // mmol/L
    gPer1000L = (mol * chem.mw) / (chem.purity || 1);  // mmol/L × g/mol = mg/L = g/1000L
  }

  return {
    meqPerL: meq,
    anion: anion,
    anionMmolPerL: meq / charge,
    residualMeq: residual,
    gPer1000L: gPer1000L,
    fullNeutralizationMeq: hco3,
  };
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
  const waterEmpty = !Object.keys(water).some((k) => Number(water[k]) > 0);
  // 原水だけの陽イオン。希釈倍率を逆算するときに要る（原水は薄まらないため）
  const waterOnly = emptyIons();
  Object.keys(water).forEach((k) => {
    if (waterOnly[k] !== undefined) waterOnly[k] += Number(water[k]) || 0;
  });
  const waterCationMeq = chargeBalance(waterOnly).cationMeq;
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
    .concat(checkStockPh(tanks, dilution));

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
    phBand: estimatePhBand(ions, { waterEmpty: waterEmpty }),
    // タンクごとの原液pH（酸を入れていないタンクは null）
    tankStockPh: tanks.map((t) => ({ name: t.name, est: tankStockPh(t, dilution) })),
    ecCoefficient: coefficient,
    ecCoefficientIsDefault: coefficient === EC_COEFFICIENT,
    ecMeasured: measured > 0 ? measured : null,
    ecCoefficientDerived: derivedCoefficient,
    waterEmpty: waterEmpty,
    waterCationMeq: waterCationMeq,
    dilution: dilution,
    reference: compareToReference(ions, micro),
    tanks,
    warnings,
  };
}

// ---------- pHの目安 ----------
// 絶対値を1点で出すには炭酸平衡・リン酸緩衝・根呼吸のCO2まで解く必要があり、
// リン酸緩衝を無視したときの誤差を定量した一次資料も見つからなかった。
// そこで「帯」で返す。設計時のアタリをつけるには足りるが、実測の代わりにはならない。
//
// 根拠にできるのは次の2点だけ:
//   ・目標pHは 5.5〜6.5（複数の資料で一致）
//   ・原水のアルカリ度は 1.0 meq/L 程度を残す設計（アーカンソー大学の実務教材）
// この2つを突き合わせると「残留アルカリ度1.0前後なら目標に入りやすい」と言える。
// それ以外の帯は、そこからの外挿。
function estimatePhBand(ions, opts) {
  const o = opts || {};
  const hco3 = Number(ions.HCO3) || 0;   // 残留アルカリ度
  const freeH = Number(ions.H) || 0;     // 中和しきれずに残った酸
  const phosphate = Number(ions.H2PO4) || 0;

  // 何も入っていない状態で「5.5未満になりやすい」と出すと、
  // 入力前から警告が出ているように見える。判定しないことを明示する
  const total = Object.keys(ions).reduce((s, k) => s + (Number(ions[k]) || 0), 0);
  if (total <= 0) {
    return {
      level: "none",
      label: "—",
      message: "肥料も原水も入っていないので、まだ判定できません",
      buffered: false,
    };
  }

  // リン酸が1 mmol/L以上あれば、pKa2=7.21 の緩衝が効いて振れが小さくなる
  const buffered = phosphate >= 1.0;

  if (freeH > 0.01) {
    // 酸が余っている＝アルカリ度を使い切って、さらに入れた状態。
    // 強酸が完全解離すると仮定した下限値を出す（実際はリン酸の緩衝でもう少し高い）
    const floor = -Math.log10(freeH / 1000);
    return {
      level: "low",
      label: `${round(Math.max(3.0, floor), 1)} 前後かそれ以下`,
      message: `酸が ${round(freeH, 3)} mmol/L 余っています。原水のアルカリ度を使い切っているので、pHは目標(5.5〜6.5)を下回る見込みです`,
      buffered: buffered,
    };
  }

  if (hco3 < 0.2) {
    // アルカリ度ゼロは、たいてい「原水をまだ入れていない」だけ。
    // 実際の井戸水・水道水は 1〜4 meq/L 程度の重炭酸を持っており、
    // それが第一リン酸カリ由来の酸性（H2PO4⁻ 単独の水溶液は pH 4.7 前後）を受け止める。
    // 処方が悪いかのように読ませないよう、原因を分けて書く
    if (o.waterEmpty) {
      return {
        level: "low",
        label: "純水なら 5.5 未満",
        message: "原水を入れていないので、アルカリ度ゼロとして計算しています。実際の井戸水・水道水は重炭酸を1〜4 meq/L程度含み、それが酸を受け止めるのでpHはこれより高くなります。①前提の原水に分析値を入れてください",
        buffered: buffered,
      };
    }
    return {
      level: "low",
      label: "5.5 未満になりやすい",
      message: "残留アルカリ度がほぼゼロです。pHを支えるものがないので下振れしやすくなります",
      buffered: buffered,
    };
  }
  if (hco3 <= 1.5) {
    return {
      level: "ok",
      label: "5.5〜6.5 に入りやすい",
      message: `残留アルカリ度 ${round(hco3, 2)} mmol/L。実務で目安とされる1.0前後の範囲です`,
      buffered: buffered,
    };
  }
  if (hco3 <= 2.5) {
    return {
      level: "high",
      label: "6.5 を超えやすい",
      message: `残留アルカリ度 ${round(hco3, 2)} mmol/L はやや多めです。酸を増やすと目標に寄せられます`,
      buffered: buffered,
    };
  }
  return {
    level: "high",
    label: "7 前後かそれ以上",
    message: `残留アルカリ度 ${round(hco3, 2)} mmol/L は多すぎます。このままでは鉄・マンガンが不可給化する側に振れます`,
    buffered: buffered,
  };
}

// 原液タンクのpH。**タンクごとに**見る。
// 酸とキレート剤は別のタンクに分けるのが普通で（達子ファームは酸がA液・キレート鉄がB液、
// CFの画面も原液pH A 4.2 / B 7.2）、酸を入れていないタンクは低くならない。
//
// リン酸で酸性にする場合、第一リン酸カリが共存すると H3PO4 / H2PO4⁻ の緩衝系になり、
// 強酸として計算するより高いpHで落ち着く（pKa1 = 2.12）。
//   強酸として計算 → pH 1.8 ／ 緩衝を考慮 → pH 3.5（CFの実測4.2に近い）
const PHOSPHATE_PKA1 = 2.12;

function tankStockPh(tank, dilution) {
  const d = Number(dilution) || 1;
  const r = calcTank(tank, d);
  const hFeed = r.ions.H || 0;        // 給液換算の遊離酸
  const pFeed = r.ions.H2PO4 || 0;    // 給液換算のリン酸イオン
  if (!(hFeed > 0)) return null;      // 酸を入れていないタンク

  // タンクの中は希釈倍率のぶん濃い（mol/L に直す）
  const hConc = (hFeed * d) / 1000;
  const pConc = (pFeed * d) / 1000;

  // リン酸塩が遊離酸より十分多ければ緩衝系として扱う
  if (pConc > hConc * 2) {
    return {
      ph: PHOSPHATE_PKA1 + Math.log10(pConc / hConc),
      buffered: true,
      note: "第一リン酸カリとの緩衝系として計算",
    };
  }
  return {
    ph: -Math.log10(hConc),
    buffered: false,
    note: "強酸が完全解離すると仮定した下限値",
  };
}

// ---------- 肥料コスト ----------
// 原液を1回作るのにいくらか、給液1000Lあたりいくらかを出す。
// 処方どうしの差を見るのが目的なので、価格の分からない資材は合計から外し、
// 「何が未設定か」を返して黙って安く見せないようにする
function recipeCost(tanks, dilution) {
  const d = Number(dilution) || 1;
  let batchTotal = 0;      // 原液を1回作るのにかかる金額
  let feedVolumeL = 0;     // その原液で作れる給液の量
  const rows = [];
  const unpriced = [];

  (tanks || []).forEach((t) => {
    const tankL = Number(t.tankL) || 0;
    if (tankL > 0) feedVolumeL += tankL * d;
    (t.items || []).forEach((it) => {
      const kg = Number(it.kg) || 0;
      if (!(kg > 0)) return;
      const chem = lookupFertilizer(it.id);
      const name = chem ? chem.name : it.id;
      const p = FERTILIZER_PRICE_REF[it.id];
      if (!p) {
        unpriced.push({ id: it.id, name: name, kg: kg });
        return;
      }
      const yen = kg * p.yenPerKg;
      batchTotal += yen;
      rows.push({ id: it.id, name: name, tank: t.name, kg: kg, yenPerKg: p.yenPerKg, yen: yen });
    });
  });

  // タンクが複数あると、それぞれが同じ希釈倍率で同じ給液に入る。
  // 給液量は「1本ぶん × 倍率」なので、本数で割って重複を消す
  const tankCount = (tanks || []).filter((t) => Number(t.tankL) > 0).length || 1;
  feedVolumeL = feedVolumeL / tankCount;

  return {
    batchTotal: batchTotal,
    feedVolumeL: feedVolumeL,
    yenPer1000L: feedVolumeL > 0 ? (batchTotal / feedVolumeL) * 1000 : 0,
    rows: rows,
    unpriced: unpriced,
  };
}

// ---------- 目標ECから希釈倍率を逆算 ----------
// 生育ステージでECを変えるとき、実務では原液の配合を作り直すのではなく
// 液肥混入機の倍率を変える。100Lのタンクを作り直すより、ダイヤルを回す方が早い。
// 伊藤ら(2022)の試験も「同じ組成の培養液を希釈率だけ変えて」2区を比較している。
//
// ⚠️ ECは希釈倍率の単純な反比例にはならない。原水は薄まらないため。
//     EC = (原液由来の陽イオン ÷ D + 原水の陽イオン) × 係数
//   これを D について解く。原水だけで目標ECを超えていれば解は無い
//   （硬水・高EC原水では、いくら薄めても目標まで下がらないことが実際にある）
function dilutionForTargetEc(result, targetEc) {
  const target = Number(targetEc) || 0;
  if (!(target > 0) || !result) return null;
  const coef = Number(result.ecCoefficient) > 0 ? Number(result.ecCoefficient) : EC_COEFFICIENT;
  const water = Number(result.waterCationMeq) || 0;
  const d0 = Number(result.dilution) || 1;
  // 原液1Lあたりの陽イオン meq（希釈前）
  const stock = (Number(result.cationMeq) - water) * d0;
  if (!(stock > 0)) return null;

  const wantCation = target / coef;
  if (wantCation <= water) {
    return {
      dilution: null,
      current: d0,
      currentEc: result.ecEstimate,
      waterCationMeq: water,
      reason: `原水だけで陽イオンが ${round(water, 2)} meq/L あります。目標EC ${target} に相当するのは ${round(wantCation, 2)} meq/L なので、肥料をゼロにしても届きません`,
    };
  }
  return {
    dilution: stock / (wantCation - water),
    current: d0,
    currentEc: result.ecEstimate,
    stockCationMeq: stock,
    waterCationMeq: water,
  };
}

// ---------- 実測からの評価 ----------
// 他所の試験のEC値をなぞっても、自分の圃場の蒸散量が違えば施肥量は合わない。
// 測るのは4つだけ（給液量・排液量・給液EC・排液EC）。そこから
// 「いま何が起きているか」と「次に何をどう動かすか」を出す。
//
// 数字の根拠:
//   排液率     ヤシガラ25〜35%（伊藤ら2022）／ロックウール10〜20%（石原ら2000）
//   窒素施用量 定植期25 → 収穫期は1月まで100・2月以降150 mg/株/日（伊藤ら2022の結論）
//   培地内EC   給液ECの数倍に濃縮する。石原ら2000は給液1.8に対し
//              排液率8.3%でマット内9.6／16.3%で6.4／39.5%で3.0 を実測。
//              排液率が半分になると培地内ECはほぼ倍になる
//
// 養分吸収率の式は物質収支から出る。
//   給液した養分 = 排液に出た養分 + 樹が吸った養分
//   → 吸収率 = 1 − (排液EC × 排液率) ÷ 給液EC
// 伊藤ら2022の実測と符合する（低濃度区は窒素利用率84.5%で排液ECが給液を下回り、
// 対照区は59.4%で上回った）。
//
// ⚠️ ECは全イオンの合計なので、この「吸収率」は窒素利用率とは一致しない。
//    原水のNa⁺やCl⁻は吸われず蓄積するため、実際の値より低めに出る。
//    絶対値ではなく、同じ圃場での推移を見るための指標として使う。
function evaluateFeed(rec) {
  const r = rec || {};
  const feedL = Number(r.feedLPerPlant) || 0;
  const drainL = Number(r.drainLPerPlant) || 0;
  const feedEc = Number(r.feedEc) || 0;
  const drainEc = Number(r.drainEc) || 0;
  const nMgPerL = Number(r.nitrogenMgPerL) || 0;

  const drainPct = feedL > 0 ? (drainL / feedL) * 100 : null;
  const uptakeRatio = (feedL > 0 && feedEc > 0 && drainEc >= 0)
    ? 1 - (drainEc * (drainL / feedL)) / feedEc
    : null;
  const nitrogenMgPerPlant = (feedL > 0 && nMgPerL > 0) ? feedL * nMgPerL : null;
  // 樹が実際に吸った水（＝蒸散量）。給液量ではなくこちらが日射・気温に対応する
  const uptakeLPerPlant = feedL > 0 ? feedL - drainL : null;
  // 排液ECが給液ECの何倍か。1.0を超えたら養分が培地に溜まっている
  const drainRatio = feedEc > 0 && drainEc > 0 ? drainEc / feedEc : null;

  return {
    drainPct: drainPct,
    uptakeRatio: uptakeRatio,
    nitrogenMgPerPlant: nitrogenMgPerPlant,
    uptakeLPerPlant: uptakeLPerPlant,
    drainRatio: drainRatio,
  };
}

// 評価結果を目標と突き合わせ、次の一手を数字で返す。
// target: { drainPctMin, drainPctMax, nitrogenMin, nitrogenMax, drainEcMax }
function feedAdvice(rec, evalResult, target) {
  const t = target || {};
  const dMin = t.drainPctMin === undefined ? 25 : Number(t.drainPctMin);
  const dMax = t.drainPctMax === undefined ? 35 : Number(t.drainPctMax);
  const nMin = Number(t.nitrogenMin) || 0;
  const nMax = Number(t.nitrogenMax) || 0;
  const ecMax = t.drainEcMax === undefined ? 5.0 : Number(t.drainEcMax);

  const e = evalResult || {};
  const out = [];
  const feedL = Number((rec || {}).feedLPerPlant) || 0;
  const feedEc = Number((rec || {}).feedEc) || 0;
  const nMgPerL = Number((rec || {}).nitrogenMgPerL) || 0;

  // ① 排液EC。ここだけは他を差し置いて先に見る
  const drainEc = Number((rec || {}).drainEc) || 0;
  if (drainEc > ecMax) {
    out.push({
      level: "danger", topic: "排液EC",
      message: `排液EC ${round(drainEc, 2)} が上限 ${ecMax} を超えています。塩類が培地に溜まっている状態で、草勢低下と尻腐れにつながります`,
      action: "給液量を増やして洗い流す（リーチング）。ECを下げても培地に溜まった分は抜けません",
    });
  }

  // ② 排液率。給液量の適否はこれで決まる
  if (e.drainPct !== null && e.drainPct !== undefined) {
    if (e.drainPct < dMin) {
      // 目標排液率にするのに必要な給液量
      const need = feedL > 0 && e.uptakeLPerPlant > 0
        ? e.uptakeLPerPlant / (1 - dMin / 100) : null;
      out.push({
        level: "warn", topic: "排液率",
        message: `排液率 ${round(e.drainPct, 1)}% は目標 ${dMin}〜${dMax}% を下回っています。培地内で濃縮が進みます`,
        action: need
          ? `給液量を ${round(feedL, 2)} → ${round(need, 2)} L/株/日 に増やす（吸水量 ${round(e.uptakeLPerPlant, 2)} L から逆算）`
          : "給液量を増やす",
      });
    } else if (e.drainPct > dMax) {
      const need = e.uptakeLPerPlant > 0 ? e.uptakeLPerPlant / (1 - dMax / 100) : null;
      out.push({
        level: "info", topic: "排液率",
        message: `排液率 ${round(e.drainPct, 1)}% は目標 ${dMin}〜${dMax}% を上回っています。肥料と水を余分に流しています`,
        action: need ? `給液量を ${round(need, 2)} L/株/日 まで減らせます` : "給液量を減らせます",
      });
    }
  }

  // ③ 排液ECと給液ECの関係。上限に達していなくても、上回り続けるのは黄信号
  if (e.drainRatio !== null && e.drainRatio !== undefined && drainEc <= ecMax) {
    if (e.drainRatio > 1.0) {
      out.push({
        level: "warn", topic: "養分の収支",
        message: `排液EC が給液EC の ${round(e.drainRatio, 2)} 倍です。入れた養分を樹が使い切れていません`,
        action: "この状態が1週間続くなら給液ECを0.1〜0.2下げる。ただし先に排液率と樹勢を確認する",
      });
    }
  }

  // ④ 窒素施用量。ECではなくこちらが本体
  if (e.nitrogenMgPerPlant !== null && e.nitrogenMgPerPlant !== undefined && nMin > 0) {
    const n = e.nitrogenMgPerPlant;
    if (n < nMin || (nMax > 0 && n > nMax)) {
      // 目標窒素量を今の給液量で満たすのに必要な濃度 → ECに換算
      const wanted = n < nMin ? nMin : nMax;
      const needMgPerL = feedL > 0 ? wanted / feedL : null;
      const needEc = (needMgPerL && nMgPerL > 0 && feedEc > 0)
        ? feedEc * (needMgPerL / nMgPerL) : null;
      out.push({
        level: n < nMin ? "warn" : "info", topic: "窒素施用量",
        message: `窒素 ${round(n, 0)} mg/株/日 は目標 ${nMin}${nMax ? "〜" + nMax : ""} mg から外れています`,
        action: needEc
          ? `いまの給液量 ${round(feedL, 2)} L のままなら、給液EC を ${round(feedEc, 2)} → ${round(needEc, 2)} にする`
          : "給液ECか給液量を調整する",
      });
    }
  }

  if (out.length === 0) {
    out.push({
      level: "ok", topic: "総合",
      message: "排液率・排液EC・窒素施用量とも目標の範囲に入っています",
      action: "このまま継続。数字を記録に残して、自分の圃場の値として蓄積する",
    });
  }
  return out;
}

// 処方から窒素濃度(mg/L)を出す。evaluateFeed に渡す用。
// NO3⁻ も NH4⁺ も窒素は1原子なので、mmol/L の合計に原子量を掛ける
function nitrogenMgPerL(ions) {
  const i = ions || {};
  const no3 = Number(i.NO3) || 0;
  const nh4 = Number(i.NH4) || 0;
  return (no3 + nh4) * 14.01;
}

// ---------- 給液量から見た規模 ----------
// 「1000L作るのに何kg」だけでは、タンクが何日持つか・年間いくらかかるかが分からない。
// 株数と1株あたりの給液量を入れて、調製の頻度と年間の肥料費を出す。
//
// 給液量の目安（伊藤ら2022・愛知農総試研報54号・促成長期どり・大玉りんか409）:
//   1回 150〜200 mL/株、給液量 0.5〜1.2 L/株/日、排液率25〜35%を目標
// ⚠️ 夏秋作ミニトマトの値（8月に2,500 mL/株/日）は作型が違うので混ぜない。
// ピーク時と年間平均を分けて扱う。
//   タンク容量・調製の頻度 → ピーク（いちばん厳しい日に足りるか）
//   年間の肥料費           → 平均（繁忙期の値を年間に掛けると過大になる）
// 1つの値で兼ねると、タンクが足りないか、費用を数割多く見積もるかのどちらかになる
function scaleEstimate(cost, dilution, opts) {
  const plants = Number(opts.plants) || 0;
  const peakMl = Number(opts.peakMlPerPlantDay) || 0;
  const avgMl = Number(opts.avgMlPerPlantDay) || 0;
  const daysPerYear = Number(opts.daysPerYear) || 0;
  const d = Number(dilution) || 1;
  if (!(plants > 0) || !(peakMl > 0)) return null;

  const peakFeedL = (plants * peakMl) / 1000;
  const avgFeedL = avgMl > 0 ? (plants * avgMl) / 1000 : null;

  return {
    // ピーク側（設備の設計に使う）
    peakFeedLPerDay: peakFeedL,
    peakStockLPerDay: peakFeedL / d,
    daysPerBatch: peakFeedL > 0 ? cost.feedVolumeL / peakFeedL : 0,
    peakYenPerDay: (cost.yenPer1000L * peakFeedL) / 1000,

    // 平均側（費用の見積もりに使う）
    avgFeedLPerDay: avgFeedL,
    avgYenPerDay: avgFeedL === null ? null : (cost.yenPer1000L * avgFeedL) / 1000,
    feedLPerYear: avgFeedL === null || !(daysPerYear > 0) ? null : avgFeedL * daysPerYear,
    yenPerYear: avgFeedL === null || !(daysPerYear > 0)
      ? null
      : (cost.yenPer1000L * avgFeedL * daysPerYear) / 1000,
  };
}

// ---------- 制約付きの組成づくり ----------
// 「カルシウムを6.0にしたい。他は基準内なら何でもよい」という組み方をする。
// Caを増やすと硝酸カルシウムからNO3も増えるので、他の元素で帳尻を合わせないと
// 電荷が釣り合わず、塩だけでは作れない組成になってしまう。
//
// 動かす順番は「基準の幅が広いもの」から。幅が狭い元素を無理に振ると
// すぐ範囲外になるため。NH4は尻腐れ対策で低く保つものなので調整には使わない
// 動かす順序。前にあるものほど先に動かす＝栽培上いじっても影響が小さい順。
// Ca は尻腐れに直結するので最後に置くが、対象からは外さない。
// （外していた時期があり、Ca を下げれば釣り合う組成でも「合いません」と
//   突き返していた。優先度を下げるのと対象外にするのは別のこと）
const BALANCE_PRIORITY = [
  { ion: "NO3", charge: -1 },
  { ion: "K", charge: 1 },
  { ion: "SO4", charge: -2 },
  { ion: "Mg", charge: 2 },
  { ion: "H2PO4", charge: -1 },
  { ion: "Ca", charge: 2 },
];

function buildBalancedTarget(fixed, opts) {
  const ranges = REFERENCE_RANGES.ions;
  const lock = fixed || {};
  const options = opts || {};
  const target = {};
  const moved = {};

  // 固定されていない元素は基準の中央から始める。
  // NH4だけは下限寄り（0.5）にする。増やす方向に動かしたくないため
  Object.keys(ranges).forEach((k) => {
    if (lock[k] !== undefined && lock[k] !== "") {
      target[k] = Number(lock[k]) || 0;
    } else if (k === "NH4") {
      target[k] = options.nh4 === undefined ? 0.5 : Number(options.nh4);
    } else if (k === "Cl") {
      target[k] = 0; // 塩化物は入れない（原水由来のみ）
    } else {
      target[k] = (ranges[k].min + ranges[k].max) / 2;
    }
  });

  // 電荷の差を、動かせる元素で埋めていく。
  //   diff = 陽 − 陰。イオンを Δ 動かすと diff は Δ×charge だけ動く
  //   → diff を消すには Δ = −diff / charge
  const initial = Object.assign({}, target);
  let diff = chargeBalance(target).diff;
  const notes = [];

  // 1周で足りる。各イオンを順に「差を消す方向へ動かせるだけ動かす」ので、
  // 1周したあとに差が残っているなら、すべてのイオンが可動域の端に張り付いている。
  // つまりそれ以上動かせず、基準の範囲内に解が無い。
  // （複数周まわす実装にしていた時期があるが、400パターンの検証で
  //   1周と結果が一致することを確認して戻した）
  BALANCE_PRIORITY.forEach((a) => {
    if (Math.abs(diff) < 0.005) return;
    if (lock[a.ion] !== undefined && lock[a.ion] !== "") return; // 固定されている
    const r = ranges[a.ion];
    if (!r) return;
    const before = target[a.ion];
    const want = before + (-diff / a.charge);
    const clamped = Math.max(r.min, Math.min(r.max, want));
    const actual = clamped - before;
    if (Math.abs(actual) < 0.0001) return;
    target[a.ion] = clamped;
    diff += actual * a.charge;
  });

  // 動いた量は「最初と最後の差」で出す。
  // 途中経過を1行ずつ並べると、同じイオンが何度も出てきて読めなくなる
  BALANCE_PRIORITY.forEach((a) => {
    const delta = target[a.ion] - initial[a.ion];
    if (Math.abs(delta) < 0.0001) return;
    moved[a.ion] = round(delta, 2);
    notes.push(`${a.ion} を ${round(initial[a.ion], 2)} → ${round(target[a.ion], 2)}`);
  });

  const feasible = Math.abs(diff) < 0.05;
  return {
    target: target,
    moved: moved,
    notes: notes,
    remaining: round(diff, 3),
    feasible: feasible,
    message: feasible
      ? `固定した元素を保ったまま、電荷が釣り合う組成にできました（${notes.join("・")}）`
      : `基準の範囲内では電荷が ${round(Math.abs(diff), 2)} meq/L 合いません。固定する値を見直すか、基準の外に出す必要があります`,
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
    solveRecipe, mmolToKg, estimatePhBand, tankStockPh,
    fertilizerTankRoles, tankRoles, conflictsWithTank, tankConflicts, splitIntoTwoTanks,
    recipeCost, scaleEstimate, buildBalancedTarget,
    applyAcidNeutralization, acidRequirement,
    evaluateFeed, feedAdvice, nitrogenMgPerL, dilutionForTargetEc,
    EC_COEFFICIENT,
  };
}
