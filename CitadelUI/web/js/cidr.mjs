const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function formatAddress(value) {
  const address = Number(value) >>> 0;
  return [
    (address >>> 24) & 255,
    (address >>> 16) & 255,
    (address >>> 8) & 255,
    address & 255,
  ].join('.');
}

export class Ipv4Cidr {
  constructor(value) {
    const input = String(value || '').trim();
    const match = IPV4_CIDR.exec(input);
    if (!match) throw new Error('Use IPv4 CIDR notation, for example 10.170.0.0/24.');
    const octets = match.slice(1, 5).map(Number);
    const prefix = Number(match[5]);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      throw new Error('Every IPv4 octet must be from 0 to 255.');
    }
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new Error('The IPv4 prefix length must be from 0 to 32.');
    }

    const address =
      (((octets[0] << 24) >>> 0) +
        (octets[1] << 16) +
        (octets[2] << 8) +
        octets[3]) >>>
      0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (address & mask) >>> 0;
    const size = 2 ** (32 - prefix);

    this.input = input;
    this.address = address;
    this.prefix = prefix;
    this.network = network;
    this.last = network + size - 1;
    this.size = size;
    this.usableAddresses = Math.max(0, size - 5);
    this.canonical = `${formatAddress(network)}/${prefix}`;
    this.isCanonical = input === this.canonical;
  }

  contains(other) {
    return this.network <= other.network && this.last >= other.last;
  }

  overlaps(other) {
    return this.network <= other.last && other.network <= this.last;
  }

  toString() {
    return this.canonical;
  }
}

export const AZURE_PROHIBITED_CIDRS = Object.freeze([
  '224.0.0.0/4',
  '255.255.255.255/32',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '168.63.129.16/32',
]);

export const AZURE_PRIVATE_CIDRS = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
]);

export const MICROSOFT_APP_PROHIBITED_CIDRS = Object.freeze([
  '169.254.0.0/16',
  '172.30.0.0/16',
  '172.31.0.0/16',
  '192.0.2.0/24',
  '100.100.0.0/17',
  '100.100.128.0/19',
  '100.100.160.0/19',
  '100.100.192.0/19',
]);

const parsedAzureProhibited = AZURE_PROHIBITED_CIDRS.map((value) => new Ipv4Cidr(value));
const parsedPrivate = AZURE_PRIVATE_CIDRS.map((value) => new Ipv4Cidr(value));
const parsedMicrosoftAppProhibited =
  MICROSOFT_APP_PROHIBITED_CIDRS.map((value) => new Ipv4Cidr(value));

export function firstOverlap(cidr, ranges = parsedAzureProhibited) {
  const index = ranges.findIndex((range) => cidr.overlaps(range));
  return index < 0 ? null : ranges[index];
}

export function azureProhibitedOverlap(cidr) {
  return firstOverlap(cidr, parsedAzureProhibited);
}

export function microsoftAppProhibitedOverlap(cidr) {
  return firstOverlap(cidr, parsedMicrosoftAppProhibited);
}

export function isRecommendedPrivateSpace(cidr) {
  return parsedPrivate.some((range) => range.contains(cidr));
}
