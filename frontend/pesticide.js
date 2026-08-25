"use strict";

const state = {
  masters: null,
  base: null,
  buildings: new Set(), // 1回の散布で複数の棟をまとめて回ることがあるので複数選択
  items: [],
  purposes: new Set(), // 選択中の目的タグ
  recipeName: "",
  profile: getProfile(),
};

init();

async function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = state.profile.displayName + (isMock ? "（お試しモード）" : "");
  applyHandover(); // 作業画面から日付・場所を引き継いで来た場合はそれを初期値にする

  // 通信を待つ前にイベントを登録する（待っている間のタップを取りこぼさないため）
  $("material-name").addEventListener("input", updatePpeHint);
  $("add-item").addEventListener("click", addItem);
  $("submit").addEventListener("click", submit);
  renderItems();

  // キャッシュがあれば即座に描画し、最新版が届いて中身が変わっていたら描き直す
  state.masters = await loadMasters(function (fresh) {
    state.masters = fresh;
    renderAll();
  });
  renderAll();

  loadMyRecords(); // 今日の記録は入力を妨げないよう待たずに読む
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
  renderMaterialOptions();
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

function renderMaterialOptions() {
  const list = $("material-list");
  list.innerHTML = "";
  materialList()
    .filter((m) => String(m.有効フラグ).toUpperCase() === "TRUE")
    .forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.薬剤名;
      list.appendChild(opt);
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
  const m = findMaterial($("material-name").value.trim());
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
  state.items = items.map((it) => ({
    materialName: it.薬剤名,
    dilution: it.希釈倍数 || "",
    amount: it.使用量 || "",
    amountUnit: it.使用量単位 || "",
    totalVolumeL: "",
  }));
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
  toast(`「${recipe.レシピ名}」の資材を入力しました（内容は編集できます）`);
}

function addItem() {
  const name = $("material-name").value.trim();
  const dilution = $("dilution").value.trim();
  const amount = $("amount").value;
  const amountUnit = $("amount-unit").value.trim();
  const totalVolumeL = $("total-volume").value;

  if (!name) return toast("資材を選択または入力してください");
  if (!dilution && !(amount && amountUnit)) {
    return toast("希釈倍数、または使用量と単位のどちらかを入力してください");
  }

  state.items.push({ materialName: name, dilution, amount, amountUnit, totalVolumeL });
  $("material-name").value = "";
  $("dilution").value = "";
  $("amount").value = "";
  $("amount-unit").value = "";
  $("total-volume").value = "";
  $("ppe-hint").hidden = true;
  renderItems();
}

function renderItems() {
  const box = $("item-list");
  box.innerHTML = "";
  state.items.forEach((it, i) => {
    const row = el("div", "item");
    const m = findMaterial(it.materialName);
    const dose = it.dilution || (it.amount ? it.amount + it.amountUnit : "");

    // 混ぜたときにどれが農薬でどれが肥料か一目で分かるようにする
    const badge = el("span", "mat-badge " + (isPesticide(m) ? "is-pest" : "is-other"),
      isPesticide(m) ? "農薬" : (m ? (m.区分 || "その他") : "未登録"));
    row.appendChild(badge);
    row.appendChild(el("span", "grow", `${it.materialName}（${dose}）`));

    const del = el("button", "del", "削除");
    del.type = "button";
    del.addEventListener("click", () => {
      state.items.splice(i, 1);
      renderItems();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

function computeDuration() {
  const s = $("start-time").value;
  const e = $("end-time").value;
  if (!s || !e) return "";
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : "";
}

async function submit() {
  if (!state.base) return toast("拠点を選択してください");
  if (state.buildings.size === 0) return toast("棟・区画を選択してください");
  if (!$("crop-select").value) return toast("農作物の種類を選択してください");
  if (state.items.length === 0) return toast("資材を1件以上リストに追加してください");

  const payload = {
    type: "spray",
    useDate: $("use-date").value,
    base: state.base,
    // 複数の棟をまとめて回った場合は「1号棟、2号棟」のように1つの記録にまとめる
    building: [...state.buildings].join(PURPOSE_SEPARATOR),
    crop: $("crop-select").value,
    purposeTags: [...state.purposes],
    purposeFree: $("purpose-free").value.trim(),
    recipeName: state.recipeName || "",
    startTime: $("start-time").value,
    endTime: $("end-time").value,
    durationMin: computeDuration(),
    recorder: state.profile.displayName,
    userId: state.profile.userId,
    note: $("note").value.trim(),
    items: state.items,
  };

  $("submit").disabled = true;
  try {
    const res = await apiPostWithQueue(payload);
    if (!res.ok) {
      toast("⚠ " + (res.error || "記録に失敗しました"));
      return;
    }
    toast(res.queued ? "📤 電波が弱いので保留しました（オンライン復帰時に自動送信）" : "✅ 記録しました");
    resetForm();
    await loadMyRecords();
  } catch (err) {
    console.error(err);
    toast("⚠ 送信に失敗しました");
  } finally {
    $("submit").disabled = false;
  }
}

function resetForm() {
  state.items = [];
  state.purposes.clear();
  state.recipeName = "";
  $("purpose-free").value = "";
  $("start-time").value = "";
  $("end-time").value = "";
  $("note").value = "";
  renderItems();
  renderPurposes();
}

async function loadMyRecords() {
  const res = await apiGet("mytoday", { userId: state.profile.userId });
  renderMyRecords(res.spray || res.pesticide || []);
}

function itemsLabel(r) {
  return (r.items || [])
    .map((it) => `${it.資材名}（${it.希釈倍数 || ((it.使用量 || "") + (it.使用量単位 || ""))}）`)
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
    const row = el("div", "item");
    const kubun = r.散布区分 ? `[${r.散布区分}] ` : "";
    row.appendChild(el("span", "grow", `${kubun}${r["棟・区画"]} / ${itemsLabel(r)}`));
    const del = el("button", "del", "取消");
    del.type = "button";
    del.addEventListener("click", () => cancelRecord(r.記録ID));
    row.appendChild(del);
    box.appendChild(row);
  });
}

async function cancelRecord(id) {
  const res = await apiPost({ type: "cancelSpray", id, userId: state.profile.userId });
  if (!res.ok) {
    toast("⚠ " + (res.error || "取消に失敗しました"));
    return;
  }
  toast("取り消しました");
  await loadMyRecords();
}
