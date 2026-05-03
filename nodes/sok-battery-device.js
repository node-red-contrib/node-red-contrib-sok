'use strict';

module.exports = function registerSokBatteryDeviceNode(RED) {
  function SokBatteryDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.bluetooth = config.bluetooth || 'auto';
    node.namePrefix = config.namePrefix || 'SK';
    node.address = config.address || '';
    node.debugEnabled = !!config.debug;
    node.queue = Promise.resolve();

    node.logDebug = (message) => {
      if (node.debugEnabled) node.debug(`[sok-debug] ${message}`);
    };

    node.loadLibrary = async () => require('../lib');

    node.enqueue = async (operation) => {
      const run = node.queue.then(async () => {
        const sok = await node.loadLibrary();
        return operation(sok);
      });
      node.queue = run.catch(() => {});
      return run;
    };

    node.on('close', (_removed, done) => {
      node.loadLibrary()
        .then((sok) => sok.shutdownBluetooth())
        .catch(() => {})
        .finally(done);
    });
  }

  RED.nodes.registerType('sok-battery-device', SokBatteryDeviceNode);
};
