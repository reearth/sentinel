import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  debugDebug,
  debugError,
  debugLog,
  debugWarn,
  configure,
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
