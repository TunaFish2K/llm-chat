import { hashFile } from "./file-hash";
self.onmessage = (event: MessageEvent<File>) => {
  void hashFile(event.data, (bytes) => self.postMessage({ bytes }))
    .then((sha256) => self.postMessage({ sha256 }), () => self.postMessage({ error: true }));
};
