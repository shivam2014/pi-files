export function formatDuration(ms: number): string {
    if (ms < 1000) return "0s";                     // SPEC: instantaneous
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `${minutes}m ${rem}s`;                    // SPEC: always "Xm Ys"
}
