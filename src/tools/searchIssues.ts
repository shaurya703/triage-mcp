import { z } from 'zod';
import type { GitHubClient } from '../github.js';
import type { GhSearchIssuesResponse } from '../types.js';
import { labelNames, limitSchema, repoSchema } from '../util.js';

export const searchIssuesShape = {
  repo: repoSchema,
  query: z.string().min(1).max(256).describe('Free-text search terms'),
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: limitSchema(30, 10),
};

type Args = z.output<z.ZodObject<typeof searchIssuesShape>>;

export async function searchIssues(client: GitHubClient, args: Args) {
  const stateTerm = args.state === 'all' ? '' : ` is:${args.state}`;
  const q = `${args.query} repo:${args.repo} is:issue${stateTerm}`;
  const data = await client.getJson<GhSearchIssuesResponse>('/search/issues', {
    query: { q, per_page: args.limit, sort: 'updated', order: 'desc' },
  });
  return {
    totalCount: data.total_count,
    returned: Math.min(data.items.length, args.limit),
    issues: data.items.slice(0, args.limit).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      labels: labelNames(i.labels),
      comments: i.comments,
      updatedAt: i.updated_at,
      url: i.html_url,
    })),
  };
}
