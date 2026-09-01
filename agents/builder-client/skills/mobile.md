---
name: mobile
description: React Native mobile work. Operates inside the standard development cycle (CLAUDE.md), with mobile-specific platform considerations and the constraint that Cyrus's Linux VM cannot build iOS (macOS-only) and Android builds are heavy. JS-level checks happen in Cyrus; native build verification is delegated to CI and human review.
---

# Skill — Mobile

## Activate when

- Linear ticket with label `mobile`
- Paths in the diff matching the mobile repo / directory
- Files matching `*.native.tsx`, `*.ios.*`, `*.android.*`

## Specialized knowledge

- **React Native conventions** for this project: navigation (React Navigation / Expo Router / etc.), state, data fetching (often shared with web via a `shared/` package), styling (RN StyleSheet, NativeWind / Tailwind-RN, or styled-components). Specifics from `STACK.md`.
- **Platform-specific code conventions** — `Platform.select`, `.ios.tsx` / `.android.tsx` files, when to keep code shared vs split.
- **Touch target sizes** — 44pt iOS minimum, 48dp Android minimum. Tap targets that look smaller in design must still meet these in implementation.
- **Keyboard handling** — `KeyboardAvoidingView`, `keyboardShouldPersistTaps`, focus management.
- **Safe areas** — `SafeAreaView` / `useSafeAreaInsets()` discipline. No hardcoded top/bottom paddings.
- **Performance basics** — `FlatList` vs `ScrollView`, `memo`/`useMemo` discipline (only when render data is expensive; avoid useMemo-everywhere), image caching.
- **Cyrus-VM constraint** — Linux Hetzner host:
  - iOS builds: **impossible** (macOS-only). Native iOS verification delegated to CI / human review on a Mac.
  - Android builds: possible but heavy. May not be installed in the Cyrus image by default.
  - JS-level checks: **always possible** (unit tests, type-check, lint).

## Procedure

Follows the standard development cycle (CLAUDE.md §"The development cycle"). Mobile-specific additions:

### Phase 4 — Self-test (mobile-specific)

- Runs JS-only checks: unit tests, type-check, lint, JS-only behavior.
- **PR description explicitly notes "native builds will run in CI"** so reviewers know to verify there.
- Web mobile viewport (responsive layout at 375x812) — yes, captured via Claude Preview MCP.
- Native iOS / Android screenshots — produce a **creative brief** instead of attempting capture. Hand to humans or to CI if CI has iOS/Android build jobs that can capture.

### Phase 5 — Self-review (mobile additions)

- Mobile a11y considerations: VoiceOver / TalkBack labels (`accessibilityLabel`, `accessibilityHint`, `accessibilityRole`), focus order in screens, dynamic font sizing support.
- Tap targets ≥ 44pt (iOS) / 48dp (Android)
- Tested in landscape if supported
- Keyboard avoidance handled
- Safe-area discipline (no hardcoded top/bottom paddings)
- No platform-specific layout breakage (`Platform.select` used where needed)

### Phase 6 — Open PR (mobile additions)

PR description includes:
- A screenshot from the iOS simulator + Android emulator **if available remotely** (rare)
- Otherwise, a note that **visual verification is delegated to CI / human review on a Mac**
- The `mobile` label per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol)

## Outputs

- PRs on the mobile repo / directory
- Updates to `dev-team-state/projects/<project>/builder-client/mobile/platform-notes.md` when platform quirks are encountered and resolved
- Creative briefs (when mobile-native screenshots are needed but Cyrus can't capture)

## Examples

> **Input**: "Add pull-to-refresh on the projects list screen"
>
> **Plan**: use existing `<ProjectsList>` component, add `refreshControl` prop wiring, use the existing `useRefreshProjects` hook, ensure haptic feedback on both platforms (iOS: `Haptics.selectionAsync()` from `expo-haptics`, Android: vibrate fallback). Test strategy: unit test for refresh callback invocation; manual verification on both platforms via CI.

## Escalation

- **Native-only bug** (can only be reproduced or fixed in Swift/Kotlin) → escalate to a human; the agent cannot operate the native toolchain.
- Cross-platform divergence requested by reviewer ("this should look different on Android") → propose with `Platform.select` and request review.
- Performance regression detectable only on-device → ping `@platform-agent` (FinOps + perf) and a human reviewer.

## What this skill does NOT do

- Build iOS apps (impossible in Linux VM).
- Build Android apps autonomously (possible with setup, but native build verification is delegated to CI).
- Submit to the App Store / Play Store (the `eas submit` command is deny-listed in settings).
- Modify native iOS / Android code (Swift / Kotlin) — that's a human task.
