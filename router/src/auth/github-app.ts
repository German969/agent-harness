// GitHub App authentication — mint installation access tokens.
//
// The Anthropic MCP for GitHub (`@modelcontextprotocol/server-github`) accepts
// a Personal Access Token OR a GitHub App installation token. Installation
// tokens are short-lived (1 hour) and installation-scoped — the correct
// pattern for per-agent isolation.
//
// Flow: sign a JWT with the App's private key → exchange it at GitHub's API
// for an installation-scoped access token. `@octokit/auth-app` handles both
// steps + caches until near-expiry.

import { createAppAuth } from '@octokit/auth-app';

export type InstallationTokenRequest = {
  /** Numeric GitHub App ID (e.g. 123456). */
  appId: number;
  /** RSA private key PEM contents, including BEGIN/END headers. */
  privateKey: string;
  /** Numeric installation id — the App's install on a specific repo/org. */
  installationId: number;
};

/**
 * Return a fresh GitHub App installation access token (`ghs_...`).
 *
 * The token is scoped to the App's installation on the target repo. Expires
 * after ~1 hour. Sessions longer than that need to re-mint (not a concern
 * for router's per-session usage).
 */
export async function mintInstallationToken(req: InstallationTokenRequest): Promise<string> {
  const auth = createAppAuth({
    appId: req.appId,
    privateKey: req.privateKey,
    installationId: req.installationId,
  });
  const { token } = await auth({ type: 'installation' });
  return token;
}
