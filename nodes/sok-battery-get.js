'use strict';

module.exports = function registerSokBatteryGetNode(RED) {
  function SokBatteryGetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.device = RED.nodes.getNode(config.device);
    node.reads = splitReads(config.reads || 'telemetry,limits,status');

    node.on('input', async (msg, send, done) => {
      const emit = send || ((message) => node.send(message));
      try {
        if (!node.device) throw new Error('SOK battery device node is not configured.');
        const override = normalizePayload(msg.payload);
        const reads = override.reads || node.reads;
        const deviceName = override.deviceName || (node.device.targetMode === 'name' ? node.device.deviceName : undefined);
        node.status({ fill: 'yellow', shape: 'ring', text: 'reading' });
        const result = await node.device.enqueue((sok) =>
          sok.readBatteries({
            bluetooth: node.device.bluetooth,
            namePrefix: node.device.namePrefix,
            deviceName,
            reads
          })
        );
        node.status({ fill: 'green', shape: 'dot', text: `${result.length} found` });
        msg.payload = result;
        emit(msg);
        done?.();
      } catch (error) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        done ? done(error) : node.error(error, msg);
      }
    });
  }

  RED.nodes.registerType('sok-battery-get', SokBatteryGetNode);
};

function normalizePayload(payload) {
  if (Array.isArray(payload)) return { reads: payload.map(String).filter(Boolean) };
  if (typeof payload === 'string') return { reads: splitReads(payload) };
  if (payload && typeof payload === 'object' && payload.reads !== undefined) {
    return {
      reads: Array.isArray(payload.reads) ? payload.reads.map(String).filter(Boolean) : splitReads(String(payload.reads)),
      deviceName: typeof payload.deviceName === 'string' && payload.deviceName ? payload.deviceName : undefined
    };
  }
  if (payload && typeof payload === 'object' && typeof payload.deviceName === 'string') {
    return { deviceName: payload.deviceName };
  }
  return {};
}

function splitReads(value) {
  return String(value || '')
    .split(',')
    .map((read) => read.trim())
    .filter(Boolean);
}
