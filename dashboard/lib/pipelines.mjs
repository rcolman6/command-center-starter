// dashboard/lib/pipelines.mjs
// Canonical Zod schema for pipeline definitions. ONE schema, in ONE file.
// dashboard/lib/pipelines.ts re-exports these and derives TS types via z.infer.
import { z } from 'zod';

export const TriggerSchema = z
  .object({
    type: z.enum(['cron', 'manual']),
    cron: z.string().min(1).optional(), // required in practice when type === 'cron'
  })
  .strict();

export const AutoGateSchema = z
  .object({ type: z.literal('auto') })
  .strict();

export const ReviewGateSchema = z
  .object({
    type: z.literal('review'),
    instructions: z.string().optional(),
  })
  .strict();

export const TestGateSchema = z
  .object({
    type: z.literal('test'),
    command: z.string().min(1),
    onFail: z
      .object({
        heal: z.string().min(1), // "worker/<name>"
        maxRetries: z.number().int().nonnegative(),
        thenEscalate: z.literal('review'),
      })
      .strict(),
  })
  .strict();

export const GateSchema = z.discriminatedUnion('type', [
  AutoGateSchema,
  ReviewGateSchema,
  TestGateSchema,
]);

export const StageSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    command: z.string().min(1), // "worker/<name>"
    gate: GateSchema,
    // Data flow (distinct from `next`, which is control flow). The upstream stage
    // ids whose deliverable this stage consumes. OMIT for the default handoff —
    // the immediately-preceding stage. Declare to pull from ANY earlier stage(s),
    // e.g. ["research"] so a late stage reads a deliverable two hops back.
    inputs: z.array(z.string().min(1)).optional(),
    next: z.string().min(1).optional(), // omit on the terminal stage
  })
  .strict();

export const PipelineDefSchema = z
  .object({
    id: z.string().min(1), // MUST equal the filename without .json
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: TriggerSchema,
    stages: z.array(StageSchema).min(1),
  })
  .strict()
  .superRefine((def, ctx) => {
    // 1. Stage ids unique.
    const seen = new Set();
    for (const [i, stage] of def.stages.entries()) {
      if (seen.has(stage.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['stages', i, 'id'],
          message: `duplicate stage id "${stage.id}"`,
        });
      }
      seen.add(stage.id);
    }
    // 2. Every `next` points at a declared stage id.
    const ids = new Set(def.stages.map((s) => s.id));
    for (const [i, stage] of def.stages.entries()) {
      if (stage.next !== undefined && !ids.has(stage.next)) {
        ctx.addIssue({
          code: 'custom',
          path: ['stages', i, 'next'],
          message: `unknown stage id "${stage.next}"`,
        });
      }
    }
    // 3. `inputs` may only name EARLIER stages — never the stage itself or one
    //    that runs later. The engine can only hand forward a deliverable that
    //    already exists when the stage is seeded. Run order is the `next`-chain
    //    walk from the first stage.
    const order = new Map();
    {
      const byId = new Map(def.stages.map((s) => [s.id, s]));
      let cur = def.stages[0];
      let pos = 0;
      const walked = new Set();
      while (cur && !walked.has(cur.id)) {
        walked.add(cur.id);
        order.set(cur.id, pos++);
        cur = cur.next !== undefined ? byId.get(cur.next) : undefined;
      }
    }
    for (const [i, stage] of def.stages.entries()) {
      if (stage.inputs === undefined) continue;
      for (const [j, inId] of stage.inputs.entries()) {
        if (!ids.has(inId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', i, 'inputs', j],
            message: `unknown stage id "${inId}"`,
          });
          continue;
        }
        if (inId === stage.id) {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', i, 'inputs', j],
            message: `stage "${stage.id}" cannot list itself as an input`,
          });
          continue;
        }
        const here = order.get(stage.id);
        const there = order.get(inId);
        // Enforce ordering only when both stages are on the reachable chain.
        if (here !== undefined && there !== undefined && there >= here) {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', i, 'inputs', j],
            message: `input "${inId}" does not run before stage "${stage.id}"`,
          });
        }
      }
    }
  });
