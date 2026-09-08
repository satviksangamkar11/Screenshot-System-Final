import { CDPClient } from './cdp-client.js';

export class CDPSession {
  constructor(
    private client: CDPClient,
    private sessionId: string,
    private targetId?: string,
  ) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.client.sendWithSession<T>(method, this.sessionId, params);
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.client.on(`${this.sessionId}:${event}`, listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    this.client.once(`${this.sessionId}:${event}`, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.client.off(`${this.sessionId}:${event}`, listener);
    return this;
  }

  async detach(): Promise<void> {
    await this.client.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => undefined);
  }

  /**
   * Attaches a new independent CDP session to the same target.
   * Used by RemoteControl to get its own screencast session without affecting the page's primary session.
   * Mirrors Playwright's `context().newCDPSession()` behavior.
   */
  async attachNewSession(): Promise<CDPSession> {
    if (!this.targetId) {
      throw new Error('Cannot attach new session: targetId not known');
    }
    const attachResp = (await this.client.send('Target.attachToTarget', {
      targetId: this.targetId,
      flatten: true,
    })) as { sessionId: string };
    return new CDPSession(this.client, attachResp.sessionId, this.targetId);
  }

  get id(): string {
    return this.sessionId;
  }
}
