import type { ReactElement } from "react";

const PATHS = {
  receipt: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 16h3" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  refund: <path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" />,
  shield: <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3zM8.5 12l2.5 2.5L15.5 10" />,
  hash: <path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16" />,
  eye: <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" />,
  lock: <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3" />,
  alert: <path d="M12 4l9 16H3L12 4zM12 10v4.5M12 17.2v.3" />,
  stop: <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5zM6.5 12h11" />,
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  clock: <path d="M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4.5l3 1.5" />,
  chain: <path d="M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1M14 10a4 4 0 00-5.6 0l-3 3A4 4 0 0011 18.6l1-1" />,
  user: <path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0" />,
  store: <path d="M4 9l1.5-5h13L20 9M4 9h16M4 9v11h16V9M9 20v-6h6v6" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  spinner: <path d="M12 3a9 9 0 019 9" />,
  dot: <circle cx="12" cy="12" r="3" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  wallet: <path d="M4 7h15a1 1 0 011 1v11H5a1 1 0 01-1-1V7zM4 7l12-3v3M16 13.5h.5" />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...(className ? { className } : {})}
    >
      {PATHS[name]}
    </svg>
  );
}
