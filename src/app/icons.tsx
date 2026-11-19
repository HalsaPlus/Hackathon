// Line icons, drawn like Hälsa+'s: rounded strokes, no fills.

const base = { width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': true, className: 'icon' } as const;

export const HomeIcon = () => (
  <svg {...base}>
    <path d="M4 11 L12 4.5 L20 11 V19.5 H15 V14.5 H9 V19.5 H4 Z" />
  </svg>
);

export const PlanIcon = () => (
  <svg {...base}>
    <path d="M3 17 H8 L15 7 H21" />
    <circle cx="3.5" cy="17" r="2" />
    <circle cx="11.5" cy="12" r="2" />
    <circle cx="20.5" cy="7" r="2" />
  </svg>
);

export const HealthIcon = () => (
  <svg {...base}>
    <path d="M2.5 12.5 H6.5 L9 6.5 L13 18 L15.5 11 H21.5" />
  </svg>
);

export const ChatIcon = () => (
  <svg {...base}>
    <path d="M5 5 H19 A2 2 0 0 1 21 7 V14.5 A2 2 0 0 1 19 16.5 H11 L6.5 20 V16.5 H5 A2 2 0 0 1 3 14.5 V7 A2 2 0 0 1 5 5 Z" />
  </svg>
);

export const SendIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ fill: 'none', stroke: '#0B0930', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
    <path d="M3 10 H16" />
    <path d="M11 5 L16 10 L11 15" />
  </svg>
);

export const CheckIcon = ({ color = '#0B0930', size = 14 }: { color?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
    <path d="M 3 7.2 L 5.8 10 L 11 4.5" style={{ fill: 'none', stroke: color, strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }} />
  </svg>
);

export const ShieldIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: '#B6A7FF', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
    <path d="M10 2.5 L16 5 V9.5 C16 13.5 13.4 16.4 10 17.5 C6.6 16.4 4 13.5 4 9.5 V5 Z" />
    <path d="M7.2 10 L9.2 12 L13 8" />
  </svg>
);

export const HeartIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ fill: 'none', stroke: '#FF8A8A', strokeWidth: 1.6, strokeLinejoin: 'round' }}>
    <path d="M8 13.5 C3 10 1.8 7.6 1.8 5.6 A3 3 0 0 1 8 4.4 A3 3 0 0 1 14.2 5.6 C14.2 7.6 13 10 8 13.5 Z" />
  </svg>
);

export const MmdMark = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
    <path d="M 3 19 L 9 19 L 17 7 L 23 7" style={{ fill: 'none', stroke: '#03D4D1', strokeWidth: 3, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
    <circle cx="3.5" cy="19" r="3" style={{ fill: '#181144', stroke: '#03D4D1', strokeWidth: 2.5 }} />
    <circle cx="13" cy="13" r="3" style={{ fill: '#181144', stroke: '#03D4D1', strokeWidth: 2.5 }} />
    <circle cx="22.5" cy="7" r="3" style={{ fill: '#181144', stroke: '#03D4D1', strokeWidth: 2.5 }} />
  </svg>
);
