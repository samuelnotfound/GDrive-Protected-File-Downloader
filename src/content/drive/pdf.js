
(() => {
    if (!window.__PSD_LOADED || window.__PSD_PDF_LOADED) return;
    window.__PSD_PDF_LOADED = true;

    const app = window.__PSD;
    const pdf = app.pdfState;
    const MENU_ID = app.ids.pdfMenu;

    function looksLikePDFName(value = '') {
        return /\.pdf(?:$|[?#])/i.test(value) || /\bpdf\b/i.test(value) && /\.pdf\b/i.test(value);
    }

    function currentDriveFileIsPDF() {
        if (!location.hostname.endsWith('drive.google.com')) return false;

        if (looksLikePDFName(document.title || '')) return true;

        const info = document.querySelector('#drive-active-item-info');
        if (info?.textContent) {
            try {
                const data = JSON.parse(info.textContent);
                const mime = data?.mimeType || data?.mime_type || '';
                if (/application\/pdf/i.test(mime) || looksLikePDFName(data?.title || '')) return true;
            } catch (_) {}
        }

        return !!document.querySelector('[aria-label*=".pdf" i], [title*=".pdf" i], [data-tooltip*=".pdf" i]');
    }

    function activateProtectedPDFDownload(event) {
        event.preventDefault();
        event.stopPropagation();
        app.ui.closeDriveFileMenu();
        app.ui.showInPageOverlay(true);

        const root = document.getElementById('psd-inpage-overlay');
        root?.classList.remove('quiet', 'idle', 'completed', 'cancelled');
        root?.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Preparing download'));
        root?.querySelector('#psd-inpage-detail')?.replaceChildren(document.createTextNode(''));

        void start();
    }

    function scanMenu(menu) {
        if (!app.isDrivePage() || !document.body || !currentDriveFileIsPDF()) return;
        if (menu.querySelector(`#${MENU_ID}`)) return;

        const nativeDownload = app.ui.findMenuRow(menu, 'Download');
        const nativeDisabled = nativeDownload && (
            nativeDownload.getAttribute('aria-disabled') === 'true' ||
            nativeDownload.hasAttribute('disabled') ||
            nativeDownload.dataset.disabled === 'true' ||
            nativeDownload.classList.contains('disabled')
        );

        if (nativeDownload && !nativeDisabled) return;

        const templateRow =
            app.ui.findMenuRow(menu, 'Details') ||
            app.ui.findMenuRow(menu, 'Add to starred') ||
            app.ui.findMenuRow(menu, 'Security limitations') ||
            nativeDownload;

        if (!templateRow) return;

        const item = app.ui.makeStandaloneMenuRow(templateRow, MENU_ID, 'Download');
        if (!item) return;

        app.ui.setDownloadMenuItemIcon(item);
        app.ui.styleDownloadMenuItem(item);
        app.ui.addMenuDescription(
            item,
            'psd-pdf-menu-label',
            'psd-pdf-menu-info',
            'GDrive Protected File Downloader'
        );
        item.addEventListener('click', activateProtectedPDFDownload);
        app.ui.handleMenuKeyboardActivation(item, activateProtectedPDFDownload);
        app.ui.insertAfterReference(menu, item, app.ui.findShareRow(menu));
    }

    async function start() {
        if (pdf.status === 'capturing' || pdf.status === 'processing') return;
        pdf.status = 'idle';
        app.pdfCapture.resetProgressUI();
        await app.pdfCapture.prepare();
    }

    function cancel() {
        if (pdf.status !== 'capturing' && pdf.status !== 'processing') return;
        pdf.stopRequested = true;
        void app.pdfOcr.shutdown();
    }

    app.pdf = {
        currentDriveFileIsPDF,
        start,
        cancel,
        scanMenu
    };
})();
