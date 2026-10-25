# Accessible workspace navigation

The root layout mounts stable polite and assertive live regions before the
application shell. Build/deploy start, success and failure events announce their
actual result without moving focus. Messages are queued by urgency; streaming
console rows are not all announced. Repeated identical announcements still clear
the region before insertion. The manager creates fallback regions only when used
outside the shared layout, avoiding duplicate initial hydration markup.

The first keyboard stops are skip links to the main content, contract editor,
console and primary navigation. Targets are programmatically focusable. On
mobile, navigation focuses the menu opener; on routes without an editor/console,
the corresponding link falls back to main content. The shell owns the single
main landmark; nested page wrappers use sections. The console has a keyboard
scroll region and output tabs support Left/Right/Home/End. Monaco has an explicit
accessible name and screen-reader support enabled. Its built-in **Toggle Tab Key
Moves Focus** command lets keyboard users switch Tab from indentation to leaving
the editor.

Shared modal focus management is used by the command palette, mobile navigation,
warming notice, onboarding tour and transaction signer. It recomputes available
controls when Tab is pressed, skips hidden/disabled controls, supports empty and
nested dialogs, contains programmatic focus, isolates background branches with
`inert`, and restores the previous connected control. Pre-existing inert state is
preserved. Escape closes cancellable dialogs; transaction signing is not cancelled
mid-signature. The tour does not intercept Enter on its own buttons. Dialogs have
explicit names, and the warming notice has a labeled close control.

Focus-visible outlines use the existing theme foreground/background tokens with
a three-pixel outline and contrasting outer surround. Forced-colors mode uses
the system Highlight color. Skip links become visible while focused.

## Regression coverage

Unit tests cover announcement priority/queueing, dynamic focus targets, hidden
and disabled controls, empty/nested dialogs, focus restoration, background
isolation, skip links and output-tab keys. Existing component/lifecycle tests
remain enabled. Playwright runs unfiltered, full-page axe scans on all 41 static
application routes, shared warming/palette/mobile-navigation states, and selected
light-theme views. It also exercises keyboard focus and real build/deploy live
announcements using explicitly mocked backend responses. No real transaction is
broadcast. Axe JSON and failure screenshots/traces are CI artifacts.

Run `npx playwright test --config playwright.accessibility.config.ts` after the
frontend production build. Browser dependencies: `npx playwright install chromium`.
The audit uses the published `@axe-core/playwright` package. Network-dependent
panels are audited in their offline/error state; connected wallet signing and
every possible data/modal state are not implied by a static-route scan.

Manual VoiceOver/NVDA reading order, announcement quality, connected-wallet
signing dialogs and all live-data interactive states remain to be verified.
Automated axe scans cannot certify complete screen-reader compliance or 100%
keyboard operability on their own. Verify the editor Tab-mode command, navigate
each workflow without a pointer, close each modal and confirm focus restoration,
and test both light/dark and forced-colors settings before certifying those goals.

Patterns follow the W3C dialog guidance:
https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
