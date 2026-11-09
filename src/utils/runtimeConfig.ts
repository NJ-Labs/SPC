type RuntimeAiConfig = {
  API_URL?: string;
  API_KEY?: string;
  MODEL?: string;
};

type RuntimeAppConfig = {
  ENV?: string;
  FEATURES?: Record<string, unknown>;
  AI?: RuntimeAiConfig;
};

const getRuntimeAppConfig = (): RuntimeAppConfig | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.APP_CONFIG;
};

const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const getViteEnv = (): ImportMetaEnv | undefined => {
  if (typeof import.meta === 'undefined') {
    return undefined;
  }

  return import.meta.env;
};

export const resolveAiRuntimeConfig = () => {
  const runtimeConfig = getRuntimeAppConfig()?.AI;
  const viteEnv = getViteEnv();

  const apiUrl = asNonEmptyString(runtimeConfig?.API_URL)
    ?? asNonEmptyString(viteEnv?.VITE_AI_API_URL);
  const apiKey = asNonEmptyString(runtimeConfig?.API_KEY)
    ?? asNonEmptyString(viteEnv?.VITE_AI_API_KEY);
  const model = asNonEmptyString(runtimeConfig?.MODEL)
    ?? asNonEmptyString(viteEnv?.VITE_AI_MODEL);

  return {
    apiUrl,
    apiKey,
    model,
  };
};
