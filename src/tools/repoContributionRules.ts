import { z } from 'zod';
import type { GitHubClient } from '../github.js';
import { GitHubError } from '../github.js';
import { repoSchema, truncate } from '../util.js';

export const repoContributionRulesShape = { repo: repoSchema };

type Args = z.output<z.ZodObject<typeof repoContributionRulesShape>>;

const CONTRIBUTING_PATHS = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];
const TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
];
const MAX_FILE_CHARS = 6000;
const MAX_MATCHES = 20;
const MAX_LINE_CHARS = 300;

// "AI" is matched case-sensitively so it does not hit words like "said".
const AI_PATTERNS = [
  /\bAI\b/,
  /\b(artificial intelligence|large language model|LLMs?|generative|copilot|chatgpt|claude|gemini|cursor|agentic)\b/i,
  /\bAI[- ](generated|assisted|authored|tools?|policy|disclosure)\b/i,
];

export interface AiMatch {
  file: string;
  line: number;
  text: string;
}

export function findAiMentions(file: string, content: string): AiMatch[] {
  const matches: AiMatch[] = [];
  content.split('\n').forEach((text, index) => {
    if (AI_PATTERNS.some((p) => p.test(text))) {
      matches.push({
        file,
        line: index + 1,
        text: truncate(text.trim(), MAX_LINE_CHARS).text,
      });
    }
  });
  return matches;
}

interface FoundFile {
  path: string;
  content: string;
}

/** Returns the first path that exists, or null. Only 404 means "absent". */
async function fetchFirst(
  client: GitHubClient,
  repo: string,
  paths: string[],
): Promise<FoundFile | null> {
  for (const path of paths) {
    try {
      const content = await client.getText(`/repos/${repo}/contents/${path}`, {
        accept: 'application/vnd.github.raw+json',
      });
      return { path, content };
    } catch (err) {
      if (err instanceof GitHubError && err.kind === 'not_found') continue;
      throw err;
    }
  }
  return null;
}

function describe(file: FoundFile | null) {
  if (!file) return null;
  const body = truncate(file.content, MAX_FILE_CHARS);
  return { path: file.path, content: body.text, truncated: body.truncated };
}

export async function repoContributionRules(client: GitHubClient, args: Args) {
  // Fails early with a clear message if the repository itself is missing, so
  // "no CONTRIBUTING file" is never confused with "no such repository".
  await client.getJson(`/repos/${args.repo}`);

  const contributing = await fetchFirst(client, args.repo, CONTRIBUTING_PATHS);
  const template = await fetchFirst(client, args.repo, TEMPLATE_PATHS);

  const aiMentions = [
    ...(contributing ? findAiMentions(contributing.path, contributing.content) : []),
    ...(template ? findAiMentions(template.path, template.content) : []),
  ];

  return {
    contributing: describe(contributing),
    pullRequestTemplate: describe(template),
    aiKeywordMatches: aiMentions.slice(0, MAX_MATCHES),
    aiKeywordMatchCount: aiMentions.length,
    note:
      'aiKeywordMatches lists lines that contain AI-related keywords. A match is a ' +
      'prompt to read the line, not proof of a policy; no matches is not proof of ' +
      'no policy, since rules can live in the wiki, a README, or a bot.',
  };
}
