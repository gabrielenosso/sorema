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
  ExistingCodingSession,
  ListExistingCodingSessionsInput,
} from '../src/domains/coding/provider-types.js';

const silentLogger = createLogger('test', 'fatal', false);

class ProviderWithHistory extends FakeCodingProvider {
  readonly askedFor: ListExistingCodingSessionsInput[] = [];

  constructor(private readonly history: readonly ExistingCodingSession[]) {
    super({ stepDelayMs: 1 });
  }

  override async listExistingSessions(
    input: ListExistingCodingSessionsInput,
  ): Promise<ExistingCodingSession[]> {
    this.askedFor.push(input);
    return this.history.filter(
      (session) => !input.projectPath || session.projectPath === input.projectPath,
    );
  }
}

function createHarness(historyFor: (root: string) => readonly ExistingCodingSession[]) {
  const root = mkdtempSync(join(tmpdir(), 'ct-any-'));
  for (const name of ['alpha', 'beta']) mkdirSync(join(root, name, '.git'), { recursive: true });
  const history = historyFor(root);
  const store = new LocalStore(createLocalAgentDatabase(':memory:'));
  const projectRegistry = new ProjectRegistry([root]);
  const events: SoremaEvent[] = [];
  const provider = new ProviderWithHistory(history);
  const adapter = new CodingDomainAdapter({
    store,
    projectRegistry,
    providers: [provider],
    publishEvent: (event) => events.push(event),
    logger: silentLogger,
    userId: 'user_1',
    deviceId: 'dev_1',
    demoMode: false,
  });
  return { adapter, store, provider, root, projectRegistry };
}

function discover(payload: Record<string, unknown>, idempotencyKey = 'k1') {
  return {
    command: { name: 'domain_sessions.discover', payload } as never,
    userId: 'user_1',
    deviceId: 'dev_1',
    correlationId: 'corr_1',
    idempotencyKey,
  };
}

/**
 * Asked out loud which sessions were open, somebody got an answer about one project they had never
 * named — the tool could only be called with a project, so the assistant picked one out of the one
 * hundred and eighty on that machine and reported that it was empty.
 *
 * "Non ho specificato nessun progetto": the question was about the machine, and the answer has to
 * be able to be about the machine too.
 */
describe('open work when nobody named a project', () => {
  const session = (projectPath: string, title: string): ExistingCodingSession => ({
    providerSessionId: `native-${title}`,
    projectPath,
    title,
    lastActiveAt: '2026-08-30T21:05:24.000Z',
  });

  it('asks every agent about everything when no project is named', async () => {
    const { adapter, provider } = createHarness((root) => [
      session(join(root, 'alpha'), 'the deploy'),
      session(join(root, 'beta'), 'the privacy notice'),
    ]);

    const result = (await adapter.execute(discover({}))) as { sessions: { title: string }[] };

    expect(provider.askedFor[0]?.projectPath).toBeUndefined();
    expect(result.sessions.map((found) => found.title).sort()).toEqual([
      'the deploy',
      'the privacy notice',
    ]);
  });

  it('still narrows to one project when one is named', async () => {
    const { adapter, provider, root } = createHarness((workspace) => [
      session(join(workspace, 'alpha'), 'the deploy'),
      session(join(workspace, 'beta'), 'the privacy notice'),
    ]);
    const projectId = adapterProjectId(root, 'alpha');

    const result = (await adapter.execute(discover({ projectId }))) as {
      sessions: { title: string }[];
    };

    expect(provider.askedFor[0]?.projectPath).toBe(join(root, 'alpha'));
    expect(result.sessions.map((found) => found.title)).toEqual(['the deploy']);
  });

  /**
   * An agent's own store covers the whole disk. Everything it reports is checked against the roots
   * the person authorised, and work outside them is not theirs to be shown or resumed.
   */
  it('leaves out work the person never authorised this machine to touch', async () => {
    const { adapter } = createHarness((root) => [
      session(join(root, 'alpha'), 'the deploy'),
      session(SOMEWHERE_ELSE, 'a repository nobody authorised'),
    ]);

    const result = (await adapter.execute(discover({}))) as { sessions: { title: string }[] };

    expect(result.sessions.map((found) => found.title)).toEqual(['the deploy']);
  });

  it('files each one under the project it really belongs to', async () => {
    const { adapter, store, root } = createHarness((workspace) => [
      session(join(workspace, 'beta'), 'the deploy'),
    ]);

    await adapter.execute(discover({}));
    const [stored] = store.listDomainSessions({ userId: 'user_1', deviceId: 'dev_1' });

    expect(stored?.projectPath).toBe(join(root, 'beta'));
  });
});

const SOMEWHERE_ELSE = 'C:\\Users\\me\\CODE\\somebody-else';

function adapterProjectId(root: string, name: string): string {
  return new ProjectRegistry([root]).listProjects().find((p) => p.name === name)?.id ?? '';
}
