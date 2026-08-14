# Synthetic seed files

These three files are **not** Astrion data and describe no real company. Every name,
UEI and CAGE code here is invented. The identifiers are deliberately un-real —
UEIs begin `ZZ`, CAGE codes begin `Z` — so that one appearing in a log, a bug report or
a screenshot cannot be mistaken for a live identifier.

They exist because Gate A came back **no**: DACIS-derived data may not live in this
repository. The real seed files live in private storage and reach a running system
through `CIE_SEED_DIR`. The test suite and CI use the files here instead.

## What they have to preserve

A synthetic fixture is only worth having if it still exercises the thing under test.
The resolver's whole job is to survive the awkward shapes the real map contains, so
these files reproduce each of those shapes:

| Property | Where | Why a test needs it |
|---|---|---|
| 50 alias rows over 15 legacy entities, one shared parent | entity map | The real file's grain. Several spellings per entity is the normal case, not the exception. |
| **Four UEIs each shared by two legacy entities** | `ZZ1TESTUEI01`, `ZZ2TESTUEI02`, `ZZ3TESTUEI03`, `ZZ4TESTUEI04` | Spec 8.2 assumes a UEI identifies one entity. It does not. `identifier_collision` must report four. |
| **Four CAGE codes each shared by two** | `ZC001` … `ZC004` | Same, for step 2 of the match order. |
| Every collision inside one family | all of them roll up to `Northwind` | A UEI still identifies the *family*, which is what makes the parent fallback sound. |
| At least one unambiguous UEI **and** CAGE | Ridgeway Solutions, `ZZ5TESTUEI05` / `ZC005` | Steps 1 and 2 need a case that resolves cleanly. |
| Spellings differing only in punctuation | `LARKSPUR, INCORPORATED` / `LARKSPUR INCORPORATED` / `LARKSPUR INC` | Acceptance test 3. They must normalise to one entity. |
| A misspelling in the authored map | `LARKSPUR INCORORATED` | It is authored, so it resolves. Transposition is not fuzzy matching. |
| A near neighbour that must stay separate | `LARKSPUR RANGE SERVICES, LLC` | Sharing a leading token is not sharing an identity. |
| A near miss that must **not** resolve | nothing matches `QUANTALYTEK INC` | Spec 8.1 and defect 9: no probabilistic matching on the family. |
| A name whose parenthetical is part of it | `TESSELLATE CONCEPTS INCORPORATED (5855)` | `splitNameLocation` strips a trailing `(City, ST)` and must leave this alone. |
| Rows with a UEI but no CAGE, and the reverse | several | Both are optional in the real file. |
| `confirmed_by_bd_ops = NO` on every row | all | Spec section 20 ships them unconfirmed, which is what forces decision D2. |
| 47 watchlist rows describing 45 companies | watchlist | Two companies appear under two spellings each. |
| Two companies split across spellings, one direction each | Kestrel Technologies, Applewood Research Solutions | Rolled up they are bidirectional. This is the finding the real file hides, and the rollup logic has to catch it. |
| 14 rows marked `both` | watchlist | Section 20's stated competimate count, before the rollup raises it. |
| 14 capability nodes | taxonomy | The real file's node count. |

The numbers on these rows are shaped like the real ones so that a rollup produces a
visible change, but they are not the real numbers.

## Using them

`tests/setup/global-setup.ts` points `CIE_SEED_DIR` here before running the seed
loaders, so `npm test` needs nothing configured. CI does the same.

Override with `CIE_TEST_SEED_DIR` if you have the real files locally and want to run the
suite against them — the assertions in `tests/` are written against the synthetic
values, so most will fail. That is expected, and is the point: the tests assert
behaviour, and the values they assert on are the ones in this directory.

## Adding to these files

If a test needs a shape that is not here, add the shape rather than reaching for a real
company. Two rules:

1. **Nothing traceable to a real company.** No real name, UEI, CAGE code, PIID or
   contract number. If you need a plausible-looking identifier, follow the `ZZ` and `Z`
   convention.
2. **Add a row to the table above.** A fixture property nobody documented is a fixture
   property the next person will delete while tidying up.
