# GDrive Current Media URL Finder

Minimal Chrome MV3 extension that shows the current Google Drive playback URLs.

It captures `videoplayback` requests for the active tab and reports the current video/audio `itag` values.

## Stream mode

The extension uses only the captured URLs and their declared codec metadata:

- `MUXED`: the current video URL contains both video and audio.
- `SEPARATE`: a distinct audio URL was captured, so audio and video are separate.
- `UNKNOWN`: neither condition is currently visible.

No byte-range downloads, container parsing, or itag lookup table are used.
