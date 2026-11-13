import net from 'node:net';

/**
 * The application is configured for browsers on the developer's machine:
 * http://localhost:3000 (web), :8080 (gateway), :8081 (Keycloak). Those URLs
 * are part of token issuers and redirect URIs.
 *
 * When the tests run inside the Playwright container (TITAN_E2E_FORWARD=1),
 * "localhost" is the container itself, so plain TCP forwarders expose the
 * same three ports there and relay to the compose services. The browser then
 * uses exactly the URLs a person would.
 */
const FORWARDS: Array<[number, string, number]> = [
  [3000, 'web', 8080],
  [8080, 'gateway', 3000],
  [8081, 'keycloak', 8080],
];

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.TITAN_E2E_FORWARD !== '1') return async () => undefined;
  const servers = await Promise.all(
    FORWARDS.map(
      ([port, host, target]) =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer((client) => {
            const upstream = net.connect(target, host);
            client.pipe(upstream).pipe(client);
            const close = () => {
              client.destroy();
              upstream.destroy();
            };
            client.on('error', close);
            upstream.on('error', close);
          });
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => resolve(server));
        }),
    ),
  );
  return async () => {
    for (const s of servers) s.close();
  };
}
