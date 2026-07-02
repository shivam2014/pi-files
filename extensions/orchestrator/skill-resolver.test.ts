import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSkill } from './skill-resolver';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'skill-resolver-test-'));
}

describe('resolveSkill', () => {
  it('resolves a valid SKILL.md with frontmatter', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'my-skill');
    const filePath = join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(filePath, '---\nname: my-skill\ndescription: "A test skill"\ndisable-model-invocation: true\n---\n\n# My Skill\n\nThis is the body content.');
    const result = resolveSkill('my-skill', dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe('my-skill');
      expect(result.skill.description).toBe('A test skill');
      expect(result.skill.body).toContain('My Skill');
      expect(result.skill.filePath).toBe(filePath);
      expect(result.skill.disableModelInvocation).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses frontmatter name when it differs from directory name', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: custom-name\ndescription: "Different name"\n---\n\nBody');
    const result = resolveSkill('my-skill', dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe('custom-name');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to requested name when frontmatter has no name', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'fallback-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: "No name in frontmatter"\n---\n\nBody');
    const result = resolveSkill('fallback-skill', dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe('fallback-skill');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('disable-model-invocation: true returns true', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'skill-a');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: skill-a\ndescription: "Test"\ndisable-model-invocation: true\n---\n\nBody');
    const result = resolveSkill('skill-a', dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.disableModelInvocation).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('disable-model-invocation: false returns false', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'skill-b');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: skill-b\ndescription: "Test"\ndisable-model-invocation: false\n---\n\nBody');
    const result = resolveSkill('skill-b', dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.disableModelInvocation).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing disable-model-invocation returns false', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'skill-c');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: skill-c\ndescription: "Test"\n---\n\nBody');
    const result = resolveSkill('skill-c', dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.disableModelInvocation).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns NOT_FOUND for unknown skill', () => {
    const dir = createTempDir();
    const result = resolveSkill('nonexistent', dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.skillName).toBe('nonexistent');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns INVALID_NAME for uppercase name', () => {
    const result = resolveSkill('Uppercase');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_NAME');
    }
  });

  it('returns INVALID_NAME for name with spaces', () => {
    const result = resolveSkill('has space');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_NAME');
    }
  });

  it('handles SKILL.md without frontmatter delimiters gracefully', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'no-frontmatter');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# No Frontmatter\n\nJust markdown.');
    const result = resolveSkill('no-frontmatter', dir);
    // parseFrontmatter returns empty frontmatter for content without ---
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe('no-frontmatter');
      expect(result.skill.body).toContain('No Frontmatter');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns INVALID_DESCRIPTION when description is empty', () => {
    const dir = createTempDir();
    const skillDir = join(dir, 'no-desc');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: no-desc\ndescription: ""\n---\n\nBody');
    const result = resolveSkill('no-desc', dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_DESCRIPTION');
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
