# Google Drive View-Only PDF Downloader
A Chrome extension designed to bypass Google Drive's download restrictions on view-only PDF files.

Unlike a standard file download, this tool acts as a workaround. It captures the document's pages as they are rendered in the Google Drive viewer and stitches them together into a new PDF file. It then runs Optical Character Recognition (OCR) on each page, making the final downloaded PDF fully text-searchable.

## Installation 
1. Download and extract the extension's ZIP file.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Toggle on **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the extracted folder.

## Usage
- Open any view-only PDF in Google Drive.
- If the PDF was opened through Google Classroom, first click **File** → **Open** → **Open in new tab** to open it directly in Google Drive. Then click **File** → **Download View-Only PDF**.

## Credits

### OCR Engine
Text recognition is powered by [Tesseract.js](https://github.com/naptha/tesseract.js). All necessary OCR components are bundled directly into the extension, meaning it runs entirely locally on your machine without requiring external cloud services, subscriptions, or API keys.

This project was made possible by the foundational work of the following developers:

- [**zavierferodova**](https://github.com/zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader) — Base project
- [**mhsohan**](https://github.com/mhsohan/How-to-download-protected-view-only-files-from-google-drive-)
- [**zeltox**](https://github.com/zeltox/Google-Drive-PDF-Downloader)

## Disclaimer
This project was built with the assistance of AI tools in development, debugging, and documentation.

This extension is intended strictly for use with documents you are legally and ethically authorized to access and retain. Please respect the copyright, permissions, and terms of service associated with any file you download.










