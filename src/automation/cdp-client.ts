import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface CDPMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export class CDPClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pendingMessages = new Map<number, (msg: CDPMessage) => void>();

  constructor(private url: string) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.setupMessageHandler();
        resolve();
      });

      this.ws.on('error', (err: Error) => reject(err));
      this.ws.once('close', () => {
        this.ws = null;
      });
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg: CDPMessage = JSON.parse(data.toString());

        if (msg.id && this.pendingMessages.has(msg.id)) {
          const handler = this.pendingMessages.get(msg.id)!;
          this.pendingMessages.delete(msg.id);
          handler(msg);
        } else if (msg.method) {
          // Session-scoped events (flattened mode) carry a top-level sessionId;
          // scope the emitted event name so each CDPSession only sees its own events.
          if (msg.sessionId) {
            this.emit(`${msg.sessionId}:${msg.method}`, msg.params);
          } else {
            this.emit(msg.method, msg.params);
          }
        }
      } catch (err) {
        console.error('Failed to parse CDP message:', err);
      }
    });

    this.ws.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private async sendMessage<T = unknown>(message: CDPMessage): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (message.id) this.pendingMessages.delete(message.id);
        reject(new Error(`CDP method ${message.method} timed out`));
      }, 30000);

      if (message.id) {
        this.pendingMessages.set(message.id, (response) => {
          clearTimeout(timeout);

          if (response.error) {
            reject(new Error(`CDP error: ${response.error.message}`));
          } else {
            resolve(response.result as T);
          }
        });
      }

      this.ws!.send(JSON.stringify(message), (err?: Error) => {
        if (err) {
          clearTimeout(timeout);
          if (message.id) this.pendingMessages.delete(message.id);
          reject(err);
        }
      });
    });
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.messageId;
    const message: CDPMessage = { id, method, params };
    return this.sendMessage<T>(message);
  }

  sendWithSession<T = unknown>(
    method: string,
    sessionId: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = ++this.messageId;
    const message: CDPMessage = { id, method, params, sessionId };
    return this.sendMessage<T>(message);
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws) {
        resolve();
        return;
      }

      this.ws.once('close', resolve);
      this.ws.close();
    });
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
