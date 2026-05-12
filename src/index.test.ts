import { describe, expect, it } from 'vitest';
import * as api from './index.js';

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
});
