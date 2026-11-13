export interface TitanConfig {
  gatewayUrl: string;
  keycloakUrl: string;
  realm: string;
  clientId: string;
  environment: string;
  mapTileUrl: string;
}

declare global {
  interface Window {
    __TITAN_CONFIG__?: Partial<TitanConfig>;
  }
}

const DEFAULTS: TitanConfig = {
  gatewayUrl: 'http://localhost:8080',
  keycloakUrl: 'http://localhost:8081',
  realm: 'titan',
  clientId: 'titan-web',
  environment: 'local-development',
  mapTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};

/** Runtime configuration injected by /config.js (never baked into the bundle). */
export function getConfig(): TitanConfig {
  if (typeof window === 'undefined') return DEFAULTS;
  return { ...DEFAULTS, ...(window.__TITAN_CONFIG__ ?? {}) };
}
