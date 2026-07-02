import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseFrontmatter, stripFrontmatter } from '@earendil-works/pi-coding-agent';

export interface SkillResolution {
  name: string;
  description: string;
  body: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export interface SkillResolutionError {
  code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'FRONTMATTER_PARSE_FAILED' | 'INVALID_NAME' | 'INVALID_DESCRIPTION' | 'IO_ERROR';
  message: string;
  skillName: string;
  cause?: string;
}

export type SkillResult =
  | { ok: true; skill: SkillResolution }
  | { ok: false; error: SkillResolutionError };

const DEFAULT_SKILLS_ROOT = join(homedir(), '.pi', 'agent', 'skills');
const SKILL_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

export function resolveSkillPath(name: string, skillsRoot?: string): string {
  return join(skillsRoot || DEFAULT_SKILLS_ROOT, name, 'SKILL.md');
}

export function resolveSkill(name: string, skillsRoot?: string): SkillResult {
  if (!SKILL_NAME_REGEX.test(name)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_NAME',
        message: `Invalid skill name: "${name}". Must be lowercase, start with a letter, and contain only letters, digits, and hyphens.`,
        skillName: name,
      },
    };
  }

  const filePath = resolveSkillPath(name, skillsRoot);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `Skill "${name}" not found at ${filePath}`,
          skillName: name,
          cause: err.code,
        },
      };
    }
    if (err.code === 'EACCES') {
      return {
        ok: false,
        error: {
          code: 'PERMISSION_DENIED',
          message: `Permission denied reading skill "${name}" at ${filePath}`,
          skillName: name,
          cause: err.code,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'IO_ERROR',
        message: `Failed to read skill "${name}": ${err.message}`,
        skillName: name,
        cause: err.code,
      },
    };
  }

  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: 'FRONTMATTER_PARSE_FAILED',
        message: `Failed to parse frontmatter for skill "${name}": ${err.message}`,
        skillName: name,
        cause: err.message,
      },
    };
  }

  const fmName = (frontmatter.name as string) || name;
  const description = (frontmatter.description as string) || '';

  // Only require description when frontmatter delimiters were present.
  // If the file has no --- delimiters, parseFrontmatter returns {} which
  // means there was no frontmatter at all — allow empty description.
  const hasFrontmatterDelimiter = content.trimStart().startsWith('---');
  if (hasFrontmatterDelimiter && !description.trim()) {
    return {
      ok: false,
      error: {
        code: 'INVALID_DESCRIPTION',
        message: `Skill "${name}" has no description in frontmatter`,
        skillName: name,
      },
    };
  }

  const disableModelInvocation = frontmatter['disable-model-invocation'] === true;

  return {
    ok: true,
    skill: {
      name: fmName,
      description: description.trim(),
      body: stripFrontmatter(content).trim(),
      filePath,
      disableModelInvocation,
    },
  };
}
