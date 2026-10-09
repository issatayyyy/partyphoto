import type { SVGProps } from "react";

type IconName = "camera" | "album" | "home" | "user" | "plus";

export function UiIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {name === "camera" && <><path d="M4 6h4l1.5-2h5L16 6h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" /><circle cx="12" cy="13" r="4" /><path d="M18.5 9h.01" /></>}
    {name === "album" && <><rect x="4" y="3" width="17" height="17" rx="3" /><path d="M17 23H5a4 4 0 0 1-4-4V7m3 9 5-5 4 4 3-3 5 5" /><circle cx="16" cy="8" r="1" /></>}
    {name === "home" && <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></>}
    {name === "user" && <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>}
    {name === "plus" && <path d="M12 5v14M5 12h14" />}
  </svg>;
}
