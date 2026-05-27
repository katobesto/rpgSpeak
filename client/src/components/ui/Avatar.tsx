import { useLightboxStore } from '../../stores/lightbox.store.ts';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  /** When true and src is set, clicking opens the image in the lightbox viewer */
  expandable?: boolean;
}

const COLORS = [
  'bg-violet-600', 'bg-indigo-600', 'bg-blue-600', 'bg-emerald-600',
  'bg-rose-600', 'bg-amber-600', 'bg-cyan-600', 'bg-pink-600',
];

function colorForName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function Avatar({ src, name, size = 'md', className = '', expandable = false }: AvatarProps) {
  const openLightbox = useLightboxStore((s) => s.open);
  const sizes = { xs: 'w-6 h-6 text-xs', sm: 'w-8 h-8 text-sm', md: 'w-10 h-10 text-sm', lg: 'w-14 h-14 text-lg' };
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const clickable = expandable && Boolean(src);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${sizes[size]} rounded-full object-cover flex-shrink-0 ${className} ${
          clickable ? 'cursor-zoom-in hover:ring-2 hover:ring-accent hover:ring-offset-1 hover:ring-offset-transparent transition-all' : ''
        }`}
        onClick={clickable ? (e) => { e.stopPropagation(); openLightbox(src, name); } : undefined}
      />
    );
  }

  return (
    <div
      className={`${sizes[size]} ${colorForName(name)} rounded-full flex items-center justify-center font-semibold text-white flex-shrink-0 ${className}`}
    >
      {initials}
    </div>
  );
}
