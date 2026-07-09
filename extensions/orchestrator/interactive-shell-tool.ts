/**
 * interactive-shell-tool.ts — Register an `interactive_shell` tool for the orchestrator.
 *
 * Lets the orchestrator run and monitor interactive CLI sessions (pi, claude,
 * codex, gemini, or arbitrary commands) with foreground/background dispatch,
 * hands-free monitoring, and event-driven watchers.
 *
 * Uses ctx.interactiveShell() if available (ExtensionAPI), otherwise falls back
 * to spawning child processes tracked in an in-memory Map.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── In-memory session store (fallback when ctx.interactiveShell unavailable) ──

interface ShellSession {
	id: string;
	command: string;
	mode: string;
	background: boolean;
	status: "running" | "completed" | "killed" | "error";
	startedAt: number;
	endedAt?: number;
	output: string[];
	exitCode?: number;
	process?: import("node:child_process").ChildProcess;
}

const sessions = new Map<string, ShellSession>();
let sessionCounter = 0;

function generateSessionId(): string {
	return `ishell-${Date.now()}-${++sessionCounter}`;
}

function tailLines(arr: string[], n: number): string {
	const lines = arr.join("\n").split("\n");
	return lines.slice(-n).join("\n");
}

// ── Parameters schema ──

const ShellParams = Type.Object({
	command: Type.Optional(Type.String({ description: "Command to run (e.g. 'openwiki --init', 'pi \"fix bugs\"')" })),
	sessionId: Type.Optional(Type.String({ description: "Existing session ID to query/send input to" })),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("interactive"), Type.Literal("hands-free"), Type.Literal("dispatch"), Type.Literal("monitor")],
			{ description: "Session mode" }
		)
	),
	background: Type.Optional(Type.Boolean({ description: "Run headless, no overlay" })),
	input: Type.Optional(Type.String({ description: "Text input to send to session" })),
	inputKeys: Type.Optional(Type.Array(Type.String(), { description: "Keys to send (e.g. ['ctrl+c', 'enter'])" })),
	inputPaste: Type.Optional(Type.String({ description: "Multiline text to paste" })),
	submit: Type.Optional(Type.Boolean({ description: "Submit the input after sending" })),
	kill: Type.Optional(Type.Boolean({ description: "Kill the session" })),
	listBackground: Type.Optional(Type.Boolean({ description: "List background sessions" })),
	dismissBackground: Type.Optional(
		Type.Union([Type.Boolean(), Type.String()], { description: "Dismiss background sessions (all or specific ID)" })
	),
	attach: Type.Optional(Type.String({ description: "Reattach to background session" })),
	timeout: Type.Optional(Type.Number({ description: "Auto-kill after N ms" })),
	reason: Type.Optional(Type.String({ description: "UI display label for overlay header" })),
	monitor: Type.Optional(
		Type.Object(
			{
				strategy: Type.String(),
				triggers: Type.Array(
					Type.Object({
						id: Type.String(),
						literal: Type.Optional(Type.String()),
						regex: Type.Optional(Type.String()),
					})
				),
			},
			{ description: "Monitor config for event-driven mode" }
		)
	),
	handoffSnapshot: Type.Optional(
		Type.Object(
			{ enabled: Type.Boolean(), lines: Type.Optional(Type.Number()) },
			{ description: "Snapshot to file on completion" }
		)
	),
	settings: Type.Optional(
		Type.Object(
			{
				updateInterval: Type.Optional(Type.Number()),
				quietThreshold: Type.Optional(Type.Number()),
			},
			{ description: "Update timing settings" }
		)
	),
	spawn: Type.Optional(
		Type.Object(
			{
				agent: Type.Optional(Type.String()),
				prompt: Type.Optional(Type.String()),
				worktree: Type.Optional(Type.Boolean()),
				mode: Type.Optional(Type.String()),
			},
			{ description: "Structured spawn params" }
		)
	),
	outputLines: Type.Optional(Type.Number({ description: "Max output lines for query (default 20, max 200)" })),
	incremental: Type.Optional(Type.Boolean({ description: "Paginate through output" })),
});

type ShellParamsType = Static<typeof ShellParams>;

// ── Fallback executor (child_process) ──

function executeFallback(params: ShellParamsType): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
} {
	// ── List background sessions ──
	if (params.listBackground) {
		const bgSessions = [...sessions.values()].filter((s) => s.background);
		if (bgSessions.length === 0) {
			return { content: [{ type: "text", text: "No background sessions." }], details: {} };
		}
		const lines = bgSessions.map(
			(s) => `[${s.id}] ${s.status} — ${s.command} (${new Date(s.startedAt).toISOString()})`
		);
		return { content: [{ type: "text", text: lines.join("\n") }], details: { sessions: bgSessions.length } };
	}

	// ── Dismiss background sessions ──
	if (params.dismissBackground !== undefined) {
		if (params.dismissBackground === true || params.dismissBackground === "all") {
			const count = sessions.size;
			sessions.clear();
			return { content: [{ type: "text", text: `Dismissed all ${count} sessions.` }], details: {} };
		}
		const id = String(params.dismissBackground);
		if (sessions.has(id)) {
			const s = sessions.get(id)!;
			if (s.process && s.status === "running") s.process.kill("SIGTERM");
			sessions.delete(id);
			return { content: [{ type: "text", text: `Dismissed session ${id}.` }], details: {} };
		}
		return { content: [{ type: "text", text: `Session ${id} not found.` }], details: { isError: true } };
	}

	// ── Existing session: query / input / kill ──
	if (params.sessionId) {
		const session = sessions.get(params.sessionId);
		if (!session) {
			return {
				content: [{ type: "text", text: `Session ${params.sessionId} not found.` }],
				details: { isError: true },
			};
		}

		// Kill
		if (params.kill) {
			if (session.process && session.status === "running") {
				session.process.kill("SIGTERM");
				session.status = "killed";
				session.endedAt = Date.now();
			}
			return {
				content: [{ type: "text", text: `Killed session ${params.sessionId}.` }],
				details: { killed: true },
			};
		}

		// Send input
		if (params.input && session.process && session.status === "running") {
			session.process.stdin?.write(params.input + (params.submit ? "\n" : ""));
			return {
				content: [{ type: "text", text: `Sent input to ${params.sessionId}.` }],
				details: { sent: true },
			};
		}

		// Send keys (best-effort via stdin writes)
		if (params.inputKeys && session.process && session.status === "running") {
			for (const key of params.inputKeys) {
				if (key === "ctrl+c") session.process.kill("SIGINT");
				else if (key === "enter") session.process.stdin?.write("\n");
				else session.process.stdin?.write(key);
			}
			return {
				content: [{ type: "text", text: `Sent keys to ${params.sessionId}.` }],
				details: { sent: true },
			};
		}

		// Paste multiline input
		if (params.inputPaste && session.process && session.status === "running") {
			session.process.stdin?.write(params.inputPaste);
			if (params.submit) session.process.stdin?.write("\n");
			return {
				content: [{ type: "text", text: `Pasted input to ${params.sessionId}.` }],
				details: { sent: true },
			};
		}

		// Query status + output
		const maxLines = Math.min(params.outputLines ?? 20, 200);
		const output = tailLines(session.output, maxLines);
		const statusText = [
			`Session: ${session.id}`,
			`Command: ${session.command}`,
			`Status: ${session.status}`,
			`Mode: ${session.mode}`,
			`Background: ${session.background}`,
			`Started: ${new Date(session.startedAt).toISOString()}`,
			session.endedAt ? `Ended: ${new Date(session.endedAt).toISOString()}` : null,
			session.exitCode !== undefined ? `Exit code: ${session.exitCode}` : null,
			``,
			`--- Last ${maxLines} lines of output ---`,
			output || "(no output)",
		]
			.filter(Boolean)
			.join("\n");

		return {
			content: [{ type: "text", text: statusText }],
			details: {
				sessionId: session.id,
				status: session.status,
				totalLines: session.output.length,
			},
		};
	}

	// ── New session: spawn command ──
	if (params.command) {
		const { spawn } = require("node:child_process") as typeof import("node:child_process");
		const id = generateSessionId();
		const mode = params.mode ?? "hands-free";
		const isBackground = params.background ?? false;

		const child = spawn("sh", ["-c", params.command], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		const session: ShellSession = {
			id,
			command: params.command,
			mode,
			background: isBackground,
			status: "running",
			startedAt: Date.now(),
			output: [],
			process: child,
		};

		sessions.set(id, session);

		// Capture stdout
		child.stdout?.on("data", (data: Buffer) => {
			const lines = data.toString().split("\n").filter(Boolean);
			session.output.push(...lines);
			if (session.output.length > 1000) {
				session.output = session.output.slice(-1000);
			}
		});

		// Capture stderr
		child.stderr?.on("data", (data: Buffer) => {
			const lines = data.toString().split("\n").filter(Boolean);
			session.output.push(...lines);
			if (session.output.length > 1000) {
				session.output = session.output.slice(-1000);
			}
		});

		// On exit
		child.on("exit", (code) => {
			session.status = code === 0 ? "completed" : "error";
			session.exitCode = code ?? undefined;
			session.endedAt = Date.now();
			session.process = undefined;
		});

		child.on("error", (err) => {
			session.status = "error";
			session.endedAt = Date.now();
			session.output.push(`Error: ${err.message}`);
			session.process = undefined;
		});

		// Auto-kill timeout
		if (params.timeout && params.timeout > 0) {
			setTimeout(() => {
				if (session.status === "running" && session.process) {
					session.process.kill("SIGTERM");
					session.status = "killed";
					session.endedAt = Date.now();
					session.process = undefined;
					session.output.push(`[auto-killed after ${params.timeout}ms]`);
				}
			}, params.timeout);
		}

		const maxLines = Math.min(params.outputLines ?? 20, 200);
		return {
			content: [
				{
					type: "text",
					text: [
						`Session started: ${id}`,
						`Command: ${params.command}`,
						`Mode: ${mode}`,
						`Background: ${isBackground}`,
						``,
						`Query with: { sessionId: "${id}" }`,
						`Kill with: { sessionId: "${id}", kill: true }`,
					].join("\n"),
				},
			],
			details: { sessionId: id, background: isBackground },
		};
	}

	// ── Attach to background session ──
	if (params.attach) {
		const session = sessions.get(params.attach);
		if (!session) {
			return {
				content: [{ type: "text", text: `Session ${params.attach} not found.` }],
				details: { isError: true },
			};
		}
		session.background = false;
		const maxLines = Math.min(params.outputLines ?? 20, 200);
		return {
			content: [{ type: "text", text: `Reattached to ${params.attach}.\n${tailLines(session.output, maxLines)}` }],
			details: { sessionId: params.attach, status: session.status },
		};
	}

	return {
		content: [{ type: "text", text: "Provide a command to start a new session, or a sessionId to query." }],
		details: {},
	};
}

// ── Registration ──

export function registerInteractiveShellTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "interactive_shell",
		label: "Interactive Shell",
		description:
			"Run and monitor interactive CLI sessions (pi, claude, codex, gemini, or arbitrary commands) with foreground/background dispatch, hands-free monitoring, and event-driven watchers.",
		parameters: ShellParams,
		async execute(
			_toolCallId: string,
			params: ShellParamsType,
			_signal?: AbortSignal,
			_onUpdate?: (update: any) => void,
			ctx?: any
		) {
			// Try ctx.interactiveShell() if available on ExtensionContext
			if (ctx?.interactiveShell) {
				try {
					const result = await ctx.interactiveShell(params);
					return {
						content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
						details: {},
					};
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `interactiveShell error: ${err.message}` }],
						details: { isError: true },
					};
				}
			}

			// Fallback: child_process-based implementation
			return executeFallback(params);
		},
	});
}
