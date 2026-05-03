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
        node.status({ fill: 'yellow', shape: 'ring', text: 'reading' });
        const result = await node.device.enqueue((sok) =>
          sok.readBattery({
            bluetooth: node.device.bluetooth,
            namePrefix: node.device.namePrefix,
            address: node.device.address,
            reads,
            logger: (message) => node.device.logDebug(message)
          })
        );
        node.status({ fill: 'green', shape: 'dot', text: 'ok' });
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
    return { reads: Array.isArray(payload.reads) ? payload.reads.map(String).filter(Boolean) : splitReads(String(payload.reads)) };
  }
  return {};
}

function splitReads(value) {
  return String(value || '')
    .split(',')
    .map((read) => read.trim())
    .filter(Boolean);
}
