import { describe, expect, it } from '@jest/globals';
import { callTool, connectClient, fixture, jsonResponse, makeClient, mockFetch } from './helpers.js';

describe('MCP server end to end (in-memory transport)', () => {
  it('lists the five read-only tools and serves a call', async () => {
    const mock = mockFetch({
      '/repos/acme/widgets/issues/42': () => jsonResponse({ ...fixture<object>('issue.json'), comments: 0 }),
    });
    const mcp = await connectClient(makeClient(mock.fetch));

    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_existing_fix',
      'find_related_code',
      'get_issue',
      'repo_contribution_rules',
      'search_issues',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const res = await callTool(mcp, 'get_issue', { repo: 'acme/widgets', number: 42 });
    expect(res.isError).toBe(false);
    expect(res.data.title).toBe('Crash when config file is empty');
    expect(JSON.parse(res.text).number).toBe(42);
  });
});
