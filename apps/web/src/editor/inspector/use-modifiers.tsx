"use client";

import * as React from "react";

export function useModifierKeys(keys: string[]): boolean {
  const [held, setHeld] = React.useState(false);
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => keys.includes(e.key) && setHeld(true);
    const up = (e: KeyboardEvent) => keys.includes(e.key) && setHeld(false);
    const blur = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [keys]);
  return held;
}

export function useModifierToggle(keys: string[]): [boolean, () => void] {
  const held = useModifierKeys(keys);
  const [manual, setManual] = React.useState(false);
  return [held ? !manual : manual, () => setManual((v) => !v)];
}
