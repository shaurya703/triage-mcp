import { describe, expect, it } from '@jest/globals';
import { decideVerdict, type LinkedPr } from '../src/tools/checkExistingFix.js';
import {
  callTool,
  connectClient,
  fixture,
  jsonResponse,
  makeClient,
  mockFetch,
} from './helpers.js';

const R = '/repos/acme/widgets';

interface PrOptions {
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
  updated?: string;
  body?: string;
}

function pr(o: PrOptions = {}) {
  const number = o.number ?? 55;
  return {
    number,
    title: `Fix for #42 (PR ${number})`,
    state: o.state ?? 'open',
    draft: o.draft ?? false,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    user: { login: 'erin' },
    labels: [],
    comments: 0,
    created_at: '2026-10-10T12:00:00Z',
    updated_at: o.updated ?? '2026-10-12T12:00:00Z',
    body: o.body ?? 'Fixes #42',
    repository_url: 'https://api.github.com/repos/acme/widgets',
    pull_request: { merged_at: o.merged ? '2026-10-13T00:00:00Z' : null },
  };
}

const crossRef = (p: object) => ({ event: 'cross-referenced', source: { type: 'issue', issue: p } });

async function run(opts: {
  assignees?: string[];
  timeline?: object[];
  search?: object[];
  issue?: object;
}) {
  const issue = {
    ...fixture<object>('issue.json'),
    assignees: (opts.assignees ?? []).map((login) => ({ login })),
    ...opts.issue,
  };
  const mock = mockFetch({
    [`${R}/issues/42`]: () => jsonResponse(issue),
    [`${R}/issues/42/timeline`]: () => jsonResponse(opts.timeline ?? []),
    '/search/issues': () =>
      jsonResponse({ total_count: 0, items: opts.search ?? [] }),
  });
  const mcp = await connectClient(makeClient(mock.fetch));
  const res = await callTool(mcp, 'check_existing_fix', { repo: 'acme/widgets', number: 42 });
  expect(res.isError).toBe(false);
  return res.data;
}

describe('check_existing_fix verdicts', () => {
  it('unclaimed: no assignee, no PRs', async () => {
    const data = await run({});
    expect(data.verdict).toBe('unclaimed');
    expect(data.assigned).toBe(false);
    expect(data.pullRequests).toEqual([]);
    expect(data.reason).toMatch(/No assignee/);
  });

  it('assigned: assignee but no PR', async () => {
    const data = await run({ assignees: ['zed'] });
    expect(data.verdict).toBe('assigned');
    expect(data.assigned).toBe(true);
    expect(data.reason).toContain('zed');
  });

  it('open_pr_exists: open PR from the timeline, with author and draft flag', async () => {
    const data = await run({ timeline: [crossRef(pr({ draft: true }))] });
    expect(data.verdict).toBe('open_pr_exists');
    expect(data.pullRequests[0]).toMatchObject({
      number: 55,
      state: 'open',
      author: 'erin',
      draft: true,
      foundVia: ['timeline'],
    });
    expect(data.reason).toContain('draft PR #55');
  });

  it('open PR beats an assignee', async () => {
    const data = await run({ assignees: ['zed'], timeline: [crossRef(pr())] });
    expect(data.verdict).toBe('open_pr_exists');
    expect(data.assigned).toBe(true);
  });

  it('already_fixed: merged PR', async () => {
    const data = await run({
      timeline: [crossRef(pr({ state: 'closed', merged: true }))],
      issue: { state: 'closed' },
    });
    expect(data.verdict).toBe('already_fixed');
    expect(data.pullRequests[0].state).toBe('merged');
  });

  it('already_fixed notes when the issue is still open', async () => {
    const data = await run({ timeline: [crossRef(pr({ state: 'closed', merged: true }))] });
    expect(data.verdict).toBe('already_fixed');
    expect(data.reason).toContain('still open');
  });

  it('a PR closed without merging is not a fix', async () => {
    const data = await run({ timeline: [crossRef(pr({ state: 'closed', merged: false }))] });
    expect(data.pullRequests[0].state).toBe('closed_unmerged');
    expect(data.verdict).toBe('unclaimed');
  });

  it('closed-unmerged PR with an assignee still gives assigned', async () => {
    const data = await run({
      assignees: ['zed'],
      timeline: [crossRef(pr({ state: 'closed' }))],
    });
    expect(data.verdict).toBe('assigned');
  });
});

describe('check_existing_fix PR discovery', () => {
  it('dedupes a PR found by both the timeline and search', async () => {
    const data = await run({ timeline: [crossRef(pr())], search: [pr()] });
    expect(data.pullRequests).toHaveLength(1);
    expect(data.pullRequests[0].foundVia).toEqual(['timeline', 'search']);
  });

  it('keeps PRs found by only one route', async () => {
    const data = await run({
      timeline: [crossRef(pr({ number: 55 }))],
      search: [pr({ number: 56, updated: '2026-10-14T00:00:00Z' })],
    });
    expect(data.pullRequests.map((p: LinkedPr) => p.number)).toEqual([56, 55]);
  });

  it('ignores timeline references from plain issues and from other repos', async () => {
    const foreign = { ...pr({ number: 7 }), repository_url: 'https://api.github.com/repos/other/repo' };
    const plainIssue = { ...pr({ number: 8 }), pull_request: undefined };
    const data = await run({ timeline: [crossRef(foreign), crossRef(plainIssue)] });
    expect(data.pullRequests).toEqual([]);
  });

  it('drops search hits that only contain the number by coincidence', async () => {
    const noise = pr({ number: 300, body: 'Updates 1420 packages', state: 'closed', merged: true });
    noise.title = 'Bump deps';
    const data = await run({ search: [noise] });
    expect(data.pullRequests).toEqual([]);
    expect(data.verdict).toBe('unclaimed');
  });

  it('works end to end with the shipped fixtures', async () => {
    const data = await run({
      timeline: fixture<object[]>('timeline.json'),
      search: fixture<{ items: object[] }>('search-prs.json').items,
    });
    expect(data.verdict).toBe('open_pr_exists');
    expect(data.pullRequests).toHaveLength(1);
    expect(data.pullRequests[0].foundVia).toEqual(['timeline', 'search']);
  });

  it('rejects a pull request number', async () => {
    const mock = mockFetch({
      [`${R}/issues/42`]: () =>
        jsonResponse({ ...fixture<object>('issue.json'), pull_request: { merged_at: null } }),
    });
    const mcp = await connectClient(makeClient(mock.fetch));
    const res = await callTool(mcp, 'check_existing_fix', { repo: 'acme/widgets', number: 42 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('pull request');
  });
});

describe('decideVerdict precedence', () => {
  const base = { issueNumber: 1, issueState: 'open' as const, assignees: [] };
  const mk = (state: LinkedPr['state'], n: number): LinkedPr => ({
    number: n, title: '', url: '', state, author: 'a', draft: false, updatedAt: '', foundVia: ['search'],
  });

  it('merged beats open', () => {
    expect(decideVerdict({ ...base, prs: [mk('open', 2), mk('merged', 3)] }).verdict).toBe('already_fixed');
  });
  it('open beats assigned', () => {
    expect(decideVerdict({ ...base, assignees: ['x'], prs: [mk('open', 2)] }).verdict).toBe('open_pr_exists');
  });
});
