import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from 'node:https';

// Synthetic one-day certificates, generated only in a disposable test directory.
// Trust is supplied to each test client, never installed in the operating system.
export function testTls({ expired = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'citadel-auth-v5-8ea0cc0f-'));
  const run = (...args) => {
    const result = spawnSync('openssl', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`Test certificate generation failed: ${result.stderr}`);
    }
  };
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-subj', '/CN=Citadel TEST ONLY root', '-days', '1');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
  writeFileSync(join(directory, 'extensions.cnf'), 'subjectAltName=DNS:localhost,DNS:identity.localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
  if (expired) {
    writeFileSync(join(directory, 'index.txt'), '');
    writeFileSync(join(directory, 'serial'), '1000\n');
    writeFileSync(join(directory, 'issuer.cnf'), '[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=1\npolicy=subject\nx509_extensions=server\n[subject]\ncommonName=supplied\n[server]\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
    run('ca', '-batch', '-config', 'issuer.cnf', '-in', 'server.csr', '-out', 'server.pem',
      '-startdate', '20240101000000Z', '-enddate', '20240102000000Z', '-notext');
  } else {
    run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'server.pem', '-days', '1', '-extfile', 'extensions.cnf');
  }
  return {
    directory, ca: readFileSync(join(directory, 'ca.pem')), cert: readFileSync(join(directory, 'server.pem')),
    key: readFileSync(join(directory, 'server.key')),
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function httpsTestRequest(server, tls, { path = '/', method = 'GET', headers = {}, body, ca = tls.ca, host = 'localhost' } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: host, servername: host, port, path, method, ca, rejectUnauthorized: true,
      lookup: (_hostname, options, done) => options.all
        ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4),
      headers: { Host: 'localhost', ...headers } }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(parts).toString('utf8'),
        json: () => JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
