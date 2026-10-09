const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');

// Ejecutar las rutas y su middleware reales sin abrir puertos. Permite las
// mismas pruebas (incluidas descargas binarias) en entornos restringidos.
function inProcessTransport(app) {
  const nativeFetch = global.fetch;
  const baseUrl = 'http://mypimes-test.local';
  global.fetch = async (url, options = {}) => {
    if (!String(url).startsWith(baseUrl)) return nativeFetch(url, options);
    return new Promise((resolve, reject) => {
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
      const req = new IncomingMessage(socket);
      req.url = String(url).slice(baseUrl.length) || '/';
      req.method = options.method || 'GET';
      req.complete = true;
      req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
      const body = options.body ? Buffer.from(options.body) : Buffer.alloc(0);
      if (body.length) req.headers['content-length'] = String(body.length);
      const res = new ServerResponse(req);
      res.assignSocket(socket);
      const chunks = [];
      const write = res.write.bind(res), end = res.end.bind(res);
      res.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
      res.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
      res.on('error', reject);
      res.on('finish', () => {
        const contents = Buffer.concat(chunks);
        resolve(new Response([204, 304].includes(res.statusCode) ? null : contents, { status: res.statusCode, headers: res.getHeaders() }));
        socket.destroy();
      });
      if (body.length) req.push(body);
      req.push(null);
      // Cada petición llega en su propio turno, como los eventos de socket HTTP.
      setImmediate(() => app.handle(req, res));
    });
  };
  return { baseUrl, close() { global.fetch = nativeFetch; } };
}
module.exports = { inProcessTransport };
