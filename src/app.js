import {
  solve,
  MIN_ALERTS,
  MAX_ALERTS,
  MAX_RESERVED,
  MAX_CODE_LENGTH,
} from './solver.js';
import { buildTreeLayout } from './tree.js';
import {
  auditSyncMarker,
  validateMarker,
  MIN_FRAME_ALERTS,
  MAX_FRAME_ALERTS,
} from './audit.js';

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
  marker: '', // 同步标记本地草稿
  audit: null, // 当前展示的审计结论 { marker, outcome }，与 lastResult 绑定
};

/** 当前仍有效的码表（status === 'optimal' 的求解结果）；任何输入变动都会将其清空。 */
let lastResult = null;

const $ = (sel) => document.querySelector(sel);
const alertRowsEl = $('#alert-rows');
const reservedRowsEl = $('#reserved-rows');
const errorsEl = $('#errors');
const resultsEl = $('#results');
const auditPanelEl = $('#audit-panel');
const markerInputEl = $('#sync-marker');
const auditOutputEl = $('#audit-output');

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
  lastResult = null;
  state.audit = null;
  auditPanelEl.hidden = true;
  auditOutputEl.innerHTML = '';
  resultsEl.innerHTML = `<p class="placeholder stale">${esc(message)}</p>`;
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

function renderDetailTable(result, auditHits = null) {
  const rows = result.alerts
    .map(
      (a, i) => `
      <tr${auditHits?.has(i) ? ' class="audit-hit"' : ''} data-alert-idx="${i}">
        <td class="idx">${i + 1}</td>
        <td>${esc(a.name)}</td>
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

function renderTree(result, auditHits = null) {
  const { nodes, edges, width, height } = buildTreeLayout(
    result.alerts.map((a, i) => ({ code: a.code, name: a.name, idx: i })),
    result.reserved ?? [],
  );

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
        const hit = auditHits?.has(n.alertIdx) ?? false;
        return `
          <g class="node code-node${hit ? ' audit-hit' : ''}" data-alert-idx="${n.alertIdx}">
            <circle cx="${n.cx}" cy="${n.cy}" r="11"><title>${esc(n.label)}：${esc(n.prefix)}${hit ? '（审计证据帧涉及）' : ''}</title></circle>
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

  const hitHint = auditHits ? ' 橙色描边为同步标记审计证据帧涉及的警报。' : '';
  return `
    <h3>二叉码树</h3>
    <p class="hint">绿节点为已分配码字，红节点为保留分支，灰点为未使用的子树；边标注 0/1。${hitHint}</p>
    <div class="tree-wrap">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
           role="img" aria-label="二叉码树">
        ${edgeSvg}${nodeSvg}
      </svg>
    </div>`;
}

function renderResult(result) {
  if (result.status === 'optimal') {
    // 审计发现风险时，在码树与明细中对证据帧涉及的警报作关联标示
    const auditHits =
      state.audit?.outcome?.status === 'risk' ? new Set(state.audit.outcome.sequence) : null;
    resultsEl.innerHTML = `
      ${renderBanner(result)}
      ${renderStats(result)}
      ${renderTree(result, auditHits)}
      ${renderDetailTable(result, auditHits)}
      ${renderReserved(result)}
      <p class="hint">搜索节点数：${result.exploredNodes}。码字两两前缀无关，任意连续电文均可按前缀码唯一拆分。</p>`;
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

function renderRiskFrameHtml(marker, outcome) {
  const alerts = lastResult.alerts;
  const occ = outcome.occurrence;
  const path = outcome.sequence
    .map(
      (idx) =>
        `<span class="path-item">#${idx + 1} ${esc(alerts[idx].name)} <code class="code">${esc(alerts[idx].code)}</code></span>`,
    )
    .join('<span class="path-sep">→</span>');
  const segs = outcome.spans
    .map((sp, k) => {
      const bits = [];
      for (let p = sp.start; p < sp.end; p++) {
        const hit = p >= occ.start && p < occ.end;
        bits.push(`<span class="bit${hit ? ' hit' : ''}">${outcome.stream[p]}</span>`);
      }
      return `<span class="cw-seg"><span class="cw-bits">${bits.join('')}</span>` +
        `<span class="cw-cap">段 ${k + 1}｜#${sp.alertIdx + 1}｜比特 ${sp.start}–${sp.end - 1}</span></span>`;
    })
    .join('');
  const boundaries = outcome.spans.map((sp) => sp.start).join(' / ');
  const occSegs = outcome.spans
    .map((sp, k) => (sp.start < occ.end && sp.end > occ.start ? k + 1 : null))
    .filter((k) => k !== null);
  const involved = [...new Set(outcome.sequence)]
    .map((i) => `#${i + 1} ${esc(alerts[i].name)}`)
    .join('、');
  return `
    <div class="banner fail">✗ 发现隔离风险：同步标记 <code class="code">${esc(marker)}</code> 会出现在连续电文的非码字边界处，接收设备可能误把它当作新帧开头。</div>
    <div class="audit-frame">
      <p><b>证据帧</b>：${outcome.sequence.length} 条警报 · ${outcome.stream.length} 比特（按警报条数最少、警报序列字典序最小、命中位置最早稳定选定）</p>
      <p class="audit-path">${path}</p>
      <div class="bitstream" role="img" aria-label="完整比特流（红底为同步标记命中位）">${segs}</div>
      <ul class="audit-facts">
        <li>完整比特流：<code class="code">${esc(outcome.stream)}</code></li>
        <li>码字边界：比特 ${boundaries}（各段码字起始；帧尾结束于比特 ${outcome.stream.length}）。</li>
        <li>标记命中：比特 [${occ.start}, ${occ.end})，首位 ${occ.start} 不在码字边界 ⇒ 非法同步；横跨第 ${occSegs.join('、')} 段码字。</li>
        <li>涉及警报：${involved}（已在上方二叉码树与码字明细中标示）。</li>
      </ul>
    </div>`;
}

function renderAuditOutcomeHtml() {
  const { marker, outcome } = state.audit;
  if (outcome.status === 'clean') {
    return `<div class="banner ok">✓ 审计通过：由 ${outcome.minAlerts}–${outcome.maxAlerts} 条警报组成的全部连续帧（共 ${outcome.framesChecked} 条）均未在任何非码字边界处出现同步标记 <code class="code">${esc(marker)}</code>。标记首位恰落在码字边界的出现属合法同步；电文首尾之外的截断串未计入证据。</div>`;
  }
  if (outcome.status === 'risk') {
    return renderRiskFrameHtml(marker, outcome);
  }
  return `<div class="banner fail">✗ 审计中断。<p>${esc(outcome.reason ?? '')}</p></div>`;
}

function refreshAuditPanel() {
  auditPanelEl.hidden = !lastResult;
  if (!lastResult) {
    auditOutputEl.innerHTML = '';
    return;
  }
  auditOutputEl.innerHTML = state.audit
    ? renderAuditOutcomeHtml()
    : `<p class="hint">在码表有效期间录入标记并点击「发起审计」；审计覆盖由 ${MIN_FRAME_ALERTS}–${MAX_FRAME_ALERTS} 条警报组成的全部连续电文。修改左侧参数或标记文本都会使旧审计结论失效。</p>`;
}

function onRunAudit() {
  if (!lastResult) return; // 码表尚未生成或已失效（面板隐藏），防御性返回
  state.marker = markerInputEl.value;
  const marker = state.marker.trim();
  const invalid = validateMarker(marker);
  if (invalid) {
    // 标记不合规：旧审计结论不得沿用
    state.audit = null;
    renderResult(lastResult);
    auditOutputEl.innerHTML = `<div class="banner fail">✗ 同步标记不合规：${esc(invalid)} 旧审计结论（若有）已失效，请修正后重新发起审计。</div>`;
    return;
  }
  const outcome = auditSyncMarker(lastResult.alerts.map((a) => a.code), marker);
  state.audit = { marker, outcome };
  renderResult(lastResult); // 在码树与明细中作关联标示
  refreshAuditPanel();
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
  // 重新生成码表：旧审计结论随旧码表一并失效
  state.audit = null;
  lastResult = result.status === 'optimal' ? result : null;
  renderResult(result);
  refreshAuditPanel();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#solve').addEventListener('click', onSolve);

  $('#run-audit').addEventListener('click', onRunAudit);
  // 标记文本被修改：旧审计结论立即失效，并去除码树/明细中的关联标示
  markerInputEl.addEventListener('input', () => {
    state.marker = markerInputEl.value;
    if (state.audit) {
      state.audit = null;
      if (lastResult) renderResult(lastResult);
      auditOutputEl.innerHTML =
        '<p class="hint stale">同步标记已修改，旧审计结论已失效，请重新发起审计。</p>';
    }
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
