import assert from 'node:assert/strict';

import {
  azureProhibitedOverlap,
  Ipv4Cidr,
  isRecommendedPrivateSpace,
  microsoftAppProhibitedOverlap,
} from '../web/js/cidr.mjs';

const vnet = new Ipv4Cidr('10.170.0.0/24');
const first = new Ipv4Cidr('10.170.0.0/26');
const second = new Ipv4Cidr('10.170.0.64/26');

assert.equal(vnet.size, 256);
assert.equal(vnet.usableAddresses, 251);
assert.equal(first.usableAddresses, 59);
assert.equal(vnet.contains(first), true);
assert.equal(first.overlaps(second), false);
assert.equal(first.overlaps(new Ipv4Cidr('10.170.0.32/27')), true);

const noncanonical = new Ipv4Cidr('10.170.0.17/26');
assert.equal(noncanonical.isCanonical, false);
assert.equal(noncanonical.canonical, '10.170.0.0/26');

assert.throws(() => new Ipv4Cidr('10.170.0/24'), /IPv4 CIDR/);
assert.throws(() => new Ipv4Cidr('10.300.0.0/24'), /0 to 255/);
assert.throws(() => new Ipv4Cidr('10.0.0.0/33'), /0 to 32/);
assert.equal(isRecommendedPrivateSpace(vnet), true);
assert.equal(isRecommendedPrivateSpace(new Ipv4Cidr('203.0.113.0/24')), false);
assert.equal(
  azureProhibitedOverlap(new Ipv4Cidr('127.1.0.0/16')).canonical,
  '127.0.0.0/8'
);
assert.equal(
  microsoftAppProhibitedOverlap(new Ipv4Cidr('172.30.2.0/24')).canonical,
  '172.30.0.0/16'
);

console.log('IPv4 CIDR parsing, containment, overlap, and Azure range checks passed.');
