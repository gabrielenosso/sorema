import { build } from 'esbuild';

/**
 * Substitutes the deployment's addresses into the bundle.
 *
 * Done here rather than in an npm script because shell variable syntax does not survive the trip
 * across platforms, and a build that silently produces a command pointing at nothing is worse than
 * one that fails. Absent values are left absent on purpose: the command then says it does not know
 * which deployment to talk to, which is the truth.
 */
const define = {};
if (process.env.SOREMA_API_URL) {
  define.__SOREMA_API_URL__ = JSON.stringify(process.env.SOREMA_API_URL);
}
if (process.env.SOREMA_TUNNEL_URL) {
  define.__SOREMA_TUNNEL_URL__ = JSON.stringify(process.env.SOREMA_TUNNEL_URL);
}

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/sorema.mjs',
  banner: {
    // An ESM bundle has no `require`, so any CommonJS dependency reaching for one dies at load with
    // "Dynamic require of \"fs\" is not supported" — and it dies wherever that dependency is first
    // touched, which here was the agent's storage layer, so only `sorema start` failed. Giving the
    // bundle a real `require` built from its own URL is the supported way out.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      // `__dirname` and `__filename` do not exist in ESM either, and a dependency that reads one
      // fails at the moment it is touched rather than at load. Same class of defect, same cure.
      "import { fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const __filename = fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  // Nothing is external. The last one was better-sqlite3, whose native binding could not be bundled
  // and so had to be installed beside the command on every machine, for every platform, at the
  // version its prebuilt binary happened to exist for. `node:sqlite` is in the runtime, so the
  // published package is one file and no dependencies, and the bundle test reads that off the
  // artefact rather than off this manifest.
  define,
});

const named = Object.keys(define).length;
process.stdout.write(
  named === 2
    ? 'built, pointed at the configured deployment\n'
    : 'built without deployment addresses: the command will ask for them\n',
);
