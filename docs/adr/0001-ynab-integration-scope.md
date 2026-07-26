# ADR-0001: YNAB integration scope

Status: Accepted
Date: 2026-07-26

## Context

`IMPROVEMENT_PLAN.md` §4 (written for the M1–M7 UI/reliability rework, now fully merged) lists as an
explicit non-goal: "No cloud sync, no bank API integrations (Plaid etc.)." That non-goal was written
to keep YDB LAN-only and free of bank-credential-linking services (Plaid-style aggregators that hold
the user's bank login).

Shyam wants to stop paying for YNAB and migrate to YDB, but needs a transition period using both
tools while YDB's day-to-day workflow catches up. That requires pulling transaction data YNAB already
has (entered via a separate SMS-parsing pipeline, out of scope for this repo) into YDB.

YNAB is not a bank-credential aggregator: the integration uses a personal access token Shyam controls,
against data Shyam already owns and entered himself. It is categorically different from a Plaid-style
integration, but it is still new external-network surface in an app designed to be LAN-only with no
standing external dependencies.

## Decision

Amend the non-goal: YDB may integrate with YNAB's API for the specific, bounded purpose of migrating
off YNAB. Constraints:

- **One-way pull only.** YDB reads from YNAB; YDB never writes to YNAB. YNAB remains the user's
  system of record until the migration is complete.
- **User-initiated, not a standing service.** No YDB code assumes network reachability to YNAB is
  always available. See ADR-0002 for the phased rollout (manual pull now, automatic sync later).
- **Scoped as a migration tool, not a permanent feature.** The intent is to delete this integration
  once Shyam has fully moved off YNAB. It should be easy to rip out.
- The blanket non-goal in `IMPROVEMENT_PLAN.md` §4 is superseded by this ADR for the YNAB case
  specifically; it still holds for any other cloud sync or bank-credential integration (Plaid etc.).

## Consequences

- Buys a path off a recurring subscription and a way to dogfood YDB against real, current data
  without a risky cutover.
- Costs: YDB gains its first external API dependency and a credential (YNAB personal access token)
  that needs to be stored and handled carefully (not committed, not logged).
- Given up: the "zero external dependencies" simplicity the original LAN-only design had. Accepted
  as a bounded, temporary trade — revisit (remove the integration) once migration is done.
