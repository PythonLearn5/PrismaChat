import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type {
  ApiProvider,
  AppConfig,
  CustomModel,
  AIClient,
  GoogleGenAIClient,
  ModelOption,
  OpenAIClient,
} from '@/types';

// --- Configuration & Types ---

export type AIProviderConfig = {
  provider: ApiProvider;
  apiKey?: string;
  baseUrl?: string;
  targetBaseUrl?: string;
  proxyMode?: ApiProxyMode;
  defaultHeaders?: Record<string, string>;
};

type ApiEnv = {
  VITE_API_KEY?: string;
  GEMINI_API_KEY?: string;
  VITE_API_PROXY_MODE?: string;
  VITE_VERCEL_AI_API_KEY?: string;
  VITE_VERCEL_AI_BASE_URL?: string;
  VITE_VERCEL_AI_MODELS?: string;
};

type ApiProxyMode = 'direct' | 'local';

// --- Provider Detection ---

export const isGoogleProvider = (ai: AIClient | unknown): ai is GoogleGenAIClient => {
  return (
    typeof ai === 'object' &&
    ai !== null &&
    'models' in ai &&
    typeof (ai as GoogleGenAIClient).models?.generateContent === 'function'
  );
};

// --- Custom Fetch (per-instance, not global) ---

/**
 * Creates a custom fetch function scoped to a specific base URL.
 * Only handles API version prefix deduplication as a safety net.
 * URL routing is handled by SDK-level options (httpOptions.baseUrl / baseURL).
 */
const createCustomFetch = (
  baseUrl: string | null,
  proxyMode: ApiProxyMode,
): typeof globalThis.fetch => {
  const nativeFetch = window.fetch.bind(window);
  const cleanBaseUrl = baseUrl?.replace(/\/+$/, '') ?? null;

  const cloneRequestWithUrl = (request: Request, url: string): Request => {
    const method = request.method;
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : request.body,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
    };

    if (init.body) {
      init.duplex = 'half';
    }

    return new Request(url, init);
  };

  const createProxyInit = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    targetOrigin: string,
  ): RequestInit => {
    const request = input instanceof Request ? input : null;
    const method = init?.method ?? request?.method;
    const headers = new Headers(request?.headers);

    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.set('X-Target-URL', targetOrigin);

    return {
      ...init,
      method,
      headers,
      body:
        init?.body ??
        (request && !['GET', 'HEAD'].includes(method ?? request.method) ? request.body : undefined),
      cache: init?.cache ?? request?.cache,
      credentials: init?.credentials ?? request?.credentials,
      integrity: init?.integrity ?? request?.integrity,
      keepalive: init?.keepalive ?? request?.keepalive,
      mode: init?.mode ?? request?.mode,
      redirect: init?.redirect ?? request?.redirect,
      referrer: init?.referrer ?? request?.referrer,
      signal: init?.signal ?? request?.signal,
    };
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let urlString: string;
    let requestInput: RequestInfo | URL = input;
    if (typeof input === 'string') {
      urlString = input;
    } else if (input instanceof URL) {
      urlString = input.toString();
    } else {
      urlString = input.url;
    }

    // Safety: deduplicate API version prefix (e.g., /v1beta/v1beta -> /v1beta).
    // Some Google SDK versions may double-append version prefixes when httpOptions.baseUrl includes one.
    if (cleanBaseUrl) {
      try {
        const baseHost = new URL(cleanBaseUrl).host;
        if (baseHost && urlString.includes(baseHost)) {
          const url = new URL(urlString);
          const basePath = new URL(cleanBaseUrl).pathname.replace(/\/$/, '');
          const versionPrefix = basePath.match(/\/v\d+(beta|alpha)?$/)?.[0];
          if (versionPrefix && url.pathname.includes(versionPrefix + versionPrefix)) {
            url.pathname = url.pathname.replace(versionPrefix + versionPrefix, versionPrefix);
            urlString = url.toString();
            requestInput =
              input instanceof Request
                ? cloneRequestWithUrl(input, urlString)
                : input instanceof URL
                  ? url
                  : urlString;
          }
        }
      } catch {
        /* ignore URL parse errors */
      }
    }

    if (proxyMode === 'local') {
      try {
        const url = new URL(urlString, window.location.href);
        const isHttpApiRequest = url.protocol === 'https:' || url.protocol === 'http:';
        const isExternalRequest = url.origin !== window.location.origin;

        if (isHttpApiRequest && isExternalRequest) {
          const proxyUrl = `/custom-api${url.pathname}${url.search}`;
          return nativeFetch(proxyUrl, createProxyInit(input, init, url.origin));
        }
      } catch {
        /* fall through to the native request */
      }
    }

    return nativeFetch(requestInput, init);
  };
};

// --- Helper Functions ---

export const findCustomModel = (
  modelName: string,
  customModels?: CustomModel[],
): CustomModel | undefined => {
  return customModels?.find((m) => m.name === modelName);
};

export const resolveApiKey = (
  explicitApiKey?: string,
  _env: ApiEnv = import.meta.env,
): string | undefined => {
  return explicitApiKey;
};

export const resolveApiProxyMode = (env: ApiEnv = import.meta.env): ApiProxyMode => {
  return env.VITE_API_PROXY_MODE === 'local' ? 'local' : 'direct';
};

const VERCEL_AI_DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

export const getVercelAIEnv = (env: ApiEnv = import.meta.env) => {
  const apiKey = env.VITE_VERCEL_AI_API_KEY;
  const upstreamBaseUrl = env.VITE_VERCEL_AI_BASE_URL || VERCEL_AI_DEFAULT_BASE_URL;
  const modelsRaw = env.VITE_VERCEL_AI_MODELS;
  const models: Array<{ id: string; name: string; displayName?: string }> = [];
  if (modelsRaw) {
    modelsRaw.split(',').forEach((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return;
      const parts = trimmed.split('|');
      const id = parts[0].trim();
      const displayName = parts[1]?.trim() || undefined;
      if (id) {
        models.push({ id, name: id, displayName });
      }
    });
  }

  const isTestEnv =
    (typeof import.meta !== 'undefined' &&
      (typeof (import.meta as unknown as { vitest?: unknown }).vitest !== 'undefined' ||
        import.meta.env?.MODE === 'test')) ||
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test');

  const isBrowser = typeof window !== 'undefined';
  const hasEnvConfig = Boolean(apiKey && !isTestEnv);

  const baseUrl = upstreamBaseUrl;
  const defaultHeaders: Record<string, string> | undefined = undefined;
  const targetBaseUrl = isBrowser ? upstreamBaseUrl : undefined;

  return { apiKey, baseUrl, targetBaseUrl, defaultHeaders, models, enabled: hasEnvConfig };
};

export const getVercelNormalizedModelId = (modelName: string): string => {
  if (modelName.startsWith('vercel/')) {
    return modelName.slice('vercel/'.length);
  }
  return modelName;
};

const getVercelModelConfig = (
  modelName: string,
  env: ApiEnv = import.meta.env,
): {
  apiKey: string;
  baseUrl: string;
  targetBaseUrl?: string;
  defaultHeaders?: Record<string, string>;
  normalizedModelId: string;
} | null => {
  const vercel = getVercelAIEnv(env);
  if (!vercel.enabled) return null;
  const isVercelModel =
    modelName.startsWith('vercel/') ||
    modelName.startsWith('vc-') ||
    vercel.models.some((m) => m.id === modelName || m.name === modelName);
  if (!isVercelModel) return null;
  const normalizedModelId = getVercelNormalizedModelId(modelName);
  return {
    apiKey: vercel.apiKey!,
    baseUrl: vercel.baseUrl,
    targetBaseUrl: vercel.targetBaseUrl,
    defaultHeaders: vercel.defaultHeaders,
    normalizedModelId,
  };
};

/**
 * Detect API provider from model name prefix.
 * Fallback when customModelConfig is unavailable.
 */
export const getAIProvider = (model: string): ApiProvider => {
  const openaiPrefixes = [
    'gpt-',
    'o1-',
    'o3-',
    'o4-',
    'deepseek-',
    'claude-',
    'grok-',
    'mistral-',
    'mixtral-',
    'qwen-',
    'yi-',
    'glm-',
    'vercel/',
    'vc-',
    'openai/',
    'anthropic/',
    'google/',
    'xai/',
    'cohere/',
    'perplexity/',
    'together/',
  ];
  if (openaiPrefixes.some((p) => model.startsWith(p))) return 'openai';
  if (model === 'custom') return 'openai';
  return 'google';
};

export const resolveModelApiConfig = (
  model: ModelOption,
  config: Pick<AppConfig, 'customModels'>,
): AIProviderConfig => {
  const customModelConfig = findCustomModel(model, config.customModels);
  const provider = customModelConfig?.provider || getAIProvider(model);

  const vercel = getVercelModelConfig(model);
  const effectiveApiKey = customModelConfig?.apiKey ?? vercel?.apiKey;
  const effectiveBaseUrl = customModelConfig?.baseUrl ?? vercel?.baseUrl;
  const effectiveTargetBaseUrl = vercel?.targetBaseUrl;
  const effectiveDefaultHeaders = vercel?.defaultHeaders;

  return {
    provider,
    ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
    ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
    ...(effectiveTargetBaseUrl ? { targetBaseUrl: effectiveTargetBaseUrl } : {}),
    ...(effectiveDefaultHeaders ? { defaultHeaders: effectiveDefaultHeaders } : {}),
  };
};

// --- API Client Factory ---

export const getAI = (config?: AIProviderConfig): AIClient => {
  const provider = config?.provider || 'google';
  const apiKey = resolveApiKey(config?.apiKey);
  const baseUrl = config?.baseUrl || null;
  const explicitProxyMode = config?.proxyMode;
  const baseProxyMode = resolveApiProxyMode();
  const hasExternalTarget = Boolean(config?.targetBaseUrl);
  const proxyMode: ApiProxyMode =
    explicitProxyMode !== undefined
      ? explicitProxyMode
      : hasExternalTarget && typeof window !== 'undefined'
        ? 'local'
        : baseProxyMode;
  const customFetch = createCustomFetch(baseUrl, proxyMode);

  // Handle OpenAI-compatible providers
  if (provider === 'openai') {
    const defaultHeaders = config?.defaultHeaders;
    const options: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: apiKey,
      dangerouslyAllowBrowser: true,
      fetch: customFetch,
      baseURL: baseUrl || 'https://api.openai.com/v1',
      ...(defaultHeaders ? { defaultHeaders } : {}),
    };

    return new OpenAI(options) as unknown as OpenAIClient;
  }

  // Handle Google — use httpOptions.baseUrl for custom endpoint support
  else {
    const options: ConstructorParameters<typeof GoogleGenAI>[0] & {
      fetch?: typeof globalThis.fetch;
      httpOptions: { baseUrl?: string };
    } = {
      apiKey: apiKey,
      fetch: customFetch,
      httpOptions: {},
    };

    // Strip trailing API version prefix (e.g. /v1beta) since the SDK adds it automatically
    if (baseUrl) {
      let cleanUrl = baseUrl.replace(/\/+$/, '');
      const versionMatch = cleanUrl.match(/\/(v\d+(?:alpha|beta)?)$/);
      if (versionMatch) {
        cleanUrl = cleanUrl.slice(0, -versionMatch[0].length);
      }
      options.httpOptions!.baseUrl = cleanUrl;
    }

    return new GoogleGenAI(options) as unknown as GoogleGenAIClient;
  }
};
