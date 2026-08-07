import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SoremaError, type ProjectSummary } from '@sorema/domain-model';
import { normalizeWorkspaceRoots, resolveWithinAllowedRoots } from '@sorema/security';

const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'build',
  '.next',
  '.venv',
  '__pycache__',
]);

export function createProjectIdentifier(canonicalPath: string): string {
  return `proj_${createHash('sha256').update(canonicalPath.toLowerCase()).digest('hex').slice(0, 16)}`;
}

export class ProjectRegistry {
  private readonly allowedRoots: string[];

  constructor(allowedRoots: readonly string[]) {
    this.allowedRoots = normalizeWorkspaceRoots(allowedRoots.filter((root) => existsSync(root)));
  }

  get roots(): readonly string[] {
    return this.allowedRoots;
  }

  listProjects(search?: string): ProjectSummary[] {
    const projects = new Map<string, ProjectSummary>();
    for (const root of this.allowedRoots) {
      for (const candidate of [root, ...this.readChildDirectories(root)]) {
        const summary = this.describeProject(candidate);
        if (summary) projects.set(summary.id, summary);
      }
    }
    const all = [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
    if (!search || search.trim().length === 0) return all;
    const needle = search.trim().toLowerCase();
    return all.filter((project) => project.name.toLowerCase().includes(needle));
  }

  private readChildDirectories(root: string): string[] {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name))
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
  }

  private describeProject(candidatePath: string): ProjectSummary | null {
    try {
      const stats = statSync(candidatePath);
      if (!stats.isDirectory()) return null;
      return {
        id: createProjectIdentifier(candidatePath),
        name: basename(candidatePath),
        path: candidatePath,
        isGitRepository: existsSync(join(candidatePath, '.git')),
        lastModifiedAt: stats.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  resolveProjectPath(projectId: string): string {
    const match = this.listProjects().find((project) => project.id === projectId);
    if (!match) {
      throw SoremaError.of('PROJECT_NOT_FOUND', `No project with id ${projectId}`, {
        details: { projectId },
      });
    }
    return resolveWithinAllowedRoots(match.path, this.allowedRoots);
  }

  assertPathIsAllowed(candidatePath: string): string {
    return resolveWithinAllowedRoots(candidatePath, this.allowedRoots);
  }

  createProject(name: string, workspaceRootPath?: string): ProjectSummary {
    const folderName = sanitizeProjectFolderName(name);
    const root = workspaceRootPath
      ? resolveWithinAllowedRoots(workspaceRootPath, this.allowedRoots)
      : this.allowedRoots[0];

    if (!root) {
      throw SoremaError.of('PROJECT_NOT_ALLOWED', 'No workspace root is configured on this device');
    }

    // join() first, then re-check against the roots: a name like ".." would otherwise escape the
    // workspace even though the root itself is allowed.
    const targetPath = resolveWithinAllowedRoots(join(root, folderName), this.allowedRoots);

    if (existsSync(targetPath)) {
      const existing = this.describeProject(targetPath);
      if (existing) return existing;
      throw SoremaError.of(
        'PROJECT_NOT_ALLOWED',
        `A file already exists at ${targetPath} and is not a folder`,
        { userMessage: 'Something with that name already exists there and is not a folder.' },
      );
    }

    mkdirSync(targetPath, { recursive: true });
    const created = this.describeProject(targetPath);
    if (!created) {
      throw SoremaError.of('INTERNAL_ERROR', `Could not describe the new project at ${targetPath}`);
    }
    return created;
  }
}

const RESERVED_WINDOWS_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export function sanitizeProjectFolderName(rawName: string): string {
  const folderName = rawName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/^[-._]+|[-._]+$/g, '');

  if (folderName.length === 0 || RESERVED_WINDOWS_NAMES.has(folderName)) {
    throw SoremaError.of('PROJECT_NOT_ALLOWED', `"${rawName}" cannot be used as a folder name`, {
      userMessage: 'That name cannot be used for a folder. Can you suggest another one?',
    });
  }
  return folderName;
}
