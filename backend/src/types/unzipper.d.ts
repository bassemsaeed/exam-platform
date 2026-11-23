declare module "unzipper" {
  export interface ZipEntry {
    path: string;
    type: string;
    buffer(): Promise<Buffer>;
    stream(): NodeJS.ReadableStream;
  }
  export interface ZipDirectory {
    files: ZipEntry[];
  }
  const _default: { Open: { buffer(buf: Buffer): Promise<ZipDirectory> } };
  export default _default;
}
