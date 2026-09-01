import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @octokit/auth-app BEFORE importing the module under test. The mock's
// authFn is what each test mutates to control behavior.

const authFn = vi.fn();
const createAppAuthMock = vi.fn(() => authFn);

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: createAppAuthMock,
}));

const { mintInstallationToken } = await import('../../src/auth/github-app.js');

beforeEach(() => {
  authFn.mockReset();
  createAppAuthMock.mockClear();
});

describe('mintInstallationToken', () => {
  it('returns the token from an installation auth call', async () => {
    authFn.mockResolvedValue({ token: 'ghs_test_installation_token', type: 'token' });
    const token = await mintInstallationToken({
      appId: 123456,
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----',
      installationId: 7654321,
    });
    expect(token).toBe('ghs_test_installation_token');
  });

  it('constructs the app auth with the caller-provided credentials', async () => {
    authFn.mockResolvedValue({ token: 't' });
    await mintInstallationToken({
      appId: 42,
      privateKey: 'pk',
      installationId: 99,
    });
    expect(createAppAuthMock).toHaveBeenCalledWith({
      appId: 42,
      privateKey: 'pk',
      installationId: 99,
    });
    expect(authFn).toHaveBeenCalledWith({ type: 'installation' });
  });

  it('propagates errors from the auth call', async () => {
    authFn.mockRejectedValue(new Error('invalid private key'));
    await expect(
      mintInstallationToken({
        appId: 1,
        privateKey: 'bad',
        installationId: 2,
      }),
    ).rejects.toThrow(/invalid private key/);
  });
});
