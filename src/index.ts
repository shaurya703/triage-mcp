#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GitHubClient } from './github.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const maxWait = Number(process.env.TRIAGE_MAX_WAIT_MS);
  const client = new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    ...(Number.isFinite(maxWait) && process.env.TRIAGE_MAX_WAIT_MS ? { maxWaitMs: maxWait } : {}),
  });
  await createServer(client).connect(new StdioServerTransport());
  // stdout carries the protocol; log only to stderr.
  console.error('triage-mcp running on stdio');
}

main().catch((err) => {
  console.error('triage-mcp failed to start:', err);
  process.exit(1);
});
