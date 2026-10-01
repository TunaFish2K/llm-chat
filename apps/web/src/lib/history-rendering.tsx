import { createContext, useContext } from "react";

/** New rich content waits for shell animations; mounted content remains usable. */
export const HistoryRendering = createContext(true);
export function useHistoryRendering(): boolean { return useContext(HistoryRendering); }

