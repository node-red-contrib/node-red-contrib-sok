'use strict';

module.exports = function registerSokBatteryDeviceNode(RED) {
  const loadLibrary = async () => import('../dist/index.js');

  function SokBatteryDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.bluetooth = config.bluetooth || 'auto';
    node.namePrefix = config.namePrefix || 'SK';
    node.targetMode = config.targetMode || 'all';
    node.deviceName = config.deviceName || '';
    node.queue = Promise.resolve();

    node.loadLibrary = loadLibrary;

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

  const permission = RED.auth?.needsPermission ? RED.auth.needsPermission('flows.read') : (_req, _res, next) => next();
  RED.httpAdmin.get('/sok-battery/devices', permission, async (req, res) => {
    try {
      const sok = await loadLibrary();
      const devices = await sok.discoverBatteries({
        bluetooth: normalizeBluetooth(req.query.bluetooth),
        namePrefix: typeof req.query.namePrefix === 'string' && req.query.namePrefix ? req.query.namePrefix : 'SK'
      });
      res.json(devices);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
};

function normalizeBluetooth(value) {
  return value === 'bluez' || value === 'noble' || value === 'auto' ? value : 'auto';
}
