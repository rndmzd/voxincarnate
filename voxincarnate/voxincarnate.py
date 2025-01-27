import asyncio
import websockets
import json
import time
from collections import deque
import pyaudio
import numpy as np
import threading
import logging

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

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
        self.peak_history = deque(maxlen=history_size)
        logging.info(f"Initializing Rolling Monitor (device: {device_index}, chunk: {chunk_size}, rate: {sample_rate}, history: {history_size})")

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
        logging.info("Rolling Monitor: Starting audio monitoring loop")
        last_log_time = time.time()
        samples_since_log = 0
        total_amplitude = 0
        
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
                
                # Accumulate stats for periodic logging
                samples_since_log += 1
                total_amplitude += normalized
                
                # Log stats every second
                current_time = time.time()
                if current_time - last_log_time >= 1.0:
                    avg_amplitude = total_amplitude / samples_since_log
                    logging.info(f"Rolling Monitor Stats - Avg Level: {avg_amplitude:.3f}, History Size: {len(self.peak_history)}")
                    last_log_time = current_time
                    samples_since_log = 0
                    total_amplitude = 0

            except Exception as e:
                logging.error(f"Audio read error: {e}")
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
    """
    client_id = id(websocket)
    logging.info(f"New WebSocket connection established (ID: {client_id})")
    connected_clients.add(websocket)
    try:
        async for _ in websocket:
            pass  # We don't expect any inbound messages
    except Exception as e:
        logging.error(f"WebSocket error for client {client_id}: {e}")
    finally:
        connected_clients.remove(websocket)
        logging.info(f"WebSocket connection closed (ID: {client_id})")

async def broadcast_amplitude(monitor):
    """
    Periodically fetch the current amplitude and broadcast it to all clients as JSON.
    """
    logging.info("Starting amplitude broadcast")
    last_log_time = time.time()
    messages_sent = 0
    total_amplitude = 0
    
    while True:
        amplitude = monitor.get_level()
        data = {"amplitude": amplitude}
        remove_sockets = []
        active_clients = len(connected_clients)
        
        for ws in set(connected_clients):
            try:
                await ws.send(json.dumps(data))
                messages_sent += 1
                total_amplitude += amplitude
            except Exception as e:
                logging.error(f"Failed to send to client {id(ws)}: {e}")
                remove_sockets.append(ws)
        
        for ws in remove_sockets:
            if ws in connected_clients:
                connected_clients.remove(ws)
                logging.info(f"Removed disconnected client {id(ws)}")

        # Log broadcast stats every second
        current_time = time.time()
        if current_time - last_log_time >= 1.0:
            if messages_sent > 0:
                avg_amplitude = total_amplitude / messages_sent
                logging.info(f"Broadcast Stats - Clients: {active_clients}, Messages: {messages_sent}, Avg Amplitude: {avg_amplitude:.3f}")
            last_log_time = current_time
            messages_sent = 0
            total_amplitude = 0

        await asyncio.sleep(0.05)  # 20 times per second

async def start_monitor():
    logging.info("Starting VoxIncarnate")
    monitor = AudioLevelMonitorRolling(history_size=1000)
    monitor.start()

    server = await websockets.serve(ws_handler, "0.0.0.0", 5678)
    logging.info("WebSocket server running on ws://0.0.0.0:5678")

    try:
        await asyncio.gather(
            server.wait_closed(),
            broadcast_amplitude(monitor)
        )
    except Exception as e:
        logging.error(f"Server error: {e}")
    finally:
        logging.info("Shutting down server")

if __name__ == "__main__":
    try:
        asyncio.run(start_monitor())
    except KeyboardInterrupt:
        print("Shutting down.")
