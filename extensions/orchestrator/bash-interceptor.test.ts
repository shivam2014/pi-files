import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import defaultOrchestrator, { getBashToolReplacement } from "./index.ts";
import { SUBAGENT_ENV_KEY } from "./subagent-runner.ts";

describe("getBashToolReplacement", () => {
	it("maps cat to read", () => {
		expect(getBashToolReplacement("cat src/index.ts")).toBe("read");
	});

	it("maps grep to grep", () => {
		expect(getBashToolReplacement("grep -n foo src/**/*.ts")).toBe("grep");
	});

	it("maps rg to grep", () => {
		expect(getBashToolReplacement("rg foo src/")).toBe("grep");
	});

	it("maps find to find", () => {
		expect(getBashToolReplacement("find . -name '*.ts'")).toBe("find");
	});

	it("maps ls to ls", () => {
		expect(getBashToolReplacement("ls -la src/")).toBe("ls");
	});

	it("maps sed -i to edit", () => {
		expect(getBashToolReplacement("sed -i 's/old/new/g' file.txt")).toBe("edit");
	});

	it("maps awk redirection to edit", () => {
		expect(getBashToolReplacement("awk '{print $1}' file.txt > out.txt")).toBe("edit");
	});

	it("maps perl -i to edit", () => {
		expect(getBashToolReplacement("perl -i -pe 's/old/new/' file.txt")).toBe("edit");
	});

	it("maps python open-write to edit", () => {
		expect(getBashToolReplacement("python -c \"open('f','w').write('x')\"")).toBe("edit");
	});

	it("maps node -e fs.writeFile to edit", () => {
		expect(getBashToolReplacement("node -e \"require('fs').writeFileSync('f','x')\"")).toBe("edit");
	});

	it("maps mkdir to write", () => {
		expect(getBashToolReplacement("mkdir -p src/new")).toBe("write");
	});

	it("maps touch to write", () => {
		expect(getBashToolReplacement("touch src/new.ts")).toBe("write");
	});

	it("allows cat with override", () => {
		expect(getBashToolReplacement("cat src/index.ts", true)).toBeNull();
	});

	it("does not block npm test", () => {
		expect(getBashToolReplacement("npm test")).toBeNull();
	});

	it("does not block gh", () => {
		expect(getBashToolReplacement("gh pr create --title 'x'")).toBeNull();
	});

	it("does not block node script.js", () => {
		expect(getBashToolReplacement("node script.js")).toBeNull();
	});

	it("does not block cd ... && make", () => {
		expect(getBashToolReplacement("cd src && make")).toBeNull();
	});

	it("does not block python read/print", () => {
		expect(getBashToolReplacement("python -c \"print(1)\"")).toBeNull();
	});

	it("does not block sed that only prints", () => {
		expect(getBashToolReplacement("sed 's/old/new/' file.txt")).toBeNull();
	});

	it("handles leading env assignments", () => {
		expect(getBashToolReplacement("FOO=bar cat file.txt")).toBe("read");
	});
});

describe("subagent tool_call handler", () => {
	let handler: ((event: any) => any) | undefined;
	const pi = {
		on: vi.fn((event: string, fn: any) => {
			if (event === "tool_call") handler = fn;
		}),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		setActiveTools: vi.fn(),
		getAllTools: vi.fn(() => []),
	};

	beforeEach(() => {
		process.env[SUBAGENT_ENV_KEY] = "1";
		defaultOrchestrator(pi as any);
		delete process.env[SUBAGENT_ENV_KEY];
	});

	afterEach(() => {
		vi.clearAllMocks();
		handler = undefined;
	});

	it("registers a tool_call handler in subagent context", () => {
		expect(handler).toBeDefined();
	});

	it("blocks bash cat with read suggestion", () => {
		const res = handler?.({ toolName: "bash", input: { command: "cat file.ts" } });
		expect(res).toEqual({ block: true, reason: expect.stringContaining("Use read instead of bash") });
	});

	it("blocks bash grep with grep suggestion", () => {
		const res = handler?.({ toolName: "bash", input: { command: "grep foo src/" } });
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("grep");
	});

	it("allows legitimate npm test", () => {
		expect(handler?.({ toolName: "bash", input: { command: "npm test" } })).toBeUndefined();
	});

	it("respects override:true", () => {
		expect(handler?.({ toolName: "bash", input: { command: "cat file.ts", override: true } })).toBeUndefined();
	});

	it("allows non-bash subagent tools", () => {
		expect(handler?.({ toolName: "read", input: { path: "file.ts" } })).toBeUndefined();
	});
});
