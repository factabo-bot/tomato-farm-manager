"use strict";

// LAI（葉面積指数）と葉面積の計算。画面を持たないので単体でテストできる。
// 式は千葉県「促成トマト栽培の養液栽培における環境制御と強草勢台木の利用」（令和4年3月）p.12
//   1枚の葉面積 ＝ 係数 × 葉長 × 葉幅（式4）
//   係数       ＝ Σ実際の葉面積 ÷ Σ(葉長×葉幅)（式5）
//   LAI        ＝ 1枝の葉面積の総和 × 枝の密度（式3）

// 係数。leaves は { length, width, area }（cm, cm, cm²）の並び。そろっていない葉は数えない
function laiCoefficient(leaves) {
  let sumArea = 0;
  let sumLW = 0;
  let n = 0;
  leaves.forEach((lf) => {
    const l = parseFloat(lf.length);
    const w = parseFloat(lf.width);
    const a = parseFloat(lf.area);
    if (!(l > 0 && w > 0 && a > 0)) return;
    sumArea += a;
    sumLW += l * w;
    n += 1;
  });
  if (n === 0) return null;
  return { value: sumArea / sumLW, n: n };
}

// 葉の大きさ（葉長・葉幅 cm）と枚数・密度から、1枝の葉面積とLAIを出す。
// 葉の大きさは数枚の平均を使う（上と下で大きさが違うため）
function laiEstimate({ coefficient, density, leafCount, leaves, targetLai }) {
  const c = parseFloat(coefficient);
  const d = parseFloat(density);
  const count = parseFloat(leafCount);
  const sizes = (leaves || [])
    .map((lf) => ({ l: parseFloat(lf.length), w: parseFloat(lf.width) }))
    .filter((s) => s.l > 0 && s.w > 0);
  if (!(c > 0) || sizes.length === 0) return null;

  const avgLeafCm2 = sizes.reduce((sum, s) => sum + c * s.l * s.w, 0) / sizes.length;
  const avgLeafM2 = avgLeafCm2 / 10000;
  const out = { avgLeafCm2: avgLeafCm2, sampleCount: sizes.length };
  if (count > 0) out.branchAreaM2 = avgLeafM2 * count;
  if (count > 0 && d > 0) out.lai = avgLeafM2 * count * d;
  const t = parseFloat(targetLai);
  if (t > 0 && d > 0) out.keepLeaves = t / d / avgLeafM2;
  return out;
}

// ---- 写真から葉の面積を出す ----
// 白い紙の上に葉と黒い正方形（一辺が分かっているもの）を置き、真上から撮った写真を想定する。
// 緑の画素を葉、いちばん大きな黒いかたまりを基準の正方形とみなし、画素数の比で面積を出す。

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  const s = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h: h, s: s, v: v };
}

// 0=背景 1=葉の候補 2=黒の候補
function classifyPixels(data, width, height) {
  const cls = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < cls.length; i += 4, p++) {
    const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    if (h >= 45 && h <= 180 && s >= 0.18 && v >= 0.12) cls[p] = 1;
    else if (v <= 0.3 && s <= 0.45) cls[p] = 2;
  }
  return cls;
}

// 同じ種類の画素がつながったかたまりを数える（4近傍）。
// 返り値の各かたまりは { kind, size, minX, maxX, minY, maxY, touchesEdge }
function findComponents(cls, width, height) {
  const label = new Int32Array(cls.length).fill(-1);
  const queue = new Int32Array(cls.length);
  const comps = [];
  for (let start = 0; start < cls.length; start++) {
    if (cls[start] === 0 || label[start] !== -1) continue;
    const kind = cls[start];
    const id = comps.length;
    const c = { kind: kind, size: 0, minX: width, maxX: 0, minY: height, maxY: 0, touchesEdge: false };
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = (p - x) / width;
      c.size++;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) c.touchesEdge = true;
      if (x > 0) visit(p - 1);
      if (x < width - 1) visit(p + 1);
      if (y > 0) visit(p - width);
      if (y < height - 1) visit(p + width);
    }
    comps.push(c);
    function visit(q) {
      if (label[q] === -1 && cls[q] === kind) {
        label[q] = id;
        queue[tail++] = q;
      }
    }
  }
  return { comps: comps, label: label };
}

// 写真の画素（RGBA）から葉の面積を出す。refSideCm は基準の正方形の一辺（cm）。
// mask には画素ごとの判定（0=使わない 1=葉 2=基準）を入れて返す。確認用の重ね表示に使う
function measureLeafArea(data, width, height, refSideCm) {
  const side = parseFloat(refSideCm);
  if (!(side > 0)) return { ok: false, error: "基準の正方形の一辺を入れてください" };

  const cls = classifyPixels(data, width, height);
  const { comps, label } = findComponents(cls, width, height);

  // 基準：黒いかたまりのうち、正方形らしいもの（縦横がほぼ同じで、外枠をよく埋める）の最大
  let ref = -1;
  comps.forEach((c, i) => {
    if (c.kind !== 2) return;
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const aspect = bw / bh;
    const fill = c.size / (bw * bh);
    if (c.size < 400 || aspect < 0.75 || aspect > 1.33 || fill < 0.8) return;
    if (ref === -1 || c.size > comps[ref].size) ref = i;
  });
  if (ref === -1) return { ok: false, error: "黒い正方形が見つかりません。紙の上に置いて、影が入らないように撮り直してください" };

  // 葉：緑のかたまりのうち、最大のものの2%以上の大きさがあるもの（小葉が離れて写っても拾う）
  let largestLeaf = 0;
  comps.forEach((c) => { if (c.kind === 1 && c.size > largestLeaf) largestLeaf = c.size; });
  if (largestLeaf === 0) return { ok: false, error: "葉が見つかりません" };
  const minLeaf = Math.max(50, largestLeaf * 0.02);
  const leafIds = new Set();
  let leafPx = 0;
  let cutOff = false;
  comps.forEach((c, i) => {
    if (c.kind !== 1 || c.size < minLeaf) return;
    leafIds.add(i);
    leafPx += c.size;
    if (c.touchesEdge) cutOff = true;
  });

  const mask = new Uint8Array(cls.length);
  for (let p = 0; p < mask.length; p++) {
    if (label[p] === ref) mask[p] = 2;
    else if (leafIds.has(label[p])) mask[p] = 1;
  }

  // 葉の表面の照り返しは色が抜けて穴になる。葉に囲まれた小さな穴は葉として数える。
  // 小葉の間に囲まれた白い隙間まで埋めないよう、大きさに上限を置く
  const holeCls = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) holeCls[p] = mask[p] === 1 ? 0 : 1;
  const holes = findComponents(holeCls, width, height);
  const maxHole = leafPx * 0.002;
  const fill = new Set();
  holes.comps.forEach((c, i) => {
    if (!c.touchesEdge && c.size <= maxHole) fill.add(i);
  });
  let filledPx = 0;
  if (fill.size > 0) {
    for (let p = 0; p < mask.length; p++) {
      if (mask[p] === 0 && fill.has(holes.label[p])) {
        mask[p] = 1;
        filledPx++;
      }
    }
  }
  leafPx += filledPx;

  const refPx = comps[ref].size;
  const warnings = [];
  if (cutOff) warnings.push("葉が写真の端で切れています。全体が入るように撮り直してください");
  if (refPx < 2500) warnings.push("黒い正方形が小さく写っています。近づくか、大きい正方形を使うと正確になります");
  return {
    ok: true,
    areaCm2: (leafPx / refPx) * side * side,
    leafPx: leafPx,
    refPx: refPx,
    warnings: warnings,
    mask: mask,
  };
}

if (typeof module !== "undefined") {
  module.exports = { laiCoefficient, laiEstimate, rgbToHsv, classifyPixels, findComponents, measureLeafArea };
}
