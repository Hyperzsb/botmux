import { afterEach, describe, expect, it } from 'vitest';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { startBytedcliIpv4Proxy, type BytedcliIpv4Proxy } from '../src/services/bytedcli-ipv4-proxy.js';

const handles: Array<{ close: () => Promise<void> }> = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(handles.splice(0).map(handle => handle.close()));
});

function exchange(proxy: BytedcliIpv4Proxy, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(proxy.url);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    sockets.add(socket);
    let response = '';
    socket.setEncoding('latin1');
    socket.once('connect', () => socket.write(request));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
    socket.setTimeout(2_000, () => reject(new Error('proxy response timed out')));
  });
}

describe('bytedcli IPv4 CONNECT proxy', () => {
  it('listens only on loopback', async () => {
    const proxy = await startBytedcliIpv4Proxy();
    handles.push(proxy);
    expect(new URL(proxy.url).hostname).toBe('127.0.0.1');
  });

  it('rejects non-CONNECT requests', async () => {
    const proxy = await startBytedcliIpv4Proxy();
    handles.push(proxy);
    const response = await exchange(proxy, 'GET / HTTP/1.1\r\nHost: example.test\r\n\r\n');
    expect(response).toContain('405 Method Not Allowed');
  });

  it('rejects IP literals and non-TLS ports', async () => {
    const proxy = await startBytedcliIpv4Proxy();
    handles.push(proxy);
    const ipResponse = await exchange(proxy, 'CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n');
    expect(ipResponse).toContain('403 Forbidden');
    const portResponse = await exchange(proxy, 'CONNECT example.test:80 HTTP/1.1\r\n\r\n');
    expect(portResponse).toContain('403 Forbidden');
  });
});
