declare module 'picomatch' {
  export default function picomatch(
    pattern: string,
    options?: Record<string, unknown>
  ): (input: string) => boolean;
}
