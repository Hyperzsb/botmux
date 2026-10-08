import { describe, expect, it } from 'vitest';
import { classifyTraexStartupProbeForTest } from '../src/adapters/cli/traex.js';

describe('TRAEX startup probe classification', () => {
  it('accepts a non-empty models JSON array', () => {
    expect(classifyTraexStartupProbeForTest({
      status: 0,
      stdout: '[{"name":"gpt-5.6-sol"}]',
      stderr: '',
    })).toEqual({ state: 'ready', reason: 'models=1' });
  });

  it('treats transport failures as retryable', () => {
    expect(classifyTraexStartupProbeForTest({
      status: null,
      stdout: '',
      stderr: 'SSL connection timeout',
      errorCode: 'ETIMEDOUT',
    })).toEqual({ state: 'retryable', reason: 'network_or_timeout' });
  });

  it('treats auth rejection as fatal', () => {
    expect(classifyTraexStartupProbeForTest({
      status: 403,
      stdout: '',
      stderr: 'Forbidden',
    })).toEqual({ state: 'fatal', reason: 'auth_or_entitlement_rejected' });
  });
});
