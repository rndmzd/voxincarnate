import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { parseCommand, type ControlCommand, type ControlResponse, type ControlState } from './control-protocol.js';

export class ControlServer {
  private server = createServer((req, res) => { void this.request(req, res); });
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  private connections = new Set<Socket>();
  private host = '';
  constructor(private token: string, private state: () => ControlState, private execute: (command: ControlCommand) => Promise<ControlResponse>) {
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    this.server.on('connection', socket => { this.connections.add(socket); socket.on('close', () => this.connections.delete(socket)); });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.authorize(req) || req.url !== '/v1/events') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      this.sockets.handleUpgrade(req, socket, head, ws => {
        ws.on('error', () => ws.terminate());
        ws.on('message', () => ws.close(1008, 'Send commands with HTTP POST.'));
        ws.send(JSON.stringify({ type: 'state', state: this.state() }));
      });
    });
  }
  async start(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    this.host = `127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  get origin(): string { return `http://${this.host}`; }
  broadcast(): void {
    const data = JSON.stringify({ type: 'state', state: this.state() });
    for (const socket of this.sockets.clients) {
      if (socket.bufferedAmount > 64 * 1024) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }
  async stop(): Promise<void> {
    this.host = '';
    for (const socket of this.sockets.clients) socket.terminate();
    for (const socket of this.connections) socket.destroy();
    await new Promise<void>(resolve => this.sockets.close(() => resolve()));
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  private authorize(req: IncomingMessage): boolean {
    // Only native local clients. Browser origins and query-string tokens are never accepted.
    if (!this.host || req.headers.host !== this.host || req.headers.origin || req.headers['sec-fetch-site']) return false;
    const candidate = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${this.token}`);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  private json(res: ServerResponse, status: number, body: unknown): void {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }
  }
  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorize(req)) { this.json(res, 403, { ok: false, code: 'unauthorized', message: 'A local connection token is required.' }); return; }
    if (req.method === 'GET' && req.url === '/v1/status') { this.json(res, 200, this.state()); return; }
    if (req.url !== '/v1/commands') { this.json(res, 404, { ok: false, code: 'not_found' }); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); this.json(res, 405, { ok: false, code: 'method_not_allowed' }); return; }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { this.json(res, 415, { ok: false, code: 'json_required' }); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { this.json(res, 413, { ok: false, code: 'too_large' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let command: ControlCommand;
      try { command = parseCommand(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { this.json(res, 400, { ok: false, code: 'invalid_command', message: (error as Error).message }); return; }
      const result = await this.execute(command);
      this.json(res, result.ok ? 200 : 409, result);
    } catch { this.json(res, 500, { ok: false, code: 'control_failed', message: 'The studio could not complete this command.' }); }
  }
}
