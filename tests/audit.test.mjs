/**
 * 同步标记隔离审计测试：手工核算用例 + 与独立暴力枚举的对拍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import {
  auditSyncMarker,
  validateMarker,
  MIN_MARKER_LENGTH,
  MAX_MARKER_LENGTH,
  MIN_FRAME_ALERTS,
  MAX_FRAME_ALERTS,
} from '../src/audit.js';

const alert = (name, freq, lo, hi) => ({ name, freq, lo, hi });

const SAMPLE_INPUT = {
  alerts: [
    alert('A', 3, 2, 6), alert('B', 8, 2, 5), alert('C', 5, 2, 5),
    alert('D', 12, 1, 4), alert('E', 20, 1, 3), alert('F', 15, 1, 4),
  ],
  reserved: ['1110'],
};

/** 直接从码字数组构造一个形状同 solve optimal 结果的码表。 */
function tableFrom(codes, names) {
  return {
    status: 'optimal',
    alerts: codes.map((code, i) => ({
      name: names?.[i] ?? `c${i}`,
      freq: 1,
      code,
      length: code.length,
      contribution: code.length,
    })),
  };
}

/* ---------------- 标记校验 ---------------- */

test('validateMarker：3–6 位 0/1 串才合规', () => {
  assert.equal(validateMarker('101'), null);
  assert.equal(validateMarker('101010'), null);
  assert.equal(validateMarker(' 101 '), null);
  assert.ok(validateMarker('').includes('录入'));
  assert.ok(validateMarker('10').includes('长度'));
  assert.ok(validateMarker('1010101').includes('长度'));
  assert.ok(validateMarker('102').includes('0/1'));
  assert.ok(validateMarker('abc').includes('0/1'));
  assert.equal(MIN_MARKER_LENGTH, 3);
  assert.equal(MAX_MARKER_LENGTH, 6);
});

test('码表缺失或非 optimal 时拒绝审计且不沿用旧结论', () => {
  const r1 = auditSyncMarker(null, '101');
  assert.equal(r1.status, 'invalid-marker');
  const r2 = auditSyncMarker({ status: 'infeasible', alerts: [] }, '101');
  assert.equal(r2.status, 'invalid-marker');
});

/* ---------------- 手工核算：码内 / 跨边界 / 截断串 / 重叠 ---------------- */

test('风险证据：跨相邻码字边界的标记，帧前截断串被正确忽略', () => {
  // 码字 000|000 -> 000000；"0000" 的合法出现只有位置 0/3（码字边界），
  // 位置 1/2 为非边界出现。扫描第一条码字时位置 1、2 的匹配起点在帧外
  // （负数，属于需要帧前截断串的情形），不得作为证据；真实证据在位置 4。
  const table = tableFrom(['000', '001', '010', '011', '100']);
  const r = auditSyncMarker(table, '0000');
  assert.equal(r.status, 'risk');
  assert.equal(r.count, 2);
  assert.deepEqual(r.path.map((p) => p.alertIndex), [0, 0]);
  assert.equal(r.bits, '000000');
  assert.equal(r.position, 1); // 该帧内最早的非边界出现
  assert.deepEqual(r.boundaries, [0, 3, 6]);
  assert.equal(r.spansBoundary, true);
  assert.equal(r.startPathIndex, 0);
  assert.equal(r.startOffset, 1);
  assert.equal(r.endPathIndex, 1);
  assert.equal(r.endOffset, 1);
  assert.deepEqual(r.touchedAlertIndexes, [0]);
  assert.deepEqual(r.touchedPathIndexes, [0, 1]);
});

test('风险证据：完全落在单个码字内部的标记', () => {
  // 码 1111 内部偏移 1 处出现 "111"；帧须补足到 2 条，取字典序最小续接 [0,0]
  const table = tableFrom(['1111', '000', '001', '110', '01', '10']);
  const r = auditSyncMarker(table, '111');
  assert.equal(r.status, 'risk');
  assert.equal(r.count, 2);
  assert.deepEqual(r.path.map((p) => p.alertIndex), [0, 0]);
  assert.equal(r.bits, '11111111');
  assert.equal(r.position, 1);
  assert.equal(r.spansBoundary, false);
  assert.equal(r.startPathIndex, 0);
  assert.equal(r.startOffset, 1);
  assert.equal(r.endPathIndex, 0);
  assert.equal(r.endOffset, 3);
});

test('风险证据：跨边界且涉及两类不同警报（示例码表）', () => {
  const table = solve(SAMPLE_INPUT);
  assert.equal(table.status, 'optimal');
  const r = auditSyncMarker(table, '010'); // 000|10 = B|F
  assert.equal(r.status, 'risk');
  assert.equal(r.count, 2);
  assert.deepEqual(r.path.map((p) => p.alertIndex), [1, 5]);
  assert.equal(r.bits, '00010');
  assert.deepEqual(r.boundaries, [0, 3, 5]);
  assert.equal(r.position, 2);
  assert.equal(r.spansBoundary, true);
  assert.deepEqual(r.touchedAlertIndexes, [1, 5]);
});

test('帧尾之外的截断串不作为证据：标记只在帧后补位时才形成出现', () => {
  // 等长 3 位码表：帧 [c3] = "011" 之后紧跟帧外假想比特 "1" 才构成 "0111"；
  // 帧内非边界位置（码字内偏移 1/2 与跨边界）均拼不出 "0111"，审计通过。
  const table = tableFrom(['000', '001', '010', '011', '100']);
  const r = auditSyncMarker(table, '0111');
  assert.equal(r.status, 'safe');
});

test('无风险：等长 3 位码表对标记 0111 审计通过，并给出覆盖序列数', () => {
  const table = tableFrom(['000', '001', '010', '011', '100']);
  const r = auditSyncMarker(table, '0111');
  assert.equal(r.status, 'safe');
  // 5^2 + 5^3 + … + 5^10
  let expected = 0n;
  let term = 1n;
  for (let k = 1; k <= MAX_FRAME_ALERTS; k++) {
    term *= 5n;
    if (k >= MIN_FRAME_ALERTS) expected += term;
  }
  assert.equal(r.sequencesCovered, expected);
  assert.deepEqual(r.frameRange, [2, 10]);
});

/* ---------------- 选择次序稳定性 ---------------- */

test('稳定选取：条数最少优先，其次输入序字典序，其次出现位置最早', () => {
  // 示例码表：0101 最早风险帧为 [C,E]=001|01（位 1 起）
  const table = solve(SAMPLE_INPUT);
  const r = auditSyncMarker(table, '0101');
  assert.equal(r.status, 'risk');
  assert.equal(r.count, 2);
  assert.deepEqual(r.path.map((p) => p.alertIndex), [2, 4]);
  assert.equal(r.position, 1);
  // 同帧内合法边界出现与非边界出现并存时，取最早的非边界位置：
  // "111" 在 11111111([A,A]) 中的非边界出现最早在位置 1
  const r2 = auditSyncMarker(table, '111');
  assert.deepEqual(r2.path.map((p) => p.alertIndex), [0, 0]);
  assert.equal(r2.position, 1);
});

/* ---------------- 暴力对拍 ---------------- */

/** 独立暴力：按 (k 升序, 序号字典序, 位置最早) 枚举全部 2–10 条序列。 */
function bruteAudit(codes, marker) {
  const n = codes.length;
  const m = marker.length;
  for (let k = MIN_FRAME_ALERTS; k <= MAX_FRAME_ALERTS; k++) {
    const seq = new Array(k).fill(0);
    const total = n ** k;
    for (let counter = 0; counter < total; counter++) {
      let x = counter;
      for (let d = k - 1; d >= 0; d--) {
        seq[d] = x % n;
        x = Math.floor(x / n);
      }
      const lens = seq.map((i) => codes[i].length);
      const bounds = new Set([0]);
      let acc = 0;
      for (const len of lens) {
        acc += len;
        bounds.add(acc);
      }
      const bits = seq.map((i) => codes[i]).join('');
      for (let p = 0; p + m <= bits.length; p++) {
        if (!bounds.has(p) && bits.startsWith(marker, p)) {
          return { status: 'risk', k, seq: seq.slice(), position: p, bits };
        }
      }
    }
  }
  return { status: 'safe' };
}

/** 从 2^L 空间随机取 size 个等长码（天然前缀无关）。 */
function randomEqualCodes(rand, size, len) {
  const pool = [];
  for (let x = 0; x < 1 << len; x++) pool.push(x.toString(2).padStart(len, '0'));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size);
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

test('与暴力枚举对拍：随机小码表 × 随机标记，结论与证据帧完全一致', () => {
  const rand = mulberry32(20260926);
  for (let t = 0; t < 24; t++) {
    const n = 3 + Math.floor(rand() * 2); // 3–4 类，控制暴力规模
    const len = 2 + Math.floor(rand() * 2); // 码长 2–3
    const codes = randomEqualCodes(rand, n, len);
    const table = tableFrom(codes);
    const mLen = MIN_MARKER_LENGTH + Math.floor(rand() * 2); // 3–4 位
    const marker = Array.from({ length: mLen }, () => (rand() < 0.5 ? '0' : '1')).join('');
    const got = auditSyncMarker(table, marker);
    const want = bruteAudit(codes, marker);
    assert.equal(got.status, want.status, `用例 ${t}: codes=${codes} marker=${marker}`);
    if (want.status === 'risk') {
      assert.equal(got.count, want.k, `用例 ${t} 条数`);
      assert.deepEqual(got.path.map((p) => p.alertIndex), want.seq, `用例 ${t} 路径`);
      assert.equal(got.position, want.position, `用例 ${t} 位置`);
      assert.equal(got.bits, want.bits, `用例 ${t} 比特流`);
    }
  }
});

/* ---------------- 端到端：solve + audit ---------------- */

test('端到端：真实求解码表审计，标记长度 3 与 6 均可工作', () => {
  const table = solve({
    alerts: [
      alert('a', 1, 3, 4), alert('b', 1, 3, 4), alert('c', 1, 3, 4),
      alert('d', 1, 3, 4), alert('e', 1, 3, 4),
    ],
    reserved: [],
  });
  assert.equal(auditSyncMarker(table, '000').status, 'risk');
  const safe6 = auditSyncMarker(table, '111111');
  assert.equal(safe6.status, 'safe');
  const risk6 = auditSyncMarker(table, '000000');
  assert.equal(risk6.status, 'risk');
});
