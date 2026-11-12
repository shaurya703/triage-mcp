# triage-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets a coding agent
check a GitHub issue properly before it writes a fix.

I have had around a hundred pull requests merged into open-source projects, and the most common way to
waste an afternoon is to fix something that already has an open PR, or to miss a contribution rule.
Before I start on an issue I check the same four things by hand. This server gives an agent those
checks as tools, so it does them too.

## Tools

| Tool | Question it answers |
|---|---|
| `search_issues` | Is there an issue for this, open or closed? |
| `get_issue` | What does it say, and what did people add in the latest comments? |
| `find_related_code` | Which files is it about? (needs a token, see below) |
| `check_existing_fix` | Is it assigned, is someone already fixing it, or is it already fixed? |
| `repo_contribution_rules` | What does CONTRIBUTING say, and does it mention AI use or disclosure? |

Every tool is read-only. There is no tool that comments, assigns, labels or opens a pull request.

### check_existing_fix

This is the one that saves the most time. It collects pull requests that reference the issue from two
places, the issue timeline and a search, merges duplicates, and returns one verdict:

| Verdict | Meaning |
|---|---|
| `already_fixed` | a pull request that references the issue was merged |
| `open_pr_exists` | someone has an open pull request for it (drafts included) |
| `assigned` | no pull request yet, but the issue has an assignee |
| `unclaimed` | none of the above |

A pull request that was closed without merging does not count as a fix.

Real output for [markedjs/marked#4099](https://github.com/markedjs/marked/issues/4099), trimmed:

```json
{
  "verdict": "open_pr_exists",
  "reason": "Open PR #4196 by VadimToptunov references issue #4099.",
  "pullRequests": [{ "number": 4196, "state": "open", "foundVia": ["timeline", "search"] }]
}
```

## Run it

Needs Node 20 or newer. It is not published to npm, so build it from a clone:

```sh
git clone https://github.com/shaurya703/triage-mcp && cd triage-mcp
npm install
npm run build
```

Then point an MCP client at it. For Claude Code or Claude Desktop:

```json
{
  "mcpServers": {
    "triage": {
      "command": "node",
      "args": ["/absolute/path/to/triage-mcp/dist/index.js"],
      "env": { "GITHUB_TOKEN": "<a token with public read access>" }
    }
  }
}
```

`GITHUB_TOKEN` is optional. Without it you get GitHub's lower unauthenticated rate limit, and
`find_related_code` returns an error, because GitHub's code search refuses requests with no token.

## Rate limits

GitHub rate limits are easy to handle badly: either the tool hangs for an hour or it hammers the API.
This server does neither.

- If GitHub says to retry within 10 seconds, it waits and retries, twice at most.
- If the wait is longer, it does not wait. The agent gets an error that says when the limit resets.
- A 403 that is not a rate limit is reported as a permission error and is not retried.

The longest wait is configurable with `TRIAGE_MAX_WAIT_MS`.

## Tests

```sh
npm test            # 43 tests, no network: fetch is mocked
npm run typecheck
```

The tests cover every verdict, duplicate pull requests found by both routes, closed-but-unmerged pull
requests, each rate-limit path (with an injected clock, so nothing really sleeps), bad input, 404s,
body truncation, and one end-to-end test that starts the real server over the SDK's in-memory
transport and calls a tool through a real MCP client.

## Limits worth knowing

- A pull request that only mentions an issue ("see #42") is treated the same as one that fixes it. When
  a pull request was merged but the issue is still open, the reason says so, so the agent can look.
- "I'll take this" in a comment is not detected as a claim.
- The AI-policy check is a keyword match. It returns the matching lines so the agent reads them instead
  of trusting a yes or no.
- The issue timeline is read for up to 500 events, and the search looks at the 30 most recently
  updated pull requests.

Design notes are in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
