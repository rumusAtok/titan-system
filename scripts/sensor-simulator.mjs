// Synthetic sensor simulator for any registered device.
//
// Publishes REAL MQTT messages (QoS 1) for the registered devices of one
// tenant. Each device gets readings for exactly the sensors it was registered
// with (flood monitoring stations, machine condition monitors, ...).
// All values are generated; no real measurement data is involved.
//
//   node scripts/sensor-simulator.mjs                       normal conditions, runs until stopped
//   node scripts/sensor-simulator.mjs --scenario flood --duration 120
//   node scripts/sensor-simulator.mjs --user maya.admin --scenario fault --duration 120 --fault-device MER-MCM-001
//   node scripts/sensor-simulator.mjs --user dana.duty      another tenant
//
// Options:
//   --user <username>        demo user whose tenant is simulated (default derek.duty)
//   --scenario <name>        normal | flood | storm | fault    (default normal)
//   --interval <seconds>     seconds between readings          (default 2)
//   --duration <seconds>     stop after this long; 0 = forever (default 0)
//   --devices <serials>      comma-separated serial numbers    (default: all)
//   --flood-device <serial>  device that floods in `flood`     (default: first device with a water-level sensor)
//   --fault-device <serial>  machine that degrades in `fault`  (default: first device with a vibration sensor)
//   --silent <serial>        device that publishes nothing (to demonstrate offline detection)
import mqtt from 'mqtt';
import { api, claimsOf, config, sleep, tokenFor, waitFor } from './lib/titan-client.mjs';

const SCENARIOS = ['normal', 'flood', 'storm', 'fault'];

function parseArgs(argv) {
  const args = { user: 'derek.duty', scenario: 'normal', interval: 2, duration: 0, devices: null, 'flood-device': null, 'fault-device': null, silent: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown option ${argv[i]}`);
    args[key] = argv[++i];
  }
  args.interval = Number(args.interval);
  args.duration = Number(args.duration);
  if (!SCENARIOS.includes(args.scenario)) throw new Error(`unknown scenario ${args.scenario}`);
  return args;
}

const round = (v, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const noise = (amplitude) => (Math.random() - 0.5) * 2 * amplitude;

/** 0 -> 1 over the first 60% of the run, back to 0 over the rest. */
function surge(t, duration) {
  const span = duration > 0 ? duration : 180;
  const progress = Math.min(1, t / span);
  return progress < 0.6 ? progress / 0.6 : Math.max(0, 1 - (progress - 0.6) / 0.4);
}

/**
 * Water level (m) and rainfall (mm/h) at `t` seconds into the run.
 * `flood`: one device rises past the warning (3.5 m) and critical (4.5 m)
 * thresholds over the first 60% of the run, then recedes.
 */
export function reading(scenario, t, duration, index, floods) {
  // Baselines cycle through four levels so that, however many devices exist,
  // "normal" conditions stay well below the 3.5 m warning threshold.
  const base = 1.6 + (index % 4) * 0.25;
  const tide = 0.15 * Math.sin((t / 120) * 2 * Math.PI + index);
  let level = base + tide + noise(0.03);
  let rain = Math.max(0, 2 + noise(2));

  if (scenario === 'storm') {
    rain = 55 + noise(10);
    level += 0.6 + noise(0.05);
  }
  if (scenario === 'flood' && floods) {
    const peak = 5.3;
    const shape = surge(t, duration);
    level = base + (peak - base) * shape + noise(0.03);
    rain = 20 + 70 * shape + noise(5);
  }
  return { water_level: round(Math.max(0, level)), rainfall: round(Math.max(0, rain), 1) };
}

/**
 * Machine condition at `t` seconds: vibration velocity (mm/s RMS), bearing
 * temperature (degC) and spindle load (%). `fault`: one machine's vibration
 * climbs past the default warning (7.1) and critical (11.2) levels and its
 * bearing past 85 degC, then recovers.
 */
export function machineReading(scenario, t, duration, index, faulty) {
  let vibration = 2.2 + (index % 4) * 0.3 + noise(0.2);
  let temperature = 55 + (index % 3) * 2 + noise(1.5);
  const load = 60 + 15 * Math.sin((t / 90) * 2 * Math.PI + index) + noise(3);
  if (scenario === 'fault' && faulty) {
    const shape = surge(t, duration);
    vibration = 2.5 + (13 - 2.5) * shape + noise(0.2);
    temperature = 56 + (94 - 56) * shape + noise(1);
  }
  return { vibration_rms: round(Math.max(0, vibration)), bearing_temperature: round(temperature, 1), spindle_load: round(Math.min(150, Math.max(0, load)), 1) };
}

/** Value for one sensor of a device; null when the simulator has no model for the kind and no range to fall back on. */
export function valueFor(sensor, generated) {
  if (sensor.kind in generated) return generated[sensor.kind];
  if (sensor.min_valid !== null && sensor.max_valid !== null) {
    const middle = (sensor.min_valid + sensor.max_valid) / 2;
    return round(middle + noise((sensor.max_valid - sensor.min_valid) * 0.02));
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await waitFor(() => tokenFor(args.user), { timeoutMs: 120_000, intervalMs: 3_000, what: 'identity provider' });
  const tenantId = claimsOf(token).tenant_id;

  let devices = await waitFor(
    async () => {
      const all = (await api(args.user, 'GET', '/api/device/devices?limit=500')).filter((d) => d.status !== 'decommissioned');
      return all.length ? all : null;
    },
    { timeoutMs: 300_000, intervalMs: 5_000, what: 'registered devices (run `npm run seed` first)' },
  );
  if (args.devices) {
    const wanted = new Set(args.devices.split(','));
    devices = devices.filter((d) => wanted.has(d.serial_no));
  }
  if (devices.length === 0) throw new Error('no matching devices');
  const has = (device, kind) => device.sensors.some((s) => s.kind === kind);
  const floodSerial = args['flood-device'] ?? devices.find((d) => has(d, 'water_level'))?.serial_no ?? null;
  const faultSerial = args['fault-device'] ?? devices.find((d) => has(d, 'vibration_rms'))?.serial_no ?? null;

  const client = await mqtt.connectAsync(config.mqttUrl, {
    clientId: `sensor-simulator-${process.pid}-${Date.now()}`,
    username: config.mqttUser,
    password: config.mqttPassword,
    reconnectPeriod: 2_000,
  });
  console.log(`simulator: tenant ${tenantId}, scenario ${args.scenario}, ${devices.length} device(s), every ${args.interval}s -> ${config.mqttUrl}`);
  console.log('simulator: SYNTHETIC data only');

  let stopping = false;
  process.on('SIGINT', () => (stopping = true));
  process.on('SIGTERM', () => (stopping = true));

  const started = Date.now();
  let seq = 0;
  let published = 0;
  while (!stopping) {
    const t = (Date.now() - started) / 1000;
    if (args.duration > 0 && t >= args.duration) break;
    seq += 1;
    const observedAt = new Date().toISOString();
    const lines = [];
    for (const [index, device] of devices.entries()) {
      if (device.serial_no === args.silent) continue;
      const generated = {
        ...reading(args.scenario, t, args.duration, index, device.serial_no === floodSerial),
        ...machineReading(args.scenario, t, args.duration, index, device.serial_no === faultSerial),
        battery: round(12.6 - (t / 3600) * 0.05 + noise(0.02)),
      };
      const readings = device.sensors.flatMap((s) => {
        const value = valueFor(s, generated);
        return value === null ? [] : [{ sensor: s.kind, value }];
      });
      if (readings.length === 0) continue;
      const message = { message_id: `${device.serial_no}-${started}-${seq}`, observed_at: observedAt, readings };
      // QoS 1: the broker acknowledges each message; a lost connection leads to a resend.
      await client.publishAsync(`titan/${tenantId}/devices/${device.id}/telemetry`, JSON.stringify(message), { qos: 1 });
      published += 1;
      lines.push(`${device.serial_no}=${readings[0].value}${device.sensors.find((s) => s.kind === readings[0].sensor)?.unit ?? ''}`);
    }
    if (seq % 5 === 1) console.log(`simulator: t=${Math.round(t)}s ${lines.join(' ')}`);
    await sleep(args.interval * 1000);
  }
  await client.endAsync();
  console.log(`simulator: stopped after publishing ${published} message(s)`);
}

// Run only when executed directly (the module is also imported by tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((err) => {
    console.error(`simulator: ${err.message}`);
    process.exit(1);
  });
}
