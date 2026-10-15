import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { LibraryStore } from './library.js';
import type { AvatarState, Character } from './shared.js';

type Subscriber = { socket: WebSocket; characterId: string };
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export class OverlayServer {
  private server = createServer((request, response) => this.handleRequest(request, response));
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  private subscribers = new Set<Subscriber>();
  private connections = new Set<Socket>();
  private timer?: ReturnType<typeof setInterval>;
  private origin = '';
  private sequence = 0;
  private lastPublished = 0;
  private stale = true;
  private current: AvatarState = { characterId: '', level: 0, db: -100, speaking: false, running: false, timestamp: Date.now(), sequence: 0 };
  constructor(private store: LibraryStore) {
    this.server.on('connection', socket => { this.connections.add(socket); socket.on('close', () => this.connections.delete(socket)); });
    this.server.on('upgrade', (request, socket, head) => {
      const url = this.authorize(request);
      const characterId = url?.searchParams.get('characterId');
      if (!url || url.pathname !== '/events' || request.headers.origin !== this.origin || !this.store.snapshot().characters.some(character => character.id === characterId)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      this.sockets.handleUpgrade(request, socket, head, ws => {
        const subscriber = { socket: ws, characterId: characterId! }; this.subscribers.add(subscriber);
        ws.on('error', () => ws.terminate()); ws.on('close', () => this.subscribers.delete(subscriber));
        ws.on('message', () => ws.close(1008, 'Read-only avatar source'));
        this.send(subscriber, this.snapshotMessage(subscriber.characterId));
      });
    });
  }
  async start(): Promise<string> {
    if (this.origin) return this.origin;
    const port = this.store.snapshot().settings.overlayPort;
    this.origin = `http://127.0.0.1:${port}`;
    try { await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); }); }); }
    catch (error) { this.origin = ''; throw new Error(`Cannot start OBS overlay on 127.0.0.1:${port}. Close the other Voxincarnate instance or choose a free overlay port. ${error instanceof Error ? error.message : String(error)}`); }
    this.timer = setInterval(() => { if (!this.stale && Date.now() - this.lastPublished > 500) { this.stale = true; this.broadcast(); } }, 100); this.timer.unref();
    return this.origin;
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const subscriber of this.subscribers) subscriber.socket.terminate(); this.subscribers.clear();
    for (const connection of this.connections) connection.destroy();
    await new Promise<void>(resolve => this.sockets.close(() => resolve()));
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.origin = '';
  }
  publish(input: Omit<AvatarState, 'timestamp' | 'sequence'> | AvatarState): void {
    if (!this.store.snapshot().characters.some(character => character.id === input.characterId)) return;
    if (![input.level, input.db].every(Number.isFinite) || typeof input.running !== 'boolean' || typeof input.speaking !== 'boolean') return;
    this.lastPublished = Date.now(); this.stale = false;
    this.current = { characterId: input.characterId, level: Math.max(0, Math.min(1, input.level)), db: Math.max(-100, Math.min(0, input.db)), speaking: input.running && input.speaking, running: input.running, timestamp: this.lastPublished, sequence: ++this.sequence };
    this.broadcast();
  }
  refresh(): void { for (const subscriber of this.subscribers) this.send(subscriber, this.snapshotMessage(subscriber.characterId)); }
  private stateFor(id: string): AvatarState {
    if (this.current.characterId === id && !this.stale && Date.now() - this.lastPublished <= 500) return this.current;
    return { characterId: id, level: 0, db: -100, speaking: false, running: false, timestamp: Date.now(), sequence: this.sequence };
  }
  private snapshotMessage(id: string): unknown { return { type: 'snapshot', character: this.store.snapshot().characters.find(character => character.id === id), state: this.stateFor(id) }; }
  private broadcast(): void { for (const subscriber of this.subscribers) this.send(subscriber, { type: 'state', state: this.stateFor(subscriber.characterId) }); }
  private send(subscriber: Subscriber, message: unknown): void {
    const ws = subscriber.socket;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    if (ws.bufferedAmount > 64 * 1024) return;
    ws.send(JSON.stringify(message), error => { if (error) ws.terminate(); });
  }
  private authorize(request: IncomingMessage): URL | undefined {
    if (!this.origin || request.headers.host !== new URL(this.origin).host) return;
    let url: URL; try { url = new URL(request.url ?? '', this.origin); } catch { return; }
    if (url.origin !== this.origin) return;
    const candidate = Buffer.from(url.searchParams.get('token') ?? ''); const expected = Buffer.from(this.store.snapshot().token);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return;
    if (request.headers.origin && request.headers.origin !== this.origin) return;
    return url;
  }
  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Permissions-Policy', 'microphone=(), camera=(), geolocation=(), display-capture=()'); response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const url = this.authorize(request); if (!url) { response.writeHead(403).end(); return; }
    let parts: string[]; try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { response.writeHead(400).end(); return; }
    if (parts[0] === 'overlay' && parts.length === 2) {
      const character = this.store.snapshot().characters.find(item => item.id === parts[1]); if (!character) { response.writeHead(404).end(); return; }
      const nonce = randomBytes(18).toString('base64');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self' ${this.origin.replace('http:', 'ws:')}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.method === 'HEAD' ? undefined : overlayHtml(character, this.stateFor(character.id), this.store.snapshot().token, nonce)); return;
    }
    if (parts[0] === 'assets' && parts.length === 3) {
      const filename = this.store.assetPath(parts[1], parts[2]); if (!filename) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'image/png'); response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(filename); stream.on('error', () => { if (!response.headersSent) response.writeHead(404); response.end(); }); stream.pipe(response); return;
    }
    response.writeHead(404).end();
  }
}

function overlayHtml(character: Character, state: AvatarState, token: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voxincarnate avatar</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#stage{position:absolute;left:50%;top:50%;transform-origin:center}img{position:absolute;left:50%;top:50%;display:none;max-width:none;pointer-events:none}</style></head><body><div id="stage"></div><script nonce="${nonce}">
const initial=${safeJson({ character, state })};const token=${safeJson(token)};let character=initial.character;let state=initial.state;let images=new Map();let generation=0;let connected=false;let lastMessage=performance.now();let poseStarted=performance.now();let pose='closed';let retry=250;let socket;let retryTimer;const stage=document.getElementById('stage');
function size(){const scale=Math.min(innerWidth/character.width,innerHeight/character.height);stage.style.width=character.width+'px';stage.style.height=character.height+'px';stage.style.transform='translate(-50%,-50%) scale('+scale+')'}addEventListener('resize',size);
async function artwork(next){const currentGeneration=++generation;const prepared=new Map();await Promise.all([...next.closed,...next.open].map(async sprite=>{const img=new Image();img.alt='';img.src='/assets/'+encodeURIComponent(next.id)+'/'+encodeURIComponent(sprite.file)+'?token='+encodeURIComponent(token);try{await img.decode();prepared.set(sprite.id,img)}catch{}}));if(currentGeneration!==generation)return;character=next;images=prepared;stage.replaceChildren(...images.values());size();}
function apply(next){if(next&&next.characterId===character.id&&typeof next.speaking==='boolean'){state=next;lastMessage=performance.now()}}
function idle(){state={...state,speaking:false,running:false};lastMessage=0}
function connect(){clearTimeout(retryTimer);socket=new WebSocket(location.origin.replace('http:','ws:')+'/events?token='+encodeURIComponent(token)+'&characterId='+encodeURIComponent(character.id));socket.onopen=()=>{connected=true;retry=250};socket.onmessage=event=>{try{const msg=JSON.parse(event.data);if(msg.type==='snapshot'&&msg.character){artwork(msg.character);apply(msg.state)}else if(msg.type==='state')apply(msg.state)}catch{}};socket.onerror=()=>socket.close();socket.onclose=()=>{connected=false;idle();retryTimer=setTimeout(connect,retry+Math.random()*100);retry=Math.min(retry*2,5000)}}
function render(now){requestAnimationFrame(render);const desired=connected&&state.running&&state.speaking&&now-lastMessage<=650?'open':'closed';if(desired!==pose){pose=desired;poseStarted=now}const frames=character[pose];const elapsed=Math.max(0,now-poseStarted);const index=Math.floor(elapsed/character.frameMs)%Math.max(1,frames.length);let selected=frames[index];if(!selected||!images.has(selected.id))selected=frames.find(sprite=>images.has(sprite.id))||character.closed.find(sprite=>images.has(sprite.id));for(const [id,img]of images){img.style.display=selected&&id===selected.id?'block':'none';if(selected&&id===selected.id)img.style.transform='translate(-50%,-50%) translate('+selected.x+'px,'+selected.y+'px) scale('+selected.scale+')'}}
size();artwork(character);connect();requestAnimationFrame(render);addEventListener('beforeunload',()=>{clearTimeout(retryTimer);socket?.close()});
</script></body></html>`;
}
