import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const [descriptorPath, keyPath, signaturePath, publicKeyPath] = process.argv.slice(2);
if (!descriptorPath || !keyPath || !signaturePath || !publicKeyPath) {
  throw new Error('Usage: node sign-release.mjs <descriptor> <private-key> <signature> <public-key>');
}

const descriptor = await readFile(descriptorPath);
const privateKey = createPrivateKey(await readFile(keyPath));
const publicKey = createPublicKey(privateKey);
const signature = sign(null, descriptor, privateKey);

await writeFile(signaturePath, `${signature.toString('base64')}\n`, { mode: 0o600 });
await writeFile(
  publicKeyPath,
  publicKey.export({ type: 'spki', format: 'pem' }),
  { mode: 0o644 }
);
