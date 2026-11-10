import { vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

type Handler = (event: any) => void;

const ORIGIN = 'https://app.example.com';

/**
 * Just enough of a browser's service worker machinery to run the real
 * page-side API (register.ts / client.ts) against the real sw.ts.
 *
 * What it models faithfully, because the bugs live there:
 * - The SW is a separate module instance. `restart()` evaluates sw.ts again
 *   in a fresh module graph, the way a browser does after terminating an
 *   idle worker: install/activate do NOT run again, module memory is gone,
 *   IndexedDB and Cache Storage survive, and `self.location` is the
 *   registered script URL.
 * - postMessage structured-clones its payload in both directions.
 * - Upstream answers 401 unless the request carries the valid bearer token.
 */
export class FakeServiceWorkerRuntime {
  readonly upstream: Request[] = [];
  validToken = 'tok-valid';

  private readonly idb = new IDBFactory();
  private readonly cacheStore = new Map<string, Map<string, Response>>();
  private swHandlers = new Map<string, Handler[]>();
  private pageHandlers = new Map<string, Set<Handler>>();
  private scriptURL: string | null = null;
  private scope = '/';
  private registration: any = null;
  private controller: any = null;
  private readonly pageClient = {
    id: 'page-1',
    postMessage: (data: unknown, ports: MessagePort[] = []) => {
      const event = { data: structuredClone(data), ports };
      queueMicrotask(() => this.pageHandlers.get('message')?.forEach((h) => h(event)));
    },
  };

  /** Install page-side globals. Call before importing register.ts/client.ts. */
  installPageGlobals(): void {
    vi.stubGlobal('navigator', { serviceWorker: this.serviceWorkerContainer() });
  }

  get registeredScriptURL(): string | null {
    return this.scriptURL;
  }

  /** Simulate the browser terminating the idle worker and waking it for an event. */
  async restart(): Promise<void> {
    if (!this.scriptURL) throw new Error('nothing registered');
    await this.evaluateScript();
  }

  /** Dispatch a fetch event the way a controlled page's subresource request would. */
  async fetch(url: string): Promise<Response> {
    const request = new Request(url);
    let responded: Promise<Response> | undefined;
    this.dispatch('fetch', {
      request,
      respondWith: (r: Response | Promise<Response>) => {
        responded = Promise.resolve(r);
      },
      waitUntil: () => {},
    });
    if (!responded) return globalThis.fetch(request);
    return responded;
  }

  lastUpstreamAuth(): string | null {
    return this.upstream.at(-1)?.headers.get('authorization') ?? null;
  }

  private async evaluateScript(): Promise<void> {
    this.swHandlers = new Map();
    vi.resetModules();
    vi.stubGlobal('indexedDB', this.idb);
    vi.stubGlobal('caches', this.cacheStorage());
    vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      this.upstream.push(req);
      const ok = req.headers.get('authorization') === `Bearer ${this.validToken}`;
      return new Response(ok ? 'tile' : 'Unauthorized', {
        status: ok ? 200 : 401,
        headers: { 'content-type': ok ? 'image/png' : 'text/plain', 'cache-control': 'no-store' },
      });
    });
    vi.stubGlobal('self', this.workerGlobalScope());
    await import('../sw.js');
  }

  private dispatch(type: string, event: any): void {
    for (const h of this.swHandlers.get(type) ?? []) h(event);
  }

  private async dispatchExtendable(type: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    this.dispatch(type, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  }

  private workerGlobalScope() {
    return {
      location: new URL(this.scriptURL!),
      registration: { scope: new URL(this.scope, ORIGIN).href },
      addEventListener: (type: string, handler: Handler) => {
        const list = this.swHandlers.get(type) ?? [];
        list.push(handler);
        this.swHandlers.set(type, list);
      },
      skipWaiting: async () => {},
      clients: {
        matchAll: async () => (this.controller ? [this.pageClient] : []),
        claim: async () => {
          if (this.controller) return;
          this.controller = this.registration.active;
          this.pageHandlers.get('controllerchange')?.forEach((h) => h({}));
        },
      },
    };
  }

  private activeWorker() {
    return {
      scriptURL: this.scriptURL,
      state: 'activated',
      postMessage: (data: unknown, transfer: MessagePort[] = []) => {
        const event = { data: structuredClone(data), ports: transfer, source: this.pageClient };
        queueMicrotask(() => this.dispatch('message', event));
      },
      addEventListener() {},
      removeEventListener() {},
    };
  }

  private serviceWorkerContainer() {
    const self = this;
    return {
      get controller() {
        return self.controller;
      },
      async register(path: string, options: { scope?: string; type?: string } = {}) {
        const url = new URL(path, ORIGIN).href;
        self.scope = options.scope ?? '/';
        if (self.registration && self.scriptURL === url) return self.registration;
        self.scriptURL = url;
        self.controller = null;
        await self.evaluateScript();
        await self.dispatchExtendable('install');
        self.registration ??= {
          scope: new URL(self.scope, ORIGIN).href,
          installing: null,
          waiting: null,
          active: null,
          unregister: async () => true,
        };
        self.registration.active = self.activeWorker();
        await self.dispatchExtendable('activate');
        return self.registration;
      },
      async getRegistration() {
        return self.registration ?? undefined;
      },
      addEventListener(type: string, handler: Handler) {
        const set = self.pageHandlers.get(type) ?? new Set();
        set.add(handler);
        self.pageHandlers.set(type, set);
      },
      removeEventListener(type: string, handler: Handler) {
        self.pageHandlers.get(type)?.delete(handler);
      },
    };
  }

  /** Simulate a page reload: page module state is gone, the registration and its worker remain. */
  reloadPage(): void {
    this.pageHandlers = new Map();
  }

  private cacheStorage(): CacheStorage {
    const open = async (name: string) => {
      const store = this.cacheStore.get(name) ?? new Map<string, Response>();
      this.cacheStore.set(name, store);
      return {
        match: async (key: Request) => store.get(key.url)?.clone(),
        put: async (key: Request, resp: Response) => {
          store.set(key.url, resp);
        },
        keys: async () => [...store.keys()].map((u) => new Request(u)),
      };
    };
    return {
      open,
      keys: async () => [...this.cacheStore.keys()],
      delete: async (name: string) => this.cacheStore.delete(name),
    } as unknown as CacheStorage;
  }
}
