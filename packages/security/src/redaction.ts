const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)(["']?)([^\s"',;]{8,})\2/gi,
];

export function redactSecrets(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, ...groups) =>
      pattern.source.includes('api[_-]?key') ? `${String(groups[0])}[redacted]` : '[redacted]',
    );
  }
  return output;
}

export function truncateOutput(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n[output truncated at ${maxBytes} bytes]`;
}
