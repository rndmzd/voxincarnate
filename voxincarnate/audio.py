"""Audio capture and per-character monitoring utilities."""

from __future__ import annotations

import logging
import sys
import threading
import time
from dataclasses import dataclass, replace
from typing import Optional

import numpy as np
import sounddevice as sd

from .configuration import CharacterConfig


@dataclass(slots=True)
class CharacterState:
    """Current visualization state for a single character."""

    id: str
    level: float = 0.0
    speaking: bool = False
    last_updated: float = 0.0


class CharacterMonitor:
    """Captures loopback audio for a character and computes smoothed levels."""

    def __init__(self, config: CharacterConfig):
        self.config = config
        self._device_index = self._resolve_device(config.audio_device)
        self._stream: Optional[sd.InputStream] = None
        self._lock = threading.Lock()
        self._state = CharacterState(id=config.id, last_updated=time.monotonic())
        self._block_duration_ms = (config.block_size / config.sample_rate) * 1000.0
        logging.info(
            "Monitor init | id=%s device=%s idx=%s block=%s rate=%s threshold=%.3f",
            config.id,
            config.audio_device,
            self._device_index,
            config.block_size,
            config.sample_rate,
            config.threshold,
        )

    @staticmethod
    def _resolve_device(name: str) -> int:
        devices = sd.query_devices()
        matches = [idx for idx, dev in enumerate(devices) if name.lower() in dev["name"].lower()]
        if not matches:
            raise RuntimeError(f"Audio device '{name}' was not found. Verify the device name via sounddevice.query_devices().")
        if len(matches) > 1:
            logging.warning("Multiple devices matched '%s'; using index %s (%s)", name, matches[0], devices[matches[0]]["name"])
        return matches[0]

    def start(self) -> None:
        if self._stream is not None:
            return

        kwargs = {
            "device": self._device_index,
            "samplerate": self.config.sample_rate,
            "blocksize": self.config.block_size,
            "dtype": "float32",
            "channels": 2,
            "callback": self._audio_callback,
        }

        if self.config.loopback and sys.platform.startswith("win"):
            kwargs["extra_settings"] = sd.WasapiSettings(loopback=True)

        self._stream = sd.InputStream(**kwargs)
        self._stream.start()
        logging.info("Started audio stream for %s", self.config.id)

    def stop(self) -> None:
        if self._stream is not None:
            logging.info("Stopping audio stream for %s", self.config.id)
            self._stream.stop()
            self._stream.close()
            self._stream = None

    def _audio_callback(self, indata, frames, time_info, status):  # pragma: no cover - realtime callback
        if status:
            logging.warning("Audio status for %s: %s", self.config.id, status)

        if frames == 0:
            return

        mono = np.mean(indata, axis=1)
        rms = float(np.sqrt(np.mean(np.square(mono))) or 0.0)
        self._update_state(rms)

    def _update_state(self, target_level: float) -> None:
        attack = max(self.config.attack_ms, 1)
        release = max(self.config.release_ms, 1)
        step = self._block_duration_ms / (attack if target_level > self._state.level else release)
        step = max(0.0, min(step, 1.0))

        with self._lock:
            new_level = self._state.level + (target_level - self._state.level) * step
            self._state.level = max(0.0, min(1.0, new_level))
            speaking = self._state.level >= self.config.threshold
            self._state.speaking = speaking
            self._state.last_updated = time.monotonic()

    def snapshot(self) -> CharacterState:
        with self._lock:
            return replace(self._state)


def start_monitors(characters: list[CharacterConfig]) -> list[CharacterMonitor]:
    monitors: list[CharacterMonitor] = []
    try:
        for cfg in characters:
            monitor = CharacterMonitor(cfg)
            monitor.start()
            monitors.append(monitor)
    except Exception:
        for monitor in monitors:
            monitor.stop()
        raise
    return monitors


def stop_monitors(monitors: list[CharacterMonitor]) -> None:
    for monitor in monitors:
        monitor.stop()
