import { describe, it } from "vitest";
import { createReadSkillTool } from "./read-skill-tool";

describe("Phase 1 repro: read_skill path traversal bug", () => {
  it("valid skill 'diagnosing-bugs' should NOT be blocked by path traversal", async () => {
    const tool = createReadSkillTool();
    const result = await tool.execute("test-1", { name: "diagnosing-bugs" }, null, null, null);
    const text = (result.content as any[])?.[0]?.text || "";

    console.log("Response text (first 200 chars):", text.substring(0, 200));

    if (text.includes("Path traversal is blocked")) {
      console.log("RED: Bug reproduced — valid skill 'diagnosing-bugs' blocked by path traversal");
      console.log("Full response:", text);
    } else if (text.includes("not found")) {
      console.log("YELLOW: Skill not found (different issue)");
      console.log("Full response:", text);
    } else {
      console.log("GREEN: Skill loaded successfully");
    }

    // This assertion is intentionally the BUG trigger:
    // If path traversal check is wrong, this will fail
    if (text.includes("Path traversal is blocked")) {
      throw new Error(`RED BUG: Valid skill 'diagnosing-bugs' blocked by path traversal. Full: ${text}`);
    }
  });
});
