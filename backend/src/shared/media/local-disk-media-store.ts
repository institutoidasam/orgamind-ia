import { Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, normalize, isAbsolute, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { MediaStore } from './media-store.port';

// Server-generated keys only ever use these characters (e.g.
// `conv/<id>/<uuid>_thumb-2.jpg`). Whitelisting up front rejects anything
// exotic (spaces, NUL, unicode, shell metacharacters) before it can reach the
// filesystem, regardless of any future traversal cleverness.
const ALLOWED_KEY = /^[A-Za-z0-9._/-]+$/;

@Injectable()
export class LocalDiskMediaStore implements MediaStore {
  private readonly rootAbs: string;

  constructor(private readonly root: string) {
    this.rootAbs = resolve(root);
  }

  private resolve(key: string): string {
    if (!key || !ALLOWED_KEY.test(key)) {
      throw new Error(`Invalid media key: ${key}`);
    }
    const norm = normalize(key);
    if (isAbsolute(norm) || norm.startsWith('..')) {
      throw new Error(`Invalid media key: ${key}`);
    }
    const target = join(this.rootAbs, norm);
    // Final containment check: the resolved absolute path must live strictly
    // inside the root directory (anchored on the path separator so a sibling
    // like `<root>-evil` cannot pass the prefix test).
    if (target !== this.rootAbs && !target.startsWith(this.rootAbs + sep)) {
      throw new Error(`Invalid media key: ${key}`);
    }
    return target;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async getBuffer(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try { await access(this.resolve(key)); return true; } catch { return false; }
  }
}
