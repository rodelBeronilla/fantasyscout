import { type KeyboardEvent, useId, useMemo, useState } from 'react';

import { matchOptions } from '../lib/player-search';

const input = 'rounded border border-line bg-bg px-2 py-1 text-sm';

/**
 * Type part of a name, then pick from the list under the box (#454): arrow keys move through it,
 * Enter takes the highlighted player (the first by default), Escape closes it. The full label
 * typed or pasted adds the player at once. A browser datalist matched only the whole label and
 * showed little on phones, so "luka" did nothing.
 */
export function PlayerPicker({ label, options, onAdd }: { label: string; options: Map<string, string>; onAdd: (id: string) => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const labels = useMemo(() => [...options.keys()], [options]);
  const matches = useMemo(() => matchOptions(labels, text), [labels, text]);
  const shown = open && text.trim().length > 0;

  const pick = (choice: string | undefined) => {
    const player = choice ? options.get(choice) : undefined;
    if (!player) return;
    onAdd(player);
    setText('');
    setActive(0);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter' && shown) {
      e.preventDefault();
      pick(matches[active] ?? matches[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        type="search"
        role="combobox"
        aria-expanded={shown && matches.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={shown && matches.length ? `${id}-${active}` : undefined}
        value={text}
        onChange={(e) => {
          if (options.has(e.target.value)) {
            pick(e.target.value);
            return;
          }
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder="Add a player"
        aria-label={label}
        className={`${input} w-full`}
        autoComplete="off"
      />
      {shown && matches.length > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label="Matching players" className="absolute right-0 left-0 z-20 mt-1 max-h-72 overflow-auto rounded border border-line bg-card p-1 text-sm shadow" data-testid="player-options">
          {matches.map((m, i) => (
            <li
              key={m}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer rounded px-2 py-1.5 ${i === active ? 'bg-accent text-accent-fg' : 'hover:bg-bg'}`}
              // mousedown, so the pick lands before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
            >
              {m}
            </li>
          ))}
        </ul>
      )}
      {shown && matches.length === 0 && (
        <p className="mt-1 text-xs text-muted" role="status" data-testid="player-no-match">
          No player matches “{text.trim()}”.
        </p>
      )}
    </div>
  );
}
