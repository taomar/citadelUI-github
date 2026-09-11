const decoderOptions = { fatal: true, ignoreBOM: true };

function encodingError() {
  return Object.assign(
    new Error('Source must be valid UTF-8. Unsupported encoding was refused before editing; no source bytes were changed.'),
    { code: 'SOURCE_ENCODING_UNSUPPORTED' }
  );
}

export function hasUtf8Bom(bytes) {
  return bytes?.[0] === 0xef && bytes?.[1] === 0xbb && bytes?.[2] === 0xbf;
}

/** Keep the transport marker out of parser offsets, but retain it for writing. */
export function decodeSourceBytes(bytes) {
  const bom = hasUtf8Bom(bytes);
  try {
    return { text: new TextDecoder('utf-8', decoderOptions).decode(bom ? bytes.subarray(3) : bytes), bom };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw encodingError();
  }
}

export function encodeSourceText(text, source = {}) {
  if (typeof text !== 'string') throw encodingError();
  const bom = source.bom ?? hasUtf8Bom(source.bytes);
  const value = `${bom ? '\uFEFF' : ''}${text}`;
  const bytes = new TextEncoder().encode(value);
  // TextEncoder replaces unpaired UTF-16 surrogates; that is not a source edit.
  if (new TextDecoder('utf-8', decoderOptions).decode(bytes) !== value) throw encodingError();
  return bytes;
}
