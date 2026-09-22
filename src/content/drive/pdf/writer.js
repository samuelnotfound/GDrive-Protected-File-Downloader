
(() => {
    const app = window.__PSD;
    const pdf = app.pdfState;
    const MIN_W = 500;
    const MIN_H = 300;

    function reportProgress(status, detail, percent = null) {
        app.ui.updateInPageOverlay(status, detail, percent);
    }

    function getDownloadFilename() {
        let title = document.querySelector('meta[itemprop="name"]')?.content ||
            document.title ||
            'download.pdf';

        title = title.replace(/\s*-\s*Google Drive\s*$/i, '').trim();
        if (!/\.pdf$/i.test(title)) title += '.pdf';
        return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    }

    async function loadImage(page) {
        const current = page.image;
        const currentSrc = current?.currentSrc || current?.src || '';

        if (
            current &&
            currentSrc === page.src &&
            current.complete &&
            current.naturalWidth >= MIN_W &&
            current.naturalHeight >= MIN_H
        ) return current;

        const image = new Image();
        image.decoding = 'async';

        const loaded = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timed out loading page ${page.pageNumber || 'unknown'}`)),
                5000
            );
            image.onload = () => {
                clearTimeout(timer);
                resolve();
            };
            image.onerror = () => {
                clearTimeout(timer);
                reject(new Error(`Could not load page ${page.pageNumber || 'unknown'}`));
            };
        });

        image.src = page.src;
        if (!image.complete) await loaded;

        if (image.naturalWidth < MIN_W || image.naturalHeight < MIN_H) {
            throw new Error(`Invalid page image: ${page.pageNumber || 'unknown'}`);
        }

        return image;
    }

    async function encodePageAsJPEG(page) {
        if (pdf.stopRequested) throw new Error('PDF generation cancelled.');

        const image = await loadImage(page);
        if (pdf.stopRequested) throw new Error('PDF generation cancelled.');

        const canvas = document.createElement('canvas');
        canvas.width = page.w;
        canvas.height = page.h;

        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context) {
            throw new Error(`Could not create canvas for page ${page.pageNumber || 'unknown'}`);
        }

        context.drawImage(image, 0, 0, page.w, page.h);

        const blob = await new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timed out encoding page ${page.pageNumber || 'unknown'}`)),
                10000
            );

            canvas.toBlob(result => {
                clearTimeout(timer);
                result
                    ? resolve(result)
                    : reject(new Error(`JPEG encoding failed on page ${page.pageNumber || 'unknown'}`));
            }, 'image/jpeg', 0.92);
        });

        canvas.width = canvas.height = 1;
        page.image = null;

        return {
            bytes: new Uint8Array(await blob.arrayBuffer()),
            width: page.w,
            height: page.h
        };
    }

    function pdfEscapeText(text) {
        return String(text)
            .replace(/\\/g, '\\\\')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/[\r\n]+/g, ' ');
    }

    function makeWriter(total) {
        const chunks = [];
        const enc = new TextEncoder();
        let position = 0;

        const writeBytes = bytes => {
            chunks.push(bytes);
            position += bytes.length;
        };
        const writeString = value => writeBytes(enc.encode(value));
        const pageObject = index => 3 + index * 3;
        const imageObject = index => 4 + index * 3;
        const contentObject = index => 5 + index * 3;
        const fontObject = 3 + total * 3;
        const maxObject = fontObject;
        const xref = new Array(maxObject + 1).fill(0);

        const beginObject = number => {
            xref[number] = position;
            writeString(`${number} 0 obj\n`);
        };
        const endObject = () => writeString('\nendobj\n');

        writeString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

        beginObject(1);
        writeString('<< /Type /Catalog /Pages 2 0 R >>');
        endObject();

        beginObject(2);
        writeString(
            `<< /Type /Pages /Kids [${Array.from(
                { length: total },
                (_, index) => `${pageObject(index)} 0 R`
            ).join(' ')}] /Count ${total} >>`
        );
        endObject();

        return {
            addPage(index, image) {
                const { width, height, bytes, words } = image;

                beginObject(pageObject(index));
                writeString(
                    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
                    `/Resources << /XObject << /Im${index + 1} ${imageObject(index)} 0 R >> ` +
                    `/Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject(index)} 0 R >>`
                );
                endObject();

                beginObject(imageObject(index));
                writeString(
                    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
                    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
                    `/Length ${bytes.length} >>\nstream\n`
                );
                writeBytes(bytes);
                writeString('\nendstream');
                endObject();

                let content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im${index + 1} Do\nQ\n`;

                if (Array.isArray(words) && words.length) {
                    content += 'BT\n/F1 10 Tf\n3 Tr\n';
                    for (const word of words) {
                        const height = Math.max(4, word.y1 - word.y0);
                        const size = Math.max(4, Math.min(72, height * 0.9));
                        const x = word.x0;
                        const y = image.height - word.y1 + Math.max(0, height * 0.12);

                        content +=
                            `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n` +
                            `/F1 ${size.toFixed(2)} Tf\n` +
                            `(${pdfEscapeText(word.text)}) Tj\n`;
                    }
                    content += '0 Tr\nET\n';
                }

                const contentBytes = enc.encode(content);
                beginObject(contentObject(index));
                writeString(`<< /Length ${contentBytes.length} >>\nstream\n`);
                writeBytes(contentBytes);
                writeString('endstream');
                endObject();
            },

            finish() {
                beginObject(fontObject);
                writeString('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
                endObject();

                const xrefPosition = position;
                writeString(`xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`);

                for (let number = 1; number <= maxObject; number++) {
                    writeString(`${String(xref[number]).padStart(10, '0')} 00000 n \n`);
                }

                writeString(
                    `trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\n` +
                    `startxref\n${xrefPosition}\n%%EOF`
                );

                return new Blob(chunks, { type: 'application/pdf' });
            }
        };
    }

    async function convertPage(writer, page, index, total) {
        const jpeg = await encodePageAsJPEG(page);

        reportProgress(
            'Preparing…',
            `OCR page ${index + 1} / ${total}`,
            50 + ((index / total) * 50)
        );

        let words = [];
        try {
            words = await app.pdfOcr.run(jpeg.bytes.slice(), index, total);
        } catch (error) {
            console.warn('[GDrive PDF] OCR failed for page', index + 1, error);
        }

        writer.addPage(index, {
            width: jpeg.width,
            height: jpeg.height,
            bytes: jpeg.bytes,
            words
        });
    }

    function showCompletedOverlay() {
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.remove('cancelled', 'unsupported');
        root.classList.add('completed');

        root.querySelector('#psd-inpage-spinner')?.style.setProperty('display', 'none');
        root.querySelector('#psd-inpage-check')?.style.setProperty('display', 'block');
        root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');
        root.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('File downloaded'));
        root.querySelector('#psd-inpage-detail')?.replaceChildren();
        app.ui.updateWindowControl();
    }

    async function finish(writer) {
        reportProgress('Preparing…', 'Finalizing the PDF file', 99);
        await app.pdfOcr.shutdown();

        const blob = writer.finish();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = getDownloadFilename();
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);

        pdf.status = 'completed';
        app.pdfCapture.resetCaptureState();
        app.ui.updateWindowControl();
        reportProgress('File downloaded', '', 100);
        showCompletedOverlay();
    }

    async function convertPages(writer, pages) {
        let converted = 0;
        let error = null;

        reportProgress('Preparing…', `OCR page 1 / ${pages.length}`, 50);
        for (let index = 0; index < pages.length; index++) {
            if (pdf.stopRequested) break;

            try {
                await convertPage(writer, pages[index], index, pages.length);
                converted++;
                reportProgress(
                    'Preparing…',
                    `OCR page ${index + 1} / ${pages.length}`,
                    50 + ((index + 1) / pages.length) * 50
                );
            } catch (conversionError) {
                error = conversionError;
                break;
            }
        }
        return { converted, error };
    }

    async function handleGenerationFailure(pages, converted, error) {
        pdf.status = 'idle';
        app.ui.updateWindowControl();
        await app.pdfOcr.shutdown();

        if (pdf.stopRequested) {
            app.pdfCapture.finishCancelledCapture();
            return;
        }

        reportProgress(
            'PDF conversion failed',
            `Page ${converted + 1} of ${pages.length}: ${error?.message || 'A page could not be converted.'}`,
            Math.floor(converted / Math.max(1, pages.length) * 100)
        );
        document.getElementById('psd-inpage-overlay')?.classList.remove('completed', 'cancelled');
    }

    async function generate() {
        if (
            pdf.status === 'capturing' ||
            pdf.status === 'processing' ||
            (!pdf.capturedPages.size && !pdf.pages.size)
        ) return;

        pdf.status = 'processing';
        pdf.stopRequested = false;
        document.getElementById('psd-inpage-overlay')?.classList.remove('quiet', 'idle');
        app.ui.updateWindowControl();

        const pages = app.pdfCapture.getOrderedCapturedPages();
        const writer = makeWriter(pages.length);
        const result = await convertPages(writer, pages);

        if (pdf.stopRequested || result.converted !== pages.length) {
            await handleGenerationFailure(pages, result.converted, result.error);
            return;
        }

        await finish(writer);
    }

    app.pdfWriter = { generate };
})();
