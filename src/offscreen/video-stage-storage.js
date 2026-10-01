(() => {
    const ROOT_DIR = 'gdrive-video-stage';

    if (!navigator.storage?.getDirectory) {
        throw new Error('Origin Private File System is not available in this browser.');
    }

    const rootPromise = navigator.storage.getDirectory();

    function safeJobName(jobId) {
        return `job-${String(jobId || '').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    }

    async function getRootDirectory() {
        return await rootPromise;
    }

    async function getJobDirectory(jobId, create = true) {
        const root = await getRootDirectory();
        const stageRoot = await root.getDirectoryHandle(ROOT_DIR, { create: true });
        return await stageRoot.getDirectoryHandle(safeJobName(jobId), { create });
    }

    async function openWriter(jobId, label) {
        const dir = await getJobDirectory(jobId, true);
        const handle = await dir.getFileHandle(`${String(label)}.bin`, { create: true });
        // keepExistingData:false truncates the temporary file at the start of a run.
        const writable = await handle.createWritable({ keepExistingData: false });
        return writable;
    }

    async function getFile(jobId, label, type = '') {
        const dir = await getJobDirectory(jobId, false);
        const handle = await dir.getFileHandle(`${String(label)}.bin`, { create: false });
        const file = await handle.getFile();
        if (!type || file.type === type) return file;
        return new File([file], file.name, { type });
    }

    async function getSize(jobId, label) {
        const file = await getFile(jobId, label);
        return file.size;
    }

    async function openReadStream(jobId, label) {
        const file = await getFile(jobId, label);
        return file.stream();
    }

    async function removeStream(jobId, label) {
        try {
            const dir = await getJobDirectory(jobId, false);
            await dir.removeEntry(`${String(label)}.bin`);
        } catch (error) {
            if (error?.name !== 'NotFoundError') throw error;
        }
    }

    async function removeJob(jobId) {
        try {
            const root = await getRootDirectory();
            const stageRoot = await root.getDirectoryHandle(ROOT_DIR, { create: true });
            await stageRoot.removeEntry(safeJobName(jobId), { recursive: true });
        } catch (error) {
            if (error?.name !== 'NotFoundError') throw error;
        }
    }

    self.GDriveVideoStageStorage = Object.freeze({
        openWriter,
        getFile,
        getSize,
        openReadStream,
        removeStream,
        removeJob
    });
})();
