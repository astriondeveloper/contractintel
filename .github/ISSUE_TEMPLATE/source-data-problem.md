---
name: Source data problem
about: An export is wrong, missing a column, or asserts something contradictory
title: '[data] '
labels: source-data
---

<!--
Four of the more consequential findings so far were source data problems rather than code
problems: a blank Transaction # column costing 18.6 percent of obligated dollars, a
participant list silently capped at 500, a contract asserted as both won and lost, and an
"Astrion" export containing a subcontract with no Astrion party on it. They are worth
tracking as their own kind of issue because the fix usually lives outside this repository.
-->

## Which export

<!-- Filename, the date it was pulled, and who pulled it. -->

## What is wrong

<!-- The column, and what it contains versus what it should. -->

## How much it affects

<!-- A count and, where money is involved, a figure. "Some rows" cannot be prioritised.
     If the loader already reports it, paste that line. If a view quantifies it, name the
     view — e.g. `select * from fpds_collapse_summary;`. -->

## Is the data recoverable

- [ ] Yes, `source_version` holds it and only the projection is affected
- [ ] No, the export never contained it
- [ ] Unknown

<!-- source_version keys on (source_system, source_record_id, payload_hash), so every
     distinct payload ever loaded is archived even when a downstream table collapses it.
     Check before assuming loss. -->

## Who can fix it at source

<!-- Usually whoever runs the DACIS export. If the fix is an export configuration change,
     say which setting. -->

## What the loader should do meanwhile

<!-- Options, not a single answer. The pattern that has worked: keep the spec-literal
     behaviour reachable, make the alternative explicit and measured, and let a person
     choose with the numbers in front of them. See migration 0015. -->
