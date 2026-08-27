"use strict";

// 前回の散布方法と調製容量は覚えておく（毎回同じ機材を使うため）
const METHOD_KEY = "tfm_spray_method";

const state = {
  masters: null,
  base: null,
  buildings: new Set(), // 1回の散布で複数の棟をまとめて回ることがあるので複数選択
  volumes: {},          // 棟名 → 散布量L
  method: "",
  items: [],
  purposes: new Set(),  // 選択中の目的タグ
  recipeName: "",
  picked: null,         // 選択中の資材（倍率を決める前の状態）
  choices: [],          // その資材の倍率候補
  profile: getProfile(),
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  applyHandover(); // 作業画面から日付・場所を引き継いで来た場合はそれを初期値にする

  const last = JSON.parse(localStorage.getItem(METHOD_KEY) || "null");
  if (last) {
    state.method = last.method || "";
    $("batch-volume").value = last.batchL || "";
  }

  // 通信を待つ前にイベントを登録する（待っている間のタップを取りこぼさないため）
  $("material-filter").addEventListener("input", renderMaterialPicker);
  $("dilution").addEventListener("input", () => {
    renderDilutionChoices();
    renderMixTable();
  });
  $("batch-volume").addEventListener("input", renderMixTable);
  $("add-item").addEventListener("click", addItem);
  $("submit").addEventListener("click", submit);
  renderItems();

  // 手元のストアだけを見て即座に描く。取り込みが済んだら描き直す
  onStoreChange = loadMyRecords;
  loadMyRecords();

  // キャッシュがあれば即座に描画し、最新版が届いて中身が変わっていたら描き直す
  state.masters = await loadMasters(function (fresh) {
    state.masters = fresh;
    renderAll();
  });
  renderAll();
}

// 作業画面の「🧪 防除」「🧪 葉面散布」からURLパラメータで渡された日付・拠点・棟を反映する。
// マスタにない拠点・棟が来ても、renderBases/renderBuildings 側で選び直される
function applyHandover() {
  const params = new URLSearchParams(location.search);
  $("use-date").value = params.get("date") || formatToday();

  const base = params.get("base");
  if (!base) return;
  state.base = base;
  (params.get("buildings") || "")
    .split(PURPOSE_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((b) => state.buildings.add(b));

  const kubun = params.get("kubun");
  toast(kubun ? `${kubun}の入力です。作業画面の日付・場所を引き継ぎました` : "作業画面の日付・場所を引き継ぎました");
}

function renderAll() {
  renderBases();
  renderCrops();
  renderPurposes();
  renderRecipes();
  renderMaterialPicker();
  renderMethods();
}

// マスタ_資材（旧マスタ_農薬）。古いGASからのレスポンスにも耐えるようフォールバックする
function materialList() {
  return state.masters.materials || state.masters.pesticides || [];
}

function renderBases() {
  const box = $("base-buttons");
  box.innerHTML = "";
  const bases = activeBases(state.masters);
  // 引き継いだ拠点がマスタにないときは先頭に戻す（棟の選択も一緒に外す）
  if (state.base && bases.indexOf(state.base) < 0) {
    state.base = null;
    state.buildings.clear();
  }
  if (!state.base) state.base = bases[0];
  bases.forEach((name) => {
    const btn = el("button", "btn" + (name === state.base ? " active" : ""), name);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.base = name;
      state.buildings.clear(); // 拠点が変われば棟の選択も外す
      renderBases();
    });
    box.appendChild(btn);
  });
  renderBuildings();
}

function renderBuildings() {
  const box = $("building-buttons");
  box.innerHTML = "";
  const buildings = buildingsOfBase(state.masters, state.base);
  const names = buildings.map((b) => b.棟区画名);

  // 引き継いだ棟のうち、この拠点にないものは外す（選べない棟が記録に残らないように）
  [...state.buildings].forEach((n) => {
    if (names.indexOf(n) < 0) state.buildings.delete(n);
  });

  // 未選択のときは先頭の棟を既定にしておく（1棟だけの拠点でいちいち選ばなくて済むように）
  if (state.buildings.size === 0 && buildings.length > 0) {
    state.buildings.add(buildings[0].棟区画名);
  }

  buildings.forEach((b) => {
    const name = b.棟区画名;
    const btn = el("button", "btn" + (state.buildings.has(name) ? " active" : ""), name);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.buildings.has(name) ? state.buildings.delete(name) : state.buildings.add(name);
      renderBuildings();
    });
    box.appendChild(btn);
  });

  // 棟が複数ある拠点だけ一括選択を出す（1棟しかない拠点では邪魔になるため）
  const bulk = $("building-bulk");
  bulk.innerHTML = "";
  if (buildings.length > 1) {
    const all = el("button", "btn chip", "すべて選択");
    all.type = "button";
    all.addEventListener("click", () => {
      buildings.forEach((b) => state.buildings.add(b.棟区画名));
      renderBuildings();
    });
    bulk.appendChild(all);

    const clear = el("button", "btn chip", "選択を解除");
    clear.type = "button";
    clear.addEventListener("click", () => {
      state.buildings.clear();
      renderBuildings();
    });
    bulk.appendChild(clear);
  }

  renderVolumes();
}

// ---------- 棟ごとの散布量 ----------
// 8/1の記録が「野呂1:90L、野呂2:90L、野呂3:20L で合計200L」の形だったので、
// どの棟にどれだけまいたかを残したうえで合計を出す

function renderVolumes() {
  const box = $("volume-rows");
  box.innerHTML = "";
  const names = [...state.buildings];
  if (names.length === 0) {
    box.appendChild(el("div", "hint", "棟・区画を選ぶと入力欄が出ます"));
    updateVolumeTotal();
    return;
  }
  names.forEach((name) => {
    const row = el("div", "num-row");
    row.appendChild(el("label", "num-label", name));
    const input = el("input", "num-input");
    input.type = "number";
    input.inputMode = "decimal";
    input.value = state.volumes[name] === undefined ? "" : state.volumes[name];
    input.addEventListener("input", () => {
      state.volumes[name] = input.value;
      updateVolumeTotal();
      renderMixTable();
    });
    row.appendChild(input);
    row.appendChild(el("span", "num-unit", "L"));
    box.appendChild(row);
  });
  updateVolumeTotal();
}

function totalVolume() {
  return [...state.buildings].reduce((sum, name) => {
    const v = Number(state.volumes[name]);
    return sum + (v > 0 ? v : 0);
  }, 0);
}

function updateVolumeTotal() {
  $("volume-total").textContent = String(Math.round(totalVolume() * 10) / 10);
}

// ---------- 散布方法 ----------

function activeMethods() {
  return (state.masters.sprayMethods || [])
    .filter((m) => String(m.有効フラグ).toUpperCase() === "TRUE")
    .sort((a, b) => Number(a.表示順) - Number(b.表示順));
}

function renderMethods() {
  const box = $("method-buttons");
  box.innerHTML = "";
  const methods = activeMethods();
  if (methods.length === 0) {
    box.appendChild(el("div", "hint", "（マスタ_散布方法が未登録。容量を直接入れてください）"));
    return;
  }
  methods.forEach((m) => {
    const btn = el("button", "btn" + (m.方法名 === state.method ? " active" : ""),
      `${m.方法名}（${m["1回調製容量L"]}L）`);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.method = m.方法名;
      $("batch-volume").value = m["1回調製容量L"];
      renderMethods();
      renderMixTable();
    });
    box.appendChild(btn);
  });
}

function renderCrops() {
  const sel = $("crop-select");
  const current = sel.value;
  sel.innerHTML = "";
  (state.masters.crops || []).forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.品目名;
    opt.textContent = c.品目名;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

// 目的は「マスタから複数選択」＋「自由入力」の併用。
// マスタから選んだぶんは表記が揃うので、あとで履歴を検索したときに取りこぼさない
function renderPurposes() {
  const all = (state.masters.purposes || [])
    .filter((p) => String(p.有効フラグ).toUpperCase() === "TRUE")
    .sort((a, b) => Number(a.表示順) - Number(b.表示順));

  renderPurposeGroup($("purpose-pest"), all.filter((p) => p.分類 === "防除"));
  renderPurposeGroup($("purpose-growth"), all.filter((p) => p.分類 !== "防除"));
}

function renderPurposeGroup(box, list) {
  box.innerHTML = "";
  if (list.length === 0) {
    box.appendChild(el("span", "hint", "（未登録）"));
    return;
  }
  list.forEach((p) => {
    const name = p.目的名;
    const btn = el("button", "btn chip" + (state.purposes.has(name) ? " active" : ""), name);
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.purposes.has(name) ? state.purposes.delete(name) : state.purposes.add(name);
      renderPurposes();
    });
    box.appendChild(btn);
  });
}

// ---------- 資材を選ぶ ----------
// datalist はスマホで中身が見えず選びにくいので、絞り込み＋一覧に置き換えた。
// 1行に 資材名・区分・倍率目安 を出して、押すと倍率の選択に進む

function renderMaterialPicker() {
  const box = $("material-picker");
  const word = $("material-filter").value.trim();
  box.innerHTML = "";

  const list = materialList()
    .filter((m) => String(m.有効フラグ).toUpperCase() === "TRUE")
    .filter((m) => !word || String(m.薬剤名).includes(word) || String(m.区分 || "").includes(word));

  if (list.length === 0) {
    box.appendChild(el("div", "hint", "見つかりません"));
    return;
  }

  list.forEach((m) => {
    const row = el("button", "picker-row" + (state.picked && state.picked.薬剤名 === m.薬剤名 ? " active" : ""));
    row.type = "button";
    row.appendChild(el("span", "mat-badge " + (isPesticide(m) ? "is-pest" : "is-other"),
      isPesticide(m) ? "農薬" : (m.区分 || "その他")));
    const text = el("span", "grow");
    text.appendChild(el("div", "", m.薬剤名));
    if (m.希釈倍率目安) text.appendChild(el("div", "sub", String(m.希釈倍率目安)));
    row.appendChild(text);
    row.addEventListener("click", () => pickMaterial(m));
    box.appendChild(row);
  });
}

function pickMaterial(m) {
  state.picked = m;
  renderMaterialPicker();
  updatePpeHint();

  $("dilution-box").hidden = false;
  $("dilution-label").textContent = `${m.薬剤名} の希釈倍率`;
  $("dilution").value = "";
  $("dose-unit").value = m.調製単位 === "g" ? "g" : "mL";
  $("dilution-note").textContent = m.希釈倍率目安 ? "ラベルの目安: " + m.希釈倍率目安 : "";

  // 倍率候補（"800/1000" のように幅があるものは複数）をボタンで出す。
  // カンマ区切りにするとスプレッドシートが桁区切りの数値と解釈して
  // 800,1000 が 8001000 になってしまうため「/」で区切る（読み込みは両対応）
  state.choices = String(m.倍率候補 || "").split(/[/,、／]/).map((s) => s.trim()).filter(Boolean);
  if (state.choices.length === 1) $("dilution").value = state.choices[0]; // 候補が1つならそれを入れておく
  renderDilutionChoices();
  renderMixTable();
}

// 選んでいる候補が分かるようにする（下の数値欄と同じ値なら光らせる）
function renderDilutionChoices() {
  const box = $("dilution-choices");
  box.innerHTML = "";
  const current = $("dilution").value;
  state.choices.forEach((c) => {
    const btn = el("button", "btn chip" + (String(current) === c ? " active" : ""), c + "倍");
    btn.type = "button";
    btn.addEventListener("click", () => {
      $("dilution").value = c;
      renderDilutionChoices();
      renderMixTable();
    });
    box.appendChild(btn);
  });
}

function findMaterial(name) {
  return materialList().find((m) => m.薬剤名 === name);
}

function isPesticide(material) {
  return material && String(material.農薬登録の有無).toUpperCase() === "TRUE";
}

// 保護具の注意は農薬登録のある資材のときだけ出す（肥料単独では出さない）
function updatePpeHint() {
  const m = state.picked;
  const hint = $("ppe-hint");
  if (isPesticide(m) && m["必要な保護具"]) {
    hint.hidden = false;
    hint.textContent = "⚠ 必要な保護具（目安。使用前にラベルで要確認）: " + m["必要な保護具"];
  } else {
    hint.hidden = true;
  }
}

function activeRecipes() {
  return (state.masters.recipes || []).filter((r) => String(r.有効フラグ).toUpperCase() === "TRUE");
}

function recipeItemsOf(recipeId) {
  return (state.masters.recipeItems || [])
    .filter((it) => it.レシピID === recipeId)
    .sort((a, b) => Number(a.表示順) - Number(b.表示順));
}

function renderRecipes() {
  const box = $("recipe-buttons");
  box.innerHTML = "";
  const recipes = activeRecipes();
  if (recipes.length === 0) {
    box.appendChild(el("div", "hint", "登録済みのレシピはありません（スプレッドシートのマスタ_散布レシピで登録できます）"));
    return;
  }
  recipes.forEach((r) => {
    const btn = el("button", "btn", r.レシピ名);
    btn.type = "button";
    btn.addEventListener("click", () => applyRecipe(r));
    box.appendChild(btn);
  });
}

function applyRecipe(recipe) {
  const items = recipeItemsOf(recipe["レシピID"]);
  if (items.length === 0) {
    toast("このレシピには資材が登録されていません");
    return;
  }
  state.items = items.map((it) => {
    const m = findMaterial(it.薬剤名);
    return {
      materialName: it.薬剤名,
      dilution: parseDilution(it.希釈倍数) || "",
      unit: (m && m.調製単位) || "mL",
    };
  });
  // レシピの対象病害虫は、マスタの目的名と一致するものはチップとして選択状態にする
  if (recipe.対象病害虫) {
    const names = (state.masters.purposes || []).map((p) => p.目的名);
    String(recipe.対象病害虫).split(/[・、,]/).forEach((t) => {
      const trimmed = t.trim();
      if (names.includes(trimmed)) state.purposes.add(trimmed);
    });
    renderPurposes();
  }
  state.recipeName = recipe.レシピ名;
  renderItems();
  toast(`「${recipe.レシピ名}」の資材を入れました（倍率は編集できます）`);
}

function addItem() {
  if (!state.picked) return toast("資材を選んでください");
  const dilution = parseDilution($("dilution").value);
  if (!dilution) return toast("希釈倍率を入れてください");

  state.items.push({
    materialName: state.picked.薬剤名,
    dilution: dilution,
    unit: $("dose-unit").value,
  });

  state.picked = null;
  $("dilution-box").hidden = true;
  $("dilution").value = "";
  $("ppe-hint").hidden = true;
  $("material-filter").value = "";
  renderMaterialPicker();
  renderItems();
}

function renderItems() {
  const box = $("item-list");
  box.innerHTML = "";
  state.items.forEach((it, i) => {
    const row = el("div", "item");
    const m = findMaterial(it.materialName);

    // 混ぜたときにどれが農薬でどれが肥料か一目で分かるようにする
    const badge = el("span", "mat-badge " + (isPesticide(m) ? "is-pest" : "is-other"),
      isPesticide(m) ? "農薬" : (m ? (m.区分 || "その他") : "未登録"));
    row.appendChild(badge);
    row.appendChild(el("span", "grow", `${it.materialName}（${it.dilution}倍）`));

    const del = el("button", "del", "削除");
    del.type = "button";
    del.addEventListener("click", () => {
      state.items.splice(i, 1);
      renderItems();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
  renderMixTable();
}

// ---------- 調製表 ----------
// これが散布前の指示書になる。総調製量と1回の調製容量から、
// 資材ごとの投入量（合計・1回あたり）を出す

function batchVolume() {
  const v = Number($("batch-volume").value);
  return v > 0 ? v : 0;
}

function renderMixTable() {
  const head = $("mix-head");
  const box = $("mix-table");
  box.innerHTML = "";

  const total = totalVolume();
  const batch = batchVolume();

  if (total <= 0 || state.items.length === 0) {
    head.textContent = "";
    box.appendChild(el("div", "hint", "棟ごとの散布量と資材を入れると、投入量が出ます"));
    return;
  }

  const plan = batchPlan(total, batch);
  head.textContent = plan
    ? `総調製量 ${Math.round(total * 10) / 10} L ／ ${state.method || "1回"} ${plan.batchL} L × ${plan.count}回`
      + (plan.lastL !== plan.batchL ? `（最後の1回は ${plan.lastL} L）` : "")
    : `総調製量 ${Math.round(total * 10) / 10} L`;

  const header = el("div", "mix-row mix-header");
  header.appendChild(el("span", "mix-name", "資材"));
  header.appendChild(el("span", "mix-num", "倍率"));
  header.appendChild(el("span", "mix-num", "合計"));
  header.appendChild(el("span", "mix-num", plan ? "1回あたり" : ""));
  box.appendChild(header);

  state.items.forEach((it) => {
    const r = mixRow(it, total, batch);
    const row = el("div", "mix-row");
    row.appendChild(el("span", "mix-name", r.materialName));
    row.appendChild(el("span", "mix-num", r.dilution ? r.dilution + "倍" : "—"));
    row.appendChild(el("span", "mix-num", r.total === null ? "—" : formatDose(r.total) + " " + r.unit));
    row.appendChild(el("span", "mix-num", r.perBatch === null ? "" : formatDose(r.perBatch) + " " + r.unit));
    box.appendChild(row);
  });
}

// ---------- 調製早見表 ----------
// 保存したあと、タンクの前で見るためのもの。
// 実際に量るのは「1回あたり」なので、そこを大きく出す

function showMixSheet(rec) {
  const box = $("mix-sheet");
  box.innerHTML = "";
  box.hidden = false;

  const batch = Number(rec["1回調製容量L"]) || 0;
  const total = Number(rec.総調製量L) || 0;
  const count = Number(rec.調製回数) || 0;
  const plan = batchPlan(total, batch);

  box.appendChild(el("h2", "", "🧪 調製早見表"));
  box.appendChild(el("div", "sheet-sub",
    `${rec.使用年月日}　${rec.拠点}　${rec["棟別散布量"] || rec["棟・区画"] || ""}`));

  if (batch > 0) {
    box.appendChild(el("div", "sheet-big", `${rec.散布方法 || "1回"} ${batch}L のタンクに入れる量`));
    (rec.items || []).forEach((it) => {
      const row = el("div", "sheet-row");
      row.appendChild(el("span", "sheet-name", it.資材名));
      row.appendChild(el("span", "sheet-dose", `${it["1回使用量"] || "—"} ${it.使用量単位 || ""}`));
      box.appendChild(row);
    });
    box.appendChild(el("div", "sheet-note",
      plan && plan.lastL !== plan.batchL
        ? `これを ${count}回。最後の1回は ${plan.lastL}L なので量も減らす`
        : `これを ${count}回`));
  }

  box.appendChild(el("div", "sheet-big", `全体（${total}L）で使う量`));
  (rec.items || []).forEach((it) => {
    const row = el("div", "sheet-row");
    row.appendChild(el("span", "sheet-name", `${it.資材名}${it.希釈倍数 ? `（${it.希釈倍数}倍）` : ""}`));
    row.appendChild(el("span", "sheet-dose", `${it.使用量 || "—"} ${it.使用量単位 || ""}`));
    box.appendChild(row);
  });

  const close = el("button", "btn-secondary", "閉じる");
  close.type = "button";
  close.addEventListener("click", () => { box.hidden = true; });
  box.appendChild(close);
  box.scrollIntoView({ block: "start" });
}

// 棟別散布量を「1号棟:90、2号棟:20」の形にする（棟・区画と同じ区切り）
function volumeByBuildingText() {
  return [...state.buildings]
    .filter((n) => Number(state.volumes[n]) > 0)
    .map((n) => `${n}:${Number(state.volumes[n])}`)
    .join(PURPOSE_SEPARATOR);
}

async function submit() {
  if (!state.base) return toast("拠点を選択してください");
  if (state.buildings.size === 0) return toast("棟・区画を選択してください");
  if (totalVolume() <= 0) return toast("棟ごとの散布量を入れてください");
  if (!$("crop-select").value) return toast("農作物の種類を選択してください");
  if (state.items.length === 0) return toast("資材を1件以上加えてください");

  const total = totalVolume();
  const batch = batchVolume();
  const plan = batchPlan(total, batch);

  // 調製表と同じ計算で、資材ごとの投入量を記録に残す
  const sendItems = state.items.map((it) => {
    const r = mixRow(it, total, batch);
    return {
      materialName: it.materialName,
      dilution: it.dilution,
      amount: formatDose(r.total),
      amountUnit: it.unit,
      perBatch: formatDose(r.perBatch),
      totalVolumeL: total,
    };
  });

  const payload = {
    type: "spray",
    clientId: newClientId(),
    useDate: $("use-date").value,
    base: state.base,
    // 複数の棟をまとめて回った場合は「1号棟、2号棟」のように1つの記録にまとめる
    building: [...state.buildings].join(PURPOSE_SEPARATOR),
    crop: $("crop-select").value,
    purposeTags: [...state.purposes],
    purposeFree: $("purpose-free").value.trim(),
    recipeName: state.recipeName || "",
    totalVolumeL: total,
    method: state.method || "",
    batchVolumeL: batch || "",
    batchCount: plan ? plan.count : "",
    volumeByBuilding: volumeByBuildingText(),
    recorder: state.profile.displayName,
    userId: state.profile.userId,
    note: $("note").value.trim(),
    items: sendItems,
  };

  // 先に手元へ書いて画面に出す（通信を待たない）。散布区分は保存時と同じ判定で決める
  const items = sendItems.map((it) => {
    const master = lookupMaterialMock(it.materialName);
    return {
      資材名: it.materialName,
      区分: master.区分,
      農薬登録の有無: master.農薬登録の有無,
      希釈倍数: it.dilution,
      使用量: it.amount,
      使用量単位: it.amountUnit,
      "1回使用量": it.perBatch,
      散布液量L: it.totalVolumeL,
    };
  });
  const saved = {
    clientId: payload.clientId,
    使用年月日: payload.useDate,
    拠点: payload.base,
    "棟・区画": payload.building,
    農作物の種類: payload.crop,
    散布区分: decideSprayTypeMock(items),
    目的タグ: payload.purposeTags.join(PURPOSE_SEPARATOR),
    目的自由入力: payload.purposeFree,
    レシピ名: payload.recipeName,
    総調製量L: total,
    散布方法: payload.method,
    "1回調製容量L": payload.batchVolumeL,
    調製回数: payload.batchCount,
    棟別散布量: payload.volumeByBuilding,
    記録者: payload.recorder,
    userId: payload.userId,
    備考: payload.note,
    状態: "未同期", // 送信が通ったら「予定」になる
    更新日時: nowTimestamp(),
    items: items,
  };
  storeAdd("spray", saved);

  // 次回のために散布方法と容量を覚えておく
  localStorage.setItem(METHOD_KEY, JSON.stringify({ method: state.method, batchL: $("batch-volume").value }));

  toast("✅ 予定として保存しました");
  resetForm();
  loadMyRecords();
  showMixSheet(saved); // そのままタンクの前で見られるように出す

  sendRecord("spray", payload, loadMyRecords);
}

function resetForm() {
  state.items = [];
  state.purposes.clear();
  state.recipeName = "";
  state.picked = null;
  state.volumes = {};
  $("purpose-free").value = "";
  $("note").value = "";
  $("dilution-box").hidden = true;
  $("ppe-hint").hidden = true;
  $("material-filter").value = "";
  renderMaterialPicker();
  renderVolumes();
  renderItems();
  renderPurposes();
}

// 手元のストアから今日ぶんの自分の散布記録を取り出す
function loadMyRecords() {
  const today = formatToday();
  const uid = state.profile.userId;
  renderMyRecords(
    storeRead("spray").filter(
      (r) => recordDate("spray", r) === today && r.状態 !== "取消" && (r.userId || uid) === uid
    )
  );
}

// 投入量が入っていればそれを見せる（何をどれだけ入れたかが一目で分かる）
function itemsLabel(r) {
  return (r.items || [])
    .map((it) => {
      const dose = it.使用量 ? `${it.使用量}${it.使用量単位 || ""}` : "";
      const bai = it.希釈倍数 ? `${it.希釈倍数}倍` : "";
      const detail = [bai, dose].filter(Boolean).join(" ");
      return `${it.資材名}${detail ? "（" + detail + "）" : ""}`;
    })
    .join("・");
}

function renderMyRecords(records) {
  const box = $("my-records");
  box.innerHTML = "";
  if (records.length === 0) {
    box.appendChild(el("div", "hint", "今日の散布記録はまだありません"));
    return;
  }
  records.slice().reverse().forEach((r) => {
    const pending = !r.記録ID;
    const planned = r.状態 === "予定" || r.状態 === "未同期";
    const row = el("div", "item" + (pending ? " pending" : ""));
    const kubun = r.散布区分 ? `[${r.散布区分}] ` : "";
    const vol = r.総調製量L ? ` ${r.総調製量L}L` : "";
    row.appendChild(el("span", "grow", `${kubun}${r["棟・区画"]}${vol} / ${itemsLabel(r)}`));

    if (pending) {
      row.appendChild(el("span", "pending-mark", r.状態 === "送信エラー" ? "送信エラー" : "未送信"));
    } else if (planned) {
      row.appendChild(el("span", "pending-mark", "予定"));
    }

    // タンクの前で見返せるように、いつでも早見表を開き直せる
    const sheet = el("button", "del sheet", "早見表");
    sheet.type = "button";
    sheet.addEventListener("click", () => showMixSheet(r));
    row.appendChild(sheet);

    // 散布が済んだら「実施した」で確定する。予定のままだと法定帳簿に出ない
    if (planned && r.記録ID) {
      const done = el("button", "del done", "実施した");
      done.type = "button";
      done.addEventListener("click", () => completeStored(r));
      row.appendChild(done);
    }

    const del = el("button", "del", "取消");
    del.type = "button";
    del.addEventListener("click", () => cancelStored(r));
    row.appendChild(del);
    box.appendChild(row);
  });
}

// 「実施した」。手元を先に完了にして、時刻を入れてサーバーへ送る
function completeStored(rec) {
  const now = nowTimestamp().slice(11, 16);
  storePatch("spray", recordKey(rec), { 状態: "完了", 終了時刻: now });
  loadMyRecords();
  toast("実施として記録しました");
  sendComplete("spray", rec.記録ID, state.profile.userId, { endTime: now }, loadMyRecords);
}

// 取消も手元を先に直し、サーバーへの連絡は裏で送る
function cancelStored(rec) {
  storePatch("spray", recordKey(rec), { 状態: "取消" });
  loadMyRecords();
  if (!rec.記録ID) {
    dropQueuedRecord(rec.clientId);
    toast("取り消しました");
    return;
  }
  toast("取り消しました");
  sendCancel("spray", rec.記録ID, state.profile.userId, loadMyRecords);
}
