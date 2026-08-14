<!--
Keep this short. The point is that a reviewer can tell what changed and what would prove
it wrong, not that every box is ticked.
-->

## What this changes

<!-- One or two sentences. -->

## Which part of the spec

<!-- Section number, or "none: infrastructure". If this departs from the spec, say so here
     and add it to docs/DECISIONS.md in the same PR. A deviation that only exists in a code
     comment is a deviation nobody will find. -->

## How it was verified

<!-- Which tests, and what they would catch. "Added tests" is not an answer; "a test that
     fails if a blank value loads as zero" is. If it was run against a real corpus, say
     which files and what the counts were. -->

## Checks

- [ ] `npm run typecheck && npm test` passes locally
- [ ] New behaviour has a test that fails without the change
- [ ] Any new migration is a new file, not an edit to an applied one
- [ ] No corpus data added to the repository (Gate A is still open — see CONTRIBUTING.md)
- [ ] Numbers quoted in comments or docs came from a measurement, and the measurement is
      repeatable

## Anything a reviewer should push back on

<!-- Where you were unsure, what you chose, and what the alternative was. This section is
     the most useful one in the template; leaving it blank is a small waste of the review. -->
