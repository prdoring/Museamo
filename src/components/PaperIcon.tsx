import type { SVGProps } from "react";

// Geometry from the selected WPA pack; colors stay local to each icon.
const artwork = {
  document: <>    <path fill="currentColor" d="M19 8h43l15 15v65H19V8zm43 6v15h15z"/>
    <path fill="var(--icon-paper, var(--surface))" d="M31 42h34v6H31zm0 15h34v6H31zm0 15h24v6H31z"/></>,
  star: <>    <path fill="currentColor" d="m48 7 11 25 27 3-20 18 6 27-24-14-24 14 6-27-20-18 27-3z"/>
    <circle fill="currentColor" cx="48" cy="46" r="6"/></>,
  gear: <>    <polygon fill="currentColor" points="48.00,6.00 53.32,14.42 58.51,15.66 67.07,10.58 72.69,14.02 72.04,23.96 75.51,28.02 85.42,28.93 87.94,35.02 81.58,42.68 82.00,48.00 89.48,54.57 87.94,60.98 78.29,63.44 75.51,67.98 77.70,77.70 72.69,81.98 63.44,78.29 58.51,80.34 54.57,89.48 48.00,90.00 42.68,81.58 37.49,80.34 28.93,85.42 23.31,81.98 23.96,72.04 20.49,67.98 10.58,67.07 8.06,60.98 14.42,53.32 14.00,48.00 6.52,41.43 8.06,35.02 17.71,32.56 20.49,28.02 18.30,18.30 23.31,14.02 32.56,17.71 37.49,15.66 41.43,6.52"/>
    <circle fill="var(--icon-paper, var(--surface))" cx="48" cy="48" r="18"/>
    <circle fill="currentColor" cx="48" cy="48" r="8"/></>,
  plus: <>    <rect fill="currentColor" x="42" y="10" width="12" height="76"/>
    <rect fill="currentColor" x="10" y="42" width="76" height="12"/></>,
  close: <>    <path fill="currentColor" d="m19 11 29 29 29-29 8 8-29 29 29 29-8 8-29-29-29 29-8-8 29-29-29-29z"/></>,
  check: <>    <path fill="currentColor" d="m11 48 20 21 54-59 9 9-63 69L2 57z"/></>,
  back: <>    <path fill="currentColor" d="m66 11-37 37 37 37 10-10-27-27 27-27z"/></>,
  next: <>    <path fill="currentColor" d="m30 11 37 37-37 37-10-10 27-27-27-27z"/></>,
  down: <>    <path fill="currentColor" d="m11 29 37 37 37-37-10-10-27 27-27-27z"/></>,
  send: <>    <path fill="currentColor" d="M8 42h48V23l32 25-32 25V54H8z"/></>,
} as const;
export type PaperIconName = keyof typeof artwork;
export function PaperIcon({ name, size = 22, className = "", ...props }: SVGProps<SVGSVGElement> & { name: PaperIconName; size?: number }) {
 return <svg {...props} width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" focusable="false" className={`paper-icon ${name === "send" ? "paper-icon--send" : ""} ${className}`}>{artwork[name]}</svg>;
}
