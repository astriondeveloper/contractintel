# Test fixtures

These files exist only to exercise the loaders. They are **not** application data
and nothing here is ever seeded into a running system.

The distinction matters because of two lines in the build specification that pull
in opposite directions if you read them carelessly:

- Section 16, Demo data: **None. Build against the real corpus.**
- Section 16, Tests: **The scoring rules have unit tests with fixtures.**
- Defect 7: *38 KB of demo data holding 16 fake opportunities.*

Defect 7 is about demo data masquerading as content: fake opportunities that a
user could see, click, and mistake for real pipeline. That is forbidden. Unit test
fixtures are required by the same section, because a rule change has to be able to
fail a test.

So the rules for this directory are:

1. Fixtures are generated inside the test files, at run time, into a temporary
   directory. They are not checked in as data files a loader could be pointed at
   by accident.
2. Fixtures load into `cie_test`, which the test setup drops and rebuilds on every
   run. They never touch the development or production database.
3. A fixture reproduces a **documented property of the real corpus**, and the test
   that uses it says which property and cites the specification section. A fixture
   never invents a plausible-looking opportunity.

The properties currently reproduced, all from specification section 4.1:

| Property | Where it comes from |
|---|---|
| Two supplied files are identical | Section 4.1, "Exports contain duplicates" |
| One file is a superset of another | Section 4.1 |
| 368 rows repeat across files | Section 4.1 |
| PSC R425 carries two different descriptions | Section 4.1, "Code labels change" |
| A name search returns 0.7 percent of the history | Section 4.1, "A name search fails" |
| Obligations may be negative | Section 7.2, a negative value is a deobligation |
| `Major Program` is populated on 7.3 percent of rows | Section 4 |
