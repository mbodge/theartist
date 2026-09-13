# First live coding workshop: executable RFP prototype, stalled artifact handoff

Date: September 13, 2026

Founder: `founder-001` · model: `gpt-6-astra` · accepted cycle: `6d389293-dbd0-47ff-b83e-5713af7c6330` · build: `4a06715e-0703-41c2-bee9-0ea38c85a8dd`.

## Result

The agent built and tested a working RFP review CLI. The hosted session then stalled after the agent's final report, without publishing immutable artifacts or confirming turn completion. This is a successful observed coding exercise and a **failed automated artifact handoff**, not a completed end-to-end autonomous run.

The [recovered prototype](../../examples/rfp-prototype/README.md) contains runnable Python source, fixtures, 26 tests, regenerated checklists, and actual local verification results. The [raw build record](../../examples/live-founder-build.json) preserves the brief, explicit messages, captured commands, missing API exit codes, and unresolved lifecycle state. Internal reasoning was excluded.

## What the agent did

The coding workshop received the previously accepted RFP experiment and explicit authority to build a prototype in a network-disabled hosted workspace. No primary RFP files were supplied. It chose a dependency-free Python CLI and labelled its source documents and scoring judgments synthetic.

Observed commands created source and fixtures, ran an initial 25-test suite and sample, added a regression test that failed, fixed the bug, and reran 26 tests and the sample. The bug classified “not required” as mandatory. The final source preserves explicit waivers while retaining prohibitions such as “must not.”

The implementation generates cited checklists, preserves superseded requirements, flags conflicting Q&A, freezes references separately from generation, and computes recall and other gates without claiming synthetic data validate the original venture.

The agent reported 29 files. Thirteen command records and its explicit completion report were available, but the artifact endpoint remained empty and the root turn remained in progress. API process exit-code fields were null, including on completed and failed command records; subprocess output contained numeric exit codes. The harness now preserves that distinction.

## Recovery and independent execution

The local worker was restarted once while adapting to missing API exit codes. It resumed the same session without repeating creation or model input.

After the ten-minute job deadline, the worker sent a cancellation event. The provider continued to report the turn active. A deletion attempt returned HTTP 409: the session must be durably idle or failed before deletion. No successful cancellation, deletion, or final provider usage was confirmed at publication. The job remains `cancelling`; another build is blocked. No background cleanup worker is installed.

To retain useful work, the operator reconstructed literal file contents from captured heredocs without executing those shell commands, then reapplied the recorded source edits. The Python source was reviewed before running it locally with an empty inherited environment. This recovery is an operator intervention, not an implemented autonomous fallback. The [recovery manifest](../../examples/rfp-prototype/recovery-manifest.json) records the method and local file hashes.

Local verification ran on Python 3.9.6:

```sh
cd examples/rfp-prototype
env -i PATH=/usr/bin:/bin /usr/bin/python3 -B verify.py \
  --sample-out sample-output-v2 --report recovery-test-results.json
```

All 26 tests passed. The sample's reference-freezing, generation, and scoring subprocesses also returned zero. Exact local output and exit codes are in [the verification record](../../examples/rfp-prototype/recovery-test-results.json). The sample artifacts were regenerated locally; they are not the unavailable original hosted bundle.

The sample recovered 8/10 obligations and 6/8 critical obligations. Both recall gates failed. Correction time remained null. The three-real-package benchmark remains inconclusive, and customer demand, benefit, and willingness to pay remain unvalidated.

## Harness changes prompted by this run

- Retain null API exit codes rather than inventing zero; explicit nonzero exits cannot satisfy the execution gate.
- Preserve job intent and remote identifiers across worker restarts.
- Keep cancellation unresolved when the provider refuses deletion; never label that state stopped or allow a replacement build.
- Attempt session deletion after a cancellation grace period, while retaining errors and retry information if deletion is refused.
- Preserve explicit command records and compact execution memory independently of provider artifacts.
- Run the recovered prototype's tests and sample in repository CI, alongside 59 harness tests.

This trial demonstrates that the agent can write, execute, debug, and test code. The managed provider's artifact finalization and cancellation behavior must be resolved or the execution backend replaced before this workflow can be called reliably unattended.
