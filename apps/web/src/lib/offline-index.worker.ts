import { computeOfflineIndex } from "./offline-index-compute";

self.onmessage = event => {
  const { id, snapshot } = event.data;
  self.postMessage({ id, index: computeOfflineIndex(snapshot) });
};
