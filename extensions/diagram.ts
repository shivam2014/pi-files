import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

interface DiagramDetails {
    code: string;
    success: boolean;
    savedTo?: string;
    error?: string;
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "draw_diagram",
        label: "Draw Diagram",
        description: "Generate a diagram or plot using matplotlib Python code. Write matplotlib code that creates a figure (using plt), and this tool will render it and return the image.",
        parameters: Type.Object({
            code: Type.String({ 
                description: "Python code using matplotlib to create the diagram. Must create a figure using plt. Example: `import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.title('My Plot')`" 
            }),
            output: Type.Optional(Type.String({ 
                description: "Optional file path to save the diagram (e.g., '/tmp/diagram.png'). If provided, the diagram will also be saved to this path." 
            })),
            width: Type.Optional(Type.Number({ 
                description: "Image width in pixels (default: 800)" 
            })),
            height: Type.Optional(Type.Number({ 
                description: "Image height in pixels (default: 600)" 
            })),
            dpi: Type.Optional(Type.Number({ 
                description: "DPI for output (default: 100)" 
            })),
        }),

        async execute(
            _toolCallId: string,
            params: { 
                code: string; 
                output?: string; 
                width?: number; 
                height?: number; 
                dpi?: number 
            },
            signal: AbortSignal | undefined,
            _onUpdate: undefined,
            ctx: { cwd: string }
        ): Promise<{ 
            content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; 
            details: DiagramDetails 
        }> {
            
            const pythonScript = join(homedir(), ".pi", "scripts", "draw_diagram.py");
            const width = params.width || 800;
            const height = params.height || 600;
            const dpi = params.dpi || 100;
            
            try {
                // Build command arguments
                const args = [
                    pythonScript,
                    "--code", params.code,
                    "--width", width.toString(),
                    "--height", height.toString(),
                    "--dpi", dpi.toString()
                ];
                
                if (params.output) {
                    args.push("--output", params.output);
                }
                
                // Execute Python script
                const { stdout, stderr } = await execFileAsync("python3", args, {
                    cwd: ctx.cwd,
                    signal,
                    timeout: 30000, // 30 second timeout
                    maxBuffer: 10 * 1024 * 1024 // 10MB buffer
                });
                
                // Parse JSON result
                const result = JSON.parse(stdout.trim());
                
                if (!result.success) {
                    return {
                        content: [{ 
                            type: "text", 
                            text: `Diagram error: ${result.error}\n\n${result.traceback || ''}` 
                        }],
                        details: {
                            code: params.code,
                            success: false,
                            error: result.error
                        }
                    };
                }
                
                // Build response with image
                const response: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
                
                // Add info text
                let info = `Diagram generated (${width}x${height} @ ${dpi} DPI)`;
                if (result.saved_to) {
                    info += `\nSaved to: ${result.saved_to}`;
                }
                response.push({ type: "text", text: info });
                
                // Add image
                response.push({
                    type: "image",
                    data: result.image,
                    mimeType: "image/png"
                });
                
                return {
                    content: response,
                    details: {
                        code: params.code,
                        success: true,
                        savedTo: result.saved_to
                    }
                };
                
            } catch (error: any) {
                // Handle execution errors
                let errorMessage = error.message || String(error);
                
                // Try to parse stderr for more info
                if (error.stderr) {
                    errorMessage += `\n\nStderr: ${error.stderr}`;
                }
                
                return {
                    content: [{ 
                        type: "text", 
                        text: `Failed to execute diagram code: ${errorMessage}` 
                    }],
                    details: {
                        code: params.code,
                        success: false,
                        error: errorMessage
                    }
                };
            }
        },
    });
}
