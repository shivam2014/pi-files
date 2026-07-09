/**
 * Integrated bash interceptor that reads specialist permissions
 * dynamically from the SPECIALISTS registry.
 *
 * - Dangerous commands always blocked.
 * - Write commands blocked for specialists without write+bash access
 *   (determined by checking if specialist has "bash" AND ("edit"|"write") in tools).
 * - All other commands allowed through.
 */

import { isWriteCommand } from "./bash-classifier";
import { SPECIALISTS } from "./specialists";

// Dangerous commands that should always be blocked regardless of specialist
const DANGEROUS_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "git push --force",
  "git push -f",
  "git reset --hard",
  "sudo rm",
  "dd if=",
  "mkfs",
  "> /dev/sda",
];

export interface IntegratedBashInterceptor {
  handler: (event: any, ctx: any) => Promise<{ block: boolean; reason: string } | undefined>;
}

/**
 * Checks whether a specialist has "write bash" access: bash tool AND at least
 * one of edit/write tools in the SPECIALISTS registry.
 */
function hasWriteBashAccess(specialistName: string | undefined): boolean {
  if (!specialistName) return false;
  const spec = SPECIALISTS[specialistName];
  if (!spec) return false;
  const tools: string[] = spec.tools ?? [];
  return tools.includes("bash") && (tools.includes("edit") || tools.includes("write"));
}

export function createIntegratedBashInterceptor(): IntegratedBashInterceptor {
  return {
    handler: async (event: any, ctx: any) => {
      // Only intercept bash tool calls
      if (event.toolName !== "bash") {
        return undefined;
      }

      const command = event.input?.command || "";
      const specialist = event.specialist as string | undefined;

      // 1. Dangerous commands always blocked
      const isDangerous = DANGEROUS_COMMANDS.some((d) => command.includes(d));
      if (isDangerous) {
        ctx.ui?.notify?.(`⚠️ Blocked dangerous command: ${command}`, "warning");
        return { block: true, reason: "Dangerous command blocked" };
      }

      // 2. Write commands blocked for read-only specialists (reads from SPECIALISTS)
      if (isWriteCommand(command) && !hasWriteBashAccess(specialist)) {
        ctx.ui?.notify?.(
          `🚫 Blocked write command for read-only specialist: ${command}`,
          "warning",
        );
        return { block: true, reason: "Write command blocked for read-only specialist" };
      }

      // 3. Allow
      return undefined;
    },
  };
}
