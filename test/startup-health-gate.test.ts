import { describe, expect, it } from 'vitest';
import { StartupHealthGate } from '../src/utils/startup-health-gate.js';

describe('StartupHealthGate', () => {
  it('keeps a service-account session blocked until both UI and auth are ready', () => {
    const gate = new StartupHealthGate();
    gate.reset(true);
    expect(gate.shouldHold()).toBe(true);

    gate.markUiReady();
    expect(gate.shouldHold()).toBe(true);

    gate.markAuthReady();
    expect(gate.shouldHold()).toBe(false);
  });

  it('does not let a fatal or exhausted probe fail open', () => {
    for (const failure of ['fatal', 'exhausted'] as const) {
      const gate = new StartupHealthGate();
      gate.reset(true);
      gate.markUiReady();
      gate.markAuthFailure(failure);
      expect(gate.shouldHold()).toBe(true);
      expect(gate.state).toBe(failure);
    }
  });

  it('passes through unchanged when disabled', () => {
    const gate = new StartupHealthGate();
    gate.reset(false);
    expect(gate.shouldHold()).toBe(false);
    expect(gate.state).toBe('disabled');
  });

  it('reset clears a previous generation result', () => {
    const gate = new StartupHealthGate();
    gate.reset(true);
    gate.markUiReady();
    gate.markAuthReady();
    expect(gate.shouldHold()).toBe(false);

    gate.reset(true);
    expect(gate.shouldHold()).toBe(true);
    expect(gate.isUiReady).toBe(false);
    expect(gate.state).toBe('pending');
  });
});
