import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SoremaError } from '@sorema/domain-model';

function canonicalize(candidatePath: string): string {
  const absolute = resolve(candidatePath);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function normalizeWorkspaceRoots(roots: readonly string[]): string[] {
  return roots.map((root) => canonicalize(root));
}

export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const canonicalCandidate = canonicalize(candidatePath);
  const canonicalRoot = canonicalize(rootPath);
  if (canonicalCandidate === canonicalRoot) return true;
  const relation = relative(canonicalRoot, canonicalCandidate);
  if (relation.length === 0) return true;
  if (isAbsolute(relation)) return false;
  return !relation.startsWith(`..${sep}`) && relation !== '..';
}

export function resolveWithinAllowedRoots(
  candidatePath: string,
  allowedRoots: readonly string[],
): string {
  if (allowedRoots.length === 0) {
    throw SoremaError.of('PROJECT_NOT_ALLOWED', 'No workspace roots are configured on this device');
  }
  const canonicalCandidate = canonicalize(candidatePath);
  const matched = allowedRoots.find((root) => isPathWithinRoot(canonicalCandidate, root));
  if (!matched) {
    throw SoremaError.of(
      'PROJECT_NOT_ALLOWED',
      `Path is outside the allowed workspace roots: ${candidatePath}`,
      { details: { candidatePath } },
    );
  }
  return canonicalCandidate;
}
