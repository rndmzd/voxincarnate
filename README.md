# Voxincarnate

A real-time audio visualization system that captures microphone input and displays it through various beautiful WebSocket-powered overlays.

## Features

- Real-time audio level monitoring with adaptive scaling
- WebSocket server for broadcasting audio levels
- Multiple visualization overlays:
  - AI Face: An expressive face that reacts to audio
  - Glowing Orb: A pulsating orb with dynamic glow effects
  - Morphing Gradient: Color gradients that shift with sound
  - Particle Field: Dynamic particle system that responds to audio
  - SVG Circle: Animated circle with color and size transitions
  - Wave: Siri-style wave animations
  - Audio Meter: Classic VU meter visualization
- OBS Integration: All overlays can be used as browser sources in OBS

## Requirements

- Python 3.7+
- PyAudio
- websockets
- numpy

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/voxincarnate.git
cd voxincarnate
```

2. Install dependencies:
```bash
pip install pyaudio websockets numpy
```

## Usage

1. Start the server:
```bash
python app.py
```

2. When prompted, select your audio input device from the list.

3. Open any of the visualization overlays in your web browser:
- `overlays/ai_face.html`
- `overlays/glowing_orb.html`
- `overlays/morphing_gradient.html`
- `overlays/particle_field.html`
- `overlays/svg_circle.html`
- `overlays/wave.html`
- `overlays/meter.html`

The visualizations will automatically connect to the WebSocket server and begin displaying your audio input.

### Using with OBS

All overlays can be added to OBS as browser sources:

1. In OBS, add a new "Browser" source to your scene
2. Set the URL to the local path of any overlay HTML file (e.g., `file:///path/to/voxincarnate/overlays/ai_face.html`)
3. Set an appropriate width and height for your overlay
4. Make sure the server (app.py) is running for the overlays to receive audio data

## How It Works

1. The Python backend uses PyAudio to capture real-time audio from your selected input device
2. Audio levels are processed using a rolling window for adaptive scaling
3. Processed audio levels are broadcast via WebSocket to any connected clients
4. HTML/JavaScript visualizations receive the audio data and animate accordingly

## Troubleshooting

- If you see "No input-capable devices found", check your system's audio settings
- If visualizations aren't responding, ensure the WebSocket server is running (python app.py)
- For connection issues, verify you're using `localhost:5678` and your firewall isn't blocking the connection

## License

MIT License - Feel free to use, modify, and distribute this code.