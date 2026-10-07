import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

/**
 * Like writeFileAtomic, but the bytes and the rename both reach the disk before
 * this resolves. Without the fsyncs a power loss can leave the renamed file
 * empty or bring back the previous one.
 */
export async function writeFileDurable(
  filePath: string,
  data: string,
  options: { mode: number },
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(tempPath, "w", options.mode);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(directory, "r");
  } catch (error) {
    if (process.platform === "win32" && isUnsupportedDirectorySync(error)) {
      // NTFS journals the rename; Windows cannot open a directory for fsync.
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "EINVAL" || code === "EPERM" || code === "EISDIR" || code === "ENOTSUP";
}
