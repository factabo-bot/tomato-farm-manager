"use strict";

// LAI計算の画面。計算そのものは lai-calc.js。
// 係数・密度などの設定と、測りかけの葉は端末に残す（10枚測る途中で画面を閉じても消えないように）。
// 写真は残さない（容量が大きいため）。面積の数字だけを残す

const LAI_KEY = "tfm_lai";
const PHOTO_MAX_PX = 1400; // 長辺をこの大きさに縮めてから数える。精度は十分で、処理が速い

const lai = loadLaiState();
let photoTarget = null; // 写真を撮っている葉の番号

init();

function loadLaiState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LAI_KEY) || "{}"); } catch (e) {}
  return {
    coefs: s.coefs || {},          // { 品種名: { value, n, date } }
    variety: s.variety || "",
    density: s.density || "",
    leafCount: s.leafCount || "",
    sizes: s.sizes && s.sizes.length ? s.sizes : [{}, {}, {}],
    target: s.target || "",
    coefVariety: s.coefVariety || "",
    refSide: s.refSide || "10",
    leaves: s.leaves && s.leaves.length ? s.leaves : [{}],
  };
}

function saveLaiState() {
  try { localStorage.setItem(LAI_KEY, JSON.stringify(lai)); } catch (e) {}
}

function init() {
  $("date-display").textContent = formatToday();
  $("user-info").textContent = getProfile().displayName + (isMock ? "（お試しモード）" : "");

  bindValue("density", "density", renderLai);
  bindValue("leaf-count", "leafCount", renderLai);
  bindValue("target", "target", renderLai);
  bindValue("coef-variety", "coefVariety", renderCoef);
  bindValue("ref-side", "refSide", null);
  $("coef").addEventListener("input", renderLai);
  $("variety").addEventListener("change", () => {
    lai.variety = $("variety").value;
    const c = lai.coefs[lai.variety];
    $("coef").value = c ? round(c.value, 3) : "";
    saveLaiState();
    renderLai();
  });
  $("add-size").addEventListener("click", () => {
    lai.sizes.push({});
    saveLaiState();
    renderSizes();
  });
  $("add-leaf").addEventListener("click", () => {
    lai.leaves.push({});
    saveLaiState();
    renderLeaves();
  });
  $("save-coef").addEventListener("click", saveCoefficient);
  $("photo-input").addEventListener("change", onPhoto);

  renderVarieties();
  renderSizes();
  renderLeaves();
}

function bindValue(id, key, after) {
  const input = $(id);
  input.value = lai[key];
  input.addEventListener("input", () => {
    lai[key] = input.value;
    saveLaiState();
    if (after) after();
  });
}

function round(v, digits) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

// ---- LAIと残す枚数 ----

function renderVarieties() {
  const sel = $("variety");
  sel.innerHTML = "";
  const names = Object.keys(lai.coefs);
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = names.length ? "選ぶ（係数を手で入れてもよい）" : "保存した係数はまだありません";
  sel.appendChild(blank);
  names.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name + "（" + round(lai.coefs[name].value, 3) + "）";
    sel.appendChild(opt);
  });
  sel.value = lai.coefs[lai.variety] ? lai.variety : "";
  const c = lai.coefs[sel.value];
  if (c && !$("coef").value) $("coef").value = round(c.value, 3);
  renderLai();
}

function renderSizes() {
  const box = $("size-rows");
  box.innerHTML = "";
  lai.sizes.forEach((s, i) => {
    const row = el("div", "size-row");
    row.appendChild(el("span", "size-name", "葉" + (i + 1)));
    row.appendChild(sizeInput(s, "length", "葉長"));
    row.appendChild(el("span", "size-x", "×"));
    row.appendChild(sizeInput(s, "width", "葉幅"));
    const del = el("button", "del", "削除");
    del.type = "button";
    del.addEventListener("click", () => {
      lai.sizes.splice(i, 1);
      if (lai.sizes.length === 0) lai.sizes.push({});
      saveLaiState();
      renderSizes();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
  renderLai();
}

function sizeInput(obj, key, placeholder) {
  const input = el("input", "");
  input.type = "number";
  input.inputMode = "decimal";
  input.placeholder = placeholder;
  input.value = obj[key] || "";
  input.addEventListener("input", () => {
    obj[key] = input.value;
    saveLaiState();
    renderLai();
    renderCoef();
  });
  return input;
}

function renderLai() {
  const box = $("lai-result");
  const r = laiEstimate({
    coefficient: $("coef").value,
    density: lai.density,
    leafCount: lai.leafCount,
    leaves: lai.sizes,
    targetLai: lai.target,
  });
  box.innerHTML = "";
  if (!r) return;
  const lines = ["1枚の平均面積 " + Math.round(r.avgLeafCm2) + " cm²（" + r.sampleCount + "枚の平均）"];
  if (r.branchAreaM2 !== undefined) lines.push("1枝の葉面積 " + round(r.branchAreaM2, 2) + " m²");
  lines.forEach((t) => box.appendChild(el("div", "", t)));
  if (r.lai !== undefined) {
    const d = el("div", "");
    d.appendChild(document.createTextNode("LAI "));
    d.appendChild(el("strong", "", String(round(r.lai, 2))));
    box.appendChild(d);
  }
  if (r.keepLeaves !== undefined) {
    const d = el("div", "");
    d.appendChild(document.createTextNode("目標に合わせて残す葉 "));
    d.appendChild(el("strong", "", Math.round(r.keepLeaves) + "枚"));
    d.appendChild(document.createTextNode("／枝"));
    box.appendChild(d);
  }
}

// ---- 係数を決める ----

function renderLeaves() {
  const box = $("leaf-cards");
  box.innerHTML = "";
  lai.leaves.forEach((lf, i) => {
    const card = el("div", "plant-card");
    const head = el("div", "plant-head");
    head.appendChild(el("span", "plant-label", "葉" + (i + 1)));
    head.appendChild(el("span", "prev-note", ""));
    const del = el("button", "del", "削除");
    del.type = "button";
    del.addEventListener("click", () => {
      lai.leaves.splice(i, 1);
      if (lai.leaves.length === 0) lai.leaves.push({});
      saveLaiState();
      renderLeaves();
    });
    head.appendChild(del);
    card.appendChild(head);

    card.appendChild(leafRow(lf, "length", "葉長(cm)"));
    card.appendChild(leafRow(lf, "width", "葉幅(cm)"));
    card.appendChild(leafRow(lf, "area", "面積(cm²)"));

    const btn = el("button", "btn-secondary photo-btn", lf.area ? "写真で測り直す" : "写真で面積を測る");
    btn.type = "button";
    btn.addEventListener("click", () => {
      photoTarget = i;
      $("photo-input").value = "";
      $("photo-input").click();
    });
    card.appendChild(btn);

    const result = el("div", "hint");
    result.id = "photo-result-" + i;
    card.appendChild(result);
    box.appendChild(card);
  });
  renderCoef();
}

function leafRow(lf, key, label) {
  const row = el("div", "num-row");
  row.appendChild(el("label", "num-label", label));
  const input = el("input", "num-input");
  input.type = "number";
  input.inputMode = "decimal";
  input.value = lf[key] || "";
  input.id = "leaf-" + key + "-" + lai.leaves.indexOf(lf);
  input.addEventListener("input", () => {
    lf[key] = input.value;
    saveLaiState();
    renderCoef();
  });
  row.appendChild(input);
  return row;
}

function renderCoef() {
  const box = $("coef-result");
  box.innerHTML = "";
  const r = laiCoefficient(lai.leaves);
  if (!r) return;
  const d = el("div", "");
  d.appendChild(document.createTextNode("係数 "));
  d.appendChild(el("strong", "", String(round(r.value, 3))));
  d.appendChild(document.createTextNode("（" + r.n + "枚から）"));
  box.appendChild(d);
}

function saveCoefficient() {
  const name = (lai.coefVariety || "").trim();
  if (!name) return toast("品種を入れてください");
  const r = laiCoefficient(lai.leaves);
  if (!r) return toast("葉長・葉幅・面積がそろった葉がありません");
  lai.coefs[name] = { value: r.value, n: r.n, date: formatToday() };
  lai.variety = name;
  $("coef").value = round(r.value, 3);
  saveLaiState();
  renderVarieties();
  toast("✓ " + name + " の係数を保存しました");
}

// ---- 写真から面積 ----

async function onPhoto() {
  const file = $("photo-input").files[0];
  const i = photoTarget;
  if (!file || i === null || !lai.leaves[i]) return;
  const out = $("photo-result-" + i);
  out.textContent = "数えています…";
  try {
    const img = await loadImage(file);
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    const r = measureLeafArea(image.data, w, h, lai.refSide);
    out.innerHTML = "";
    if (!r.ok) {
      out.className = "hint warn";
      out.textContent = r.error;
      return;
    }
    lai.leaves[i].area = String(Math.round(r.areaCm2));
    saveLaiState();
    const areaInput = $("leaf-area-" + i);
    if (areaInput) areaInput.value = lai.leaves[i].area;
    renderCoef();

    out.className = "hint" + (r.warnings.length ? " warn" : "");
    out.appendChild(el("div", "", "面積 " + Math.round(r.areaCm2) + " cm²（緑＝葉、赤＝基準として数えた部分）"));
    r.warnings.forEach((t) => out.appendChild(el("div", "", t)));
    paintMask(image, r.mask);
    ctx.putImageData(image, 0, 0);
    canvas.className = "leaf-preview";
    out.appendChild(canvas);
  } catch (e) {
    out.className = "hint warn";
    out.textContent = "写真を読み込めませんでした";
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load")); };
    img.src = url;
  });
}

// 数えた部分に色を重ねる。数えていない部分は薄くする
function paintMask(image, mask) {
  const d = image.data;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (mask[p] === 1) {
      d[i] = d[i] * 0.4;
      d[i + 1] = d[i + 1] * 0.4 + 255 * 0.6;
      d[i + 2] = d[i + 2] * 0.4 + 90 * 0.6;
    } else if (mask[p] === 2) {
      d[i] = d[i] * 0.3 + 230 * 0.7;
      d[i + 1] = d[i + 1] * 0.3 + 40 * 0.7;
      d[i + 2] = d[i + 2] * 0.3 + 40 * 0.7;
    } else {
      d[i] = 255 - (255 - d[i]) * 0.35;
      d[i + 1] = 255 - (255 - d[i + 1]) * 0.35;
      d[i + 2] = 255 - (255 - d[i + 2]) * 0.35;
    }
  }
}
