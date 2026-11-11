export const DEFAULT_COMFY_SERVICE_URL = 'http://127.0.0.1:8188';

export function drawingConfig(config) {
  const missing = config.serviceUrl == null || typeof config.serviceUrl === 'string' && !config.serviceUrl.trim();
  return { ...config, serviceUrl: missing ? DEFAULT_COMFY_SERVICE_URL : config.serviceUrl };
}
