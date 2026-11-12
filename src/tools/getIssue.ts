import { z } from 'zod';
import type { GitHubClient } from '../github.js';
import type { GhComment, GhIssue } from '../types.js';
import {
  MAX_BODY_CHARS,
  MAX_COMMENT_CHARS,
  issueNumberSchema,
  labelNames,
  limitSchema,
  repoSchema,
  truncate,
} from '../util.js';

export const getIssueShape = {
  repo: repoSchema,
  number: issueNumberSchema,
  commentLimit: limitSchema(20, 5).describe('How many of the most recent comments to include'),
};

type Args = z.output<z.ZodObject<typeof getIssueShape>>;

const PAGE_SIZE = 100;

/**
 * The comments endpoint is oldest-first, so the newest comments are on the
 * last page. Fetch the last page, and the one before it if that is not enough.
 */
async function recentComments(
  client: GitHubClient,
  repo: string,
  number: number,
  total: number,
  want: number,
): Promise<GhComment[]> {
  if (total === 0) return [];
  const lastPage = Math.ceil(total / PAGE_SIZE);
  const fetchPage = (page: number) =>
    client.getJson<GhComment[]>(`/repos/${repo}/issues/${number}/comments`, {
      query: { per_page: PAGE_SIZE, page },
    });
  let comments = await fetchPage(lastPage);
  if (comments.length < want && lastPage > 1) {
    comments = [...(await fetchPage(lastPage - 1)), ...comments];
  }
  return comments.slice(-want);
}

export async function getIssue(client: GitHubClient, args: Args) {
  const issue = await client.getJson<GhIssue>(`/repos/${args.repo}/issues/${args.number}`);
  const body = truncate(issue.body, MAX_BODY_CHARS);
  const comments = await recentComments(
    client,
    args.repo,
    args.number,
    issue.comments,
    args.commentLimit,
  );
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    isPullRequest: issue.pull_request !== undefined,
    author: issue.user?.login ?? null,
    labels: labelNames(issue.labels),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    body: body.text,
    bodyTruncated: body.truncated,
    commentCount: issue.comments,
    recentComments: comments.map((c) => {
      const text = truncate(c.body, MAX_COMMENT_CHARS);
      return {
        author: c.user?.login ?? null,
        createdAt: c.created_at,
        body: text.text,
        bodyTruncated: text.truncated,
      };
    }),
  };
}
