# unyt-harvester-example

A sample **log harvester** for paying operators in HoloFuel (HF) through a Unyt
smart agreement.

A harvester reads measurements from a source of truth that you, the payer,
trust. It turns them into parked spends on your agreement, and executes the
agreement so each operator is paid for the work measured. This repository is
based on the harvester Holo runs to pay node operators in the Wind Tunnel
program.

The default source is a synthetic log of LLM token use: operators serve LLM
requests, and you pay them per input and output token. A Nomad source is
included as a second example; it is the one Wind Tunnel uses.

```
 source (token log | Nomad)
   │  per-operator measurements, per window
   ▼
 harvester ── park spends (invoicer) ──▶ your agreement on HoloFuel
           ── park HF     (funder)   ──▶
           ── execute                ──▶ operators paid in HF
```

## Try it locally

```bash
npm ci
npm run rehearse -- --clean
```

This runs the whole flow on a private HoloFuel network on your machine. It uses
the production `unyt.happ` (`unytco/unyt-release` v1.0.1) with a freshly
generated network seed, so the DNA is the one MainNet runs but the network
cannot meet MainNet or any other network. It takes about three minutes and
ends with:

```
operator-1 uhCAk…  paid 0.054884 HF  expected 0.054884 HF  ok
operator-2 uhCAk…  paid 0.032534 HF  expected 0.032534 HF  ok
rehearsal PASS
```

The rehearsal needs Linux x86-64 because `unyt_cli`, which sets up HoloFuel's
units and lanes, is published only for it. On macOS, run it in a Linux
container. The harvester itself runs anywhere Node 22.5+ runs.

What it does, in order (see [src/rehearsal/rehearse.ts](src/rehearsal/rehearse.ts)):

1. Downloads and checks the pinned `unyt.happ`, `unyt_cli` and Holochain 0.7.1.
2. Starts a conductor, installs the app with a random network seed and a
   stand-in progenitor, and runs `unyt_cli progenitor holofuel setup`, which
   gives the harvester an HF credit limit to fund payments with.
3. Plays Net Zero: creates the `LLMTokens` lane with the units `TOKIN` and
   `TOKOUT`, naming the harvester as the lane's editor.
4. Runs `provision` to publish the agreement.
5. Plays Net Zero again: points the lane's `proof_of_service` at the agreement.
6. Writes three minutes of synthetic token use, then runs `process` and
   `invoice --drain`. `invoice` parks the spends, funds the agreement and
   executes it.
7. Each operator accepts its payment, and the rehearsal compares the HF
   received with the price sheet.

## Going live on HoloFuel

1. **Run a harvester agent on MainNet.** Install `unyt.happ` from
   `unytco/unyt-release` v1.0.1 on a conductor you operate. That agent parks
   invoices, funds the agreement and executes it.
2. **Ask Net Zero for a lane.** The HoloFuel network operator creates lanes.
   Send it your lane's name and units, in the shape of
   [config/lanes/llm-tokens.json](config/lanes/llm-tokens.json), and your
   harvester's agent key as lane editor. _How to request a lane: to be
   published._ You get back the lane id, your units' indices and the lane
   definition hash.
3. **Publish your agreement** from the harvester's conductor:
   ```bash
   npm run provision -- --price TOKIN=0.000001 --price TOKOUT=0.000004 --yes
   ```
   It prints the agreement id (`AGREEMENT_ID`).
4. **Ask Net Zero to point your lane's `proof_of_service` at that agreement.**
   Spends can only be parked on an agreement its lane names. The new lane
   version comes into force when the current one ends.
5. **Fund the harvester and schedule the runs.** _Where a program's HF comes
   from on MainNet is not decided yet._ Set `.env` from
   [env.example](env.example), run `npm run hc:init` once, then run
   `npm run process` and `npm run invoice` on a schedule. `AGREEMENT_ID` and
   `LANE_DEFINITION_IDS` (your lane's definition hash) are required. `invoice` tops up the
   agreement from the harvester's HF when it falls below `FUND_MIN_HF`.

Operators need a Unyt agent on HoloFuel; the key your source reports for them
is where their HF goes. They accept each payment in the Unyt app.

## Using your own source

A source implements [`Source`](src/sources/source.ts):

```ts
interface Source {
  name: string;
  ingest(): Promise<IngestResult>; // read new raw records, idempotently
  measure(windowStart: number, windowEnd: number): Promise<Measurement[]>;
  close(): Promise<void>;
}
```

`measure` returns one `{ operatorKey, metricKey, value, … }` per operator,
metric and window. The rest of the harvester only sees those. Start from
[src/sources/tokens/](src/sources/tokens/) and register yours in
[src/sources/open.ts](src/sources/open.ts).

Then map your metric keys onto your lane's units in a billing policy
([policy.example.json](policy.example.json), `POLICY_PATH`) and price each unit
with `provision --price SYMBOL=rate`. Rates are HF per unit, at most 6 decimal
places.

## Commands

| Command                   | Does                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `npm run process`         | ingest the source and queue measurements per window               |
| `npm run invoice`         | park pending measurements, fund, execute (`--dry-run` to preview) |
| `npm run fund`            | park HF onto the agreement                                        |
| `npm run unlock`          | return the agreement's held HF to the harvester                   |
| `npm run provision`       | publish the price sheet, code template and agreement              |
| `npm run ops <cmd>`       | `summary`, `lanes`, `pending`, `invoiced`, `failures`             |
| `npm run generate-tokens` | write a synthetic token log                                       |
| `npm run watch`           | Nomad source: follow the event stream                             |
| `npm run rehearse`        | the local end-to-end run above                                    |

`npm test` runs prettier, the type check and the unit tests.

## Other Unyt networks

The harvester works on any Unyt network whose DNA matches the pinned release:
point it at that network's conductor, and have that network's progenitor
create your lane. HoloFuel is the network this sample is written for.

## License

[CAL-1.0](LICENSE).
