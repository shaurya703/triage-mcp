import { z } from 'zod';

export const MAX_BODY_CHARS = 4000;
export const MAX_COMMENT_CHARS = 1000;

export interface Truncated {
  text: string;
  truncated: boolean;
}

export function truncate(text: string | null | undefined, max: number): Truncated {
  const value = text ?? '';
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/** "owner/name", with the character set GitHub allows. */
export const repoSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'repo must look like "owner/name", for example "facebook/react"',
  );

export const issueNumberSchema = z.number().int().positive();

export function limitSchema(max: number, fallback: number) {
  return z.number().int().min(1).max(max).default(fallback);
}

export function labelNames(labels: Array<{ name: string } | string>): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : l.name));
}
