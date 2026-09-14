/**
 * Download and unpack a release archive. ZIP input waits for pending output writes
 * after each chunk; tar archives use a stream pipeline.
 */
import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { chmod, open, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Unzip, UnzipInflate } from 'fflate';
import { extract } from 'tar-stream';

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number | null) => void;
  signal?: AbortSignal;
}

export async function downloadFile(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: options.signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  let done = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      options.onProgress?.(done, total);
      callback(null, chunk);
    },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(dest));
}

/** Rejects paths that would escape `destDir`; returns the absolute target path. */
function safeTarget(destDir: string, entryName: string, stripComponents: number): string | null {
  const parts = entryName.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.some((part) => part === '..') || isAbsolute(entryName)) throw new Error(`unsafe archive entry: ${entryName}`);
  const kept = parts.slice(stripComponents);
  if (kept.length === 0) return null;
  const target = normalize(join(destDir, ...kept));
  if (!target.startsWith(normalize(destDir) + sep) && target !== normalize(destDir)) throw new Error(`unsafe archive entry: ${entryName}`);
  return target;
}

export async function extractArchive(
  file: string,
  format: 'zip' | 'tgz',
  destDir: string,
  stripComponents: number,
): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  if (format === 'zip') await extractZip(file, destDir, stripComponents);
  else await extractTgz(file, destDir, stripComponents);
}

async function extractZip(file: string, destDir: string, stripComponents: number): Promise<void> {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  let failure: Error | null = null;
  /** Output files with bytes still in flight; the read loop waits for them after every chunk. */
  const active = new Set<{ out: WriteStream; done: Promise<void> }>();
  unzip.onfile = (entry) => {
    if (entry.name.endsWith('/')) return;
    const target = safeTarget(destDir, entry.name, stripComponents);
    if (!target) return;
    mkdirSync(dirname(target), { recursive: true });
    const out = createWriteStream(target);
    const file = {
      out,
      done: new Promise<void>((resolve, reject) => out.once('finish', resolve).once('error', reject)),
    };
    active.add(file);
    entry.ondata = (err, data, final) => {
      if (err) {
        failure = err;
        out.destroy(err);
        return;
      }
      if (data.length) out.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      if (final) out.end();
    };
    entry.start();
  };
  /**
   * Check current writableNeedDrain before waiting for drain.
   * An ended stream is awaited through its completion promise, since drain may no longer fire.
   */
  const settle = async (): Promise<void> => {
    for (const file of [...active]) {
      if (file.out.writableEnded) {
        await file.done;
        active.delete(file);
      } else if (file.out.writableNeedDrain) {
        await new Promise<void>((resolve) => file.out.once('drain', () => resolve()));
      }
    }
  };
  const handle = await open(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      unzip.push(new Uint8Array(chunk.subarray(0, bytesRead)), false);
      if (failure) throw failure;
      await settle();
    }
    unzip.push(new Uint8Array(0), true);
  } finally {
    await handle.close();
  }
  if (failure) throw failure;
  await Promise.all([...active].map((file) => file.done));
}

async function extractTgz(file: string, destDir: string, stripComponents: number): Promise<void> {
  const tar = extract();
  const links: Array<{ target: string; linkname: string }> = [];
  tar.on('entry', (header, stream, next) => {
    void (async () => {
      const target = safeTarget(destDir, header.name, stripComponents);
      if (!target) {
        stream.resume();
        return;
      }
      if (header.type === 'directory') {
        mkdirSync(target, { recursive: true });
        stream.resume();
      } else if (header.type === 'symlink' && header.linkname) {
        links.push({ target, linkname: header.linkname });
        stream.resume();
      } else if (header.type === 'file') {
        mkdirSync(dirname(target), { recursive: true });
        await pipeline(stream, createWriteStream(target));
        if (header.mode !== undefined && process.platform !== 'win32') await chmod(target, header.mode & 0o777);
      } else stream.resume();
    })().then(() => next(), next);
  });
  await pipeline(createReadStream(file), createGunzip(), tar);
  for (const link of links) {
    mkdirSync(dirname(link.target), { recursive: true });
    await symlink(link.linkname, link.target).catch(() => undefined);
  }
}
