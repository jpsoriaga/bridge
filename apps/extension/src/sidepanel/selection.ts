import { isAttachablePath } from '@bridge/shared';

/** Marker, fence and blank lines around each file in `@@CONTEXT` format. */
const PER_FILE_OVERHEAD = 40;

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * What a Send files selection comes to: text files go into the message (and count against
 * the character budget), images are attached (and never count as characters).
 */
export function splitSelection(sizes: ReadonlyMap<string, number>, selected: Iterable<string>) {
  const files: string[] = [];
  const images: string[] = [];
  let chars = 0;
  for (const path of selected) {
    if (isAttachablePath(path)) images.push(path);
    else {
      files.push(path);
      chars += (sizes.get(path) ?? 0) + path.length + PER_FILE_OVERHEAD;
    }
  }
  return { files, images, chars };
}

/** "2 files · 1 image", leaving out a kind with none. */
export function selectionSummary(files: number, images: number): string {
  const parts = [];
  if (files > 0 || images === 0) parts.push(plural(files, 'file'));
  if (images > 0) parts.push(plural(images, 'image'));
  return parts.join(' · ');
}

/** The Send files button: what it will do. */
export function insertLabel(files: number, images: number): string {
  if (files === 0 && images === 0) return 'Insert files';
  if (images === 0) return `Insert ${plural(files, 'file')}`;
  if (files === 0) return `Attach ${plural(images, 'image')}`;
  return `Insert ${plural(files, 'file')} and attach ${plural(images, 'image')}`;
}

/** What Send files did, for the status line. */
export function sentSummary(files: number, images: number): string {
  const parts = [];
  if (files > 0) parts.push(`added ${plural(files, 'file')} to the message box`);
  if (images > 0) parts.push(`attached ${plural(images, 'image')}`);
  const text = parts.join(' and ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}. Review it and press send.`;
}
