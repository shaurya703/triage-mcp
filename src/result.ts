import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GitHubError } from './github.js';

export function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Validates raw arguments and runs the handler. Expected failures (bad input,
 * GitHub errors) become isError results; anything else is a bug and is
 * reported as a generic failure without a stack trace.
 */
export async function runTool<S extends z.ZodRawShape>(
  shape: S,
  rawArgs: unknown,
  handler: (args: z.output<z.ZodObject<S>>) => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  const parsed = z.object(shape).safeParse(rawArgs);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
    return fail(`Invalid input. ${problems}`);
  }
  try {
    return ok(await handler(parsed.data));
  } catch (err) {
    if (err instanceof GitHubError) return fail(err.message);
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`Unexpected error: ${reason}`);
  }
}
