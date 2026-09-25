/**
 * Nothing to show, said plainly.
 *
 * A practice with no invoices, no bookings, or no claims yet is an ordinary
 * state — the first week of using the system looks exactly like this. It was
 * previously unreachable only because every detail panel fell back to the
 * first record in the seed data, which for a second practice meant another
 * tenant's patient. Scoping that selection correctly makes the empty case
 * real, so it needs to look deliberate rather than broken.
 *
 * This used to be a second, differently styled empty state. It now re-exports
 * the shared one from `ui.jsx` (same `title`, `detail`, `action` props, plus an
 * optional `icon`), so every empty panel in the workspace looks the same.
 */
import { EmptyState } from '../ui';

export { EmptyState };
export default EmptyState;
