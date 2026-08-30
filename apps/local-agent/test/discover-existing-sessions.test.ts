import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sorema/observability';
import type { SoremaEvent } from '@sorema/domain-model';
import { createLocalAgentDatabase } from '../src/db/client.js';
import { LocalStore } from '../src/store/local-store.js';
import { ProjectRegistry } from '../src/projects/project-registry.js';
import { CodingDomainAdapter } from '../src/domains/coding/coding-domain-adapter.js';
import { FakeCodingProvider } from '../src/domains/coding/providers/fake-coding-provider.js';
import type {
  CodingProvider,
  ExistingCodingSession,
  ListExistingCodingSessionsInput,
} from '../src/domains/coding/provider-types.js';

const silentLogger = createLogger('test', 'fatal', false);

class ProviderWithHistory extends FakeCodingProvider {
  readonly askedFor: ListExistingCodingSessionsInput[] = [];

  constructor(private readonly history: ExistingCodingSession[]) {
    super({ stepDelayMs: 1 });
  }

  override async listExistingSessions(
    input: ListExistingCodingSessionsInput,
  ): Promise<ExistingCodingSession[]> {
    this.askedFor.push(input);
    return this.history;
  }
}

function createHarness(providers: CodingProvider[]) {
  const root = mkdtempSync(join(tmpdir(), 'ct-discover-'));
  const projectPath = join(root, 'ai-sorema');
  mkdirSync(join(projectPath, '.git'), { recursive: true });
  const store = new LocalStore(createLocalAgentDatabase(':memory:'));
  const projectRegistry = new ProjectRegistry([root]);
  const events: SoremaEvent[] = [];
  const adapter = new CodingDomainAdapter({
    store,
    projectRegistry,
    providers,
    publishEvent: (event) => events.push(event),
    logger: silentLogger,
    userId: 'user_1',
    deviceId: 'dev_1',
    demoMode: false,
  });
  const projectId = projectRegistry.listProjects().find((p) => p.name === 'ai-sorema')?.id;
  if (!projectId) throw new Error('test project was not discovered');
  return { adapter, store, projectId, projectPath };
}

function discover(projectId: string, idempotencyKey = 'k1') {
  return {
    command: { name: 'domain_sessions.discover', payload: { projectId } } as never,
    userId: 'user_1',
    deviceId: 'dev_1',
    correlationId: 'corr_1',
    idempotencyKey,
  };
}

/**
 * Work started in the Codex or Claude desktop application was invisible here: the person asked to
 * carry on with what they had been doing that morning and the assistant could only offer to begin
 * again from nothing.
 *
 * Discovering one is not enough on its own. Everything downstream — continuing it, cancelling it,
 * drawing it in the work tab — is written against a Sorema session row, so a discovered session is
 * adopted into one and comes back with the same identifier every other session has.
 */
describe('carrying on a session the desktop application started', () => {
  const morning: ExistingCodingSession = {
    providerSessionId: '019ff153-a463-75b1-a8ad-275be673ad46',
    title: 'rewrite the privacy notice',
    lastActiveAt: '2026-08-30T21:05:24.000Z',
  };

  it('answers with a session identifier continue_task already understands', async () => {
    const { adapter, store, projectId } = createHarness([new ProviderWithHistory([morning])]);

    const result = (await adapter.execute(discover(projectId))) as {
      sessions: { id: string; title: string; providerId: string }[];
    };

    expect(result.sessions).toHaveLength(1);
    const [session] = result.sessions;
    expect(session?.title).toBe('rewrite the privacy notice');
    expect(store.findDomainSession(session?.id ?? '')?.providerSessionId).toBe(
      '019ff153-a463-75b1-a8ad-275be673ad46',
    );
  });

  /**
   * Asked twice, the same session is the same session. Without this the person hears their morning
   * offered once per time they asked, and each copy carries on from the same transcript.
   */
  it('adopts one session once, however many times it is discovered', async () => {
    const { adapter, store, projectId } = createHarness([new ProviderWithHistory([morning])]);

    const first = (await adapter.execute(discover(projectId, 'k1'))) as {
      sessions: { id: string }[];
    };
    const second = (await adapter.execute(discover(projectId, 'k2'))) as {
      sessions: { id: string }[];
    };

    expect(second.sessions[0]?.id).toBe(first.sessions[0]?.id);
    expect(store.listDomainSessions({ userId: 'user_1', deviceId: 'dev_1' })).toHaveLength(1);
  });

  it('asks each agent only about the folder the person named', async () => {
    const provider = new ProviderWithHistory([]);
    const { adapter, projectId, projectPath } = createHarness([provider]);

    await adapter.execute(discover(projectId));

    expect(provider.askedFor.map((input) => input.projectPath)).toEqual([projectPath]);
  });

  /**
   * A project with a decade of history behind it would otherwise answer with a list nobody can hold
   * in their head, read out loud, one at a time.
   */
  it('asks for a handful, not for everything ever run there', async () => {
    const provider = new ProviderWithHistory([]);
    const { adapter, projectId } = createHarness([provider]);

    await adapter.execute(discover(projectId));

    expect(provider.askedFor[0]?.limit).toBe(10);
  });

  it('refuses a folder the person never authorised', async () => {
    const { adapter } = createHarness([new ProviderWithHistory([morning])]);

    await expect(adapter.execute(discover('project_somewhere_else'))).rejects.toThrow();
  });
});
