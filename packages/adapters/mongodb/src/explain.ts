import type { MongoExplain } from '@datakit/core';
import type { Document } from 'mongodb';
import { isDocument, shellText } from './values';

/**
 * Sums up `executionStats` explain output. A find, and a pipeline the server runs as a find, report `queryPlanner`
 * and `executionStats` at the top; other pipelines report them in their first stage (`$cursor`) and add one entry per
 * later stage; a sharded cluster reports the plan of each shard under `shards`.
 */

const CHILDREN = ['inputStage', 'outerStage', 'innerStage', 'thenStage', 'elseStage'] as const;

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0) || 0);
const asDocument = (value: unknown): Document | undefined => (isDocument(value) ? value : undefined);

/** The plan tree of a `queryPlanner.winningPlan`; the slot-based engine nests it under `queryPlan`. */
function planRoot(winningPlan: unknown): Document | undefined {
  const plan = asDocument(winningPlan);
  if (!plan) return undefined;
  const root = asDocument(plan.queryPlan) ?? plan;
  // A cluster names the plan of each shard; the first one stands for all.
  const shard = Array.isArray(root.shards) ? asDocument(root.shards[0]) : undefined;
  if (shard) return planRoot(shard.winningPlan ?? shard.queryPlanner?.winningPlan) ?? root;
  return root;
}

/** Stage names from the root down, depth first. */
function planStages(node: Document | undefined, into: string[] = []): string[] {
  if (!node) return into;
  if (typeof node.stage === 'string') into.push(node.stage);
  for (const key of CHILDREN) planStages(asDocument(node[key]), into);
  if (Array.isArray(node.inputStages)) for (const child of node.inputStages) planStages(asDocument(child), into);
  return into;
}

function planIndex(node: Document | undefined): string | null {
  if (!node) return null;
  if (typeof node.indexName === 'string') return node.indexName;
  if (node.stage === 'IDHACK') return '_id_';
  for (const key of CHILDREN) {
    const index = planIndex(asDocument(node[key]));
    if (index) return index;
  }
  if (Array.isArray(node.inputStages)) {
    for (const child of node.inputStages) {
      const index = planIndex(asDocument(child));
      if (index) return index;
    }
  }
  return null;
}

export function summarizeExplain(output: Document): MongoExplain {
  const pipelineStages = Array.isArray(output.stages) ? output.stages.filter(isDocument) : [];
  const cursor = asDocument(pipelineStages[0]?.$cursor);
  const shard = isDocument(output.shards) ? asDocument(Object.values(output.shards)[0]) : undefined;
  const source = cursor ?? (output.queryPlanner ? output : undefined) ?? shard ?? output;

  const plan = planRoot(asDocument(source.queryPlanner)?.winningPlan);
  const later = pipelineStages.slice(cursor ? 1 : 0);
  const stats = asDocument(output.executionStats) ?? asDocument(source.executionStats) ?? {};
  const last = later.at(-1);

  return {
    // The later pipeline stages run on top of the cursor, so they come first.
    stages: [...later.map((stage) => Object.keys(stage).find((key) => key.startsWith('$')) ?? '?').reverse(), ...planStages(plan)],
    index: planIndex(plan),
    returned: asNumber(last?.nReturned ?? stats.nReturned),
    docsExamined: asNumber(stats.totalDocsExamined),
    keysExamined: asNumber(stats.totalKeysExamined),
    timeMs: asNumber(last?.executionTimeMillisEstimate ?? stats.executionTimeMillis),
    text: shellText(output),
  };
}
