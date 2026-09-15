export function isRegionField(name) {
  return typeof name === 'string' && /location|region/i.test(name);
}
