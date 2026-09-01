#!/usr/bin/env python3
"""Re-quote the ops workflow's `command` input into an argv the VPS shell cannot
re-interpret.

`ssh host CMD` concatenates its command arguments into a single string, and the
REMOTE shell parses that string before anything else runs. So interpolating the
operator's input unquoted into

    ssh host "sh .../ops.sh ${OPS_CMD}"

let shell metacharacters escape ops.sh entirely: `ps; id -un` ran `id -un` on the
VPS as a second command, which ops.sh's allowlist never saw. ops.sh is only a
containment boundary for input that reaches it AS ARGUMENTS.

This reads OPS_CMD from the environment and prints a re-quoted single line:

    ps                  -> ps
    logs router 60      -> logs router 60
    sql "SELECT 1"      -> sql 'SELECT 1'
    ps; id -un          -> 'ps;' id -un      (ops.sh sees op name "ps;" -> rejected)

shlex.split honours the operator's own quoting, so a quoted SQL query stays one
argument, and treats `;` `&&` `|` as ordinary characters rather than separators.
shlex.quote then makes every argument inert to the remote shell.
"""

import os
import shlex
import sys


def quote_op(raw: str) -> str:
    # Newlines would break the single-line command handed to ssh. Nothing legitimate
    # needs them, so reject rather than try to escape them.
    if "\n" in raw or "\r" in raw:
        raise ValueError("newlines are not allowed in the command")

    argv = shlex.split(raw)
    if not argv:
        raise ValueError("empty command")

    return " ".join(shlex.quote(a) for a in argv)


# (input, expected re-quoted argv). The injection cases are the point of this
# script: each one used to reach the VPS as a second command that ops.sh never saw.
SELFTEST = [
    ("ps", "ps"),
    ("logs router 60", "logs router 60"),
    ("sessions 8", "sessions 8"),
    ("state projects/iris/strategist/mvp-scope.md", "state projects/iris/strategist/mvp-scope.md"),
    # Operator quoting is honoured: the query stays a single argument.
    ('sql "SELECT id FROM sessions LIMIT 2"', "sql 'SELECT id FROM sessions LIMIT 2'"),
    # Metacharacters become inert literals, so ops.sh's allowlist gets to reject them.
    ("ps; id -un", "'ps;' id -un"),
    ("ps && echo pwned", "ps '&&' echo pwned"),
    ("ps | tee /tmp/x", "ps '|' tee /tmp/x"),
    ("ps $(id -un)", "ps '$(id' '-un)'"),
    ("ps `id -un`", "ps '`id' '-un`'"),
    ("ps > /tmp/x", "ps '>' /tmp/x"),
]


def selftest() -> int:
    failures = 0
    for raw, expected in SELFTEST:
        got = quote_op(raw)
        if got != expected:
            print(f"FAIL {raw!r}\n  expected {expected!r}\n  got      {got!r}", file=sys.stderr)
            failures += 1

    for raw, why in [("", "empty"), ("   ", "whitespace only"), ("ps\nid", "newline")]:
        try:
            quote_op(raw)
        except ValueError:
            continue
        print(f"FAIL {why} input {raw!r} should have been rejected", file=sys.stderr)
        failures += 1

    if failures:
        print(f"quote-op selftest: {failures} failure(s)", file=sys.stderr)
        return 1
    print(f"quote-op selftest: {len(SELFTEST)} quoting cases + 3 rejections OK")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()

    raw = os.environ.get("OPS_CMD", "")
    try:
        print(quote_op(raw))
    except ValueError as err:
        print(f"ops: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
