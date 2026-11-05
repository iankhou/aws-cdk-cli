import * as os from 'os';
import * as path from 'path';
import type { EvaluatedStack } from '@aws-cdk/toolkit-lib';
import * as fs from 'fs-extra';
import { formatResourceCheckSummary, normalizeResourceCheckReport, runResourceChecks } from '../../lib/runner/resource-checks';

const stack = (stackName: string): EvaluatedStack => ({
  stackName,
  hierarchicalId: stackName,
  stackId: `arn:aws:cloudformation:eu-west-1:123456789012:stack/${stackName}/abcd1234-0000-0000-0000-000000000000`,
  physicalResourceIds: { Queue: `${stackName}-Queue` },
  template: { Resources: { Queue: { Type: 'AWS::SQS::Queue', Properties: { VisibilityTimeout: 30 } } } },
  unresolved: [],
  provenance: {},
});

/**
 * A checker whose `check` script reports one result per resource of the requested stack, with the region and
 * profile it ran with; it fails for a stack named `broken`
 */
function fakeChecker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-checker-'));
  fs.writeJsonSync(path.join(dir, 'package.json'), { name: 'fake-checker', private: true, scripts: { check: 'node check.js' } });
  fs.writeFileSync(path.join(dir, 'check.js'), `
    const fs = require('fs');
    const arg = (name) => process.argv[process.argv.indexOf('--' + name) + 1];
    const stack = JSON.parse(fs.readFileSync(arg('resolved'), 'utf-8')).stacks.find((s) => s.stackName === arg('stack'));
    if (stack.stackName === 'broken') process.exit(1);
    const detail = process.env.AWS_REGION + '/' + process.env.AWS_PROFILE;
    fs.writeFileSync(arg('out'), JSON.stringify(Object.entries(stack.template.Resources).map(([logicalId, r]) =>
      ({ logicalId, type: r.Type, property: '(exists)', status: 'missing', detail }))));
  `);
  return dir;
}

describe('runResourceChecks', () => {
  let checker: string;
  beforeEach(() => {
    checker = fakeChecker();
  });
  afterEach(() => {
    fs.removeSync(checker);
  });

  test('runs the checker once per stack, with the region and profile, and summarizes its results', () => {
    const { reports, errors } = runResourceChecks([stack('a'), stack('b')], { checkerDirectory: checker, region: 'eu-west-1', profile: 'test-profile' });

    expect(errors).toEqual([]);
    expect(reports.map((r) => r.stackName)).toEqual(['a', 'b']);
    expect(reports[0].summary).toEqual({ missing: 1 });
    expect(reports[0].results).toEqual([
      { logicalId: 'Queue', type: 'AWS::SQS::Queue', property: '(exists)', status: 'missing', detail: 'eu-west-1/test-profile' },
    ]);
  });

  test('a stack the checker fails for is reported as an error, and the others are still checked', () => {
    const { reports, errors } = runResourceChecks([stack('broken'), stack('b')], { checkerDirectory: checker, region: 'eu-west-1' });

    expect(reports.map((r) => r.stackName)).toEqual(['b']);
    expect(errors).toEqual([expect.stringMatching(/^broken: /)]);
  });

  test('a checker directory that does not exist is reported as an error for every stack', () => {
    const { reports, errors } = runResourceChecks([stack('a')], { checkerDirectory: path.join(checker, 'does-not-exist') });

    expect(reports).toEqual([]);
    expect(errors).toEqual([expect.stringMatching(/^a: /)]);
  });
});

test('formatResourceCheckSummary', () => {
  expect(formatResourceCheckSummary({ stackName: 'a', summary: { pass: 24, missing: 3 }, results: [] })).toEqual('a: 24 pass, 3 missing');
  expect(formatResourceCheckSummary({ stackName: 'a', summary: {}, results: [] })).toEqual('a: no resources checked');
});

test('normalizeResourceCheckReport replaces the deployment\'s values in expected and actual values and details', () => {
  const deployed: EvaluatedStack = {
    ...stack('a'),
    physicalResourceIds: { Queue: 'https://sqs.eu-west-1.amazonaws.com/123456789012/a-Queue-1A2B3C4D5E6F' },
  };
  const report = normalizeResourceCheckReport({
    stackName: 'a',
    summary: { pass: 1, missing: 1 },
    results: [
      { logicalId: 'Queue', property: 'RedrivePolicy', status: 'pass', expected: { deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:123456789012:dlq' }, actual: 30 },
      { logicalId: 'Queue', property: '(exists)', status: 'missing', detail: 'queue https://sqs.eu-west-1.amazonaws.com/123456789012/a-Queue-1A2B3C4D5E6F does not exist' },
    ],
  }, deployed);

  expect(report.results).toEqual([
    { logicalId: 'Queue', property: 'RedrivePolicy', status: 'pass', expected: { deadLetterTargetArn: 'arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:dlq' }, actual: 30 },
    { logicalId: 'Queue', property: '(exists)', status: 'missing', detail: 'queue ${Queue} does not exist' },
  ]);
});
