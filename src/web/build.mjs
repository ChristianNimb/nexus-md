/**
 * Bundles the React UI (src/web/ui) into two self-contained files in
 * src/web/public: app.js and app.css.
 *
 *   npm run build:web        one-shot production bundle
 *   npm run dev:web          rebuild on save
 *
 * The BUILT OUTPUT IS COMMITTED, so `docker compose up` needs no build step and
 * the bot has no runtime dependency on React. You only need to run this after
 * editing something under src/web/ui — which needs the devDependencies
 * (react, react-dom, esbuild) installed.
 *
 * Everything is inlined deliberately: no CDN, no code splitting, no dynamic
 * imports. The linking panel is often opened on a LAN with no internet, so it
 * has to work from these two files alone.
 */
import { build, context } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(here, 'ui', 'main.tsx')],
  bundle: true,
  outfile: join(here, 'public', 'app.js'),
  format: 'iife',
  platform: 'browser',
  target: ['es2020', 'chrome90', 'safari15', 'firefox90'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch,
  legalComments: 'none',
  // React reads this to strip its development-only warnings and checks.
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  loader: { '.svg': 'text' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/web/ui …');
} else {
  const result = await build({ ...options, metafile: true });
  const outputs = result.metafile.outputs;
  for (const [file, meta] of Object.entries(outputs)) {
    console.log(`${file}  ${(meta.bytes / 1024).toFixed(1)} kB`);
  }
}
