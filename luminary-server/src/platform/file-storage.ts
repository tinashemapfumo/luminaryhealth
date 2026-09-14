import { createReadStream } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, resolve, sep } from 'node:path';
import { config } from './config.js';

const root = resolve(config.clientFileStoragePath);
const insideRoot = (absolute: string) => absolute === root || absolute.startsWith(`${root}${sep}`);

export interface StoredFile {
  storageKey: string;
  checksum: string;
}

export async function storePatientFile(input: {
  practiceId: string;
  patientId: string;
  originalName: string;
  bytes: Buffer;
}): Promise<StoredFile> {
  const safeName = basename(input.originalName).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
  const storageKey = [
    input.practiceId,
    input.patientId,
    `${new Date().toISOString().slice(0, 10)}-${randomUUID()}-${safeName}`,
  ].join('/');
  const absolute = resolve(root, storageKey);

  if (!insideRoot(absolute)) {
    throw new Error('Resolved upload path escaped the storage root');
  }

  await mkdir(resolve(root, input.practiceId, input.patientId), { recursive: true });
  await writeFile(absolute, input.bytes, { flag: 'wx' });

  return {
    storageKey,
    checksum: createHash('sha256').update(input.bytes).digest('hex'),
  };
}

export async function patientFileStream(storageKey: string) {
  const absolute = resolve(root, storageKey);
  if (!insideRoot(absolute)) {
    throw new Error('Resolved download path escaped the storage root');
  }
  await access(absolute);
  return createReadStream(absolute);
}

export async function removePatientFile(storageKey: string): Promise<void> {
  const absolute = resolve(root, storageKey);
  if (!insideRoot(absolute)) {
    throw new Error('Resolved cleanup path escaped the storage root');
  }
  await unlink(absolute);
}
