// Prints the health of the local stack as reported by the API gateway.
//   node scripts/status.mjs        (also: ./scripts/titan.ps1 status)
// Exit code 0 when every critical service is ready, 1 otherwise.
import { api } from './lib/titan-client.mjs';

try {
  const health = await api('adam.admin', 'GET', '/api/platform/health');
  console.log(`Platform status: ${health.status}   (${health.environment}, checked ${health.checked_at})\n`);
  console.log(`${'SERVICE'.padEnd(26)}${'STATUS'.padEnd(14)}${'DATABASE'.padEnd(11)}${'BROKER'.padEnd(9)}${'CRITICAL'.padEnd(10)}PROBE`);
  for (const s of health.services) {
    console.log(
      `${s.service.padEnd(26)}${s.status.padEnd(14)}${(s.checks?.database ?? '-').padEnd(11)}${(s.checks?.broker ?? '-').padEnd(9)}${(s.critical ? 'yes' : 'no').padEnd(10)}${s.latency_ms === null ? '-' : `${s.latency_ms} ms`}`,
    );
  }
  const notRunning = health.services.filter((s) => s.status === 'unreachable').map((s) => s.service);
  if (notRunning.length) console.log(`\nNot running (their compose profile may not be started): ${notRunning.join(', ')}`);
  const criticalDown = health.services.filter((s) => s.critical && !['ok', 'degraded'].includes(s.status));
  if (criticalDown.length) {
    console.log(`\nCRITICAL services not ready: ${criticalDown.map((s) => s.service).join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll critical services are ready.');
} catch (err) {
  console.error(`The stack is not reachable: ${err.message}`);
  console.error('Is it running?  ./scripts/titan.ps1 up');
  process.exit(1);
}
