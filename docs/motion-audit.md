# Transition audit

## Findings and changes

The web app had a 160ms sheet entrance and button feedback, but no sheet exits, page transitions, lightbox transitions, or animated disclosure panels. Conditional rendering removed surfaces immediately.

| Surface | Behavior after this pass |
| --- | --- |
| Stream, Gems, Tags, tag detail, Map, Settings | 180ms fade when the destination changes; no remount just to animate, and no replay on each search keystroke |
| Thought actions, edit/capture, tag editor, post location | Backdrop fade and 24px sheet entrance; 160ms exit, including save, discard, and programmatic closes |
| Photo viewer | Fade in/out; fade after image load; eased zoom/snapback with direct, un-delayed pointer dragging |
| Search, formatting, tag selector, location editor | Expand/collapse with a short fade; closing controls become inert |
| Long thoughts | Measured-height Show more / Show less resize |
| Confirmations, suggestions, notices | Short entrance fades; no staggered animation of feed content |
| Buttons/navigation selection | 120ms color feedback and restrained press feedback |
| Android capture and tag-picker activities | Shared 180ms enter / 160ms exit window animation |
| Android widget setup, native alert dialogs, file pickers, external apps, video fullscreen | Retain platform-controlled transitions |

Shared presence keeps exiting surfaces mounted for 160ms. Scroll/inert locks survive overlapping old/new sheets; focus returns only after the final overlay closes. Autofocus fields capture the trigger before mounting. Editor editability changes do not emit draft updates, and late draft updates cannot reopen a closed editor.

CSS and JavaScript transitions respect reduced motion. Page transitions cancel when that preference changes; closing surfaces immediately finish. Leaflet disables animated zoom/fitting when reduced motion is enabled. Android window animations follow the system animation scale.

## Verification

- Browser: Stream/Gems/Tags/tag detail/Settings/Map navigation; action sheet to editor; formatting-to-tags panel switch; Escape dismissal; new-tag autofocus and return focus; text and attachment save dismissal.
- Photo viewer: local WebP fixture loads, keyboard zoom updates to 1.5×, close restores thumbnail focus and releases body scrolling/inert state.
- Narrow viewport: 390×844 search expansion/collapse and bottom sheet; sheet bottom aligns with viewport bottom, controls remain visible without the native keyboard.
- Regression tests cover overlapping overlay locks, reverse completion order, prior inert/overflow state, and removed focus targets. Full suite: 56 tests pass.
- Production build and Android `:app:processDebugResources` pass. Vite reports unresolved asset-placeholder and large-chunk warnings.

Device follow-up: confirm Android capture/tag-picker opening and closing with the IME visible, rapid back presses, window-animation scale disabled, and real pinch/swipe gestures. Physical-device frame pacing and native keyboard behavior were not measured in this pass.
