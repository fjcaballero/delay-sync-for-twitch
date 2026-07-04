# Delay Sync for Twitch

Chrome extension that delays Twitch video and audio by a user-chosen number of seconds, entirely locally, to synchronize the stream with another source (TV, radio, PPV, another stream).

Typical use case: you are watching an event on TV and following a streamer's reaction on Twitch, but the Twitch stream runs ahead — set a delay and both stay in sync.

## Features

- **Full-size delayed playback**: the delayed video replaces the player at its exact size, in normal, theater and fullscreen modes.
- **Native controls keep working**: Twitch's own pause, volume, mute and seek act on the delayed output in real time.
- **Smooth start**: the live stream stays visible and audible while the delay buffer fills, with a countdown overlay; the switch is seamless.
- **On-page controls**: a compact panel integrated next to the channel's Follow button (plus the extension popup). The chosen delay is remembered.
- **Live adjustment**: lowering the delay skips ahead instantly using the existing buffer, no reload.
- **60 fps capture** via `requestVideoFrameCallback`, capped at 1280 px wide to keep memory in check.
- **100% local**: no data is collected or transmitted. No external requests.

## Installation

From source (until it is published on the Chrome Web Store):

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Open a Twitch stream, set the seconds in the panel next to the Follow button and click **Delay**.

## How it works

- **Video**: frames are captured from the `<video>` element into a ring buffer of `ImageBitmap`s, timestamped with the video's playback time, and drawn onto a canvas placed in the player's stacking layer (Twitch overlays stay on top). The original video keeps playing with `opacity: 0`.
- **Audio**: the element's audio is routed through a Web Audio `DelayNode` via `createMediaElementSource`. Volume/mute are applied on a post-delay `GainNode` so they take effect immediately instead of after the delay.

## Notes

- Memory usage grows with the delay: at 60 fps and 1280×720, a 5 s delay holds roughly 400+ frames in memory. Lower `MAX_CAPTURE_WIDTH` in `content.js` if your machine struggles.
- If Twitch replaces the video element (ads, channel change), press **Stop** and **Delay** again.

Not affiliated with or endorsed by Twitch Interactive, Inc.

## License

[MIT](LICENSE)
