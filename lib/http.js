import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

export function matches(actual, expected) {
  const a = Buffer.from(actual ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  let body = '';
  for await (const chunk of req.setEncoding('utf8')) {
    body += chunk;
    if (body.length > 8192) throw new Error('Request exceeds the size limit');
  }
  const value = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('Expected a JSON object');
  }
  return value;
}

export async function asset(res, name, type) {
  const body = await readFile(new URL(`../public/${name}`, import.meta.url));
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function integer(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Expected an integer from ${min} to ${max}, got ${value}`);
  }
  return number;
}
