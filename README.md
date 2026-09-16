# GDrive Protected File Downloader

A Chrome extension that adds download button on google drive files that has the download option disabled. The extension does not remove permissions, nor bypass account restrictions.

## Features

- Integrates "Download" button when download option is disbled for the file
- Save view-only PDF and video file
- Make generated PDFs text-searchable using OCR
- Process PDF content and video saving locally in the browser
- Runs directly as a Chrome extension

## How it works?

This tool acts as a workaround and does not download the actual file. When the extension detects that 1) downloading is disabled for the file and (2) the file type is supported by the extension, it injects a custom download button into the Google Drive interface and processes the content according to its file type.

### PDF

It captures the document's pages as they are rendered in the Google Drive viewer and stitches them together into a new PDF file. It then runs Optical Character Recognition (OCR) on each page, making the final downloaded PDF fully text-searchable.

### Video

When a video is played, audio and video streams are provided separately to the player. The extension intercepts those stream URLs, downloads them, and automatically combines them into a single video file using FFmpeg.

Support for additional file types is currently unplanned.

## Installation

1. Download and extract the extension's ZIP file.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the extracted extension folder.
6. The extension should now appear in your Chrome extensions list.

## Tests

The regression tests use Node's built-in test runner and require no package installation:

```bash
node --test tests/*.test.js
```

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

> **Important:** The downloader uses the video quality provided by the Google Drive player. Select your preferred resolution **before starting the download** to ensure the downloader receives the intended quality.

## Limitations

- PDF output quality depends on the resolution and rendering quality provided by Google Drive.
- OCR accuracy depends on the clarity, resolution, language, and formatting of the rendered pages.
- Processing large files can take noticeable time and system resources.
- Video download quality is limited to the streams and resolutions made available by Google Drive.
- Changes to Google Drive’s player or internal code may affect compatibility.

## Credits

- **[Tesseract.js](https://github.com/naptha/tesseract.js):** Bundled engine for client-side text recognition.

* **[FFmpeg WebAssembly](https://www.npmjs.com/package/@ffmpeg/core):** Bundled media processor to merge separate video and audio streams.

* **[zavierferodova](https://github.com/zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader)**
* **[mhsohan](https://github.com/mhsohan/How-to-download-protected-view-only-files-from-google-drive-)**
* **[zeltox](https://github.com/zeltox/Google-Drive-PDF-Downloader)**

## Disclaimer

- This project was built with the assistance of AI tools during development, debugging, refactoring, and documentation.
- It does not remove access restrictions, bypass authentication, or grant access to files that the user cannot already view.
- Do not use this extension to circumvent access controls, permissions, copyright restrictions, or other restrictions imposed by the owner of a file.
- Please respect the copyright, permissions, privacy, and terms of service associated with any content you access or download.
