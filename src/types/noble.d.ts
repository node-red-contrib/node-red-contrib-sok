declare module '@abandonware/noble' {
  import type { EventEmitter } from 'node:events';

  export interface NobleAdvertisement {
    localName?: string;
    serviceUuids?: string[];
  }

  export interface NobleCharacteristic extends EventEmitter {
    uuid: string;
    properties?: string[];
    read(callback: (error: Error | null, data: Buffer) => void): void;
    write(data: Buffer, withoutResponse: boolean, callback: (error: Error | null) => void): void;
    subscribe(callback: (error: Error | null) => void): void;
  }

  export interface NoblePeripheral extends EventEmitter {
    id: string;
    uuid?: string;
    address?: string;
    addressType?: string;
    advertisement?: NobleAdvertisement;
    rssi?: number;
    state?: 'connected' | 'connecting' | 'disconnected' | string;
    connectable?: boolean;
    connect(callback?: (error?: Error | string | null) => void): void;
    disconnect(callback?: (error?: Error | null) => void): void;
    cancelConnect?(): void;
    discoverAllServicesAndCharacteristics(callback: (error: Error | null, services: unknown[], characteristics: NobleCharacteristic[]) => void): void;
  }

  export interface Noble extends EventEmitter {
    state: string;
    _bindings?: {
      cancelConnect?: (...args: unknown[]) => unknown;
      disconnect?: (id: string) => unknown;
    };
    startScanning(serviceUuids: string[], allowDuplicates: boolean, callback?: (error?: Error) => void): void;
    stopScanning(): void;
  }

  const noble: Noble;
  export default noble;
}
