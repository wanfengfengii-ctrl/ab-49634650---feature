/**
 * 同步标记隔离审计（纯逻辑，无 DOM 依赖，浏览器 / Node 通用）。
 *
 * 背景：接收设备在连续警报电文中扫描同步标记以定位新帧开头。只有标记
 * 首位恰好落在码字边界时才属合法同步；若标记能出现在某条连续电文的
 * 非边界位置（含横跨相邻码字的情形），设备即可能误判帧头，称为隔离风险。
 *
 * 审计范围：由 2–10 条警报码字首尾相接组成的全部连续帧。仅统计完整
 * 落在帧内的标记命中；帧首之前 / 帧尾之外的截断串不得作为证据。
 *
 * 结论：
 *   - 存在风险时，按 ① 警报条数最少 ② 警报序列（按输入顺序展开）字典序
 *     最小 ③ 标记命中位置最早 的次序稳定返回唯一证据帧；
 *   - 否则确认该长度范围内的全部连续帧均未在非边界处出现该标记。
 *
 * 实现：合法电文是正则语言 —— 解码自动机（状态 = 码字的真前缀，空串即
 * 码字边界）与 KMP 匹配自动机、最近 m-1 个位置的边界标志组成积自动机；
 * 用记忆化搜索精确判定"是否存在非法命中"，再按字典序逐类构造最小证据
 * 序列。复杂度与 n^L 的帧数量无关。
 */

import { isPrefixFree } from './solver.js';

export const MIN_MARKER_LENGTH = 3;
export const MAX_MARKER_LENGTH = 6;
export const MIN_FRAME_ALERTS = 2;
export const MAX_FRAME_ALERTS = 10;

/** 校验同步标记，返回中文错误信息（null 表示合规）。 */
export function validateMarker(marker) {
  const s = String(marker ?? '').trim();
  if (!/^[01]*$/.test(s)) return '同步标记只能由 0/1 组成。';
  if (s.length < MIN_MARKER_LENGTH || s.length > MAX_MARKER_LENGTH) {
    return `同步标记长度须为 ${MIN_MARKER_LENGTH}–${MAX_MARKER_LENGTH} 位（当前 ${s.length} 位）。`;
  }
  return null;
}

/**
 * 同步标记隔离审计。
 * @param {string[]} codes 各类警报的码字（按输入顺序，两两前缀无关）
 * @param {string} marker 3–6 位二进制同步标记
 * @returns 下列情形之一：
 *   { status:'invalid', reason } —— 标记不合规，不得沿用旧结论
 *   { status:'error', reason } —— 码表数据不可用
 *   { status:'clean', marker, minAlerts, maxAlerts, framesChecked }
 *   { status:'risk', marker, sequence, stream, spans, occurrence, length }
 *     sequence：警报下标序列；spans：各段码字在比特流中的区间；
 *     occurrence：非法命中的比特区间 [start, end)。
 */
export function auditSyncMarker(codes, marker) {
  const mark = String(marker ?? '').trim();
  const invalid = validateMarker(mark);
  if (invalid) return { status: 'invalid', reason: invalid };
  if (
    !Array.isArray(codes) ||
    codes.length === 0 ||
    codes.some((c) => typeof c !== 'string' || !/^[01]+$/.test(c))
  ) {
    return { status: 'error', reason: '码表数据无效，无法审计。' };
  }
  if (!isPrefixFree(codes)) {
    return { status: 'error', reason: '码字不满足前缀无关，无法审计。' };
  }

  const n = codes.length;
  const m = mark.length;
  const R = MAX_FRAME_ALERTS;

  /* -------- 解码自动机：状态 = 码字的真前缀，'' 即码字边界 -------- */
  const BOUNDARY = 0;
  const states = [''];
  const indexOf = new Map([['', BOUNDARY]]);
  for (const code of codes) {
    for (let k = 1; k < code.length; k++) {
      const p = code.slice(0, k);
      if (!indexOf.has(p)) {
        indexOf.set(p, states.length);
        states.push(p);
      }
    }
  }
  const codeSet = new Set(codes);
  const S = states.length;
  // trans[s][b] = { next, completed }；null 表示该比特不属于任何合法电文
  const trans = states.map((prefix) =>
    [0, 1].map((b) => {
      const q = prefix + b;
      if (codeSet.has(q)) return { next: BOUNDARY, completed: true };
      const idx = indexOf.get(q);
      return idx === undefined ? null : { next: idx, completed: false };
    }),
  );

  /* -------- KMP 匹配自动机 -------- */
  const pi = new Array(m).fill(0);
  for (let i = 1; i < m; i++) {
    let j = pi[i - 1];
    while (j > 0 && mark[i] !== mark[j]) j = pi[j - 1];
    if (mark[i] === mark[j]) j += 1;
    pi[i] = j;
  }
  // go[s][b]：已匹配 s 位时再读入比特 b 后的匹配长度（可达 m）
  const go = Array.from({ length: m + 1 }, () => [0, 0]);
  for (let s = 0; s <= m; s++) {
    for (const b of [0, 1]) {
      const ch = String(b);
      let j = s;
      while (j > 0 && (j === m || mark[j] !== ch)) j = pi[j - 1];
      if (mark[j] === ch) j += 1;
      go[s][b] = j;
    }
  }

  /* -------- canComplete[s][r]：从状态 s 恰好再完成 r 条码字并停在边界 -------- */
  const canComplete = Array.from({ length: S }, () => new Array(R + 1).fill(false));
  const byDepthDesc = states.map((_, i) => i).sort((a, b) => states[b].length - states[a].length);
  for (let s = 0; s < S; s++) canComplete[s][0] = s === BOUNDARY;
  for (let r = 1; r <= R; r++) {
    for (const s of byDepthDesc) {
      canComplete[s][r] = trans[s].some(
        (t) => t !== null && canComplete[t.next][r - (t.completed ? 1 : 0)],
      );
    }
  }

  /* -------- 积自动机：恰好 r 条码字内能否制造一次非法命中 -------- */
  const FLAG_BITS = m - 1; // 记录最近 m-1 个位置是否为码字边界
  const FLAG_MASK = (1 << FLAG_BITS) - 1;
  const OLDEST = FLAG_BITS - 1; // 命中起点（位置 p-m+1）所在的标志位
  const KMP_STATES = m + 1;
  const riskMemo = new Map();

  function canRisk(s, flags, kmp, r) {
    if (r === 0) return false;
    const key = (((s << FLAG_BITS) | flags) * KMP_STATES + kmp) * (R + 1) + r;
    const cached = riskMemo.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    for (let b = 0; b < 2 && !ok; b++) {
      const t = trans[s][b];
      if (t === null) continue;
      const r2 = r - (t.completed ? 1 : 0);
      if (r2 < 0) continue;
      const kmp2 = go[kmp][b];
      const matched = kmp2 === m;
      const startOnBoundary = (flags >> OLDEST) & 1; // 命中起点位置的边界标志
      const flags2 = ((flags << 1) & FLAG_MASK) | (s === BOUNDARY ? 1 : 0);
      if (matched && startOnBoundary === 0) {
        // 非法命中已完整落入电文，余下任意完整帧尾即可
        ok = canComplete[t.next][r2];
      } else {
        ok = canRisk(t.next, flags2, matched ? pi[m - 1] : kmp2, r2);
      }
    }
    riskMemo.set(key, ok);
    return ok;
  }

  /* -------- 逐类构造字典序最小的证据序列 -------- */
  // 顺序消费一条码字并推进积自动机；返回 null 表示路径非法（边界处不会发生）
  function consumeCodeword(code, st) {
    let { s, flags, kmp, risk } = st;
    for (const ch of code) {
      const b = ch === '1' ? 1 : 0;
      const t = trans[s][b];
      if (t === null) return null;
      if (!risk) {
        const kmp2 = go[kmp][b];
        if (kmp2 === m && ((flags >> OLDEST) & 1) === 0) risk = true;
        kmp = kmp2 === m ? pi[m - 1] : kmp2;
        flags = ((flags << 1) & FLAG_MASK) | (s === BOUNDARY ? 1 : 0);
      }
      s = t.next;
    }
    return { s, flags, kmp, risk };
  }

  function findWitnessFrame(L) {
    let st = { s: BOUNDARY, flags: 0, kmp: 0, risk: false };
    if (!canRisk(st.s, st.flags, st.kmp, L)) return null;
    const sequence = [];
    for (let pos = 0; pos < L; pos++) {
      const remaining = L - pos - 1;
      let chosen = -1;
      for (let i = 0; i < n; i++) {
        const cand = consumeCodeword(codes[i], st);
        if (cand === null) continue;
        const feasible = cand.risk
          ? canComplete[cand.s][remaining]
          : canRisk(cand.s, cand.flags, cand.kmp, remaining);
        if (feasible) {
          chosen = i;
          st = cand;
          break;
        }
      }
      if (chosen < 0) return null; // canRisk 前置检查保证不会到达
      sequence.push(chosen);
    }
    return st.risk ? sequence : null;
  }

  for (let L = MIN_FRAME_ALERTS; L <= MAX_FRAME_ALERTS; L++) {
    const sequence = findWitnessFrame(L);
    if (!sequence) continue;
    const stream = sequence.map((i) => codes[i]).join('');
    const spans = [];
    let offset = 0;
    for (const i of sequence) {
      spans.push({ alertIdx: i, code: codes[i], start: offset, end: offset + codes[i].length });
      offset += codes[i].length;
    }
    // 电文中最早的非法命中位置（首位不在码字边界、且完整落入帧内）
    const boundarySet = new Set(spans.map((sp) => sp.start));
    let start = -1;
    for (let p = 0; p + m <= stream.length; p++) {
      if (!boundarySet.has(p) && stream.startsWith(mark, p)) {
        start = p;
        break;
      }
    }
    if (start < 0) return { status: 'error', reason: '审计内部状态不一致。' };
    return {
      status: 'risk',
      marker: mark,
      sequence,
      stream,
      spans,
      occurrence: { start, end: start + m },
      length: stream.length,
    };
  }

  let framesChecked = 0;
  for (let L = MIN_FRAME_ALERTS; L <= MAX_FRAME_ALERTS; L++) framesChecked += n ** L;
  return {
    status: 'clean',
    marker: mark,
    minAlerts: MIN_FRAME_ALERTS,
    maxAlerts: MAX_FRAME_ALERTS,
    framesChecked,
  };
}
