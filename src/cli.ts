import { Command, Option } from 'commander';
import { setTimeout as delay } from 'node:timers/promises';

import { connectBatteryReaders, discoverBatteries, readBatteries, shutdownBluetooth, type BluetoothBackendName, type ReadOptions, type SokBatteryReader } from './index.js';

type Logger = (message: string) => void;

interface GlobalCliOptions {
  bluetooth: BluetoothBackendName;
  namePrefix: string;
  reads: string;
  debug?: boolean;
}

interface GetCliOptions extends GlobalCliOptions {
  interval?: string;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  installSignalCleanup();

  const program = new Command();
  program
    .name('sok-battery')
    .description('Discover and read SOK smart batteries over Bluetooth LE.')
    .showHelpAfterError();
  addSharedOptions(program);

  addSharedOptions(
    program
      .command('discover')
      .description('Discover SOK batteries.')
  ).action(async (options: Partial<GlobalCliOptions>, command: Command) => {
    const globals = globalOptions(command, options);
    const result = await discoverBatteries({
      bluetooth: globals.bluetooth,
      namePrefix: globals.namePrefix,
      logger: loggerFor(globals)
    });
    await writeJson(result);
  });

  addSharedOptions(
    program
      .command('get')
      .description('Read one exact SOK battery by advertised name, or all discovered SOK batteries.')
      .argument('[deviceName]', 'exact advertised BLE device name')
      .option('--interval <seconds>', 'read repeatedly every N seconds using persistent BLE sessions')
  ).action(async (deviceName: string | undefined, options: Partial<GetCliOptions>, command: Command) => {
    const globals = globalOptions(command, options);
    const intervalMs = parseIntervalMs(options.interval);
    if (intervalMs === null) {
      const result = await readBatteries(toReadOptions(globals, deviceName));
      await writeJson(result);
      return;
    }

    await readAtInterval(globals, deviceName, intervalMs);
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    await shutdownBluetooth();
  }
}

export function parseIntervalMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--interval must be a number greater than 0 seconds.');
  return seconds * 1000;
}

export function toReadOptions(globals: GlobalCliOptions, deviceName?: string): ReadOptions {
  return {
    bluetooth: globals.bluetooth,
    namePrefix: globals.namePrefix,
    reads: globals.reads,
    deviceName: deviceName || undefined,
    logger: loggerFor(globals)
  };
}

function addSharedOptions(command: Command): Command {
  return command
    .addOption(new Option('--bluetooth <backend>', 'Bluetooth backend').choices(['auto', 'bluez', 'noble']).default('auto'))
    .option('--name-prefix <prefix>', 'SOK BLE advertised name prefix', 'SK')
    .option('--reads <reads>', 'comma-separated register groups to read', 'telemetry,limits,status')
    .option('--debug', 'print Bluetooth/protocol diagnostics to stderr');
}

function globalOptions(command: Command, options: Partial<GlobalCliOptions>): GlobalCliOptions {
  return {
    bluetooth: optionValue(command, options, 'bluetooth', 'auto'),
    namePrefix: optionValue(command, options, 'namePrefix', 'SK'),
    reads: optionValue(command, options, 'reads', 'telemetry,limits,status'),
    debug: optionValue(command, options, 'debug', false)
  };
}

function optionValue<K extends keyof GlobalCliOptions>(command: Command, options: Partial<GlobalCliOptions>, name: K, fallback: NonNullable<GlobalCliOptions[K]>): NonNullable<GlobalCliOptions[K]> {
  const parentOptions = command.parent?.opts<Partial<GlobalCliOptions>>() || {};
  const localSource = command.getOptionValueSource(name);
  if (localSource === 'default' && parentOptions[name] !== undefined) return parentOptions[name] as NonNullable<GlobalCliOptions[K]>;
  return (options[name] ?? fallback) as NonNullable<GlobalCliOptions[K]>;
}

function loggerFor({ debug }: GlobalCliOptions): Logger {
  return debug ? (message) => process.stderr.write(`[sok-debug] ${message}\n`) : () => {};
}

async function writeJson(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

async function readAtInterval(globals: GlobalCliOptions, deviceName: string | undefined, intervalMs: number): Promise<void> {
  const readers = await connectBatteryReaders(toReadOptions(globals, deviceName));
  if (readers.length === 0) {
    await writeJson([]);
    return;
  }

  try {
    while (true) {
      await writeJson(await readPersistentReaders(readers));
      await delay(intervalMs);
    }
  } finally {
    await Promise.all(readers.map((reader) => reader.disconnect().catch(() => {})));
  }
}

async function readPersistentReaders(readers: SokBatteryReader[]) {
  const readings = [];
  for (const reader of readers) readings.push(await reader.read());
  return readings;
}

function installSignalCleanup(): void {
  let shuttingDown = false;
  const handler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownBluetooth();
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}
