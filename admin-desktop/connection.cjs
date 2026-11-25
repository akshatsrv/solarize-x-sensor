function serverOrigin(value) {
  let url;
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter the full server address, including https://.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter only the server address, without credentials or a page path.');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS for a remote server. HTTP is available for this computer’s local demo.');
  }
  return url.origin;
}

function connectionInput(input) {
  const origin = serverOrigin(input?.address);
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = input.password;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(username) || typeof password !== 'string' || !password || password.length > 1024) {
    throw new Error('Enter your Smart Self Check username and password.');
  }
  return { origin, username, password };
}

module.exports = { serverOrigin, connectionInput };
