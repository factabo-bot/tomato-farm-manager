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

// 画面のモード。用途もタイミングも違う機能を1画面に積むと、
// 毎日使うものが下に埋もれる。空文字＝まだ選んでいない（モード選択画面を出す）。
// 保存済みの状態に mode が無くても loadState の Object.assign で "" になるので、
// 更新後の初回は自然にモード選択から始まる
const FERT_MODES = {
  daily: "日々の記録と評価",
  design: "処方をつくる",
  cost: "コストを見る",
};

function defaultState() {
  const water = {};
  WATER_FIELDS.forEach((f) => (water[f.key] = ""));
  return {
    mode: "",
    dilution: 120,
    // 目標ECから希釈倍率を逆算するための入力
    targetEc: "",
    tanks: [
      { name: "A液", tankL: 100, items: [] },
      { name: "B液", tankL: 100, items: [] },
    ],
    water: water,
    acid: { anion: "", meqPerL: "", residual: "1.0" },
    // 実測からの評価。目標値も持つ（自分の圃場に合わせて動かすため）
    evaluate: {
      date: "", feedL: "", drainL: "", feedEc: "", drainEc: "",
      feedPh: "", drainPh: "", note: "",
      drainMin: "25", drainMax: "35", nMin: "100", nMax: "150", drainEcMax: "5.0",
    },
    feedLogAll: false,
    // 処方モードの折りたたみグループの開閉。毎回たたみ直す手間をなくす
    groups: {},
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
    // 規模の試算。ピークは設備の設計に、平均は費用の見積もりに使う
    scale: { plants: "", peak: "", avg: "", days: "" },
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

// ---------- モードの出し分け ----------
// history.js の switchTab を属性駆動に一般化したもの。
// 違いは「切り替えで再計算しない」こと。
//
// ⚠️ applyMode は hidden 以外を触ってはいけない。recalc をモードで分岐させると、
//    コスト（②①に依存）と実測評価（lastResult.ions に依存）が壊れる。
//    全部計算して表示だけ出し分ける、を規律として守る。
function applyMode() {
  const m = state.mode;
  const chosen = Object.prototype.hasOwnProperty.call(FERT_MODES, m);
  $("mode-menu").hidden = chosen;
  $("mode-bar").hidden = !chosen;
  $("mode-title").textContent = chosen ? FERT_MODES[m] : "";
  document.querySelectorAll("main [data-mode]").forEach((sec) => {
    sec.hidden = !chosen || sec.dataset.mode.split(" ").indexOf(m) < 0;
  });
  window.scrollTo(0, 0);
}

function switchMode(mode) {
  state.mode = mode;
  saveState();
  applyMode();
  // 処方サマリーの案内文はモードによって変わる（design では「処方をつくるへ」を出さない）。
  // applyMode は hidden しか触らず、recalc も走らないので、ここで描き直す
  renderRecipeSummary();
  // 表示の出し分けは applyMode の仕事。データの取り込みはこちらで分ける
  if (mode === "daily") pullFeedLogs();
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
  renderEvaluate();
  renderRecipeSummary();
  renderDilutionSolve();

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

// 中和に必要な酸の量と、その酸が持ち込むイオンを出す。
// 「pHを直すために入れたものが、組成を動かす」ことを見えるようにするのが目的
function renderAcidResult(req) {
  const box = $("acid-result");
  if (!box) return;
  box.innerHTML = "";
  if (!req) return;
  const R = FertilizerCalc.round;
  const label = ACID_ANION_LABEL[req.anion] || req.anion;

  box.appendChild(el("p", "hint",
    "中和量 " + R(req.meqPerL, 2) + " meq/L（原水のアルカリ度 " + R(req.fullNeutralizationMeq, 2)
    + " のうち " + R(req.residualMeq, 2) + " を残す）"));
  box.appendChild(el("p", "fert-acid-gain",
    label + " が " + R(req.anionMmolPerL, 2) + " mmol/L 増えます"));
  if (req.gPer1000L !== null) {
    box.appendChild(el("p", "hint",
      "給液1000Lあたり " + R(req.gPer1000L, 1) + " g（市販濃度のままの実重量）"));
  }
  if (req.anion === "SO4") {
    box.appendChild(el("p", "hint warn",
      "⚠️ 硫酸は2価。H⁺ 1 meq あたり SO4 は 0.5 mmol です。Caと同じタンクに入れると石膏が沈殿します"));
  }
  box.appendChild(el("p", "hint",
    "増えた分は処方から差し引いてください。差し引かないと" + label + "が狙いより多くなります"));
}

// 目標ECから必要な希釈倍率を出す。
// 生育ステージでECを変えるとき、原液を作り直すのではなく倍率を変えるのが実務
function renderDilutionSolve() {
  const box = $("dilution-result");
  if (!box) return;
  box.innerHTML = "";
  const target = num(state.targetEc);
  if (!(target > 0)) return;
  const R = FertilizerCalc.round;
  const r = lastResult ? FertilizerCalc.dilutionForTargetEc(lastResult, target) : null;
  if (!r) {
    box.appendChild(el("p", "hint", "先に③のタンクへ肥料を入れてください"));
    return;
  }
  if (!r.dilution) {
    box.appendChild(el("p", "hint warn", "⚠️ " + r.reason));
    return;
  }
  const d = R(r.dilution, 0);
  box.appendChild(el("p", "fert-context-line",
    "EC " + target + " にするには " + d + " 倍"
    + "（いま " + R(r.current, 0) + "倍で EC " + R(r.currentEc, 2) + "）"));

  // 混入機には可動範囲がある。外れていたら倍率ではなく配合を変える話になる
  if (r.dilution < 50 || r.dilution > 500) {
    box.appendChild(el("p", "hint warn",
      "⚠️ 液肥混入機の可動範囲を外れています（ドサトロン DR06GL は 1:500〜1:50＝50〜500倍）。"
      + "この場合は倍率ではなく原液の配合そのものを変えることになります"));
  }
  if (r.waterCationMeq > 0) {
    box.appendChild(el("p", "hint",
      "原水の陽イオン " + R(r.waterCationMeq, 2) + " meq/L は薄まらないので、"
      + "ECは倍率の単純な反比例にはなりません。それを織り込んだ値です"));
  }
  const btn = el("button", "btn-secondary", "この倍率にする");
  btn.type = "button";
  btn.addEventListener("click", () => {
    state.dilution = d;
    saveState();
    $("dilution").value = d;
    recalc();
    toast("希釈倍率を " + d + " 倍にしました");
  });
  box.appendChild(btn);
}

// 3モード共通の1行サマリー。
// コストも実測評価も処方（配合・希釈倍率・原水）の計算結果に依存しているので、
// どのモードにいても「いまどの処方の話をしているか」が見えている必要がある。
// 表示する値はすべて計算済みのものを引くだけで、新規計算はしない
function renderRecipeSummary() {
  const box = $("recipe-summary");
  if (!box) return;
  box.innerHTML = "";
  const R = FertilizerCalc.round;

  if (collectRecipeItems().length === 0) {
    // design モードは処方を組んでいる最中の画面。
    // そこで「処方をつくるへ」と案内するのは、いま居る場所を指して行けと言うのと同じ
    if (state.mode === "design") {
      box.appendChild(el("p", "hint", "下の原液タンクに肥料を入れると、ここに組成の要約が出ます"));
      return;
    }
    box.appendChild(el("p", "hint warn",
      state.mode === "daily"
        ? "⚠️ 処方が空です。窒素施用量は出ませんが、排液率と排液ECの判定は動きます"
        : "⚠️ 処方が空です。肥料を入れないとコストは計算できません"));
    const btn = el("button", "btn-secondary", "処方をつくるへ");
    btn.type = "button";
    btn.addEventListener("click", () => switchMode("design"));
    box.appendChild(btn);
    return;
  }

  const parts = [];
  if (state.recipeName) parts.push(state.recipeName);
  parts.push(num(state.dilution) + "倍");
  if (lastResult) {
    parts.push("EC " + R(lastResult.ecEstimate, 2));
    const n = FertilizerCalc.nitrogenMgPerL(lastResult.ions);
    if (n > 0) parts.push("N " + R(n, 0) + " mg/L");
  }
  box.appendChild(el("p", "fert-context-line", parts.join(" / ")));
}

// 実測から評価する。
// 借りてきたEC値をなぞるのではなく、自分の圃場の数字で次の一手を決めるための画面。
// 窒素濃度はいまの処方から取るので、①〜④の入力とつながっている
function renderEvaluate() {
  const box = $("ev-result");
  if (!box) return;
  box.innerHTML = "";
  const ev = state.evaluate || {};
  const R = FertilizerCalc.round;
  const feedL = num(ev.feedL);

  if (!(feedL > 0)) {
    box.appendChild(el("p", "hint", "給液量を入れると計算します。排液量・排液ECも入れると判定が増えます"));
    return;
  }

  const nPerL = lastResult ? FertilizerCalc.nitrogenMgPerL(lastResult.ions) : 0;
  const rec = {
    feedLPerPlant: feedL,
    drainLPerPlant: num(ev.drainL),
    // 給液ECの実測が無ければ、処方からの推定値で代用する
    feedEc: num(ev.feedEc) || (lastResult ? lastResult.ecEstimate : 0),
    drainEc: num(ev.drainEc),
    nitrogenMgPerL: nPerL,
  };
  const e = FertilizerCalc.evaluateFeed(rec);
  const adv = FertilizerCalc.feedAdvice(rec, e, {
    drainPctMin: num(ev.drainMin), drainPctMax: num(ev.drainMax),
    nitrogenMin: num(ev.nMin), nitrogenMax: num(ev.nMax),
    drainEcMax: num(ev.drainEcMax),
  });

  const cell = function (label, value, unit) {
    const d = el("div", "fert-ev-cell");
    d.appendChild(el("div", "fert-ev-label", label));
    const v = el("div", "fert-ev-value", value === null || value === undefined ? "—" : String(value));
    if (unit) v.appendChild(el("span", "fert-ev-unit", unit));
    d.appendChild(v);
    return d;
  };
  const grid = el("div", "fert-ev-grid");
  grid.appendChild(cell("排液率", e.drainPct === null ? null : R(e.drainPct, 1), "%"));
  grid.appendChild(cell("吸水量", e.uptakeLPerPlant === null ? null : R(e.uptakeLPerPlant, 2), "L/株/日"));
  grid.appendChild(cell("養分吸収率", e.uptakeRatio === null ? null : R(e.uptakeRatio * 100, 1), "%"));
  grid.appendChild(cell("窒素施用量", e.nitrogenMgPerPlant === null ? null : R(e.nitrogenMgPerPlant, 0), "mg/株/日"));
  box.appendChild(grid);

  if (e.drainRatio !== null && e.drainRatio !== undefined) {
    box.appendChild(el("p", "hint",
      "排液EC は給液EC の " + R(e.drainRatio, 2) + " 倍"
      + (e.drainRatio <= 1 ? "（下回っている＝樹が吸えている）" : "（上回っている＝養分が余っている）")));
  }
  if (nPerL > 0) {
    box.appendChild(el("p", "hint", "窒素濃度 " + R(nPerL, 1) + " mg/L（いまの処方から算出）"));
  } else {
    box.appendChild(el("p", "hint warn", "②タンクに肥料を入れると、窒素施用量も判定されます"));
  }
  if (!num(ev.feedEc) && lastResult) {
    box.appendChild(el("p", "hint", "給液ECの実測が空欄なので、処方からの推定値 " + R(lastResult.ecEstimate, 2) + " を使っています"));
  }

  adv.forEach(function (a) {
    const d = el("div", "fert-advice fert-advice-" + a.level);
    d.appendChild(el("div", "fert-advice-topic", a.topic));
    d.appendChild(el("div", "fert-advice-msg", a.message));
    d.appendChild(el("div", "fert-advice-action", "→ " + a.action));
    box.appendChild(d);
  });

  box.appendChild(el("p", "hint",
    "この数字を毎日記録すると、自分の圃場の給液量カーブと吸収率が見えてきます。他所の試験値はそれまでの仮置きです"));
}

// ---------- 日々の記録 ----------
// 保存先はこの端末。GAS接続時も、まずここに書いてから裏で送る
// （通信を待たずに一覧へ出すため。growth.js と同じ考え方）。
// ⚠️ 共通の記録ストア（work/spray/growth）には載せない。あちらに4種目を足すと
//    pullRecords / storePrune / recordDate まで波及する
const FERT_LOG_KEY = "tfm_feed_logs";

function feedToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function feedLogs() {
  const list = readLocal(FERT_LOG_KEY);
  return Array.isArray(list) ? list : [];
}

// いまの入力と計算結果から1行分を組み立てる。
// 判断基準は「半年後にこの行だけ見て、当時の判定を再現できるか」。
// ⚠️ 処方は上書き保存されうるので、処方IDへの参照だけでは再現できない。
//    窒素濃度・希釈倍率・EC推定をスナップショットとして持たせる。
// ⚠️ 給液ECは未入力だと推定値で代用しているので、実測かどうかのフラグを残す。
//    これが無いと、あとで推移を見たときに実測と推定が混ざる
function buildFeedLog() {
  const ev = state.evaluate;
  const R = FertilizerCalc.round;
  const nPerL = lastResult ? FertilizerCalc.nitrogenMgPerL(lastResult.ions) : 0;
  const feedEcInput = num(ev.feedEc);
  const rec = {
    feedLPerPlant: num(ev.feedL),
    drainLPerPlant: num(ev.drainL),
    feedEc: feedEcInput || (lastResult ? lastResult.ecEstimate : 0),
    drainEc: num(ev.drainEc),
    nitrogenMgPerL: nPerL,
  };
  const e = FertilizerCalc.evaluateFeed(rec);
  const or = (v, d) => (v === null || v === undefined ? "" : R(v, d));
  return {
    "記録ID": "",
    "給液日": ev.date || feedToday(),
    "記録日時": new Date().toISOString(),
    "clientId": newClientId(),
    "状態": isMock ? "お試し" : "未同期",
    "給液量": rec.feedLPerPlant,
    "排液量": rec.drainLPerPlant,
    "給液EC": R(rec.feedEc, 2),
    "排液EC": rec.drainEc,
    "給液pH": num(ev.feedPh) || "",
    "排液pH": num(ev.drainPh) || "",
    "排液率": or(e.drainPct, 1),
    "吸水量": or(e.uptakeLPerPlant, 3),
    "養分吸収率": e.uptakeRatio === null ? "" : R(e.uptakeRatio * 100, 1),
    "窒素施用量": or(e.nitrogenMgPerPlant, 0),
    "処方ID": state.recipeId || "",
    "処方名": state.recipeName || "",
    "希釈倍率": num(state.dilution),
    "窒素濃度": R(nPerL, 1),
    "EC推定": lastResult ? R(lastResult.ecEstimate, 2) : "",
    "給液EC実測": feedEcInput > 0 ? "TRUE" : "FALSE",
    "判定目標": "排液" + num(ev.drainMin) + "-" + num(ev.drainMax)
      + "/N" + num(ev.nMin) + "-" + num(ev.nMax)
      + "/排液EC≦" + num(ev.drainEcMax),
    "メモ": ev.note || "",
  };
}

function resetSaveButton() {
  const btn = $("ev-save");
  if (!btn) return;
  btn.dataset.arm = "";
  btn.textContent = "この内容で記録する";
}

function saveFeedLog() {
  const ev = state.evaluate;
  if (!(num(ev.feedL) > 0)) {
    toast("給液量を入れてください");
    return false;
  }
  const row = buildFeedLog();
  const list = feedLogs();
  // 給液日は1日1行。同じ日があれば置き換える
  let replaced = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i]["給液日"] === row["給液日"]) { list.splice(i, 1, row); replaced = true; break; }
  }
  if (!replaced) list.push(row);
  list.sort((a, b) => (String(a["給液日"]) < String(b["給液日"]) ? 1 : -1));
  writeLocal(FERT_LOG_KEY, list);
  toast(replaced ? "✅ " + row["給液日"] + " の記録を上書きしました" : "✅ 記録しました");
  renderFeedLogList();
  sendFeedLog(row);
  return true;
}

// 手元に書いたあとで裏から送る。通れば記録IDを書き戻し、
// 送れなければキューに残る（どちらでも手元の記録は消えない）。
//
// ⚠️ お試しモードでは送らない。apiPostWithQueue は isMock のとき mockPost に落ち、
//    mockPost は未知の type を「作業記録」として保存してしまう（common.js）。
//    saveRecipe が同じ理由で isMock を分岐しているので、それに倣う
async function sendFeedLog(row) {
  if (isMock) return;
  const prof = (typeof getProfile === "function" ? getProfile() : {}) || {};
  const payload = {
    type: "feedLog",
    clientId: row["clientId"],
    feedDate: row["給液日"],
    feedL: row["給液量"],
    drainL: row["排液量"],
    feedEc: row["給液EC"],
    drainEc: row["排液EC"],
    feedPh: row["給液pH"],
    drainPh: row["排液pH"],
    drainPct: row["排液率"],
    uptakeL: row["吸水量"],
    uptakeRatio: row["養分吸収率"],
    nitrogenPerPlant: row["窒素施用量"],
    recipeId: row["処方ID"],
    recipeName: row["処方名"],
    dilution: row["希釈倍率"],
    nitrogenMgPerL: row["窒素濃度"],
    ecEstimate: row["EC推定"],
    feedEcMeasured: row["給液EC実測"] === "TRUE",
    targetNote: row["判定目標"],
    note: row["メモ"],
    recorder: prof.displayName || "",
    userId: prof.userId || "",
  };
  try {
    const res = await apiPostWithQueue(payload);
    const list = feedLogs();
    for (let i = 0; i < list.length; i++) {
      if (list[i]["clientId"] !== row["clientId"]) continue;
      if (res && res.ok && res.id) { list[i]["記録ID"] = res.id; list[i]["状態"] = "完了"; }
      else if (res && res.queued) { list[i]["状態"] = "送信待ち"; }
      writeLocal(FERT_LOG_KEY, list);
      renderFeedLogList();
      break;
    }
  } catch (err) {
    console.warn("給液記録を送れませんでした", err);
  }
}

// サーバーの記録を手元に取り込む。端末を替えても記録が見えるようにするため。
// マージの作法は pullRecords（common.js）に倣い、
// 「サーバー分で置き換え、まだ送れていない手元の行だけ足し戻す」。
// 手元にしか無い行を消さないことと、同じ給液日が二重に並ばないことの両立が目的
async function pullFeedLogs() {
  if (isMock) return;
  const to = feedToday();
  const d = new Date();
  d.setDate(d.getDate() - 60);
  const p = (n) => String(n).padStart(2, "0");
  const from = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());

  const res = await apiGet("feedLogs", { from: from, to: to });
  if (!res || !res.ok || !Array.isArray(res.logs)) return;

  const local = feedLogs();
  // 記録IDが無い＝まだサーバーに載っていない行
  const pending = local.filter((r) => !r["記録ID"]);
  const seen = {};
  const merged = [];
  res.logs.concat(pending).forEach((r) => {
    const key = String(r["給液日"] || "");
    if (!key || seen[key]) return;   // 同じ給液日はサーバー側を優先（1日1行）
    seen[key] = true;
    merged.push(r);
  });
  // 期間外の手元の行（60日より前）は残す
  local.forEach((r) => {
    const key = String(r["給液日"] || "");
    if (!key || seen[key]) return;
    if (key >= from && key <= to) return;   // 期間内なのに無い＝サーバーで取消された
    seen[key] = true;
    merged.push(r);
  });
  merged.sort((a, b) => (String(a["給液日"]) < String(b["給液日"]) ? 1 : -1));
  writeLocal(FERT_LOG_KEY, merged);
  renderFeedLogList();
}

// 一覧。グラフは作らず、平均1行＋表で推移を読ませる
function renderFeedLogList() {
  const box = $("feed-log-list");
  const sumBox = $("feed-log-summary");
  const moreBtn = $("feed-log-more");
  if (!box || !sumBox) return;
  box.innerHTML = "";
  sumBox.innerHTML = "";
  const list = feedLogs();
  if (moreBtn) moreBtn.hidden = list.length <= 14;

  if (list.length === 0) {
    box.appendChild(el("p", "hint",
      "まだ記録がありません。上の欄を埋めて「この内容で記録する」を押すと、ここに溜まっていきます"));
    return;
  }
  const R = FertilizerCalc.round;

  // 直近7件の平均。日々の上下ではなく傾向を読むための行
  const recent = list.slice(0, 7);
  const avg = (key) => {
    const vals = recent.map((r) => Number(r[key])).filter((v) => isFinite(v) && v !== 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const parts = [];
  const ad = avg("排液率"); if (ad !== null) parts.push("排液率 " + R(ad, 0) + "%");
  const ae = avg("排液EC"); if (ae !== null) parts.push("排液EC " + R(ae, 2));
  const an = avg("窒素施用量"); if (an !== null) parts.push("窒素 " + R(an, 0) + " mg/株/日");
  if (parts.length) {
    sumBox.appendChild(el("p", "fert-context-line",
      "直近" + recent.length + "件の平均： " + parts.join(" / ")));
  }

  const limit = state.feedLogAll ? 60 : 14;
  const rows = list.slice(0, limit);
  const table = el("table", "fert-table");
  const thead = el("thead");
  const hr = el("tr");
  ["日付", "排液率", "給液EC", "排液EC", "N"].forEach((h) => hr.appendChild(el("th", "", h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  rows.forEach((r, i) => {
    const tr = el("tr");
    // 給液ECが推定だった行は薄字にして、実測と混ぜて読まないようにする
    if (r["給液EC実測"] === "FALSE") tr.className = "fert-row-sub";
    tr.appendChild(el("td", "", String(r["給液日"]).slice(5)));
    // 1つ古い行と比べて矢印を付ける（既存のイオン表と同じクラスを使う）
    const prev = rows[i + 1];
    const cell = (key, digits, unit) => {
      const v = Number(r[key]);
      const td = el("td", "num", isFinite(v) && r[key] !== "" ? R(v, digits) + (unit || "") : "—");
      if (prev && r[key] !== "" && prev[key] !== "") {
        const p = Number(prev[key]);
        if (isFinite(p) && isFinite(v)) {
          if (v > p) { td.className = "num fert-above"; td.textContent += " ↑"; }
          else if (v < p) { td.className = "num fert-below"; td.textContent += " ↓"; }
        }
      }
      return td;
    };
    tr.appendChild(cell("排液率", 0, "%"));
    tr.appendChild(cell("給液EC", 2, ""));
    tr.appendChild(cell("排液EC", 2, ""));
    tr.appendChild(cell("窒素施用量", 0, ""));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const wrap = el("div", "fert-table-wrap");
  wrap.appendChild(table);
  box.appendChild(wrap);
  box.appendChild(el("p", "hint",
    "薄い行は給液ECが実測ではなく処方からの推定値。N は窒素施用量 mg/株/日。↑↓ は1つ前の記録との比較"));
  if (list.length > rows.length) {
    box.appendChild(el("p", "hint", "全 " + list.length + " 件中 " + rows.length + " 件を表示"));
  }
}

// 根拠にした月別の実測値を、いつでも見えるところに出しておく
function renderScaleRef() {
  const box = $("scale-ref");
  if (!box) return;
  box.innerHTML = "";

  const table = el("table", "fert-table");
  const thead = el("thead");
  const hr = el("tr");
  ["月", "給液量", "EC", "ステージ"].forEach((h) => hr.appendChild(el("th", "", h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  FEED_VOLUME_FORCING.forEach((m) => {
    const tr = el("tr");
    tr.appendChild(el("td", "", m.month + "月"));
    tr.appendChild(el("td", "num", m.feedMl));
    tr.appendChild(el("td", "num sub", m.ec.toFixed(1)));
    tr.appendChild(el("td", "sub", m.stage));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const wrap = el("div", "fert-table-wrap");
  wrap.appendChild(table);
  box.appendChild(wrap);
  box.appendChild(el("p", "hint",
    "単位 mL/日/株。伊藤ら(2022) 愛知農総試研報54号の低濃度区。大玉りんか409・ヤシガラ・3.0株/m²・CO2施用あり・促成長期（9/3定植〜6/28収穫終了）"));
  box.appendChild(el("p", "hint",
    "論文が直接書くのは「給液量0.5〜1.2 L/株」の範囲だけ。月別の値は窒素施用量(表3)を培養液のNO3-N濃度で割った逆算値で、実測表ではない"));
  box.appendChild(el("p", "hint warn",
    "⚠️ 大玉の値。中玉・ミニでは変わる。株あたりなので栽植密度が違う計画に移すときはm²あたりに直すこと（この試験は3.0株/m²＝1.1〜3.6 L/m²/日）"));
  box.appendChild(el("p", "hint",
    "参考：夏秋作ミニトマトなら8月に2,500 mL/株/日まで要る（研報53号）。作型が違うので越冬長期どりには使わない"));
}

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
    peakMlPerPlantDay: num(state.scale.peak),
    avgMlPerPlantDay: num(state.scale.avg),
    daysPerYear: num(state.scale.days),
  });
  if (!scale) {
    box.appendChild(el("p", "hint", "株数とピーク時の給液量を入れると、タンクの持ち日数が出ます"));
    return;
  }

  const st = el("div", "fert-scale");
  const add = (label, value, cls) => {
    const row = el("div", "fert-scale-row" + (cls ? " " + cls : ""));
    row.appendChild(el("span", "fert-scale-label", label));
    row.appendChild(el("span", "fert-scale-value", value));
    st.appendChild(row);
  };

  add("── 設備の設計（ピーク時）", "", "fert-scale-head");
  add("給液量", `${Math.round(scale.peakFeedLPerDay).toLocaleString()} L/日`);
  add("原液の減り", `${FertilizerCalc.round(scale.peakStockLPerDay, 1)} L/日（タンク1本）`);
  add("このタンクの持ち", `${FertilizerCalc.round(scale.daysPerBatch, 1)} 日`);

  if (scale.avgFeedLPerDay !== null) {
    add("── 費用の見積もり（年間平均）", "", "fert-scale-head");
    add("給液量", `${Math.round(scale.avgFeedLPerDay).toLocaleString()} L/日`);
    add("肥料代", `${Math.round(scale.avgYenPerDay).toLocaleString()} 円/日`);
    if (scale.yenPerYear !== null) {
      add("年間の肥料代", `${Math.round(scale.yenPerYear).toLocaleString()} 円`);
      add("年間の給液量", `${Math.round(scale.feedLPerYear).toLocaleString()} L`);
    }
  } else {
    box.appendChild(st);
    box.appendChild(el("p", "hint",
      "年間平均の給液量も入れると、肥料代の見積もりが出ます。ピークの値を年間に掛けると数割多く見積もることになります"));
    return;
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

  const acidResidual = $("acid-residual");
  acidResidual.value = state.acid.residual;
  acidResidual.addEventListener("focus", () => acidResidual.select());
  acidResidual.addEventListener("input", () => {
    state.acid.residual = acidResidual.value;
    saveState();
  });

  $("acid-calc").addEventListener("click", () => {
    const hco3 = num(state.water.HCO3);
    if (!(hco3 > 0)) {
      toast("先に③で原水のHCO3を入れてください");
      return;
    }
    const anion = state.acid.anion || "NO3";
    const req = FertilizerCalc.acidRequirement(hco3, {
      anion: anion,
      residualMeq: num(state.acid.residual),
      fertilizerId: ACID_BY_ANION[anion],
    });
    state.acid.anion = anion;
    state.acid.meqPerL = String(FertilizerCalc.round(req.meqPerL, 2));
    saveState();
    $("acid-anion").value = anion;
    $("acid-meq").value = state.acid.meqPerL;
    renderAcidResult(req);
    recalc();
  });

  // --- 実測からの評価 ---
  // 保存済みの状態が旧バージョンだと evaluate を持っていないので補う
  if (!state.evaluate) {
    state.evaluate = {
      feedL: "", drainL: "", feedEc: "", drainEc: "",
      drainMin: "25", drainMax: "35", nMin: "100", nMax: "150", drainEcMax: "5.0",
    };
  }
  [
    ["ev-date", "date"],
    ["ev-feed", "feedL"], ["ev-drain", "drainL"],
    ["ev-feed-ec", "feedEc"], ["ev-drain-ec", "drainEc"],
    ["ev-feed-ph", "feedPh"], ["ev-drain-ph", "drainPh"], ["ev-note", "note"],
    ["ev-drain-min", "drainMin"], ["ev-drain-max", "drainMax"],
    ["ev-n-min", "nMin"], ["ev-n-max", "nMax"], ["ev-drain-ec-max", "drainEcMax"],
  ].forEach((pair) => {
    const elm = $(pair[0]);
    if (!elm) return;
    if (state.evaluate[pair[1]] !== undefined) elm.value = state.evaluate[pair[1]];
    // 日付欄で select() すると入力しづらいので数値・文字だけ
    if (elm.type !== "date") elm.addEventListener("focus", () => elm.select());
    elm.addEventListener("input", () => {
      state.evaluate[pair[1]] = elm.value;
      saveState();
      renderEvaluate();
      if (pair[1] === "date") resetSaveButton();
    });
  });

  // 同じ給液日に2回保存すると前の記録が消える。
  // 既に記録がある日は、1回押しただけでは書き換えない（reset-all と同じ2段階）
  $("ev-save").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const date = state.evaluate.date || feedToday();
    const dup = feedLogs().some((r) => r["給液日"] === date);
    if (dup && btn.dataset.arm !== "1") {
      btn.dataset.arm = "1";
      btn.textContent = date + " の記録を上書きする？";
      setTimeout(resetSaveButton, 4000);
      return;
    }
    resetSaveButton();
    saveFeedLog();
  });

  $("feed-log-more").addEventListener("click", () => {
    state.feedLogAll = true;
    saveState();
    renderFeedLogList();
    $("feed-log-more").hidden = true;
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

  // --- 目標ECから希釈倍率 ---
  const tec = $("dilution-target-ec");
  if (tec) {
    tec.value = state.targetEc || "";
    tec.addEventListener("focus", () => tec.select());
    tec.addEventListener("input", () => {
      state.targetEc = tec.value;
      saveState();
      renderDilutionSolve();
    });
  }
  $("dilution-solve").addEventListener("click", () => {
    if (!(num(state.targetEc) > 0)) { toast("目標ECを入れてください"); return; }
    renderDilutionSolve();
  });

  // --- モード ---
  Object.keys(FERT_MODES).forEach((m) => {
    const btn = $("mode-" + m);
    if (btn) btn.addEventListener("click", () => switchMode(m));
  });
  $("back-to-menu").addEventListener("click", () => switchMode(""));

  // --- 処方モードの折りたたみグループ ---
  // 既定の開閉は HTML の open 属性で決める（②逆算は開、①前提と⑤実測ECは閉）。
  // 一度でも開閉したらその状態を覚え、次からはそちらを優先する
  if (!state.groups) state.groups = {};
  ["grp-basis", "grp-reverse", "grp-ec"].forEach((id) => {
    const box = $(id);
    if (!box) return;
    if (state.groups[id] !== undefined) box.open = !!state.groups[id];
    box.addEventListener("toggle", () => {
      state.groups[id] = box.open;
      saveState();
    });
  });

  $("reset-all").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.arm !== "1") {
      btn.dataset.arm = "1";
      btn.textContent = "本当にリセット？";
      setTimeout(() => { btn.dataset.arm = ""; btn.textContent = "入力をリセット"; }, 3000);
      return;
    }
    // モードまで消すとモード選択画面に放り出される。
    // リセットしたいのは入力であって、いまどの画面にいるかではない
    const keepMode = state.mode;
    state = defaultState();
    state.mode = keepMode;
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

  // 促成長期どりの月別給液量から、ピークと年間平均を入れる。
  // ピークは6月の1,210 mL、平均は10か月の単純平均。
  // 年間日数は 9/3定植〜6/28収穫終了 の約300日。
  $("scale-preset").addEventListener("click", () => {
    const peak = Math.max.apply(null, FEED_VOLUME_FORCING.map((m) => m.feedMl));
    const avg = FEED_VOLUME_FORCING.reduce((s, m) => s + m.feedMl, 0) / FEED_VOLUME_FORCING.length;
    state.scale.peak = String(peak);
    state.scale.avg = String(Math.round(avg));
    state.scale.days = "300";
    saveState();
    $("scale-peak").value = state.scale.peak;
    $("scale-avg").value = state.scale.avg;
    $("scale-days").value = state.scale.days;
    renderCost();
    renderScaleRef();
    toast("促成長期どりの給液量を入れました");
  });

  // --- 規模の入力 ---
  [["scale-plants", "plants"], ["scale-peak", "peak"], ["scale-avg", "avg"], ["scale-days", "days"]].forEach((pair) => {
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
  $("scale-peak").value = state.scale.peak;
  $("scale-avg").value = state.scale.avg;
  $("scale-days").value = state.scale.days;
  renderScaleRef();
  // 給液日は既定で今日。前日の値が残っていると、気づかずに前日の行を
  // 上書きしてしまうので、今日より前の日付は今日に戻す
  const today = feedToday();
  const saved = state.evaluate.date;
  state.evaluate.date = saved && saved >= today ? saved : today;
  $("ev-date").value = state.evaluate.date;
  renderFeedLogList();
  resetSaveButton();
  recalc();
  // 最後に置く。処方の読み込み・リセットからも initRender が呼ばれるので、
  // ここを忘れるとその後でモードの表示が崩れる
  applyMode();
}

window.addEventListener("DOMContentLoaded", () => {
  const d = $("date-display");
  if (d) d.textContent = formatToday();
  const u = $("user-info");
  if (u) u.textContent = getProfile().displayName;
  loadState();
  // fertilizer.html#daily のように開くと、そのモードで始まる。
  // ホームから1タップで給液の入力欄まで届かせるため
  const hash = (location.hash || "").replace("#", "");
  if (Object.prototype.hasOwnProperty.call(FERT_MODES, hash)) {
    state.mode = hash;
    saveState();
  }
  bindInputs();
  initRender();
  // 記録モードで開いたときは、サーバーの記録を裏で取りに行く
  if (state.mode === "daily") pullFeedLogs();

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
