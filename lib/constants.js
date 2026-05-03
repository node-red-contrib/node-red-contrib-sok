'use strict';

const SOK = {
  advertisedNamePrefix: 'SK',
  serviceUuid: 'fff0',
  notifyUuid: 'fff1',
  writeUuid: 'fff2'
};

const READS = {
  telemetry: { name: 'telemetry', start: 0x0080, count: 0x007a },
  limits: { name: 'limits', start: 0x0401, count: 0x0031 },
  status: { name: 'status', start: 0x0902, count: 0x0001 }
};

module.exports = {
  READS,
  SOK
};
