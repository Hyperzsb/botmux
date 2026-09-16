import { lookup } from 'node:dns/promises';
import { connect, createServer, isIP, type Server, type Socket } from 'node:net';

const HEADER_LIMIT_BYTES = 16 * 1024;
const HEADER_TIMEOUT_MS = 5_000;

export interface BytedcliIpv4Proxy {
  url: string;
  close: () => Promise<void>;
}

function reject(client: Socket, status: number, reason: string): void {
  try {
    client.end(
      `HTTP/1.1 ${status} ${reason}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Length: 0\r\n\r\n',
    );
  } catch {
    client.destroy();
  }
}

/**
 * Start a loopback-only, CONNECT-only proxy for ByteCloud Auth.
 *
 * The hostname is resolved by Node with `family: 4`, then the TLS byte stream
 * remains end-to-end between bytedcli and ByteCloud. The proxy never sees or
 * terminates credentials. It accepts only DNS hostnames on port 443, listens
 * only on an ephemeral loopback port, and is destroyed as soon as the one
 * bytedcli invocation exits.
 */
export async function startBytedcliIpv4Proxy(): Promise<BytedcliIpv4Proxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));

    let header: Buffer = Buffer.alloc(0);
    let routed = false;
    const timer = setTimeout(() => client.destroy(), HEADER_TIMEOUT_MS);
    timer.unref?.();

    const onData = (chunk: Buffer) => {
      if (routed) return;
      header = header.length ? Buffer.concat([header, chunk]) : chunk;
      const headerEnd = header.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (header.length > HEADER_LIMIT_BYTES) client.destroy();
        return;
      }

      routed = true;
      clearTimeout(timer);
      client.removeListener('data', onData);
      client.pause();

      const lineEnd = header.indexOf('\r\n');
      const requestLine = header.subarray(0, lineEnd).toString('latin1');
      const match = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]$/.exec(requestLine);
      if (!match) { reject(client, 405, 'Method Not Allowed'); return; }

      const host = match[1].toLowerCase();
      const port = Number(match[2]);
      if (port !== 443 || isIP(host) !== 0 || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) {
        reject(client, 403, 'Forbidden');
        return;
      }

      lookup(host, { family: 4 }).then(({ address }) => {
        if (client.destroyed) return;
        const upstream = connect({ host: address, port, family: 4 });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        upstream.once('connect', () => {
          if (client.destroyed) { upstream.destroy(); return; }
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const rest = header.subarray(headerEnd + 4);
          if (rest.length) upstream.write(rest);
          // Wire data explicitly. Bun's net.Socket.pipe() has exhibited
          // intermittent truncation when two sockets are spliced immediately
          // after a CONNECT response; direct writes keep this tiny tunnel
          // reliable on both Bun and Node.
          client.on('data', data => { if (!upstream.destroyed) upstream.write(data); });
          upstream.on('data', data => { if (!client.destroyed) client.write(data); });
          client.once('end', () => upstream.end());
          upstream.once('end', () => client.end());
          client.resume();
        });
        upstream.on('error', () => {
          if (!client.destroyed) reject(client, 502, 'Bad Gateway');
          upstream.destroy();
        });
        client.once('close', () => upstream.destroy());
      }).catch(() => reject(client, 502, 'Bad Gateway'));
    };

    client.on('data', onData);
    client.on('error', () => client.destroy());
  });

  return await new Promise<BytedcliIpv4Proxy>((resolve, rejectStart) => {
    const onError = (error: Error) => rejectStart(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectStart(new Error('IPv4 proxy did not bind a TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          if (!server.listening) return;
          await new Promise<void>(done => server.close(() => done()));
        },
      });
    });
  });
}
