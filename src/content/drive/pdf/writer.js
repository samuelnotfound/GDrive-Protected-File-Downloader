(() => {
    const app = window.__PSD;
    const pdf = app.pdfState;

    const report = (status, detail, percent = null) =>
        app.ui.updateInPageOverlay(status, detail, percent);

    function getDownloadFilename() {
        let title = document.querySelector('meta[itemprop="name"]')?.content || document.title || 'download.pdf';
        title = title.replace(/\s*-\s*Google Drive\s*$/i, '').trim();
        if (!/\.pdf$/i.test(title)) title += '.pdf';
        return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    }

    function createWriter(pageCount) {
        const textEncoder = new TextEncoder();
        const chunks = [];
        const offsets = new Array(3 + pageCount * 3).fill(0);
        let position = 0;

        const writeText = value => {
            const bytes = textEncoder.encode(value);
            chunks.push(bytes);
            position += bytes.length;
        };
        const writeBytes = bytes => {
            chunks.push(bytes);
            position += bytes.length;
        };
        const startObject = number => {
            offsets[number] = position;
            writeText(`${number} 0 obj\n`);
        };
        const endObject = () => writeText('\nendobj\n');
        const pageObject = index => 3 + index * 3;
        const imageObject = index => pageObject(index) + 1;
        const contentObject = index => pageObject(index) + 2;
        const objectCount = offsets.length - 1;

        writeText('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

        startObject(1);
        writeText('<< /Type /Catalog /Pages 2 0 R >>');
        endObject();

        startObject(2);
        const kids = Array.from({ length: pageCount }, (_, i) => `${pageObject(i)} 0 R`).join(' ');
        writeText(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
        endObject();

        return {
            addPage(index, image) {
                const pageRef = pageObject(index);
                const imageRef = imageObject(index);
                const contentRef = contentObject(index);

                startObject(pageRef);
                writeText(
                    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] ` +
                    `/Resources << /XObject << /Im${index + 1} ${imageRef} 0 R >> >> ` +
                    `/Contents ${contentRef} 0 R >>`
                );
                endObject();

                startObject(imageRef);
                writeText(
                    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
                    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
                    `/Length ${image.bytes.length} >>\nstream\n`
                );
                writeBytes(image.bytes);
                writeText('\nendstream');
                endObject();

                const content = `q\n${image.width} 0 0 ${image.height} 0 0 cm\n/Im${index + 1} Do\nQ\n`;
                const contentBytes = textEncoder.encode(content);

                startObject(contentRef);
                writeText(`<< /Length ${contentBytes.length} >>\nstream\n`);
                writeBytes(contentBytes);
                writeText('endstream');
                endObject();
            },

            finish() {
                const xrefPosition = position;
                writeText(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
                for (let i = 1; i <= objectCount; i++) {
                    writeText(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
                }
                writeText(
                    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n` +
                    `startxref\n${xrefPosition}\n%%EOF`
                );
                return new Blob(chunks, { type: 'application/pdf' });
            }
        };
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
    }

    async function generate(runId) {
        if (pdf.status === 'processing' || !pdf.capturedPages.size) return;
        if (runId !== pdf.runId || pdf.stopRequested) return;

        pdf.status = 'processing';
        app.ui.updateWindowControl();

        const pages = app.pdfCapture.getOrderedCapturedPages();
        const writer = createWriter(pages.length);

        app.ui.showScrollDim(false);
        const actions = document.querySelector('#psd-inpage-actions');
        const toggle = document.querySelector('#psd-inpage-toggle');
        if (actions) actions.style.display = 'flex';
        if (toggle) {
            toggle.style.display = 'block';
            toggle.disabled = false;
            toggle.textContent = 'Cancel';
        }

        try {
            for (let index = 0; index < pages.length; index++) {
                if (runId !== pdf.runId || pdf.stopRequested) return;

                report('Processing', `Processing page ${index + 1} / ${pages.length}`, 50 + (index / pages.length) * 50);
                writer.addPage(index, pages[index]);
            }

            if (runId !== pdf.runId || pdf.stopRequested) return;

            report('Preparing…', 'Finalizing the PDF file', 99);
            const url = URL.createObjectURL(writer.finish());
            const link = document.createElement('a');
            link.href = url;
            link.download = getDownloadFilename();
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);

            if (runId !== pdf.runId || pdf.stopRequested) return;

            pdf.status = 'completed';
            app.pdfCapture.resetCaptureState();
            app.ui.updateWindowControl();
            report('File downloaded', '', 100);
            showCompletedOverlay();
        } catch (error) {
            if (runId !== pdf.runId || pdf.stopRequested) return;

            pdf.status = 'idle';
            app.ui.updateWindowControl();
            report('PDF conversion failed', error.message || 'A page could not be converted.', 0);
            console.warn('[Drive Media Saver] PDF generation failed:', error);
        }
    }

    app.pdfWriter = { generate };
})();
