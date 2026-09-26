import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditSyncMarker,
  validateMarker,
  MIN_MARKER_LENGTH,
  MAX_MARKER_LENGTH,
  MIN_FRAME_ALERTS,
  MAX_FRAME_ALERTS,
} from '../src/audit.js';
import { solve } from '../src/solver.js';

/**
 * 与实现独立的暴力枚举：严格按规格次序（警报条数 → 序列字典序 → 命中位置）
 * 返回首个非法命中；仅统计完整落入帧内的标记出现。
 */
function bruteAudit(codes, marker) {
  const n = codes.length;
  const m = marker.length;
  for (let L = MIN_FRAME_ALERTS; L <= MAX_FRAME_ALERTS; L++) {
    const seq = new Array(L).fill(0);
    for (;;) {
      const stream = seq.map((i) => codes[i]).join('');
      const boundaries = new Set();
      let offset = 0;
      for (const i of seq) {
        boundaries.add(offset);
        offset += codes[i].length;
      }
      for (let p = 0; p + m <= stream.length; p++) {
        if (!boundaries.has(p) && stream.startsWith(marker, p)) {
          return { risk: true, sequence: seq.slice(), position: p };
        }
      }
      let k = L - 1;
      while (k >= 0 && seq[k] === n - 1) {
        seq[k] = 0;
        k--;
      }
      if (k < 0) break;
      seq[k]++;
    }
  }
  return { risk: false };
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

/* ---------------- 标记校验 ---------------- */

test('validateMarker：仅接受 3–6 位 0/1 串', () => {
  assert.equal(validateMarker('011'), null);
  assert.equal(validateMarker('011010'), null);
  assert.equal(validateMarker('  0110  '), null); // 允许首尾空白
  assert.ok(validateMarker('')); // 空
  assert.ok(validateMarker('01')); // 过短
  assert.ok(validateMarker('0110101')); // 过长
  assert.ok(validateMarker('0120')); // 非法字符
  assert.ok(validateMarker('abcd'));
  assert.ok(validateMarker(null));
  for (const bad of ['01', '0110101', '012']) {
    const r = auditSyncMarker(['0', '10'], bad);
    assert.equal(r.status, 'invalid', `标记 ${bad} 应判不合规`);
    assert.ok(r.reason.length > 0);
  }
});

test('码表数据不可用时返回 error', () => {
  assert.equal(auditSyncMarker([], '011').status, 'error');
  assert.equal(auditSyncMarker(null, '011').status, 'error');
  assert.equal(auditSyncMarker(['0', '2'], '011').status, 'error');
  assert.equal(auditSyncMarker(['0', '01'], '011').status, 'error'); // 非前缀无关
});

/* ---------------- 手工核算的风险帧 ---------------- */

test('风险：标记完整落在单条码字内部', () => {
  // '0110' 内部位置 1 即含 '110'；同一帧内位置 1 与 5 均命中，应报最早的 1
  const r = auditSyncMarker(['0110', '10', '110', '001', '000'], '110');
  assert.equal(r.status, 'risk');
  assert.deepEqual(r.sequence, [0, 0]);
  assert.equal(r.stream, '01100110');
  assert.deepEqual(r.occurrence, { start: 1, end: 4 });
  assert.equal(r.spans.length, 2);
  assert.deepEqual(r.spans.map((s) => [s.start, s.end]), [[0, 4], [4, 8]]);
});

test('风险：标记横跨相邻码字', () => {
  // (0,0)='0101' 无命中；(0,1)='0110' 在位置 1 横跨两段码字命中
  const r = auditSyncMarker(['01', '10', '0011', '0000', '111'], '110');
  assert.equal(r.status, 'risk');
  assert.deepEqual(r.sequence, [0, 1]);
  assert.equal(r.stream, '0110');
  assert.deepEqual(r.occurrence, { start: 1, end: 4 });
});

test('风险：优先返回警报条数最少的帧（2 条无风险时才看 3 条）', () => {
  // '01010' 需横跨 3 条码字：仅 (1,1,1)='101010' 在位置 1 非法命中
  const codes = ['0', '10', '110', '1110', '11110'];
  const r = auditSyncMarker(codes, '01010');
  assert.equal(r.status, 'risk');
  assert.deepEqual(r.sequence, [1, 1, 1]);
  assert.equal(r.occurrence.start, 1);
});

test('边界命中属合法同步，不判风险', () => {
  // '1111' 只会作为码字 '11110' 的前缀出现在边界处
  const codes = ['0', '10', '110', '1110', '11110'];
  const r = auditSyncMarker(codes, '1111');
  assert.equal(r.status, 'clean');
  assert.equal(r.framesChecked, 12207025); // 5^2+…+5^10
  assert.equal(r.minAlerts, MIN_FRAME_ALERTS);
  assert.equal(r.maxAlerts, MAX_FRAME_ALERTS);
});

test('帧尾截断串不得作为证据', () => {
  // 所有码字均以 0 结尾：帧尾留下的 '0'/'01' 等真前缀不构成完整命中；
  // '011' 需要相邻 '11'，在该码表的任何连续帧中都不存在
  const r = auditSyncMarker(['0', '10'], '011');
  assert.equal(r.status, 'clean');
  assert.equal(r.framesChecked, 2044); // 2^2+…+2^10
});

test('完整落入帧尾（位置 len-m）的命中必须计入', () => {
  const r = auditSyncMarker(['10', '01'], '001');
  assert.equal(r.status, 'risk');
  assert.deepEqual(r.sequence, [0, 1]);
  assert.equal(r.stream, '1001');
  assert.equal(r.occurrence.start, 1); // 命中恰好在帧尾结束
  assert.equal(r.occurrence.end, 4);
});

/* ---------------- 与求解器联用 ---------------- */

test('示例码表：审计结论与暴力枚举一致', () => {
  const s = solve({
    alerts: [
      { name: '特大地震预警', freq: 3, lo: 2, hi: 6 },
      { name: '强余震警报', freq: 8, lo: 2, hi: 5 },
      { name: '海啸警报', freq: 5, lo: 2, hi: 5 },
      { name: '滑坡泥石流警报', freq: 12, lo: 1, hi: 4 },
      { name: '应急演练通知', freq: 20, lo: 1, hi: 3 },
      { name: '解除警报', freq: 15, lo: 1, hi: 4 },
    ],
    reserved: ['1110'],
  });
  assert.equal(s.status, 'optimal');
  const codes = s.alerts.map((a) => a.code);
  const r = auditSyncMarker(codes, '100');
  assert.equal(r.status, 'risk');
  assert.deepEqual(r.sequence, [0, 1]); // '1111'+'000' = '1111000'，位置 3 非边界
  assert.equal(r.stream, '1111000');
  assert.equal(r.occurrence.start, 3);
  // 该码表下每个 3–6 位标记都与暴力枚举结论一致
  for (let len = MIN_MARKER_LENGTH; len <= MAX_MARKER_LENGTH; len++) {
    for (let v = 0; v < 1 << len; v++) {
      const mk = v.toString(2).padStart(len, '0');
      const mine = auditSyncMarker(codes, mk);
      const brute = bruteAudit(codes, mk);
      assert.equal(mine.status === 'risk', brute.risk, `标记 ${mk} 风险结论不一致`);
      if (brute.risk) {
        assert.deepEqual(mine.sequence, brute.sequence, `标记 ${mk} 证据序列不一致`);
        assert.equal(mine.occurrence.start, brute.position, `标记 ${mk} 命中位置不一致`);
      }
    }
  }
});

/* ---------------- 随机对拍 ---------------- */

test('与暴力枚举对拍：随机码表与随机标记的结论及证据帧完全一致', () => {
  const rand = mulberry32(20260926);
  const pool = [];
  for (let len = 1; len <= 4; len++) {
    for (let v = 0; v < 1 << len; v++) pool.push(v.toString(2).padStart(len, '0'));
  }
  let checked = 0;
  for (let t = 0; t < 80; t++) {
    // 随机前缀无关码表（2–3 类，控制暴力枚举规模）
    const nCodes = 2 + Math.floor(rand() * 2);
    const shuffled = [...pool].sort(() => rand() - 0.5);
    const codes = [];
    for (const c of shuffled) {
      if (codes.length >= nCodes) break;
      if (codes.every((o) => !(o.startsWith(c) || c.startsWith(o)))) codes.push(c);
    }
    if (codes.length < nCodes) continue;
    const mLen = MIN_MARKER_LENGTH + Math.floor(rand() * (MAX_MARKER_LENGTH - MIN_MARKER_LENGTH + 1));
    let mk = '';
    for (let i = 0; i < mLen; i++) mk += rand() < 0.5 ? '0' : '1';
    const mine = auditSyncMarker(codes, mk);
    const brute = bruteAudit(codes, mk);
    checked++;
    assert.equal(mine.status === 'risk', brute.risk, `用例 ${t}（${codes} / ${mk}）风险结论不一致`);
    if (brute.risk) {
      assert.deepEqual(mine.sequence, brute.sequence, `用例 ${t}（${codes} / ${mk}）证据序列不一致`);
      assert.equal(mine.occurrence.start, brute.position, `用例 ${t}（${codes} / ${mk}）命中位置不一致`);
      // 证据帧自洽：命中确实落在流内且起点非边界
      assert.equal(mine.stream.startsWith(mk, mine.occurrence.start), true);
      const boundaries = new Set(mine.spans.map((s) => s.start));
      assert.ok(!boundaries.has(mine.occurrence.start));
    } else {
      assert.equal(mine.framesChecked, Array.from({ length: MAX_FRAME_ALERTS - MIN_FRAME_ALERTS + 1 },
        (_, k) => codes.length ** (MIN_FRAME_ALERTS + k)).reduce((a, b) => a + b, 0));
    }
  }
  assert.ok(checked >= 60, `有效随机用例数不足：${checked}`);
});

test('性能：8 类 12 位码 + 6 位标记在毫秒内完成', () => {
  const codes = ['0', '10', '110', '1110', '11110', '111110', '1111110', '11111110'];
  const start = performance.now();
  const r = auditSyncMarker(codes, '010101');
  const elapsed = performance.now() - start;
  assert.equal(r.status, 'risk');
  assert.ok(elapsed < 500, `耗时 ${elapsed.toFixed(1)}ms 超出预期`);
});
