import asyncio
import websockets
import json
import time
from collections import deque
import pyaudio
import numpy as np
import threading

# ------------------------------------------------------------------------
# Rolling audio monitor class
# ------------------------------------------------------------------------
class AudioLevelMonitorRolling:
    """
    Captures audio from a chosen device and measures amplitude in real time,
    using a rolling history for min/max scaling (to avoid 'stuck' extremes).
    """
    def __init__(self, device_index=None, chunk_size=1024, sample_rate=44100, history_size=50):
        """
        :param device_index: PyAudio input device index. If None, user picks from list.
        :param chunk_size: Number of frames per buffer chunk.
        :param sample_rate: Audio sampling rate in Hz.
        :param history_size: Rolling window size (number of peaks stored).
        """
        if device_index is None:
            device_index = self.user_select_device()

        self.device_index = device_index
        self.chunk_size = chunk_size
        self.sample_rate = sample_rate

        # Store the N most recent peaks in a deque, so we can compute min/max quickly.
        self.peak_history = deque(maxlen=history_size)

        self.pa = pyaudio.PyAudio()
        self.stream = None
        self.current_level = 0.0

        self._stop_event = threading.Event()
        self._monitor_thread = None

    @staticmethod
    def user_select_device():
        """
        Prompt the user to pick an input device from a list of input-capable devices.
        """
        p = pyaudio.PyAudio()
        device_count = p.get_device_count()
        input_devices = []

        for i in range(device_count):
            info = p.get_device_info_by_index(i)
            max_input = info.get('maxInputChannels', 0)
            if max_input > 0:
                input_devices.append((i, info['name']))

        if not input_devices:
            p.terminate()
            raise RuntimeError("No input-capable devices found. Check your audio settings.")

        print("\n==[ Available Audio Input Devices ]==")
        for idx, (dev_idx, name) in enumerate(input_devices):
            print(f"{idx+1}. [Device Index: {dev_idx}] {name}")
        print()

        while True:
            try:
                selection = input(f"Select device # (1-{len(input_devices)}): ")
                selection_int = int(selection) - 1
                if 0 <= selection_int < len(input_devices):
                    chosen_device_index = input_devices[selection_int][0]
                    print(f"You selected device index: {chosen_device_index}  ({input_devices[selection_int][1]})")
                    p.terminate()
                    return chosen_device_index
                else:
                    print("Invalid selection. Enter a valid number.")
            except ValueError:
                print("Please enter a numeric choice.")

    def start(self):
        """
        Opens the PyAudio stream and starts a background thread for monitoring.
        """
        self.stream = self.pa.open(
            format=pyaudio.paInt16,
            channels=2,
            rate=self.sample_rate,
            input=True,
            frames_per_buffer=self.chunk_size,
            input_device_index=self.device_index
        )

        self._stop_event.clear()
        self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._monitor_thread.start()

    def _monitor_loop(self):
        """
        Reads audio in short chunks, computes the peak amplitude, and
        normalizes it to [0..1] using a rolling min/max window.
        """
        while not self._stop_event.is_set():
            try:
                data = self.stream.read(self.chunk_size, exception_on_overflow=False)
                audio_data = np.frombuffer(data, dtype=np.int16)
                peak = np.max(np.abs(audio_data))

                # Push the latest peak into a rolling window
                self.peak_history.append(peak)

                # Compute rolling min and max
                min_val = min(self.peak_history)
                max_val = max(self.peak_history)

                if min_val == max_val:
                    # If there's no range, just do naive scaling
                    normalized = peak / 32767.0
                else:
                    normalized = (peak - min_val) / float(max_val - min_val)

                self.current_level = normalized

            except Exception as e:
                print(f"Audio read error: {e}")
                time.sleep(0.1)

    def stop(self):
        self._stop_event.set()
        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join()

        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
            self.stream = None

        self.pa.terminate()

    def get_level(self):
        return self.current_level

# ------------------------------------------------------------------------
# WebSocket broadcast logic
# ------------------------------------------------------------------------

# Track connected clients
connected_clients = set()

async def ws_handler(websocket):
    """
    Basic handler for each new client connection.
    We'll just store the connection in a global set. 
    (Ignoring inbound messages in this example.)
    """
    connected_clients.add(websocket)
    try:
        async for _ in websocket:
            pass  # We don't expect any inbound messages
    except:
        pass
    finally:
        connected_clients.remove(websocket)

async def broadcast_amplitude(monitor):
    """
    Periodically fetch the current amplitude and broadcast it to all clients as JSON.
    """
    while True:
        amplitude = monitor.get_level()
        data = {"amplitude": amplitude}
        remove_sockets = []
        for ws in connected_clients:
            try:
                await ws.send(json.dumps(data))
            except:
                remove_sockets.append(ws)
        # Remove any dead connections
        for ws in remove_sockets:
            connected_clients.remove(ws)

        # 20 times per second is plenty smooth; you can raise if you want it snappier
        await asyncio.sleep(0.05)

async def main():
    # 1) Start audio monitoring
    monitor = AudioLevelMonitorRolling(history_size=1000)
    monitor.start()

    # 2) Launch the WebSocket server (listening on ws://localhost:5678/)
    server = await websockets.serve(ws_handler, "0.0.0.0", 5678)
    print("WebSocket server running on ws://0.0.0.0:5678")

    # 3) Run forever: handle incoming connections & broadcast amplitude
    #    'server.wait_closed()' only returns if the server is shutting down,
    #    so we run it in parallel with 'broadcast_amplitude()'.
    await asyncio.gather(
        server.wait_closed(),
        broadcast_amplitude(monitor)
    )

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Shutting down.")
