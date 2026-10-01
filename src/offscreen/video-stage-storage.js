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


    async function cleanupStaleJobs(maxAgeMs = 2 * 60 * 60 * 1000, protectedJobIds = []) {
        const protectedNames = new Set((Array.isArray(protectedJobIds) ? protectedJobIds : []).map(safeJobName));
        const cutoff = Date.now() - Math.max(60_000, Number(maxAgeMs) || 0);
        const root = await getRootDirectory();
        let stageRoot;
        try {
            stageRoot = await root.getDirectoryHandle(ROOT_DIR, { create: false });
        } catch (error) {
            if (error?.name === 'NotFoundError') return 0;
            throw error;
        }

        let removed = 0;
        for await (const [name, handle] of stageRoot.entries()) {
            if (!handle || handle.kind !== 'directory') continue;
            if (protectedNames.has(String(name))) continue;
            // Current jobs are named job-gdrive-video-<timestamp>-<random>.
            const match = String(name).match(/^job-gdrive-video-(\d+)-/i);
            if (!match) continue;
            const createdAt = Number(match[1]);
            if (!Number.isSafeInteger(createdAt) || createdAt >= cutoff) continue;
            try {
                await stageRoot.removeEntry(name, { recursive: true });
                removed++;
            } catch (error) {
                if (error?.name !== 'NotFoundError') throw error;
            }
        }
        return removed;
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
        removeJob,
        cleanupStaleJobs
    });
})();
