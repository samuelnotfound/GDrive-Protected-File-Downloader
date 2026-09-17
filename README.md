# GDrive Protected File Downloader

A Chrome extension that adds a download button to Google Drive files that have the normal Download option disabled. The extension does not remove permissions or bypass account restrictions.

## Features

- Adds a **Download** button when the normal Google Drive download option is disabled.
- Saves **view-only PDF and video files** as downloadable files.
- Makes generated PDFs **text-searchable using OCR**.
- Processes PDF content and video files locally in the browser.
- Runs directly as a Chrome extension.

## How does it work?

This tool is a workaround for content that your browser can already view. It does not directly download the original protected file.

When the extension detects that downloading is disabled and that the file type is supported, it adds a custom download button to the Google Drive interface and processes the content according to its file type.

### PDF

The extension captures the pages as they are rendered in the Google Drive viewer and combines them into a new PDF file. When OCR is enabled, it reads the text from each captured page and adds searchable text to the generated PDF.

### Video

When a video is played, Google Drive provides the video and audio separately to the video player. The extension detects those streams, downloads them, and automatically combines them into a single video file using FFmpeg.

Support for additional file types is currently unplanned.

## Installation

1. Download and extract the extension's ZIP file.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the extracted extension folder.
6. The extension should now appear in your Chrome extensions list.

## Usage

### PDF

1. Open a **view-only PDF** in Google Drive.
2. If the PDF was opened through Google Classroom, select **File** → **Open** → **Open in new tab** to open it directly in Google Drive.
3. Open the **File** menu.
4. Select **Download View-Only PDF**.
5. The extension will begin capturing and processing the rendered pages.
6. Once processing is complete, the generated PDF will be downloaded.

### Video

1. Open a **view-only video** in Google Drive.
2. Start the video player.
3. Open the player's **Settings**.
4. Select **Quality**.
5. Choose your preferred resolution.
6. Start the download using the extension.

> **Important:** The downloader uses the video quality provided by the Google Drive player. Select your preferred resolution **before starting the download** so the downloader receives the intended quality.

## Limitations

- PDF output quality depends on the resolution and rendering quality provided by Google Drive.
- OCR accuracy depends on the clarity, resolution, language, and formatting of the rendered pages.
- Processing large files can use noticeable system resources and may take some time.
- Video download quality is limited to the streams and resolutions made available by Google Drive.
- Changes to Google Drive's player, viewer, or internal behavior may affect compatibility.

## Credits

- **[salauddinn/gdrive-video-downloader](https://github.com/salauddinn/gdrive-video-downloader)** — reference material for the Google Drive video download workflow, including handling separate video and audio streams.
- **[zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader](https://github.com/zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader)** — reference material for the Google Drive view-only PDF workflow used by this project.
  - **[mhsohan/How-to-download-protected-view-only-files-from-google-drive-](https://github.com/mhsohan/How-to-download-protected-view-only-files-from-google-drive-)**
  - **[zeltox/Google-Drive-PDF-Downloader](https://github.com/zeltox/Google-Drive-PDF-Downloader)**

- **[Tesseract.js](https://github.com/naptha/tesseract.js)** — bundled engine used for client-side OCR.
- **[FFmpeg WebAssembly](https://www.npmjs.com/package/@ffmpeg/core)** — bundled media processor used to combine separate video and audio streams into a single file.

Please refer to the original projects for their licenses, source code, and notices.

## Disclaimer

- This project was built with the assistance of AI tools during development, debugging, refactoring, and documentation.
- It does not remove access restrictions, bypass authentication, or grant access to files that the user cannot already view.
- Do not use this extension to circumvent access controls, permissions, copyright restrictions, or other restrictions imposed by the owner of a file.
- You are responsible for complying with Google Drive's Terms of Service and any applicable copyright, privacy, and other laws.

This project is provided as-is.
