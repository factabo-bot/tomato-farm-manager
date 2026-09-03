"use strict";

// 養液設計画面。計算そのものは fertilizer.js（純粋関数）に任せ、ここはDOMだけを扱う。
// 入力はこの端末の localStorage に持つ。処方のマスタ保存は次の段階（GAS側の対応が要る）。

const FERT_STATE_KEY = "tfm_fert_state";

// 原水の入力欄に出すイオン。HCO3とNaを外すと電荷が合わなくなるので必ず入れる
const WATER_FIELDS = [
  { key: "Ca", label: "Ca カルシウム" },
  { key: "Mg", label: "Mg マグネシウム" },
  { key: "K", label: "K カリウム" },
  { key: "Na", label: "Na ナトリウム" },
  { key: "NO3", label: "NO3 硝酸" },
  { key: "SO4", label: "SO4 硫酸" },
  { key: "Cl", label: "Cl 塩化物" },
  { key: "HCO3", label: "HCO3 重炭酸" },
];

const ION_LABEL = {
  K: "カリウム", Ca: "カルシウム", Mg: "マグネシウム", NH4: "アンモニウム",
  NO3: "硝酸", H2PO4: "リン酸", SO4: "硫酸", Cl: "塩化物",
  Na: "ナトリウム", HCO3: "重炭酸", H: "水素",
};

const MICRO_LABEL = {
  Fe: "鉄", Mn: "マンガン", Zn: "亜鉛", B: "ホウ素", Cu: "銅", Mo: "モリブデン",
};

function defaultState() {
  const water = {};
  WATER_FIELDS.forEach((f) => (water[f.key] = ""));
  return {
    dilution: 120,
    tanks: [
      { name: "A液", tankL: 100, items: [] },
      { name: "B液", tankL: 100, items: [] },
    ],
    water: water,
    acid: { anion: "", meqPerL: "" },
    ecMeasured: "",
    ecCoefficient: "",
    // 保存した処方とのひもづけ
    recipeId: "",
    recipeName: "",
    recipeStage: "",
    waterId: "",
    // 逆算の目標組成（mmol/L・空欄可）
    target: {},
    // 「この元素だけ決めたい」の入力（空欄＝自動調整）
    lock: {},
    // 規模の試算（株数・1株1日の給液量mL・年間の給液日数）
    scale: { plants: "", ml: "", days: "" },
  };
}

// お試しモード（GAS未接続）で処方を保存する先。
// 本番はスプレッドシートの マスタ_養液処方 に入る
const FERT_LOCAL_RECIPE_KEY = "tfm_fert_recipes_local";
const FERT_LOCAL_ITEM_KEY = "tfm_fert_recipe_items_local";

let masters = null;

function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch (err) {
    return [];
  }
}
function writeLocal(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch (err) {
    console.warn("保存できませんでした", err);
  }
}

// サーバー側の処方と、お試しモードのローカル処方をまとめて扱う
function allFeedRecipes() {
  const remote = (masters && masters.feedRecipes) || [];
  return remote.concat(readLocal(FERT_LOCAL_RECIPE_KEY))
    .filter((r) => String(r["有効フラグ"]).toUpperCase() !== "FALSE");
}
function allFeedRecipeItems() {
  const remote = (masters && masters.feedRecipeItems) || [];
  return remote.concat(readLocal(FERT_LOCAL_ITEM_KEY));
}
function allWaters() {
  const remote = (masters && masters.waters) || [];
  return remote.filter((w) => String(w["有効フラグ"]).toUpperCase() !== "FALSE");
}

let state = defaultState();

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(FERT_STATE_KEY) || "null");
    if (raw && raw.tanks) state = Object.assign(defaultState(), raw);
  } catch (err) {
    console.warn("養液設計の入力を読み込めませんでした", err);
  }
}

function saveState() {
  try {
    localStorage.setItem(FERT_STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("養液設計の入力を保存できませんでした", err);
  }
}

// 数値入力は空欄を0として扱う（0と未入力を区別する必要がない画面なので）
function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// ---------- 肥料の選択肢 ----------
// 規制品（硝酸アンモニウムなど）は既定のリストに出さない。
// トマトはNH4を1.5mmol/L以下に抑えるので、無くても処方は組める
function fertilizerOptions() {
  const list = [];
  Object.keys(FERTILIZER_CHEM).forEach((id) => {
    const c = FERTILIZER_CHEM[id];
    if (c.restricted) return;
    list.push({
      id, name: c.name,
      group: c.isAcid ? "酸" : "単肥",
      roles: FertilizerCalc.fertilizerTankRoles(id),
    });
  });
  Object.keys(FERTILIZER_PRODUCTS).forEach((id) => {
    list.push({
      id, name: FERTILIZER_PRODUCTS[id].name,
      group: "微量要素",
      roles: FertilizerCalc.fertilizerTankRoles(id),
    });
  });
  return list;
}

// ---------- タンクの描画 ----------
function renderTanks() {
  const wrap = $("tank-list");
  wrap.innerHTML = "";

  state.tanks.forEach((tank, ti) => {
    const box = el("div", "fert-tank");

    const head = el("div", "fert-tank-head");
    const nameInput = el("input", "fert-tank-name");
    nameInput.type = "text";
    nameInput.value = tank.name;
    nameInput.addEventListener("input", () => {
      tank.name = nameInput.value;
      saveState();
      recalc();
    });
    head.appendChild(nameInput);

    const volLabel = el("span", "num-unit", "容量");
    head.appendChild(volLabel);
    const volInput = el("input", "num-input");
    volInput.type = "number";
    volInput.inputMode = "decimal";
    volInput.value = tank.tankL;
    volInput.addEventListener("focus", () => volInput.select());
    volInput.addEventListener("input", () => {
      tank.tankL = num(volInput.value);
      saveState();
      recalc();
    });
    head.appendChild(volInput);
    head.appendChild(el("span", "num-unit", "L"));

    if (state.tanks.length > 1) {
      const del = el("button", "del", "削除");
      del.type = "button";
      del.addEventListener("click", () => {
        state.tanks.splice(ti, 1);
        saveState();
        renderTanks();
        recalc();
      });
      head.appendChild(del);
    }
    box.appendChild(head);

    // 明細
    (tank.items || []).forEach((item, ii) => {
      const row = el("div", "fert-item-row");
      const chem = FERTILIZER_CHEM[item.id] || FERTILIZER_PRODUCTS[item.id];
      const nameSpan = el("span", "grow", chem ? chem.name : item.id);
      row.appendChild(nameSpan);

      const kgInput = el("input", "num-input");
      kgInput.type = "number";
      kgInput.inputMode = "decimal";
      kgInput.step = "0.1";
      // 0 を表示すると、入力のたびに消してから打ち直すことになるので空欄にする
      kgInput.value = (item.kg === 0 || item.kg === "" || item.kg === null || item.kg === undefined) ? "" : item.kg;
      kgInput.placeholder = "0";
      kgInput.addEventListener("focus", () => kgInput.select());
      kgInput.addEventListener("input", () => {
        // 空欄のまま持たせる（0を書き戻すと同じ問題が起きる）
        item.kg = kgInput.value === "" ? "" : num(kgInput.value);
        saveState();
        recalc();
      });
      row.appendChild(kgInput);
      row.appendChild(el("span", "num-unit", "kg"));

      const del = el("button", "del", "×");
      del.type = "button";
      del.addEventListener("click", () => {
        tank.items.splice(ii, 1);
        saveState();
        renderTanks();
        recalc();
      });
      row.appendChild(del);
      box.appendChild(row);
    });

    // このタンクで既に起きている衝突。計算結果まで見に行かなくても分かるよう箱の中に出す
    FertilizerCalc.tankConflicts(tank).forEach((c) => {
      box.appendChild(el("div", "fert-tank-warn",
        `⚠ ${TANK_ROLE_LABEL[c.a]}と${TANK_ROLE_LABEL[c.b]}が同居しています。${c.label}`));
    });

    // 追加行
    const addRow = el("div", "fert-add-row");
    const sel = el("select", "unit-select");
    const blank = el("option", "", "＋ 肥料を選ぶ");
    blank.value = "";
    sel.appendChild(blank);
    let lastGroup = "";
    let group = null;
    fertilizerOptions().forEach((o) => {
      if (o.group !== lastGroup) {
        group = document.createElement("optgroup");
        group.label = o.group;
        sel.appendChild(group);
        lastGroup = o.group;
      }
      // このタンクに入れると沈殿・分解するものは選べないようにし、理由を書く
      const conflicts = FertilizerCalc.conflictsWithTank(tank, o.id);
      let label = o.name;
      if (conflicts.length > 0) {
        const other = conflicts.map((c) => {
          const mine = FertilizerCalc.fertilizerTankRoles(o.id);
          return TANK_ROLE_LABEL[mine.indexOf(c.a) >= 0 ? c.b : c.a];
        });
        label += `（${other.join("・")}と同居できません）`;
      } else if (o.roles.length > 0) {
        label += `【${o.roles.map((r) => TANK_ROLE_LABEL[r]).join("・")}】`;
      }
      const opt = el("option", "", label);
      opt.value = o.id;
      opt.disabled = conflicts.length > 0;
      group.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      tank.items = (tank.items || []).concat([{ id: sel.value, kg: "" }]);
      sel.value = "";
      saveState();
      renderTanks();
      recalc();
    });
    addRow.appendChild(sel);
    box.appendChild(addRow);

    wrap.appendChild(box);
  });
}

// ---------- 原水の描画 ----------
function renderWater() {
  const wrap = $("water-inputs");
  wrap.innerHTML = "";
  WATER_FIELDS.forEach((f) => {
    const row = el("div", "fert-water-row");
    row.appendChild(el("label", "num-label", f.label));
    const input = el("input", "num-input");
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "0.01";
    input.value = state.water[f.key];
    input.placeholder = "0";
    input.addEventListener("focus", () => input.select());
    input.addEventListener("input", () => {
      state.water[f.key] = input.value;
      saveState();
      recalc();
    });
    row.appendChild(input);
    row.appendChild(el("span", "num-unit", "mmol/L"));
    wrap.appendChild(row);
  });
}

// 原水だけの電荷収支。分析値に抜けがあるとここで気づける
function renderWaterBalance() {
  const ions = {};
  WATER_FIELDS.forEach((f) => (ions[f.key] = num(state.water[f.key])));
  const b = FertilizerCalc.chargeBalance(ions);
  $("water-cation").textContent = FertilizerCalc.round(b.cationMeq, 2);
  $("water-anion").textContent = FertilizerCalc.round(b.anionMeq, 2);
  const note = $("water-balance-note");
  if (b.cationMeq === 0 && b.anionMeq === 0) {
    note.textContent = "";
    note.className = "";
  } else if (b.errorPct > 5) {
    note.textContent = ` ⚠ ${FertilizerCalc.round(b.errorPct, 1)}% ずれています。測っていない項目がありませんか`;
    note.className = "fert-inline-warn";
  } else {
    note.textContent = " ✓ 釣り合っています";
    note.className = "fert-inline-ok";
  }
}

// ---------- 計算して結果を描く ----------
function buildInput() {
  const water = {};
  WATER_FIELDS.forEach((f) => {
    const v = num(state.water[f.key]);
    if (v) water[f.key] = v;
  });
  const input = {
    dilution: num(state.dilution) || 1,
    tanks: state.tanks.map((t) => ({
      name: t.name, tankL: num(t.tankL),
      items: (t.items || []).filter((i) => num(i.kg) > 0),
    })),
    water: water,
  };
  if (state.acid.anion && num(state.acid.meqPerL) > 0) {
    input.acid = { anion: state.acid.anion, meqPerL: num(state.acid.meqPerL) };
  }
  if (num(state.ecMeasured) > 0) input.ecMeasured = num(state.ecMeasured);
  if (num(state.ecCoefficient) > 0) input.ecCoefficient = num(state.ecCoefficient);
  return input;
}

let lastResult = null;

function recalc() {
  renderWaterBalance();
  const result = FertilizerCalc.calcSolution(buildInput());
  lastResult = result;

  // EC
  $("res-ec").textContent = FertilizerCalc.round(result.ecEstimate, 2);
  const ecNote = [];
  ecNote.push(`係数 ${FertilizerCalc.round(result.ecCoefficient, 4)}${result.ecCoefficientIsDefault ? "（既定）" : "（補正済み）"}`);
  if (result.ecMeasured) ecNote.push(`実測 ${result.ecMeasured}`);
  $("res-ec-note").textContent = ecNote.join(" / ");

  // 電荷バランス
  $("res-balance").textContent = FertilizerCalc.round(result.balanceErrorPct, 2);
  const balNote = $("res-balance-note");
  balNote.textContent = `陽 ${FertilizerCalc.round(result.cationMeq, 2)} / 陰 ${FertilizerCalc.round(result.anionMeq, 2)} meq/L`;
  balNote.className = "fert-stat-note " + (result.balanceErrorPct > 0.5 ? "fert-inline-warn" : "fert-inline-ok");

  // pHの目安。絶対値ではなく帯で出す（実測の代わりにはならない）
  const ph = result.phBand;
  const phEl = $("res-ph");
  phEl.textContent = ph.label;
  phEl.className = "fert-stat-value fert-ph-value fert-ph-" + ph.level;
  const phNote = [ph.message];
  if (ph.buffered) phNote.push("リン酸1mmol/L以上あり緩衝が効く");
  // 原液pHはタンクごと。酸を入れたタンクだけ低くなる（キレート剤と分けてあれば問題ない）
  (result.tankStockPh || []).forEach((t) => {
    if (!t.est) return;
    phNote.push(`${t.name}の原液pHは ${FertilizerCalc.round(t.est.ph, 1)} 相当（${t.est.note}）`);
  });
  $("res-ph-note").textContent = phNote.join(" / ");

  // 警告
  const warnBox = $("res-warnings");
  warnBox.innerHTML = "";
  result.warnings.forEach((w) => {
    warnBox.appendChild(el("div", "fert-warn fert-warn-" + w.level, w.message));
  });

  // 主要イオン
  renderIonTable(result);
  renderMicroTable(result);
  renderCost();

  // 実測ECが入っていれば係数の補正ボタンを出す
  $("ec-coef-box").hidden = !(result.ecCoefficientDerived > 0);
  if (result.ecCoefficientDerived > 0 && !$("ec-coef").value) {
    $("ec-coef").placeholder = FertilizerCalc.round(result.ecCoefficientDerived, 4);
  }
}

function renderIonTable(result) {
  const wrap = $("res-ions");
  wrap.innerHTML = "";
  const table = el("table", "fert-table");
  const thead = el("thead");
  const hr = el("tr");
  // スマホ幅（実機は360〜412pxが主）に収める。
  //  - 判定列は作らず、値の色と矢印で示す
  //  - me/L は既定で隠す（日本の処方表と比べるときだけ出す）
  const showMeq = !!state.showMeq;
  const heads = showMeq ? ["イオン", "mmol/L", "me/L", "基準"] : ["イオン", "mmol/L", "基準"];
  heads.forEach((h) => hr.appendChild(el("th", "", h)));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  result.reference.ions.forEach((row) => {
    const tr = el("tr");
    tr.appendChild(el("td", "", `${row.ion} ${ION_LABEL[row.ion] || ""}`));

    let cls = "num";
    let mark = "";
    if (row.value > 0) {
      if (row.below) { cls += " fert-below"; mark = " ↓"; }
      else if (row.above) { cls += " fert-above"; mark = " ↑"; }
    }
    tr.appendChild(el("td", cls, FertilizerCalc.round(row.value, 2) + mark));
    if (showMeq) {
      tr.appendChild(el("td", "num", FertilizerCalc.round(FertilizerCalc.ionMeq(result.ions, row.ion), 2)));
    }
    tr.appendChild(el("td", "num sub", `${row.min}〜${row.max}`));
    tbody.appendChild(tr);
  });

  // 養分ではないが電荷収支に効くイオン。薄いグレーの行で下にまとめる
  let hasSub = false;
  ["Na", "HCO3", "H"].forEach((k) => {
    if (!result.ions[k]) return;
    hasSub = true;
    const tr = el("tr", "fert-row-sub");
    tr.appendChild(el("td", "", `${k} ${ION_LABEL[k] || ""}`));
    tr.appendChild(el("td", "num", FertilizerCalc.round(result.ions[k], 3)));
    if (showMeq) {
      tr.appendChild(el("td", "num", FertilizerCalc.round(FertilizerCalc.ionMeq(result.ions, k), 3)));
    }
    tr.appendChild(el("td", "num sub", "—"));
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);

  wrap.appendChild(el("p", "hint", "↓ は基準より低い / ↑ は高い（作型・原水で適正は動くので参照線）"));
  if (hasSub) {
    wrap.appendChild(el("p", "hint",
      "グレーの行は養分ではないが電荷収支に必要なイオン。Na⁺やHCO3⁻を数えないとバランスが合わない"));
  }
  wrap.appendChild(el("p", "hint",
    `リン酸をPO4³⁻(3価)で換算すると ${FertilizerCalc.round(result.phosphateMeq3, 2)} me/L。日本の処方表はこの流儀が多いので比較時は注意`));
}

function renderMicroTable(result) {
  const wrap = $("res-micro");
  wrap.innerHTML = "";
  const table = el("table", "fert-table");
  const thead = el("thead");
  const hr = el("tr");
  ["要素", "mg/L", "標準（比）"].forEach((h) => hr.appendChild(el("th", "", h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  result.reference.micro.forEach((row) => {
    const tr = el("tr");
    tr.appendChild(el("td", "", `${row.element} ${MICRO_LABEL[row.element] || ""}`));
    tr.appendChild(el("td", "num", FertilizerCalc.round(row.value, 3)));
    // 標準値と標準比を1列にまとめる（スマホ幅で列が溢れるため）
    let stdText = "—";
    if (row.standard !== null) {
      stdText = String(row.standard);
      if (row.ratioToStandard !== null && row.value > 0) {
        stdText += `（${FertilizerCalc.round(row.ratioToStandard, 1)}倍）`;
      }
    }
    tr.appendChild(el("td", "num sub", stdText));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.appendChild(el("p", "hint", "標準はオランダ系の給液組成（μmol/Lを換算）。作型・原水で適正は動くので参照線として見る"));
}

// ---------- 書き出し ----------
function resultToText() {
  if (!lastResult) return "";
  const r = lastResult;
  const lines = [];
  lines.push("【養液組成】" + new Date().toLocaleDateString("ja-JP"));
  lines.push(`希釈 ${state.dilution}倍`);
  state.tanks.forEach((t) => {
    const items = (t.items || []).filter((i) => num(i.kg) > 0);
    if (items.length === 0) return;
    lines.push(`[${t.name} ${t.tankL}L]`);
    items.forEach((i) => {
      const chem = FERTILIZER_CHEM[i.id] || FERTILIZER_PRODUCTS[i.id];
      lines.push(`  ${chem ? chem.name : i.id}  ${i.kg} kg`);
    });
  });
  lines.push("");
  lines.push(`EC推定 ${FertilizerCalc.round(r.ecEstimate, 2)} mS/cm（係数 ${FertilizerCalc.round(r.ecCoefficient, 4)}）`);
  lines.push(`電荷バランス 陽 ${FertilizerCalc.round(r.cationMeq, 2)} / 陰 ${FertilizerCalc.round(r.anionMeq, 2)} meq/L（誤差 ${FertilizerCalc.round(r.balanceErrorPct, 2)}%）`);
  lines.push("");
  lines.push("[主要イオン mmol/L]");
  NUTRIENT_IONS.forEach((k) => {
    lines.push(`  ${k}: ${FertilizerCalc.round(r.ions[k], 2)}`);
  });
  lines.push("[微量要素 mg/L]");
  MICRO_ELEMENTS.forEach((k) => {
    lines.push(`  ${k}: ${FertilizerCalc.round(r.micro[k], 3)}`);
  });
  if (r.warnings.length) {
    lines.push("");
    lines.push("[注意]");
    r.warnings.forEach((w) => lines.push("  ・" + w.message));
  }
  return lines.join("\n");
}

// ---------- 元素を指定して組成を作る ----------
// 「Caを6.0にしたい。他は基準内なら何でもよい」という組み方。
// 指定しなかった元素を基準の範囲で動かし、電荷が釣り合う組成にする

function renderLockInputs() {
  const wrap = $("lock-inputs");
  wrap.innerHTML = "";
  TARGET_FIELDS.forEach((k) => {
    const row = el("div", "fert-water-row");
    row.appendChild(el("label", "num-label", `${k} ${ION_LABEL[k] || ""}`));
    const input = el("input", "num-input");
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "0.1";
    const r = REFERENCE_RANGES.ions[k];
    input.placeholder = r ? `${r.min}〜${r.max}` : "";
    input.value = state.lock[k] === undefined ? "" : state.lock[k];
    input.addEventListener("focus", () => input.select());
    input.addEventListener("input", () => {
      state.lock[k] = input.value;
      saveState();
    });
    row.appendChild(input);
    row.appendChild(el("span", "num-unit", "mmol/L"));
    wrap.appendChild(row);
  });
}

function runBuildTarget() {
  const fixed = {};
  let count = 0;
  TARGET_FIELDS.forEach((k) => {
    if (state.lock[k] !== undefined && String(state.lock[k]).trim() !== "") {
      fixed[k] = num(state.lock[k]);
      count++;
    }
  });

  const box = $("build-result");
  box.innerHTML = "";
  if (count === 0) {
    box.appendChild(el("p", "hint", "動かしたい元素の値を1つ以上入れてください（空欄のものが自動で調整されます）"));
    return;
  }

  const r = FertilizerCalc.buildBalancedTarget(fixed);
  box.appendChild(el("div", "fert-warn fert-warn-" + (r.feasible ? "info" : "warn"), r.message));

  const table = el("table", "fert-table");
  const thead = el("thead");
  const hr = el("tr");
  ["イオン", "mmol/L", "基準"].forEach((h) => hr.appendChild(el("th", "", h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  TARGET_FIELDS.forEach((k) => {
    const ref = REFERENCE_RANGES.ions[k];
    const tr = el("tr");
    const isFixed = fixed[k] !== undefined;
    tr.appendChild(el("td", "", `${isFixed ? "🔒 " : ""}${k} ${ION_LABEL[k] || ""}`));
    const cell = el("td", "num" + (isFixed ? " fert-locked" : ""), FertilizerCalc.round(r.target[k], 2));
    tr.appendChild(cell);
    tr.appendChild(el("td", "num sub", ref ? `${ref.min}〜${ref.max}` : "—"));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const wrap = el("div", "fert-table-wrap");
  wrap.appendChild(table);
  box.appendChild(wrap);

  if (r.feasible) {
    const apply = el("button", "btn-secondary", "この組成を下の逆算に入れる");
    apply.type = "button";
    apply.addEventListener("click", () => {
      TARGET_FIELDS.forEach((k) => {
        state.target[k] = String(FertilizerCalc.round(r.target[k], 2));
      });
      saveState();
      renderTargetInputs();
      toast("目標組成に入れました");
      $("solve").scrollIntoView({ block: "center" });
    });
    box.appendChild(apply);
  }
}

// ---------- コストと規模 ----------

function renderCost() {
  const box = $("cost-result");
  box.innerHTML = "";

  const tanks = state.tanks.map((t) => ({
    name: t.name, tankL: num(t.tankL),
    items: (t.items || []).filter((i) => num(i.kg) > 0),
  }));
  const dilution = num(state.dilution) || 120;
  const cost = FertilizerCalc.recipeCost(tanks, dilution);

  if (cost.rows.length === 0 && cost.unpriced.length === 0) {
    box.appendChild(el("p", "hint", "タンクに肥料を入れると計算します"));
    return;
  }

  // 単価のわかる分の内訳
  const table = el("table", "fert-table");
  const thead = el("thead");
  const hr = el("tr");
  ["肥料", "kg", "円"].forEach((h) => hr.appendChild(el("th", "", h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  cost.rows.forEach((r) => {
    const tr = el("tr");
    tr.appendChild(el("td", "", r.name));
    tr.appendChild(el("td", "num sub", FertilizerCalc.round(r.kg, 2)));
    tr.appendChild(el("td", "num", Math.round(r.yen).toLocaleString()));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const wrap = el("div", "fert-table-wrap");
  wrap.appendChild(table);
  box.appendChild(wrap);

  const sum = el("div", "total-line");
  sum.textContent = `原液1回ぶん ${Math.round(cost.batchTotal).toLocaleString()}円 → 給液 ${Math.round(cost.feedVolumeL).toLocaleString()}L 分 ＝ ${FertilizerCalc.round(cost.yenPer1000L, 1)}円/1000L`;
  box.appendChild(sum);

  if (cost.unpriced.length > 0) {
    box.appendChild(el("div", "fert-warn fert-warn-info",
      `価格が未設定のため合計に入っていません: ${cost.unpriced.map((u) => u.name).join("・")}`));
  }

  // 規模の試算
  const scale = FertilizerCalc.scaleEstimate(cost, dilution, {
    plants: num(state.scale.plants),
    mlPerPlantDay: num(state.scale.ml),
    daysPerYear: num(state.scale.days),
  });
  if (!scale) {
    box.appendChild(el("p", "hint", "株数と1株あたりの給液量を入れると、タンクの持ち日数と年間コストが出ます"));
    return;
  }

  const st = el("div", "fert-scale");
  const add = (label, value) => {
    const row = el("div", "fert-scale-row");
    row.appendChild(el("span", "fert-scale-label", label));
    row.appendChild(el("span", "fert-scale-value", value));
    st.appendChild(row);
  };
  add("1日の給液量", `${Math.round(scale.feedLPerDay).toLocaleString()} L`);
  add("1日に減る原液", `${FertilizerCalc.round(scale.stockLPerDay, 1)} L（タンク1本あたり）`);
  add("このタンクの持ち", `${FertilizerCalc.round(scale.daysPerBatch, 1)} 日`);
  add("肥料代", `${Math.round(scale.yenPerDay).toLocaleString()} 円/日`);
  if (scale.yenPerYear > 0) {
    add("年間の肥料代", `${Math.round(scale.yenPerYear).toLocaleString()} 円`);
  }
  box.appendChild(st);
}

// ---------- 逆算（目標組成 → 配合） ----------

const TARGET_FIELDS = ["K", "Ca", "Mg", "NH4", "NO3", "H2PO4", "SO4"];

// 目標組成のプリセット。単位はすべて mmol/L。
//
// 愛知県の資料は me/L 表記なので換算した。リン酸は3価（PO4³⁻）で書かれている
// と読める：5.0 me/L ÷ 3 = 1.67 mmol/L とすると電荷が 陽23.0 / 陰22.97 でほぼ揃う。
// 1価として5.0 mmol/L にすると陰が26.3となり3.3もずれるので、3価換算が正しい。
const TARGET_PRESETS = {
  dutch: {
    label: "オランダ標準",
    values: { K: 9.5, Ca: 5.4, Mg: 2.4, NH4: 1.2, NO3: 15, H2PO4: 1.5, SO4: 4.4 },
    note: "Nutrient Solutions for Greenhouse Crops (2016) のトマト・不活性培地。公表値のままだと電荷が1.0ずれる",
  },
  aichi: {
    label: "愛知県 改良処方",
    values: { K: 10.5, Ca: 4.0, Mg: 2.0, NH4: 0.5, NO3: 16.8, H2PO4: 1.67, SO4: 2.25 },
    note: "愛知県農総試2015。NH4を1.3→0.5に下げP・Kを上げた版（尻腐れ減・可販果増）。me/L表記を換算",
  },
};

function renderTargetInputs() {
  const wrap = $("target-inputs");
  wrap.innerHTML = "";
  TARGET_FIELDS.forEach((k) => {
    const row = el("div", "fert-water-row");
    row.appendChild(el("label", "num-label", `${k} ${ION_LABEL[k] || ""}`));
    const input = el("input", "num-input");
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "0.1";
    input.placeholder = "0";
    input.value = state.target[k] === undefined ? "" : state.target[k];
    input.addEventListener("focus", () => input.select());
    input.addEventListener("input", () => {
      state.target[k] = input.value;
      saveState();
      renderTargetBalance();
    });
    row.appendChild(input);
    row.appendChild(el("span", "num-unit", "mmol/L"));
    wrap.appendChild(row);
  });
  renderTargetBalance();
}

function targetAsNumbers() {
  const t = {};
  TARGET_FIELDS.forEach((k) => (t[k] = num(state.target[k])));
  return t;
}

function renderTargetBalance() {
  const b = FertilizerCalc.chargeBalance(targetAsNumbers());
  $("target-cation").textContent = FertilizerCalc.round(b.cationMeq, 2);
  $("target-anion").textContent = FertilizerCalc.round(b.anionMeq, 2);
  const note = $("target-balance-note");
  if (b.cationMeq === 0 && b.anionMeq === 0) {
    note.textContent = "";
    note.className = "";
  } else if (b.errorPct > 1) {
    const over = b.diff > 0 ? "陽" : "陰";
    note.textContent = ` ⚠ ${over}が ${FertilizerCalc.round(Math.abs(b.diff), 2)} meq/L 多い`;
    note.className = "fert-inline-warn";
  } else {
    note.textContent = " ✓ 釣り合っています";
    note.className = "fert-inline-ok";
  }
}

let lastSolve = null;

function runSolve() {
  const water = {};
  WATER_FIELDS.forEach((f) => {
    const v = num(state.water[f.key]);
    if (v) water[f.key] = v;
  });
  const sol = FertilizerCalc.solveRecipe(targetAsNumbers(), water);
  lastSolve = sol;

  const box = $("solve-result");
  box.innerHTML = "";

  if (sol.picks.length === 0) {
    box.appendChild(el("p", "hint", "目標が空です。組成を入れてください"));
    return;
  }

  sol.warnings.forEach((w) => {
    box.appendChild(el("div", "fert-warn fert-warn-" + w.level, w.message));
  });

  // タンク容量と希釈倍率は、いま入力されている1本目の値を使う
  const tankL = num(state.tanks[0] && state.tanks[0].tankL) || 100;
  const dilution = num(state.dilution) || 120;

  box.appendChild(el("p", "hint",
    `${tankL}Lタンク・${dilution}倍希釈に換算した量（${sol.note}）`));

  const table = el("table", "fert-table");
  const thead = el("thead");
  const hr = el("tr");
  ["肥料", "mmol/L", "kg"].forEach((h) => hr.appendChild(el("th", "", h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  sol.picks.forEach((p) => {
    const tr = el("tr");
    tr.appendChild(el("td", "", p.name));
    tr.appendChild(el("td", "num sub", FertilizerCalc.round(p.mmol, 2)));
    tr.appendChild(el("td", "num", FertilizerCalc.round(FertilizerCalc.mmolToKg(p.mmol, p.id, tankL, dilution), 2)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const wrap = el("div", "fert-table-wrap");
  wrap.appendChild(table);
  box.appendChild(wrap);

  const apply = el("button", "btn-secondary", "この配合をタンクに入れる");
  apply.type = "button";
  apply.addEventListener("click", () => applySolve(tankL, dilution));
  box.appendChild(apply);
}

// 品目を2本のタンクに振り分けて state に入れる。
// タンク名は既存のものを引き継ぐ（「A液＝カルシウム側」という決まりは無く、
// 研修先はB液がカルシウム側、CFアプリはA液が酸性側で揃っていないため）。
// どちらのタンクがカルシウム側だったかは、いまの中身から推定する
function assignToTanks(items, tankL) {
  const split = FertilizerCalc.splitIntoTwoTanks(items);

  const name0 = (state.tanks[0] && state.tanks[0].name) || "A液";
  const name1 = (state.tanks[1] && state.tanks[1].name) || "B液";

  // 1本目に既にカルシウムが入っていれば、1本目をカルシウム側として保つ
  const firstHasCa = ((state.tanks[0] && state.tanks[0].items) || [])
    .some((it) => FertilizerCalc.fertilizerTankRoles(it.id).indexOf("calcium") >= 0);
  const secondHasCa = ((state.tanks[1] && state.tanks[1].items) || [])
    .some((it) => FertilizerCalc.fertilizerTankRoles(it.id).indexOf("calcium") >= 0);
  const caFirst = firstHasCa || !secondHasCa;

  state.tanks = [
    { name: name0, tankL: tankL, items: caFirst ? split.calciumSide : split.sulfateSide },
    { name: name1, tankL: tankL, items: caFirst ? split.sulfateSide : split.calciumSide },
  ];
  const caName = caFirst ? name0 : name1;
  return caName;
}

// 逆算した配合をタンクに流し込む
function applySolve(tankL, dilution) {
  if (!lastSolve || lastSolve.picks.length === 0) return;
  const items = lastSolve.picks.map((p) => ({
    id: p.id,
    kg: FertilizerCalc.round(FertilizerCalc.mmolToKg(p.mmol, p.id, tankL, dilution), 3),
  }));
  const caName = assignToTanks(items, tankL);
  state.recipeId = "";
  saveState();
  initRender();
  toast(`配合をタンクに入れました（カルシウムは${caName}側）`);
}

// いま手で入れてある肥料を、沈殿しないように2本へ組み直す
function autoSplitTanks() {
  const items = [];
  state.tanks.forEach((t) => (t.items || []).forEach((it) => items.push({ id: it.id, kg: it.kg })));
  if (items.length === 0) { toast("肥料が入っていません"); return; }
  const tankL = num(state.tanks[0] && state.tanks[0].tankL) || 100;
  const caName = assignToTanks(items, tankL);
  saveState();
  initRender();
  toast(`2本に分け直しました（カルシウムは${caName}側）`);
}

// ---------- 処方の呼び出し・保存 ----------

function renderRecipeSelect() {
  const sel = $("recipe-select");
  const list = allFeedRecipes();
  sel.innerHTML = "";
  const blank = el("option", "", list.length ? "（選択しない）" : "（保存された処方はまだありません）");
  blank.value = "";
  sel.appendChild(blank);
  list.forEach((r) => {
    const stage = r["生育ステージ"] ? `（${r["生育ステージ"]}）` : "";
    const o = el("option", "", (r["処方名"] || r["処方ID"]) + stage);
    o.value = r["処方ID"];
    sel.appendChild(o);
  });
  sel.value = state.recipeId || "";
  $("delete-recipe").hidden = !state.recipeId;
}

function renderWaterSelect() {
  const sel = $("water-select");
  const list = allWaters();
  sel.innerHTML = "";
  const blank = el("option", "", "（手入力）");
  blank.value = "";
  sel.appendChild(blank);
  list.forEach((w) => {
    const o = el("option", "", w["原水名"] || w["原水ID"]);
    o.value = w["原水ID"];
    sel.appendChild(o);
  });
  sel.value = state.waterId || "";
}

function applyWater(id) {
  const w = allWaters().find((x) => x["原水ID"] === id);
  if (!w) return;
  WATER_FIELDS.forEach((f) => {
    const v = w[f.key];
    state.water[f.key] = (v === undefined || v === null || v === "") ? "" : String(v);
  });
}

// 明細をタンクごとにまとめ直して state に流し込む
function loadRecipe(id) {
  const r = allFeedRecipes().find((x) => x["処方ID"] === id);
  if (!r) return;

  const items = allFeedRecipeItems()
    .filter((x) => x["処方ID"] === id)
    .sort((a, b) => num(a["表示順"]) - num(b["表示順"]));

  const map = {};
  const order = [];
  items.forEach((it) => {
    const key = it["タンク名"] || "タンク";
    if (!map[key]) {
      map[key] = { name: key, tankL: num(it["タンク容量L"]) || 100, items: [] };
      order.push(key);
    }
    map[key].items.push({ id: it["肥料ID"], kg: num(it["量kg"]) });
  });

  if (order.length > 0) state.tanks = order.map((k) => map[k]);
  state.dilution = num(r["希釈倍率"]) || state.dilution;
  state.ecCoefficient = r["EC係数"] === undefined || r["EC係数"] === "" ? "" : String(r["EC係数"]);
  state.ecMeasured = r["実測EC"] === undefined || r["実測EC"] === "" ? "" : String(r["実測EC"]);
  state.recipeId = id;
  state.recipeName = r["処方名"] || "";
  state.recipeStage = r["生育ステージ"] || "";
  state.waterId = r["原水ID"] || "";
  if (state.waterId) applyWater(state.waterId);

  saveState();
  initRender();
  toast(`「${state.recipeName}」を読み込みました`);
}

function collectRecipeItems() {
  const items = [];
  state.tanks.forEach((t) => {
    (t.items || []).forEach((it) => {
      if (num(it.kg) <= 0) return;
      const chem = FERTILIZER_CHEM[it.id] || FERTILIZER_PRODUCTS[it.id];
      items.push({
        tank: t.name, tankL: t.tankL,
        id: it.id, name: chem ? chem.name : it.id, kg: it.kg,
      });
    });
  });
  return items;
}

// お試しモードの保存先。IDは L01, L02… （サーバー側は V01…）
function saveRecipeLocal(payload) {
  const list = readLocal(FERT_LOCAL_RECIPE_KEY);
  const items = readLocal(FERT_LOCAL_ITEM_KEY);
  let id = payload.recipeId;
  if (!id) {
    let max = 0;
    list.forEach((r) => {
      const m = String(r["処方ID"]).match(/^L(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    });
    id = "L" + ("0" + (max + 1)).slice(-2);
  }
  const rec = {
    "処方ID": id, "処方名": payload.name, "生育ステージ": payload.stage,
    "希釈倍率": payload.dilution, "原水ID": payload.waterId,
    "EC係数": payload.ecCoefficient, "実測EC": payload.ecMeasured, "実測日": payload.ecMeasuredAt,
    "備考": "", "有効フラグ": "TRUE", "更新日時": nowTimestamp(),
  };
  const idx = list.findIndex((r) => r["処方ID"] === id);
  if (idx >= 0) list[idx] = rec; else list.push(rec);

  const rest = items.filter((it) => it["処方ID"] !== id);
  payload.items.forEach((it, i) => {
    rest.push({
      "処方ID": id, "表示順": i + 1, "タンク名": it.tank, "タンク容量L": it.tankL,
      "肥料ID": it.id, "肥料名": it.name, "量kg": it.kg,
    });
  });
  writeLocal(FERT_LOCAL_RECIPE_KEY, list);
  writeLocal(FERT_LOCAL_ITEM_KEY, rest);
  return { ok: true, id: id };
}

function deleteRecipeLocal(id) {
  const list = readLocal(FERT_LOCAL_RECIPE_KEY).filter((r) => r["処方ID"] !== id);
  const items = readLocal(FERT_LOCAL_ITEM_KEY).filter((it) => it["処方ID"] !== id);
  writeLocal(FERT_LOCAL_RECIPE_KEY, list);
  writeLocal(FERT_LOCAL_ITEM_KEY, items);
  return { ok: true };
}

async function saveRecipe(asNew) {
  const name = $("recipe-name").value.trim();
  if (!name) { toast("処方名を入れてください"); return; }
  const items = collectRecipeItems();
  if (items.length === 0) { toast("肥料が1件も入っていません"); return; }

  const payload = {
    type: "feedRecipe",
    recipeId: asNew ? "" : (state.recipeId || ""),
    name: name,
    stage: $("recipe-stage").value,
    dilution: state.dilution,
    waterId: state.waterId || "",
    ecCoefficient: state.ecCoefficient || "",
    ecMeasured: state.ecMeasured || "",
    ecMeasuredAt: num(state.ecMeasured) > 0 ? formatToday() : "",
    items: items,
  };

  // お試しモードでは共通の mockPost に落ちない（未知のtypeは作業記録扱いになってしまう）
  const res = isMock ? saveRecipeLocal(payload) : await apiPost(payload);
  if (res && res.ok) {
    state.recipeId = res.id || state.recipeId;
    state.recipeName = name;
    state.recipeStage = payload.stage;
    saveState();
    if (!isMock) {
      // 保存した内容をマスタキャッシュに載せ直す
      const fresh = await apiGet("masters");
      if (fresh && fresh.ok) { masters = fresh; saveMastersCache(fresh); }
    }
    renderRecipeSelect();
    toast(`処方「${name}」を保存しました`);
  } else {
    toast("⚠ " + ((res && res.error) || "保存できませんでした"));
  }
}

async function deleteRecipe() {
  const id = state.recipeId;
  if (!id) return;
  const res = isMock ? deleteRecipeLocal(id) : await apiPost({ type: "deleteFeedRecipe", recipeId: id });
  if (res && res.ok) {
    state.recipeId = "";
    state.recipeName = "";
    saveState();
    if (!isMock) {
      const fresh = await apiGet("masters");
      if (fresh && fresh.ok) { masters = fresh; saveMastersCache(fresh); }
    }
    renderRecipeSelect();
    toast("処方を削除しました");
  } else {
    toast("⚠ " + ((res && res.error) || "削除できませんでした"));
  }
}

// ---------- 起動 ----------
function bindInputs() {
  const dil = $("dilution");
  dil.value = state.dilution;
  dil.addEventListener("focus", () => dil.select());
  dil.addEventListener("input", () => {
    state.dilution = num(dil.value);
    saveState();
    recalc();
  });

  $("auto-split").addEventListener("click", autoSplitTanks);

  $("add-tank").addEventListener("click", () => {
    state.tanks.push({ name: "タンク" + (state.tanks.length + 1), tankL: 100, items: [] });
    saveState();
    renderTanks();
    recalc();
  });

  const acidSel = $("acid-anion");
  acidSel.value = state.acid.anion || "";
  acidSel.addEventListener("change", () => {
    state.acid.anion = acidSel.value;
    saveState();
    recalc();
  });

  const acidMeq = $("acid-meq");
  acidMeq.value = state.acid.meqPerL;
  acidMeq.addEventListener("input", () => {
    state.acid.meqPerL = acidMeq.value;
    saveState();
    recalc();
  });

  const ecm = $("ec-measured");
  ecm.value = state.ecMeasured;
  ecm.addEventListener("input", () => {
    state.ecMeasured = ecm.value;
    saveState();
    recalc();
  });

  const meqToggle = $("show-meq");
  meqToggle.checked = !!state.showMeq;
  meqToggle.addEventListener("change", () => {
    state.showMeq = meqToggle.checked;
    saveState();
    recalc();
  });

  const ecc = $("ec-coef");
  ecc.value = state.ecCoefficient;
  ecc.addEventListener("input", () => {
    state.ecCoefficient = ecc.value;
    saveState();
    recalc();
  });

  $("apply-coef").addEventListener("click", () => {
    if (!lastResult || !(lastResult.ecCoefficientDerived > 0)) return;
    const v = FertilizerCalc.round(lastResult.ecCoefficientDerived, 4);
    state.ecCoefficient = String(v);
    $("ec-coef").value = v;
    saveState();
    recalc();
    toast(`係数を ${v} に補正しました`);
  });

  $("copy-result").addEventListener("click", () => {
    const text = resultToText();
    if (!text) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => toast("計算結果をコピーしました"),
        () => toast("コピーできませんでした")
      );
    } else {
      toast("この端末ではコピーできません");
    }
  });

  $("reset-all").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.arm !== "1") {
      btn.dataset.arm = "1";
      btn.textContent = "本当にリセット？";
      setTimeout(() => { btn.dataset.arm = ""; btn.textContent = "入力をリセット"; }, 3000);
      return;
    }
    state = defaultState();
    saveState();
    initRender();
    toast("入力をリセットしました");
  });

  // --- 処方 ---
  $("recipe-select").addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) {
      state.recipeId = "";
      saveState();
      $("delete-recipe").hidden = true;
      return;
    }
    loadRecipe(id);
  });

  const rname = $("recipe-name");
  rname.addEventListener("input", () => {
    state.recipeName = rname.value;
    saveState();
  });

  const rstage = $("recipe-stage");
  rstage.addEventListener("change", () => {
    state.recipeStage = rstage.value;
    saveState();
  });

  $("save-recipe").addEventListener("click", () => saveRecipe(false));
  $("new-recipe").addEventListener("click", () => saveRecipe(true));

  $("delete-recipe").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.arm !== "1") {
      btn.dataset.arm = "1";
      btn.textContent = "本当に削除？";
      setTimeout(() => { btn.dataset.arm = ""; btn.textContent = "この処方を削除"; }, 3000);
      return;
    }
    btn.dataset.arm = "";
    btn.textContent = "この処方を削除";
    deleteRecipe();
  });

  // --- 逆算 ---
  $("target-preset").addEventListener("change", (e) => {
    const key = e.target.value;
    if (!key) return;
    if (key === "current") {
      // いまの計算結果をそのまま目標に写す
      if (lastResult) {
        TARGET_FIELDS.forEach((k) => {
          state.target[k] = String(FertilizerCalc.round(lastResult.ions[k], 2));
        });
        toast("いまの組成を目標に写しました");
      }
    } else {
      const p = TARGET_PRESETS[key];
      if (!p) return;
      TARGET_FIELDS.forEach((k) => {
        state.target[k] = p.values[k] === undefined ? "" : String(p.values[k]);
      });
      toast(p.label + " を読み込みました");
    }
    e.target.value = "";
    saveState();
    renderTargetInputs();
  });

  $("solve").addEventListener("click", runSolve);
  $("build-target").addEventListener("click", runBuildTarget);

  // --- 規模の入力 ---
  [["scale-plants", "plants"], ["scale-ml", "ml"], ["scale-days", "days"]].forEach((pair) => {
    const elm = $(pair[0]);
    elm.value = state.scale[pair[1]];
    elm.addEventListener("focus", () => elm.select());
    elm.addEventListener("input", () => {
      state.scale[pair[1]] = elm.value;
      saveState();
      renderCost();
    });
  });

  // --- 原水 ---
  $("water-select").addEventListener("change", (e) => {
    state.waterId = e.target.value;
    if (state.waterId) applyWater(state.waterId);
    saveState();
    renderWater();
    recalc();
  });
}

function initRender() {
  $("dilution").value = state.dilution;
  $("acid-anion").value = state.acid.anion || "";
  $("acid-meq").value = state.acid.meqPerL;
  $("ec-measured").value = state.ecMeasured;
  $("ec-coef").value = state.ecCoefficient;
  $("recipe-name").value = state.recipeName || "";
  $("recipe-stage").value = state.recipeStage || "";
  renderRecipeSelect();
  renderWaterSelect();
  renderTanks();
  renderWater();
  renderTargetInputs();
  renderLockInputs();
  $("scale-plants").value = state.scale.plants;
  $("scale-ml").value = state.scale.ml;
  $("scale-days").value = state.scale.days;
  recalc();
}

window.addEventListener("DOMContentLoaded", () => {
  const d = $("date-display");
  if (d) d.textContent = formatToday();
  const u = $("user-info");
  if (u) u.textContent = getProfile().displayName;
  loadState();
  bindInputs();
  initRender();

  // マスタは遅い（実測8〜11秒）ので画面を描いてから取りに行く。
  // キャッシュがあれば loadMasters がすぐ返す
  loadMasters((fresh) => {
    masters = fresh;
    renderRecipeSelect();
    renderWaterSelect();
  }).then((m) => {
    masters = m;
    renderRecipeSelect();
    renderWaterSelect();
  });
});
