---
name: npi-providers-guide
description: Select and verify specialty cohorts with npi_* tools. Use when a provider search needs an exact specialty, an ambiguous professional category, or a defensible completeness claim.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this guide to turn a specialty request into a checked set of NPI-enumerated providers. NPPES covers NPI holders; a registry search cannot establish a census of everyone practicing a profession.

## Gates

- Choose the intended profession and specialty before accepting the resolver's first candidate. Inspect the candidate's grouping, classification, and specialization: related terms can describe different professions or narrower specialties.
- Keep NUCC section separate from NPPES entity type. A taxonomy's Individual or Non-Individual section does not determine whether a registry record is an individual or an organization. Choose the entity type from the user's request and check the returned record.
- Verify an exact specialty against the full provider record. NPPES matches taxonomy descriptions as substrings, and a search row's primary taxonomy need not be the taxonomy that matched. Check all recorded taxonomy codes against the selected specialty codes before including or excluding the provider.
- Establish search coverage before reporting a complete cohort or declaring a named provider absent. A narrowed query reaches a subset; it does not prove that omitted candidates do not exist.

## Core chain

Use npi_lookup_taxonomy to settle the intended specialty, npi_search_providers to collect candidates, and npi_get_provider to inspect the candidates' complete taxonomy lists. If the request spans several taxonomy codes, evaluate each intended code rather than treating the highest-ranked resolver candidate as the whole category.

## Workflows

For a shortlist, check the requested identity, profession, specialty, and practice location on the candidate records. A different primary specialty alone is not grounds to discard a candidate who records the selected code elsewhere in its taxonomy list.

For an exhaustive cohort, follow the search's returned pages and postal continuations, deduplicating by NPI across pages, postal branches, and specialty searches. Continue when the response offers another page even if location filtering left few visible rows. Record unresolved branches rather than counting them as empty.

A saturated five-digit ZIP cannot be split losslessly into ZIP+4 prefixes: some practice addresses record only five digits. Postal partitioning also leaves providers with only non-US practice addresses unreached. If either gap remains relevant to the requested cohort, report the retrieved set with its coverage limit; further narrowing does not establish completeness.
