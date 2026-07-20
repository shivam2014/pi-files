import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';

const stepsSchema = Type.Array(
    Type.Union([
        Type.String(),
        Type.Object({
            label: Type.String(),
            kind: Type.Literal('loop_until'),
            loopUntil: Type.Object({
                criterion: Type.String(),
                evaluator: Type.String(),
                iterationTemplate: Type.Object({
                    specialist: Type.String(),
                    task: Type.String(),
                }),
            }),
        }),
        Type.Object({
            label: Type.String(),
            kind: Type.Literal('delegation'),
        }),
        Type.Object({
            label: Type.String(),
            kind: Type.Literal('orchestrator'),
        }),
    ])
);

describe('plan tool step schema', () => {
    it('accepts string steps', () => {
        const union = (stepsSchema as any).items;
        expect(union.anyOf).toBeDefined();
        const kinds = union.anyOf.map((s: any) => s.properties?.kind?.const).filter(Boolean);
        expect(kinds).toContain('loop_until');
    });
    it('schema includes delegation kind', () => {
        const union = (stepsSchema as any).items;
        const kinds = union.anyOf.map((s: any) => s.properties?.kind?.const).filter(Boolean);
        expect(kinds).toContain('delegation');
    });
    it('schema includes orchestrator kind', () => {
        const union = (stepsSchema as any).items;
        const kinds = union.anyOf.map((s: any) => s.properties?.kind?.const).filter(Boolean);
        expect(kinds).toContain('orchestrator');
    });
});
