# Sound-specific mouth animation

Voxincarnate offers two character modes. Closed/open keeps the original energy-driven
sprite animation. Sound-specific mouths uses a bundled local HeadAudio classifier
and your labeled A-H/X images. Select the mode in the character builder and save.

## Try the included character

Choose **Try lip-sync demo** in the character library. This adds Signal with nine
original, transparent mouth drawings and selects it without replacing another
character. Select each pose in the builder to inspect it. Close the builder, choose
your audio source, and start audio. In assistant mode, only the embedded assistant's
captured output drives the mouth, as before. Add its separate audio capture in OBS.

## Prepare your own images

Each image is a full character frame, placed using its saved X/Y/scale. Use the same
canvas and stable character geometry for all images. Keep upper teeth anchored;
change the mouth rather than shifting the whole head. Prefer transparent PNGs for
cutouts. A keyed pose can contain multiple ordered frames, cycling at the character's
frame interval while that mouth shape is active.

| Pose | Drawing |
| --- | --- |
| A | Lips pressed closed for P/B/M |
| B | Slightly open, teeth visible; narrow vowels and many consonants |
| C | Medium open EH/AE; also the intermediate when opening wide |
| D | Wide open AH |
| E | Rounded OH |
| F | Puckered OO |
| G | Upper teeth against lower lip for F/V |
| H | Tongue raised for L and similar tongue sounds |
| X | Relaxed rest |

These labels follow [Rhubarb's artwork convention](https://github.com/DanielSWolf/rhubarb-lip-sync#mouth-shapes).
HeadAudio's finer acoustic labels are reduced into these nine drawings; they are
visual approximations, not a one-to-one phoneme transcript. Missing A/X artwork
falls back to closed images; other missing shapes use open images. The builder
shows completeness and can audition missing poses using those fallbacks.

## Transitions and timing

The studio and OBS use the same animation selector. It uses elapsed time, a short
stability window for vowel changes, and a C intermediate on closed-to-D openings.
Lip closures, Stop, disconnect, and idle interrupt that transition immediately.
Frames are predecoded, and a single image is shown at a time, preserving alpha and
avoiding doubled teeth from full-image opacity fades. For more fluid artwork,
author intermediate frames within the poses and use a shorter frame interval.

Analysis occurs alongside the existing audio-energy detector. The detector still
controls idle/noise behavior; an active voice can display A rather than being
forced to keep its mouth open. The audio branch emits no audible output. Normal
Sesame playback remains unchanged, and no compensating delay is introduced.

**Mouth threshold** controls both speech activation and the return to rest. Once
the displayed input level stays below it for **Mouth hold**, the avatar becomes
Idle and uses X/rest (or the closed-mouth fallback). Shorter pauses retain speech;
audio above the threshold resets the hold. Older libraries with a separate, lower
closing threshold use the visible mouth threshold too.
The default hold is 250 ms for new settings. Existing saved hold values are kept;
change **Mouth hold** and save to apply a different duration to your current setup.

The [HeadAudio author](https://github.com/met4citizen/HeadAudio) reports about
50-100 ms of processing latency. Capture, message delivery, and rendering add to
that. Evaluate the full path with an OBS recording before choosing an audio sync
offset. The existing state timestamp is for liveness; articulation also carries
an audio-relative acquisition cursor, resetting on a new capture session.

## Local processing and compatibility

Worklet code, the pretrained mixed English model, and licensing notices are bundled
with the application. No runtime CDN, API key, external inference service, or
transcription is required. The model is an MFCC/Gaussian-prototype classifier
trained upstream on synthetic voices; Sesame-specific accuracy has not been
established. Noise, overlapping speakers, music, laughter, and singing can produce
incorrect shapes. An unavailable analyzer displays a diagnostic and falls back to
closed/open animation. Restart audio to retry initialization.

Version 1 character libraries migrate to version 2 after artwork validation. The
original is retained as `library.json.v1.bak` beside the library (a unique additional
backup is used if a different v1 backup already exists). Existing character
IDs, artwork, settings, token, and OBS links are preserved. Old characters remain
in closed/open mode until you opt in. The optional demo is added only on request.
