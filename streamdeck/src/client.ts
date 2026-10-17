import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import type { ControlCommand, ControlResponse, ControlState } from '../../desktop/control-protocol.js';

export interface Connection { port: number; token: string }
export function parseConnection(value: unknown): Connection {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!data || typeof data !== 'object' || !Number.isInteger(data.port) || data.port < 1024 || data.port > 65535 || typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw new Error('Copy a fresh connection code from Voxincarnate → Stream Deck & hotkeys.');
  return { port: data.port, token: data.token };
}

export class LocalControlClient extends EventEmitter {
  state?: ControlState;
  message = 'Paste a connection code to connect.';
  private connection?: Connection;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private retry = 500;
  private generation = 0;
  connect(connection: Connection): void {
    this.close(); this.connection = parseConnection(connection); this.retry = 500; this.message = 'Connecting to Voxincarnate…'; this.emit('state'); this.open(this.generation);
  }
  close(): void {
    ++this.generation; clearTimeout(this.timer); this.socket?.terminate(); this.socket = undefined; this.connection = undefined; this.state = undefined;
  }
  private open(generation: number): void {
    if (!this.connection || generation !== this.generation) return;
    const socket = new WebSocket(`ws://127.0.0.1:${this.connection.port}/v1/events`, { headers: { Authorization: `Bearer ${this.connection.token}` }, handshakeTimeout: 2500, maxPayload: 256 * 1024, perMessageDeflate: false });
    this.socket = socket;
    socket.on('message', bytes => {
      if (generation !== this.generation) return;
      try {
        const message = JSON.parse(String(bytes));
        if (message.type !== 'state' || message.state?.apiVersion !== 1 || !Array.isArray(message.state.characters)) throw new Error('Unsupported API.');
        this.state = message.state; this.retry = 500; this.message = 'Connected to Voxincarnate.'; this.emit('state');
      } catch { this.message = 'Update Voxincarnate and its Stream Deck plugin together.'; socket.terminate(); }
    });
    socket.on('unexpected-response', (_req, response) => {
      this.message = response.statusCode === 403 ? 'Connection code rejected. Copy it again from Voxincarnate.' : 'The local control API is unavailable.';
      response.resume(); socket.terminate();
    });
    socket.on('error', () => { if (generation === this.generation && !this.message.startsWith('Connection code rejected')) this.message = 'Open Voxincarnate and enable its local control API.'; });
    socket.on('close', () => {
      if (generation !== this.generation) return;
      if (this.state) this.message = 'Disconnected. Reconnecting to Voxincarnate…';
      this.state = undefined; this.emit('state');
      this.timer = setTimeout(() => this.open(generation), this.retry); this.retry = Math.min(this.retry * 2, 5000);
    });
  }
  async execute(command: ControlCommand): Promise<ControlResponse> {
    const connection = this.connection;
    if (!connection || !this.state) throw new Error(this.message);
    const generation = this.generation;
    const result = await new Promise<ControlResponse>((resolve, reject) => {
      const body = JSON.stringify(command);
      const req = request({ hostname: '127.0.0.1', port: connection.port, path: '/v1/commands', method: 'POST',
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 22000 }, response => {
        let size = 0; const chunks: Buffer[] = [];
        response.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) req.destroy(new Error('Control response was too large.')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof value.ok !== 'boolean') throw new Error('Invalid control response.');
            if (response.statusCode === 403) throw new Error('Connection code rejected. Copy a fresh code from Voxincarnate.');
            resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('The command timed out. Check the studio before retrying.')));
      req.on('error', reject); req.end(body);
    });
    if (generation !== this.generation) throw new Error('The connection changed. Check the studio before retrying.');
    if (result.state) { this.state = result.state; this.emit('state'); }
    return result;
  }
}
