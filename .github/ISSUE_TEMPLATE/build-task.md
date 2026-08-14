---
name: Build task
about: A piece of the specification that is not built yet
title: ''
labels: build
---

## Spec section

<!-- The section number. If it is not in the spec, say what it is for and who asked. -->

## What exists now

<!-- Which tables, views and loaders are already in place. Most of the schema is built, so
     this is usually more than it looks. `npm run accept` names what each blocked
     acceptance test is waiting for. -->

## What this adds

## Which acceptance tests it unblocks

<!-- From spec section 18. Numbers, e.g. "4, 5, 6, 7". If none, say so — plenty of useful
     work unblocks nothing. -->

## Depends on

<!-- Other issues, or an external answer. Gates A, B and C in spec section 6 are external
     and unresolved; if this needs one, name it. -->

## How it will be verified

<!-- Which acceptance test, which unit tests, and which query against the real corpus.
     Something that produces a number a person can sanity-check is worth more than a test
     that only proves the code ran. -->

## Watch out for

<!-- The traps already known in this area. A few that keep coming up:
     - short PIIDs are not unique: agency 9700 PIID 0001 carries 58 distinct transactions
     - a blank value is null, never zero
     - a negative value is a deobligation and is kept
     - value_is_shared means the figure covers several awardees, so it cannot be summed
     - participant_list_truncated means a count is a floor
     - divide by applicable weight, not known weight (spec 10.3, defect 2)
-->
