import {
  solve,
  MIN_ALERTS,
  MAX_ALERTS,
  MAX_RESERVED,
  MAX_CODE_LENGTH,
} from './solver.js';
import { buildTreeLayout } from './tree.js';
import { auditSyncMarker } from './audit.js';

const SAMPLE = {
  alerts: [
    { name: '特大地震预警', freq: '3', lo: '2', hi: '6' },
    { name: '强余震警报', freq: '8', lo: '2', hi: '5' },
    { name: '海啸警报', freq: '5', lo: '2', hi: '5' },
    { name: '滑坡泥石流警报', freq: '12', lo: '1', hi: '4' },
    { name: '应急演练通知', freq: '20', lo: '1', hi: '3' },
    { name: '解除警报', freq: '15', lo: '1', hi: '4' },
  ],
  reserved: ['1110'],
};

const EMPTY_ALERT = () => ({ name: '', freq: '', lo: '', hi: '' });

const state = {
  alerts: structuredClone(SAMPLE.alerts),
  reserved: [...SAMPLE.reserved],
};

const $ = (sel) => document.querySelector(sel);
const alertRowsEl = $('#alert-rows');
const reservedRowsEl = $('#reserved-rows');
const errorsEl = $('#errors');
const resultsEl = $('#results');
const auditResultsEl = $('#audit-results');
const auditMarkerEl = $('#audit-marker');
const auditRunEl = $('#audit-run');

// currentResult：当前"已生成且仍有效"的 optimal 码表；草稿任何变动立即置空。
// auditResult：最近一次审计结论，仅在 currentResult 与标记均未变化时有效。
let currentResult = null;
let auditResult = null;

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ---------------- 输入区渲染 ---------------- */

function renderAlertRows() {
  const canRemove = state.alerts.length > MIN_ALERTS;
  const rows = state.alerts
    .map(
      (a, i) => `
      <tr>
        <td class="idx">${i + 1}</td>
        <td><input type="text" data-idx="${i}" data-field="name" value="${esc(a.name)}"
             placeholder="警报名称" maxlength="24"></td>
        <td><input type="number" data-idx="${i}" data-field="freq" value="${esc(a.freq)}"
             min="1" step="1" placeholder="正整数"></td>
        <td><input type="number" data-idx="${i}" data-field="lo" value="${esc(a.lo)}"
             min="1" max="${MAX_CODE_LENGTH}" step="1"></td>
        <td><input type="number" data-idx="${i}" data-field="hi" value="${esc(a.hi)}"
             min="1" max="${MAX_CODE_LENGTH}" step="1"></td>
        <td><button type="button" class="btn small danger" data-remove-alert="${i}"
             ${canRemove ? '' : 'disabled'} title="删除此类别">删除</button></td>
      </tr>`,
    )
    .join('');
  alertRowsEl.innerHTML = `
    <table class="grid">
      <thead>
        <tr>
          <th>#</th><th>警报名称</th><th>预计发送频次</th>
          <th>码长下限</th><th>码长上限</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  $('#add-alert').disabled = state.alerts.length >= MAX_ALERTS;
  $('#alert-count').textContent = `${state.alerts.length} / ${MAX_ALERTS} 类（至少 ${MIN_ALERTS} 类）`;
}

function renderReservedRows() {
  reservedRowsEl.innerHTML =
    state.reserved.length === 0
      ? '<p class="hint">暂无保留前缀，可添加 0–3 条。</p>'
      : state.reserved
          .map(
            (r, i) => `
        <div class="reserved-row">
          <span class="idx">#${i + 1}</span>
          <input type="text" data-reserved-idx="${i}" value="${esc(r)}"
                 placeholder="如 0110（1–${MAX_CODE_LENGTH} 位 0/1）" pattern="[01]+" spellcheck="false">
          <button type="button" class="btn small danger" data-remove-reserved="${i}">删除</button>
        </div>`,
          )
          .join('');
  $('#add-reserved').disabled = state.reserved.length >= MAX_RESERVED;
}

function renderForm() {
  renderAlertRows();
  renderReservedRows();
}

/* ---------------- 结论失效 ---------------- */

function invalidateResults(message = '输入已变更，旧结论已失效，请重新生成码表。') {
  currentResult = null;
  auditResult = null;
  resultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
  renderAuditStale('码表已失效：请重新生成码表后再发起审计，旧审计结论不再沿用。');
  setAuditEnabled(false);
}

function setAuditEnabled(enabled) {
  auditRunEl.disabled = !enabled;
}

function invalidateAudit(message = '同步标记已修改，旧审计结论已失效，请重新发起审计。') {
  auditResult = null;
  auditResultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
  if (currentResult && currentResult.status === 'optimal') renderResult(currentResult);
}

function clearErrors() {
  errorsEl.hidden = true;
  errorsEl.innerHTML = '';
}

function showErrors(errors) {
  errorsEl.hidden = false;
  errorsEl.innerHTML = `<strong>参数未通过校验：</strong><ul>${
    errors.map((e) => `<li>${esc(e)}</li>`).join('')
  }</ul>`;
}

/* ---------------- 结果区渲染 ---------------- */

function renderBanner(result) {
  if (result.status === 'optimal') {
    return `<div class="banner ok">✓ 已找到最优码表：总加权码长 <b>${result.cost}</b>，最大码长 <b>${result.maxLength}</b>。</div>`;
  }
  if (result.status === 'error') {
    return `<div class="banner fail">✗ 求解中断。<p>${esc(result.reason ?? '')}</p></div>`;
  }
  const reason = result.reason ? `<p>${esc(result.reason)}</p>` : '';
  return `<div class="banner fail">✗ 没有可用的完整分配。${reason}</div>`;
}

function renderStats(result) {
  const { kraft } = result;
  return `
    <div class="stats">
      <div class="stat"><span class="stat-label">总加权码长（总成本）</span><span class="stat-value">${result.cost}</span></div>
      <div class="stat"><span class="stat-label">最大码长</span><span class="stat-value">${result.maxLength}</span></div>
      <div class="stat"><span class="stat-label">码字占用码空间</span><span class="stat-value">${kraft.codes} / ${kraft.unit}</span></div>
      <div class="stat"><span class="stat-label">保留分支占用</span><span class="stat-value">${kraft.reserved} / ${kraft.unit}</span></div>
      <div class="stat"><span class="stat-label">剩余空闲</span><span class="stat-value">${kraft.free} / ${kraft.unit}</span></div>
    </div>`;
}

function renderDetailTable(result, audit) {
  const touched =
    audit && audit.status === 'risk' ? new Set(audit.touchedAlertIndexes) : null;
  const rows = result.alerts
    .map(
      (a, i) => `
      <tr class="${touched && touched.has(i) ? 'audit-row-hit' : ''}">
        <td class="idx">${i + 1}</td>
        <td>${esc(a.name)}${touched && touched.has(i) ? '<span class="audit-badge">审计涉及</span>' : ''}</td>
        <td><code class="code">${esc(a.code)}</code></td>
        <td>${a.length}</td>
        <td>${a.freq}</td>
        <td>${a.freq} × ${a.length} = <b>${a.contribution}</b></td>
      </tr>`,
    )
    .join('');
  return `
    <h3>码字明细</h3>
    <table class="grid detail">
      <thead>
        <tr><th>#</th><th>警报</th><th>码字</th><th>码长</th><th>频次</th><th>加权贡献</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="5">总成本（加权码长总和）</td><td><b>${result.cost}</b></td></tr>
      </tfoot>
    </table>`;
}

function renderReserved(result) {
  if (!result.reserved || result.reserved.length === 0) {
    return '<h3>保留分支</h3><p class="hint">未设置保留前缀。</p>';
  }
  const rows = result.reserved
    .map(
      (r) => `
      <tr>
        <td><code class="code reserved">${esc(r.prefix)}</code></td>
        <td>${r.length}</td>
        <td>2<sup>-${r.length}</sup> = ${r.weight} / ${result.kraft.unit}</td>
        <td>该前缀的子树整体封禁，码字既不落入也不遮蔽</td>
      </tr>`,
    )
    .join('');
  return `
    <h3>保留分支</h3>
    <table class="grid detail">
      <thead><tr><th>保留前缀</th><th>长度</th><th>占用码空间</th><th>约束</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function truncate(s, n = 6) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function renderTree(result, audit) {
  const { nodes, edges, width, height } = buildTreeLayout(
    result.alerts.map((a) => ({ code: a.code, name: a.name })),
    result.reserved ?? [],
  );
  const touched =
    audit && audit.status === 'risk'
      ? new Set(
          audit.touchedAlertIndexes.map((i) => result.alerts[i].code),
        )
      : null;

  const edgeSvg = edges
    .map((e) => {
      const mx = (e.from.cx + e.to.cx) / 2;
      const my = (e.from.cy + e.to.cy) / 2;
      return `
        <line x1="${e.from.cx}" y1="${e.from.cy}" x2="${e.to.cx}" y2="${e.to.cy}" class="edge"/>
        <text x="${mx}" y="${my - 3}" class="edge-bit">${e.bit}</text>`;
    })
    .join('');

  const nodeSvg = nodes
    .map((n) => {
      if (n.type === 'dot') {
        return `<circle cx="${n.cx}" cy="${n.cy}" r="2.6" class="dot"><title>未使用的子树</title></circle>`;
      }
      if (n.type === 'code') {
        const hit = touched && touched.has(n.prefix);
        return `
          <g class="node code-node${hit ? ' audit-hit' : ''}">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>${esc(n.label)}：${esc(n.prefix)}${hit ? '（审计涉及）' : ''}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">${esc(truncate(n.label))}</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      if (n.type === 'reserved') {
        return `
          <g class="node reserved-node">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>保留前缀：${esc(n.prefix)}</title></circle>
            <text x="${n.cx}" y="${n.cy + 26}" class="node-label">保留</text>
            <text x="${n.cx}" y="${n.cy + 40}" class="node-code">${esc(n.prefix)}</text>
          </g>`;
      }
      const label = n.type === 'root' ? '根' : '';
      return `
        <g class="node internal-node">
          <circle cx="${n.cx}" cy="${n.cy}" r="8"><title>前缀 ${n.prefix === '' ? 'ε（空）' : esc(n.prefix)}</title></circle>
          ${label ? `<text x="${n.cx}" y="${n.cy - 14}" class="node-label">${label}</text>` : ''}
        </g>`;
    })
    .join('');

  return `
    <h3>二叉码树</h3>
    <p class="hint">绿节点为已分配码字，红节点为保留分支，灰点为未使用的子树；边标注 0/1。</p>
    <div class="tree-wrap">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           role="img" aria-label="二叉码树">
        ${edgeSvg}${nodeSvg}
      </svg>
    </div>`;
}

function renderResult(result) {
  if (result.status === 'optimal') {
    resultsEl.innerHTML = `
      ${renderBanner(result)}
      ${renderStats(result)}
      ${renderTree(result, auditResult)}
      ${renderDetailTable(result, auditResult)}
      ${renderReserved(result)}
      <p class="hint">搜索节点数：${result.exploredNodes}。码字两两前缀无关，任意连续电文均可按前缀码唯一拆分。${
        auditResult ? '码树与明细中已标示最近一次隔离审计涉及的码字。' : ''
      }</p>`;
  } else {
    // infeasible / error：明确说明没有可用的完整分配
    const reservedInfo =
      result.reserved && result.reserved.length > 0
        ? `<p class="hint">当前保留前缀：${result.reserved
            .map((r) => `<code class="code reserved">${esc(typeof r === 'string' ? r : r.prefix)}</code>`)
            .join('、')}</p>`
        : '';
    resultsEl.innerHTML = `${renderBanner(result)}${reservedInfo}`;
  }
}

/* ---------------- 同步标记隔离审计 ---------------- */

function renderAuditStale(message) {
  auditResultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
}

function renderBitStream(a) {
  const { markerStart, markerEnd, path } = a;
  const words = path
    .map((seg, t) => {
      const cells = [...seg.code]
        .map((bit, d) => {
          const q = seg.start + d;
          const inMarker = q >= markerStart && q <= markerEnd;
          const cls =
            'bit' + (inMarker ? (q === markerStart ? ' marker-start' : ' marker') : '');
          return `<span class="${cls}" title="位 ${q}">${bit}</span>`;
        })
        .join('');
      const touched = t >= a.startPathIndex && t <= a.endPathIndex;
      return `<span class="word${touched ? ' touched' : ''}" title="第 ${t + 1} 条：${esc(seg.name)}（输入序号 ${seg.alertIndex + 1}）">${cells}</span>`;
    })
    .join('<span class="word-boundary" title="码字边界">│</span>');
  return `<div class="bitstream" role="img" aria-label="证据帧完整比特流">${words}</div>`;
}

function renderAuditRisk(a) {
  const spanNote = a.spansBoundary
    ? `标记<b>跨越了第 ${a.startPathIndex + 1} 条与第 ${a.endPathIndex + 1} 条码字的边界</b>。`
    : `标记完全落在第 ${a.startPathIndex + 1} 条码字内部（码字内偏移 ${a.startOffset}）。`;
  const pathRows = a.path
    .map((seg, t) => {
      const touched = t >= a.startPathIndex && t <= a.endPathIndex;
      return `
        <tr class="${touched ? 'audit-row-hit' : ''}">
          <td class="idx">${t + 1}</td>
          <td>${esc(seg.name)}<span class="hint">（输入序号 ${seg.alertIndex + 1}）</span></td>
          <td><code class="code">${esc(seg.code)}</code></td>
          <td>[${seg.start}, ${seg.end})</td>
          <td>${touched ? '<b>涉及标记</b>' : '—'}</td>
        </tr>`;
    })
    .join('');
  return `
    <div class="banner fail">✗ 发现误同步风险：标记 <code class="code audit-marker-code">${esc(a.marker)}</code>
      在一条 ${a.count} 条警报的连续帧中，于电文第 <b>${a.position}</b> 位（0 起算）处出现，
      该位置<b>不是码字边界</b>，接收设备可能把它误判为新帧开头。</div>
    <h3>证据帧完整比特流</h3>
    <p class="hint">高亮位为同步标记（${esc(a.marker)}，第 ${a.markerStart}–${a.markerEnd} 位）；
      竖线为码字边界；只有标记首位落在边界（帧首或竖线后）才是合法同步。${spanNote}
      帧首之前 / 帧尾之后需要截断串才能形成的出现均不计入证据。</p>
    ${renderBitStream(a)}
    <h3>涉及的警报路径（按发送顺序）</h3>
    <table class="grid detail">
      <thead><tr><th>帧内序号</th><th>警报</th><th>码字</th><th>电文比特区间</th><th>标记涉及</th></tr></thead>
      <tbody>${pathRows}</tbody>
    </table>`;
}

function renderAuditSafe(a) {
  const [lo, hi] = a.frameRange;
  return `
    <div class="banner ok">✓ 隔离审计通过：在 ${lo}–${hi} 条警报的全部连续帧
      （共 ${a.sequencesCovered.toString()} 条序列，允许警报重复）中，
      标记 <code class="code audit-marker-code">${esc(a.marker)}</code>
      从未在<b>非码字边界</b>位置出现——既未在任何码字内部出现，也未跨越相邻码字边界出现。</div>
    <p class="hint">码表前后端之外的截断串未纳入证据；标记首位恰在码字边界（含帧首）的出现为合法帧同步，不属于风险。</p>`;
}

function onAudit() {
  if (!currentResult || currentResult.status !== 'optimal') {
    renderAuditStale('码表尚未生成或已失效：请先在上方生成仍有效的码表。');
    return;
  }
  const r = auditSyncMarker(currentResult, auditMarkerEl.value);
  if (r.status === 'invalid-marker') {
    auditResult = null;
    renderAuditStale(`同步标记不合规：${esc(r.error)} 旧审计结论不得沿用。`);
    renderResult(currentResult); // 去掉码树/明细上可能存在的旧关联标示
    return;
  }
  auditResult = r;
  auditResultsEl.innerHTML =
    r.status === 'risk' ? renderAuditRisk(r) : renderAuditSafe(r);
  renderResult(currentResult); // 在现有二叉码树与明细中作关联标示
}

/* ---------------- 收集与求解 ---------------- */

function parseIntStrict(s) {
  const t = String(s).trim();
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

function collectInput() {
  return {
    alerts: state.alerts.map((a) => ({
      name: a.name.trim(),
      freq: parseIntStrict(a.freq),
      lo: parseIntStrict(a.lo),
      hi: parseIntStrict(a.hi),
    })),
    // 空白的保留前缀行视为未填写
    reserved: state.reserved.map((r) => r.trim()).filter((r) => r !== ''),
  };
}

function onSolve() {
  const result = solve(collectInput());
  if (result.status === 'invalid') {
    showErrors(result.errors);
    invalidateResults('参数未通过校验，旧结论已清除。');
    return;
  }
  clearErrors();
  currentResult = result.status === 'optimal' ? result : null;
  auditResult = null;
  setAuditEnabled(result.status === 'optimal');
  renderResult(result);
  if (result.status !== 'optimal') {
    renderAuditStale('当前码表不可用（无完整分配或求解中断），无法发起审计；修订码表参数后重新生成即可继续。');
  } else {
    renderAuditStale('新码表已生成，旧审计结论已清除；请录入同步标记并发起审计。');
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#solve').addEventListener('click', onSolve);
  auditRunEl.addEventListener('click', onAudit);
  auditMarkerEl.addEventListener('input', () => {
    if (auditResult) invalidateAudit();
  });
  auditMarkerEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') onAudit();
  });

  $('#add-alert').addEventListener('click', () => {
    if (state.alerts.length >= MAX_ALERTS) return;
    state.alerts.push(EMPTY_ALERT());
    renderAlertRows();
    invalidateResults();
  });
  $('#add-reserved').addEventListener('click', () => {
    if (state.reserved.length >= MAX_RESERVED) return;
    state.reserved.push('');
    renderReservedRows();
    invalidateResults();
  });
  $('#load-sample').addEventListener('click', () => {
    state.alerts = structuredClone(SAMPLE.alerts);
    state.reserved = [...SAMPLE.reserved];
    renderForm();
    clearErrors();
    invalidateResults('已载入示例参数，请点击「生成码表」。');
  });
  $('#reset').addEventListener('click', () => {
    state.alerts = Array.from({ length: MIN_ALERTS }, EMPTY_ALERT);
    state.reserved = [];
    renderForm();
    clearErrors();
    invalidateResults('已清空，请录入参数后生成码表。');
  });

  // 任何输入变动都会使旧结论失效
  $('#input-panel').addEventListener('input', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.dataset.idx !== undefined && t.dataset.field) {
      state.alerts[Number(t.dataset.idx)][t.dataset.field] = t.value;
    } else if (t.dataset.reservedIdx !== undefined) {
      state.reserved[Number(t.dataset.reservedIdx)] = t.value;
    }
    invalidateResults();
  });

  $('#input-panel').addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.removeAlert !== undefined) {
      state.alerts.splice(Number(t.dataset.removeAlert), 1);
      renderAlertRows();
      invalidateResults();
    } else if (t.dataset.removeReserved !== undefined) {
      state.reserved.splice(Number(t.dataset.removeReserved), 1);
      renderReservedRows();
      invalidateResults();
    }
  });
}

renderForm();
bindEvents();
invalidateResults('配置左侧参数后，点击「生成码表」。');
