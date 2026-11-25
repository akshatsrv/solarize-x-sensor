export function monitorServers(value, localUrl) {
  const entries = value ? JSON.parse(value) : [];
  if (!Array.isArray(entries) || entries.length > 25) throw new Error('SERVER_PEERS must contain up to 25 servers.');
  const seen = new Set(localUrl ? [localUrl] : []);
  const servers = entries.map(entry => {
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.origin) ||
        typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80) {
      throw new Error('Use distinct HTTPS server addresses and names in SERVER_PEERS.');
    }
    seen.add(url.origin);
    return { url: url.origin, name: entry.name.trim(), status: 'Checking' };
  });
  let running = false;
  async function check() {
    if (running) return;
    running = true;
    try {
      await Promise.all(servers.map(async server => {
        try {
          const res = await fetch(new URL('/readyz', server.url), { redirect: 'error', signal: AbortSignal.timeout(3000) });
          server.status = res.ok ? 'Online' : 'Unavailable';
          await res.body?.cancel();
        } catch {
          server.status = 'Unreachable';
        }
        server.checkedAt = Date.now();
      }));
    } finally {
      running = false;
    }
  }
  void check();
  const timer = servers.length ? setInterval(check, 15000).unref() : null;
  return { servers, stop() { clearInterval(timer); } };
}
