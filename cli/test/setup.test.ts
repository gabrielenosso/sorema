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

  it('ignores a code on a machine that is already paired', () => {
    const steps = planSetup({ paired: true, code: 'A1B2C3D4', serviceInstalled: true, ...DURABLE });

    expect(steps.some((step) => step.action === 'pair')).toBe(false);
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

    expect(steps.map((step) => step.action)).toEqual(['explain', 'run-in-foreground']);
    expect(steps.some((step) => step.action === 'install-service')).toBe(false);
  });

  it('still pairs before falling back to the foreground', () => {
    const steps = planSetup({
      paired: false,
      code: 'A1B2C3D4',
      serviceInstalled: false,
      rottingPath: 'the npx cache',
    });

    expect(steps[0]?.action).toBe('pair');
    expect(steps.at(-1)?.action).toBe('run-in-foreground');
  });
});
