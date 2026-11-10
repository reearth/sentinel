import { vi } from 'vitest';
import * as fakeIndexedDB from 'fake-indexeddb';

type Handler = (event: any) => void;

type WorkerState = 'parsed' | 'installing' | 'installed' | 'activating' | 'activated' | 'redundant';

/** How a window client other than the page under test treats the worker's token requests. */
export type OtherClientKind = 'silent' | 'unavailable';

const ORIGIN = 'https://app.example.com';

const IDB_INTERFACES = [
  'IDBCursor',
  'IDBCursorWithValue',
  'IDBDatabase',
  'IDBFactory',
  'IDBIndex',
  'IDBKeyRange',
  'IDBObjectStore',
  'IDBOpenDBRequest',
  'IDBRequest',
  'IDBTransaction',
  'IDBVersionChangeEvent',
] as const;

interface FakeClient {
  id: string;
  type: 'window';
  postMessage(data: unknown, ports?: MessagePort[]): void;
}

/** One evaluated copy of sw.ts, seen by the page as a ServiceWorker. */
class FakeWorker {
  state: WorkerState = 'parsed';
  handlers = new Map<string, Handler[]>();
  skipWaitingFlag = false;
  private readonly stateListeners = new Set<Handler>();

  constructor(
    readonly scriptURL: string,
    private readonly runtime: FakeServiceWorkerRuntime
  ) {}

  postMessage(data: unknown, transfer: MessagePort[] = []): void {
    this.runtime.deliverToWorker(this, data, transfer);
  }

  addEventListener(type: string, listener: Handler): void {
    if (type === 'statechange') this.stateListeners.add(listener);
  }

  removeEventListener(type: string, listener: Handler): void {
    if (type === 'statechange') this.stateListeners.delete(listener);
  }

  setState(state: WorkerState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) listener({ target: this });
  }
}

interface FakeRegistration {
  scope: string;
  installing: FakeWorker | null;
  waiting: FakeWorker | null;
  active: FakeWorker | null;
  unregister(): Promise<boolean>;
  update(): Promise<void>;
}

/**
 * Just enough of a browser's service worker machinery to run the real
 * page-side API (register.ts / client.ts) against the real sw.ts.
 *
 * What it models faithfully, because the bugs live there:
 * - Each worker is a separate module instance of sw.ts. `restart()`
 *   evaluates the active worker's script again in a fresh module graph, the
 *   way a browser does after terminating an idle worker: install/activate do
 *   NOT run again, module memory is gone, IndexedDB and Cache Storage
 *   survive, and `self.location` is the registered script URL.
 * - The update lifecycle. register() with the newest worker's URL resolves
 *   with the existing registration and installs nothing. Any other URL
 *   resolves with `registration.installing` set while the old worker stays
 *   active and keeps controlling the page; the new worker then moves through
 *   installed, activating and activated on later tasks, with statechange
 *   events. It waits behind an active worker unless it called skipWaiting().
 *   Activation hands already-controlled clients to the new worker
 *   (controllerchange); clients.claim() takes uncontrolled ones.
 * - Fetches from the page go to its controller, or straight to the network
 *   when the page is uncontrolled.
 * - postMessage structured-clones its payload in both directions, and the
 *   worker receives it as an ExtendableMessageEvent whose waitUntil promises
 *   are collected (see `idle()`).
 * - Several window clients. The page under test runs the real library;
 *   `addClient()` adds tabs that never answer token requests (an older
 *   library) or answer TOKEN_UNAVAILABLE.
 * - The worker global has the full IndexedDB interface set, not just the
 *   `indexedDB` factory: the idb library does instanceof checks against them.
 * - Upstream answers 401 unless the request carries the valid bearer token.
 *
 * Not modelled: the `self` global belongs to the most recently evaluated
 * worker, so an old worker still running code reaches the new one's scope.
 * clients.claim() therefore claims for whichever worker is active.
 */
export class FakeServiceWorkerRuntime {
  readonly upstream: Request[] = [];
  readonly toPage: unknown[] = [];
  readonly toWorker: unknown[] = [];
  idbOpens = 0;
  validToken = 'tok-valid';

  private readonly idb = this.countingIDBFactory();
  private readonly cacheStore = new Map<string, Map<string, Response>>();
  private pageHandlers = new Map<string, Set<Handler>>();
  private scope = '/';
  private registration: FakeRegistration | null = null;
  private controller: FakeWorker | null = null;
  private jobs: Promise<unknown> = Promise.resolve();
  private readonly pendingWork = new Set<Promise<unknown>>();
  private readonly pageClient: FakeClient = {
    id: 'page-1',
    type: 'window',
    postMessage: (data: unknown, ports: MessagePort[] = []) => {
      this.toPage.push(structuredClone(data));
      const event = { data: structuredClone(data), ports };
      queueMicrotask(() => this.pageHandlers.get('message')?.forEach((h) => h(event)));
    },
  };
  private readonly windowClients: FakeClient[] = [this.pageClient];

  /** Install page-side globals. Call before importing register.ts/client.ts. */
  installPageGlobals(): void {
    vi.stubGlobal('navigator', { serviceWorker: this.serviceWorkerContainer() });
  }

  /** Script URL of the newest worker: the one the next update check compares against. */
  get registeredScriptURL(): string | null {
    return this.newestWorker()?.scriptURL ?? null;
  }

  get activeScriptURL(): string | null {
    return this.registration?.active?.scriptURL ?? null;
  }

  get controllerScriptURL(): string | null {
    return this.controller?.scriptURL ?? null;
  }

  /** Add another tab on the origin, in front of the page under test unless `at` says otherwise. */
  addClient(kind: OtherClientKind, at: 'front' | 'back' = 'front'): void {
    const client: FakeClient = {
      id: `other-${this.windowClients.length}`,
      type: 'window',
      postMessage: (data: unknown, ports: MessagePort[] = []) => {
        const type = (data as { type?: string }).type;
        if (kind === 'unavailable' && (type === 'REQUEST_TOKEN' || type === 'REFRESH_TOKEN')) {
          ports[0]?.postMessage({ type: 'TOKEN_UNAVAILABLE' });
        }
      },
    };
    if (at === 'front') this.windowClients.unshift(client);
    else this.windowClients.push(client);
  }

  /** Simulate the browser terminating the idle worker and waking it for an event. */
  async restart(): Promise<void> {
    const worker = this.registration?.active;
    if (!worker) throw new Error('nothing registered');
    await this.evaluateScript(worker);
  }

  /**
   * The browser's periodic update check found new bytes at the registered
   * URL: install a fresh worker from the same URL. Resolves once it is active.
   */
  async updateCheck(): Promise<void> {
    const url = this.registeredScriptURL;
    if (!url) throw new Error('nothing registered');
    const worker = await this.runJob<FakeWorker>((resolve) => this.install(url, resolve));
    await this.whenState(worker, 'activated');
  }

  /** Resolves once every waitUntil promise from messages posted to workers so far has settled. */
  async idle(): Promise<void> {
    await nextTask();
    while (this.pendingWork.size > 0) await Promise.allSettled([...this.pendingWork]);
  }

  /** Dispatch a fetch event the way a controlled page's subresource request would. */
  async fetch(url: string): Promise<Response> {
    const request = new Request(url);
    const worker = this.controller;
    if (!worker) return globalThis.fetch(request);
    let responded: Promise<Response> | undefined;
    this.dispatch(worker, 'fetch', {
      request,
      respondWith: (r: Response | Promise<Response>) => {
        responded = Promise.resolve(r);
      },
      waitUntil: () => {},
    });
    if (!responded) return globalThis.fetch(request);
    return responded;
  }

  /**
   * Post a message to the page the way the worker does and collect what the
   * page posts back on the port. Resolves once the first reply has arrived
   * and every reply racing it in the same turn is in (so a duplicate listener
   * still shows up as a second reply), or with nothing after `timeoutMs`.
   */
  async askPage(message: unknown, timeoutMs = 2000): Promise<unknown[]> {
    const replies: unknown[] = [];
    let firstReply!: () => void;
    const replied = new Promise<void>((resolve) => (firstReply = resolve));
    const port = {
      postMessage: (data: unknown) => {
        replies.push(structuredClone(data));
        firstReply();
      },
    } as unknown as MessagePort;
    this.pageClient.postMessage(message, [port]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([replied, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return replies;
  }

  lastUpstreamAuth(): string | null {
    return this.upstream[this.upstream.length - 1]?.headers.get('authorization') ?? null;
  }

  seedCache(name: string): void {
    this.cacheStore.set(name, this.cacheStore.get(name) ?? new Map());
  }

  get cacheNames(): string[] {
    return [...this.cacheStore.keys()];
  }

  /** Simulate a page reload: page module state is gone, the registration and its worker remain. */
  reloadPage(): void {
    this.pageHandlers = new Map();
  }

  deliverToWorker(worker: FakeWorker, data: unknown, transfer: MessagePort[]): void {
    this.toWorker.push(structuredClone(data));
    const event = {
      data: structuredClone(data),
      ports: transfer,
      source: this.pageClient,
      waitUntil: (promise: Promise<unknown>) => {
        const tracked = Promise.resolve(promise).finally(() => this.pendingWork.delete(tracked));
        this.pendingWork.add(tracked);
      },
    };
    queueMicrotask(() => this.dispatch(worker, 'message', event));
  }

  private newestWorker(): FakeWorker | null {
    const reg = this.registration;
    return reg ? reg.installing ?? reg.waiting ?? reg.active : null;
  }

  /** Jobs run one at a time, like the browser's per-scope job queue. */
  private runJob<T>(job: (resolve: (value: T) => void) => Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs = this.jobs.then(() => job(resolve)).catch(reject);
    });
  }

  private async install(url: string, resolve: (worker: FakeWorker) => void): Promise<void> {
    const reg = (this.registration ??= {
      scope: new URL(this.scope, ORIGIN).href,
      installing: null,
      waiting: null,
      active: null,
      unregister: async () => true,
      update: () => this.updateCheck(),
    });
    const worker = new FakeWorker(url, this);
    await this.evaluateScript(worker);
    reg.installing = worker;
    worker.setState('installing');
    resolve(worker);

    await nextTask();
    await this.dispatchExtendable(worker, 'install');
    reg.installing = null;
    reg.waiting = worker;
    worker.setState('installed');
    void this.tryActivate();
  }

  private async tryActivate(): Promise<void> {
    const reg = this.registration!;
    const worker = reg.waiting;
    const activating = () => reg.active?.state === 'activating';
    if (!worker || activating()) return;
    if (reg.active && !worker.skipWaitingFlag) return;

    await nextTask();
    if (reg.waiting !== worker || activating()) return;
    reg.active?.setState('redundant');
    reg.active = worker;
    reg.waiting = null;
    worker.setState('activating');
    if (this.controller) this.setController(worker);
    await this.dispatchExtendable(worker, 'activate');
    worker.setState('activated');
    await this.tryActivate();
  }

  private setController(worker: FakeWorker): void {
    if (this.controller === worker) return;
    this.controller = worker;
    this.pageHandlers.get('controllerchange')?.forEach((h) => h({}));
  }

  private whenState(worker: FakeWorker, state: WorkerState): Promise<void> {
    if (worker.state === state) return Promise.resolve();
    return new Promise((resolve) => {
      worker.addEventListener('statechange', function onChange() {
        if (worker.state !== state) return;
        worker.removeEventListener('statechange', onChange);
        resolve();
      });
    });
  }

  private async evaluateScript(worker: FakeWorker): Promise<void> {
    worker.handlers = new Map();
    vi.resetModules();
    vi.stubGlobal('indexedDB', this.idb);
    for (const name of IDB_INTERFACES) vi.stubGlobal(name, fakeIndexedDB[name]);
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
    vi.stubGlobal('self', this.workerGlobalScope(worker));
    await import('../sw.js');
  }

  private dispatch(worker: FakeWorker, type: string, event: any): void {
    for (const h of worker.handlers.get(type) ?? []) h(event);
  }

  private async dispatchExtendable(worker: FakeWorker, type: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    this.dispatch(worker, type, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  }

  private workerGlobalScope(worker: FakeWorker) {
    return {
      location: new URL(worker.scriptURL),
      registration: { scope: new URL(this.scope, ORIGIN).href },
      addEventListener: (type: string, handler: Handler) => {
        const list = worker.handlers.get(type) ?? [];
        list.push(handler);
        worker.handlers.set(type, list);
      },
      skipWaiting: async () => {
        worker.skipWaitingFlag = true;
        void this.tryActivate();
      },
      clients: {
        matchAll: async (options: { type?: string } = {}) =>
          this.controller
            ? this.windowClients.filter((c) => !options.type || options.type === 'all' || c.type === options.type)
            : [],
        // Claims for the registration's active worker, whichever copy of the
        // script calls it: see "Not modelled" above.
        claim: async () => {
          const active = this.registration?.active;
          if (active) this.setController(active);
        },
      },
    };
  }

  private serviceWorkerContainer() {
    const self = this;
    return {
      get controller() {
        return self.controller;
      },
      register(path: string, options: { scope?: string; type?: string } = {}) {
        const url = new URL(path, ORIGIN).href;
        return self.runJob<FakeRegistration>(async (resolve) => {
          self.scope = options.scope ?? '/';
          if (self.registration && self.newestWorker()?.scriptURL === url) {
            resolve(self.registration);
            return;
          }
          await self.install(url, () => resolve(self.registration!));
        });
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

  private countingIDBFactory(): IDBFactory {
    const factory = new fakeIndexedDB.IDBFactory();
    const open = factory.open.bind(factory);
    factory.open = (name: string, version?: number) => {
      this.idbOpens++;
      return open(name, version);
    };
    return factory;
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

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
