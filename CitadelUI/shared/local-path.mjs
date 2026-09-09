export function validateLocalPath(value) {
  const path = String(value || '').trim();
  if (!path) throw new Error('Local path is required.');
  if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(path)) {
    throw new Error('Local path must be an absolute Windows, UNC, or POSIX path.');
  }
  return path;
}

export function localPathMatchesHandle(localPath, handleName) {
  const parts = String(localPath).replace(/[\\/]+$/, '').split(/[\\/]/);
  const leaf = parts.at(-1) || '';
  return leaf.localeCompare(String(handleName || ''), undefined, { sensitivity: 'accent' }) === 0;
}

export function localChildDisplayPath(parent, name) {
  const path = validateLocalPath(parent);
  const destination = `${path.replace(/[\\/]+$/, '')}${path.includes('\\') ? '\\' : '/'}${name}`;
  if (destination.length > 1024 || /[\u0000-\u001f\u007f]/.test(destination)) {
    throw new Error('The complete display-only destination must be at most 1024 characters and contain no control characters.');
  }
  return destination;
}
