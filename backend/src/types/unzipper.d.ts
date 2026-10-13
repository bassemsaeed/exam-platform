declare module "unzipper" {
  export interface ZipEntry {
    path: string;
    type: string;
    buffer(): Promise<Buffer>;
  }
  export interface ZipDirectory {
    files: ZipEntry[];
  }
  const _default: { Open: { buffer(buf: Buffer): Promise<ZipDirectory> } };
  export default _default;
}
