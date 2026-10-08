/**
 * Startup health gate for CLIs whose TUI can render before the backend is
 * authenticated.  This is intentionally separate from ReadyGate: ReadyGate
 * protects against startup selectors, while this gate protects the first
 * message from an unauthenticated model backend.
 */

export type StartupHealthState = 'disabled' | 'pending' | 'ready' | 'fatal' | 'exhausted';

export class StartupHealthGate {
  private enabled = false;
  private uiReady = false;
  private authState: StartupHealthState = 'disabled';

  reset(enabled: boolean): void {
    this.enabled = enabled;
    this.uiReady = false;
    this.authState = enabled ? 'pending' : 'disabled';
  }

  markUiReady(): void {
    this.uiReady = true;
  }

  markAuthReady(): void {
    if (!this.enabled) return;
    this.authState = 'ready';
  }

  markAuthFailure(state: 'fatal' | 'exhausted'): void {
    if (!this.enabled) return;
    this.authState = state;
  }

  /** True while any startup-health condition still blocks user input. */
  shouldHold(): boolean {
    return this.enabled && (!this.uiReady || this.authState !== 'ready');
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isUiReady(): boolean {
    return this.uiReady;
  }

  get state(): StartupHealthState {
    return this.authState;
  }
}
