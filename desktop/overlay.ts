import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createAvatarAnimator, createMotionAnimator, drawSmokePuff } from './animation.js';
import { createMotionSoundPlayer } from './motion-sound.js';
import { hasMotion } from './character-motions.js';
import { MOTION_EFFECTS } from './shared.js';
import type { LibraryStore } from './library.js';
import type { Articulation, AvatarState, Character, CharacterPresence, MotionEffect } from './shared.js';

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
  private articulationClock?: { characterId: string; audioTimeMs: number };
  private presence = new Map<string, CharacterPresence>();
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
    let articulation: Articulation | undefined;
    if (input.articulation !== undefined) {
      const value = input.articulation;
      if (!value || !Number.isFinite(value.audioTimeMs) || value.audioTimeMs < 0 || value.audioTimeMs > Number.MAX_SAFE_INTEGER || !value.weights || typeof value.weights !== 'object' || Array.isArray(value.weights)) return;
      const weights = Object.entries(value.weights);
      if (!weights.length || weights.some(([key, weight]) => !['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'].includes(key) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1)) return;
      articulation = { audioTimeMs: value.audioTimeMs, weights: { ...value.weights } };
    }
    if (!input.running || this.articulationClock?.characterId !== input.characterId) this.articulationClock = undefined;
    if (articulation && input.running) {
      if (this.articulationClock && articulation.audioTimeMs < this.articulationClock.audioTimeMs) articulation = this.current.articulation;
      else this.articulationClock = { characterId: input.characterId, audioTimeMs: articulation.audioTimeMs };
    }
    this.lastPublished = Date.now(); this.stale = false;
    this.current = { characterId: input.characterId, level: Math.max(0, Math.min(1, input.level)), db: Math.max(-100, Math.min(0, input.db)), speaking: input.running && input.speaking, running: input.running, timestamp: this.lastPublished, sequence: ++this.sequence, ...(input.running && articulation ? { articulation } : {}) };
    this.broadcast();
  }
  getPresence(characterId: string): CharacterPresence { return { ...(this.presence.get(characterId) ?? { visible: true, sequence: 0 }) }; }
  setPresence(characterId: string, visible: boolean, effect?: MotionEffect): CharacterPresence {
    const character = this.store.snapshot().characters.find(character => character.id === characterId);
    if (typeof visible !== 'boolean' || !character) throw new Error('Choose a valid character and visibility.');
    if (effect !== undefined && (!MOTION_EFFECTS.includes(effect) || !hasMotion(character, visible ? 'enter' : 'exit', effect))) {
      throw new Error('This character does not have that entrance or exit animation. Add it in Edit character first.');
    }
    const presence: CharacterPresence = { visible, sequence: (this.presence.get(characterId)?.sequence ?? 0) + 1, ...(effect === undefined ? {} : { effect }) };
    this.presence.set(characterId, presence);
    this.broadcast();
    return { ...presence };
  }
  refresh(): void {
    const ids = new Set(this.store.snapshot().characters.map(character => character.id));
    for (const id of this.presence.keys()) if (!ids.has(id)) this.presence.delete(id);
    if (this.articulationClock && !ids.has(this.articulationClock.characterId)) this.articulationClock = undefined;
    if (this.current.characterId && !ids.has(this.current.characterId)) {
      this.stale = true; this.lastPublished = 0;
      this.current = { characterId: '', level: 0, db: -100, speaking: false, running: false, timestamp: Date.now(), sequence: ++this.sequence };
    }
    for (const subscriber of this.subscribers) {
      if (ids.has(subscriber.characterId)) this.send(subscriber, this.snapshotMessage(subscriber.characterId));
      else {
        this.send(subscriber, { type: 'deleted', characterId: subscriber.characterId }, true);
        subscriber.socket.close(4004, 'Character deleted');
        this.subscribers.delete(subscriber);
      }
    }
  }
  private stateFor(id: string): AvatarState {
    const presence = { ...(this.presence.get(id) ?? { visible: true, sequence: 0 }) };
    if (this.current.characterId === id && !this.stale && Date.now() - this.lastPublished <= 500) return { ...this.current, presence };
    return { characterId: id, level: 0, db: -100, speaking: false, running: false, timestamp: Date.now(), sequence: this.sequence, presence };
  }
  private snapshotMessage(id: string): unknown { return { type: 'snapshot', character: this.store.snapshot().characters.find(character => character.id === id), state: this.stateFor(id) }; }
  private broadcast(): void { for (const subscriber of this.subscribers) this.send(subscriber, { type: 'state', state: this.stateFor(subscriber.characterId) }); }
  private send(subscriber: Subscriber, message: unknown, final = false): void {
    const ws = subscriber.socket;
    if (ws.readyState !== WebSocket.OPEN) return;
    // The final deletion message and close frame must reach a slow browser too.
    if (!final && ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    if (!final && ws.bufferedAmount > 64 * 1024) return;
    ws.send(JSON.stringify(message), error => { if (error) ws.terminate(); });
  }
  private authorize(request: IncomingMessage): URL | undefined {
    if (!this.origin || request.headers.host !== new URL(this.origin).host) return;
    let url: URL; try { url = new URL(request.url ?? '', this.origin); } catch { return; }
    if (url.origin !== this.origin) return;
    const candidate = Buffer.from(url.searchParams.get('token') ?? ''); const expected = Buffer.from(this.store.snapshot().token);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return;
    // The local file:// studio measures decoded alpha pixels. Its anonymous image
    // requests have Origin:null or Electron's file://; permit only authenticated asset reads.
    const studioAsset = (request.headers.origin === 'null' || request.headers.origin === 'file://') && (request.method === 'GET' || request.method === 'HEAD') && /^\/assets\/[^/]+\/[^/]+$/.test(url.pathname);
    if (request.headers.origin && request.headers.origin !== this.origin && !studioAsset) return;
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
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'self' ${this.origin.replace('http:', 'ws:')}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.method === 'HEAD' ? undefined : overlayHtml(character, this.stateFor(character.id), this.store.snapshot().token, nonce)); return;
    }
    if (parts[0] === 'assets' && parts.length === 3) {
      const filename = this.store.assetPath(parts[1], parts[2]); if (!filename) { response.writeHead(404).end(); return; }
      if (request.headers.origin === 'null' || request.headers.origin === 'file://') { response.setHeader('Access-Control-Allow-Origin', request.headers.origin); response.setHeader('Vary', 'Origin'); }
      const sound = /\.wav$/i.test(parts[2]);
      response.setHeader('Content-Type', sound ? 'audio/wav' : 'image/png'); response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      let range: { start: number; end: number } | undefined;
      if (sound) {
        let size: number; try { size = statSync(filename).size; } catch { response.writeHead(404).end(); return; }
        response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Content-Length', size);
        if (request.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
          const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, size - Number(match[2])) : NaN;
          const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
            response.removeHeader('Content-Length'); response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return;
          }
          range = { start, end }; response.statusCode = 206;
          response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); response.setHeader('Content-Length', end - start + 1);
        }
      }
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(filename, range); stream.on('error', () => { if (!response.headersSent) response.writeHead(404); response.end(); }); stream.pipe(response); return;
    }
    response.writeHead(404).end();
  }
}

function overlayHtml(character: Character, state: AvatarState, token: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voxincarnate avatar</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#stage,#smoke{position:absolute;left:50%;top:50%;transform-origin:center}#smoke{pointer-events:none}img{position:absolute;left:50%;top:50%;display:none;max-width:none;pointer-events:none}</style></head><body><div id="stage"></div><canvas id="smoke"></canvas><script nonce="${nonce}">
const initial=${safeJson({ character, state })};const token=${safeJson(token)};const animator=(${createAvatarAnimator.toString()})();const motion=(${createMotionAnimator.toString()})();const sounds=(${createMotionSoundPlayer.toString()})((id,sound)=>'/assets/'+encodeURIComponent(id)+'/'+encodeURIComponent(sound.file)+'?token='+encodeURIComponent(token),undefined,message=>console.warn(message));sounds.baseline(initial.character.id,initial.state.presence?.sequence||0);const drawSmoke=(${drawSmokePuff.toString()});let character=initial.character;let state=initial.state;let images=new Map();let bounds;let spriteBounds={};let generation=0;let deleted=false;let connected=false;let lastMessage=performance.now();let retry=250;let socket;let retryTimer;const stage=document.getElementById('stage');const smokeCanvas=document.getElementById('smoke');const smokeContext=smokeCanvas?.getContext?.('2d');
function geometry(){const scale=Math.min(innerWidth/character.width,innerHeight/character.height);return{width:innerWidth/scale,height:innerHeight/scale,bounds,spriteBounds}}
function updateMotion(now){const start=motion.update(character,state.presence,now,geometry());sounds.play(character,start);if(!motion.frame(now).active)sounds.stop()}
function size(){const scale=Math.min(innerWidth/character.width,innerHeight/character.height);stage.style.width=character.width+'px';stage.style.height=character.height+'px';stage.style.transform='translate(-50%,-50%) scale('+scale+')';if(smokeCanvas){smokeCanvas.width=character.width;smokeCanvas.height=character.height;smokeCanvas.style.transform=stage.style.transform}}addEventListener('resize',size);motion.update(character,state.presence,performance.now(),geometry());
function visibleBounds(img,sprite,next){const width=img.naturalWidth||img.width||next.width;const height=img.naturalHeight||img.height||next.height;let left=0,right=width,top=0,bottom=height;try{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(img,0,0);const pixels=context.getImageData(0,0,width,height).data;left=width;right=0;top=height;bottom=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[(y*width+x)*4+3]>0){left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1)}if(right<=left||bottom<=top)return}catch{}return{left:sprite.x+(left-width/2)*sprite.scale,right:sprite.x+(right-width/2)*sprite.scale,top:sprite.y+(top-height/2)*sprite.scale,bottom:sprite.y+(bottom-height/2)*sprite.scale}}
async function artwork(next){if(deleted)return;const currentGeneration=++generation;const prepared=new Map();const measured=[];const perSprite={};await Promise.all([...next.closed,...next.open,...Object.values(next.visemes||{}).flat(),...Object.values(next.motions||{}).flatMap(clip=>clip.frames),...Object.values(next.motionVariants||{}).flatMap(choices=>Object.values(choices).flatMap(clip=>clip.frames))].map(async sprite=>{const img=new Image();img.alt='';img.src='/assets/'+encodeURIComponent(next.id)+'/'+encodeURIComponent(sprite.file)+'?token='+encodeURIComponent(token);try{await img.decode();prepared.set(sprite.id,img);const box=visibleBounds(img,sprite,next);if(box){measured.push(box);perSprite[sprite.id]=box}}catch{}}));if(currentGeneration!==generation||deleted)return;character=next;images=prepared;spriteBounds=perSprite;bounds=measured.length?{left:Math.min(...measured.map(box=>box.left)),right:Math.max(...measured.map(box=>box.right)),top:Math.min(...measured.map(box=>box.top)),bottom:Math.max(...measured.map(box=>box.bottom))}:undefined;stage.replaceChildren(...images.values());size();updateMotion(performance.now())}
function apply(next){if(!deleted&&next&&next.characterId===character.id&&typeof next.speaking==='boolean'){state={...next,presence:next.presence||state.presence};lastMessage=performance.now();updateMotion(lastMessage)}}
function idle(){state={...state,speaking:false,running:false};lastMessage=0}
function remove(){if(deleted)return;deleted=true;connected=false;generation++;clearTimeout(retryTimer);idle();animator.reset();motion.reset();sounds.stop();images.clear();bounds=undefined;spriteBounds={};stage.replaceChildren();if(smokeContext)smokeContext.clearRect(0,0,character.width,character.height);socket?.close?.()}
function connect(){if(deleted)return;clearTimeout(retryTimer);let firstSnapshot=true;socket=new WebSocket(location.origin.replace('http:','ws:')+'/events?token='+encodeURIComponent(token)+'&characterId='+encodeURIComponent(character.id));socket.onopen=()=>{if(deleted){socket.close();return}connected=true;retry=250};socket.onmessage=event=>{if(deleted)return;try{const msg=JSON.parse(event.data);if(msg.type==='deleted'&&msg.characterId===character.id)remove();else if(msg.type==='snapshot'){if(msg.character){if(firstSnapshot){sounds.baseline(msg.character.id,msg.state?.presence?.sequence||0);firstSnapshot=false}artwork(msg.character);apply(msg.state)}else remove()}else if(msg.type==='state')apply(msg.state)}catch{}};socket.onerror=()=>socket.close();socket.onclose=event=>{if(event?.code===4004)remove();connected=false;idle();sounds.stop();if(!deleted){retryTimer=setTimeout(connect,retry+Math.random()*100);retry=Math.min(retry*2,5000)}}}
function render(now){if(deleted)return;requestAnimationFrame(render);const live=connected&&state.running&&now-lastMessage<=650;animator.update(character,{...state,running:live,speaking:live&&state.speaking},now);updateMotion(now);const movement=motion.frame(now);let selected=movement.sprite||animator.frame(now);if(!selected||!images.has(selected.id)){const fallback=movement.active?[...character.closed,...character.open]:animator.isClosed()?[...character.closed,...character.open]:[...character.open,...character.closed];selected=fallback.find(sprite=>images.has(sprite.id))}for(const [id,img]of images){img.style.display=movement.visible&&selected&&id===selected.id?'block':'none';if(selected&&id===selected.id){img.style.opacity=String(movement.opacity);img.style.transform='translate(-50%,-50%) translate('+((movement.flipX?-selected.x:selected.x)*movement.scale+movement.offsetX)+'px,'+(selected.y*movement.scale+movement.offsetY)+'px) scale('+(selected.scale*movement.scale*(movement.flipX?-1:1))+','+(selected.scale*movement.scale)+')'}}if(smokeContext)drawSmoke(smokeContext,movement.smoke,character.width,character.height)}
size();artwork(character);connect();requestAnimationFrame(render);addEventListener('beforeunload',()=>{clearTimeout(retryTimer);sounds.stop();socket?.close()});
</script></body></html>`;
}
