"""Configuration utilities for the VoxIncarnate audio server."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass(slots=True)
class OverlaySprites:
    open: List[str] = field(default_factory=list)
    closed: List[str] = field(default_factory=list)


@dataclass(slots=True)
class OverlayLayout:
    mode: str = "absolute"
    left: Optional[str] = None
    right: Optional[str] = None
    top: Optional[str] = None
    bottom: Optional[str] = None
    width: Optional[str] = None
    height: Optional[str] = None


@dataclass(slots=True)
class OverlayConfig:
    label: str
    sprites: OverlaySprites
    idle_swap_ms: int = 1500
    layout: OverlayLayout = field(default_factory=OverlayLayout)


@dataclass(slots=True)
class CharacterConfig:
    id: str
    audio_device: str
    loopback: bool = False
    threshold: float = 0.02
    attack_ms: int = 45
    release_ms: int = 140
    block_size: int = 2048
    sample_rate: int = 48000
    overlay: Optional[OverlayConfig] = None


@dataclass(slots=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    broadcast_fps: int = 30


@dataclass(slots=True)
class AppConfig:
    server: ServerConfig
    characters: List[CharacterConfig]


def _parse_overlay(data: Dict[str, Any]) -> OverlayConfig:
    sprites = data.get("sprites", {})
    layout = data.get("layout", {})
    return OverlayConfig(
        label=data.get("label", "Character"),
        sprites=OverlaySprites(
            open=list(sprites.get("open", [])),
            closed=list(sprites.get("closed", [])),
        ),
        idle_swap_ms=int(data.get("idle_swap_ms", 1500)),
        layout=OverlayLayout(
            mode=layout.get("mode", "absolute"),
            left=layout.get("left"),
            right=layout.get("right"),
            top=layout.get("top"),
            bottom=layout.get("bottom"),
            width=layout.get("width"),
            height=layout.get("height"),
        ),
    )


def _parse_character(data: Dict[str, Any]) -> CharacterConfig:
    overlay = data.get("overlay")
    overlay_cfg = _parse_overlay(overlay) if overlay else None
    return CharacterConfig(
        id=data["id"],
        audio_device=data["audio_device"],
        loopback=bool(data.get("loopback", False)),
        threshold=float(data.get("threshold", 0.02)),
        attack_ms=int(data.get("attack_ms", 45)),
        release_ms=int(data.get("release_ms", 140)),
        block_size=int(data.get("block_size", 2048)),
        sample_rate=int(data.get("sample_rate", 48000)),
        overlay=overlay_cfg,
    )


def load_config(path: Optional[Path] = None) -> AppConfig:
    """Load the application configuration from disk."""

    if path is None:
        path = Path(__file__).resolve().parents[1] / "config" / "characters.json"

    with path.open("r", encoding="utf-8") as fp:
        payload = json.load(fp)

    server_data = payload.get("server", {})
    characters = payload.get("characters", [])

    if not characters:
        raise ValueError("No characters defined in configuration. Add at least one entry under 'characters'.")

    server_cfg = ServerConfig(
        host=server_data.get("host", "127.0.0.1"),
        port=int(server_data.get("port", 8765)),
        broadcast_fps=int(server_data.get("broadcast_fps", 30)),
    )

    character_cfgs = [_parse_character(item) for item in characters]

    return AppConfig(server=server_cfg, characters=character_cfgs)
