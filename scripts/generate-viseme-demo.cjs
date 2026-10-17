/* Original vector artwork, rendered by the project's pinned Electron runtime.
   Rebuild with: node node_modules/electron/cli.js scripts/generate-viseme-demo.cjs */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const mouth = {
  A: '<path d="M167 248 Q200 253 233 248 M177 255 Q200 261 223 255" fill="none"/>',
  B: '<path d="M163 240 Q200 234 237 240 L233 255 Q200 261 167 255Z" fill="#162b31"/><path d="M166 241 Q200 238 234 241 L232 248 H168Z" fill="#fff9e6" stroke="none"/>',
  C: '<path d="M162 240 Q200 234 238 240 Q236 282 200 284 Q164 282 162 240Z" fill="#162b31"/><path d="M165 241 Q200 238 235 241 L231 249 H169Z" fill="#fff9e6" stroke="none"/><path d="M177 274 Q200 260 223 274 Q200 286 177 274" fill="#e68e87" stroke="none"/>',
  D: '<path d="M161 240 Q200 233 239 240 Q245 306 200 309 Q155 306 161 240Z" fill="#162b31"/><path d="M165 241 Q200 237 235 241 L232 252 H168Z" fill="#fff9e6" stroke="none"/><path d="M175 296 Q200 278 225 296 Q200 311 175 296" fill="#e68e87" stroke="none"/>',
  E: '<ellipse cx="200" cy="263" rx="23" ry="29" fill="#162b31"/><path d="M187 248 Q200 242 213 248" fill="none" stroke="#fff9e6" stroke-width="5"/>',
  F: '<path d="M184 246 Q200 233 216 246 Q224 269 200 274 Q176 269 184 246Z" fill="#162b31"/><path d="M178 243 Q200 227 222 243 M181 276 Q200 285 219 276" fill="none" stroke-width="3"/>',
  G: '<path d="M163 240 Q200 234 237 240 Q230 268 200 265 Q170 268 163 240Z" fill="#162b31"/><path d="M166 241 Q200 237 234 241 L229 254 H171Z" fill="#fff9e6" stroke="none"/><path d="M172 256 Q200 249 228 256 Q200 272 172 256" fill="#e68e87" stroke-width="2"/>',
  H: '<path d="M163 240 Q200 234 237 240 Q236 281 200 283 Q164 281 163 240Z" fill="#162b31"/><path d="M167 241 Q200 238 233 241 L230 248 H170Z" fill="#fff9e6" stroke="none"/><path d="M187 277 L188 251 Q200 244 212 251 L213 277 Q200 285 187 277Z" fill="#e68e87" stroke-width="2"/>',
  X: '<path d="M169 246 Q200 263 231 246" fill="none" stroke-linecap="round"/>'
};
function svg(pose) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs><linearGradient id="shell" x2=".8" y2="1"><stop stop-color="#e1f2de"/><stop offset="1" stop-color="#9dc4b3"/></linearGradient><linearGradient id="body" x2="0" y2="1"><stop stop-color="#406861"/><stop offset="1" stop-color="#203d3c"/></linearGradient></defs>
  <path d="M135 355 Q139 302 200 303 Q261 302 265 355Z" fill="url(#body)" stroke="#173333" stroke-width="5"/>
  <path d="M200 72V45" stroke="#173333" stroke-width="7" stroke-linecap="round"/><circle cx="200" cy="38" r="11" fill="#e8ba71" stroke="#173333" stroke-width="4"/>
  <rect x="81" y="159" width="28" height="62" rx="13" fill="#e8ba71" stroke="#173333" stroke-width="5"/><rect x="291" y="159" width="28" height="62" rx="13" fill="#e8ba71" stroke="#173333" stroke-width="5"/>
  <rect x="99" y="77" width="202" height="245" rx="91" fill="url(#shell)" stroke="#173333" stroke-width="5"/>
  <path d="M126 139 Q142 111 164 108" fill="none" stroke="#f3fff1" stroke-width="7" stroke-linecap="round" opacity=".7"/>
  <rect x="129" y="159" width="142" height="55" rx="27" fill="#203d3c"/>
  <ellipse cx="166" cy="184" rx="12" ry="15" fill="#d7f5cb"/><ellipse cx="234" cy="184" rx="12" ry="15" fill="#d7f5cb"/>
  <circle cx="169" cy="180" r="3" fill="#fff"/><circle cx="237" cy="180" r="3" fill="#fff"/>
  <path d="M139 227H148 M252 227H261" stroke="#e58d78" stroke-width="5" stroke-linecap="round" opacity=".75"/>
  <g stroke="#294b45" stroke-width="4" stroke-linejoin="round">${mouth[pose]}</g>
  <rect x="181" y="331" width="38" height="6" rx="3" fill="#e8ba71"/><circle cx="229" cy="334" r="3" fill="#b7dfc0"/>
  </svg>`;
}
app.whenReady().then(async () => {
  const directory = path.resolve(__dirname, '../artwork/viseme-demo');
  await fs.mkdir(directory, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 400, height: 400, useContentSize: true,
    transparent: true, frame: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    for (const pose of Object.keys(mouth)) {
      const html = `<html style="background:transparent"><body style="margin:0;background:transparent">${svg(pose)}</body></html>`;
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await fs.writeFile(path.join(directory, `${pose}.png`), (await window.webContents.capturePage()).toPNG());
    }
    console.log(`Rendered nine original mouth poses to ${directory}`);
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
