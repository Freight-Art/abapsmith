## What changed and why

<!-- Summarize the change and the reasoning behind it. Link an issue if there is one. -->

## Verification

- [ ] `npm test` passes (offline suite — fakes/fixtures only, no real SAP system)
- [ ] `npm run typecheck` / `npm run build` pass
- [ ] `npm run check:leaks` passes
- [ ] Live-tested against a real ABAP appliance (`npm run test:live` and/or a manual `scripts/` harness) — state the system/release and what was exercised below

<!-- If live-tested, name the system kind/release and what the round covered. If the change
touches a cassette or fixture, say what was re-captured and against which system. -->
