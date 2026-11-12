import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GitHubClient } from './github.js';
import { runTool } from './result.js';
import { checkExistingFix, checkExistingFixShape } from './tools/checkExistingFix.js';
import { findRelatedCode, findRelatedCodeShape } from './tools/findRelatedCode.js';
import { getIssue, getIssueShape } from './tools/getIssue.js';
import {
  repoContributionRules,
  repoContributionRulesShape,
} from './tools/repoContributionRules.js';
import { searchIssues, searchIssuesShape } from './tools/searchIssues.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function createServer(client: GitHubClient): McpServer {
  const server = new McpServer({ name: 'triage-mcp', version: '0.1.0' });

  server.registerTool(
    'search_issues',
    {
      description: 'Search issues in a GitHub repository by free text and state.',
      inputSchema: searchIssuesShape,
      annotations: READ_ONLY,
    },
    (args) => runTool(searchIssuesShape, args, (a) => searchIssues(client, a)),
  );

  server.registerTool(
    'get_issue',
    {
      description:
        'Get one issue: title, body (truncated if long), labels, assignees, author, state and the most recent comments.',
      inputSchema: getIssueShape,
      annotations: READ_ONLY,
    },
    (args) => runTool(getIssueShape, args, (a) => getIssue(client, a)),
  );

  server.registerTool(
    'find_related_code',
    {
      description:
        'Search the code of a repository for a term. Requires GITHUB_TOKEN because GitHub code search needs authentication.',
      inputSchema: findRelatedCodeShape,
      annotations: READ_ONLY,
    },
    (args) => runTool(findRelatedCodeShape, args, (a) => findRelatedCode(client, a)),
  );

  server.registerTool(
    'check_existing_fix',
    {
      description:
        'Check whether an issue is assigned and whether open or merged pull requests reference it. Returns a verdict: unclaimed, assigned, open_pr_exists or already_fixed.',
      inputSchema: checkExistingFixShape,
      annotations: READ_ONLY,
    },
    (args) => runTool(checkExistingFixShape, args, (a) => checkExistingFix(client, a)),
  );

  server.registerTool(
    'repo_contribution_rules',
    {
      description:
        'Fetch CONTRIBUTING.md and the pull request template, and list lines that mention AI use or disclosure.',
      inputSchema: repoContributionRulesShape,
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(repoContributionRulesShape, args, (a) => repoContributionRules(client, a)),
  );

  return server;
}
