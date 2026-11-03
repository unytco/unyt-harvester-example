/// Subject: Proof of service, paid in HF per measured unit
///
/// Pays operators in HoloFuel (HF) for work a trusted source measured. The
/// harvester that parks the measurements is operated by the payer, so the
/// report is trusted — there is no third-party work-proof validation.
///
/// Roles:
/// - invoicer (the harvester): parks the measured service units and reports
///   the per-operator breakdown.
/// - funder (the harvester's funding): parks the HF that pays operators.
///
/// Inputs:
/// - consumed_inputs.invoicer_allocations: the harvester's parked spend(s)
///     carrying the measured units (.data.amount, .data.source).
/// - consumed_inputs.funder_allocations: the funder's parked HF.
/// - consumed_inputs.invoice_payloads: per parked spend, .data is
///     [ { host_pub_key, units: { <unit index>: count, ... } } ].
/// - inputs.price_sheet_data_blob_hash: { micro_hf_per_unit: { <unit index>:
///     rate } } — integer micro-HF (1e-6 HF) paid per unit, as strings. A unit
///     the sheet does not price is credited to the operator but earns no HF.
/// - inputs.hf_index: HF's unit index (string). A Fixed input because indices
///     are assigned by registration order.
/// - inputs.previous_execution (Custom GetPreviousExecution): { id, output } of
///     the last run. Its output.locked is the HF this agreement held back last
///     run — carried forward automatically by conservation — and its id is the
///     source a lock-funded allocation names. Absent on the first execution.
/// - inputs.harvester_pub_key (Fixed): the funder's AgentPubKey, as the same
///     string representation executor_pub_key uses. The receiver for unlock's
///     reclaim.
/// - inputs.unlock (ExecutorProvided bool): return the whole held HF balance to
///     the funder (inputs.harvester_pub_key) and hold nothing. Any invoice
///     parked alongside the reclaim is rejected, not deleted, so it survives
///     for a later execution. Optional; absent or false takes the normal
///     pay-and-hold path.
///
/// Logic: for each operator, HF owed = sum over priced units of count * rate;
/// allocate that HF from as many parked/carried sources as needed (the carried
/// lock first, then the funder's freshly-parked HF, via consume_allocations)
/// to the operator, together with the measured units that earned it, so the
/// operator's unit balances are a running total of credited work; HOLD any
/// remaining HF on the agreement (output.locked) so it funds the next
/// execution. If the available HF cannot cover the invoices, throw — a
/// payment is required.
///
/// All amounts use exact integer micro-HF arithmetic and ZFuel strings, never
/// float.

let price_sheet = get_data_blob(inputs.price_sheet_data_blob_hash.data);
let rates = #{};
for unit in price_sheet.micro_hf_per_unit.keys() {
    rates[unit] = parse_int(price_sheet.micro_hf_per_unit[unit]);
}

let hf = inputs.hf_index.data;

// A micro-HF integer as a ZFuel decimal string, e.g. 1388 -> "0.001388".
fn micro_to_hf(micro) {
    let fraction = (micro % 1000000).to_string();
    while fraction.len() < 6 {
        fraction = "0" + fraction;
    }
    return (micro / 1000000).to_string() + "." + fraction;
}

let final_unyt_allocation = [];
let total_micro_expected = 0;
// Invoice HF that could NOT be funded, reported in the shortfall throw so the
// operator knows how much to top up.
let total_micro_unfunded = 0;
let funder_alloc = consumed_inputs.funder_allocations;
let able_to_pay = true;

// Carried lock from the previous execution (auto-applied by conservation), and
// that execution's hash — the source a lock-funded payment names. Prepended to
// the funder funding so the invoice loop draws the held HF down before fresh
// parked HF.
let prev_source = ();
if type_of(inputs.previous_execution.data) == "map" {
    prev_source = inputs.previous_execution.data.id;
    // A prior run that held nothing omits `locked`, so default it to an empty
    // map before indexing — indexing () would be a runtime error.
    let carried_locked = inputs.previous_execution.data.output.locked ?? #{};
    let carried = carried_locked[hf] ?? "0";
    if carried != "0" {
        let carried_amount = #{};
        carried_amount[hf] = carried;
        funder_alloc.insert(0, #{ "data": #{ "amount": carried_amount, "source": prev_source } });
    }
}

// Unlock: return the whole held HF balance to the funder and hold nothing.
// Runs before invoicing so a reclaim never settles operator work; names every
// funding source so nothing is left unaccounted. Every execution is called
// with links: [] (every currently-parked link on the agreement), and a
// ParkedSpendCredit link — invoicer's included — is deleted once
// "used" unless the script names it in rejected_links. An invoice
// parked alongside the reclaim is rejected here, not settled or dropped, so it
// survives untouched for a later, normal execution.
if type_of(inputs.unlock) == "map" && inputs.unlock.data == true {
    let carried_back = "0";
    let sources = [];
    for alloc in funder_alloc {
        carried_back = add_fuel(carried_back, alloc.data.amount[hf] ?? "0");
        sources.push(alloc.data.source);
    }
    let out = [];
    if carried_back != "0" {
        let amt = #{};
        amt[hf] = carried_back;
        out.push(#{ "receiver": inputs.harvester_pub_key.data, "amounts": amt, "sources": sources });
    }
    let rejected = [];
    for alloc in consumed_inputs.invoicer_allocations {
        rejected.push(#{ "hash": alloc.data.source, "reason": "unlock reclaim: preserved for a later invoice settlement" });
    }
    return #{ "output": #{ "unyt_allocation": out }, "rejected_links": rejected };
}

for (value, count) in consumed_inputs.invoice_payloads {
    for (payload, i) in value.data {
        // A payload may omit a unit that was zero for the period; it then
        // contributes nothing. The operator's allocation carries the measured
        // units as the invoiced strings, so they sum exactly to the parked
        // spend. Only non-zero keys: conservation rejects a zero-valued key
        // that is not in the parked spend's total.
        let amounts = #{};
        let owed = 0;
        for unit in payload.units.keys() {
            let measured = parse_int(payload.units[unit]);
            if measured > 0 {
                amounts[unit] = payload.units[unit];
                owed += measured * (rates[unit] ?? 0);
            }
        }
        total_micro_expected += owed;
        let sources = [value.link_hash];

        if owed > 0 {
            if !able_to_pay {
                total_micro_unfunded += owed;
                continue;
            }
            let needed = micro_to_hf(owed);
            // Draws from as many funder_alloc entries as needed, in order
            // (carried lock first), subtracting in place with exact ZFuel
            // arithmetic.
            let drawn = consume_allocations(funder_alloc, hf, needed);
            if !drawn.covered {
                able_to_pay = false;
                total_micro_unfunded += owed;
                continue;
            }
            amounts[hf] = needed;
            for s in drawn.sources {
                sources.push(s);
            }
        }

        // A payload with no measured work gets no allocation.
        if amounts.len() > 0 {
            final_unyt_allocation.push(#{
                "receiver": payload.host_pub_key,
                "amounts": amounts,
                "sources": sources
            });
        }
    }
}

if able_to_pay {
    // Unspent HF (the carried lock plus any fresh parked remainder) to HOLD for
    // the next execution, and the sources that still carry a remainder. Every
    // source that funds the new lock must stay named on an allocation or
    // conservation drops it: fully-spent sources are already named on their
    // operator payments; a partially-spent parked source and the carried-lock
    // source are named on an operator allocation below. (The
    // carried lock rides forward as the predecessor's running balance — its
    // amount needs no naming — but naming its source is harmless: the
    // predecessor is an accepted non-parked source.)
    let remaining_hf = "0";
    let remaining_sources = [];
    for (t, i) in funder_alloc {
        let amt = t.data.amount[hf] ?? "0";
        if amt != "0" {
            remaining_hf = add_fuel(remaining_hf, amt);
            remaining_sources.push(t.data.source);
        }
    }

    // Name the remainder sources on the last operator allocation; an
    // allocation's sources need not match its amounts.
    if remaining_sources.len() > 0 && final_unyt_allocation.len() > 0 {
        let last = final_unyt_allocation.pop();
        last.sources += remaining_sources;
        final_unyt_allocation.push(last);
    }
    // Known limitation: a run with HF to hold but no operator allocation (only
    // empty or zero payloads) has nowhere to name those sources, so
    // conservation refuses the run. It fails safe — no loss — and does not
    // arise in normal operation, where an execution always settles measured
    // work.

    let output = #{ "unyt_allocation": final_unyt_allocation };
    if remaining_hf != "0" {
        let locked = #{};
        locked[hf] = remaining_hf;
        output.locked = locked;
    }
    return #{ "output": output };
} else {
    throw "For execution to succeed, a further payment of " + micro_to_hf(total_micro_unfunded) + " HF must be sent to this agreement (" + micro_to_hf(total_micro_expected) + " HF invoiced in total).";
}
