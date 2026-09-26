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
