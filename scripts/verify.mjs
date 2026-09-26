/**
 * verify 一次性服务入口：依次执行
 *   1. 代码测试（node --test）
 *   2. 构建检查（scripts/build.mjs）
 *   3. 健康地址冒烟（GET HEALTH_URL / WEB_URL，带重试）
 * 全部通过以退出码 0 结束，否则非 0。
 */
import { spawnSync } from 'node:child_process';

const HEALTH_URL = process.env.HEALTH_URL || 'http://web/healthz';
const WEB_URL = process.env.WEB_URL || 'http://web/';
const SMOKE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 60_000);

let failed = false;

function step(name, args) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status === 0) {
    console.log(`✓ ${name} 通过`);
  } else {
    console.error(`✗ ${name} 失败（退出码 ${r.status}）`);
    failed = true;
  }
}

async function smoke(url, expectText) {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  let lastError = '未知错误';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = await res.text();
      if (res.ok && body.includes(expectText)) {
        console.log(`✓ 冒烟通过 ${url}（HTTP ${res.status}，包含「${expectText}」）`);
        return true;
      }
      lastError = `HTTP ${res.status} 或响应内容不符`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`✗ 冒烟失败 ${url}：${lastError}`);
  return false;
}

step('代码测试', ['--test']);
step('构建检查', ['scripts/build.mjs']);

console.log('\n=== 健康地址冒烟 ===');
if (!(await smoke(HEALTH_URL, 'ok'))) failed = true;
if (!(await smoke(WEB_URL, '地震预警'))) failed = true;

if (failed) {
  console.error('\nverify：存在失败步骤');
  process.exit(1);
}
console.log('\nverify：全部通过');
process.exit(0);
