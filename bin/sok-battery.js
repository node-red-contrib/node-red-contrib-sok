#!/usr/bin/env node
'use strict';

const { readBattery } = require('../lib');

async function main() {
  const command = process.argv[2] || 'read';
  if (command !== 'read') {
    throw new Error(`Unknown command "${command}".`);
  }

  const options = {};
  for (let index = 3; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === '--bluetooth') options.bluetooth = process.argv[++index];
    else if (arg === '--address') options.address = process.argv[++index];
    else if (arg === '--name-prefix') options.namePrefix = process.argv[++index];
    else if (arg === '--reads') options.reads = process.argv[++index];
    else if (arg === '--debug') options.logger = (message) => console.error(message);
    else throw new Error(`Unknown option "${arg}".`);
  }

  const result = await readBattery(options);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
