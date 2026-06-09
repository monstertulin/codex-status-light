import fs from "node:fs/promises";
import path from "node:path";

export async function writeSnapshotFile(filePath, snapshot) {
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await fs.mkdir(dirPath, { recursive: true });

  try {
    const currentPayload = await fs.readFile(filePath, "utf8");
    if (currentPayload === payload) {
      return false;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, filePath);
  return true;
}

export async function readSnapshotFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}
