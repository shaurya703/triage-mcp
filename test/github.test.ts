import { describe, expect, it } from '@jest/globals';
import { GitHubClient, GitHubError } from '../src/github.js';
import { jsonResponse, makeClient, mockFetch } from './helpers.js';

const NOW = 1_000_000_000_000; // matches makeClient's clock
const ok = () => jsonResponse({ ok: true });
const limited = (headers: Record<string, string>, status = 403) => () =>
  jsonResponse({ message: 'API rate limit exceeded' }, { status, headers });

describe('request headers', () => {
  it('sends version, user agent and token', async () => {
    const mock = mockFetch({ '/x': ok });
    await makeClient(mock.fetch, { token: 'tok' }).getJson('/x');
    expect(mock.calls[0]!.headers).toMatchObject({
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'triage-mcp',
      Authorization: 'Bearer tok',
    });
  });

  it('omits Authorization without a token', async () => {
    const mock = mockFetch({ '/x': ok });
    await makeClient(mock.fetch).getJson('/x');
    expect(mock.calls[0]!.headers.Authorization).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('waits for a short retry-after and then succeeds', async () => {
    const mock = mockFetch({ '/x': [limited({ 'retry-after': '3' }, 429), ok] });
    const client = makeClient(mock.fetch);
    await expect(client.getJson('/x')).resolves.toEqual({ ok: true });
    expect(client.sleeps).toEqual([3000]);
    expect(mock.calls).toHaveLength(2);
  });

  it('waits until x-ratelimit-reset when remaining is 0', async () => {
    const reset = String(NOW / 1000 + 4);
    const mock = mockFetch({
      '/x': [limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), ok],
    });
    const client = makeClient(mock.fetch);
    await client.getJson('/x');
    expect(client.sleeps).toEqual([4000]);
  });

  it('does not wait when the reset is far away, and says when it resets', async () => {
    const reset = String(NOW / 1000 + 1800);
    const mock = mockFetch({
      '/x': limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
    });
    const client = makeClient(mock.fetch);
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).kind).toBe('rate_limited');
    expect((err as GitHubError).message).toContain(new Date(NOW + 1_800_000).toISOString());
    expect((err as GitHubError).message).toContain('GITHUB_TOKEN');
    expect(client.sleeps).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });

  it('respects the configurable max wait', async () => {
    const mock = mockFetch({ '/x': [limited({ 'retry-after': '30' }), ok] });
    const patient = makeClient(mock.fetch, { maxWaitMs: 60_000 });
    await expect(patient.getJson('/x')).resolves.toEqual({ ok: true });
    expect(patient.sleeps).toEqual([30_000]);
  });

  it('stops after the retry cap', async () => {
    const mock = mockFetch({ '/x': limited({ 'retry-after': '1' }) });
    const client = makeClient(mock.fetch, { maxRetries: 2 });
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect((err as GitHubError).kind).toBe('rate_limited');
    expect(mock.calls).toHaveLength(3); // first try + 2 retries
    expect(client.sleeps).toEqual([1000, 1000]);
  });

  it('treats a plain 403 (no rate-limit headers) as forbidden, not retryable', async () => {
    const mock = mockFetch({ '/x': () => jsonResponse({ message: 'Resource not accessible' }, { status: 403 }) });
    const client = makeClient(mock.fetch);
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect((err as GitHubError).kind).toBe('forbidden');
    expect(mock.calls).toHaveLength(1);
  });
});

describe('other failures', () => {
  it('maps network errors to a GitHubError', async () => {
    const client = new GitHubClient({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect((err as GitHubError).kind).toBe('network');
  });

  it('maps 404 to not_found', async () => {
    const mock = mockFetch({ '/x': () => jsonResponse({ message: 'Not Found' }, { status: 404 }) });
    const err = await makeClient(mock.fetch).getJson('/x').catch((e: unknown) => e);
    expect((err as GitHubError).kind).toBe('not_found');
  });
});
