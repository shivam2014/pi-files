import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseFrontmatter, stripFrontmatter, getAgentDir } from '@earendil-works/pi-coding-agent';

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

/**
 * Ordered list of skill roots to probe — the single source of truth for skill
 * discovery, shared by read_skill, list_skills, and resolveSkill.
 *
 * Probe order:
 *   1. <agentDir>/skills
 *   2. ~/.agents/skills
 *   3. npm-bundled package roots under <agentDir>/npm/node_modules
 *      (both <pkg>/skills and scoped <@scope>/<pkg>/skills).
 * Only existing roots are meaningful; callers test each candidate for existence.
 */
export function getSkillRoots(): string[] {
  const agentDir = getAgentDir();
  const roots: string[] = [join(agentDir, 'skills'), join(homedir(), '.agents', 'skills')];
  const npmModules = join(agentDir, 'npm', 'node_modules');
  try {
    for (const entry of readdirSync(npmModules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) {
        const scopeDir = join(npmModules, entry.name);
        try {
          for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
            if (sub.isDirectory()) roots.push(join(scopeDir, sub.name, 'skills'));
          }
        } catch {
          // skip unreadable scope dir
        }
      } else {
        roots.push(join(npmModules, entry.name, 'skills'));
      }
    }
  } catch {
    // no npm-bundled root available
  }
  return roots;
}

/**
 * Resolve a skill name to the first existing {root}/{name}/SKILL.md across all
 * roots in probe order. Returns undefined when no root contains the skill.
 */
export function resolveSkillFilePath(name: string): string | undefined {
  for (const root of getSkillRoots()) {
    const candidate = join(root, name, 'SKILL.md');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Enumerate every on-disk skill name across all skill roots.
 * A skill name is a directory under a root that contains a SKILL.md
 * (the same name read_skill/resolveSkillFilePath resolve against).
 * Deduplicated (first root in probe order wins) and sorted for stable output.
 */
export function listAvailableSkillNames(): string[] {
  const seen = new Set<string>();
  for (const root of getSkillRoots()) {
    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // root missing / unreadable — try the next
    }
    for (const name of entries) {
      if (seen.has(name)) continue; // first root in probe order wins
      if (existsSync(join(root, name, 'SKILL.md'))) seen.add(name);
    }
  }
  return [...seen].sort();
}

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

  const filePath = skillsRoot
    ? resolveSkillPath(name, skillsRoot)
    : resolveSkillFilePath(name) ?? resolveSkillPath(name);

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
