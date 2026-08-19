import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // 宿主提供框架与 harness 包；打进产物会造成两份实例，服务查找失败。
  external: ['@deepseek-ai/*'],
})
