// dashboard/lib/pipelines.ts — TypeScript surface. Re-export only; defines NO shapes.
// The two filesystem helpers (loadPipeline / listPipelines) read config/pipelines/*.json.
import fs from 'fs';
import path from 'path';
import type { z } from 'zod';
import {
  PipelineDefSchema,
  StageSchema,
  GateSchema,
  AutoGateSchema,
  ReviewGateSchema,
  TestGateSchema,
  TriggerSchema,
} from './pipelines.mjs';

export {
  PipelineDefSchema,
  StageSchema,
  GateSchema,
  AutoGateSchema,
  ReviewGateSchema,
  TestGateSchema,
  TriggerSchema,
};

export type Trigger = z.infer<typeof TriggerSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type PipelineDef = z.infer<typeof PipelineDefSchema>;

export function parsePipelineDef(input: unknown): PipelineDef {
  return PipelineDefSchema.parse(input); // throws ZodError on bad input
}

// Next.js runs with cwd = dashboard/, so the repo root is one level up and
// pipeline definitions live at config/pipelines/<id>.json from there.
const PIPELINES_DIR = path.join(process.cwd(), '..', 'config', 'pipelines');

// Read + parse config/pipelines/<id>.json. Throws if missing or invalid.
export function loadPipeline(id: string): PipelineDef {
  const file = path.join(PIPELINES_DIR, `${id}.json`);
  const raw = fs.readFileSync(file, 'utf-8');
  return parsePipelineDef(JSON.parse(raw));
}

// Read the directory, parse every *.json, keep only the valid ones, skip
// .schema.json. Never throws on a missing dir or a bad file — returns what it can.
export function listPipelines(): PipelineDef[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(PIPELINES_DIR);
  } catch {
    return []; // missing dir = no pipelines
  }
  const out: PipelineDef[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.json') || name === '.schema.json') continue;
    try {
      const raw = fs.readFileSync(path.join(PIPELINES_DIR, name), 'utf-8');
      out.push(parsePipelineDef(JSON.parse(raw)));
    } catch {
      // skip invalid/unparseable files — the validator reports them separately
    }
  }
  return out;
}
