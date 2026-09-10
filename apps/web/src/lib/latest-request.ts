import { useCallback, useEffect, useRef } from "react";
/** A response is relevant only while its reader is mounted and no newer read has started. */
export function useLatestRequest() {
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  return useCallback(() => {
    const current = ++version.current;
    return () => version.current === current;
  }, []);
}
