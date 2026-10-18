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
interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: "directory";
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
}
interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  /** 保存先を選んでファイルのハンドルを得る (Chrome / Edge。書き込みの許可も付く) */
  showSaveFilePicker?: (options?: { suggestedName?: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
  /** フォルダを選ばせる (Chrome / Edge。AI エージェントの設定 .mcp.json を、Claude Code で開くフォルダに直接書くために使う) */
  showDirectoryPicker?(options?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
}

/** ビルド日時 (vite.config.ts の define) */
declare const __BUILD__: string;

/** Vite の ?raw 読み込み (例の JSON を文字列で同梱する) */
declare module "*.json?raw" { const text: string; export default text; }

/** esbuild の text loader (CLI に文書を同梱する) */
declare module "*.md" { const text: string; export default text; }
