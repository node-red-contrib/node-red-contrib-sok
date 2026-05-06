# node-red-contrib-sok

Strict TypeScript Node.js library, CLI, and Node-RED nodes for SOK smart batteries over BLE.

The current implementation targets the BLE protocol seen in `captures/SOK Batterie SK12V324PH00057.pklg`:

- advertised name: `SK12V314XXXXXXX`
- service UUID: `fff0`
- notify characteristic: `fff1`
- write characteristic: `fff2`
- payload protocol: Modbus RTU read-holding-register frames over BLE notifications

## Library

The package exports a typed ESM API from `dist/index.js`:

- `discoverBatteries(options)` returns matching BLE devices
- `readBatteries(options)` discovers and reads zero, one, or many devices
- `readBatteryDevice(device, options)` reads one discovered device
- `connectBatteryReaders(options)` discovers and connects once, then returns persistent readers with `read()` and `disconnect()`
- `shutdownBluetooth()` stops active BLE sessions

Read output is always an array at the CLI and Node-RED layer. Each reading contains compact device metadata, a timestamp, and decoded data. Raw register maps and Modbus frames are not included in public JSON output.

For repeated reads, keep the BLE session open and only issue new register requests:

```js
import { connectBatteryReaders } from 'node-red-contrib-sok';

const readers = await connectBatteryReaders({
  deviceName: 'SK12V314XXXXXXX',
  reads: 'telemetry'
});

try {
  const reading = await readers[0].read();
  console.log(reading.decoded);
} finally {
  await Promise.all(readers.map((reader) => reader.disconnect()));
}
```

## Nodes

- `sok-battery-device`: config node for the battery BLE target
- `sok-battery-get`: input node that reads `telemetry`, `limits`, and `status`

Use the config node's search button to discover SOK batteries from the Node-RED editor. Select one exact advertised device name, or keep "All discovered devices".

The output is placed in `msg.payload` as an array with zero, one, or multiple readings.

## CLI

```sh
npm install
npm run build
npm run discover
npm run get
```

Useful options:

```sh
node ./bin/sok-battery.js discover --name-prefix SK
node ./bin/sok-battery.js get --reads telemetry
node ./bin/sok-battery.js get SK12V314XXXXXXX
node ./bin/sok-battery.js get SK12V314XXXXXXX --interval 5
node ./bin/sok-battery.js get --bluetooth bluez --debug
```

`get --interval 5` keeps the BLE session open and reads every five seconds until stopped.

Bluetooth backends:

- `auto`: uses BlueZ on Linux when available, otherwise noble
- `bluez`: uses Linux BlueZ over D-Bus, useful on devices where noble would require extra privileges
- `noble`: uses `@abandonware/noble`, useful for macOS smoke tests

## Development

```sh
npm run build
npm run lint
npm test
npm run check
```
