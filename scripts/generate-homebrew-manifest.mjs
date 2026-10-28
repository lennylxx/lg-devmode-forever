#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const appInfo = JSON.parse(readFileSync('app/appinfo.json', 'utf8'));
const expectedIpk = `${appInfo.id}_${appInfo.version}_all.ipk`;
const ipkPath = resolve(process.argv[2] || expectedIpk);
const outputPath = resolve(process.argv[3] || `${appInfo.id}.manifest.json`);

if (basename(ipkPath) !== expectedIpk) {
  throw new Error(`Expected IPK filename ${expectedIpk}, received ${basename(ipkPath)}`);
}

const manifest = {
  id: appInfo.id,
  version: appInfo.version,
  type: appInfo.type,
  title: appInfo.title,
  appDescription: appInfo.appDescription,
  iconUri: 'https://raw.githubusercontent.com/lennylxx/lg-devmode-forever/main/app/icon.png',
  sourceUrl: 'https://github.com/lennylxx/lg-devmode-forever',
  rootRequired: false,
  ipkUrl: basename(ipkPath),
  ipkHash: {
    sha256: createHash('sha256').update(readFileSync(ipkPath)).digest('hex'),
  },
};

writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Generated ${basename(outputPath)} for ${basename(ipkPath)}`);
