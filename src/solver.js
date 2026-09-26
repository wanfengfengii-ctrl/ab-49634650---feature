/**
 * 地震预警二进制码编配求解器（纯逻辑，无 DOM 依赖，浏览器 / Node 通用）。
 *
 * 问题：为 n 类警报（5–8）各选恰一条二进制码字，满足：
 *   1. 码字两两不得互为前缀（前缀无关 ⇒ 任意连续电文可唯一拆分）；
 *   2. 每类码字长度落在其闭区间 [lo, hi] 内；
 *   3. 码字不得"落入"保留前缀的子树（保留串是码字的前缀），
 *      也不得"遮蔽"保留前缀（码字是保留串的前缀）。
 * 目标（按优先级字典序）：
 *   ① 加权码长总和 Σ freq·len 最小；
 *   ② 最大码长最小；
 *   ③ 按警报输入顺序展开码字，逐位字典序最小（'0' < '1'，前缀短者居前）。
 *
 * 算法（两阶段精确分支限界）：
 *   阶段一在"长度元组"空间搜索最优 (总成本, 最大码长)：每类仅枚举码长，
 *   用 Kraft 容量（2^-MAX_CODE_LENGTH 为单位的整数）与容量感知的代价下界
 *   剪枝；叶子元组的可行性由带记忆化的精确分配检查判定（正确处理保留
 *   前缀的落入/遮蔽约束，纯 Kraft 不等式对此不充分）。
 *   阶段二在 成本 ≤ 最优成本、码长 ≤ 最优最大码长 的硬约束下按字典序
 *   枚举码字，首个完整分配即第三级目标下的字典序最小解。
 */

export const MIN_ALERTS = 5;
export const MAX_ALERTS = 8;
export const MAX_RESERVED = 3;
export const MAX_CODE_LENGTH = 12;
export const MAX_FREQ = 1_000_000_000;

/** 以 2^-MAX_CODE_LENGTH 为单位的码空间总容量。 */
const FULL_CAPACITY = 1 << MAX_CODE_LENGTH;

/** 长度 len 的码字占用的容量单位数。 */
function weightOf(len) {
  return 1 << (MAX_CODE_LENGTH - len);
}

/**
 * 规范化保留前缀：去空白、去重，并剔除被更短保留串覆盖的冗余项
 * （若 r 是 s 的前缀，则 s 的子树本就被 r 封禁，s 冗余）。
 */
export function normalizeReserved(reserved) {
  const seen = new Set();
  const list = [];
  for (const raw of reserved ?? []) {
    const s = String(raw ?? '').trim();
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    list.push(s);
  }
  list.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const result = [];
  for (const s of list) {
    if (!result.some((r) => s.startsWith(r))) result.push(s);
  }
  return result;
}

/** 判断一组码字是否两两互不互为前缀。 */
export function isPrefixFree(codes) {
  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (i !== j && codes[j].startsWith(codes[i])) return false;
    }
  }
  return true;
}

/** 判断码字是否与全部保留前缀前缀无关（既不落入也不遮蔽）。 */
export function reservedCompatible(code, reserved) {
  for (const r of reserved) {
    if (code.startsWith(r) || r.startsWith(code)) return false;
  }
  return true;
}

/** 校验录入参数，返回中文错误信息数组（空数组表示通过）。 */
export function validateInput(input) {
  const errors = [];
  const alerts = input?.alerts ?? [];
  const reserved = input?.reserved ?? [];

  if (alerts.length < MIN_ALERTS || alerts.length > MAX_ALERTS) {
    errors.push(`警报类别数量须为 ${MIN_ALERTS}–${MAX_ALERTS} 类，当前为 ${alerts.length} 类。`);
  }
  const names = new Set();
  alerts.forEach((a, i) => {
    const label = `第 ${i + 1} 类警报`;
    const name = String(a?.name ?? '').trim();
    if (name === '') {
      errors.push(`${label}：名称不能为空。`);
    } else if (name.length > 24) {
      errors.push(`${label}：名称「${name}」超过 24 个字符。`);
    } else if (names.has(name)) {
      errors.push(`${label}：名称「${name}」与其他类别重复。`);
    }
    names.add(name);

    if (!Number.isInteger(a?.freq) || a.freq < 1 || a.freq > MAX_FREQ) {
      errors.push(`${label}：预计发送频次须为 1–${MAX_FREQ} 的正整数。`);
    }
    const { lo, hi } = a ?? {};
    if (
      !Number.isInteger(lo) ||
      !Number.isInteger(hi) ||
      lo < 1 ||
      hi > MAX_CODE_LENGTH ||
      lo > hi
    ) {
      errors.push(`${label}：码长区间须满足 1 ≤ 下限 ≤ 上限 ≤ ${MAX_CODE_LENGTH}。`);
    }
  });

  if (!Array.isArray(reserved) || reserved.length > MAX_RESERVED) {
    errors.push(`保留前缀最多 ${MAX_RESERVED} 条，当前 ${Array.isArray(reserved) ? reserved.length : 0} 条。`);
  } else {
    reserved.forEach((r, i) => {
      const s = String(r ?? '').trim();
      if (!/^[01]+$/.test(s)) {
        errors.push(`保留前缀 #${i + 1} 须为由 0/1 组成的非空串。`);
      } else if (s.length > MAX_CODE_LENGTH) {
        errors.push(`保留前缀 #${i + 1} 长度不能超过 ${MAX_CODE_LENGTH} 位。`);
      }
    });
  }
  return errors;
}

/**
 * 求解最优码表。
 * 返回：
 *   { status: 'invalid', errors }
 *   { status: 'infeasible', reason, reserved } —— 没有可用的完整分配
 *   { status: 'optimal', alerts, reserved, cost, maxLength, kraft, exploredNodes }
 *   { status: 'error', reason } —— 安全上限触发（正常输入不会到达）
 */
export function solve(input) {
  const errors = validateInput(input);
  if (errors.length > 0) return { status: 'invalid', errors };

  const alerts = input.alerts.map((a) => ({
    name: String(a.name).trim(),
    freq: a.freq,
    lo: a.lo,
    hi: a.hi,
  }));
  const reserved = normalizeReserved(input.reserved);
  const n = alerts.length;

  const reservedWeight = reserved.reduce((sum, r) => sum + weightOf(r.length), 0);
  const initialCapacity = FULL_CAPACITY - reservedWeight;
  if (initialCapacity <= 0) {
    return {
      status: 'infeasible',
      reason: '保留前缀已占满全部码空间，任何码字都无处可放。',
      reserved,
    };
  }
  // Kraft 必要条件：全部取允许的最长码（占用最小）仍装不下 ⇒ 必无解。
  const minNeed = alerts.reduce((sum, a) => sum + weightOf(a.hi), 0);
  if (minNeed > initialCapacity) {
    return {
      status: 'infeasible',
      reason: 'Kraft 约束不满足：即使每类都取允许的最长码，剩余码空间仍装不下全部类别。',
      reserved,
    };
  }

  let exploredNodes = 0;
  const NODE_LIMIT = 6_000_000; // 安全上限，正常规模远低于此

  // 后缀量：剩余类别取最长码的最小容量需求。
  const sufMinWeight = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    sufMinWeight[i] = sufMinWeight[i + 1] + weightOf(alerts[i].hi);
  }

  /**
   * Kraft 松弛动态规划（合法下界，真实约束只会更强）：
   *   costDP[i][cap]  —— 位置 i..n-1 在剩余容量 cap 下、仅满足 Kraft 与码长区间的最小加权代价；
   *   maxLenDP[i][cap] —— 同一松弛下的最小可能最大码长。
   * 复杂度 O(n · 2^D · D)，一次性预计算供两个阶段剪枝。
   */
  const costDP = Array.from({ length: n + 1 }, () => new Float64Array(FULL_CAPACITY + 1));
  const maxLenDP = Array.from({ length: n + 1 }, () => new Float64Array(FULL_CAPACITY + 1));
  for (let i = n - 1; i >= 0; i--) {
    const a = alerts[i];
    for (let cap = 0; cap <= FULL_CAPACITY; cap++) {
      let bestCost = Infinity;
      let bestMax = Infinity;
      for (let len = a.lo; len <= a.hi; len++) {
        const w = weightOf(len);
        if (w > cap) continue;
        const restCost = costDP[i + 1][cap - w];
        if (restCost === Infinity) continue;
        const total = a.freq * len + restCost;
        if (total < bestCost) bestCost = total;
        const m = Math.max(len, maxLenDP[i + 1][cap - w]);
        if (m < bestMax) bestMax = m;
      }
      costDP[i][cap] = bestCost;
      maxLenDP[i][cap] = bestMax;
    }
  }

  /**
   * 精确可行性：给定每类码长（按位置），是否存在满足全部约束的分配。
   * 只与长度多重集合有关，调用方按多重集合记忆化。
   */
  function feasibleAssignment(lengths) {
    const order = lengths.map((_, idx) => idx).sort((x, y) => lengths[x] - lengths[y]);
    const placed = [];
    const sufW = new Array(n + 1).fill(0);
    for (let k = n - 1; k >= 0; k--) sufW[k] = sufW[k + 1] + weightOf(lengths[order[k]]);

    function* candidatesOf(len) {
      function* walk(prefix) {
        if (prefix.length === len) {
          const ok =
            reserved.every((r) => !(prefix.startsWith(r) || r.startsWith(prefix))) &&
            placed.every((a) => !(a.startsWith(prefix) || prefix.startsWith(a)));
          if (ok) yield prefix;
          return;
        }
        for (const bit of ['0', '1']) {
          const child = prefix + bit;
          const covered =
            placed.some((a) => child.startsWith(a)) ||
            reserved.some((r) => child.startsWith(r));
          if (!covered) yield* walk(child);
        }
      }
      yield* walk('');
    }

    function dfs(k, cap) {
      if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
      if (k === n) return true;
      if (sufW[k] > cap) return false;
      const len = lengths[order[k]];
      const w = weightOf(len);
      if (w > cap) return false;
      for (const code of candidatesOf(len)) {
        placed.push(code);
        if (dfs(k + 1, cap - w)) return true;
        placed.pop();
      }
      return false;
    }
    return dfs(0, initialCapacity);
  }

  /* ---------------- 阶段一：最优 (总成本, 最大码长) ---------------- */

  const feasMemo = new Map();
  let best = null;
  const lens = new Array(n);

  function dfsLengths(i, cap, cost, maxLen) {
    if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
    if (best && (cost > best.cost || (cost === best.cost && maxLen >= best.maxLen))) return;
    if (i === n) {
      const key = lens.slice().sort((x, y) => x - y).join(',');
      let feas = feasMemo.get(key);
      if (feas === undefined) {
        feas = feasibleAssignment(lens);
        feasMemo.set(key, feas);
      }
      if (feas && (!best || cost < best.cost || (cost === best.cost && maxLen < best.maxLen))) {
        best = { cost, maxLen };
      }
      return;
    }
    if (sufMinWeight[i] > cap) return;
    const lowerBound = cost + costDP[i][cap];
    if (
      best &&
      (lowerBound > best.cost ||
        (lowerBound === best.cost && Math.max(maxLen, maxLenDP[i][cap]) >= best.maxLen))
    ) {
      return;
    }
    const a = alerts[i];
    for (let len = a.lo; len <= a.hi; len++) {
      const w = weightOf(len);
      if (w > cap) continue;
      lens[i] = len;
      dfsLengths(i + 1, cap - w, cost + a.freq * len, Math.max(maxLen, len));
    }
  }

  /* -------- 阶段二：成本/码长硬约束下字典序最小的具体分配 -------- */

  const assigned = [];
  let found = null;

  function* codeCandidates(lo, hi) {
    function* walk(prefix) {
      const depth = prefix.length;
      if (
        depth >= lo &&
        !assigned.some((a) => a.startsWith(prefix)) &&
        !reserved.some((r) => r.startsWith(prefix))
      ) {
        yield prefix;
      }
      if (depth < hi) {
        for (const bit of ['0', '1']) {
          const child = prefix + bit;
          const covered =
            assigned.some((a) => child.startsWith(a)) ||
            reserved.some((r) => child.startsWith(r));
          if (!covered) yield* walk(child);
        }
      }
    }
    yield* walk('');
  }

  function dfsCodes(i, cap, cost) {
    if (found) return;
    if (++exploredNodes > NODE_LIMIT) throw new Error('search_limit_exceeded');
    if (cost > best.cost) return;
    if (i === n) {
      found = assigned.slice(); // 代价不可能低于最优 ⇒ 即字典序最小的最优分配
      return;
    }
    if (sufMinWeight[i] > cap) return;
    if (cost + costDP[i][cap] > best.cost) return;
    const a = alerts[i];
    const hiCap = Math.min(a.hi, best.maxLen);
    for (const code of codeCandidates(a.lo, hiCap)) {
      const w = weightOf(code.length);
      if (w > cap) continue;
      if (cost + a.freq * code.length > best.cost) continue;
      assigned.push(code);
      dfsCodes(i + 1, cap - w, cost + a.freq * code.length);
      assigned.pop();
      if (found) return;
    }
  }

  try {
    dfsLengths(0, initialCapacity, 0, 0);
    if (best) dfsCodes(0, initialCapacity, 0);
  } catch (err) {
    if (err.message === 'search_limit_exceeded') {
      return { status: 'error', reason: '搜索规模超出安全上限，请收紧码长区间后重试。' };
    }
    throw err;
  }

  if (!best || !found) {
    return {
      status: 'infeasible',
      reason: '在码长区间与保留前缀的约束下，不存在满足前缀无关条件的完整分配。',
      reserved,
    };
  }

  const resultAlerts = alerts.map((a, i) => ({
    name: a.name,
    freq: a.freq,
    code: found[i],
    length: found[i].length,
    contribution: a.freq * found[i].length,
  }));
  const kraftCodes = found.reduce((sum, c) => sum + weightOf(c.length), 0);
  return {
    status: 'optimal',
    alerts: resultAlerts,
    reserved: reserved.map((r) => ({ prefix: r, length: r.length, weight: weightOf(r.length) })),
    cost: best.cost,
    maxLength: best.maxLen,
    kraft: {
      unit: FULL_CAPACITY,
      codes: kraftCodes,
      reserved: reservedWeight,
      free: FULL_CAPACITY - reservedWeight - kraftCodes,
    },
    exploredNodes,
  };
}
