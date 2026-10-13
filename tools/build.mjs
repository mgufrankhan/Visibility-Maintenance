// Bundles each server entry point and operator tool into a self-contained ESM
// file under dist/, and copies the migrations they apply. Release images run
// these bundles; they do not need the TypeScript sources or dev dependencies.
import { build } from 'esbuild';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');

const entries = {
  'platform-api/main': 'apps/platform-api/src/main.ts',
  'maintenance-api/main': 'apps/maintenance-api/src/main.ts',
  'maintenance-worker/main': 'apps/maintenance-worker/src/main.ts',
  'tools/migrate': 'tools/migrate.ts',
  'tools/setup': 'tools/setup.ts',
  'tools/license-cli': 'tools/license-cli.ts',
  'tools/backup': 'tools/backup.ts',
};

await rm(out, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, path.join(root, v)])),
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  metafile: true,
  // pg optionally loads a native binding that is not shipped.
  external: ['pg-native'],
  banner: { js: "import { createRequire as __vmCreateRequire } from 'node:module'; const require = __vmCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
await cp(path.join(root, 'database', 'migrations'), path.join(out, 'migrations'), { recursive: true });

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const inputs = Object.keys(result.metafile.inputs).filter((f) => f.includes('node_modules/'));
const packages = [...new Set(inputs.map((f) => f.split('node_modules/').pop().split('/').slice(0, f.includes('node_modules/@') ? 2 : 1).join('/')))].sort();
await writeFile(
  path.join(out, 'build-info.json'),
  JSON.stringify({ version: pkg.version, built_at: new Date().toISOString(), entries: Object.keys(entries), bundled_packages: packages }, null, 2),
);
console.log(`Built ${Object.keys(entries).length} bundles into ${path.relative(root, out)}/`);
