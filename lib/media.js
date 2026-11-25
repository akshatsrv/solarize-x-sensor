import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const types = new Map([
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
]);
export const mediaType = name => types.get(extname(name).toLowerCase());
export const maxUploadBytes = 100 * 1024 * 1024;

export async function storeUpload(req, file) {
  const expected = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > maxUploadBytes) {
    throw new Error('Select a file up to 100 MB.');
  }
  let size = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > expected) return callback(new Error('Upload exceeds its declared size.'));
      callback(null, chunk);
    },
  });
  await pipeline(req, limit, createWriteStream(file, { flags: 'wx' }));
  if (size !== expected) throw new Error('The upload was incomplete.');
  return size;
}

export async function serveMedia(req, res, file, type) {
  const { size } = await stat(file);
  return serveMediaStream(req, res, size, type, (start, end) => createReadStream(file, { start, end }));
}

export function serveMediaStream(req, res, size, type, stream) {
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400, immutable',
  };
  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match?.[1]) start = Number(match[1]);
    else if (match?.[2]) start = Math.max(0, size - Number(match[2]));
    if (match?.[1] && match[2]) end = Math.min(Number(match[2]), size - 1);
    if (!match || (!match[1] && !match[2]) || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD' || !size) return res.end();
  const source = stream(start, end);
  res.once('close', () => source.destroy());
  source.on('error', () => res.destroy()).pipe(res);
}
