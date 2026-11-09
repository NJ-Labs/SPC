/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_AI_API_URL?: string;
	readonly VITE_AI_API_KEY?: string;
	readonly VITE_AI_MODEL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

interface RuntimeAiConfig {
	API_URL?: string;
	API_KEY?: string;
	MODEL?: string;
}

interface RuntimeAppConfig {
	ENV?: string;
	FEATURES?: Record<string, unknown>;
	AI?: RuntimeAiConfig;
}

interface Window {
	APP_CONFIG?: RuntimeAppConfig;
}
