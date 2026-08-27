/**
 * Telling a command apart from a pairing code.
 *
 * `sorema <CODE>` means the whole setup runs from one word, which also means every word this command
 * takes is competing with the shape of a code. `projects` is eight alphanumeric characters, which is
 * exactly what a code looks like, so `sorema projects` was read as a code and answered `fetch failed`
 * from the pairing endpoint — the same class of failure as `sorema KQZM-W7PT` answering "No command
 * called KQZM-W7PT", in the other direction.
 *
 * The words win. A code is issued by the service and can be issued again; a command word is the only
 * name a feature has, and the collision is silent in the direction that costs more.
 */
export const COMMAND_WORDS: ReadonlySet<string> = new Set([
  'help',
  '--help',
  'status',
  'projects',
  'pair',
  'start',
  'service',
]);

/**
 * Deliberately wider than the format the service issues today. Two pairing-code alphabets exist in
 * this codebase and only one is live, so a validator matching exactly the live one would silently
 * reject every code the day the other became live, and the symptom would be the command claiming
 * there is no such command. Anything that could be a code is sent, and the service decides. It is
 * the only half that knows.
 */
export function looksLikePairingCode(value: string | undefined): value is string {
  if (value === undefined || COMMAND_WORDS.has(value)) return false;
  // Six to sixteen, dashes anywhere, because the length is the service's business and not this
  // command's. Pinned at exactly eight, a code lengthened on the server would reach a machine
  // running an older release as "no such command" — a message about the wrong thing entirely, on
  // the one screen where somebody has no way to tell what went wrong.
  return /^[0-9A-Za-z]{2,}(?:-?[0-9A-Za-z]+)*$/.test(value) && value.replace(/-/g, '').length >= 6 && value.replace(/-/g, '').length <= 16;
}
