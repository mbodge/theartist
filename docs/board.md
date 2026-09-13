# The studio board

The person launching a studio holds its founding board seat. They can appoint directors who provide strategic nudges to the supervisor—the artist or founder making proposal and acceptance decisions. The supervisor retains judgment and explicitly answers each nudge with **adopt**, **defer**, or **decline**, plus a short rationale.

This is an advisory board, not a required vote before every action. It applies to both artist and founder studios. The first interface is the local CLI and portable public archive; there is no board dashboard or hosted account authentication yet.

## Launch and membership

A newly provisioned founder gets a launching member automatically:

```sh
npm run studio -- init my-founder --launcher mike --name "Mike Bodge"
npm run studio -- board --instance my-founder
npm run studio -- board add collaborator --instance my-founder --as mike --name "Collaborator"
```

Omitting launcher options uses the local member ID `launcher` and display name `Studio launcher`. A new artist studio gets that default board on its first cycle. Initialize a named launcher before the first cycle, or add a board to an existing studio:

```sh
npm run studio -- board init --studio artist --as mike --name "Mike Bodge"
npm run studio -- board init --instance existing-founder --as mike --name "Mike Bodge"
```

Initialization cannot replace an existing launcher. Only the launcher can add or remove directors; the launching seat cannot be removed. IDs cannot be reused after removal, preserving historical attribution. There are at most twelve active members.

`founder-001` has been initialized locally with `mike` as its launcher. This membership lives in that instance's database; cloning the repository does not give a new user Mike's board.

## Nudge the supervisor

```sh
npm run studio -- board nudge --instance my-founder --as mike \
  --key first-deliverable --text "Prioritize one small, runnable deliverable before expanding the scope."

npm run studio -- board --instance my-founder
npm run studio -- show CYCLE_ID --instance my-founder
```

Nudges are public, attributed to an active member, timestamped, and limited to 1,200 characters. An optional `--key` deduplicates retries for that author; reusing it with different text is rejected. Without a key, each invocation is a new nudge.

Up to eight nudges may remain active. Guidance stays active across cycles until withdrawn, so an important direction does not disappear through memory-search ranking. Each new cycle gets its own explicit supervisor response. A response is a decision about guidance, not proof of implementation or customer validation.

```sh
npm run studio -- board withdraw NUDGE_ID --instance my-founder --as mike \
  --text "The first deliverable is complete; this priority has served its purpose."

npm run studio -- board remove collaborator --instance my-founder --as mike
```

An author or the launcher can withdraw a nudge. Removing a director withdraws their active nudges. Original records, withdrawals, membership changes, and prior replies remain in history. Replaying a withdrawn nudge's old key does not reactivate it; submit a new key for new guidance.

## When guidance takes effect

Every agent stage receives a bounded snapshot of current board guidance. Research can use it to choose what to investigate; making and critique can use it as context. Only the supervisor at `propose` or `decide` answers the board.

The next supervisor call must answer every active nudge that has not already received a response in that cycle. A nudge arriving after the proposal can be answered at the acceptance decision. A nudge arriving after that decision waits for the next cycle. An in-flight request keeps its original snapshot; additions and withdrawals take effect on subsequent calls, rather than changing what an already-running model saw.

Replies use structured model output. Unknown IDs, duplicate replies, or missing replies fail the stage. Replies and the ordinary decision checkpoint commit in the same fenced SQLite transaction. A stale worker cannot record a reply after losing its lease. A retry gets its own saved snapshot, and completed decisions are not rerun merely because someone added a nudge.

Coding jobs receive the frozen nudges and supervisor replies from the accepted cycle, including the final acceptance decision. Later board edits cannot silently rewrite an already-queued build brief. The handoff also records whether each nudge was still active at the final acceptance decision. Deferred, declined, and previously withdrawn nudges are history, not execution instructions.

The supervisor may incorporate, defer, or disagree with a nudge. It must explain that choice. Board text does not grant tool access, increase budgets, rewrite completed work, or count as customer evidence. Operating limits remain enforced by the harness.

## Memory and public record

The database keeps members, attributed nudges, withdrawals, delivery snapshots, and replies. The shared memory journal also contains governance records. Historical records remain retrievable, but only active nudges in the current board snapshot are current guidance.

Archive schema version 4 includes a `board` object with membership, nudge history, public-cycle replies, and exact per-attempt delivery snapshots. Private-cycle replies and their snapshots stay out of public exports. Board nudges themselves are public; `--private` is rejected for board commands rather than silently publishing a supposedly private nudge.

```sh
npm run studio -- memory --instance my-founder
npm run studio -- export --instance my-founder
```

See [the offline board fixture](../examples/board-fixture.json). Its synthetic supervisor replies defer the nudges; they demonstrate delivery and persistence, not autonomous judgment.

## Local identity and hosted product boundary

`--as` is local operator attribution, **not authentication**. Anyone with access to the local data and CLI can select an existing member ID or edit the database. Membership checks prevent accidental misuse through these methods but do not create a multi-user security boundary.

A hosted product must bind the launching seat to the authenticated creator, scope all board operations to their studio, and derive the acting member from the server session rather than a caller-supplied ID. The current tables and decision records provide the governance model for that interface; the account system and dashboard remain to be built.
