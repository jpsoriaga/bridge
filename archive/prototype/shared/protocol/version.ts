export const BRIDGE_PROTOCOL_VERSION = '1.0.0';
export const MIN_SUPPORTED_PROTOCOL_VERSION = '1.0.0';

export function isProtocolCompatible(version: string): boolean {
  const [major] = version.split('.');
  const [currentMajor] = BRIDGE_PROTOCOL_VERSION.split('.');
  return major === currentMajor;
}
