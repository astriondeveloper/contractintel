# Archivo

Four weights of Archivo, converted to WOFF2 from the company-issued TrueType files:

| File | Weight | Role |
|---|---|---|
| `Archivo-Regular.woff2` | 400 | Body |
| `Archivo-Medium.woff2` | 500 | Labels and captions |
| `Archivo-SemiBold.woff2` | 600 | Subheads |
| `Archivo-Bold.woff2` | 700 | Display and headlines |

Archivo is licensed under the SIL Open Font License 1.1, which permits bundling and
redistribution with the software that uses it.

## Why they are committed rather than fetched

Two reasons, and the second is the load-bearing one.

A container may have no outbound network. Linking a font from a CDN makes the typeface a
runtime dependency on a third party being reachable, and the failure is silent: the page
renders in Arial and looks approximately right.

Acceptance test 12, from specification section 18, is that the interface renders in Archivo
and not a fallback face. `scripts/acceptance.ts` checks that every file referenced by an
`@font-face` in `../app.css` is present here. A CDN link would make that test unable to
assert anything from inside the repository.

Only the four weights the stylesheet declares are here. The complete family is nine weights
with matching italics; adding one means adding both the file and its `@font-face` block, and
the acceptance check will fail on a declaration whose file is missing.
