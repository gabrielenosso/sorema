import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Refuses to let this repository name the deployment that serves it.
 *
 * This repository is public and the control plane is not. An API Gateway endpoint, the CloudFront
 * domain or the AWS account id landing here is not a leak that can be taken back: it is published
 * from the moment it is pushed, and nobody can rotate an account id.
 *
 * The check used to live in the private repository, in the script that rebuilt this one by copying.
 * That script is gone — this repository is now where the agent is developed — so the protection
 * moved to where the bytes are written rather than where they used to be copied from.
 *
 * Two layers, because neither is sufficient alone:
 *
 * - **Shapes** always run and need no configuration, so they work on a stranger's clone too.
 * - **The deployment's own strings**, when this machine has them. An account id has no shape that
 *   tells it apart from any other twelve digits, so only the literal value catches it — and the
 *   literal value cannot be committed here, which is the whole point. It is read from the private
 *   checkout beside this one. Whether that half is on is printed rather than assumed: a check that
 *   silently degrades to matching nothing is worse than no check at all.
 */

/**
 * Addresses recognisable by their form.
 *
 * Deliberately narrow. A bare "twelve digits" matches the session-id fixtures under
 * `apps/local-agent/test`, and a check that cries wolf is one people learn to pass with
 * `--no-verify`. Each rule below describes something that can only be an AWS address.
 */
const FORBIDDEN_SHAPES = [
  {
    pattern: /[a-z0-9]{8,}\.execute-api\.[a-z0-9-]+\.amazonaws\.com/gi,
    what: 'an API Gateway endpoint',
  },
  { pattern: /[a-z0-9]{10,}\.cloudfront\.net/gi, what: 'a CloudFront distribution domain' },
  { pattern: /arn:aws[a-z-]*:[^\s"'`]*:\d{12}:/gi, what: 'an AWS account id inside an ARN' },
  { pattern: /[a-z0-9][a-z0-9.-]*\.s3[.-][a-z0-9-]*\.?amazonaws\.com/gi, what: 'an S3 endpoint' },
  { pattern: /[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{9}\b/g, what: 'a Cognito user pool id' },
  {
    // Twelve digits are only suspicious in company. On their own they are a fixture; beside the
    // word AWS or "account" on the same line they are an account id, which has no other shape to
    // recognise it by. No word boundaries, so `awsAccountId` and `AWS_ACCOUNT` count.
    pattern: /\b\d{12}\b/g,
    onlyWhenLineAlsoMatches: /aws|account|arn/i,
    what: 'twelve digits on a line that also says AWS, which is what an account id looks like',
  },
];

/** Only text this repository authors. A binary fixture is not where an endpoint hides. */
const CHECKED_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|txt|html|css|sh|ps1|xml)$/i;

const repositoryRoot = resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const explicitPaths = readOption('--paths');
const scanHistory = argv.includes('--history');
const scanStaged = argv.includes('--staged');

function readOption(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv.slice(index + 1).filter((value) => !value.startsWith('--'));
}

function git(args, { encoding = 'utf8', allowNoMatch = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repositoryRoot, encoding, maxBuffer: 1024 ** 3 });
  } catch (error) {
    // Only "found nothing" is survivable, and only where a caller says so. Anything else is the
    // check failing to run, which must never read as the check having passed.
    if (allowNoMatch && error.status === 1) return error.stdout ?? '';
    throw error;
  }
}

/**
 * The deployment's literal addresses, from the private checkout beside this one.
 *
 * Never committed here and never written here. `SOREMA_DEPLOYMENT_FILE` names the file for a
 * checkout laid out differently, and when it is set it is the only place looked at — otherwise a
 * test asking what the shape rules catch on their own would silently be answered by the sibling.
 * The default is that sibling, which is how the two repositories are developed.
 */
function deploymentStrings() {
  const candidates = process.env.SOREMA_DEPLOYMENT_FILE
    ? [process.env.SOREMA_DEPLOYMENT_FILE]
    : [join(repositoryRoot, '..', 'sorema-cloud', 'infrastructure', 'deployment.json')];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const values = new Set();
    // Named, not measured. The first version of this filtered by length, on the reasoning that a
    // region name is short — but `eu-central-1` is twelve characters, so it became forbidden and
    // this check refused a commit because its own test named the region it was testing for. A
    // region is not a secret: it is in every AWS URL and every error message. What must not appear
    // is the endpoint, the domain and the account.
    const inTheOpen = new Set(['region']);
    for (const [key, value] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) {
      if (inTheOpen.has(key)) continue;
      if (typeof value === 'string' && value.length > 8) values.add(value);
    }
    return { path, values: [...values] };
  }
  return { path: null, values: [] };
}

const deployment = deploymentStrings();

function findingsIn(text, where) {
  const findings = [];
  for (const { pattern, onlyWhenLineAlsoMatches, what } of FORBIDDEN_SHAPES) {
    for (const match of text.matchAll(pattern)) {
      if (onlyWhenLineAlsoMatches && !onlyWhenLineAlsoMatches.test(lineAround(text, match.index))) {
        continue;
      }
      findings.push(`${where} names ${what}: ${match[0]}`);
    }
  }
  for (const value of deployment.values) {
    if (text.includes(value)) findings.push(`${where} names this deployment: ${value}`);
  }
  return findings;
}

function lineAround(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? undefined : end);
}

function checkedFiles() {
  if (explicitPaths) return explicitPaths;
  const listing = scanStaged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    : git(['ls-files']);
  return listing
    .split('\n')
    .filter((path) => path.length > 0 && CHECKED_EXTENSIONS.test(path))
    .map((path) => join(repositoryRoot, path));
}

/**
 * Every set of bytes any ref has ever held at a checked path.
 *
 * The same `findingsIn` runs over these as over the working tree, rather than handing the patterns
 * to `git grep`: its POSIX engine has no lookaround and rejects them outright, and the first version
 * of this scanned the whole history, printed a fatal error, and reported success.
 */
function historicalBlobs() {
  const log = git(['log', '--all', '--raw', '--no-renames', '--abbrev=40', '--format=']);
  const blobs = new Map();
  for (const line of log.split('\n')) {
    if (!line.startsWith(':')) continue;
    const [modes, path] = line.split('\t');
    const blob = modes?.split(' ').at(3);
    if (!path || !blob || /^0+$/.test(blob)) continue;
    if (!CHECKED_EXTENSIONS.test(path)) continue;
    if (!blobs.has(blob)) blobs.set(blob, path);
  }
  return blobs;
}

const findings = [];

for (const path of checkedFiles()) {
  if (!existsSync(path)) continue;
  findings.push(...findingsIn(readFileSync(path, 'utf8'), path.replace(/\\/g, '/')));
}

let historyBlobCount = 0;
if (scanHistory) {
  const blobs = historicalBlobs();
  historyBlobCount = blobs.size;
  if (historyBlobCount > 0) {
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repositoryRoot,
      input: [...blobs.keys()].join('\n'),
      maxBuffer: 1024 ** 3,
    });
    let offset = 0;
    while (offset < batch.length) {
      const headerEnd = batch.indexOf(0x0a, offset);
      if (headerEnd === -1) break;
      const [hash, , size] = batch.subarray(offset, headerEnd).toString('utf8').split(' ');
      const length = Number(size);
      const body = batch.subarray(headerEnd + 1, headerEnd + 1 + length).toString('utf8');
      findings.push(...findingsIn(body, `history ${hash?.slice(0, 8)} ${blobs.get(hash)}`));
      offset = headerEnd + 1 + length + 1;
    }
  }
}

const listSource = deployment.path
  ? `${deployment.values.length} deployment strings from ${deployment.path}`
  : 'no deployment strings on this machine, so shape checks only';

if (findings.length > 0) {
  process.stderr.write(
    [
      'Refusing. This repository is public and would name the deployment that serves it:',
      ...findings.map((finding) => `  ${finding}`),
      '',
      `Checked with ${listSource}.`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stdout.write(
  `no forbidden strings in ${scanHistory ? `${historyBlobCount} historical blobs and ` : ''}` +
    `the ${scanStaged ? 'staged changes' : 'working tree'}; checked with ${listSource}\n`,
);
