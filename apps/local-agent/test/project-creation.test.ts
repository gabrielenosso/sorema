import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistry, sanitizeProjectFolderName } from '../src/projects/project-registry.js';

let workspaceRoot: string;
let outsideRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'ct-workspace-'));
  outsideRoot = mkdtempSync(join(tmpdir(), 'ct-outside-'));
});

describe('creating a project', () => {
  it('creates the folder inside the workspace and returns it as a project', () => {
    const registry = new ProjectRegistry([workspaceRoot]);
    const project = registry.createProject('AI Sorema');

    expect(project.name).toBe('ai-sorema');
    expect(existsSync(project.path)).toBe(true);
    expect(project.path.startsWith(workspaceRoot)).toBe(true);
    expect(registry.listProjects().map((entry) => entry.name)).toContain('ai-sorema');
  });

  it('is idempotent when the project already exists', () => {
    const registry = new ProjectRegistry([workspaceRoot]);
    const first = registry.createProject('demo');
    const second = registry.createProject('demo');
    expect(second.id).toBe(first.id);
    expect(second.path).toBe(first.path);
  });

  it('never writes outside the workspace, whatever the name looks like', () => {
    const registry = new ProjectRegistry([workspaceRoot]);
    const hostileNames = [
      '..',
      '../evil',
      '../../evil',
      '..\\evil',
      '../../../../../../etc/passwd',
      join(outsideRoot, 'evil'),
      'C:\\Windows\\System32',
      '/etc/cron.d/evil',
      'a/../../b',
    ];

    for (const hostileName of hostileNames) {
      try {
        const project = registry.createProject(hostileName);
        expect(project.path.startsWith(workspaceRoot)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }

    expect(existsSync(join(outsideRoot, 'evil'))).toBe(false);
    expect(registry.listProjects().every((entry) => entry.path.startsWith(workspaceRoot))).toBe(
      true,
    );
  });

  it('refuses when no workspace root is configured', () => {
    const registry = new ProjectRegistry([]);
    expect(() => registry.createProject('anything')).toThrow(/workspace root/i);
  });

  it('refuses when a file already occupies the name', () => {
    const registry = new ProjectRegistry([workspaceRoot]);
    writeFileSync(join(workspaceRoot, 'taken'), 'not a folder', 'utf8');
    expect(() => registry.createProject('taken')).toThrow(/not a folder/i);
  });

  it('still resolves the new project by id for a coding task', () => {
    const registry = new ProjectRegistry([workspaceRoot]);
    const project = registry.createProject('resolvable');
    expect(registry.resolveProjectPath(project.id)).toBe(project.path);
  });

  it('creates inside a nested root when several are configured', () => {
    const second = join(workspaceRoot, 'nested');
    mkdirSync(second, { recursive: true });
    const registry = new ProjectRegistry([workspaceRoot, second]);
    const project = registry.createProject('somewhere');
    expect(project.path.startsWith(workspaceRoot)).toBe(true);
  });
});

describe('finding a project from a spoken name', () => {
  it.each(['X-AI', 'x ai', 'X_AI', 'x.a.i'])('matches %s to the xai folder', (spokenName) => {
    mkdirSync(join(workspaceRoot, 'xai'));
    const registry = new ProjectRegistry([workspaceRoot]);

    expect(registry.listProjects(spokenName).map((project) => project.name)).toEqual(['xai']);
  });

  it('still supports ordinary substring searches after spoken punctuation is normalized', () => {
    mkdirSync(join(workspaceRoot, 'xai-scorecard-handover'));
    mkdirSync(join(workspaceRoot, 'sorema'));
    const registry = new ProjectRegistry([workspaceRoot]);

    expect(registry.listProjects('scorecard').map((project) => project.name)).toEqual([
      'xai-scorecard-handover',
    ]);
  });
});

describe('folder name sanitising', () => {
  it('turns a spoken name into a safe folder name', () => {
    expect(sanitizeProjectFolderName('AI Sorema')).toBe('ai-sorema');
    expect(sanitizeProjectFolderName('  Spaces  Everywhere  ')).toBe('spaces-everywhere');
    expect(sanitizeProjectFolderName('già-fatto')).toBe('gia-fatto');
    expect(sanitizeProjectFolderName('my_project.v2')).toBe('my_project.v2');
  });

  it('strips separators so a name can never become a path', () => {
    expect(sanitizeProjectFolderName('a/b/c')).toBe('a-b-c');
    expect(sanitizeProjectFolderName('a\\b')).toBe('a-b');
    expect(sanitizeProjectFolderName('C:/Windows/System32')).toBe('c-windows-system32');
  });

  it('rejects names that sanitise down to nothing', () => {
    for (const empty of ['', '   ', '...', '///', '---']) {
      expect(() => sanitizeProjectFolderName(empty)).toThrow();
    }
  });

  it('rejects reserved windows device names', () => {
    for (const reserved of ['CON', 'nul', 'COM1', 'lpt9']) {
      expect(() => sanitizeProjectFolderName(reserved)).toThrow();
    }
  });

  it('caps the length so a rambling instruction cannot become a folder name', () => {
    expect(sanitizeProjectFolderName('a'.repeat(200))).toHaveLength(64);
  });
});
