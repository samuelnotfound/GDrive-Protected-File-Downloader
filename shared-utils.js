export function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
export function formatBytes(bytes) {
    const number = Number(bytes) || 0;
    if (number < 1024) return `${number} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = number;
    let unit = "B";
    for (const nextUnit of units) {
        if (value < 1024) break;
        value /= 1024;
        unit = nextUnit;
    }
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${unit}`;
}
