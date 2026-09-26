/**
 * UI 无头冒烟：用最小 DOM 桩加载 app.js，验证加载、求解渲染、
 * 结论失效、校验提示与增删行等交互逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeInputElement {
  constructor(dataset = {}, value = '') {
    this.dataset = dataset;
    this.value = value;
  }
}
globalThis.HTMLInputElement = FakeInputElement;

class StubElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  closest() {
    return null;
  }
}

const registry = new Map();
globalThis.document = {
  querySelector(sel) {
    if (!registry.has(sel)) registry.set(sel, new StubElement(sel));
    return registry.get(sel);
  },
};
const $ = (sel) => document.querySelector(sel);
const type = (idx, field, value) =>
  $('#input-panel').fire('input', { target: new FakeInputElement({ idx: String(idx), field }, value) });

await import('../src/app.js');

test('初始载入示例参数，结果区为占位提示', () => {
  assert.ok($('#alert-rows').innerHTML.includes('特大地震预警'));
  assert.ok($('#results').innerHTML.includes('生成码表'));
});

test('生成码表：展示码树、明细、加权贡献、保留分支与总成本', () => {
  $('#solve').fire('click');
  const html = $('#results').innerHTML;
  assert.ok(html.includes('已找到最优码表'));
  assert.ok(html.includes('二叉码树') && html.includes('<svg'));
  assert.ok(html.includes('码字明细') && html.includes('加权贡献'));
  assert.ok(html.includes('保留分支') && html.includes('1110'));
  assert.ok(html.includes('总成本'));
});

test('输入变动后旧结论失效，重新生成可恢复', () => {
  type(0, 'freq', '4');
  assert.ok($('#results').innerHTML.includes('失效'));
  type(0, 'freq', '3');
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('已找到最优码表'));
});

test('无解时明确说明没有可用的完整分配', () => {
  for (let i = 0; i < 5; i++) {
    type(i, 'lo', '1');
    type(i, 'hi', '1');
  }
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('没有可用的完整分配'));
});

test('非法参数给出校验错误且不保留旧结论', () => {
  type(0, 'freq', '0');
  type(0, 'hi', '3');
  $('#solve').fire('click');
  assert.equal($('#errors').hidden, false);
  assert.ok($('#errors').innerHTML.includes('频次'));
  assert.ok($('#results').innerHTML.includes('清除'));
});

test('警报类别与保留前缀的增删及数量上限', () => {
  $('#load-sample').fire('click');
  $('#add-alert').fire('click');
  assert.ok($('#alert-rows').innerHTML.includes('data-idx="6"'));
  $('#add-alert').fire('click');
  $('#add-alert').fire('click');
  assert.equal($('#add-alert').disabled, true); // 8 类封顶
  $('#add-reserved').fire('click');
  assert.ok($('#reserved-rows').innerHTML.includes('data-reserved-idx="1"'));
  $('#add-reserved').fire('click');
  $('#add-reserved').fire('click');
  assert.equal($('#add-reserved').disabled, true); // 3 条封顶
});

/* ---------------- 同步标记隔离审计 ---------------- */

const setMarker = (value) => {
  const marker = $('#sync-marker');
  marker.value = value;
  marker.fire('input');
};

test('审计面板随码表有效性显隐', () => {
  $('#load-sample').fire('click');
  assert.equal($('#audit-panel').hidden, true); // 码表尚未生成
  $('#solve').fire('click');
  assert.equal($('#audit-panel').hidden, false); // 码表有效，可发起审计
  type(0, 'freq', '4'); // 修改输入草稿
  assert.equal($('#audit-panel').hidden, true); // 旧码表失效，面板隐藏
  type(0, 'freq', '3');
});

test('发现风险：展示证据帧并在码树与明细中关联标示', () => {
  $('#load-sample').fire('click');
  $('#solve').fire('click');
  setMarker('100');
  $('#run-audit').fire('click');
  const out = $('#audit-output').innerHTML;
  assert.ok(out.includes('发现隔离风险'));
  assert.ok(out.includes('证据帧'));
  assert.ok(out.includes('1111000')); // 完整比特流
  assert.ok(out.includes('码字边界'));
  assert.ok(out.includes('非法同步'));
  assert.ok(out.includes('特大地震预警') && out.includes('强余震警报')); // 警报路径
  const results = $('#results').innerHTML;
  assert.ok(results.includes('audit-hit')); // 关联标示
  assert.ok(results.includes('data-alert-idx="0"'));
});

test('标记不合规或文本被修改：不沿用旧审计结论', () => {
  $('#load-sample').fire('click');
  $('#solve').fire('click');
  setMarker('100');
  $('#run-audit').fire('click');
  assert.ok($('#audit-output').innerHTML.includes('发现隔离风险'));
  setMarker('10'); // 修改标记文本：旧结论立即失效，关联标示去除
  assert.ok($('#audit-output').innerHTML.includes('已失效'));
  assert.ok(!$('#results').innerHTML.includes('audit-hit'));
  $('#run-audit').fire('click'); // 长度不合规
  assert.ok($('#audit-output').innerHTML.includes('不合规'));
  assert.ok(!$('#results').innerHTML.includes('audit-hit'));
  setMarker('10a1'); // 非法字符
  $('#run-audit').fire('click');
  assert.ok($('#audit-output').innerHTML.includes('0/1'));
});

test('重新生成码表后旧审计结论失效', () => {
  $('#load-sample').fire('click');
  $('#solve').fire('click');
  setMarker('100');
  $('#run-audit').fire('click');
  assert.ok($('#results').innerHTML.includes('audit-hit'));
  $('#solve').fire('click'); // 重新生成码表
  assert.ok(!$('#results').innerHTML.includes('audit-hit'));
  assert.ok(!$('#audit-output').innerHTML.includes('发现隔离风险'));
  assert.ok($('#audit-output').innerHTML.includes('发起审计'));
});

test('审计通过：该长度范围内全部连续帧均无非法命中', () => {
  $('#load-sample').fire('click');
  // 调整为 5 类、码长固定 1–5 位、无保留前缀 ⇒ 码表 0/10/110/1110/11110
  $('#input-panel').fire('click', { target: { closest: () => ({ dataset: { removeAlert: '5' } }) } });
  $('#input-panel').fire('click', { target: { closest: () => ({ dataset: { removeReserved: '0' } }) } });
  for (let i = 0; i < 5; i++) {
    type(i, 'lo', String(i + 1));
    type(i, 'hi', String(i + 1));
  }
  $('#solve').fire('click');
  assert.ok($('#results').innerHTML.includes('11110'));
  setMarker('111101');
  $('#run-audit').fire('click');
  const out = $('#audit-output').innerHTML;
  assert.ok(out.includes('审计通过'));
  assert.ok(out.includes('均未在任何非码字边界处出现'));
  assert.ok(out.includes('12207025')); // 5^2+…+5^10 条连续帧
  assert.ok(!$('#results').innerHTML.includes('audit-hit'));
});
