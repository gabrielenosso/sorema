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
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
  define,
});

const named = Object.keys(define).length;
process.stdout.write(
  named === 2
    ? 'built, pointed at the configured deployment\n'
    : 'built without deployment addresses: the command will ask for them\n',
);
