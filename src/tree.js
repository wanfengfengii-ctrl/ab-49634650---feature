/**
 * 二叉码树布局（纯函数）：把码字与保留前缀组织成一棵树并计算坐标，
 * 供 UI 渲染 SVG。未展开的兄弟子树以灰色圆点占位，表示被剪除/未使用的码空间。
 */

export const SLOT_W = 40;
export const LEVEL_H = 62;
export const PAD_X = 36;
export const PAD_TOP = 30;
export const PAD_BOTTOM = 46;

/**
 * @param {Array<{code:string, name:string}>} codes 已分配码字
 * @param {Array<{prefix:string}>} reserved 保留前缀
 * @returns {{nodes:Array, edges:Array, width:number, height:number, maxDepth:number}}
 */
export function buildTreeLayout(codes, reserved) {
  const root = { prefix: '', depth: 0, type: 'root', children: new Map() };

  const ensureNode = (p) => {
    let node = root;
    for (let d = 1; d <= p.length; d++) {
      const bit = p[d - 1];
      if (!node.children.has(bit)) {
        node.children.set(bit, {
          prefix: p.slice(0, d),
          depth: d,
          type: 'internal',
          children: new Map(),
        });
      }
      node = node.children.get(bit);
    }
    return node;
  };

  for (const { code, name } of codes) {
    const node = ensureNode(code);
    node.type = 'code';
    node.label = name;
  }
  for (const { prefix } of reserved) {
    const node = ensureNode(prefix);
    node.type = 'reserved';
  }

  const nodes = [];
  const edges = [];
  let slot = 0;
  let maxDepth = 0;

  function place(node) {
    maxDepth = Math.max(maxDepth, node.depth);
    // 有任一子树被展开时，为缺失的一侧补占位圆点（左 0 右 1）。
    const entries = [];
    for (const bit of ['0', '1']) {
      const child = node.children.get(bit);
      if (child) {
        entries.push(child);
      } else if (node.children.size > 0) {
        entries.push({
          prefix: node.prefix + bit,
          depth: node.depth + 1,
          type: 'dot',
          children: new Map(),
        });
      }
    }
    if (entries.length === 0) {
      node.x = slot++;
      nodes.push(node);
      return;
    }
    for (const entry of entries) {
      edges.push({ from: node, to: entry, bit: entry.prefix.slice(-1) });
      place(entry);
    }
    node.x = (entries[0].x + entries[entries.length - 1].x) / 2;
    nodes.push(node);
  }
  place(root);

  const width = Math.max(1, slot - 1) * SLOT_W + PAD_X * 2;
  const height = maxDepth * LEVEL_H + PAD_TOP + PAD_BOTTOM;
  for (const node of nodes) {
    node.cx = PAD_X + node.x * SLOT_W;
    node.cy = PAD_TOP + node.depth * LEVEL_H;
  }
  return { nodes, edges, width, height, maxDepth };
}
