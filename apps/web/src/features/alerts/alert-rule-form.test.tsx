import type { AlertRuleResponse } from '@logalot/contracts';
import { describe, expect, it } from 'vitest';
import {
  assembleAlertRuleBody,
  EMPTY_ALERT_RULE_VALUES,
  parseLabels,
  validateAlertRule,
  valuesFromRule,
} from './alert-rule-form';

describe('parseLabels', () => {
  it('parses key=value lines and ignores blanks / malformed lines', () => {
    expect(parseLabels('env=prod\n\nregion=us-east-1\nnokey\n=noval')).toEqual({
      env: 'prod',
      region: 'us-east-1',
    });
  });
});

describe('assembleAlertRuleBody', () => {
  it('coerces strings to numbers, drops empty query fields, and maps channels', () => {
    const body = assembleAlertRuleBody({
      ...EMPTY_ALERT_RULE_VALUES,
      name: '  High errors  ',
      text: 'boom',
      service: '',
      threshold: '12',
      windowSeconds: '600',
      notifyChannels: [
        { type: 'webhook', value: 'https://hooks.test/x' },
        { type: 'email', value: '' }, // dropped (blank)
      ],
    });
    expect(body).toMatchObject({
      name: 'High errors',
      query: { text: 'boom' },
      threshold: 12,
      windowSeconds: 600,
      notifyChannels: [{ type: 'webhook', url: 'https://hooks.test/x' }],
    });
    expect((body.query as Record<string, unknown>).service).toBeUndefined();
  });
});

describe('validateAlertRule (shared-contract validation)', () => {
  it('rejects an empty inline query (would fire on all logs)', () => {
    const result = validateAlertRule('create', { ...EMPTY_ALERT_RULE_VALUES, name: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messages.join(' ')).toMatch(/exactly one of/i);
  });

  it('accepts a well-formed inline-query rule', () => {
    const result = validateAlertRule('create', {
      ...EMPTY_ALERT_RULE_VALUES,
      name: 'High errors',
      text: 'boom',
      threshold: '5',
    });
    expect(result.ok).toBe(true);
  });
});

describe('valuesFromRule', () => {
  it('round-trips a rule into editable form values', () => {
    const rule: AlertRuleResponse = {
      id: '00000000-0000-0000-0000-0000000000f1',
      tenantId: '00000000-0000-0000-0000-0000000000aa',
      name: 'High errors',
      savedQueryId: null,
      query: { text: 'boom', level: 'error', labels: { env: 'prod' } },
      comparator: 'gte',
      threshold: 7,
      windowSeconds: 600,
      severity: 'critical',
      enabled: false,
      notifyChannels: [{ type: 'email', to: 'a@b.test' }],
      state: 'firing',
      lastEvaluatedAt: null,
      lastTriggeredAt: null,
      createdBy: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(valuesFromRule(rule)).toMatchObject({
      name: 'High errors',
      text: 'boom',
      level: 'error',
      labels: 'env=prod',
      comparator: 'gte',
      threshold: '7',
      windowSeconds: '600',
      severity: 'critical',
      enabled: false,
      notifyChannels: [{ type: 'email', value: 'a@b.test' }],
    });
  });
});
