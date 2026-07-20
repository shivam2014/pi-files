import { describe, it, expect } from "vitest";
import { getBashToolReplacement } from "./bash-interceptor";

describe("bash-interceptor override", () => {
  it("allows sed with override:true", () => {
    const result = getBashToolReplacement("sed -i 's/foo/bar/' file.txt", true);
    expect(result.allowed).toBe(true);
    expect(result.tool).toBeUndefined();
  });
  it("redirects sed without override to edit tool", () => {
    const result = getBashToolReplacement("sed -i 's/foo/bar/' file.txt", false);
    expect(result.allowed).toBe(true);
    expect(result.tool).toBeDefined();
  });
  it("allows awk with override:true", () => {
    const result = getBashToolReplacement("awk '{print $1}' file.txt", true);
    expect(result.allowed).toBe(true);
    expect(result.tool).toBeUndefined();
  });
  it("allows cat with override:true", () => {
    const result = getBashToolReplacement("cat file.txt", true);
    expect(result.allowed).toBe(true);
  });
  it("still blocks dangerous commands with override:true", () => {
    const result = getBashToolReplacement("rm -rf /", true);
    expect(result.allowed).toBe(false);
  });
});
