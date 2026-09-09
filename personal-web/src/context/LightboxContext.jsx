import { createContext, useContext, useState, useCallback } from "react";

const LightboxContext = createContext({ open: () => {} });
export const useLightbox = () => useContext(LightboxContext);

// Holds the currently-enlarged image group. For stepper groups a shared `store` drives navigation
// (and completion) so the inline stepper and the lightbox stay in sync.
export function LightboxProvider({ children }) {
  const [state, setState] = useState(null); // { images, mode, store|null, index }

  const open = useCallback((group, index = 0) => {
    if (group.store) group.store.goto(index);
    setState({ ...group, index });
  }, []);
  const close = useCallback(() => setState(null), []);
  const setIndex = useCallback((i) => setState((s) => (s ? { ...s, index: i } : s)), []);

  return (
    <LightboxContext.Provider value={{ open, close, setIndex, state }}>
      {children}
    </LightboxContext.Provider>
  );
}
