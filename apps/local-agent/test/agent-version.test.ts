import { afterEach, describe, expect, it } from 'vitest';
import { localAgentVersion } from '../src/capabilities/capability-detector.js';

const originalVersion = process.env.SOREMA_AGENT_VERSION;

afterEach(() => {
  if (originalVersion === undefined) delete process.env.SOREMA_AGENT_VERSION;
  else process.env.SOREMA_AGENT_VERSION = originalVersion;
});

describe('the version reported by the installed agent', () => {
  it('uses the published command version injected when the service starts', () => {
    process.env.SOREMA_AGENT_VERSION = '0.9.11';
    expect(localAgentVersion()).toBe('0.9.11');
  });
});
