import { readFileSync } from 'node:fs';
import { GitHubClient, type ClientOptions } from '../src/github.js';

export function fixture<T = unknown>(name: string): T {
  const text = readFileSync(`${process.cwd()}/test/fixtures/${name}`, 'utf8');
  return (name.endsWith('.json') ? JSON.parse(text) : text) as T;
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

export type Responder = (url: URL) => Response | Promise<Response>;

/**
 * A fake fetch driven by a route table. Keys are exact URL paths (no query
 * string); a request to an unlisted path throws so a test never silently
 * depends on an unmocked call. A route may hold a list, consumed in order,
 * with the last entry repeating.
 */
export function mockFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const counters = new Map<string, number>();
  const impl = async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const route = routes[url.pathname];
    if (!route) throw new Error(`Unmocked request: ${url.pathname}${url.search}`);
    const responders = Array.isArray(route) ? route : [route];
    const n = counters.get(url.pathname) ?? 0;
    counters.set(url.pathname, n + 1);
    return responders[Math.min(n, responders.length - 1)]!(url);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

export function makeClient(
  fetchImpl: typeof fetch,
  options: Partial<ClientOptions> = {},
): GitHubClient & { sleeps: number[] } {
  const sleeps: number[] = [];
  const client = new GitHubClient({
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_000_000_000_000,
    ...options,
  });
  return Object.assign(client, { sleeps });
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

/** Starts the real server in-process and returns a connected MCP client. */
export async function connectClient(github: GitHubClient): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(github).connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return {
    isError: result.isError === true,
    text: content[0]?.text ?? '',
    data: result.structuredContent as any,
  };
}
