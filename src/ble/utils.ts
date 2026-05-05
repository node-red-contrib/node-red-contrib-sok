import { SOK } from '../constants.js';
import type { SokDiscoveredDevice } from './backend.js';

export function normalizeUuid(uuid: string | null | undefined): string {
  const compact = String(uuid || '').toLowerCase().replaceAll('-', '');
  if (compact.length === 32 && compact.startsWith('0000') && compact.endsWith('00001000800000805f9b34fb')) return compact.slice(4, 8);
  return compact;
}

export function formatCanonicalUuid(uuid: string): string {
  const compact = normalizeUuid(uuid);
  if (compact.length === 4) return `0000${compact}-0000-1000-8000-00805f9b34fb`;
  if (compact.length !== 32) return uuid.toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function matchesSokDevice(
  candidate: { name?: string | null; address?: string | null; serviceUuids?: string[] | null },
  {
    namePrefix = SOK.advertisedNamePrefix,
    deviceName = null,
    serviceUuid = SOK.serviceUuid
  }: {
    namePrefix?: string;
    deviceName?: string | null;
    serviceUuid?: string | null;
  } = {}
): boolean {
  const name = candidate.name || '';
  if (deviceName) return name === deviceName;
  if (name.startsWith(namePrefix)) return true;

  if (!serviceUuid) return false;
  const expectedServiceUuid = normalizeUuid(serviceUuid);
  return (candidate.serviceUuids || []).some((uuid) => normalizeUuid(uuid) === expectedServiceUuid);
}

export function uniqueDevices(devices: SokDiscoveredDevice[]): SokDiscoveredDevice[] {
  const byKey = new Map<string, SokDiscoveredDevice>();
  for (const device of devices) {
    const key = device.name || device.address || `${device.backend}:${device.id}`;
    const existing = byKey.get(key);
    if (!existing || (device.rssi ?? -999) > (existing.rssi ?? -999)) byKey.set(key, device);
  }
  return [...byKey.values()].sort((left, right) => displayDevice(left).localeCompare(displayDevice(right)));
}

export function displayDevice(device: SokDiscoveredDevice): string {
  return device.name || device.address || device.id;
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function unboxBluezValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) return (value as { value: unknown }).value;
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
