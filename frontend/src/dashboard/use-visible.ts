import { useEffect, useRef, useState } from "react";

export function useVisible<T extends HTMLElement>(rootMargin = "320px") {
  const ref = useRef<T>(null);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      setMounted(true);
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const intersects = entries.some((entry) => entry.isIntersecting);
        setVisible(intersects);
        if (intersects) setMounted(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);
  return { mounted, ref, visible };
}
