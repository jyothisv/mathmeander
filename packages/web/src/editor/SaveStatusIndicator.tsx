// The save-status view (slice 2c autosave) — deliberately ISOLATED and trivially swappable: change
// only this file to restyle/quiet/hide the indicator once the loop is trusted. It is a PERSISTENT
// element (never mounts/unmounts per save — that flicker was the whole complaint), in a polite
// `role="status"` live region, whose text/kind come from the pure `describeSaveStatus`. During
// development it shows the full set of states (saved/unsaved/saving/offline/error) for observability.
import { describeSaveStatus, type SaveState } from './saveStatus';

export function SaveStatusIndicator({ state }: { state: SaveState }) {
  const { kind, label } = describeSaveStatus(state);
  return (
    <p className={`save-status save-status--${kind}`} role="status" aria-atomic="true">
      {label}
    </p>
  );
}
