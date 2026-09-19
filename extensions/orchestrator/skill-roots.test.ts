/**
 * skill-roots.test.ts
 *
 * FIX 1: read_skill / list_skills / resolveSkill search an ORDERED list of skill
 * roots (single source of truth), not just <agentDir>/skills.
 *   order: <agentDir>/skills → ~/.agents/skills → npm-bundled package roots
 *          (unscoped <pkg>/skills AND scoped <@scope>/<pkg>/skills).
 * Hermetic: getAgentDir + os.homedir are mocked onto a temp tree built in beforeAll.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const hoisted = vi.hoisted(() => {
  const base = `${process.env.HOME}/.pi-skill-roots-test`;
  return { base, agentDir: `${base}/agent`, homeDir: `${base}/home` };
});

vi.mock("os", async () => {
  const actual = await vi.importActual<any>("node:os");
  return { ...actual, homedir: () => hoisted.homeDir };
});

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return { ...actual, getAgentDir: () => hoisted.agentDir };
});

import { getSkillRoots, resolveSkillFilePath, resolveSkill } from "./skill-resolver.ts";

const AGENT_DIR = hoisted.agentDir;
const HOME_DIR = hoisted.homeDir;

function writeSkill(root: string, name: string, desc: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`, "utf-8");
  return join(dir, "SKILL.md");
}

beforeAll(() => {
  rmSync(hoisted.base, { recursive: true, force: true });
  mkdirSync(join(AGENT_DIR, "skills"), { recursive: true });
  mkdirSync(join(HOME_DIR, ".agents", "skills"), { recursive: true });
  writeSkill(join(AGENT_DIR, "skills"), "tdd", "Test driven development");
  writeSkill(join(HOME_DIR, ".agents", "skills"), "reddit-scraper", "Scrape reddit");
  writeSkill(
    join(AGENT_DIR, "npm", "node_modules", "pi-interactive-shell", "skills"),
    "pi-interactive-shell",
    "Interactive shell helper",
  );
  writeSkill(
    join(AGENT_DIR, "npm", "node_modules", "@scope", "pkg", "skills"),
    "interactive-reading",
    "Guided reading",
  );
});

afterAll(() => {
  rmSync(hoisted.base, { recursive: true, force: true });
});

describe("FIX 1 — ordered skill roots", () => {
  it("probes agentDir/skills → ~/.agents/skills → npm-bundled roots", () => {
    const roots = getSkillRoots();
    expect(roots[0]).toBe(join(AGENT_DIR, "skills"));
    expect(roots[1]).toBe(join(HOME_DIR, ".agents", "skills"));
    expect(roots).toContain(join(AGENT_DIR, "npm", "node_modules", "pi-interactive-shell", "skills"));
    expect(roots).toContain(join(AGENT_DIR, "npm", "node_modules", "@scope", "pkg", "skills"));
  });

  it("resolves a skill from the agent root", () => {
    expect(resolveSkillFilePath("tdd")).toBe(join(AGENT_DIR, "skills", "tdd", "SKILL.md"));
  });

  it("resolves a skill from ~/.agents/skills", () => {
    expect(resolveSkillFilePath("reddit-scraper")).toBe(
      join(HOME_DIR, ".agents", "skills", "reddit-scraper", "SKILL.md"),
    );
  });

  it("resolves an npm-bundled (unscoped) skill", () => {
    expect(resolveSkillFilePath("pi-interactive-shell")).toBe(
      join(AGENT_DIR, "npm", "node_modules", "pi-interactive-shell", "skills", "pi-interactive-shell", "SKILL.md"),
    );
  });

  it("resolves an npm-bundled (scoped) skill", () => {
    expect(resolveSkillFilePath("interactive-reading")).toBe(
      join(AGENT_DIR, "npm", "node_modules", "@scope", "pkg", "skills", "interactive-reading", "SKILL.md"),
    );
  });

  it("returns undefined for an unknown skill", () => {
    expect(resolveSkillFilePath("does-not-exist")).toBeUndefined();
  });

  it("resolveSkill reads an npm-bundled skill body (regression: pi-interactive-shell was unreachable)", () => {
    const r = resolveSkill("pi-interactive-shell");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.filePath).toContain("pi-interactive-shell");
      expect(r.skill.description).toBe("Interactive shell helper");
    }
  });

  it("keeps path-traversal protection (INVALID_NAME)", () => {
    const r = resolveSkill("../etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_NAME");
  });
});
