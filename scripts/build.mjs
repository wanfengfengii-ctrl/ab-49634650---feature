/**
 * 构建检查：语法校验全部 JS（.js 以 ESM 方式解析）、核对 HTML 引用、
 * 清理并把静态产物复制到 dist/，最后写入构建清单。
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

function checkSyntax(file, asModule) {
  // node --check 依据扩展名选择解析目标：.js 一律按 CommonJS 解析，
  // 因此 ESM 源文件先复制为 .mjs 再校验。
  const args = asModule ? ['--check', file] : ['--check', file];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`语法校验失败 ${file}\n${r.stderr}`);
  }
}

async function syntaxCheckAll() {
  const tmp = await mkdtemp(join(tmpdir(), 'build-check-'));
  try {
    const targets = [];
    for (const f of await readdir(srcDir)) {
      if (f.endsWith('.js')) targets.push(join(srcDir, f));
    }
    for (const dir of ['scripts', 'tests']) {
      for (const f of await readdir(join(root, dir))) {
        if (f.endsWith('.js') || f.endsWith('.mjs')) targets.push(join(root, dir, f));
      }
    }
    for (const file of targets) {
      const probe = join(tmp, `${Math.random().toString(36).slice(2)}.mjs`);
      await cp(file, probe);
      checkSyntax(probe, true);
    }
    console.log(`✓ 语法校验通过（${targets.length} 个文件）`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function build() {
  await syntaxCheckAll();

  const html = await readFile(join(srcDir, 'index.html'), 'utf8');
  for (const ref of ['styles.css', 'app.js']) {
    if (!html.includes(ref)) throw new Error(`index.html 未引用 ${ref}`);
  }
  const appJs = await readFile(join(srcDir, 'app.js'), 'utf8');
  for (const dep of ['./solver.js', './tree.js']) {
    if (!appJs.includes(dep)) throw new Error(`app.js 未引用 ${dep}`);
  }
  console.log('✓ 静态资源引用核对通过');

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(srcDir, distDir, { recursive: true });

  const files = (await readdir(distDir)).sort();
  await writeFile(
    join(distDir, 'build-info.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), files }, null, 2) + '\n',
  );
  console.log(`✓ 构建完成：dist/（${files.join(', ')}）`);
}

build().catch((err) => {
  console.error(`✗ 构建失败：${err.message}`);
  process.exit(1);
});
