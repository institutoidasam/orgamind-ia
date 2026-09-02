import type { Readable } from 'node:stream';

export const MEDIA_STORE = Symbol.for('MEDIA_STORE');

export interface MediaStore {
  /** Persist bytes under a relative key (e.g. "conv/<id>/<messageId>.jpg"). */
  put(key: string, data: Buffer): Promise<void>;
  /** Read the full object into memory (small media). */
  getBuffer(key: string): Promise<Buffer>;
  /** Stream the object for serving. */
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
}
