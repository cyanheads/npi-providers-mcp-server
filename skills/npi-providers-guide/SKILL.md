---
name: npi-providers-guide
description: Select and verify specialty cohorts with npi_* tools. Use when a provider search needs an exact specialty, an ambiguous professional category, or a defensible completeness claim.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.2"
---

## Scope

Use this guide to turn a specialty request into a checked set of NPI-enumerated providers. NPPES covers NPI holders; a registry search cannot establish a census of everyone practicing a profession.

## Gates

- Choose the intended profession and specialty before accepting the resolver's first candidate. Inspect the candidate's grouping, classification, and specialization: related terms can describe different professions or narrower specialties.
- Keep NUCC section separate from NPPES entity type. A taxonomy's Individual or Non-Individual section does not determine whether a registry record is an individual or an organization. Choose the entity type from the user's request and check the returned record.
- Verify an exact specialty against the full provider record. NPPES matches a taxonomy description as a case-insensitive prefix of any of a provider's taxonomies' classification or specialization, and a search row's primary taxonomy need not be the taxonomy that matched; such rows name the match in `matchedTaxonomy`. Free-text `taxonomy_description` is sent as written and never filtered, so generic text still reaches other codes (`Family` also reaches Family Medicine): check all recorded taxonomy codes against the selected specialty codes before including or excluding the provider. A search from `specialty`, or from a decoded code or display name, returns only rows holding a code in `resolvedTaxonomies` (a classification-level code counts its whole classification). A code newer than the bundled NUCC set is kept only under a classification-level code, when its description names that classification; check such a code against the specialty you intend.
- Establish search coverage before reporting a complete cohort or declaring a named provider absent. A narrowed query reaches a subset; it does not prove that omitted candidates do not exist.

## Core chain

Use npi_lookup_taxonomy to settle the intended specialty, npi_search_providers to collect candidates, and npi_get_provider to inspect the candidates' complete taxonomy lists. If the request spans several taxonomy codes, evaluate each intended code rather than treating the highest-ranked resolver candidate as the whole category. A code from `npi_get_provider` or `npi_lookup_taxonomy` goes straight into `taxonomy_description`. An inactive code a record still carries is refused before searching (`unresolved_specialty`, naming the replacement when NUCC gives one).

## Workflows

For a shortlist, check the requested identity, profession, specialty, and practice location on the candidate records. A different primary specialty alone is not grounds to discard a candidate who records the selected code elsewhere in its taxonomy list.

For an exhaustive cohort, follow the search's returned pages and postal continuations, deduplicating by NPI across pages, postal branches, and specialty searches. Continue when the response offers another page even if location or resolved-code filtering left few visible rows. A continuation value without a `*` (the bare digits of the prefix being split) matches only a postal code recorded with exactly those digits, so an empty result for it ends that branch. Record unresolved branches rather than counting them as empty.

A saturated five-digit ZIP cannot be split losslessly into ZIP+4 prefixes: some practice addresses record only five digits. Postal partitioning also leaves unreached providers whose practice addresses all carry a blank postal code, or one with a letter, space, or hyphen in a position the split adds (most Canadian and UK). If either gap remains relevant to the requested cohort, report the retrieved set with its coverage limit; further narrowing does not establish completeness.
