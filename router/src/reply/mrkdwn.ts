// Convert standard Markdown → Slack's `mrkdwn` dialect.
// Slack uses `*bold*` (not `**bold**`), `<url|text>` (not `[text](url)`),
// has no headers, and renders no markdown tables. See
// https://api.slack.com/reference/surfaces/formatting.
//
// Code blocks + inline code segments are protected first so their content is
// not touched by any transformation.

export function toSlackMrkdwn(input: string): string {
  const protectedInput = protectCode(input);
  let out = protectedInput.text;
  out = convertTables(out);
  out = convertHeaders(out);
  out = convertBold(out);
  out = convertLinks(out);
  out = restoreCode(out, protectedInput.tokens);
  return out;
}

type ProtectedInput = { text: string; tokens: string[] };

function protectCode(input: string): ProtectedInput {
  const tokens: string[] = [];
  const push = (raw: string): string => {
    const i = tokens.length;
    tokens.push(raw);
    return `<<<MRKDWN_CODE_${i}>>>`;
  };
  const fenced = input.replace(/```[\s\S]*?```/g, (m) => push(m));
  const inline = fenced.replace(/`[^`\n]+`/g, (m) => push(m));
  return { text: inline, tokens };
}

function restoreCode(text: string, tokens: string[]): string {
  return text.replace(/<<<MRKDWN_CODE_(\d+)>>>/g, (_, i) => tokens[Number(i)] ?? '');
}

function convertHeaders(input: string): string {
  return input.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*');
}

function convertBold(input: string): string {
  return input.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*').replace(/__([^_\n]+?)__/g, '*$1*');
}

function convertLinks(input: string): string {
  return input.replace(/\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, '<$2|$1>');
}

// Markdown tables render as literal pipe characters in Slack. Wrap them in a
// triple-backtick code fence so they render in monospace and align visually.
// The separator row (`|---|---|`) is dropped.
function convertTables(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let buf: string[] | null = null;

  const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
  const isSeparator = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line);

  const flush = (): void => {
    if (buf !== null && buf.length > 0) {
      out.push('```', ...buf, '```');
    }
    buf = null;
  };

  for (const line of lines) {
    if (isTableRow(line)) {
      if (buf === null) buf = [];
      if (!isSeparator(line)) buf.push(line.trim());
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}
