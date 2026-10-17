# Voxincarnate for Stream Deck

Requires Windows, Stream Deck 7.1 or newer, and a running Voxincarnate desktop app. A separate Node.js installation is not required to use the plugin.

1. In Voxincarnate, open **Stream Deck & hotkeys** and choose **Install Stream Deck plugin**. Alternatively, double-click `build/streamdeck/com.voxincarnate.streamdeck.streamDeckPlugin` after building from source.
2. Drag a Voxincarnate action onto a Stream Deck key.
3. In Voxincarnate, choose **Copy connection code**. Paste it into that key's **Connection code** field and choose **Connect**. One connection applies to every Voxincarnate key.
4. For Entrance and Exit, choose the currently selected character or a specific saved character, then an animation. Saved default uses that character's active entrance/exit, including no animation.

Available actions: Start audio capture, Stop audio, Toggle audio, Refresh microphone inputs, Entrance, Exit. Walking, Jump, and Puff of smoke can be selected independently for entrances and exits. Keys display actual app state and report rejected commands. Refresh requires stopped audio. Save changes in the studio before capture or an on-air animation. Start capture uses the studio's selected audio mode and microphone; sign-in and the assistant website's voice-call controls remain in the studio.

Use separate Start and Stop actions for sequences. The plugin never retries commands automatically, and repeated presses while an action is pending are ignored. Disconnected keys show App offline. Connections reconnect with a bounded backoff; old animations are not replayed. Each action in a Stream Deck Multi Action is a separate request; add appropriate delays between steps, because Stream Deck does not await completion of the app's asynchronous work.

Connection credentials live in the plugin's global settings and are not included in individual key settings or exported key profiles. Treat the copied connection code as a password. The plugin sends it only to `127.0.0.1`. Changing the API port requires copying a new code. Global hotkeys work independently of the API and plugin.

Build and validate the installer with `npm run streamdeck:build`; the normal application build includes it too. Development uses the official `@elgato/streamdeck` SDK and `@elgato/cli`. `streamdeck/src/client.ts` contains the authenticated local transport and reconnect lifecycle; `desktop/control-protocol.ts` defines the supported commands.
