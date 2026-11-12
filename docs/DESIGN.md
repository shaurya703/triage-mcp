# Design notes

## Why these five tools

Before starting a fix for an open-source issue I check the same things by hand:

1. Is there an issue, and what does it say? (`search_issues`, `get_issue`)
2. Which code is it about? (`find_related_code`)
3. Is someone already on it, or is it already fixed? (`check_existing_fix`)
4. What does the project require of contributors, including any AI-use
   disclosure rule? (`repo_contribution_rules`)

Each tool answers one of those questions and returns trimmed, structured
data, so an agent does not have to read raw GitHub JSON. All tools return
`structuredContent` plus the same JSON as text.

## How the verdict is decided

`check_existing_fix` gathers pull requests from two routes:

- the issue timeline, taking `cross-referenced` events whose source is a pull
  request in the same repository;
- a search for the issue number among pull requests, keeping only hits whose
  title or body contains `#N` or `/issues/N` as a whole number (the bare number
  otherwise matches things like "1420 packages").

PRs are merged into one entry per PR number, recording which route found it.
A PR is `merged`, `open` (drafts included, flagged), or `closed_unmerged`.

Verdict, first match wins:

| Verdict          | Condition                                  |
|------------------|--------------------------------------------|
| `already_fixed`  | at least one merged PR references the issue |
| `open_pr_exists` | at least one open PR references the issue   |
| `assigned`       | the issue has an assignee                   |
| `unclaimed`      | none of the above                           |

A PR closed without merging never counts as a fix. The decision is in the pure
function `decideVerdict`, which is tested separately.

Known limits: a PR that merely mentions an issue ("see #42") is treated like
one that fixes it, and the reason string says when the issue is still open
after a merge so the agent can check. Claims made in comments ("I'll take
this") are not detected.

## Rate limiting

The client reacts to a 403 or 429 only when GitHub says it is a rate limit:
a `retry-after` header, or `x-ratelimit-remaining: 0` with `x-ratelimit-reset`.

- If the wait is at most `maxWaitMs` (default 10 s, env `TRIAGE_MAX_WAIT_MS`),
  it sleeps and retries, at most 2 retries.
- If the wait is longer, it does not sleep. It returns an error giving the
  reset time and, when no token is set, a hint to set `GITHUB_TOKEN`.
- A 403 without those headers is a plain permission error and is not retried.

Sleep and clock are injected, so the tests never wait.

## Errors and limits on size

Bad input (for example a `repo` that is not `owner/name`) and GitHub errors
(404, 401, 422, rate limit, network) become `isError` tool results with a
readable message. Issue bodies are cut at 4000 characters and comments at
1000, with a `...Truncated` flag. Result counts are capped (30 issues, 20 code
hits, 20 comments).

## Out of scope

- No write operations: no commenting, assigning, labelling or opening PRs.
  Every tool is annotated `readOnlyHint`.
- No cloning or reading repository files beyond CONTRIBUTING and the PR
  template.
- No caching or persistence between calls.
- `find_related_code` needs `GITHUB_TOKEN`, because GitHub code search rejects
  unauthenticated requests.
