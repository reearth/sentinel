import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  debugDebug,
  debugError,
  debugLog,
  debugWarn,
  updateConfig,
} from './config.js';

describe('service worker debug logging', () => {
  afterEach(() => {
    updateConfig({ debug: false });
    vi.restoreAllMocks();
  });

  it('does not write to the console when debug is false', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    updateConfig({ debug: false });
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

    updateConfig({
      debug: true,
      protectedDomains: ['assets.example.com'],
      api: {
        tokenEndpoint: '/api/auth/token',
        refreshEndpoint: '/api/auth/refresh',
        proxyEndpoint: 'https://proxy.example.com',
      },
    });
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
