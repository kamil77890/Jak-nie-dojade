import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function iconProps({ size = 18, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export function ArrowUpRight(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

export function ArrowRight(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 12h16M14 6l6 6-6 6" />
    </svg>
  );
}

export function ArrowLeft(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M20 12H4M10 6l-6 6 6 6" />
    </svg>
  );
}

export function Refresh(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
    </svg>
  );
}

export function Clock(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function Mail(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </svg>
  );
}

export function Queue(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 7h16M4 12h16M4 17h10" />
      <circle cx="18.5" cy="17" r="1.5" />
    </svg>
  );
}

export function Shield(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5 19 6v5.2c0 4-2.9 7.4-7 9.3-4.1-1.9-7-5.3-7-9.3V6l7-2.5Z" />
      <path d="m9.2 11.8 2 2 3.6-3.8" />
    </svg>
  );
}

export function Activity(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  );
}

export function Seat(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 4v10h10V4M5 14h14v4H5zM8 18v2M16 18v2" />
    </svg>
  );
}

export function AlertTriangle(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 4 21 20H3L12 4Z" />
      <path d="M12 9v5M12 17.2v.1" />
    </svg>
  );
}

export function CheckCircle(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.4 2.4 4.6-5" />
    </svg>
  );
}

export function Printer(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
      <path d="M7 14h10v6H7z" />
    </svg>
  );
}

export function Ticket(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" />
      <path d="M14 6v12" strokeDasharray="2 2.5" />
    </svg>
  );
}

export function Spark(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}

export function Sun(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function Moon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

export function ArrowDown(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  );
}
