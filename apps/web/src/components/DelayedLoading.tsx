import { useEffect, useState, type ReactNode } from "react";

export function DelayedLoading({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 150); return () => clearTimeout(timer); }, []);
  return visible ? children : <div className="loading-placeholder" aria-busy="true" />;
}
