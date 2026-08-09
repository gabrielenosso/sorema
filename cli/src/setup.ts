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
  | { action: 'install-globally' }
  | { action: 'install-service' }
  | { action: 'restart-service' }
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
  // A code given explicitly wins over what this machine believes about itself. Its identity file can
  // name an account that no longer exists — a rebuilt user pool leaves exactly that — and then the
  // machine reports itself paired while the account it claims cannot see it. Somebody typing a fresh
  // code is saying which account this machine belongs to, and that is the more recent truth.
  if (state.code) steps.push({ action: 'pair', code: state.code });

  // A service is the whole point of a single command: after this, nothing has to be run again. When
  // the paths would not survive — an npx cache, a Node that moves with the version manager — the
  // service would die silently, so the command stays in the foreground and says why.
  if (state.rottingPath) {
    steps.push({
      action: 'explain',
      message: `Installing sorema properly first, because ${state.rottingPath}.`,
    });
    steps.push({ action: 'install-globally' });
  }

  if (!state.serviceInstalled) steps.push({ action: 'install-service' });
  // A service that was already running when the pairing happened is still answering as the machine
  // this one used to be: the new key is on disk, and the old socket is still open, so it has no
  // reason to reconnect and read it. The account shows the deleted machine online and the new one
  // as never having appeared. Nothing about that is visible from here, which is why it is done
  // rather than mentioned.
  else if (state.code) steps.push({ action: 'restart-service' });
  // Installing already started it, and a second copy in this terminal would fight the first for the
  // socket. Reporting that is more useful than appearing to hang.
  steps.push({ action: 'already-running' });
  return steps;
}
