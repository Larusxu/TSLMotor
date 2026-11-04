import { useEffect, useRef, useState, type ReactNode } from "react";

/** Pointer ownership survives drive preparation and React status updates.
 * Release/unmount/blur still cancels preparation and stops an accepted task. */
export function HoldMotionButton({ canStart, interrupted, start, stop, onError, onHolding, children }: {
  canStart: boolean; interrupted: boolean; start: () => Promise<unknown>;
  stop: () => void; onError: (error: unknown) => void;
  onHolding: (holding: boolean) => void; children: ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  const holding = useRef(false), generation = useRef(0);
  const callbacks = useRef({ start, stop, onError, onHolding });
  callbacks.current = { start, stop, onError, onHolding };
  const release = () => {
    if (!holding.current) return;
    holding.current = false; ++generation.current; setPressed(false);
    callbacks.current.onHolding(false); callbacks.current.stop();
  };
  const begin = () => {
    if (!canStart || holding.current || interrupted) return;
    holding.current = true; const id = ++generation.current;
    setPressed(true); callbacks.current.onHolding(true);
    void (async () => callbacks.current.start())().catch(error => {
      if (generation.current !== id) return;
      release(); callbacks.current.onError(error);
    });
  };
  useEffect(() => { if (interrupted) release(); }, [interrupted]);
  useEffect(() => {
    const blur = () => release();
    const hide = () => { if (document.hidden) release(); };
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", hide);
      release();
    };
  }, []);
  return <button className="btn hold-motion-button" type="button" aria-pressed={pressed}
    disabled={!pressed && !canStart}
    onPointerDown={e => {
      if (e.button !== 0 || !e.isPrimary || !canStart) return;
      e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); begin();
    }}
    onPointerUp={() => release()} onPointerCancel={() => release()}
    onLostPointerCapture={() => release()} onBlur={() => release()}
    onKeyDown={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!e.repeat) begin(); } }}
    onKeyUp={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); release(); } }}>
    {children}
  </button>;
}
