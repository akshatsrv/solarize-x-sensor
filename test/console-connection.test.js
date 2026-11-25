import assert from 'node:assert/strict';
import { test } from 'node:test';
import connection from '../admin-desktop/connection.cjs';

const { serverOrigin, connectionInput } = connection;

test('the console accepts HTTPS servers and local HTTP demo addresses', () => {
  assert.equal(serverOrigin(' https://signage.example.com/ '), 'https://signage.example.com');
  assert.equal(serverOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(serverOrigin('http://[::1]:8080'), 'http://[::1]:8080');
  assert.throws(() => serverOrigin('http://192.168.1.25:8080'), /HTTPS/);
});

test('the connection form rejects navigation paths and embedded credentials', () => {
  for (const address of ['https://user:pass@signage.example.com', 'https://signage.example.com/#fleet', 'https://signage.example.com/subdomain']) {
    assert.throws(() => serverOrigin(address), /server address/);
  }
  assert.throws(() => connectionInput({ address: 'https://signage.example.com', username: 'admin' }), /password/);
});
