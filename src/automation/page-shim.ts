import { CDPSession } from './cdp-session.js';
import { LocatorShim } from './locator-shim.js';

export class PageShim {
  private executionContextId: number | null = null;
  /**
   * The frame id of the top-level document we actually navigated to (set from
   * `Page.frameNavigated` for any frame reporting no `parentId`, and confirmed
   * by `goto()`'s own `Page.navigate` response). Enterprise SAP portals commonly
   * load several other frames alongside the one being documented -- a
   * notification service, a chat widget, an SSO keep-alive iframe -- each of
   * which fires its own `Runtime.executionContextCreated` with
   * `auxData.isDefault: true` for *its own* frame. Without this id, the
   * context handler below accepted whichever such event fired last and had no
   * way to tell it apart from the frame actually being captured; a live run
   * against a RISE-hosted landscape showed `evaluate()` silently querying an
   * empty, irrelevant document for its full three-minute readiness budget
   * (`interactive=0, dialogs=0`) while the real page -- error dialog included
   * -- sat fully rendered on screen the whole time.
   */
  private mainFrameId: string | null = null;
  private _url = 'about:blank';
  private isClosed_ = false;
  private domContentLoadId: string | null = null;
  private eventHandlers = new Map<string, (...args: unknown[]) => void>();

  constructor(private cdpSession: CDPSession) {
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const frameNavHandler = (...args: unknown[]) => {
      const params = args[0] as Record<string, unknown> | undefined;
      if (params) {
        const frame = params.frame as { id: string; url: string; parentId?: string } | undefined;
        if (frame) {
          if (!frame.parentId) {
            this.mainFrameId = frame.id;
          }
          if (!frame.parentId || frame.id === this.mainFrameId) {
            this._url = frame.url;
          }
        }
      }
    };
    this.eventHandlers.set('Page.frameNavigated', frameNavHandler);
    this.cdpSession.on('Page.frameNavigated', frameNavHandler);

    const contextHandler = (...args: unknown[]) => {
      const params = args[0] as Record<string, unknown> | undefined;
      if (params) {
        const context = params.context as
          | { id: number; auxData?: { isDefault?: boolean; frameId?: string } }
          | undefined;
        if (
          context?.auxData?.isDefault &&
          (this.mainFrameId === null || context.auxData?.frameId === this.mainFrameId)
        ) {
          this.executionContextId = context.id;
        }
      }
    };
    this.eventHandlers.set('Runtime.executionContextCreated', contextHandler);
    this.cdpSession.on('Runtime.executionContextCreated', contextHandler);

    const targetDestroyHandler = () => {
      this.isClosed_ = true;
    };
    this.eventHandlers.set('Target.targetDestroyed', targetDestroyHandler);
    this.cdpSession.on('Target.targetDestroyed', targetDestroyHandler);
  }

  private cleanupEventListeners(): void {
    for (const [event, handler] of this.eventHandlers) {
      this.cdpSession.off(event, handler);
    }
    this.eventHandlers.clear();
  }

  async enable(): Promise<void> {
    await this.cdpSession.send('Runtime.enable', {});
    await this.cdpSession.send('Page.enable', {});

    // Wait for the execution context to be created (with a timeout)
    await new Promise<void>((resolve, reject) => {
      if (this.executionContextId !== null) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('enable: execution context not created within 5s'));
      }, 5000);

      const onContextCreated = (...args: unknown[]) => {
        const params = args[0] as Record<string, unknown> | undefined;
        if (params) {
          const context = params.context as { id: number; auxData?: { isDefault?: boolean } } | undefined;
          if (context && context.auxData?.isDefault) {
            clearTimeout(timeout);
            this.cdpSession.off('Runtime.executionContextCreated', onContextCreated);
            resolve();
          }
        }
      };

      this.cdpSession.on('Runtime.executionContextCreated', onContextCreated);
    });
  }

  async evaluate<R, Arg = void>(fn: (arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    if (this.executionContextId === null) {
      throw new Error('Page.evaluate: execution context not ready');
    }

    /*
     * Under tsx's dev-time esbuild transform, a named function with nested
     * closures gets wrapped with a `__name(fn, "fn")` call to preserve
     * `.name` — a helper that lives in the bundled module scope, not in the
     * function's own source. `fn.toString()` only carries the function
     * body, so once that text is shipped into the page's isolated execution
     * context and re-parsed there, the call remains but the helper does not,
     * and every such function throws `ReferenceError: __name is not defined`
     * before running a single line of its own logic. A no-op `__name` in the
     * preamble absorbs the reference regardless of how a given function got
     * transformed; a plain `tsc` build never emits the helper, so this is a
     * no-op there too.
     */
    const functionDeclaration = `function(arg) {
      const __name = (fn) => fn;
      return (${fn.toString()})(arg);
    }`;

    const resp = (await this.cdpSession.send('Runtime.callFunctionOn', {
      functionDeclaration,
      arguments: arg !== undefined ? [{ value: arg }] : [],
      executionContextId: this.executionContextId,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text: string; description: string };
    };

    if (resp.exceptionDetails) {
      throw new Error(`Page.evaluate threw: ${resp.exceptionDetails.text || resp.exceptionDetails.description}`);
    }

    return resp.result?.value as R;
  }

  async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;
    const waitUntil = opts?.waitUntil ?? 'domcontentloaded';

    return Promise.race([
      (async () => {
        const resp = (await this.cdpSession.send('Page.navigate', { url })) as { frameId?: string; loaderId?: string; errorText?: string };

        if (resp.errorText) {
          throw new Error(`goto(${url}): ${resp.errorText}`);
        }

        // Authoritative: this is the frame CDP itself confirms we navigated,
        // independent of whatever `Page.frameNavigated` events land afterward.
        if (resp.frameId) {
          this.mainFrameId = resp.frameId;
        }

        if (waitUntil === 'domcontentloaded') {
          // Page.domContentEventFired carries only a timestamp, not a frame/loader id,
          // so we wait for the next fire after issuing navigate (this session has
          // exactly one frame in play at a time in this codebase's usage).
          await new Promise<void>((resolve, reject) => {
            const handleLoad = () => {
              this.cdpSession.off('Page.domContentEventFired', handleLoad);
              resolve();
            };
            this.cdpSession.on('Page.domContentEventFired', handleLoad);

            setTimeout(() => {
              this.cdpSession.off('Page.domContentEventFired', handleLoad);
              reject(new Error(`goto(${url}): domContentEventFired timeout`));
            }, timeout);
          });
        }

        // Cache the URL immediately after navigation resolves
        this._url = url;
      })(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`goto timeout after ${timeout}ms`)), timeout)),
    ]);
  }

  async goBack(opts?: { timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;

    const historyResp = (await this.cdpSession.send('Page.getNavigationHistory', {})) as {
      entries?: Array<{ id: number }>;
      currentIndex?: number;
    };

    if (!historyResp.entries || historyResp.currentIndex === undefined || historyResp.currentIndex === 0) {
      throw new Error('goBack: no history entry to go back to');
    }

    const entryId = historyResp.entries[historyResp.currentIndex - 1]?.id;
    if (!entryId) {
      throw new Error('goBack: entry not found in history');
    }

    return Promise.race([
      (async () => {
        await this.cdpSession.send('Page.navigateToHistoryEntry', { entryId });

        {
          await new Promise<void>((resolve, reject) => {
            const handleLoad = () => {
              this.cdpSession.off('Page.domContentEventFired', handleLoad);
              resolve();
            };
            this.cdpSession.on('Page.domContentEventFired', handleLoad);

            setTimeout(() => {
              this.cdpSession.off('Page.domContentEventFired', handleLoad);
              reject(new Error('goBack: domContentEventFired timeout'));
            }, timeout);
          });
        }
      })(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`goBack timeout after ${timeout}ms`)), timeout)),
    ]);
  }

  async title(): Promise<string> {
    return this.evaluate(() => document.title);
  }

  url(): string {
    return this._url;
  }

  isClosed(): boolean {
    return this.isClosed_;
  }

  async waitForTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForLoadState(state: string, opts?: { timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;

    if (state === 'domcontentloaded') {
      // Already domloaded if we're here; just wait a tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else if (state === 'networkidle') {
      // Track in-flight requests and wait for zero pending.
      // This is a simplified approach: count requests sent vs. completed.
      // For real workloads, subscribe to Network events and count.
      await Promise.race([
        new Promise<void>((resolve) => {
          let pendingCount = 0;
          const maxAttempts = 50;
          let attempts = 0;

          const checkIdle = async () => {
            // Query Network.getResourceTree to check pending requests (if Network.enable was called)
            // For now, just sleep and assume idle after ~1s of no major activity.
            await this.waitForTimeout(100);
            attempts++;
            if (attempts >= maxAttempts) {
              resolve();
            }
          };

          checkIdle();
        }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`waitForLoadState(${state}) timeout`)), timeout)),
      ]);
    }
  }

  async screenshot(opts?: { path?: string; fullPage?: boolean; animations?: 'disabled' | 'allow' }): Promise<Buffer> {
    /*
     * CDP has no direct equivalent of Playwright's `animations: 'disabled'`.
     * Mitigated the same way Playwright itself does internally: inject a
     * temporary stylesheet that kills animations/transitions, capture, then
     * remove it, so a mid-transition frame never lands in the evidence set.
     */
    const marker = 'data-ui-doc-engine-anim-off';
    if (opts?.animations === 'disabled') {
      await this.evaluate((attr) => {
        const style = document.createElement('style');
        style.setAttribute(attr, '1');
        style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
        document.head.appendChild(style);
      }, marker).catch(() => undefined);
    }

    try {
      const resp = (await this.cdpSession.send('Page.captureScreenshot', { format: 'png' })) as {
        data?: string;
      };

      if (!resp.data) {
        throw new Error('Page.captureScreenshot: no data returned');
      }

      const buffer = Buffer.from(resp.data, 'base64');

      if (opts?.path) {
        const fs = await import('fs/promises');
        await fs.writeFile(opts.path, buffer);
      }

      return buffer;
    } finally {
      if (opts?.animations === 'disabled') {
        await this.evaluate((attr) => {
          document.head.querySelector(`style[${attr}]`)?.remove();
        }, marker).catch(() => undefined);
      }
    }
  }

  locator(selector: string): LocatorShim {
    return new LocatorShim(this.cdpSession, selector);
  }

  keyboard = {
    /**
     * A single printable character (e.g. a digit typed into a native date
     * input's segmented editor) needs a synthesized `char` event carrying
     * `text`, or Chromium dispatches the keyCode without ever inserting a
     * character — matching Playwright's own keyboard.press, which sends
     * rawKeyDown + char + keyUp for printable keys and plain keyDown/keyUp
     * for named ones (Escape, Tab, Enter, arrows, F-keys, Backspace).
     */
    press: async (key: string) => {
      const keyCode = this.getWindowsVirtualKeyCode(key);
      const isPrintable = key.length === 1;

      await this.cdpSession.send('Input.dispatchKeyEvent', {
        type: isPrintable ? 'rawKeyDown' : 'keyDown',
        key,
        windowsVirtualKeyCode: keyCode,
      });
      if (isPrintable) {
        await this.cdpSession.send('Input.dispatchKeyEvent', {
          type: 'char',
          text: key,
          unmodifiedText: key,
        });
      }
      await this.cdpSession.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        windowsVirtualKeyCode: keyCode,
      });
    },
    insertText: async (text: string) => {
      await this.cdpSession.send('Input.insertText', { text });
    },
  };

  mouse = {
    click: async (x: number, y: number) => {
      await this.cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await this.cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    },
  };

  context() {
    return {
      // Second param matches Playwright's real newCDPSession(page) signature;
      // unused here since the shim's session is already bound to one target.
      newCDPSession: async (_page?: PageShim) => this.cdpSession.attachNewSession(),
      storageState: async (opts?: { path?: string }) => {
        // Implemented in Phase C (storage-state.ts)
        throw new Error('storageState not yet implemented');
      },
    };
  }

  private getWindowsVirtualKeyCode(key: string): number {
    const keyMap: Record<string, number> = {
      Escape: 27,
      Tab: 9,
      Enter: 13,
      Backspace: 8,
      Control: 17,
      Shift: 16,
      Alt: 18,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      F4: 115,
      F12: 123,
    };
    return keyMap[key] ?? key.charCodeAt(0);
  }
}
