import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';

/** Drive Express with Node HTTP message objects without opening a listener.
 * Used by isolated route tests in environments with no loopback networking. */
export function inProcessFetch(app, url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    req.method = options.method || 'GET';
    req.url = new URL(url).pathname + new URL(url).search;
    req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    if (!req.headers.host) req.headers.host = new URL(url).host;
    const payload = options.body === undefined ? null : Buffer.from(options.body);
    if (payload) req.headers['content-length'] = String(payload.length);
    const res = new ServerResponse(req);
    const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.emit('finish');
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.getHeaders())) {
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
      }
      resolve(new Response(res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode, headers }));
      return res;
    };
    req.on('error', reject);
    res.on('error', reject);
    app.handle(req, res, error => error ? reject(error) : res.status(404).end());
    if (payload) req.push(payload);
    req.push(null);
  });
}
