#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ci_evidence {
  generated_at: string;
  platform: NodeJS.Platform;
  bun_version: string;
  hard_gate_outcome: string;
  required_suites: string[];
  github: {
    workflow?: string;
    run_id?: string;
    run_number?: string;
    job?: string;
    ref?: string;
    sha?: string;
    actor?: string;
  };
}

function main(): void {
  const evidence_dir = join(process.cwd(), "ci-evidence");
  mkdirSync(evidence_dir, { recursive: true });

  const hard_gate_outcome = process.env.HARD_GATE_OUTCOME ?? "unknown";
  const report: ci_evidence = {
    generated_at: new Date().toISOString(),
    platform: process.platform,
    bun_version: process.versions.bun ?? "unknown",
    hard_gate_outcome,
    required_suites: ["unit", "integration", "e2e", "fault", "concurrency"],
    github: {
      workflow: process.env.GITHUB_WORKFLOW,
      run_id: process.env.GITHUB_RUN_ID,
      run_number: process.env.GITHUB_RUN_NUMBER,
      job: process.env.GITHUB_JOB,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      actor: process.env.GITHUB_ACTOR,
    },
  };

  const artifact_path = join(evidence_dir, `hard-gate-evidence-${process.platform}.json`);
  writeFileSync(artifact_path, JSON.stringify(report, null, 2));
  console.log(`[ci-evidence] wrote ${artifact_path}`);
}

main();
