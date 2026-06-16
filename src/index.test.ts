import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from './index.js';

function createServiceWorkerEnvironment(controlled = false) {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let serviceWorker: any;

  const dispatch = (type: string) => {
    const event = new Event(type);
    for (const listener of listeners.get(type) ?? []) {
      if (typeof listener === 'function') {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  };

  const postMessage = vi.fn((message: { type?: string }) => {
    if (message.type === 'CLAIM_CLIENTS') {
      serviceWorker.controller = activeWorker;
      dispatch('controllerchange');
    }
  });

  const activeWorker = {
    postMessage,
  } as unknown as ServiceWorker;

  const registration = {
    active: activeWorker,
    unregister: vi.fn().mockResolvedValue(true),
  } as unknown as ServiceWorkerRegistration;

  serviceWorker = {
    controller: controlled ? activeWorker : null,
    getRegistration: vi.fn().mockResolvedValue(registration),
    register: vi.fn().mockResolvedValue(registration),
    addEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        const current = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        current.add(listener);
        listeners.set(type, current);
      }
    ),
    removeEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener);
      }
    ),
  };

  vi.stubGlobal('navigator', { serviceWorker });

  return {
    postMessage,
    registration,
    serviceWorker,
  };
}

afterEach(async () => {
  await api.unregisterAssetSecurity();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('@reearth/sentinel public API', () => {
  it('exports the registration functions', () => {
    expect(typeof api.registerAssetSecurity).toBe('function');
    expect(typeof api.unregisterAssetSecurity).toBe('function');
  });

  it('exports the token + status functions', () => {
    expect(typeof api.updateToken).toBe('function');
    expect(typeof api.clearToken).toBe('function');
    expect(typeof api.getSecurityStatus).toBe('function');
  });

  it('asks an active service worker to claim clients when the page is uncontrolled', async () => {
    const { postMessage, serviceWorker } = createServiceWorkerEnvironment(false);

    await api.registerAssetSecurity({
      proxyUrl: 'https://proxy.example.com',
      protectedDomains: ['assets.example.com'],
    });

    expect(serviceWorker.controller).toBeTruthy();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CONFIG' })
    );
    expect(postMessage).toHaveBeenCalledWith({ type: 'CLAIM_CLIENTS' });
  });

  it('does not ask for client claiming when the page is already controlled', async () => {
    const { postMessage } = createServiceWorkerEnvironment(true);

    await api.registerAssetSecurity({
      proxyUrl: 'https://proxy.example.com',
      protectedDomains: ['assets.example.com'],
    });

    expect(
      postMessage.mock.calls.some(([message]) => message.type === 'CLAIM_CLIENTS')
    ).toBe(false);
  });
});

describe('@reearth/sentinel debug logging', () => {
  it('stays silent when debug is disabled', async () => {
    createServiceWorkerEnvironment(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await api.registerAssetSecurity({
      proxyUrl: 'https://proxy.example.com',
      protectedDomains: ['assets.example.com'],
    });
    await api.clearToken();

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('writes namespaced logs when debug is enabled', async () => {
    createServiceWorkerEnvironment(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await api.registerAssetSecurity({
      proxyUrl: 'https://proxy.example.com',
      protectedDomains: ['assets.example.com'],
      debug: true,
    });
    await api.clearToken();

    expect(
      log.mock.calls.some(
        ([first]) => typeof first === 'string' && first.startsWith('[AssetSecurity]')
      )
    ).toBe(true);
  });

  it('still logs unregistration before the config is torn down', async () => {
    createServiceWorkerEnvironment(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await api.registerAssetSecurity({
      proxyUrl: 'https://proxy.example.com',
      protectedDomains: ['assets.example.com'],
      debug: true,
    });
    log.mockClear();

    await api.unregisterAssetSecurity();

    expect(log).toHaveBeenCalledWith('[AssetSecurity] Service worker unregistered');
  });
});
