/**
 * 同步标记隔离审计（纯逻辑，无 DOM 依赖，浏览器 / Node 通用）。
 *
 * 背景：接收设备靠同步标记 M（3–6 位）识别新帧开头。连续警报电文由若干
 * 码字直接拼接而成，必须确认 M 不会在"非码字边界"位置出现——无论该次出现
 * 完全落在单个码字内部，还是跨越相邻码字的边界。标记首位恰在码字边界
 * （含帧首）才算合法同步；需要码表前后端之外比特的截断串（帧前/帧后）
 * 不作为任何证据。
 *
 * 审计范围：由 2–10 类警报（允许重复）组成的全部连续序列。
 *
 * 风险帧的稳定选取次序：
 *   ① 警报条数 k 最小；
 *   ② 按警报输入顺序（输入序号小者居前）展开的序列字典序最小；
 *   ③ 标记在电文中出现位置最早（0 起算）。
 *
 * 搜索方法：
 *   - KMP 自动机状态 s（已匹配 M 的前缀长度）逐比特扫描，完整匹配后按
 *     M 的真前缀 border 回退，因此重叠出现（如 M='000' 扫 '0000'）不漏报；
 *   - 额外维护最近 m 个比特位置的"是否码字边界"位掩码（滚动 m 位），
 *     匹配完成时查看起始位（age m-1）的边界标志，即可在 O(1) 判定该次
 *     出现是合法同步还是误同步；跨码字出现自然被同一机制覆盖；
 *   - 在"码字边界状态"上做带记忆化的可达性分析 canRisk(s,hist,b,left)
 *     （b = 已扫描比特数，仅用于排除起点在帧首之前的截断串），再以
 *     警报序号升序 DFS，按上述次序取第一条风险帧。
 */

export const MIN_MARKER_LENGTH = 3;
export const MAX_MARKER_LENGTH = 6;
export const MIN_FRAME_ALERTS = 2;
export const MAX_FRAME_ALERTS = 10;

/** 校验同步标记录入，返回中文错误信息（null 表示合规）。 */
export function validateMarker(marker) {
  const s = String(marker ?? '').trim();
  if (s === '') return '请录入同步标记（3–6 位二进制串）。';
  if (!/^[01]+$/.test(s)) return '同步标记须为仅由 0/1 组成的二进制串。';
  if (s.length < MIN_MARKER_LENGTH || s.length > MAX_MARKER_LENGTH) {
    return `同步标记长度须为 ${MIN_MARKER_LENGTH}–${MAX_MARKER_LENGTH} 位，当前为 ${s.length} 位。`;
  }
  return null;
}

/**
 * 执行同步标记隔离审计。
 * @param {{status:string, alerts:Array<{name:string, code:string}>}} codeTable
 *        solve() 的 optimal 结果（调用方须保证其仍有效）
 * @param {string} rawMarker 调度员录入的原始标记
 * @returns 之一：
 *   { status:'invalid-marker', error, marker }
 *   { status:'safe', marker, sequencesCovered:bigint, memoStates }
 *   { status:'risk', marker, count, position, bits, boundaries, path,
 *     markerStart, markerEnd, startPathIndex, startOffset,
 *     endPathIndex, endOffset, spansBoundary, touchedAlertIndexes,
 *     touchedPathIndexes, memoStates }
 */
export function auditSyncMarker(codeTable, rawMarker) {
  const marker = String(rawMarker ?? '').trim();
  const error = validateMarker(marker);
  if (error) return { status: 'invalid-marker', error, marker };

  if (!codeTable || codeTable.status !== 'optimal' || !Array.isArray(codeTable.alerts)) {
    return { status: 'invalid-marker', error: '码表尚未生成或已失效，请先生成仍有效的码表。', marker };
  }
  const alerts = codeTable.alerts;
  const n = alerts.length;
  const codes = alerts.map((a) => a.code);

  const m = marker.length;
  const HIST_SIZE = 1 << m; // 最近 m 个位置的边界标志位掩码
  const HIST_MASK = HIST_SIZE - 1;
  const MAX_BITS = MAX_FRAME_ALERTS * 12; // 码长上限 12，帧最长 120 位

  // KMP 前缀函数
  const pi = new Array(m).fill(0);
  for (let i = 1; i < m; i++) {
    let j = pi[i - 1];
    while (j > 0 && marker[i] !== marker[j]) j = pi[j - 1];
    if (marker[i] === marker[j]) j++;
    pi[i] = j;
  }
  // go[s][b]：当前已匹配长度 s（0..m-1），读到比特 b 后的新匹配长度
  const go = Array.from({ length: m }, () => [0, 0]);
  for (let s = 0; s < m; s++) {
    for (const bit of ['0', '1']) {
      let j = s;
      while (j > 0 && marker[j] !== bit) j = pi[j - 1];
      if (marker[j] === bit) j++;
      go[s][bit === '1' ? 1 : 0] = j;
    }
  }

  /**
   * 从码字边界状态出发扫描一条码字。
   * 历史位掩码约定：读入位置 q 的比特后，hist 的第 a 位表示位置 q-a 是否
   * 为码字边界（a=0 即当前位）。匹配完成时起点年龄为 m-1。
   * 一旦发现起点在帧内且非边界的标记出现，立即返回（扫描自左向右，
   * 首个即该码字内最早位置）；否则返回新边界状态。
   */
  function scanWord(s, hist, b, code) {
    for (let d = 0; d < code.length; d++) {
      const q = b + d;
      hist = ((hist << 1) | (d === 0 ? 1 : 0)) & HIST_MASK;
      s = go[s][code.charCodeAt(d) - 48];
      if (s === m) {
        const start = q - m + 1;
        const atBoundary = (hist & (1 << (m - 1))) !== 0;
        s = pi[m - 1]; // 完整匹配后按真前缀 border 回退，继续捕捉重叠匹配
        if (start >= 0 && !atBoundary) {
          return { risk: true, position: start, s, hist };
        }
      }
    }
    return { risk: false, s, hist, b: b + code.length };
  }

  /* ---- 可达性记忆化：left 条码字之内是否可能出现误同步 ---- */
  const memo = new Map();
  const B_STRIDE = MAX_BITS + 1;
  const LEFT_STRIDE = MAX_FRAME_ALERTS + 1;
  const memoKey = (s, hist, b, left) =>
    (((s * HIST_SIZE + hist) * B_STRIDE + b) * LEFT_STRIDE + left);

  function canRisk(s, hist, b, left) {
    if (left <= 0) return false;
    const key = memoKey(s, hist, b, left);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    for (let i = 0; i < n; i++) {
      const r = scanWord(s, hist, b, codes[i]);
      if (r.risk || canRisk(r.s, r.hist, r.b, left - 1)) {
        memo.set(key, true);
        return true;
      }
    }
    memo.set(key, false);
    return false;
  }

  /* ---- 按 k 升序、序号字典序升序 DFS，取第一条风险帧 ---- */
  const path = [];
  let answer = null;

  for (let k = MIN_FRAME_ALERTS; k <= MAX_FRAME_ALERTS && !answer; k++) {
    if (!canRisk(0, 0, 0, k)) continue;
    // 同一 (深度, 边界状态) 经字典序更小的前缀首次到达时若无所获，
    // 后续更大前缀到达同一状态也不可能有所获（未来只取决于该状态）。
    const visited = new Set();

    function dfs(d, s, hist, b) {
      if (!canRisk(s, hist, b, k - d)) return false;
      // 同一深度的相同边界状态只从字典序最小的前缀重建一次：
      // 后续更大前缀到达同一状态时，其任何风险续接在小前缀处同样存在。
      const stateKey = ((s * HIST_SIZE + hist) * B_STRIDE + b) * (MAX_FRAME_ALERTS + 1) + d;
      if (visited.has(stateKey)) return false;
      visited.add(stateKey);
      for (let i = 0; i < n; i++) {
        const r = scanWord(s, hist, b, codes[i]);
        path.push(i);
        if (r.risk) {
          // 风险可能出现在帧的前缀条码字内：序列仍须补足到 k 条，
          // 续接不改变该次出现，取字典序最小的全 0（警报序号 0）续接。
          while (path.length < k) path.push(0);
          answer = { k, path: path.slice(), position: r.position };
          return true;
        }
        if (dfs(d + 1, r.s, r.hist, r.b)) return true;
        path.pop();
      }
      return false;
    }
    dfs(0, 0, 0, 0);
  }

  if (!answer) {
    // 覆盖的连续序列总数：n^2 + n^3 + … + n^10
    let covered = 0n;
    let term = 1n;
    for (let k = 1; k <= MAX_FRAME_ALERTS; k++) {
      term *= BigInt(n);
      if (k >= MIN_FRAME_ALERTS) covered += term;
    }
    return {
      status: 'safe',
      marker,
      sequencesCovered: covered,
      frameRange: [MIN_FRAME_ALERTS, MAX_FRAME_ALERTS],
      memoStates: memo.size,
    };
  }

  /* ---- 组装证据帧 ---- */
  const { k: count, path: idxPath, position } = answer;
  const boundaries = [0];
  for (const idx of idxPath) boundaries.push(boundaries[boundaries.length - 1] + codes[idx].length);
  const bits = idxPath.map((idx) => codes[idx]).join('');
  const end = position + m - 1;

  const locate = (q) => {
    let j = 0;
    while (j + 1 < boundaries.length && boundaries[j + 1] <= q) j++;
    return { pathIndex: j, offset: q - boundaries[j] };
  };
  const startLoc = locate(position);
  const endLoc = locate(end);
  const touchedPathIndexes = [];
  for (let t = startLoc.pathIndex; t <= endLoc.pathIndex; t++) touchedPathIndexes.push(t);
  const touchedAlertIndexes = [...new Set(touchedPathIndexes.map((t) => idxPath[t]))].sort(
    (a, b) => a - b,
  );

  return {
    status: 'risk',
    marker,
    count,
    position, // 0 起算的电文位位置
    markerStart: position,
    markerEnd: end,
    bits,
    boundaries, // 长度 count+1，含帧尾
    path: idxPath.map((alertIndex, t) => ({
      order: t,
      alertIndex,
      name: alerts[alertIndex].name,
      code: codes[alertIndex],
      start: boundaries[t],
      end: boundaries[t + 1],
    })),
    startPathIndex: startLoc.pathIndex,
    startOffset: startLoc.offset,
    endPathIndex: endLoc.pathIndex,
    endOffset: endLoc.offset,
    spansBoundary: startLoc.pathIndex !== endLoc.pathIndex,
    touchedAlertIndexes,
    touchedPathIndexes,
    frameRange: [MIN_FRAME_ALERTS, MAX_FRAME_ALERTS],
    memoStates: memo.size,
  };
}
