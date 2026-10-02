/**
 * File System Access API の最小限の型 (Chrome / Edge。ローカルの boxglow.json を開いて監視・書き戻すために使う)
 */
interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}
interface FileSystemHandle {
  readonly kind: "file" | "directory";
  readonly name: string;
  queryPermission(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: "file";
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

/** ビルド日時 (vite.config.ts の define) */
declare const __BUILD__: string;

/** Vite の ?raw 読み込み (例の JSON を文字列で同梱する) */
declare module "*.json?raw" { const text: string; export default text; }
