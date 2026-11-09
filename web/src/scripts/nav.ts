import { isRememberedOwner } from '../lib/owner';

// The owner's links (the SQL console) show only in a browser that has signed in as the owner (#940).
if (isRememberedOwner()) for (const item of document.querySelectorAll<HTMLElement>('[data-owner-only]')) item.hidden = false;

// One nav dropdown open at a time, and none once the reader clicks or tabs elsewhere.
const groups = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-nav-group]'));
for (const group of groups) {
  group.addEventListener('toggle', () => {
    if (!group.open) return;
    for (const other of groups) if (other !== group) other.open = false;
  });
}
document.addEventListener('click', (e) => {
  const target = e.target as Node | null;
  for (const group of groups) if (group.open && target && !group.contains(target)) group.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const group of groups) group.open = false;
});
