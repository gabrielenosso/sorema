#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version') || args[0] === '--version') {
  process.stdout.write('codex-cli 9.9.9-stub\n');
  process.exit(0);
}

if (args.includes('--help')) {
  const resuming = args[1] === 'resume';
  process.stdout.write(
    [
      'Usage: codex exec [OPTIONS] [PROMPT]',
      '  -c, --config <key=value>',
      '      --strict-config',
      '      --skip-git-repo-check',
      '      --json',
      '  -o, --output-last-message <FILE>',
      ...(resuming ? [] : ['  -C, --cd <DIR>', '  -s, --sandbox <SANDBOX_MODE>']),
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const lastMessageIndex = args.indexOf('--output-last-message');
const lastMessagePath = lastMessageIndex === -1 ? null : args[lastMessageIndex + 1];
const resumedSessionId = args[1] === 'resume' ? args[2] : null;
const sessionId = resumedSessionId ?? '11111111-2222-3333-4444-555555555555';

let instruction = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  instruction += chunk;
});

process.stdin.on('end', () => {
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

  emit({ type: 'thread.started', thread_id: sessionId });
  emit({ type: 'item.completed', item: { item_type: 'command_execution', command: 'pnpm test' } });
  emit({ type: 'item.completed', item: { item_type: 'patch', changes: 1 } });
  emit({ type: 'item.completed', item: { item_type: 'agent_message' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } });

  if (lastMessagePath) {
    const verb = resumedSessionId ? 'Continued the session and' : 'Implemented';
    const configOverrides = args.filter((arg, index) => args[index - 1] === '-c');
    writeFileSync(
      lastMessagePath,
      `${verb} the requested change for: ${instruction.trim()}\n\nAdded a test and the suite passed.\nconfig: ${configOverrides.join(' ')}\n`,
      'utf8',
    );
  }

  process.exit(instruction.includes('MAKE_ME_FAIL') ? 3 : 0);
});
