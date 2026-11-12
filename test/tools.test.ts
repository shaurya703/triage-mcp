import { describe, expect, it } from '@jest/globals';
import {
  callTool,
  connectClient,
  fixture,
  jsonResponse,
  makeClient,
  mockFetch,
  textResponse,
} from './helpers.js';

const R = '/repos/acme/widgets';

async function setup(routes: Parameters<typeof mockFetch>[0]) {
  const mock = mockFetch(routes);
  const mcp = await connectClient(makeClient(mock.fetch));
  return { mcp, mock };
}

describe('search_issues', () => {
  it('returns trimmed issue summaries and builds the query', async () => {
    const { mcp, mock } = await setup({
      '/search/issues': () => jsonResponse(fixture('search-issues.json')),
    });
    const res = await callTool(mcp, 'search_issues', {
      repo: 'acme/widgets',
      query: 'config',
      state: 'open',
      limit: 5,
    });
    expect(res.isError).toBe(false);
    expect(res.data.totalCount).toBe(2);
    expect(res.data.issues[0]).toEqual({
      number: 42,
      title: 'Crash when config file is empty',
      state: 'open',
      labels: ['bug', 'good first issue'],
      comments: 3,
      updatedAt: '2026-10-20T14:30:00Z',
      url: 'https://github.com/acme/widgets/issues/42',
    });
    const q = mock.calls[0]!.url.searchParams;
    expect(q.get('q')).toBe('config repo:acme/widgets is:issue is:open');
    expect(q.get('per_page')).toBe('5');
  });

  it('omits the state qualifier for state=all and caps the limit', async () => {
    const { mcp, mock } = await setup({
      '/search/issues': () => jsonResponse(fixture('search-issues.json')),
    });
    const tooMany = await callTool(mcp, 'search_issues', {
      repo: 'acme/widgets',
      query: 'x',
      limit: 500,
    });
    expect(tooMany.isError).toBe(true);
    await callTool(mcp, 'search_issues', { repo: 'acme/widgets', query: 'x', state: 'all' });
    expect(mock.calls[0]!.url.searchParams.get('q')).toBe('x repo:acme/widgets is:issue');
  });
});

describe('get_issue', () => {
  it('returns the issue with the most recent comments', async () => {
    const { mcp, mock } = await setup({
      [`${R}/issues/42`]: () => jsonResponse(fixture('issue.json')),
      [`${R}/issues/42/comments`]: () => jsonResponse(fixture('issue-comments.json')),
    });
    const res = await callTool(mcp, 'get_issue', {
      repo: 'acme/widgets',
      number: 42,
      commentLimit: 2,
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({
      number: 42,
      author: 'alice',
      state: 'open',
      labels: ['bug', 'good first issue'],
      assignees: [],
      bodyTruncated: false,
      commentCount: 3,
    });
    expect(res.data.recentComments.map((c: any) => c.author)).toEqual(['maintainer1', 'carol']);
    // Comments are fetched from the last page (3 comments -> page 1 of 100).
    expect(mock.calls[1]!.url.searchParams.get('page')).toBe('1');
  });

  it('sets bodyTruncated when the body is cut', async () => {
    const long = { ...fixture<object>('issue.json'), body: 'x'.repeat(10_000), comments: 0 };
    const { mcp } = await setup({ [`${R}/issues/42`]: () => jsonResponse(long) });
    const res = await callTool(mcp, 'get_issue', { repo: 'acme/widgets', number: 42 });
    expect(res.data.bodyTruncated).toBe(true);
    expect(res.data.body.length).toBeLessThan(10_000);
    expect(res.data.recentComments).toEqual([]);
  });

  it('truncates long comments and flags them', async () => {
    const comments = [
      { user: { login: 'bob' }, created_at: '2026-10-02T10:00:00Z', body: 'y'.repeat(5000) },
    ];
    const { mcp } = await setup({
      [`${R}/issues/42`]: () => jsonResponse({ ...fixture<object>('issue.json'), comments: 1 }),
      [`${R}/issues/42/comments`]: () => jsonResponse(comments),
    });
    const res = await callTool(mcp, 'get_issue', { repo: 'acme/widgets', number: 42 });
    expect(res.data.recentComments[0].bodyTruncated).toBe(true);
  });

  it('reads the previous page when the last page is short', async () => {
    const page = (ids: number[]) =>
      ids.map((id) => ({ user: { login: `u${id}` }, created_at: '2026-10-02T10:00:00Z', body: 'c' }));
    const { mcp } = await setup({
      [`${R}/issues/42`]: () => jsonResponse({ ...fixture<object>('issue.json'), comments: 101 }),
      [`${R}/issues/42/comments`]: (url) =>
        jsonResponse(url.searchParams.get('page') === '2' ? page([101]) : page([...Array(100).keys()])),
    });
    const res = await callTool(mcp, 'get_issue', {
      repo: 'acme/widgets',
      number: 42,
      commentLimit: 3,
    });
    expect(res.data.recentComments.map((c: any) => c.author)).toEqual(['u98', 'u99', 'u101']);
  });
});

describe('find_related_code', () => {
  it('returns paths, urls and text-match fragments when present', async () => {
    const { mcp, mock } = await setup({
      '/search/code': () => jsonResponse(fixture('search-code.json')),
    });
    const res = await callTool(mcp, 'find_related_code', {
      repo: 'acme/widgets',
      query: 'loadConfig',
    });
    expect(res.isError).toBe(false);
    expect(res.data.results[0].path).toBe('src/config.ts');
    expect(res.data.results[0].fragments[0]).toContain('loadConfig');
    expect(res.data.results[1].fragments).toEqual([]);
    expect(mock.calls[0]!.headers.Accept).toBe('application/vnd.github.text-match+json');
    expect(mock.calls[0]!.url.searchParams.get('q')).toBe('loadConfig repo:acme/widgets');
  });

  it('explains the token requirement on 401', async () => {
    const { mcp } = await setup({
      '/search/code': () => jsonResponse({ message: 'Requires authentication' }, { status: 401 }),
    });
    const res = await callTool(mcp, 'find_related_code', { repo: 'acme/widgets', query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('GITHUB_TOKEN');
  });
});

describe('repo_contribution_rules', () => {
  const repoRoute = { [R]: () => jsonResponse({ full_name: 'acme/widgets' }) };
  const notFound = () => jsonResponse({ message: 'Not Found' }, { status: 404 });

  it('detects an AI policy and returns the matched lines', async () => {
    const { mcp } = await setup({
      ...repoRoute,
      [`${R}/contents/CONTRIBUTING.md`]: () => textResponse(fixture('contributing-with-ai.md')),
      [`${R}/contents/.github/PULL_REQUEST_TEMPLATE.md`]: () =>
        textResponse(fixture('pr-template.md')),
    });
    const res = await callTool(mcp, 'repo_contribution_rules', { repo: 'acme/widgets' });
    expect(res.isError).toBe(false);
    expect(res.data.contributing.path).toBe('CONTRIBUTING.md');
    expect(res.data.pullRequestTemplate.path).toBe('.github/PULL_REQUEST_TEMPLATE.md');
    expect(res.data.aiKeywordMatchCount).toBeGreaterThan(0);
    const lines = res.data.aiKeywordMatches.map((m: any) => m.text).join('\n');
    expect(lines).toContain('must disclose');
    expect(res.data.aiKeywordMatches[0].file).toBe('CONTRIBUTING.md');
  });

  it('reports no matches for a plain file ("said" is not "AI")', async () => {
    const { mcp } = await setup({
      ...repoRoute,
      [`${R}/contents/CONTRIBUTING.md`]: () => textResponse(fixture('contributing-plain.md')),
      [`${R}/contents/.github/PULL_REQUEST_TEMPLATE.md`]: notFound,
      [`${R}/contents/PULL_REQUEST_TEMPLATE.md`]: notFound,
      [`${R}/contents/docs/PULL_REQUEST_TEMPLATE.md`]: notFound,
    });
    const res = await callTool(mcp, 'repo_contribution_rules', { repo: 'acme/widgets' });
    expect(res.data.aiKeywordMatchCount).toBe(0);
    expect(res.data.aiKeywordMatches).toEqual([]);
    expect(res.data.pullRequestTemplate).toBeNull();
  });

  it('finds CONTRIBUTING.md under .github/', async () => {
    const { mcp } = await setup({
      ...repoRoute,
      [`${R}/contents/CONTRIBUTING.md`]: notFound,
      [`${R}/contents/.github/CONTRIBUTING.md`]: () =>
        textResponse(fixture('contributing-with-ai.md')),
      [`${R}/contents/.github/PULL_REQUEST_TEMPLATE.md`]: notFound,
      [`${R}/contents/PULL_REQUEST_TEMPLATE.md`]: notFound,
      [`${R}/contents/docs/PULL_REQUEST_TEMPLATE.md`]: notFound,
    });
    const res = await callTool(mcp, 'repo_contribution_rules', { repo: 'acme/widgets' });
    expect(res.data.contributing.path).toBe('.github/CONTRIBUTING.md');
    expect(res.data.aiKeywordMatchCount).toBeGreaterThan(0);
  });

  it('returns nulls, not an error, when the repo has neither file', async () => {
    const { mcp } = await setup({
      ...repoRoute,
      [`${R}/contents/CONTRIBUTING.md`]: notFound,
      [`${R}/contents/.github/CONTRIBUTING.md`]: notFound,
      [`${R}/contents/docs/CONTRIBUTING.md`]: notFound,
      [`${R}/contents/.github/PULL_REQUEST_TEMPLATE.md`]: notFound,
      [`${R}/contents/PULL_REQUEST_TEMPLATE.md`]: notFound,
      [`${R}/contents/docs/PULL_REQUEST_TEMPLATE.md`]: notFound,
    });
    const res = await callTool(mcp, 'repo_contribution_rules', { repo: 'acme/widgets' });
    expect(res.isError).toBe(false);
    expect(res.data.contributing).toBeNull();
  });
});

describe('errors', () => {
  it('turns a 404 into an isError result', async () => {
    const { mcp } = await setup({
      [`${R}/issues/999`]: () => jsonResponse({ message: 'Not Found' }, { status: 404 }),
    });
    const res = await callTool(mcp, 'get_issue', { repo: 'acme/widgets', number: 999 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Not found');
  });

  it('rejects a malformed repo without calling GitHub', async () => {
    const { mcp, mock } = await setup({});
    for (const repo of ['widgets', 'a/b/c', 'acme/wid gets', '']) {
      const res = await callTool(mcp, 'get_issue', { repo, number: 1 });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('owner/name');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects a non-positive issue number', async () => {
    const { mcp } = await setup({});
    const res = await callTool(mcp, 'check_existing_fix', { repo: 'acme/widgets', number: 0 });
    expect(res.isError).toBe(true);
  });

  it('turns a 422 from search into a readable error', async () => {
    const { mcp } = await setup({
      '/search/issues': () => jsonResponse({ message: 'Validation Failed' }, { status: 422 }),
    });
    const res = await callTool(mcp, 'search_issues', { repo: 'acme/widgets', query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Validation Failed');
  });
});
