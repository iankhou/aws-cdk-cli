import * as path from 'path';
import type { EvaluatedStack, UnresolvedExpression } from '@aws-cdk/toolkit-lib';
import * as fs from 'fs-extra';

/**
 * Resource types whose settings are account-wide: the deployed value is whichever stack set it last
 */
const ACCOUNT_WIDE_TYPES = new Set(['AWS::ApiGateway::Account']);

/**
 * Shortest generated value that is also replaced inside longer strings.
 * Shorter ones (e.g. API Gateway resource ids) are only replaced when they are the whole value.
 */
const MIN_EMBEDDED_LENGTH = 8;

/**
 * Parts of physical ids are only replaced if they contain a digit, like generated names and ids do:
 * other parts are words such as a WAF scope (`REGIONAL`) that appear elsewhere with their own meaning
 */
const looksGenerated = (value: string) => /\d/.test(value);

/**
 * A deployed stack's template, with the values CloudFormation and the services chose for this deployment
 * replaced by placeholders, so it is the same for every deployment of the same app
 */
export interface ResolvedSnapshot {
  readonly version: '1';
  readonly stackName: string;
  /** The template's resources, evaluated against the deployed stack */
  readonly resources: { [logicalId: string]: any };
  readonly outputs?: { [logicalId: string]: any };
  /** Expressions that could not be evaluated */
  readonly unresolved: UnresolvedExpression[];
  /** Resources with account-wide settings, whose deployed values depend on what else is deployed in the account */
  readonly accountWide?: string[];
  readonly nestedStacks?: { [logicalId: string]: ResolvedSnapshot };
}

/**
 * A function that replaces the values that depend on the deployment in a string, by matching the deployment's values:
 * - each generated physical id (one that doesn't appear in the resource's own properties) with `${LogicalId}`;
 *   the name at the end of a URL or ARN physical id with
 *   `${LogicalId.Name}`, and each part of a `|`-separated physical id with `${LogicalId[n]}`
 * - the stack id, account, region and partition with `${AWS::StackId}`, `${AWS::AccountId}`, `${AWS::Region}`
 *   and `${AWS::Partition}` (taken from the stack id)
 */
export function deploymentValueNormalizer(stack: EvaluatedStack): (value: string) => string {
  const replacements = new Map<string, string>();
  const add = (value: string | undefined, placeholder: string) => {
    if (value && !replacements.has(value)) {
      replacements.set(value, placeholder);
    }
  };
  // most specific first: when two values are equal, the first one added wins
  add(stack.stackId, '${AWS::StackId}');
  // Names the template chooses (e.g. `StageName: prod`, `BucketName: my-bucket`) appear in the resource's own
  // properties and are the same in every deployment; CloudFormation-generated names and ids never do
  const generated = Object.entries(stack.physicalResourceIds)
    .filter(([logicalId, physicalId]) => !stringsIn(stack.template.Resources?.[logicalId]?.Properties).has(physicalId));
  for (const [logicalId, physicalId] of generated) {
    add(physicalId, `\${${logicalId}}`);
  }
  for (const [logicalId, physicalId] of generated) {
    const parts = physicalId.split('|');
    if (parts.length > 1) {
      parts.forEach((part, i) => looksGenerated(part) && add(part, `\${${logicalId}[${i}]}`));
    }
    const name = physicalId.replace(/\/$/, '').split(/[/:]/).pop();
    if (name && name !== physicalId && looksGenerated(name)) {
      add(name, `\${${logicalId}.Name}`);
    }
  }
  const [, partition, , region, account] = stack.stackId.split(':');
  add(account, '${AWS::AccountId}');
  add(region, '${AWS::Region}');

  const embedded = [...replacements.keys()].filter((v) => v.length >= MIN_EMBEDDED_LENGTH).sort((a, b) => b.length - a.length);
  const embeddedPattern = embedded.length > 0 ? new RegExp(embedded.map(escapeRegExp).join('|'), 'g') : undefined;
  return (value: string) => {
    const whole = replacements.get(value);
    if (whole !== undefined) {
      return whole;
    }
    const replaced = embeddedPattern ? value.replace(embeddedPattern, (match) => replacements.get(match)!) : value;
    return partition ? replaced.split(`arn:${partition}:`).join('arn:${AWS::Partition}:') : replaced;
  };
}

/**
 * Make a stack's evaluated template independent of the deployment it was evaluated against.
 *
 * A value whose provenance the evaluation recorded is written as its provenance: an `Fn::Sub` template with
 * `${LogicalId}`, `${LogicalId.Attribute}`, `${AWS::Region}`, `${ImportValue:Name}` and so on in place of the values
 * that depend on the deployment. The other strings (and the literal text in provenance) are deployment-independent
 * unless a function computed them from a deployment-dependent value (e.g. `Fn::Select` of an attribute); those are
 * normalized with `deploymentValueNormalizer`.
 */
export function resolvedSnapshot(stack: EvaluatedStack): ResolvedSnapshot {
  const replace = deploymentValueNormalizer(stack);
  const sources = stack.provenance ?? {};
  // in provenance, only the literal text between placeholders can contain deployment values
  const replaceLiterals = (source: string) => source.split(/(\$\{[^}]*\})/).map((part, i) => (i % 2 === 1 ? part : replace(part))).join('');
  const normalize = (value: string, at: string) => (at in sources ? replaceLiterals(sources[at]) : replace(value));

  const resources = mapStrings(stack.template.Resources ?? {}, normalize, 'Resources');
  const accountWide = Object.entries<any>(stack.template.Resources ?? {})
    .filter(([, r]) => ACCOUNT_WIDE_TYPES.has(r?.Type))
    .map(([logicalId]) => logicalId);

  return {
    version: '1',
    stackName: stack.stackName,
    resources,
    ...(stack.template.Outputs ? { outputs: mapStrings(stack.template.Outputs, normalize, 'Outputs') } : {}),
    // reasons can quote the deployment's values (e.g. the identifier of a resource that couldn't be read)
    unresolved: stack.unresolved.map((u) => ({ ...u, reason: replace(u.reason) })),
    ...(accountWide.length > 0 ? { accountWide } : {}),
    ...(stack.nestedStacks ? {
      nestedStacks: Object.fromEntries(Object.entries(stack.nestedStacks).map(([id, nested]) => [id, resolvedSnapshot(nested)])),
    } : {}),
  };
}

/**
 * Write each stack's resolved snapshot to `<stackName>.resolved.json` in the snapshot directory
 */
export async function writeResolvedSnapshots(snapshotDirectory: string, snapshots: ResolvedSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    await fs.writeJson(path.join(snapshotDirectory, `${snapshot.stackName}.resolved.json`), snapshot, { spaces: 1 });
  }
}

/** Map every string in a value; `at` is the value's path, like the paths in `EvaluatedStack.provenance` */
function mapStrings(value: any, fn: (s: string, at: string) => string, at: string): any {
  if (typeof value === 'string') {
    return fn(value, at);
  }
  if (Array.isArray(value)) {
    return value.map((x, i) => mapStrings(x, fn, `${at}.${i}`));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, mapStrings(x, fn, `${at}.${k}`)]));
  }
  return value;
}

function stringsIn(value: any, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    into.add(value);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((x) => stringsIn(x, into));
  }
  return into;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
