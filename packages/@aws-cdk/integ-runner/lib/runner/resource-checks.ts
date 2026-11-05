import * as os from 'os';
import * as path from 'path';
import type { EvaluatedStack } from '@aws-cdk/toolkit-lib';
import * as fs from 'fs-extra';
import { exec } from '../utils';

/**
 * One stack's results from the resource checker
 */
export interface ResourceCheckReport {
  readonly stackName: string;
  /** Number of results by status (`pass`, `fail`, `missing`, `gap`, ...) */
  readonly summary: { [status: string]: number };
  /** The checker's results, as it reports them */
  readonly results: any[];
}

export interface ResourceCheckOptions {
  /** A checkout of the resource checker (cdk-integ-assertions), with its dependencies installed */
  readonly checkerDirectory: string;
  /** Region the stacks are deployed in */
  readonly region?: string;
  /** AWS profile to read the stacks' resources with */
  readonly profile?: string;
  /** Extra environment variables for the checker */
  readonly env?: { [name: string]: string };
}

/**
 * Read each deployed stack's resources back through their service APIs, and compare them with the stack's
 * resolved template, by running the checker's `check` script once per stack.
 *
 * Only read calls are made. A stack the checker can't be run for is left out of the result.
 */
export function runResourceChecks(stacks: EvaluatedStack[], options: ResourceCheckOptions): {
  reports: ResourceCheckReport[];
  errors: string[];
} {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-resource-checks-'));
  try {
    const resolvedFile = path.join(workDir, 'evaluate.json');
    fs.writeJsonSync(resolvedFile, { stacks });
    const env = {
      ...options.env,
      ...(options.region ? { AWS_REGION: options.region, AWS_DEFAULT_REGION: options.region } : {}),
      ...(options.profile ? { AWS_PROFILE: options.profile } : {}),
    };
    const reports: ResourceCheckReport[] = [];
    const errors: string[] = [];
    for (const stack of stacks) {
      const out = path.join(workDir, `${stack.stackName}.checks.json`);
      try {
        exec(['npm', 'run', '--silent', 'check', '--', '--resolved', resolvedFile, '--stack', stack.stackName, '--out', out], {
          cwd: options.checkerDirectory,
          env,
        });
        const results: any[] = fs.readJsonSync(out);
        const summary: { [status: string]: number } = {};
        for (const r of results) {
          summary[r.status] = (summary[r.status] ?? 0) + 1;
        }
        reports.push({ stackName: stack.stackName, summary, results });
      } catch (e: any) {
        errors.push(`${stack.stackName}: ${e.message ?? e}`);
      }
    }
    return { reports, errors };
  } finally {
    fs.removeSync(workDir);
  }
}

/**
 * Write each stack's resource check report to `<stackName>.checks.json` in the snapshot directory
 */
export async function writeResourceCheckReports(snapshotDirectory: string, reports: ResourceCheckReport[]): Promise<void> {
  for (const report of reports) {
    await fs.writeJson(path.join(snapshotDirectory, `${report.stackName}.checks.json`), report, { spaces: 1 });
  }
}

/**
 * One line per stack, e.g. `my-stack: 24 pass, 3 missing, 5 unresolved`
 */
export function formatResourceCheckSummary(report: ResourceCheckReport): string {
  const counts = Object.entries(report.summary).map(([status, n]) => `${n} ${status}`).join(', ');
  return `${report.stackName}: ${counts || 'no resources checked'}`;
}
