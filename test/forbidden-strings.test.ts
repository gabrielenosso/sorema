import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');
const checker = join(repositoryRoot, 'scripts', 'check-forbidden-strings.mjs');

/**
 * Every address below is assembled at run time rather than written out.
 *
 * A literal here would be a forbidden string sitting in a file the check scans, so the test would
 * fail the repository it is meant to protect. The pieces are inert on their own.
 */
const A_DISTRIBUTION_ID = ['d', '30w4rtq', 'hgijeo'].join('');
const AN_API_ID = ['lrqfd', '20dq8'].join('');
const AN_ACCOUNT_ID = ['834107', '150470'].join('');

function check(args: readonly string[], deploymentFile?: string) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Points the exact-string half at a file that does not exist, so what the run reports is what
      // the shape rules alone catch. Without it the sibling private checkout answers for them on
      // the owner's machine and nowhere else, and the test would mean two different things.
      ...(deploymentFile === undefined ? {} : { SOREMA_DEPLOYMENT_FILE: deploymentFile }),
    },
  });
}

function fileContaining(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'sorema-forbidden-')), 'planted.ts');
  writeFileSync(path, contents);
  return path;
}

const NOWHERE = join(tmpdir(), 'sorema-no-deployment-file-here.json');

/**
 * The one thing the retired export script did that still has to happen.
 *
 * `pnpm export:public` refused to copy anything naming this deployment. Now that the agent is
 * developed here rather than copied here, that refusal has to happen where the bytes are written.
 * The check is only worth having if it is capable of failing, so each rule is asserted against
 * something it must catch — not merely run over a clean tree and seen to pass.
 */
describe('the check that keeps the deployment out of the public repository', () => {
  it('refuses an API Gateway endpoint with no list of strings to compare against', () => {
    const planted = fileContaining(
      `export const base = "https://${AN_API_ID}.execute-api.eu-central-1.amazonaws.com";\n`,
    );

    const result = check(['--paths', planted], NOWHERE);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('an API Gateway endpoint');
  });

  it('refuses the CloudFront domain with no list of strings to compare against', () => {
    const planted = fileContaining(
      `export const app = "https://${A_DISTRIBUTION_ID}.cloudfront.net";\n`,
    );

    const result = check(['--paths', planted], NOWHERE);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a CloudFront distribution domain');
  });

  it('refuses the account id in an ARN, and beside the word it is always written beside', () => {
    const inAnArn = fileContaining(
      `const role = "arn:aws:iam::${AN_ACCOUNT_ID}:role/cdk-deploy";\n`,
    );
    const named = fileContaining(`const awsAccountId = "${AN_ACCOUNT_ID}";\n`);

    expect(check(['--paths', inAnArn], NOWHERE).status).toBe(1);
    expect(check(['--paths', named], NOWHERE).status).toBe(1);
  });

  it('says out loud whether it is comparing against the deployment or only against shapes', () => {
    // The failure this guards is a check that passes because it has nothing to check with. The
    // export script refused outright in that case; here a stranger's clone has to keep working, so
    // it degrades to the shape rules and reports that it did rather than looking the same either way.
    const clean = fileContaining('export const answer = 42;\n');

    const withoutList = check(['--paths', clean], NOWHERE);

    expect(withoutList.status).toBe(0);
    expect(withoutList.stdout).toContain('no deployment strings on this machine');
  });

  it('leaves twelve digits alone when nothing on the line says they are an account', () => {
    // The session id fixtures under apps/local-agent/test hold one. A rule that stopped a commit
    // over those is a rule people would learn to skip.
    const fixture = fileContaining(`const sessionId = "11111111-2222-3333-4444-555555555555";\n`);

    expect(check(['--paths', fixture], NOWHERE).status).toBe(0);
  });

  it('finds nothing in this repository, in the working tree or anywhere in its history', () => {
    const result = check(['--history']);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no forbidden strings in \d+ historical blobs/);
  });
});
