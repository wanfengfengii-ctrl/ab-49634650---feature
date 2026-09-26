import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solve,
  validateInput,
  normalizeReserved,
  isPrefixFree,
  reservedCompatible,
  MAX_CODE_LENGTH,
} from '../src/solver.js';
import { buildTreeLayout } from '../src/tree.js';

const alert = (name, freq, lo, hi) => ({ name, freq, lo, hi });

/** 与求解器独立的暴力枚举：直接比较 (代价, 最大码长, 码字元组) 字典序。 */
function bruteSolve(input) {
  const alerts = input.alerts;
  const reserved = normalizeReserved(input.reserved);
  const assigned = [];
  let best = null;

  function compat(c) {
    return (
      assigned.every((a) => !(a.startsWith(c) || c.startsWith(a))) &&
      reserved.every((r) => !(c.startsWith(r) || r.startsWith(c)))
    );
  }
  function* codesOf(lo, hi) {
    function* rec(p) {
      if (p.length >= lo && compat(p)) yield p;
      if (p.length < hi) {
        yield* rec(p + '0');
        yield* rec(p + '1');
      }
    }
    yield* rec('');
  }
  function cmp(a, b) {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.maxLen !== b.maxLen) return a.maxLen - b.maxLen;
    for (let i = 0; i < a.codes.length; i++) {
      if (a.codes[i] !== b.codes[i]) return a.codes[i] < b.codes[i] ? -1 : 1;
    }
    return 0;
  }
  function dfs(i, cost, maxLen) {
    if (i === alerts.length) {
      const sol = { cost, maxLen, codes: assigned.slice() };
      if (!best || cmp(sol, best) < 0) best = sol;
      return;
    }
    for (const c of codesOf(alerts[i].lo, alerts[i].hi)) {
      assigned.push(c);
      dfs(i + 1, cost + alerts[i].freq * c.length, Math.max(maxLen, c.length));
      assigned.pop();
    }
  }
  dfs(0, 0, 0);
  return best;
}

function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 基础工具 ---------------- */

test('normalizeReserved：去重并剔除被更短前缀覆盖的冗余项', () => {
  assert.deepEqual(normalizeReserved(['00', '0', '10', '0', ' 10 ']), ['0', '10']);
  assert.deepEqual(normalizeReserved([]), []);
  assert.deepEqual(normalizeReserved(['', '  ']), []);
});

test('isPrefixFree / reservedCompatible', () => {
  assert.equal(isPrefixFree(['0', '10', '11']), true);
  assert.equal(isPrefixFree(['0', '01']), false);
  assert.equal(reservedCompatible('10', ['0']), true);
  assert.equal(reservedCompatible('010', ['0']), false); // 落入保留子树
  assert.equal(reservedCompatible('0', ['010']), false); // 遮蔽保留前缀
});

test('validateInput：逐项校验录入参数', () => {
  const good = {
    alerts: [
      alert('a', 1, 1, 3), alert('b', 2, 1, 3), alert('c', 3, 1, 3),
      alert('d', 4, 1, 3), alert('e', 5, 1, 3),
    ],
    reserved: ['01'],
  };
  assert.deepEqual(validateInput(good), []);
  assert.ok(validateInput({ alerts: good.alerts.slice(0, 4), reserved: [] }).length > 0); // 少于 5 类
  assert.ok(validateInput({ alerts: [...good.alerts, alert('f', 1, 1, 2), alert('g', 1, 1, 2), alert('h', 1, 1, 2), alert('i', 1, 1, 2)], reserved: [] }).length > 0); // 多于 8 类
  assert.ok(validateInput({ alerts: [alert('a', 0, 1, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('频次')));
  assert.ok(validateInput({ alerts: [alert('a', 1.5, 1, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('频次')));
  assert.ok(validateInput({ alerts: [alert('a', 1, 3, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('码长区间')));
  assert.ok(validateInput({ alerts: [alert('a', 1, 1, MAX_CODE_LENGTH + 1), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('码长区间')));
  assert.ok(validateInput({ ...good, reserved: ['012'] }).some((e) => e.includes('保留前缀')));
  assert.ok(validateInput({ ...good, reserved: ['0', '1', '00', '11'] }).some((e) => e.includes('最多')));
  assert.ok(validateInput({ alerts: [alert('a', 1, 1, 2), alert('a', 1, 1, 2), ...good.alerts.slice(2)], reserved: [] }).some((e) => e.includes('重复')));
  assert.ok(validateInput({ alerts: [alert('', 1, 1, 2), ...good.alerts.slice(1)], reserved: [] }).some((e) => e.includes('不能为空')));
  assert.equal(solve({ alerts: [], reserved: [] }).status, 'invalid');
});

/* ---------------- 手工核算的最优解 ---------------- */

test('等长约束：5 类全部取 3 位码，按字典序取前五', () => {
  const r = solve({
    alerts: [alert('a', 1, 3, 3), alert('b', 1, 3, 3), alert('c', 1, 3, 3), alert('d', 1, 3, 3), alert('e', 1, 3, 3)],
    reserved: [],
  });
  assert.equal(r.status, 'optimal');
  assert.deepEqual(r.alerts.map((a) => a.code), ['000', '001', '010', '011', '100']);
  assert.equal(r.cost, 15);
  assert.equal(r.maxLength, 3);
});

test('加权最优：高频类别获得更短码字', () => {
  const r = solve({
    alerts: [alert('a', 10, 1, 12), alert('b', 10, 1, 12), alert('c', 10, 1, 12), alert('d', 10, 1, 12), alert('e', 1, 1, 12)],
    reserved: [],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 93); // 长度组合 {2,2,2,3,3}（Kraft 和恰为 1），低频者取 3
  assert.equal(r.maxLength, 3);
  assert.deepEqual(r.alerts.map((a) => a.code), ['00', '01', '10', '110', '111']);
  assert.equal(r.alerts[4].length, 3);
});

test('第二级目标：代价相同时取最大码长更小者', () => {
  // {3,3,3,3}+E 长 1 与 {2,3,4,4}+E 长 1 代价同为 23，前者最大码长 3 胜出
  const r = solve({
    alerts: [alert('a', 1, 1, 12), alert('b', 1, 1, 12), alert('c', 2, 1, 12), alert('d', 2, 1, 12), alert('e', 5, 1, 1)],
    reserved: [],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 23);
  assert.equal(r.maxLength, 3);
  assert.deepEqual(r.alerts.map((a) => a.code), ['000', '001', '010', '011', '1']);
});

test('保留前缀封禁半侧码空间', () => {
  const r = solve({
    alerts: [alert('a', 1, 3, 4), alert('b', 1, 3, 4), alert('c', 1, 3, 4), alert('d', 1, 3, 4), alert('e', 1, 3, 4)],
    reserved: ['0'],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 17); // 长度 {3,3,3,4,4}
  assert.deepEqual(r.alerts.map((a) => a.code), ['100', '101', '110', '1110', '1111']);
  for (const a of r.alerts) assert.ok(a.code.startsWith('1'));
});

test('保留前缀的"遮蔽"约束：不得选用保留串的祖先前缀', () => {
  // 保留 00：码字 "0" 虽不在其子树内，但遮蔽了保留分支，同样禁用
  const r = solve({
    alerts: [alert('a', 1, 1, 3), alert('b', 1, 1, 3), alert('c', 1, 1, 3), alert('d', 1, 1, 3), alert('e', 1, 1, 3)],
    reserved: ['00'],
  });
  assert.equal(r.status, 'optimal');
  assert.equal(r.cost, 14); // {01, 100, 101, 110, 111}
  assert.equal(r.maxLength, 3);
  assert.deepEqual(r.alerts.map((a) => a.code), ['01', '100', '101', '110', '111']);
  for (const a of r.alerts) {
    assert.notEqual(a.code, '0');
    assert.ok(reservedCompatible(a.code, ['00']));
  }
});

/* ---------------- 无解情形 ---------------- */

test('无解：Kraft 必要条件不满足', () => {
  const r = solve({
    alerts: [alert('a', 1, 1, 2), alert('b', 1, 1, 2), alert('c', 1, 1, 2), alert('d', 1, 1, 2), alert('e', 1, 1, 2)],
    reserved: [],
  });
  assert.equal(r.status, 'infeasible');
  assert.ok(r.reason.length > 0);
});

test('无解：码位槽不足（5 类抢 4 个 2 位码）', () => {
  const r = solve({
    alerts: [alert('a', 1, 2, 2), alert('b', 1, 2, 2), alert('c', 1, 2, 2), alert('d', 1, 2, 2), alert('e', 1, 2, 2)],
    reserved: [],
  });
  assert.equal(r.status, 'infeasible');
});

test('无解：保留前缀占满全部码空间', () => {
  const r = solve({
    alerts: [alert('a', 1, 1, 3), alert('b', 1, 1, 3), alert('c', 1, 1, 3), alert('d', 1, 1, 3), alert('e', 1, 1, 3)],
    reserved: ['0', '1'],
  });
  assert.equal(r.status, 'infeasible');
});

test('无解：保留后剩余槽位不足', () => {
  const r = solve({
    alerts: [alert('a', 1, 3, 3), alert('b', 1, 3, 3), alert('c', 1, 3, 3), alert('d', 1, 3, 3), alert('e', 1, 3, 3)],
    reserved: ['0'],
  });
  assert.equal(r.status, 'infeasible'); // 仅剩 100/101/110/111 四个槽
});

/* ---------------- 性质与对拍 ---------------- */

test('最优解性质：前缀无关、避开保留、长度落在区间内、成本一致', () => {
  const rand = mulberry32(20260925);
  for (let t = 0; t < 30; t++) {
    const n = 5 + Math.floor(rand() * 4);
    const alerts = Array.from({ length: n }, (_, i) => {
      const lo = 1 + Math.floor(rand() * 3);
      return alert(`a${i}`, 1 + Math.floor(rand() * 20), lo, Math.min(MAX_CODE_LENGTH, lo + 1 + Math.floor(rand() * 4)));
    });
    const pool = ['0', '1', '00', '01', '10', '11', '010', '101'];
    const reserved = pool.filter(() => rand() < 0.15).slice(0, 3);
    const r = solve({ alerts, reserved });
    if (r.status !== 'optimal') continue;
    const codes = r.alerts.map((a) => a.code);
    assert.ok(isPrefixFree(codes), `前缀无关: ${codes}`);
    const norm = normalizeReserved(reserved);
    for (const c of codes) assert.ok(reservedCompatible(c, norm), `避开保留: ${c}`);
    r.alerts.forEach((a, i) => {
      assert.ok(a.length >= alerts[i].lo && a.length <= alerts[i].hi);
      assert.equal(a.contribution, a.freq * a.length);
    });
    assert.equal(r.cost, r.alerts.reduce((s, a) => s + a.contribution, 0));
    assert.equal(r.maxLength, Math.max(...r.alerts.map((a) => a.length)));
  }
});

test('与暴力枚举对拍：小规模随机用例结论完全一致', () => {
  const rand = mulberry32(1234567);
  const pool = ['0', '1', '00', '01', '10', '11'];
  for (let t = 0; t < 25; t++) {
    const alerts = Array.from({ length: 5 }, (_, i) => {
      const lo = 1 + Math.floor(rand() * 2);
      return alert(`a${i}`, 1 + Math.floor(rand() * 5), lo, 3);
    });
    const reserved = pool.filter(() => rand() < 0.2).slice(0, 2);
    const input = { alerts, reserved };
    const mine = solve(input);
    const brute = bruteSolve(input);
    if (!brute) {
      assert.equal(mine.status, 'infeasible', `用例 ${t}: 暴力无解但求解器给出 ${JSON.stringify(mine)}`);
      continue;
    }
    assert.equal(mine.status, 'optimal', `用例 ${t}: 暴力有解但求解器 ${mine.status}`);
    assert.equal(mine.cost, brute.cost, `用例 ${t} 代价`);
    assert.equal(mine.maxLength, brute.maxLen, `用例 ${t} 最大码长`);
    assert.deepEqual(mine.alerts.map((a) => a.code), brute.codes, `用例 ${t} 码字`);
  }
});

test('前缀码可唯一拆分：随机电文编码后可无歧义解码', () => {
  const r = solve({
    alerts: [
      alert('a', 3, 2, 6), alert('b', 8, 2, 5), alert('c', 5, 2, 5),
      alert('d', 12, 1, 4), alert('e', 20, 1, 3), alert('f', 15, 1, 4),
    ],
    reserved: ['1110'],
  });
  assert.equal(r.status, 'optimal');
  const codes = r.alerts.map((a) => a.code);
  const rand = mulberry32(42);
  const seq = Array.from({ length: 200 }, () => Math.floor(rand() * codes.length));
  const wire = seq.map((i) => codes[i]).join('');
  // 贪心前缀匹配即可唯一解码（前缀无关保证）
  const decoded = [];
  let pos = 0;
  while (pos < wire.length) {
    const idx = codes.findIndex((c) => wire.startsWith(c, pos));
    assert.notEqual(idx, -1, `位置 ${pos} 无法解码`);
    decoded.push(idx);
    pos += codes[idx].length;
  }
  assert.deepEqual(decoded, seq);
});

test('性能：8 类宽区间在可接受时间内完成', () => {
  const alerts = Array.from({ length: 8 }, (_, i) => alert(`a${i}`, 1 + i * 7, 1, MAX_CODE_LENGTH));
  const start = performance.now();
  const r = solve({ alerts, reserved: ['1010'] });
  const elapsed = performance.now() - start;
  assert.equal(r.status, 'optimal');
  assert.ok(elapsed < 3000, `耗时 ${elapsed.toFixed(0)}ms 超出预期`);
});

/* ---------------- 码树布局 ---------------- */

test('码树布局：节点类型与坐标完整', () => {
  const { nodes, edges, width, height } = buildTreeLayout(
    [{ code: '00', name: '甲' }, { code: '01', name: '乙' }, { code: '1', name: '丙' }],
    [{ prefix: '001' }].filter(() => false), // 无保留
  );
  const codes = nodes.filter((n) => n.type === 'code');
  assert.equal(codes.length, 3);
  assert.ok(nodes.some((n) => n.type === 'root'));
  assert.equal(edges.length, nodes.length - 1); // 树：边数 = 节点数 - 1
  assert.ok(width > 0 && height > 0);
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.cx) && Number.isFinite(n.cy));
  }
});

test('码树布局：保留前缀渲染为保留节点', () => {
  const { nodes } = buildTreeLayout(
    [{ code: '10', name: '甲' }, { code: '11', name: '乙' }],
    [{ prefix: '0' }],
  );
  const reserved = nodes.filter((n) => n.type === 'reserved');
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].prefix, '0');
});
