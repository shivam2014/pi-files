# ADR-0004: Fusion tool module split

Fusion-tool.ts grew to 863 lines across 6 concerns (config, panel models, judge analysis, formatting, model resolution, orchestration). We extracted 7 focused modules along natural seams and kept the original file as a thin registration-and-re-export hub. This preserves backward compatibility while giving each concern its own testable module. The extraction is purely structural — no behavioral changes to the fusion tool's public interface or execution semantics.
