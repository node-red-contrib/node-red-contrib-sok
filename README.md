# node-red-contrib-sok

Simple first-pass Node-RED BLE reader for SOK smart batteries.

The current implementation targets the BLE protocol seen in `captures/SOK Batterie SK12V324PH00057.pklg`:

- advertised name: `SK12V314PH00057`
- service UUID: `fff0`
- notify characteristic: `fff1`
- write characteristic: `fff2`
- payload protocol: Modbus RTU read-holding-register frames over BLE notifications

## Nodes

- `sok-battery-device`: config node for the battery BLE target
- `sok-battery-get`: input node that reads `telemetry`, `limits`, and `status`

The output is placed in `msg.payload` and includes decoded fields, raw register maps, and raw Modbus response frames.

## CLI

```sh
npm install
npm run read -- --debug
```

Useful options:

```sh
node ./bin/sok-battery.js read --name-prefix SK --reads telemetry
node ./bin/sok-battery.js read --address 40:d6:3c:51:00:18
node ./bin/sok-battery.js read --bluetooth bluez --debug
```

Bluetooth backends:

- `auto`: uses BlueZ on Linux when available, otherwise noble
- `bluez`: uses Linux BlueZ over D-Bus, useful on devices where noble would require extra privileges
- `noble`: uses `@abandonware/noble`, useful for macOS smoke tests

This is deliberately small and capture-led. The next refactor can split BLE backends, extend the register map, and add richer Node-RED configuration once the live read is proven against the battery.
