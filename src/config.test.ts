import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  debugDebug,
  debugError,
  debugLog,
  debugWarn,
  configure,
  isProtectedDomain,
} from './config.js';
import { toRuntimeConfig } from './runtime-config.js';

function runtime(debug: boolean) {
  return toRuntimeConfig({
    proxyUrl: 'https://proxy.example.com',
    protectedDomains: ['assets.example.com'],
    namespace: 'asset-security',
    debug,
  });
}

describe('service worker debug logging', () => {
  afterEach(() => {
    configure(null);
    vi.restoreAllMocks();
  });

  it('does not write to the console when debug is false', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    configure(runtime(false));
    debugLog('log message');
    debugDebug('debug message');
    debugWarn('warn message');
    debugError('error message');

    expect(log).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('writes to the console when debug is true', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    configure(runtime(true));
    vi.clearAllMocks();

    debugLog('log message');
    debugDebug('debug message');
    debugWarn('warn message');
    debugError('error message');

    expect(log).toHaveBeenCalledWith('log message');
    expect(debug).toHaveBeenCalledWith('debug message');
    expect(warn).toHaveBeenCalledWith('warn message');
    expect(error).toHaveBeenCalledWith('error message');
  });
});

describe('isProtectedDomain', () => {
  afterEach(() => {
    configure(null);
  });

  function protect(...protectedDomains: string[]) {
    configure(
      toRuntimeConfig({
        proxyUrl: 'https://proxy.example.com',
        protectedDomains,
        namespace: 'asset-security',
        debug: false,
      })
    );
  }

  it('matches the domain itself and its subdomains', () => {
    protect('tiles.example.com');

    expect(isProtectedDomain('https://tiles.example.com/imagery/1/2/3.png')).toBe(true);
    expect(isProtectedDomain('https://a.tiles.example.com/imagery/1/2/3.png')).toBe(true);
  });

  it.each([
    'https://tiles.example.com.attacker.net/imagery/1/2/3.png',
    'https://eviltiles.example.com/imagery/1/2/3.png',
    'https://attacker.net/tiles.example.com/1/2/3.png',
  ])('does not send the token to %s', (url) => {
    protect('tiles.example.com');

    expect(isProtectedDomain(url)).toBe(false);
  });

  it('a domain with a port matches only that host and port', () => {
    protect('localhost:8080');

    expect(isProtectedDomain('http://localhost:8080/imagery/1/2/3.png')).toBe(true);
    expect(isProtectedDomain('http://localhost:9090/imagery/1/2/3.png')).toBe(false);
    expect(isProtectedDomain('http://localhost.attacker.net:8080/imagery/1/2/3.png')).toBe(false);
  });
});
