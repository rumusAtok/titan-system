// Runtime configuration. In the container this file is rewritten at start
// from environment variables (see infrastructure/docker/web/15-titan-config.envsh),
// so one image works in every environment.
window.__TITAN_CONFIG__ = {
  gatewayUrl: 'http://localhost:8080',
  keycloakUrl: 'http://localhost:8081',
  realm: 'titan',
  clientId: 'titan-web',
  environment: 'local-development',
  mapTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};
