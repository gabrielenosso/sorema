import { platform, release } from 'node:os';
import type { Capability } from '@sorema/domain-model';
import { resolveExecutablePath, spawnResolvedExecutable } from '../process/executable-resolver.js';
import type { ProjectRegistry } from '../projects/project-registry.js';
import type { DomainAdapter } from '../domains/domain-adapter.js';

export const LOCAL_AGENT_VERSION = '0.1.0';

export function detectExecutableVersion(
  executablePath: string,
  args: string[] = ['--version'],
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let output = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const resolved = resolveExecutablePath(executablePath);
    if (!resolved) {
      finish(null);
      return;
    }
    try {
      const child = spawnResolvedExecutable(resolved, args, { windowsHide: true });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(null);
      }, 10_000);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0 ? output.trim() : null);
      });
    } catch {
      finish(null);
    }
  });
}

export type CapabilityDetectorOptions = {
  projectRegistry: ProjectRegistry;
  adapters: DomainAdapter[];
  demoMode: boolean;
};

export async function detectCapabilities(
  options: CapabilityDetectorOptions,
): Promise<Capability[]> {
  const capabilities: Capability[] = [
    {
      id: 'system.host',
      domain: 'system',
      version: LOCAL_AGENT_VERSION,
      available: true,
      status: 'ready',
      details: {
        platform: platform(),
        release: release(),
        nodeVersion: process.version,
        demoMode: options.demoMode,
      },
    },
    {
      id: 'system.workspaces',
      domain: 'system',
      available: options.projectRegistry.roots.length > 0,
      status: options.projectRegistry.roots.length > 0 ? 'ready' : 'misconfigured',
      details: {
        // The folders listed here are the only ones anything on this machine may ever touch, so
        // they are shown to the user rather than counted.
        roots: [...options.projectRegistry.roots],
        projectCount: options.projectRegistry.listProjects().length,
      },
    },
  ];

  // Only git is detected here. Docker was detected and reported for a while, but nothing consumed
  // it, so it was noise dressed as information. Browser automation was reported as permanently
  // "unsupported", which advertised a feature that does not exist. A capability earns its place by
  // changing what the assistant will actually do; git does, because its absence is the one thing
  // that silently breaks "commit this" without the agent explaining why.
  const gitVersion = await detectExecutableVersion('git');
  capabilities.push({
    id: 'tooling.git',
    domain: 'system',
    version: gitVersion ?? undefined,
    available: gitVersion !== null,
    status: gitVersion !== null ? 'ready' : 'missing',
  });

  for (const adapter of options.adapters) {
    capabilities.push(...(await adapter.detectCapabilities()));
  }

  return capabilities;
}
