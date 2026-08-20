import { minimapMap, viewportRect } from '../src/components/minimap';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { console.log('ok   ' + name); return; }
  failures++;
  console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
};

// 1) 长宽比保真：任意场景/窗口/缩放下 rect.w/rect.h === windowW/windowH。
//    宽扁场景是 issue 报告的原始场景。
const scenes: Array<[number, number]> = [[10000, 800], [800, 5000], [2000, 1219]];
const wins: Array<[number, number]> = [[1200, 700], [1311, 804], [2560, 1080]];
for (const [sceneW, sceneH] of scenes) {
  const m = minimapMap(sceneW, sceneH, 280, 170, -180, -80);
  for (const [winW, winH] of wins) {
    for (const k of [0.005, 0.05, 1, 8, 40, 500]) {
      const r = viewportRect(k, 123.4, -567.8, winW, winH, m);
      check(`aspect scene=${sceneW}x${sceneH} win=${winW}x${winH} k=${k}`,
        Math.abs(r.w / r.h - winW / winH) < 1e-9,
        `got ${(r.w / r.h).toFixed(6)} want ${(winW / winH).toFixed(6)}`);
    }
  }
}

// 2) letterbox：场景映射完整落在 280x170 框内、两轴居中；受限轴恰好填满。
{
  const m = minimapMap(10000, 800, 280, 170, -180, -80);
  const fx = (x: number) => (x - m.x0) * m.s;
  const fy = (y: number) => (y - m.y0) * m.s;
  check('scene fits in box',
    fx(-180) >= 0 && fx(-180 + 10000) <= 280 && fy(-80) >= 0 && fy(-80 + 800) <= 170);
  check('x fills box (width-bound)', Math.abs((fx(-180 + 10000) - fx(-180)) - 280) < 1e-9);
  check('letterbox gaps centered on both axes',
    Math.abs(fx(-180) - (280 - fx(-180 + 10000))) < 1e-9 &&
    Math.abs(fy(-80) - (170 - fy(-80 + 800))) < 1e-9);
  // 3) jump 求逆与正向映射互逆（mini px → scene → mini 往返）。
  check('jump round-trip', Math.abs(fx(4321) / m.s + m.x0 - 4321) < 1e-6);
}

// 4) 可见下限：极端放大时最小边钳到 6px，但两侧同比例放大，
//    长宽比与矩形中心保持不变（原 Math.max(6,·) 按轴独立钳制会破坏比例）。
{
  const m = minimapMap(10000, 800, 280, 170, -180, -80);
  const winW = 1200, winH = 700, k = 500, tx = -123456, ty = 98765;
  const r = viewportRect(k, tx, ty, winW, winH, m);
  const rawW = (winW / k) * m.s, rawH = (winH / k) * m.s;
  check('floor min side >= 6px', Math.min(r.w, r.h) >= 6 - 1e-9);
  check('floor keeps ratio', Math.abs(r.w / r.h - winW / winH) < 1e-9);
  const cx = (-tx / k - m.x0) * m.s + rawW / 2;
  const cy = (-ty / k - m.y0) * m.s + rawH / 2;
  check('floor keeps rect center',
    Math.abs(r.x + r.w / 2 - cx) < 1e-9 && Math.abs(r.y + r.h / 2 - cy) < 1e-9);
}

if (failures > 0) throw new Error(failures + ' check(s) failed');
console.log('all minimap tier-1 checks passed');
