import { z } from 'zod';
import type { GitHubClient } from '../github.js';
import type { GhSearchCodeResponse } from '../types.js';
import { limitSchema, repoSchema } from '../util.js';

export const findRelatedCodeShape = {
  repo: repoSchema,
  query: z.string().min(1).max(256).describe('Identifier, error message or phrase to look for'),
  limit: limitSchema(20, 10),
};

type Args = z.output<z.ZodObject<typeof findRelatedCodeShape>>;

export async function findRelatedCode(client: GitHubClient, args: Args) {
  // GitHub code search needs authentication. Without a token the client
  // surfaces the 401 as a readable error telling the user to set GITHUB_TOKEN.
  const data = await client.getJson<GhSearchCodeResponse>('/search/code', {
    query: { q: `${args.query} repo:${args.repo}`, per_page: args.limit },
    accept: 'application/vnd.github.text-match+json',
  });
  return {
    totalCount: data.total_count,
    results: data.items.slice(0, args.limit).map((item) => ({
      path: item.path,
      url: item.html_url,
      fragments: (item.text_matches ?? []).map((m) => m.fragment),
    })),
  };
}
