import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const certDir = path.join(rootDir, '.cert');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const sanRecordPath = path.join(certDir, 'san.txt');
const opensslConfPath = path.join(certDir, 'openssl.cnf');

function getLanIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        ips.push(entry.address);
      }
    }
  }
  return Array.from(new Set(ips)).sort();
}

const lanIps = getLanIpv4Addresses();
const sanEntries = [
  'DNS:localhost',
  'IP:127.0.0.1',
  ...lanIps.map((ip) => `IP:${ip}`),
];
const sanString = sanEntries.join(',');

const hasCertFiles = fs.existsSync(keyPath) && fs.existsSync(certPath);
const existingSan = fs.existsSync(sanRecordPath)
  ? fs.readFileSync(sanRecordPath, 'utf8').trim()
  : '';

if (!hasCertFiles || existingSan !== sanString) {
  fs.mkdirSync(certDir, { recursive: true });

  const altNamesLines = ['DNS.1 = localhost', 'IP.1 = 127.0.0.1'];
  lanIps.forEach((ip, idx) => {
    altNamesLines.push(`IP.${idx + 2} = ${ip}`);
  });

  const opensslConfig = `[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
CN = spi-camera-solver.local

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
${altNamesLines.join('\n')}
`;

  fs.writeFileSync(opensslConfPath, opensslConfig, 'utf8');

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-days',
      '365',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-config',
      opensslConfPath,
      '-extensions',
      'v3_req',
    ],
    { stdio: 'inherit' }
  );

  fs.writeFileSync(sanRecordPath, sanString, 'utf8');
  console.log('[ensure-cert] HTTPS用自己署名証明書を生成しました (.cert/)');
} else {
  console.log('[ensure-cert] 既存のHTTPS証明書を使用します (.cert/)');
}

if (lanIps.length > 0) {
  console.log('[ensure-cert] iPhone実機テスト用URL:');
  for (const ip of lanIps) {
    console.log(`  https://${ip}:5173`);
  }
} else {
  console.log('[ensure-cert] ローカルLAN IPが見つかりませんでした。https://localhost:5173 でアクセスしてください。');
}
