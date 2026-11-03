# Architecture

## Data flow

```
 Source.ingest()            the source's own tables (token_request | Nomad tables)
 Source.measure(window)  ─▶ Measurement { sourceId, operatorKey, metricKey, value }
        │
        ▼  attribution: malformed keys and keys this network lacks are skipped
 metrics outbox (SQLite)    pending → invoiced
        │
        ▼  billing policy: metric key → lane unit symbol → unit index
 invoice plans              one per operator per invoice period
        │
        ▼
 create_parked_spend (invoicer)   fund: park HF (funder)   execute_rave
```

`process` runs everything above the outbox; `invoice` runs everything below it.

## Store

One SQLite file holds:

- **Core tables** ([src/store/](src/store/)): `metrics` (the outbox),
  `agent_presence` (what the network said about each operator key), `meta`
  (cursors).
- **Source tables**, owned by each source: `token_request` and
  `token_log_cursor` for the token source; allocations, node status events,
  node agent keys and the stream cursor for Nomad
  ([src/sources/nomad/store.ts](src/sources/nomad/store.ts)).

A `metrics` row is keyed by `(source_id, metric_key, window_start, part)`.
`process` measures a window's whole total each time and stores only what no
claimed or invoiced row covers yet. A late record for a window that is already
being invoiced becomes a new pending part, paid in a follow-up spend.

An operator whose key the network does not hold yet is skipped, and the
window is remembered. Once the network has the key, those windows are
measured again, so the operator's first windows are paid too.

The token source reports the earliest new record, so late records are
counted. The Nomad source does not: it measures from its cursor on, and a
first run measures only the latest complete window.

## Invoice lifecycle

1. Pending rows group into one plan per operator per complete period.
2. Each plan gets an `invoice_key`: a hash of the agreement, operator, period,
   policy version and record ids. It goes in the spend's payload.
3. The plan is **claimed** before it is parked: in one transaction its rows
   become `parking` and its amount, payload and key are stored
   (`invoice_claim`). The claim is refused if `process` changed a row since the
   plan was built. Once the spend is parked, the rows become `invoiced`.
4. Each run first settles earlier claims. It reads the keys of the spends
   parked on the agreement: a claim whose key is there is marked invoiced; any
   other claim is parked again with exactly its stored amount.
5. A run whose park call failed does not execute, since the spend may have
   landed anyway; executing would consume it before the next run could see it.
   A failure to mark a parked claim stops the run. So a spend is always still
   parked when a later run looks for it, provided the harvester is the only
   agent that executes the agreement.
6. `invoice` funds the agreement when its available HF is below `FUND_MIN_HF`,
   parking up to `FUND_TOP_UP_HF` from the harvester's balance plus credit
   limit, less the network's fee.
7. It executes the agreement. The template
   ([execution_code.rhai](src/agreement/template/execution_code.rhai)) prices
   each operator's units with the price sheet's micro-HF rates in integer
   arithmetic, pays them from the funding, and holds the remainder for the
   next execution.

## Who does what

| Step                                      | On HoloFuel               | In the rehearsal                      |
| ----------------------------------------- | ------------------------- | ------------------------------------- |
| Network and the HF unit                   | exist                     | `unyt_cli progenitor holofuel setup`  |
| Create the program's lane and units       | Net Zero, on request      | `createProgramLane` in `net-zero.ts`  |
| Price sheet, template, agreement          | the program (`provision`) | the same code                         |
| Point `proof_of_service` at the agreement | Net Zero                  | `wireProofOfService` in `net-zero.ts` |
| HF for funding                            | not decided yet           | the harvester's credit limit          |
| Ingest, invoice, fund, execute            | the harvester             | the same commands                     |

One agent, the harvester, holds both agreement roles (`invoicer`, `funder`)
and is the agreement's only authorized executor. The roles and executor are
fixed when the agreement is created; changing them means a new agreement.

## Lanes and timing

Lane definition windows tile: a new version starts where the current one ends.
A spend must cite the lane version in force, so `invoice` resolves each id in
`LANE_DEFINITION_IDS` to its version in force at the start of each run. In the
rehearsal the lane's first version lasts one minute, so the version that names
the agreement is in force a minute after the lane is created.
