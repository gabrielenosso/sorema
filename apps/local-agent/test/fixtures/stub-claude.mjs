#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('9.9.9-stub (Claude Code)\n');
  process.exit(0);
}

if (args.includes('--help')) {
  const chromeHelp = args.includes('--stub-no-chrome') ? [] : ['      --chrome'];
  process.stdout.write(
    [
      'Usage: claude [options] [command] [prompt]',
      '  -p, --print',
      '      --output-format <format>',
      '      --verbose',
      '      --session-id <uuid>',
      '  -r, --resume [value]',
      '      --permission-mode <mode>',
      ...chromeHelp,
      '      --add-dir <directories...>',
      '      --dangerously-skip-permissions',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (args.includes('auth') && args.includes('status')) {
  const loggedIn = !args.includes('--stub-logged-out');
  process.stdout.write(
    `${JSON.stringify({ loggedIn, authMethod: loggedIn ? 'oauth' : 'none', apiProvider: 'firstParty' })}\n`,
  );
  process.exit(loggedIn ? 0 : 1);
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

const resumedSessionId = valueOf('--resume');
const sessionId = resumedSessionId ?? valueOf('--session-id') ?? 'unknown-session';

let instruction = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  instruction += chunk;
});

process.stdin.on('end', () => {
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
  });
  emit({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
  emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] },
  });

  if (instruction.includes('MAKE_ME_FAIL')) {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'The build did not compile.',
      session_id: sessionId,
    });
    process.exit(1);
  }

  const verb = resumedSessionId ? 'Continued the session and' : 'Implemented';
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `${verb} the requested change for: ${instruction.trim()}\n\nAdded a test and the suite passed.\nflags: ${args.join(' ')}`,
    session_id: sessionId,
    total_cost_usd: 0.01,
  });
  process.exit(0);
});
