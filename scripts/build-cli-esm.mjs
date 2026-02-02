#!/usr/bin/env node
/**
 * Bundle Post CLI to ESM so we can run with node --experimental-vm-modules.
 * Keeps ink/react/discord etc. external to avoid transforming yoga-layout (top-level await).
 */
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const builds = [
  {
    entry: join(root, 'src/cli/known.ts'),
    outfile: join(root, 'dist-esm/known.mjs'),
    name: 'known.mjs',
  },
  {
    entry: join(root, 'src/cli/inbox.ts'),
    outfile: join(root, 'dist-esm/inbox.mjs'),
    name: 'inbox.mjs',
  },
]

for (const { entry, outfile, name } of builds) {
  await esbuild
    .build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      sourcemap: true,
      alias: {
        '@': join(root, 'src'),
      },
      packages: 'external',
      jsx: 'automatic',
      loader: {
        '.tsx': 'tsx',
        '.ts': 'ts',
      },
    })
    .catch(() => process.exit(1))
  console.log(`Built dist-esm/${name}`)
}
