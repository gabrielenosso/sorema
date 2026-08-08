/**
 * One command that ends with this machine connected, whatever state it started in.
 *
 * The alternative — pair, then install, then start — asks somebody to hold a three-step procedure in
 * their head and to know which steps they have already done. They will run it twice, or run the
 * wrong one, and the failure will be silent. So the command works out what is missing and does only
 * that, which also makes running it again harmless.
 */
export type MachineState = {
  paired: boolean;
  code: string | null;
  /** Null when the paths are durable; the reason when they are not. */
  rottingPath: string | null;
  serviceInstalled: boolean;
};

export type SetupStep =
  | { action: 'pair'; code: string }
  | { action: 'install-service' }
  | { action: 'run-in-foreground' }
  | { action: 'already-running' }
  | { action: 'explain'; message: string };

export function planSetup(state: MachineState): SetupStep[] {
  if (!state.paired && !state.code) {
    return [
      {
        action: 'explain',
        message:
          'This machine is not paired yet.\n' +
          'Open the web app, choose "Pair your computer", and run the command it shows you.',
      },
    ];
  }

  const steps: SetupStep[] = [];
  if (!state.paired && state.code) steps.push({ action: 'pair', code: state.code });

  // A service is the whole point of a single command: after this, nothing has to be run again. When
  // the paths would not survive — an npx cache, a Node that moves with the version manager — the
  // service would die silently, so the command stays in the foreground and says why.
  if (state.rottingPath) {
    steps.push({
      action: 'explain',
      message:
        `Staying in the foreground: ${state.rottingPath}.\n` +
        'A service pointing there stops working without saying so. To have it start on its own:\n\n' +
        '  npm install -g sorema\n  sorema\n',
    });
    steps.push({ action: 'run-in-foreground' });
    return steps;
  }

  if (!state.serviceInstalled) steps.push({ action: 'install-service' });
  // Installing already started it, and a second copy in this terminal would fight the first for the
  // socket. Reporting that is more useful than appearing to hang.
  steps.push({ action: 'already-running' });
  return steps;
}
