let socket, context, actionId, settings = {}, characters = [], activeCharacterId = '';
const byId = id => document.getElementById(id);
function send(event, payload) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload, action: actionId })); }
function refreshCharacters() {
  const select = byId('character');
  select.replaceChildren(new Option('Currently selected', ''));
  for (const character of characters) select.add(new Option(character.name, character.id));
  if (settings.characterId && !characters.some(character => character.id === settings.characterId)) select.add(new Option('Character unavailable · choose another', settings.characterId));
  select.value = settings.characterId || '';
  byId('effect').value = settings.effect || '';
  const character = characters.find(character => character.id === (settings.characterId || activeCharacterId));
  const kind = actionId?.endsWith('.enter') ? 'enter' : 'exit';
  for (const option of byId('effect').options) option.disabled = !!character && !!option.value && !character.motions[kind].includes(option.value);
}
window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
  context = uuid;
  const action = JSON.parse(actionInfo); actionId = action.action; settings = action.payload?.settings || {};
  byId('motion').hidden = !actionId.includes('.character.'); refreshCharacters();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.onopen = () => { socket.send(JSON.stringify({ event: registerEvent, uuid })); send('sendToPlugin', { event: 'status' }); };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.event === 'didReceiveSettings') { settings = message.payload.settings; refreshCharacters(); }
    if (message.event === 'sendToPropertyInspector' && message.payload.event === 'status') {
      byId('status').textContent = message.payload.message; byId('status').classList.toggle('error', !message.payload.connected);
      characters = message.payload.characters || []; activeCharacterId = message.payload.activeCharacterId || ''; refreshCharacters();
    }
  };
  socket.onclose = () => { byId('status').textContent = 'Stream Deck disconnected. Select this key again.'; };
};
byId('pair-form').onsubmit = event => { event.preventDefault(); send('sendToPlugin', { event: 'pair', code: byId('connection').value }); byId('connection').value = ''; byId('status').textContent = 'Connecting to Voxincarnate…'; };
for (const id of ['character', 'effect']) byId(id).onchange = () => {
  settings = { characterId: byId('character').value, effect: byId('effect').value };
  send('setSettings', settings); refreshCharacters();
};
