import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAiRuntimeConfig } from './runtimeConfig';

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.APP_CONFIG;
});

describe('browser AI configuration', () => {
  it('does not use upstream AI environment variables in the browser', () => {
    vi.stubEnv('AI_API_KEY', 'private-upstream-key');
    vi.stubEnv('AI_API_URL', 'https://upstream.example/v1');
    vi.stubEnv('AI_MODEL', 'upstream-model');
    expect(resolveAiRuntimeConfig()).toEqual({ apiKey: undefined, apiUrl: undefined, model: undefined });
  });

  it('supports explicit direct-browser VITE settings', () => {
    vi.stubEnv('VITE_AI_API_KEY', 'browser-token');
    vi.stubEnv('VITE_AI_API_URL', 'https://direct.example');
    vi.stubEnv('VITE_AI_MODEL', 'model');
    expect(resolveAiRuntimeConfig()).toEqual({ apiKey: 'browser-token', apiUrl: 'https://direct.example', model: 'model' });
  });

  it('uses the gateway runtime config ahead of direct-browser fallback', () => {
    vi.stubEnv('VITE_AI_API_URL', 'https://direct.example');
    window.APP_CONFIG = { AI: { API_URL: '/', API_KEY: 'gateway-token', MODEL: 'model' } };
    expect(resolveAiRuntimeConfig()).toEqual({ apiKey: 'gateway-token', apiUrl: '/', model: 'model' });
  });
});
