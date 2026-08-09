import { describe, expect, it } from 'vitest';
import { planSetup } from '../src/setup.js';

const DURABLE = { rottingPath: null };

describe('working out what a machine still needs', () => {
  it('asks for a code when there is nothing to go on', () => {
    const steps = planSetup({ paired: false, code: null, serviceInstalled: false, ...DURABLE });

    expect(steps.map((step) => step.action)).toEqual(['explain']);
  });

  it('pairs, installs and reports, the first time', () => {
    const steps = planSetup({
      paired: false,
      code: 'A1B2C3D4',
      serviceInstalled: false,
      ...DURABLE,
    });

    expect(steps.map((step) => step.action)).toEqual([
      'pair',
      'install-service',
      'already-running',
    ]);
  });

  it('does nothing twice when run again', () => {
    const steps = planSetup({ paired: true, code: null, serviceInstalled: true, ...DURABLE });

    expect(steps.map((step) => step.action)).toEqual(['already-running']);
  });

  it('acts on a code even when this machine believes it is already paired', () => {
    // Its identity file can name an account that no longer exists. Somebody typing a fresh code is
    // stating which account this machine belongs to, and the command asks before moving it.
    const steps = planSetup({ paired: true, code: 'A1B2C3D4', serviceInstalled: true, ...DURABLE });

    expect(steps.some((step) => step.action === 'pair')).toBe(true);
  });

  it('installs the service on a paired machine that never got one', () => {
    const steps = planSetup({ paired: true, code: null, serviceInstalled: false, ...DURABLE });

    expect(steps.map((step) => step.action)).toEqual(['install-service', 'already-running']);
  });

  it('stays in the foreground rather than installing a service that would rot', () => {
    const steps = planSetup({
      paired: true,
      code: null,
      serviceInstalled: false,
      rottingPath: 'the npx cache',
    });

    // It installs itself somewhere durable rather than sending the reader off to do it.
    expect(steps.map((step) => step.action)).toEqual([
      'explain',
      'install-globally',
      'install-service',
      'already-running',
    ]);
  });

  it('still pairs before falling back to the foreground', () => {
    const steps = planSetup({
      paired: false,
      code: 'A1B2C3D4',
      serviceInstalled: false,
      rottingPath: 'the npx cache',
    });

    expect(steps[0]?.action).toBe('pair');
    expect(steps.map((step) => step.action)).toContain('install-globally');
  });
});

/**
 * Re-pairing has to restart what is already running.
 *
 * The identity is written to disk, and a daemon started before that keeps signing as the machine
 * this one used to be — its socket stays open, so it never retries and never reads the new key.
 * The account then shows the deleted machine connected and the new one as never having appeared,
 * which is exactly what it looks like when pairing itself has failed.
 */
describe('pairing a machine that is already running', () => {
  it('restarts the service instead of reporting all is well', () => {
    const steps = planSetup({
      paired: true,
      code: 'ABCD1234',
      rottingPath: null,
      serviceInstalled: true,
    });

    expect(steps.map((step) => step.action)).toEqual(['pair', 'restart-service', 'already-running']);
  });

  it('does not restart when nothing was re-paired', () => {
    const steps = planSetup({
      paired: true,
      code: null,
      rottingPath: null,
      serviceInstalled: true,
    });

    expect(steps.map((step) => step.action)).not.toContain('restart-service');
  });

  it('does not restart a service it has only just installed', () => {
    const steps = planSetup({
      paired: false,
      code: 'ABCD1234',
      rottingPath: null,
      serviceInstalled: false,
    });

    expect(steps.map((step) => step.action)).toContain('install-service');
    expect(steps.map((step) => step.action)).not.toContain('restart-service');
  });
});
