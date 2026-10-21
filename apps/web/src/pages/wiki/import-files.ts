import { unzip } from "fflate";

// Collects the files of a Markdown import, wherever they come from: the folder picker, a folder
// dragged onto the page, or a .zip. The picker is the browser's and the desktop's: some (a KDE
// file chooser through the desktop portal, for one) hand over only part of a folder's subfolders,
// so dropping the folder or choosing a .zip walks it here instead.

export type PickedFile = { path: string; file: File };
export type ImportFile = { path: string; content: string; size: number };

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;
const ZIP_EXTENSION = /\.zip$/i;

export function isMarkdown(path: string) {
  return MARKDOWN_EXTENSION.test(path);
}

export function isZip(path: string) {
  return ZIP_EXTENSION.test(path);
}

function readAll(reader: FileSystemDirectoryReader) {
  // readEntries returns a batch at a time (100 in Chromium): read until it is empty.
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
        } else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, out: PickedFile[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ path: entry.fullPath.replace(/^\//, ""), file });
  } else if (entry.isDirectory) {
    for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) {
      await walk(child, out);
    }
  }
}

// What was dropped: folders are walked to the bottom, files taken as they are.
export async function droppedFiles(transfer: DataTransfer): Promise<PickedFile[]> {
  // Entries must be taken before the first await: the drop data is gone after it.
  const entries = [...transfer.items]
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  const out: PickedFile[] = [];
  for (const entry of entries) {
    await walk(entry, out);
  }
  return out;
}

export function pickedFiles(list: FileList | null): PickedFile[] {
  return [...(list ?? [])].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

async function zipEntries(zip: File): Promise<ImportFile[]> {
  const data = new Uint8Array(await zip.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(data, { filter: (entry) => isMarkdown(entry.name) }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  const decoder = new TextDecoder();
  return Object.entries(entries).map(([path, bytes]) => ({
    path,
    content: decoder.decode(bytes),
    size: bytes.byteLength,
  }));
}

// The Markdown files among the picked ones, .zip archives opened, and how many others were left.
export async function readImportFiles(picked: PickedFile[]) {
  const files: ImportFile[] = [];
  let ignored = 0;
  for (const { path, file } of picked) {
    if (isMarkdown(path)) {
      files.push({ path, content: await file.text(), size: file.size });
    } else if (isZip(path)) {
      files.push(...(await zipEntries(file)));
    } else {
      ignored++;
    }
  }
  return { files, ignored };
}
