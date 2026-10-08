# GDrive Protected File Downloader

**This does not remove permissions or bypass account restrictions.**

> [!WARNING]
> **Legal Disclaimer:** This tool is provided strictly for educational purposes and personal use. Users are entirely responsible for ensuring they have the legal right to save or download any content and must comply with Google Drive's Terms of Service. The creator of this repository assumes no liability for how this tool is used, nor any consequences resulting from its use.

## Features

- Automatically adds a **Download** button to the File menu when Google Drive’s normal download option is disabled
- Saves **view-only PDF** and **video** files as downloadable files
- Processes PDF pages and video streams **locally in the browser**

## How does it work?

### PDF

The extension captures each page as it is rendered in the Google Drive viewer, then builds a downloadable PDF from those page images.

### Video

Google Drive serves video and audio as separate streams to the video player. The extension detects those streams, downloads them, and merges them into a single MP4 file.

Support for additional file types is currently unplanned.

## Install

1. Download or unpack this extension folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extension folder.

## Usage

1. Open a view-only PDF or video on Google Drive.
2. Open the **File** menu.
3. Choose the extension’s **Download** item.
4. Follow the on-screen overlay (capture / quality picker / progress).

For files opened through Google Classroom, use **File → Open → Open in new tab** first, then use the Google Drive **File** menu.

## Known Issues

* PDF quality may appear blurry — Zoom the document to 200% or higher before capturing it for better quality.
* PDF capture may not complete — Do not close or leave the current tab while a capture is in progress.
* Video downloads may be extremely slow or fail — Refresh the current tab and try the download again.

For other unexpected problems, refreshing the current tab usually resolves them.

This is an experimental program and, like many experimental projects, it may still contain bugs and unexpected behavior. The current version was originally developed with AI assistance and contains some messy, overly complicated code. I plan to simplify and clean up the codebase in the future, but until then, this application is being provided as-is.

## Limitations

- PDF quality depends on the resolution Google Drive renders in the viewer.
- Large files can use significant memory and take longer to process.
- Video quality is limited to the streams and resolutions Drive actually exposes.
- Changes to Google Drive’s player, viewer, or network behavior may break compatibility.
- Leaving the PDF viewer tab mid-capture can still interrupt page capture.

## Credits

### References

- **[salauddinn/gdrive-video-downloader](https://github.com/salauddinn/gdrive-video-downloader)** — reference for the Google Drive video download flow (separate video/audio streams).
- **[zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader](https://github.com/zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader)** — reference for the PDF capture workflow.
  - **[mhsohan/How-to-download-protected-view-only-files-from-google-drive-](https://github.com/mhsohan/How-to-download-protected-view-only-files-from-google-drive-)**
  - **[zeltox/Google-Drive-PDF-Downloader](https://github.com/zeltox/Google-Drive-PDF-Downloader)**

### Bundled library

- **[mp4-remux](https://github.com/mscststs/mp4-remux)** — tiny pure-JS tool used to merge separate video and audio MP4 streams without re-encoding.

Please refer to those projects for their licenses, source, and notices.

## Disclaimer

- This project was built with assistance from AI tools during development, debugging, refactoring, and documentation.
- It does not remove access restrictions, bypass authentication, or grant access to files the user cannot already view.
- You are responsible for complying with Google Drive’s Terms of Service and applicable law.

This project is provided as-is.
