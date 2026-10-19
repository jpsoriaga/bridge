import type { ActivityEntry } from '../../preload/api';
import type { EntryDescription, ResultKind } from './errors';
import { Icon, type IconName } from './Icon';

const RESULT_ICONS: Record<ResultKind, IconName> = {
  create: 'plus',
  modify: 'pencil',
  rename: 'arrow',
  delete: 'trash'
};

/** A file change's icon (coloured by kind), or the dot for everything else. */
export function EntryMark({ description }: { description: EntryDescription }) {
  const { result, tone } = description;
  if (!result) return <span className="dot" data-tone={tone} />;
  return (
    <span className="result-icon" data-tone={result.tone}>
      <Icon name={RESULT_ICONS[result.kind]} className="icon icon-sm" />
    </span>
  );
}

/** "07:50 PM · Created · via chat", with the verb coloured by kind. */
export function EntryMeta({ description, time }: { description: EntryDescription; time: string }) {
  const { result, meta } = description;
  if (!result) return <>{`${time} · ${meta}`}</>;
  return (
    <>
      {time} ·{' '}
      <span className="result-verb" data-tone={result.tone}>
        {result.verb}
      </span>
      {result.rest}
    </>
  );
}

/** The row's `data-result`, so a delete's path can be struck through. */
export const resultOf = (entry: ActivityEntry, description: EntryDescription) =>
  entry.undone ? undefined : description.result?.kind;
