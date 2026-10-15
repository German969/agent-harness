// The real transport's error text. Linear rejects a query or mutation with HTTP 400
// and the reason in the body; HAR-8's first create run failed reading only
// "HTTP 400", with nothing to act on.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultGraphQL } from '../../src/linear/linearClient.js';

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('defaultGraphQL', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts Linear's own reason on an HTTP 400", async () => {
    respond(400, {
      errors: [
        {
          message: 'Forbidden',
          extensions: { userPresentableMessage: 'Invalid scope: `write` required' },
        },
      ],
    });
    await expect(defaultGraphQL('lin_api_x', 'https://example.test')('q', {})).rejects.toThrow(
      'linear graphql HTTP 400: Invalid scope: `write` required',
    );
  });

  it('falls back to the message, and to the bare status when the body says nothing', async () => {
    respond(400, { errors: [{ message: 'Argument Validation Error' }] });
    await expect(defaultGraphQL('lin_api_x', 'https://example.test')('q', {})).rejects.toThrow(
      'HTTP 400: Argument Validation Error',
    );
    respond(502, 'bad gateway');
    await expect(defaultGraphQL('lin_api_x', 'https://example.test')('q', {})).rejects.toThrow(
      /HTTP 502$/,
    );
  });
});
