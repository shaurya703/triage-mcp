import { z } from 'zod';
import type { GitHubClient } from '../github.js';
import { GitHubError } from '../github.js';
import type { GhIssue, GhSearchIssuesResponse, GhTimelineEvent } from '../types.js';
import { issueNumberSchema, repoSchema } from '../util.js';

export const checkExistingFixShape = {
  repo: repoSchema,
  number: issueNumberSchema,
};

type Args = z.output<z.ZodObject<typeof checkExistingFixShape>>;

export type PrState = 'open' | 'merged' | 'closed_unmerged';
export type Verdict = 'unclaimed' | 'assigned' | 'open_pr_exists' | 'already_fixed';
type Source = 'timeline' | 'search';

export interface LinkedPr {
  number: number;
  title: string;
  url: string;
  state: PrState;
  author: string | null;
  draft: boolean;
  updatedAt: string;
  foundVia: Source[];
}

const TIMELINE_PAGE_SIZE = 100;
const TIMELINE_MAX_PAGES = 5;

export function prState(pr: GhIssue): PrState {
  if (pr.pull_request?.merged_at) return 'merged';
  return pr.state === 'open' ? 'open' : 'closed_unmerged';
}

/** Merge PRs from several routes into one entry per PR number. */
export function mergePrs(found: Array<{ pr: GhIssue; via: Source }>): LinkedPr[] {
  const byNumber = new Map<number, LinkedPr>();
  for (const { pr, via } of found) {
    const existing = byNumber.get(pr.number);
    if (existing) {
      if (!existing.foundVia.includes(via)) existing.foundVia.push(via);
      continue;
    }
    byNumber.set(pr.number, {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: prState(pr),
      author: pr.user?.login ?? null,
      draft: pr.draft ?? false,
      updatedAt: pr.updated_at,
      foundVia: [via],
    });
  }
  return [...byNumber.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Decide the verdict. Precedence: a merged PR beats an open PR, which beats an
 * assignee. A PR closed without merging is not a fix and is ignored here.
 */
export function decideVerdict(input: {
  issueNumber: number;
  issueState: 'open' | 'closed';
  assignees: string[];
  prs: LinkedPr[];
}): { verdict: Verdict; reason: string } {
  const merged = input.prs.find((p) => p.state === 'merged');
  if (merged) {
    const note =
      input.issueState === 'open'
        ? ' The issue is still open, so check that the PR really resolves it.'
        : '';
    return {
      verdict: 'already_fixed',
      reason: `PR #${merged.number} that references issue #${input.issueNumber} was merged.${note}`,
    };
  }
  const open = input.prs.find((p) => p.state === 'open');
  if (open) {
    const kind = open.draft ? 'draft PR' : 'PR';
    return {
      verdict: 'open_pr_exists',
      reason: `Open ${kind} #${open.number} by ${open.author ?? 'an unknown author'} references issue #${input.issueNumber}.`,
    };
  }
  if (input.assignees.length > 0) {
    return {
      verdict: 'assigned',
      reason: `Issue #${input.issueNumber} is assigned to ${input.assignees.join(', ')} and no open or merged PR references it.`,
    };
  }
  const closedNote = input.issueState === 'closed' ? ' The issue is closed, though.' : '';
  return {
    verdict: 'unclaimed',
    reason: `No assignee and no open or merged PR references issue #${input.issueNumber}.${closedNote}`,
  };
}

async function timelinePrs(
  client: GitHubClient,
  repo: string,
  number: number,
): Promise<GhIssue[]> {
  const sameRepo = `/repos/${repo.toLowerCase()}`;
  const prs: GhIssue[] = [];
  for (let page = 1; page <= TIMELINE_MAX_PAGES; page++) {
    const events = await client.getJson<GhTimelineEvent[]>(
      `/repos/${repo}/issues/${number}/timeline`,
      { query: { per_page: TIMELINE_PAGE_SIZE, page } },
    );
    for (const e of events) {
      const source = e.source?.issue;
      if (e.event !== 'cross-referenced' || !source?.pull_request) continue;
      // A PR in another repository cannot fix this repository's issue.
      if (!source.repository_url?.toLowerCase().endsWith(sameRepo)) continue;
      prs.push(source);
    }
    if (events.length < TIMELINE_PAGE_SIZE) break;
  }
  return prs;
}

/**
 * Search matches the bare number anywhere in a PR, which is noisy. Keep a hit
 * only if its title or body contains "#N" or ".../issues/N" as a whole number.
 */
function mentionsIssue(pr: GhIssue, number: number): boolean {
  const text = `${pr.title}\n${pr.body ?? ''}`;
  return new RegExp(`(#|/issues/)${number}(?!\\d)`).test(text);
}

async function searchPrs(
  client: GitHubClient,
  repo: string,
  number: number,
): Promise<GhIssue[]> {
  const data = await client.getJson<GhSearchIssuesResponse>('/search/issues', {
    query: { q: `${number} repo:${repo} is:pr`, per_page: 30, sort: 'updated', order: 'desc' },
  });
  return data.items.filter((pr) => mentionsIssue(pr, number));
}

export async function checkExistingFix(client: GitHubClient, args: Args) {
  const issue = await client.getJson<GhIssue>(`/repos/${args.repo}/issues/${args.number}`);
  if (issue.pull_request) {
    throw new GitHubError(
      'validation',
      `#${args.number} is a pull request, not an issue. Pass an issue number.`,
    );
  }
  const [fromTimeline, fromSearch] = await Promise.all([
    timelinePrs(client, args.repo, args.number),
    searchPrs(client, args.repo, args.number),
  ]);
  const prs = mergePrs([
    ...fromTimeline.map((pr) => ({ pr, via: 'timeline' as const })),
    ...fromSearch.map((pr) => ({ pr, via: 'search' as const })),
  ]);
  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const { verdict, reason } = decideVerdict({
    issueNumber: args.number,
    issueState: issue.state,
    assignees,
    prs,
  });
  return {
    issue: { number: issue.number, title: issue.title, state: issue.state, url: issue.html_url },
    assigned: assignees.length > 0,
    assignees,
    pullRequests: prs,
    verdict,
    reason,
  };
}
